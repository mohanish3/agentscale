const crypto = require('node:crypto');
const express = require('express');
const queue = require('../queue');

const STRIPE_TOLERANCE_S = 300;

function hmacHex(secret, data) {
  return crypto.createHmac('sha256', secret).update(data).digest('hex');
}

// timingSafeEqual throws on length mismatch, and the attacker controls the header,
// so length is checked first rather than letting a bad header 500 the route.
function safeEqual(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string' || a.length !== b.length) return false;
  return crypto.timingSafeEqual(Buffer.from(a), Buffer.from(b));
}

// Stripe sends "t=<ts>,v1=<hex>,v0=<hex>".
function parseCommaSigned(header) {
  const parts = {};
  for (const part of (header ?? '').split(',')) {
    const i = part.indexOf('=');
    if (i > 0) parts[part.slice(0, i).trim()] = part.slice(i + 1).trim();
  }
  return parts;
}

// Every verify() takes the raw request bytes, never the parsed body: re-serializing
// JSON reorders keys and drops whitespace, so the digest would never match a real sender.
const providers = {
  github: {
    secretEnv: 'GITHUB_WEBHOOK_SECRET',
    verify: (secret, req) =>
      safeEqual(req.get('x-hub-signature-256') ?? '', `sha256=${hmacHex(secret, req.rawBody)}`),
  },
  stripe: {
    secretEnv: 'STRIPE_WEBHOOK_SECRET',
    verify: (secret, req) => {
      const { t, v1 } = parseCommaSigned(req.get('stripe-signature'));
      if (!t || !v1) return false;
      // Without a tolerance window a captured request replays forever.
      if (!(Math.abs(Date.now() / 1000 - Number(t)) <= STRIPE_TOLERANCE_S)) return false;
      const signed = Buffer.concat([Buffer.from(`${t}.`), req.rawBody]);
      return safeEqual(v1, hmacHex(secret, signed));
    },
  },
  generic: {
    secretEnv: 'GENERIC_WEBHOOK_SECRET',
    verify: (secret, req) => safeEqual(req.get('x-signature-256') ?? '', hmacHex(secret, req.rawBody)),
  },
};

const router = express.Router();

router.post('/:provider/webhook', (req, res) => {
  const provider = providers[req.params.provider];
  if (!provider) return res.status(404).json({ error: 'unknown provider' });

  // An unset secret is a misconfiguration, not permission to skip verification.
  const secret = process.env[provider.secretEnv];
  if (!secret) return res.status(503).json({ error: `${provider.secretEnv} is not configured` });

  if (!Buffer.isBuffer(req.rawBody) || !provider.verify(secret, req)) {
    return res.status(401).json({ error: 'invalid signature' });
  }

  const task = queue.enqueue(`integrations:${req.params.provider}`, req.body);
  res.status(202).json({ taskId: task.id });
});

module.exports = { router, providers };
