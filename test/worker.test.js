const { test, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const app = require('../src/index.js');
const queue = require('../src/queue.js');
const { runOnce } = require('../src/worker.js');

let server;

before(() => {
  process.env.WORKER_TOKEN = 'test-worker-token';
  server = app.listen(0);
  process.env.AGENTSCALE_URL = `http://localhost:${server.address().port}`;
});
after(() => server.close());
beforeEach(() => queue.clear());

test('an empty queue yields no work', async () => {
  assert.equal(await runOnce(), null);
});

test('an in-flight task reads as running, and an unknown id 404s', async () => {
  const { id } = queue.enqueue('test', {});
  const headers = { authorization: 'Bearer test-worker-token' };

  // Claim the task the way a worker does, but do not report a result yet.
  await fetch(`${process.env.AGENTSCALE_URL}/tasks/next`, { method: 'POST', headers });

  const running = await fetch(`${process.env.AGENTSCALE_URL}/tasks/${id}`, { headers });
  assert.equal(running.status, 200);
  assert.equal((await running.json()).status, 'running');

  const unknown = await fetch(`${process.env.AGENTSCALE_URL}/tasks/nope`, { headers });
  assert.equal(unknown.status, 404, 'an unknown id must be distinguishable from an in-flight one');
});

// Also proves the route is reachable at all — a literal segment under /tasks/ is exactly what
// /tasks/:id has swallowed before.
test('a worker can renew its lease over HTTP, and a stale token is refused', async () => {
  const { id } = queue.enqueue('test', { slow: true });
  const headers = { authorization: 'Bearer test-worker-token', 'content-type': 'application/json' };
  const url = `${process.env.AGENTSCALE_URL}/tasks/${id}/renew`;

  const leased = await (await fetch(`${process.env.AGENTSCALE_URL}/tasks/next`, {
    method: 'POST', headers,
  })).json();
  assert.ok(leased.leaseMs > 0, 'the worker derives its renew interval from this');

  const renewed = await fetch(url, {
    method: 'POST', headers, body: JSON.stringify({ leaseToken: leased.leaseToken }),
  });
  assert.equal(renewed.status, 204);

  const stale = await fetch(url, {
    method: 'POST', headers, body: JSON.stringify({ leaseToken: 'not-the-current-lease' }),
  });
  assert.equal(stale.status, 409, 'a worker that lost the task must be told, not silently allowed');
});

test('a queued task is pulled, run and its result recorded', async () => {
  const { id } = queue.enqueue('integrations:github', { action: 'opened' });

  const handled = await runOnce();

  assert.equal(handled.id, id);
  assert.equal(queue.depth(), 0, 'task should be off the queue');
  assert.deepEqual(queue.getResult(id), {
    status: 'succeeded',
    result: { received: { action: 'opened' } },
    completedAt: queue.getResult(id).completedAt,
  });
});

test('an n8n workflow runs its steps in dependency order', async () => {
  const conn = (to) => ({ main: [[{ node: to, type: 'main', index: 0 }]] });
  const res = await fetch(`${process.env.AGENTSCALE_URL}/n8n/workflows`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: 'Bearer test-worker-token' },
    body: JSON.stringify({
      name: 'deploy',
      nodes: [{ name: 'C' }, { name: 'A' }, { name: 'B' }],
      connections: { A: conn('B'), B: conn('C') },
    }),
  });
  const { taskId } = await res.json();

  await runOnce();

  const { status, result } = queue.getResult(taskId);
  assert.equal(status, 'succeeded');
  assert.equal(result.workflow, 'deploy');
  assert.deepEqual(result.steps.map((s) => s.name), ['A', 'B', 'C']);
});

test('a failing task is retried, then fails for good once attempts run out', async () => {
  // A task claiming to be n8n with a non-array steps payload blows up in handle().
  const { id } = queue.enqueue('n8n', { steps: 'not-an-array' });

  await runOnce();
  assert.equal(queue.getResult(id).status, 'queued', 'first failure should be retried');

  await runOnce();
  assert.equal(queue.getResult(id).status, 'queued');

  await runOnce();
  const outcome = queue.getResult(id);
  assert.equal(outcome.status, 'failed', 'should be terminal after 3 attempts');
  assert.match(outcome.error, /gave up after 3 attempts/);
  assert.equal(await runOnce(), null, 'a task that gave up must not be redelivered');
});
