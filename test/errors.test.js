const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const app = require('../src/index.js');

let base;
let server;

before(() => {
  process.env.WORKER_TOKEN = 'test-worker-token';
  server = app.listen(0);
  base = `http://localhost:${server.address().port}`;
});
after(() => server.close());

const post = (path, body) =>
  fetch(`${base}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: 'Bearer test-worker-token' },
    body,
  });

test('a realistic n8n export is accepted, not 413d by the default body limit', async () => {
  const nodes = Array.from({ length: 200 }, (_, i) => ({
    name: `Node${i}`,
    type: 'n8n-nodes-base.httpRequest',
    parameters: { notes: 'x'.repeat(600) },
  }));
  const body = JSON.stringify({ name: 'big', nodes });
  assert.ok(body.length > 100 * 1024, 'fixture must exceed the 100kb default to be a regression test');

  const res = await post('/n8n/workflows', body);
  assert.equal(res.status, 202);
});

test('errors return JSON and leak no stack trace or filesystem path', async () => {
  const res = await post('/n8n/workflows', '{"nodes": [ this is not json');

  assert.equal(res.status, 400);
  assert.match(res.headers.get('content-type'), /application\/json/);

  const text = await res.text();
  assert.doesNotMatch(text, /node_modules|at \w+ \(|<html/i, 'must not expose internals');
  assert.ok(JSON.parse(text).error, 'should carry an error message');
});

test('a body past the limit is refused as JSON', async () => {
  const res = await post('/n8n/workflows', JSON.stringify({ blob: 'x'.repeat(6 * 1024 * 1024) }));

  assert.equal(res.status, 413);
  assert.match(res.headers.get('content-type'), /application\/json/);
  assert.doesNotMatch(await res.text(), /node_modules/);
});
