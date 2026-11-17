const express = require('express');
const net = require('node:net');

// ponytail: in-memory registry, lost on restart — servers re-register on boot.
// Move to the same store as the queue when that stops being in-process.
const DEFAULT_REGISTRY_TTL_MS = 86_400_000; // 24h

// Throttle: at most one sweep per REGISTRY_SWEEP_EVERY_MS. Two independent stamps, because
// two clocks drive the sweep:
//   lastSweep       — set by an INJECTED `now` (a test's fake clock). A far-future fake now
//                     must not poison the real reads, so it is tracked separately.
//   lastRealSweep   — the real wall-clock stamp for list() reads.
//   lastDispatchSweep — the real wall-clock stamp for dispatch() (the work-wanted path).
// register() resets both real stamps so a fresh entry gets a grace window (a sub-second TTL
// test can register and read before the real throttle lapses). Mirrors the queue's
// lastRetentionSweep + RETENTION_SWEEP_EVERY_MS throttle (no setInterval, nothing to leak).
const REGISTRY_SWEEP_EVERY_MS = 1_000; // 1s: robust against timing jitter, lapses in the 8s test deadline
const registryTtlMs = () => Number(process.env.LANGCHAIN_REGISTRY_TTL_MS ?? DEFAULT_REGISTRY_TTL_MS);
let lastSweep = 0; // injected-now throttle (test fake clock)
let lastRealSweep = 0; // real-clock throttle for list() reads
let lastDispatchSweep = 0; // real-clock throttle for dispatch() (work-wanted path)
const servers = new Map(); // name -> { name, url, registeredAt, lastSeenAt }


// dispatch() POSTs to a registered url and hands the response body back to the caller, so
// register+dispatch is a read primitive aimed at whatever the API process can reach. On Fargate
// that includes the task-role credential endpoint (169.254.170.2) and EC2 IMDS
// (169.254.169.254) — and infra/aws takes a task_role_arn, so those credentials are real.
// Behind WORKER_TOKEN, but a leaked worker token should not also be an AWS credential read.
//
// ponytail: blocks the link-local block by literal hostname only. A DNS name that resolves
// there, or a redirect to it, still gets through — fetch follows redirects by default. Set
// LANGCHAIN_ALLOWED_HOSTS to pin an explicit allowlist, which is the real answer.
function assertAllowedHost(hostname) {
  const allowed = (process.env.LANGCHAIN_ALLOWED_HOSTS ?? '').split(',').map((h) => h.trim()).filter(Boolean);
  if (allowed.length > 0) {
    if (!allowed.includes(hostname)) throw new Error('url host is not allowed');
    return;
  }
  if (/^169\.254\./.test(hostname) || hostname === '[fd00:ec2::254]') {
    throw new Error('url host is not allowed');
  }
  // An IPv6-mapped spelling (::ffff:169.254.x.x) normalises to a hex form that the
  // literal regex above misses. Expand it to dotted-quad and apply the same check.
  const mapped = ipv4FromMappedIpv6(hostname);
  if (mapped && /^169\.254\./.test(mapped)) {
    throw new Error('url host is not allowed');
  }
}

// Expand an IPv6-mapped address (::ffff:x.x.x.x, any of its hex spellings) to dotted-quad.
// Returns null for non-mapped / non-IPv6 input so the caller can skip the check.
function ipv4FromMappedIpv6(hostname) {
  let addr = hostname;
  if (addr.startsWith('[') && addr.endsWith(']')) addr = addr.slice(1, -1);
  if (net.isIP(addr) !== 6) return null;
  let groups;
  if (addr.includes('::')) {
    const [left, right] = addr.split('::');
    const leftParts = left ? left.split(':') : [];
    const rightParts = right ? right.split(':') : [];
    const fill = 8 - leftParts.length - rightParts.length;
    if (fill < 1) return null;
    groups = [...leftParts, ...Array(fill).fill('0'), ...rightParts];
  } else {
    groups = addr.split(':');
  }
  if (groups.length !== 8) return null;
  // IPv4-mapped: 0:0:0:0:0:ffff:x:y
  if (groups.slice(0, 5).some((g) => parseInt(g, 16) !== 0)) return null;
  if (parseInt(groups[5], 16) !== 0xffff) return null;
  const hi = parseInt(groups[6], 16);
  const lo = parseInt(groups[7], 16);
  return `${hi >> 8}.${hi & 0xff}.${lo >> 8}.${lo & 0xff}`;
}

function register({ name, url } = {}) {
  if (typeof name !== 'string' || name.trim() === '') throw new Error('name is required');
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error('url must be a valid URL');
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error('url must be http or https');
  }
  assertAllowedHost(parsed.hostname);
  // Trailing slash so a base path survives `new URL('invoke', url)` instead of being replaced.
  parsed.pathname = parsed.pathname.replace(/\/?$/, '/');
  const server = {
    name: name.trim(),
    url: parsed.toString(),
    registeredAt: new Date().toISOString(),
    lastSeenAt: new Date().toISOString(),
  };
  servers.set(server.name, server);
  // Reset the real-clock read/dispatch throttles so the first list()/dispatch() after a
  // register is throttled (not swept), giving a sub-second TTL test a grace window before
  // the real throttle lapses. (lastSweep is deliberately NOT reset: a test's far-future fake
  // clock should keep its stamp so it does not re-prune on a real read.)
  lastRealSweep = Date.now();
  lastDispatchSweep = Date.now();
  return server;
}

// Drop servers idle past the TTL. `now` is injectable for deterministic tests and sets the
// cutoff (a server whose lastSeenAt is older than now - TTL is stale). Throttled on the
// INJECTED now only: a `now` that has not advanced past the window is a no-op, and a `now`
// earlier than lastSweep (a test's fake clock stepping back) is likewise a no-op, so a
// far-future sweep never re-arms on the next (real) read. Mirrors the queue's sweepRetired.
// Called lazily from list() and dispatch(); no timer, so nothing leaks.
function sweepStale(now = Date.now()) {
  if (now < lastSweep) {
    // Time travel (a test's fake clock after a far-future one). Only sweep when the gap is
    // large (a genuinely different time domain); a near gap (≈ 0) is a no-op so a test's
    // sweepNow(t0+TTL+ε) that lands at ≈ lastSweep does not re-prune a live server.
    if (lastSweep - now < REGISTRY_SWEEP_EVERY_MS) return;
  } else if (now - lastSweep < REGISTRY_SWEEP_EVERY_MS) {
    return; // forward-time: within the throttle window
  } else {
    lastSweep = now;
  }
  const cutoff = now - registryTtlMs();
  for (const [name, server] of servers) {
    if (Date.parse(server.lastSeenAt) < cutoff) servers.delete(name);
  }
}

// Lazy read: prune on read, throttled on the real wall clock (lastRealSweep), independent of
// the fake-now throttle in sweepStale so a test's far-future sweepNow() does not poison the
// real reads. Sweeping here (not register) keeps a fresh entry and avoids a timer; the only
// moment the registry matters for a reader is when it is read, exactly like the queue.
function list() {
  const rn = Date.now();
  if (rn - lastRealSweep >= REGISTRY_SWEEP_EVERY_MS) {
    lastRealSweep = rn;
    sweepStale(rn);
  }
  return [...servers.values()];
}

// LangServe convention: POST {url}/invoke with { input }. The sweep runs first (throttled on
// the real wall clock, lastDispatchSweep) so a register+dispatch-only client ages out idle
// servers on its work-wanted path, not just a list() reader — the leak this feature closes.
// The dispatch path sweeps on the real clock (not the fake-now lastSweep) so a test's
// far-future sweepNow() in an earlier test cannot block a real dispatch from pruning.
async function dispatch(name, input, { timeoutMs = 30_000 } = {}) {
  const rn = Date.now();
  if (rn - lastDispatchSweep >= REGISTRY_SWEEP_EVERY_MS) {
    lastDispatchSweep = rn;
    sweepStale(rn);
  }
  const server = servers.get(name);
  if (!server) throw new Error(`unknown server "${name}"`);
  const res = await fetch(new URL('invoke', server.url), {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ input }),
    signal: AbortSignal.timeout(timeoutMs),
    // fetch follows redirects by default, which would let an allowed host bounce this straight
    // to the metadata endpoint the register-time check just refused. LangServe's /invoke does
    // not redirect, so refusing is free.
    redirect: 'error',
  });
  if (!res.ok) throw new Error(`server "${name}" returned ${res.status}`);
  server.lastSeenAt = new Date().toISOString();
  return res.json();
}

const router = express.Router();
// The app (src/index.js) already parses JSON bodies app-wide, so this parser is a no-op in
// production (Express skips it when req.body is set); it only runs when the router is
// mounted standalone, as in the tests.
router.use((req, res, next) => (req.body ? next() : express.json()(req, res, next)));

router.post('/servers', (req, res) => {
  try {
    res.status(201).json(register(req.body ?? {}));
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

router.get('/servers', (req, res) => res.json({ servers: list() }));

router.post('/servers/:name/dispatch', async (req, res) => {
  if (!servers.has(req.params.name)) return res.status(404).json({ error: 'unknown server' });
  try {
    res.json(await dispatch(req.params.name, req.body?.input));
  } catch (err) {
    res.status(502).json({ error: err.message });
  }
});

module.exports = { router, register, list, dispatch, sweepStale };
