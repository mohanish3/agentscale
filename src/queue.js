// Shared dispatch target: webhooks, n8n workflows and LangChain jobs all land here,
// and the orchestrator scales the worker pool off its depth.
// ponytail: in-process FIFO, so it dies with the process and does not span replicas.
// Swap for SQS when workers run outside this process.
const tasks = [];
let nextId = 1;

function enqueue(source, payload) {
  const task = {
    id: String(nextId++),
    source,
    payload,
    enqueuedAt: new Date().toISOString(),
  };
  tasks.push(task);
  return task;
}

function dequeue() {
  return tasks.shift() ?? null;
}

function depth() {
  return tasks.length;
}

function clear() {
  tasks.length = 0;
}

module.exports = { enqueue, dequeue, depth, clear };
