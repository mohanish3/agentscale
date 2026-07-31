const express = require('express');
const queue = require('../queue');

// Flattens an n8n workflow export (nodes + connections) into a dependency-ordered
// list of steps. n8n allows loop-back connections, so cycles are rejected rather
// than silently dropping the nodes a topological sort cannot reach.
function toTaskGraph(workflow) {
  const nodes = workflow?.nodes;
  if (!Array.isArray(nodes) || nodes.length === 0) {
    throw new Error('workflow must have a non-empty nodes array');
  }
  const names = new Set(nodes.map((n) => n?.name));
  if (names.size !== nodes.length || names.has(undefined)) {
    throw new Error('every node needs a unique name');
  }

  const edges = new Map([...names].map((n) => [n, new Set()]));
  const indegree = new Map([...names].map((n) => [n, 0]));

  for (const [from, outputs] of Object.entries(workflow.connections ?? {})) {
    if (!names.has(from)) throw new Error(`connection from unknown node "${from}"`);
    // connections[from] is { main: [[{node}, ...], ...], ... } — one array per output slot.
    for (const slots of Object.values(outputs ?? {})) {
      for (const conn of (slots ?? []).flat()) {
        const to = conn?.node;
        if (!names.has(to)) throw new Error(`connection to unknown node "${to}"`);
        if (edges.get(from).has(to)) continue; // duplicate edge, already counted
        edges.get(from).add(to);
        indegree.set(to, indegree.get(to) + 1);
      }
    }
  }

  // Kahn's algorithm: if it emits fewer nodes than it was given, a cycle held some back.
  const ready = [...names].filter((n) => indegree.get(n) === 0);
  const order = [];
  while (ready.length > 0) {
    const name = ready.shift();
    order.push(name);
    for (const to of edges.get(name)) {
      indegree.set(to, indegree.get(to) - 1);
      if (indegree.get(to) === 0) ready.push(to);
    }
  }
  if (order.length !== nodes.length) throw new Error('workflow contains a cycle');

  const byName = new Map(nodes.map((n) => [n.name, n]));
  return order.map((name) => ({
    name,
    type: byName.get(name).type ?? 'unknown',
    parameters: byName.get(name).parameters ?? {},
    next: [...edges.get(name)],
  }));
}

const router = express.Router();

router.post('/workflows', (req, res) => {
  let steps;
  try {
    steps = toTaskGraph(req.body);
  } catch (err) {
    return res.status(400).json({ error: err.message });
  }
  const task = queue.enqueue('n8n', { workflow: req.body?.name ?? 'unnamed', steps });
  res.status(202).json({ taskId: task.id, steps: steps.map((s) => s.name) });
});

module.exports = { router, toTaskGraph };
