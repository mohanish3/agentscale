const { test } = require('node:test');
const assert = require('node:assert/strict');
const {
  desiredCount, workerHealth, HEARTBEAT_TTL_MS, WORKER_EVICT_MS,
} = require('../src/orchestrator/index.js');
const app = require('../src/index.js');

test('scales with queue depth', () => {
  assert.equal(desiredCount(0), 0);
  assert.equal(desiredCount(1), 1);
  assert.equal(desiredCount(5), 1);
  assert.equal(desiredCount(6), 2);
});

test('clamps to min and max', () => {
  assert.equal(desiredCount(0, { min: 2 }), 2);
  assert.equal(desiredCount(1000, { max: 10 }), 10);
});

test('rejects nonsense scaling config', () => {
  assert.throws(() => desiredCount(10, { tasksPerWorker: 0 }), RangeError);
  assert.throws(() => desiredCount(10, { min: 5, max: 1 }), RangeError);
});

test('a stale heartbeat reads as unhealthy', async () => {
  process.env.WORKER_TOKEN = 'test-worker-token';
  const auth = { authorization: 'Bearer test-worker-token' };
  const server = app.listen(0);
  const base = `http://localhost:${server.address().port}`;
  try {
    await fetch(`${base}/orchestrator/workers/w1/heartbeat`, { method: 'POST', headers: auth });
    const { workers } = await (await fetch(`${base}/orchestrator/workers`, { headers: auth })).json();
    assert.deepEqual(workers.map((w) => [w.id, w.healthy]), [['w1', true]]);
    assert.equal(workerHealth(Date.now() + HEARTBEAT_TTL_MS + 1)[0].healthy, false);
  } finally {
    server.close();
  }
});

// Worker ids default to `worker-${pid}`, so a pool that scales in and back out again used to
// leave a permanently unhealthy entry per cycle, and GET /orchestrator/workers grew forever.
test('a worker that never comes back is eventually forgotten', async () => {
  process.env.WORKER_TOKEN = 'test-worker-token';
  const auth = { authorization: 'Bearer test-worker-token' };
  const server = app.listen(0);
  const base = `http://localhost:${server.address().port}`;
  try {
    await fetch(`${base}/orchestrator/workers/w2/heartbeat`, { method: 'POST', headers: auth });

    // Staying listed-but-unhealthy past the TTL is the point — that is the signal an operator
    // looks at. Eviction is deliberately much later.
    assert.equal(workerHealth(Date.now() + HEARTBEAT_TTL_MS + 1).find((w) => w.id === 'w2').healthy, false);

    assert.deepEqual(workerHealth(Date.now() + WORKER_EVICT_MS + 1), [], 'long-dead workers drop out');
  } finally {
    server.close();
  }
});
