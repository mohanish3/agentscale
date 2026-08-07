const crypto = require('node:crypto');
const express = require('express');
const queue = require('./queue');
const integrations = require('./integrations');
const n8n = require('./n8n');
const langchainWorkers = require('./langchainWorkers');
const orchestrator = require('./orchestrator');

const app = express();

// Webhook signatures are computed over the bytes as sent, so keep them before parsing.
// The default 100kb limit rejects realistic n8n workflow exports (a 200-node export runs
// ~140kb), which 413s the n8n module on its own use case.
app.use(express.json({
  limit: process.env.MAX_BODY_SIZE ?? '5mb',
  verify: (req, res, buf) => { req.rawBody = buf; },
}));

app.get('/health', (req, res) => {
  res.json({ status: 'ok' });
});

// The control and worker surfaces are as sensitive as the verified webhook surface:
// draining the queue reads every task payload, and registering a LangChain server
// picks where task input gets POSTed. An unset token refuses, same as a missing
// webhook secret — it is never a reason to serve these open.
// WORKER_TOKEN is comma-separated, so a caller can be revoked individually rather than
// rotating one secret for the whole pool. Each candidate still gets its own timing-safe
// compare rather than a joined-string search, so token B's bytes can't be inferred from
// how far a match against token A got.
function requireWorkerToken(req, res, next) {
  const tokens = (process.env.WORKER_TOKEN ?? '').split(',').map((t) => t.trim()).filter(Boolean);
  if (tokens.length === 0) return res.status(503).json({ error: 'WORKER_TOKEN is not configured' });
  const got = Buffer.from((req.get('authorization') ?? '').replace(/^Bearer /, ''));
  const authorized = tokens.some((token) => {
    const expected = Buffer.from(token);
    return got.length === expected.length && crypto.timingSafeEqual(got, expected);
  });
  if (!authorized) return res.status(401).json({ error: 'unauthorized' });
  next();
}

// Signed by the sender, so this authenticates itself per-provider.
app.use('/integrations', integrations.router);

// Everything else writes to or reads from the queue with no signature of its own.
app.use('/n8n', requireWorkerToken, n8n.router);
app.use('/langchain', requireWorkerToken, langchainWorkers.router);
app.use('/orchestrator', requireWorkerToken, orchestrator.router);

// Workers pull from the same queue everything else dispatches into.
app.post('/tasks/next', requireWorkerToken, (req, res) => {
  const task = queue.lease();
  return task ? res.json(task) : res.status(204).end();
});

// Reporting an outcome is what releases the lease. A failure is requeued until the task runs
// out of attempts, so a flaky agent run is not terminal on the first try.
app.post('/tasks/:id/result', requireWorkerToken, (req, res) => {
  const { status, result, error, leaseToken } = req.body ?? {};
  const applied = status === 'succeeded'
    ? queue.ack(req.params.id, { status, result }, leaseToken)
    : queue.nack(req.params.id, error, leaseToken);

  // The lease moved on while this worker was still running — its result is stale, and saying
  // so is what makes double-execution visible rather than silent.
  if (!applied) return res.status(409).json({ error: 'lease is no longer held' });
  res.status(204).end();
});

// Tasks that exhausted TASK_MAX_ATTEMPTS, for an operator to look at before deciding what to
// do with them. In-process like the rest of the queue — gone on restart, not a durable DLQ.
// Must stay ahead of GET /tasks/:id, which would otherwise treat "dead-letter" as an id.
app.get('/tasks/dead-letter', requireWorkerToken, (req, res) => {
  res.json(queue.deadLettered());
});

app.get('/tasks/:id', requireWorkerToken, (req, res) => {
  const result = queue.getResult(req.params.id);
  return result ? res.json(result) : res.status(404).json({ error: 'unknown task' });
});

// Puts a dead-lettered task back on the queue with a clean attempt count.
app.post('/tasks/:id/replay', requireWorkerToken, (req, res) => {
  return queue.replay(req.params.id)
    ? res.status(204).end()
    : res.status(404).json({ error: 'not dead-lettered' });
});

// Express's default handler renders an HTML stack trace containing absolute server paths,
// so every error — a 413, a malformed JSON body — leaks filesystem layout to the caller.
app.use((err, req, res, next) => {
  const status = err.status ?? err.statusCode ?? 500;
  if (status >= 500) console.error(err);
  res.status(status).json({ error: status >= 500 ? 'internal error' : err.message });
});

if (require.main === module) {
  const port = process.env.PORT || 8000;
  app.listen(port, () => console.log(`agentscale listening on ${port}`));
}

module.exports = app;
