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

test('a failing task reports failure instead of vanishing', async () => {
  // A task claiming to be n8n with a non-array steps payload blows up in handle().
  const { id } = queue.enqueue('n8n', { steps: 'not-an-array' });

  await runOnce();

  const outcome = queue.getResult(id);
  assert.equal(outcome.status, 'failed');
  assert.match(outcome.error, /map is not a function/);
});
