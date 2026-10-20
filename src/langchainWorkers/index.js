const express = require('express');

// ponytail: in-memory registry, lost on restart — servers re-register on boot.
// Move to the same store as the queue when that stops being in-process.
const servers = new Map(); // name -> { name, url, registeredAt }

// dispatch() POSTs to a registered url and hands the response body back to the caller, so
// register+dispatch is a read primitive aimed at whatever the API process can reach. On Fargate
// that includes the task-role credential endpoint (169.254.170.2) and EC2 IMDS
// (169.254.169.254) — and infra/aws takes a task_role_arn, so those credentials are real.
// Behind WORKER_TOKEN, but a leaked worker token should not also be an AWS credential read.
//
// new URL() normalizes a host before it ever reaches the check: an IPv4 address arrives as
// a dotted quad, and an IPv4 address spelled as an IPv4-mapped IPv6 literal arrives as hex
// ([::ffff:169.254.169.254] -> [::ffff:a9fe:a9fe]). A block that matches the literal
// hostname only therefore had a hole — the metadata endpoint, wearing a v6 costume, sailed
// through and dispatch() POSTed straight to it. Reduce any v4-flavoured host to one dotted
// quad so the range test below is spelling-proof.
function effectiveV4(hostname) {
  let h = hostname;
  if (h.startsWith('[') && h.endsWith(']')) h = h.slice(1, -1); // IPv6 hosts arrive bracketed
  const mapped = h.match(/^::ffff:(.+)/);
  if (mapped) {
    const dotted = mapped[1].match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
    if (dotted) return dotted.slice(1).join('.'); // [::ffff:a.b.c.d]
    const hex = mapped[1].match(/^([0-9a-f]{1,4}):([0-9a-f]{1,4})$/i);
    if (hex) { // [::ffff:hhhh:hhhh] — the same v4 address in its normalized hex form
      const hi = Number.parseInt(hex[1], 16);
      const lo = Number.parseInt(hex[2], 16);
      return `${hi >> 8}.${hi & 0xff}.${lo >> 8}.${lo & 0xff}`;
    }
    return null; // a v6 address that is not a clean v4 mapping is not a v4
  }
  if (/^\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(h)) return h; // plain dotted quad
  if (/^\d+$/.test(h)) { // a single decimal-integer spelling of the same address
    const n = Number(h);
    if (Number.isFinite(n) && n <= 0xffffffff) {
      return `${(n >>> 24) & 0xff}.${(n >>> 16) & 0xff}.${(n >>> 8) & 0xff}.${n & 0xff}`;
    }
  }
  return null; // a name, or a non-mapped v6
}

// ponytail: blocks the link-local 169.254/16 range and the one task-role v6 address.
// A DNS name that resolves there, or a redirect to it, still gets through — fetch follows
// redirects by default (dispatch() already refuses those). Set LANGCHAIN_ALLOWED_HOSTS to
// pin an explicit allowlist, which is the real answer.
function assertAllowedHost(hostname) {
  const allowed = (process.env.LANGCHAIN_ALLOWED_HOSTS ?? '').split(',').map((h) => h.trim()).filter(Boolean);
  if (allowed.length > 0) {
    if (!allowed.includes(hostname)) throw new Error('url host is not allowed');
    return;
  }
  const v4 = effectiveV4(hostname);
  if (v4) {
    const [first, second] = v4.split('.');
    if (first === '169' && second === '254') throw new Error('url host is not allowed');
    return;
  }
  if (hostname === '[fd00:ec2::254]') throw new Error('url host is not allowed');
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
  const server = { name: name.trim(), url: parsed.toString(), registeredAt: new Date().toISOString() };
  servers.set(server.name, server);
  return server;
}

function list() {
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
  return res.json();
}

const router = express.Router();

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

module.exports = { router, register, list, dispatch };
