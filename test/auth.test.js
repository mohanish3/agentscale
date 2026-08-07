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

test('WORKER_TOKEN accepts a comma-separated list, so either token authorizes', async () => {
  process.env.WORKER_TOKEN = `${TOKEN},second-worker-token`;
  try {
    for (const t of [TOKEN, 'second-worker-token']) {
      const res = await fetch(`${base}/tasks/next`, {
        method: 'POST',
        headers: { authorization: `Bearer ${t}` },
      });
      assert.equal(res.status, 200, `token ${t} should authorize`);
      queue.enqueue('test', { secret: 'do not leak' }); // put one back for the next iteration
    }
  } finally {
    process.env.WORKER_TOKEN = TOKEN;
  }
});

test('a token not in the list is still rejected', async () => {
  process.env.WORKER_TOKEN = `${TOKEN},second-worker-token`;
  try {
    const res = await fetch(`${base}/tasks/next`, {
      method: 'POST',
      headers: { authorization: 'Bearer third-token-not-issued' },
    });
    assert.equal(res.status, 401);
  } finally {
    process.env.WORKER_TOKEN = TOKEN;
  }
});

test('GET /tasks/dead-letter is its own route, not swallowed by GET /tasks/:id', async () => {
  queue.clear();
  const { id } = queue.enqueue('test', { poison: true });
  const wayLater = () => Date.now() + 10 * 60_000;
  for (let i = 0; i < 3; i++) {
    queue.lease();
    queue.sweepExpired(wayLater());
  }

  const res = await fetch(`${base}/tasks/dead-letter`, {
    headers: { authorization: `Bearer ${TOKEN}` },
  });
  assert.equal(res.status, 200);
  const entries = await res.json();
  assert.equal(entries.length, 1);
  assert.equal(entries[0].task.id, id);
});

test('replaying a dead-lettered task over HTTP re-queues it', async () => {
  queue.clear();
  const { id } = queue.enqueue('test', { poison: true });
  const wayLater = () => Date.now() + 10 * 60_000;
  for (let i = 0; i < 3; i++) {
    queue.lease();
    queue.sweepExpired(wayLater());
  }

  const res = await fetch(`${base}/tasks/${id}/replay`, {
    method: 'POST',
    headers: { authorization: `Bearer ${TOKEN}` },
  });
  assert.equal(res.status, 204);
  assert.equal(queue.getResult(id).status, 'queued');
});

test('replaying an unknown task is a 404', async () => {
  const res = await fetch(`${base}/tasks/no-such-id/replay`, {
    method: 'POST',
    headers: { authorization: `Bearer ${TOKEN}` },
  });
  assert.equal(res.status, 404);
});
