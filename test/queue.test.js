const { test, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const queue = require('../src/queue.js');

beforeEach(() => queue.clear());

test('a leased task leaves the visible queue but is not gone', () => {
  const { id } = queue.enqueue('test', {});
  assert.equal(queue.depth(), 1);

  const leased = queue.lease();

  assert.equal(leased.id, id);
  assert.equal(queue.depth(), 0, 'in-flight work should not drive scaling');
  assert.equal(queue.getResult(id).status, 'running');
});

test('a worker that dies mid-task does not take the task with it', () => {
  const { id } = queue.enqueue('test', { work: 'important' });
  queue.lease(); // worker takes it, then vanishes without reporting

  assert.equal(queue.depth(), 0, 'still leased, so not yet visible');

  // Far enough ahead that the lease has expired.
  queue.sweepExpired(Date.now() + 10 * 60_000);

  assert.equal(queue.depth(), 1, 'task must come back');
  assert.equal(queue.getResult(id).status, 'queued');
  assert.equal(queue.lease().id, id, 'and be redeliverable');
});

test('redelivery is bounded — a task that keeps killing workers gives up', () => {
  const { id } = queue.enqueue('test', { poison: true });
  const wayLater = () => Date.now() + 10 * 60_000;

  for (let i = 0; i < 3; i++) {
    queue.lease();
    queue.sweepExpired(wayLater());
  }

  assert.equal(queue.getResult(id).status, 'failed');
  assert.equal(queue.depth(), 0, 'must not redeliver forever');
});

// The visibility timeout deliberately allows two workers to hold the same task, so the queue
// has to survive the slow one reporting after it has been superseded.
test('a superseded worker cannot retire the lease that replaced it', () => {
  const { id } = queue.enqueue('test', {});
  const slow = queue.lease();

  queue.sweepExpired(Date.now() + 10 * 60_000); // slow worker's lease lapses
  const current = queue.lease();

  assert.notEqual(current.leaseToken, slow.leaseToken);

  // The slow worker finally finishes, unaware it lost the task.
  assert.equal(queue.ack(id, { status: 'succeeded', result: 'stale' }, slow.leaseToken), false);

  assert.equal(queue.getResult(id).status, 'running', 'must still belong to the current worker');
  assert.equal(queue.ack(id, { status: 'succeeded', result: 'fresh' }, current.leaseToken), true);
  assert.equal(queue.getResult(id).result, 'fresh');
});

test('a superseded worker cannot requeue the task either', () => {
  const { id } = queue.enqueue('test', {});
  const slow = queue.lease();
  queue.sweepExpired(Date.now() + 10 * 60_000);
  const current = queue.lease();

  assert.equal(queue.nack(id, 'stale failure', slow.leaseToken), false);

  assert.equal(queue.depth(), 0, 'a stale failure must not put the task back while it is running');
  assert.equal(queue.getResult(id).status, 'running');
  assert.equal(queue.nack(id, 'real failure', current.leaseToken), true);
});

test('acking completes the task and releases the lease', () => {
  const { id } = queue.enqueue('test', {});
  const { leaseToken } = queue.lease();

  queue.ack(id, { status: 'succeeded', result: { ok: true } }, leaseToken);

  assert.equal(queue.getResult(id).status, 'succeeded');
  queue.sweepExpired(Date.now() + 10 * 60_000);
  assert.equal(queue.depth(), 0, 'an acked task must never be redelivered');
});

test('the same dedupe key enqueues once and returns the original task', () => {
  const first = queue.enqueue('integrations:github', { n: 1 }, 'github:delivery-abc');
  const retry = queue.enqueue('integrations:github', { n: 1 }, 'github:delivery-abc');

  assert.equal(retry.id, first.id);
  assert.equal(queue.depth(), 1, 'a redelivered webhook must not run the agent twice');
});

test('dedupe still resolves after the original task has completed', () => {
  const first = queue.enqueue('integrations:github', {}, 'github:delivery-abc');
  const { leaseToken } = queue.lease();
  queue.ack(first.id, { status: 'succeeded', result: {} }, leaseToken);

  const retry = queue.enqueue('integrations:github', {}, 'github:delivery-abc');

  assert.equal(retry.id, first.id);
  assert.equal(queue.depth(), 0, 'a late retry must not resurrect finished work');
});

test('tasks without a dedupe key are always distinct', () => {
  const a = queue.enqueue('n8n', {});
  const b = queue.enqueue('n8n', {});

  assert.notEqual(a.id, b.id);
  assert.equal(queue.depth(), 2);
});
