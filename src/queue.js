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
const DEFAULT_RETENTION_MS = 86_400_000; // 24h — longer than any provider's webhook retry window
const DEFAULT_MAX_LEASE_MS = 3_600_000; // ceiling on how long renewals can hold one lease open
const RETENTION_SWEEP_EVERY_MS = 60_000;

const visibilityMs = () => Number(process.env.TASK_VISIBILITY_MS ?? DEFAULT_VISIBILITY_MS);
const maxAttempts = () => Number(process.env.TASK_MAX_ATTEMPTS ?? DEFAULT_MAX_ATTEMPTS);
const retentionMs = () => Number(process.env.TASK_RETENTION_MS ?? DEFAULT_RETENTION_MS);
const maxLeaseMs = () => Number(process.env.TASK_MAX_LEASE_MS ?? DEFAULT_MAX_LEASE_MS);

const pending = [];
const inFlight = new Map(); // id -> { task, leaseExpiresAt }
const attempts = new Map(); // id -> delivery count, survives redelivery
const results = new Map(); // id -> { status, ... }
const tasksById = new Map(); // every task ever accepted, so a dedupe hit resolves after completion
const byDedupeKey = new Map(); // dedupe key -> task id
const deadLetter = new Map(); // id -> { task, error, attempts, failedAt } for gave-up tasks
let nextId = 1;
let lastRetentionSweep = 0;

const stamp = () => new Date().toISOString();

// dedupeKey makes enqueue idempotent: providers retry webhooks, and without this a retry
// runs the agent a second time. A repeat key returns the original task rather than a new one.
function enqueue(source, payload, dedupeKey) {
  sweepRetired();
  if (dedupeKey != null && byDedupeKey.has(dedupeKey)) {
    return tasksById.get(byDedupeKey.get(dedupeKey));
  }
  // The key is kept on the task so retention can drop its byDedupeKey entry too, rather than
  // leaking one string per webhook forever.
  const task = { id: String(nextId++), source, payload, enqueuedAt: stamp(), dedupeKey };
  tasksById.set(task.id, task);
  if (dedupeKey != null) byDedupeKey.set(dedupeKey, task.id);
  pending.push(task);
  results.set(task.id, { status: 'queued', enqueuedAt: task.enqueuedAt });
  return task;
}

// Hand a task to a worker under a lease. Sweeps first so expired leases are redeliverable.
function lease() {
  sweepExpired();
  sweepRetired();
  const task = pending.shift();
  if (!task) return null;
  const attempt = (attempts.get(task.id) ?? 0) + 1;
  attempts.set(task.id, attempt);
  // A slow worker can still be running after its lease expired and the task was handed to
  // someone else. The token identifies which lease a report belongs to, so the straggler's
  // late result cannot retire or overwrite the lease now held by another worker.
  const leaseToken = crypto.randomUUID();
  const leasedAt = Date.now();
  inFlight.set(task.id, { task, leaseToken, leasedAt, leaseExpiresAt: leasedAt + visibilityMs() });
  results.set(task.id, { status: 'running', attempt, startedAt: stamp() });
  // leaseMs is a duration, not a deadline: the worker runs on a different machine, and a
  // deadline would have it subtracting this process's clock from its own. It renews on a
  // fraction of this, so TASK_VISIBILITY_MS stays the only thing to configure.
  return { ...task, leaseToken, leaseMs: visibilityMs() };
}

// False means the report came from a lease that is no longer current — the caller was
// superseded and its result is discarded rather than applied to someone else's work.
function holdsLease(id, leaseToken) {
  return inFlight.get(id)?.leaseToken === leaseToken;
}

// A worker still working pushes its own deadline out, instead of having the task redelivered
// underneath it — which is what used to happen to any agent run outliving TASK_VISIBILITY_MS.
//
// Capped from when the lease was taken, not per renewal. A worker blocked on a call that never
// returns still has a live event loop, so its renew timer keeps firing and the task would never
// come back: a permanent silent stall, strictly worse than the double-execution the visibility
// timeout already accepts. Past the cap the lease lapses as if the worker had died, so the
// worst-case wall clock for one task is about TASK_MAX_LEASE_MS × TASK_MAX_ATTEMPTS.
function renew(id, leaseToken, now = Date.now()) {
  const held = inFlight.get(id);
  if (!holdsLease(id, leaseToken)) return false;
  if (now - held.leasedAt >= maxLeaseMs()) return false;
  held.leaseExpiresAt = now + visibilityMs();
  return true;
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

// Everything above is keyed by task id and nothing ever removed it: a long-lived API taking
// webhooks accumulated one entry per task, forever, in five maps. Terminal tasks now age out
// after TASK_RETENTION_MS. Only terminal ones — a task with no completedAt is still queued or
// in flight, and dropping it would lose live work.
//
// Dropping the byDedupeKey entry means a provider redelivery older than the retention window
// runs the agent a second time, so the window has to stay longer than any sender's retry
// schedule (GitHub gives up well inside 24h; Stripe retries for 3 days but its own signature
// tolerance rejects a replay after 5 minutes).
//
// ponytail: O(n) scan over results, throttled to once a minute so it stays off the lease path.
// If the terminal set ever gets big enough for that to hurt, keep a completion-ordered list
// and walk it from the front instead.
function sweepRetired(now = Date.now()) {
  if (now - lastRetentionSweep < RETENTION_SWEEP_EVERY_MS) return;
  lastRetentionSweep = now;
  const cutoff = now - retentionMs();
  for (const [id, result] of results) {
    if (!result.completedAt || Date.parse(result.completedAt) > cutoff) continue;
    const dedupeKey = tasksById.get(id)?.dedupeKey;
    if (dedupeKey != null) byDedupeKey.delete(dedupeKey);
    results.delete(id);
    tasksById.delete(id);
    attempts.delete(id);
    deadLetter.delete(id);
  }
}

function retryOrFail(id, task, reason) {
  if ((attempts.get(id) ?? 0) >= maxAttempts()) {
    const error = `${reason}; gave up after ${attempts.get(id)} attempts`;
    results.set(id, { status: 'failed', error, completedAt: stamp() });
    // ponytail: in-process, like the rest of this file — a dead-lettered task is inspectable
    // and replayable within a process lifetime, but does not survive a restart. SQS gives a
    // durable DLQ for free once the queue itself moves (see the README's status section).
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
  lastRetentionSweep = 0;
}

module.exports = {
  enqueue, lease, renew, ack, nack, depth, getResult, clear, sweepExpired, sweepRetired,
  deadLettered, replay,
};
