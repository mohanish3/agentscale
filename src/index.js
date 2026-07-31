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

app.use('/integrations', integrations.router);
app.use('/n8n', n8n.router);
app.use('/langchain', langchainWorkers.router);
app.use('/orchestrator', orchestrator.router);

// Workers pull from the same queue everything else dispatches into.
app.post('/tasks/next', (req, res) => {
  const task = queue.dequeue();
  return task ? res.json(task) : res.status(204).end();
});

if (require.main === module) {
  const port = process.env.PORT || 8000;
  app.listen(port, () => console.log(`agentscale listening on ${port}`));
}

module.exports = app;
