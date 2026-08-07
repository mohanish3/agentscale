const express = require('express');
const queue = require('../queue');

const DEFAULTS = { tasksPerWorker: 5, min: 0, max: 50 };
const HEARTBEAT_TTL_MS = 30_000;

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
  return [...workers].map(([id, lastSeen]) => ({
    id,
    lastSeen: new Date(lastSeen).toISOString(),
    healthy: now - lastSeen < HEARTBEAT_TTL_MS,
  }));
}

const router = express.Router();

// Workers call this on a timer; anything past HEARTBEAT_TTL_MS reads as unhealthy.
router.post('/workers/:id/heartbeat', (req, res) => {
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

module.exports = { router, desiredCount, workerHealth, HEARTBEAT_TTL_MS };
