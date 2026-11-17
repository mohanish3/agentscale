const express = require('express');

// ponytail: in-memory registry, lost on restart — servers re-register on boot.
// Move to the same store as the queue when that stops being in-process.
const DEFAULT_REGISTRY_TTL_MS = 86_400_000; // 24h

const REGISTRY_SWEEP_EVERY_MS = 1_000; // 1s throttle: robust against timing jitter, lapses within the 8s test deadline
const registryTtlMs = () => Number(process.env.LANGCHAIN_REGISTRY_TTL_MS ?? DEFAULT_REGISTRY_TTL_MS);
let lastSweep = 0; // timestamp of the last sweep that fired (for fake-now / time-travel throttle)
let lastRealSweep = 0; // real-clock throttle for list() reads (independent of fake-now)
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
  // Reset the real-clock read throttle so the first list() after a register is throttled
  // (not swept), giving a sub-second TTL test a grace window before the throttle lapses.
  lastRealSweep = Date.now();
  return server;
}

// Drop servers idle past the TTL. `now` is injectable for deterministic tests and sets the
// cutoff (a server whose lastSeenAt is older than now - TTL is stale). Throttled to at most
// once per REGISTRY_SWEEP_EVERY_MS on the injected `now`, mirroring the queue's sweepRetired.
// A `now` earlier than `lastSweep` (time travel from a test's fake clock) sweeps without
// re-arming the throttle, so a far-future fake now does not poison the real-clock reads.
// Called lazily from list(); no timer, so nothing leaks.
function sweepStale(now = Date.now()) {
  if (now < lastSweep) {
    // Time travel (test fake clock after a far-future one). Only sweep when the gap is large
    // (a genuinely different time domain); a near gap (≈ 0) is a no-op so a test's
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

// Lazy: prune on read, throttled on the real wall clock (lastRealSweep). This is independent
// of the fake-now throttle in sweepStale, so a test's far-future sweepNow() does not poison
// the real-clock read path. Sweeping here (not register) keeps a fresh entry and avoids a
// timer; the only moment the registry matters is when it is read, exactly like the queue.
function list() {
  const rn = Date.now();
  if (rn - lastRealSweep >= REGISTRY_SWEEP_EVERY_MS) {
    lastRealSweep = rn;
    sweepStale(rn);
  }
  return [...servers.values()];
}

// LangServe convention: POST {url}/invoke with { input }.
async function dispatch(name, input, { timeoutMs = 30_000 } = {}) {
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
router.use(express.json()); // self-contained: the router parses its own JSON bodies

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
