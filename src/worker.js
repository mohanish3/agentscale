// The other half of the system: pulls tasks off the queue, runs them, reports the outcome.
// This is what the Fargate task definition's container image is meant to run.
const IDLE_MS = Number(process.env.WORKER_IDLE_MS ?? 1000);
const HEARTBEAT_MS = 10_000;
// Only used if the API hands out a task without a usable leaseMs; matches the queue's default
// TASK_VISIBILITY_MS so the two don't drift apart silently.
const DEFAULT_LEASE_MS = 300_000;

// Read at call time rather than module load so tests can point at an ephemeral port.
const config = () => ({
  base: process.env.AGENTSCALE_URL ?? 'http://localhost:8000',
  token: process.env.WORKER_TOKEN,
  id: process.env.WORKER_ID ?? `worker-${process.pid}`,
});

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function call(path, { method = 'POST', body } = {}) {
  const { base, token } = config();
  const res = await fetch(new URL(path, base), {
    method,
    headers: {
      authorization: `Bearer ${token}`,
      ...(body === undefined ? {} : { 'content-type': 'application/json' }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  if (!res.ok && res.status !== 204) throw new Error(`${method} ${path} returned ${res.status}`);
  return res.status === 204 ? null : res.json();
}

// ponytail: this is the plug point — replace the body with your agent runtime. The default
// resolves what it was handed so the pipeline is verifiable end to end without one.
async function handle(task) {
  if (task.source === 'n8n') {
    // Steps arrive dependency-ordered from src/n8n, so running them in array order is the
    // correct execution: a node never starts before the nodes feeding it have run.
    const steps = (task.payload?.steps ?? []).map((s) => ({ name: s.name, type: s.type }));
    return { workflow: task.payload?.workflow, steps };
  }
  return { received: task.payload };
}

// One poll-execute-report cycle. Returns the task it handled, or null when the queue is empty.
async function runOnce() {
  const task = await call('/tasks/next');
  if (!task) return null;
  // Echoed back so the API can tell this report apart from one by a worker that took the task
  // over after this lease expired. A 409 means exactly that, and is not worth retrying.
  const { leaseToken, leaseMs } = task;

  // Hold the lease open for as long as the agent runs, instead of letting a slow task get
  // redelivered underneath us. Renew at half the lease the API handed out, so a single lost
  // renewal isn't fatal, and there's no second timeout to keep in sync with the API's.
  // Guarded because setInterval(NaN) fires flat out.
  const renewEveryMs = Math.max(1000, Math.floor((Number(leaseMs) || DEFAULT_LEASE_MS) / 2));
  const renewTimer = setInterval(() => {
    // Nothing in here may reject: an unhandled rejection inside a timer callback takes the whole
    // worker down. A renewal losing the race with the final report is a 409 and expected, not
    // a reason to die.
    call(`/tasks/${task.id}/renew`, { body: { leaseToken } })
      .catch((err) => console.error(`task ${task.id}: renew failed: ${err.message}`));
  }, renewEveryMs);
  // A pending timer keeps node alive; this one must never be why a worker won't exit.
  renewTimer.unref?.();

  const report = async (body) => {
    try {
      await call(`/tasks/${task.id}/result`, { body: { ...body, leaseToken } });
    } catch (err) {
      if (!/409/.test(err.message)) throw err;
      console.error(`task ${task.id}: lease expired mid-run, result discarded`);
    }
  };

  // Run first, then report — so a reporting failure is never mistaken for a task failure.
  let outcome;
  try {
    outcome = { status: 'succeeded', result: await handle(task) };
  } catch (err) {
    // A failed task must still report, otherwise the caller waits on a result that never lands.
    outcome = { status: 'failed', error: err.message };
  } finally {
    // Before reporting, so a renewal can't land after the ack — and in a finally so runOnce()
    // never leaves a live timer behind, however handle() ended.
    clearInterval(renewTimer);
  }
  await report(outcome);
  return task;
}

async function main() {
  const { token, id, base } = config();
  if (!token) {
    console.error('WORKER_TOKEN is required');
    process.exit(1);
  }

  let running = true;
  // Without this, `docker compose down` and Fargate scale-in both wait out the kill timeout.
  for (const signal of ['SIGTERM', 'SIGINT']) {
    process.on(signal, () => { running = false; });
  }

  console.log(`${id} polling ${base}`);

  // Heartbeat from inside the loop rather than on a timer: a worker that starts before the
  // API is reachable retries every pass until it registers, instead of being invisible for a
  // full interval. Nothing orders startup on ECS the way compose's depends_on does.
  let lastBeat = 0;
  while (running) {
    try {
      if (Date.now() - lastBeat >= HEARTBEAT_MS) {
        await call(`/orchestrator/workers/${id}/heartbeat`);
        lastBeat = Date.now();
      }
      if (!(await runOnce())) await sleep(IDLE_MS);
    } catch (err) {
      // The API being briefly unreachable is normal during a deploy; back off and retry.
      console.error(`poll failed: ${err.message}`);
      await sleep(IDLE_MS);
    }
  }

  console.log(`${id} stopped`);
}

if (require.main === module) main();

module.exports = { handle, runOnce };
