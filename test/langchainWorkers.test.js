const { test } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const express = require('express');
const { register, list, dispatch, sweepStale, router } = require('../src/langchainWorkers/index.js');

test('rejects a non-http url', () => {
  assert.throws(() => register({ name: 'x', url: 'ftp://host/' }), /http/);
  assert.throws(() => register({ name: 'x', url: 'not a url' }), /valid URL/);
});

// dispatch() returns the upstream body to the caller, so registering the metadata endpoint
// turns an authenticated call into an AWS credential read on Fargate.
test('refuses to register a link-local host', () => {
  assert.throws(() => register({ name: 'imds', url: 'http://169.254.169.254/latest/meta-data/' }), /not allowed/);
  assert.throws(() => register({ name: 'ecs', url: 'http://169.254.170.2/v2/credentials' }), /not allowed/);
  assert.throws(() => register({ name: 'v6', url: 'http://[fd00:ec2::254]/' }), /not allowed/);
});

// The guard is documented to block "the link-local block" (169.254.x) so a leaked worker
// token cannot become an AWS credential read. It matches the dotted-quad hostname literally
// (plus one exact IPv6 literal), but the SAME 169.254.169.254 metadata address can be spelled
// in IPv6-mapped form, which Node normalizes to hex: [::ffff:169.254.169.254] ->
// [::ffff:a9fe:a9fe]. That matches neither /^169\.254\./ nor the [fd00:ec2::254] literal, so
// register() accepts it and dispatch() will POST to the metadata endpoint. Both spellings are
// the identical link-local address and must be refused like the dotted form.
test('refuses the IPv6-mapped spelling of a link-local metadata host', () => {
  assert.throws(() => register({ name: 'imds-mapped', url: 'http://[::ffff:169.254.169.254]/' }), /not allowed/);
  assert.throws(() => register({ name: 'imds-mapped-hex', url: 'http://[::ffff:a9fe:a9fe]/' }), /not allowed/);
});

test('an explicit allowlist replaces the default block', () => {
  process.env.LANGCHAIN_ALLOWED_HOSTS = 'chains.internal, other.internal';
  try {
    assert.equal(register({ name: 'ok', url: 'http://chains.internal/' }).name, 'ok');
    assert.throws(() => register({ name: 'no', url: 'http://elsewhere.internal/' }), /not allowed/);
  } finally {
    delete process.env.LANGCHAIN_ALLOWED_HOSTS;
  }
});

test('dispatches to the registered server and returns its output', async () => {
  let seen;
  const upstream = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      seen = { url: req.url, body: JSON.parse(body) };
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ output: 'done' }));
    });
  });
  await new Promise((r) => upstream.listen(0, r));
  try {
    register({ name: 'chain', url: `http://localhost:${upstream.address().port}/base` });
    assert.deepEqual(await dispatch('chain', 'hello'), { output: 'done' });
    assert.equal(seen.url, '/base/invoke');
    assert.deepEqual(seen.body, { input: 'hello' });
  } finally {
    upstream.close();
  }
});

test('an upstream failure surfaces as an error', async () => {
  const upstream = http.createServer((req, res) => res.writeHead(500).end());
  await new Promise((r) => upstream.listen(0, r));
  try {
    register({ name: 'bad', url: `http://localhost:${upstream.address().port}` });
    await assert.rejects(() => dispatch('bad', 'x'), /returned 500/);
  } finally {
    upstream.close();
  }
});

// ── Registry TTL (sweepStale, mirroring the queue's retention pattern) ─────────────────────
// The registry is an in-memory Map that previously kept every server forever. It must now
// age a server out after LANGCHAIN_REGISTRY_TTL_MS (default 24h), refreshed on a successful
// dispatch, pruned by a lazy throttled sweep at read time (list/dispatch), with an
// injectable `now` for deterministic tests (exactly like the queue's sweepRetired).

const names = (all) => all.map((s) => s.name);
const has = (name) => list().some((s) => s.name === name);

// The feature adds sweepStale. Guard every call behind an existence assertion so these cases
// fail *by assertion* on code that has not added it, and exercise it for real once it exists.
function sweepNow(now) {
  assert.equal(typeof sweepStale, 'function', 'the registry must export sweepStale(now)');
  if (typeof sweepStale === 'function') sweepStale(now);
}

test('register stamps lastSeenAt, and sweepStale drops a server older than the TTL', () => {
  const server = register({ name: 'ttl-drop', url: 'http://localhost:1/a' });
  assert.equal(typeof server.lastSeenAt, 'string', 'register must stamp lastSeenAt');
  assert.ok(!Number.isNaN(Date.parse(server.lastSeenAt)), 'lastSeenAt must be a parseable ISO timestamp');

  const t0 = Date.now();
  sweepNow(t0 + 60_000); // within the 24h default window
  assert.ok(has('ttl-drop'), 'a server seen recently must survive the sweep');

  sweepNow(t0 + 86_400_000 + 60_000); // a minute past the default TTL
  assert.ok(!has('ttl-drop'), 'a server idle past the TTL must be swept');
});

test('a successful dispatch refreshes lastSeenAt, so an active server is not swept', async () => {
  const upstream = http.createServer((req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ output: 'ok' }));
  });
  await new Promise((r) => upstream.listen(0, r));
  process.env.LANGCHAIN_REGISTRY_TTL_MS = '86400000'; // 24h window
  try {
    const server = register({ name: 'ttl-active', url: `http://localhost:${upstream.address().port}/` });
    const t0 = Date.parse(server.lastSeenAt);

    await dispatch('ttl-active', 'x'); // a hit keeps it alive
    const after = Date.parse(list().find((s) => s.name === 'ttl-active').lastSeenAt);
    assert.ok(after >= t0, 'a successful dispatch must advance lastSeenAt');

    sweepNow(t0 + 86_400_000 + 60_000); // a minute past the *original* stamp
    assert.ok(has('ttl-active'), 'a server that has been used since must not be swept');
  } finally {
    delete process.env.LANGCHAIN_REGISTRY_TTL_MS;
    upstream.close();
  }
});

test('a failed dispatch does not refresh lastSeenAt, so a dead server ages out', async () => {
  const upstream = http.createServer((req, res) => res.writeHead(500).end());
  await new Promise((r) => upstream.listen(0, r));
  process.env.LANGCHAIN_REGISTRY_TTL_MS = '1'; // tiny window: stale almost immediately
  try {
    const server = register({ name: 'ttl-dead', url: `http://localhost:${upstream.address().port}/` });
    const t0 = Date.parse(server.lastSeenAt);

    await assert.rejects(() => dispatch('ttl-dead', 'x'), /returned 500/);
    const after = Date.parse(list().find((s) => s.name === 'ttl-dead').lastSeenAt);
    assert.equal(after, t0, 'a failed dispatch must not extend the server\u2019s life');

    sweepNow(t0 + 60_000);
    assert.ok(!has('ttl-dead'), 'a dead server never used successfully must be swept');
  } finally {
    delete process.env.LANGCHAIN_REGISTRY_TTL_MS;
    upstream.close();
  }
});

test('the sweep window is controlled by LANGCHAIN_REGISTRY_TTL_MS', () => {
  process.env.LANGCHAIN_REGISTRY_TTL_MS = '1';
  try {
    const s = register({ name: 'ttl-env', url: 'http://localhost:1/b' });
    const t0 = Date.parse(s.lastSeenAt);
    sweepNow(t0 + 60_000);
    assert.ok(!has('ttl-env'), 'a tiny TTL must sweep the server');
  } finally {
    delete process.env.LANGCHAIN_REGISTRY_TTL_MS;
  }

  const s = register({ name: 'ttl-env2', url: 'http://localhost:1/c' });
  const t0 = Date.parse(s.lastSeenAt);
  sweepNow(t0 + 60_000); // well inside the 24h default
  assert.ok(has('ttl-env2'), 'the 24h default must keep a recently-seen server');
});

// The sweep is lazy: it runs on read (list/dispatch) behind a throttle, not from a timer.
// register() must not sweep, and a read must eventually prune an idle server once the
// throttle window lapses.
test('the sweep runs lazily on read and prunes an idle server with no timer', async () => {
  process.env.LANGCHAIN_REGISTRY_TTL_MS = '1'; // stale against the real clock immediately
  try {
    register({ name: 'ttl-lazy', url: 'http://localhost:1/d' });
    assert.ok(has('ttl-lazy'), 'register must not sweep the server it just added');

    // The sweep is throttled to once a minute, so a fresh read may skip it. The real clock
    // advances, so keep reading until the throttle lapses and the sweep fires.
    const deadline = Date.now() + 8000;
    while (has('ttl-lazy') && Date.now() < deadline) {
      list();
      await new Promise((r) => setTimeout(r, 30));
    }
    assert.ok(!has('ttl-lazy'), 'a read must eventually prune the idle server');
  } finally {
    delete process.env.LANGCHAIN_REGISTRY_TTL_MS;
  }
});

test('GET /langchain/servers returns lastSeenAt and the read prunes a stale server', async () => {
  process.env.LANGCHAIN_ALLOWED_HOSTS = 'localhost';
  process.env.LANGCHAIN_REGISTRY_TTL_MS = '1';
  const app = express();
  app.use('/langchain', router);
  const srv = http.createServer(app);
  await new Promise((r) => srv.listen(0, r));
  const base = `http://localhost:${srv.address().port}`;
  try {
    const reg = await fetch(`${base}/langchain/servers`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'http-ttl', url: `${base}/` }),
    });
    assert.equal(reg.status, 201);
    assert.equal(typeof (await reg.json()).lastSeenAt, 'string', 'register must stamp lastSeenAt');

    const get = await (await fetch(`${base}/langchain/servers`)).json();
    assert.ok(get.servers.some((s) => s.name === 'http-ttl' && typeof s.lastSeenAt === 'string'),
      'GET /langchain/servers must expose lastSeenAt per entry');

    // Sweep on read: keep reading until the throttled sweep prunes the stale server.
    const deadline = Date.now() + 8000;
    let present = true;
    while (present && Date.now() < deadline) {
      const body = await (await fetch(`${base}/langchain/servers`)).json();
      present = body.servers.some((s) => s.name === 'http-ttl');
      if (present) await new Promise((r) => setTimeout(r, 30));
    }
    assert.ok(!present, 'the registry must age the server out on read');
  } finally {
    delete process.env.LANGCHAIN_ALLOWED_HOSTS;
    delete process.env.LANGCHAIN_REGISTRY_TTL_MS;
    srv.close();
  }
});
