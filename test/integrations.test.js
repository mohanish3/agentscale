const { test, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const app = require('../src/index.js');
const queue = require('../src/queue.js');

const SECRET = 'test-secret';
let server;
let base;

before(() => {
  process.env.GITHUB_WEBHOOK_SECRET = SECRET;
  delete process.env.STRIPE_WEBHOOK_SECRET;
  server = app.listen(0);
  base = `http://localhost:${server.address().port}`;
});
after(() => server.close());
beforeEach(() => queue.clear());

const sign = (body) => `sha256=${crypto.createHmac('sha256', SECRET).update(body).digest('hex')}`;

function post(path, body, headers = {}) {
  return fetch(`${base}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body,
  });
}

test('valid github signature is accepted and enqueued', async () => {
  // Deliberately not what JSON.stringify would emit: an implementation that hashes the
  // re-serialized body instead of the bytes on the wire fails here, as it would in production.
  const body = '{"action":   "opened",\n  "number": 1}';
  const res = await post('/integrations/github/webhook', body, { 'x-hub-signature-256': sign(body) });
  assert.equal(res.status, 202);
  assert.equal(queue.depth(), 1);
});

test('body tampered after signing is rejected and not enqueued', async () => {
  const signature = sign(JSON.stringify({ amount: 1 }));
  const res = await post('/integrations/github/webhook', JSON.stringify({ amount: 1000000 }), {
    'x-hub-signature-256': signature,
  });
  assert.equal(res.status, 401);
  assert.equal(queue.depth(), 0);
});

test('missing signature header is rejected', async () => {
  const res = await post('/integrations/github/webhook', JSON.stringify({ action: 'opened' }));
  assert.equal(res.status, 401);
  assert.equal(queue.depth(), 0);
});

test('malformed signature header rejects instead of crashing', async () => {
  const body = JSON.stringify({ action: 'opened' });
  const res = await post('/integrations/github/webhook', body, { 'x-hub-signature-256': 'sha256=short' });
  assert.equal(res.status, 401);
  assert.equal(queue.depth(), 0);
});

test('unconfigured secret refuses rather than accepting unverified', async () => {
  const body = JSON.stringify({ id: 'evt_1' });
  const res = await post('/integrations/stripe/webhook', body, { 'stripe-signature': 't=1,v1=abc' });
  assert.equal(res.status, 503);
  assert.equal(queue.depth(), 0);
});

test('a redelivered webhook is accepted but only runs once', async () => {
  const body = JSON.stringify({ action: 'opened' });
  const headers = { 'x-hub-signature-256': sign(body), 'x-github-delivery': 'delivery-abc' };

  const first = await post('/integrations/github/webhook', body, headers);
  const retry = await post('/integrations/github/webhook', body, headers);

  assert.equal(first.status, 202);
  assert.equal(retry.status, 202, 'a retry must not look like an error, or the provider keeps retrying');
  assert.equal((await retry.json()).taskId, (await first.json()).taskId);
  assert.equal(queue.depth(), 1, 'GitHub redelivery must not run the agent twice');
});

test('distinct deliveries of the same payload both enqueue', async () => {
  const body = JSON.stringify({ action: 'opened' });
  const signature = sign(body);

  await post('/integrations/github/webhook', body, { 'x-hub-signature-256': signature, 'x-github-delivery': 'one' });
  await post('/integrations/github/webhook', body, { 'x-hub-signature-256': signature, 'x-github-delivery': 'two' });

  assert.equal(queue.depth(), 2, 'identical payloads are legitimately separate events');
});

test('unknown provider is 404', async () => {
  const res = await post('/integrations/nope/webhook', '{}');
  assert.equal(res.status, 404);
});
