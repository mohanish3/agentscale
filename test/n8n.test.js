const { test } = require('node:test');
const assert = require('node:assert/strict');
const { toTaskGraph } = require('../src/n8n/index.js');

const conn = (to) => ({ main: [[{ node: to, type: 'main', index: 0 }]] });

test('orders nodes by dependency', () => {
  const steps = toTaskGraph({
    nodes: [{ name: 'C' }, { name: 'A' }, { name: 'B' }],
    connections: { A: conn('B'), B: conn('C') },
  });
  assert.deepEqual(steps.map((s) => s.name), ['A', 'B', 'C']);
  assert.deepEqual(steps[0].next, ['B']);
});

test('rejects a cycle', () => {
  assert.throws(
    () => toTaskGraph({ nodes: [{ name: 'A' }, { name: 'B' }], connections: { A: conn('B'), B: conn('A') } }),
    /cycle/,
  );
});

test('rejects a connection to an unknown node', () => {
  assert.throws(() => toTaskGraph({ nodes: [{ name: 'A' }], connections: { A: conn('Ghost') } }), /unknown node/);
});

test('rejects an empty workflow', () => {
  assert.throws(() => toTaskGraph({ nodes: [] }), /non-empty/);
});

test('a workflow with no connections keeps every node', () => {
  const steps = toTaskGraph({ nodes: [{ name: 'A' }, { name: 'B' }] });
  assert.equal(steps.length, 2);
});
