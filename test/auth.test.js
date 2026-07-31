const { test, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const app = require('../src/index.js');
const queue = require('../src/queue.js');

const TOKEN = 'test-worker-token';
let server;
let base;

before(() => {
  process.env.WORKER_TOKEN = TOKEN;
  server = app.listen(0);
  base = `http://localhost:${server.address().port}`;
});
after(() => server.close());
beforeEach(() => {
  queue.clear();
  queue.enqueue('test', { secret: 'do not leak' });
});

test('the queue cannot be drained without a token', async () => {
  const res = await fetch(`${base}/tasks/next`, { method: 'POST' });
  assert.equal(res.status, 401);
  assert.equal(queue.depth(), 1, 'task must still be queued');
});

test('a wrong token is rejected', async () => {
  const res = await fetch(`${base}/tasks/next`, {
    method: 'POST',
    headers: { authorization: 'Bearer wrong-token-here' },
  });
  assert.equal(res.status, 401);
  assert.equal(queue.depth(), 1);
});

test('a valid token drains the queue', async () => {
  const res = await fetch(`${base}/tasks/next`, {
    method: 'POST',
    headers: { authorization: `Bearer ${TOKEN}` },
  });
  assert.equal(res.status, 200);
  assert.equal((await res.json()).source, 'test');
  assert.equal(queue.depth(), 0);
});

test('server registration and workflow ingest are protected too', async () => {
  for (const path of ['/langchain/servers', '/n8n/workflows']) {
    const res = await fetch(`${base}${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'x', url: 'http://evil.example/', nodes: [{ name: 'A' }] }),
    });
    assert.equal(res.status, 401, `${path} must require a token`);
  }
});

test('health stays public', async () => {
  assert.equal((await fetch(`${base}/health`)).status, 200);
});
