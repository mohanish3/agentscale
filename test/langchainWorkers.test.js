const { test } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { register, dispatch } = require('../src/langchainWorkers/index.js');

test('rejects a non-http url', () => {
  assert.throws(() => register({ name: 'x', url: 'ftp://host/' }), /http/);
  assert.throws(() => register({ name: 'x', url: 'not a url' }), /valid URL/);
});

test('dispatches to the registered server and returns its output', async () => {
  let seen;
  const upstream = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      seen = { url: req.url, body: JSON.parse(body) };
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ output: 'done' }));
    });
  });
  await new Promise((r) => upstream.listen(0, r));
  try {
    register({ name: 'chain', url: `http://localhost:${upstream.address().port}/base` });
    assert.deepEqual(await dispatch('chain', 'hello'), { output: 'done' });
    assert.equal(seen.url, '/base/invoke');
    assert.deepEqual(seen.body, { input: 'hello' });
  } finally {
    upstream.close();
  }
});

test('an upstream failure surfaces as an error', async () => {
  const upstream = http.createServer((req, res) => res.writeHead(500).end());
  await new Promise((r) => upstream.listen(0, r));
  try {
    register({ name: 'bad', url: `http://localhost:${upstream.address().port}` });
    await assert.rejects(() => dispatch('bad', 'x'), /returned 500/);
  } finally {
    upstream.close();
  }
});
