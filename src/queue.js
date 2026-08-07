// Shared dispatch target: webhooks, n8n workflows and LangChain jobs all land here,
// and the orchestrator scales the worker pool off its depth.
//
// Delivery is at-least-once, deliberately mirroring SQS: a worker leases a task, and the
// lease expires unless the worker reports an outcome. A worker that dies mid-task does not
// take the task with it. Keeping these semantics here means swapping in SQS later is an
// adapter, not a redesign.
//
// ponytail: in-process, so it dies with the process and does not span replicas.
// Swap for SQS when workers run outside this process — see the README status section.
const crypto = require('node:crypto');

const DEFAULT_VISIBILITY_MS = 300_000;
const DEFAULT_MAX_ATTEMPTS = 3;

const visibilityMs = () => Number(process.env.TASK_VISIBILITY_MS ?? DEFAULT_VISIBILITY_MS);
const maxAttempts = () => Number(process.env.TASK_MAX_ATTEMPTS ?? DEFAULT_MAX_ATTEMPTS);

const pending = [];
const inFlight = new Map(); // id -> { task, leaseExpiresAt }
const attempts = new Map(); // id -> delivery count, survives redelivery
const results = new Map(); // id -> { status, ... }
const tasksById = new Map(); // every task ever accepted, so a dedupe hit resolves after completion
const byDedupeKey = new Map(); // dedupe key -> task id
const deadLetter = new Map(); // id -> { task, error, attempts, failedAt } for gave-up tasks
let nextId = 1;

const stamp = () => new Date().toISOString();

// dedupeKey makes enqueue idempotent: providers retry webhooks, and without this a retry
// runs the agent a second time. A repeat key returns the original task rather than a new one.
function enqueue(source, payload, dedupeKey) {
  if (dedupeKey != null && byDedupeKey.has(dedupeKey)) {
    return tasksById.get(byDedupeKey.get(dedupeKey));
  }
  const task = { id: String(nextId++), source, payload, enqueuedAt: stamp() };
  tasksById.set(task.id, task);
  if (dedupeKey != null) byDedupeKey.set(dedupeKey, task.id);
  pending.push(task);
  results.set(task.id, { status: 'queued', enqueuedAt: task.enqueuedAt });
  return task;
}

// Hand a task to a worker under a lease. Sweeps first so expired leases are redeliverable.
function lease() {
  sweepExpired();
  const task = pending.shift();
  if (!task) return null;
  const attempt = (attempts.get(task.id) ?? 0) + 1;
  attempts.set(task.id, attempt);
  // A slow worker can still be running after its lease expired and the task was handed to
  // someone else. The token identifies which lease a report belongs to, so the straggler's
  // late result cannot retire or overwrite the lease now held by another worker.
  const leaseToken = crypto.randomUUID();
  inFlight.set(task.id, { task, leaseToken, leaseExpiresAt: Date.now() + visibilityMs() });
  results.set(task.id, { status: 'running', attempt, startedAt: stamp() });
  return { ...task, leaseToken };
}

// False means the report came from a lease that is no longer current — the caller was
// superseded and its result is discarded rather than applied to someone else's work.
function holdsLease(id, leaseToken) {
  return inFlight.get(id)?.leaseToken === leaseToken;
}

// Returns tasks whose worker never reported back. Called on every lease rather than from a
// timer: no interval to leak, and the only moment redelivery matters is when work is wanted.
function sweepExpired(now = Date.now()) {
  for (const [id, held] of inFlight) {
    if (held.leaseExpiresAt > now) continue;
    inFlight.delete(id);
    retryOrFail(id, held.task, 'worker stopped reporting');
  }
}

function retryOrFail(id, task, reason) {
  if ((attempts.get(id) ?? 0) >= maxAttempts()) {
    const error = `${reason}; gave up after ${attempts.get(id)} attempts`;
    results.set(id, { status: 'failed', error, completedAt: stamp() });
    // ponytail: in-process, like the rest of this file — a dead-lettered task is inspectable
    // and replayable within a process lifetime, but does not survive a restart. SQS gives a
    // durable DLQ for free once the queue itself moves (see WAYFINDER.md).
    deadLetter.set(id, { task, error, attempts: attempts.get(id), failedAt: stamp() });
    return;
  }
  pending.push(task);
  results.set(id, { status: 'queued', requeuedAt: stamp() });
}

// Gave-up tasks, for an operator to inspect before deciding whether to replay them.
function deadLettered() {
  return [...deadLetter.values()];
}

// Puts a dead-lettered task back on the queue with a clean attempt count, as if freshly
// enqueued. Not available for a task that is still pending, in flight, or already succeeded —
// only one that actually exhausted its attempts.
function replay(id) {
  const entry = deadLetter.get(id);
  if (!entry) return false;
  deadLetter.delete(id);
  attempts.set(id, 0);
  pending.push(entry.task);
  results.set(id, { status: 'queued', requeuedAt: stamp() });
  return true;
}

function ack(id, outcome, leaseToken) {
  if (!holdsLease(id, leaseToken)) return false;
  inFlight.delete(id);
  results.set(id, { ...outcome, completedAt: stamp() });
  return true;
}

// A reported failure is retried like a lost lease — a flaky agent run should not be terminal
// until it has used its attempts.
function nack(id, error, leaseToken) {
  const held = inFlight.get(id);
  if (!holdsLease(id, leaseToken)) return false;
  inFlight.delete(id);
  retryOrFail(id, held.task, error ?? 'task failed');
  return true;
}

// Visible work only, matching what an autoscaler should react to (SQS's
// ApproximateNumberOfMessagesVisible). In-flight tasks already have a worker on them.
function depth() {
  sweepExpired();
  return pending.length;
}

function getResult(id) {
  return results.get(id) ?? null;
}

function clear() {
  pending.length = 0;
  inFlight.clear();
  attempts.clear();
  results.clear();
  tasksById.clear();
  byDedupeKey.clear();
  deadLetter.clear();
}

module.exports = {
  enqueue, lease, ack, nack, depth, getResult, clear, sweepExpired, deadLettered, replay,
};
