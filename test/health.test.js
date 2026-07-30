const { test } = require('node:test');
const assert = require('node:assert/strict');
const app = require('../src/index.js');

test('GET /health returns ok', async () => {
  const server = app.listen(0);
  const { port } = server.address();
  try {
    const res = await fetch(`http://localhost:${port}/health`);
    const body = await res.json();
    assert.equal(res.status, 200);
    assert.deepEqual(body, { status: 'ok' });
  } finally {
    server.close();
  }
});
