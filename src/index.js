const crypto = require('node:crypto');
const express = require('express');
const queue = require('./queue');
const integrations = require('./integrations');
const n8n = require('./n8n');
const langchainWorkers = require('./langchainWorkers');
const orchestrator = require('./orchestrator');

const app = express();

// Webhook signatures are computed over the bytes as sent, so keep them before parsing.
app.use(express.json({ verify: (req, res, buf) => { req.rawBody = buf; } }));

app.get('/health', (req, res) => {
  res.json({ status: 'ok' });
});

// The control and worker surfaces are as sensitive as the verified webhook surface:
// draining the queue reads every task payload, and registering a LangChain server
// picks where task input gets POSTed. An unset token refuses, same as a missing
// webhook secret — it is never a reason to serve these open.
// ponytail: one shared secret for the whole worker/control surface; issue per-worker
// credentials when the pool spans accounts or tenants.
function requireWorkerToken(req, res, next) {
  const expected = process.env.WORKER_TOKEN;
  if (!expected) return res.status(503).json({ error: 'WORKER_TOKEN is not configured' });
  const got = (req.get('authorization') ?? '').replace(/^Bearer /, '');
  if (got.length !== expected.length || !crypto.timingSafeEqual(Buffer.from(got), Buffer.from(expected))) {
    return res.status(401).json({ error: 'unauthorized' });
  }
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
  const task = queue.dequeue();
  return task ? res.json(task) : res.status(204).end();
});

if (require.main === module) {
  const port = process.env.PORT || 8000;
  app.listen(port, () => console.log(`agentscale listening on ${port}`));
}

module.exports = app;
