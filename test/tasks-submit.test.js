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
beforeEach(() => queue.clear());

const auth = { authorization: `Bearer ${TOKEN}` };

function submit(body, headers = {}) {
  return fetch(`${base}/tasks`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify(body),
  });
}

test('POST /tasks with a worker token enqueues the payload and returns a task id', async () => {
  const res = await submit({ payload: { job: 'summarize', url: 'https://example.com' } }, auth);
  assert.equal(res.status, 202);

  const body = await res.json();
  assert.ok(body.taskId, 'a new task id must be returned');
  assert.equal(queue.depth(), 1, 'the submitted work must land in the queue');

  // The submitted task is leased like any other, and is pollable afterwards.
  const leased = queue.lease();
  assert.equal(leased.id, body.taskId);
  assert.equal(leased.source, 'http');
  assert.deepEqual(leased.payload, { job: 'summarize', url: 'https://example.com' });
  assert.equal(queue.getResult(body.taskId).status, 'running');
});

test('reusing an idempotency key returns the original task, not a new one', async () => {
  const first = await submit({ payload: { n: 1 }, idempotencyKey: 'sub-a' }, auth);
  const retry = await submit({ payload: { n: 1 }, idempotencyKey: 'sub-a' }, auth);

  assert.equal(first.status, 202);
  assert.equal(retry.status, 202, 'a resubmission must not look like an error');
  assert.equal((await retry.json()).taskId, (await first.json()).taskId);
  assert.equal(queue.depth(), 1, 'a repeated key must not run the work twice');
});

test('submissions without an idempotency key are always distinct', async () => {
  const a = await submit({ payload: { n: 1 } }, auth);
  const b = await submit({ payload: { n: 1 } }, auth);

  assert.equal(a.status, 202);
  assert.equal(b.status, 202);
  assert.notEqual((await a.json()).taskId, (await b.json()).taskId);
  assert.equal(queue.depth(), 2, 'identical payloads without a key are separate submissions');
});

test('an idempotency key keeps resolving the original task after it completes', async () => {
  const first = await submit({ payload: { n: 1 }, idempotencyKey: 'sub-done' }, auth);
  // Assert the status before parsing the body: a non-2xx response is not JSON, and reading
  // the status first is what makes a missing route fail on a clean assertion rather than a
  // JSON parse of the error page.
  assert.equal(first.status, 202, 'the submission must be accepted before its key is read back');
  const taskId = (await first.json()).taskId;
  const { leaseToken } = queue.lease();
  queue.ack(taskId, { status: 'succeeded', result: { ok: true } }, leaseToken);

  const retry = await submit({ payload: { n: 1 }, idempotencyKey: 'sub-done' }, auth);
  assert.equal(retry.status, 202);
  assert.equal((await retry.json()).taskId, taskId);
  assert.equal(queue.depth(), 0, 'a late resubmission must not resurrect finished work');
});

test('a missing token is rejected and nothing is queued', async () => {
  const res = await submit({ payload: { n: 1 } });
  assert.equal(res.status, 401);
  assert.equal(queue.depth(), 0);
});

test('a wrong token is rejected and nothing is queued', async () => {
  const res = await submit({ payload: { n: 1 } }, { authorization: 'Bearer wrong-token' });
  assert.equal(res.status, 401);
  assert.equal(queue.depth(), 0);
});

test('an unconfigured WORKER_TOKEN refuses rather than serving the route open', async () => {
  const saved = process.env.WORKER_TOKEN;
  delete process.env.WORKER_TOKEN;
  try {
    const res = await submit({ payload: { n: 1 } }, auth);
    assert.equal(res.status, 503);
    assert.equal(queue.depth(), 0);
  } finally {
    process.env.WORKER_TOKEN = saved;
  }
});
