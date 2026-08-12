const express = require('express');
const queue = require('../queue');

const DEFAULTS = { tasksPerWorker: 5, min: 0, max: 50 };
const HEARTBEAT_TTL_MS = 30_000;
// Worker ids default to `worker-${pid}`, so every scale-in left a permanently unhealthy entry
// here that nothing ever removed. Stay visible long enough to be noticed, then drop.
const WORKER_EVICT_MS = HEARTBEAT_TTL_MS * 10;

const workers = new Map(); // id -> last heartbeat (ms epoch)
let desired = DEFAULTS.min;

// How many workers a given queue depth needs. This is the whole scaling policy.
function desiredCount(depth, opts = {}) {
  const { tasksPerWorker, min, max } = { ...DEFAULTS, ...opts };
  if (!Number.isFinite(tasksPerWorker) || tasksPerWorker <= 0) {
    throw new RangeError('tasksPerWorker must be a positive number');
  }
  if (!Number.isFinite(min) || !Number.isFinite(max) || min > max || min < 0) {
    throw new RangeError('min must be >= 0 and <= max');
  }
  return Math.min(max, Math.max(min, Math.ceil(Math.max(0, depth) / tasksPerWorker)));
}

function workerHealth(now = Date.now()) {
  for (const [id, lastSeen] of workers) {
    if (now - lastSeen >= WORKER_EVICT_MS) workers.delete(id);
  }
  return [...workers].map(([id, lastSeen]) => ({
    id,
    lastSeen: new Date(lastSeen).toISOString(),
    healthy: now - lastSeen < HEARTBEAT_TTL_MS,
  }));
}

const router = express.Router();

// Workers call this on a timer; anything past HEARTBEAT_TTL_MS reads as unhealthy.
// Evict on the write path too, not only in workerHealth() — otherwise a pool that scales in and
// out while nobody polls GET /orchestrator/workers keeps growing, which is the exact failure
// this eviction exists to stop.
router.post('/workers/:id/heartbeat', (req, res) => {
  workerHealth();
  workers.set(req.params.id, Date.now());
  res.json({ ok: true });
});

router.get('/workers', (req, res) => {
  res.json({ desired, queueDepth: queue.depth(), workers: workerHealth() });
});

// ponytail: computes and records a target count only, never calls AWS. The Fargate service
// does scale now, but off a CPU target-tracking policy in Terraform (infra/aws), not off this
// number — queue depth isn't a metric ECS Application Auto Scaling can read natively. Wiring
// this endpoint to ECS UpdateService (@aws-sdk/client-ecs) would make queue depth the scaling
// signal instead of CPU, but needs a real cluster and credentials to verify against first.
router.post('/scale', (req, res) => {
  try {
    desired = desiredCount(queue.depth(), req.body ?? {});
  } catch (err) {
    return res.status(400).json({ error: err.message });
  }
  res.json({ desired, queueDepth: queue.depth() });
});

module.exports = { router, desiredCount, workerHealth, HEARTBEAT_TTL_MS, WORKER_EVICT_MS };
