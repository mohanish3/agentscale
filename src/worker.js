// The other half of the system: pulls tasks off the queue, runs them, reports the outcome.
// This is what the Fargate task definition's container image is meant to run.
const IDLE_MS = Number(process.env.WORKER_IDLE_MS ?? 1000);
const HEARTBEAT_MS = 10_000;

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
  try {
    const result = await handle(task);
    await call(`/tasks/${task.id}/result`, { body: { status: 'succeeded', result } });
  } catch (err) {
    // A failed task must still report, otherwise the caller waits on a result that never lands.
    await call(`/tasks/${task.id}/result`, { body: { status: 'failed', error: err.message } });
  }
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
