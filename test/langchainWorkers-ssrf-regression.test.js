const { test } = require('node:test');
const assert = require('node:assert/strict');
const { register } = require('../src/langchainWorkers/index.js');

// Regression: `new URL()` normalizes a host before assertAllowedHost() ever sees it.
// http://[::ffff:169.254.169.254]/... arrives as the hex form [::ffff:a9fe:a9fe], which
// matches neither the /^169\.254\./ regex nor the '[fd00:ec2::254]' literal — so the
// metadata endpoint was registerable in its IPv4-mapped spelling, and dispatch() would
// POST to it and hand the body back to the caller (AWS credential read on Fargate).
test('refuses the IPv4-mapped IPv6 spelling of the metadata endpoint', () => {
  // Dotted v4 inside an IPv6 literal — what an attacker writes.
  assert.throws(
    () => register({ name: 'imds-mapped', url: 'http://[::ffff:169.254.169.254]/latest/meta-data/' }),
    /not allowed/,
  );
  // The normalized hex form — what URL hands the check, equivalent address.
  assert.throws(
    () => register({ name: 'imds-hex', url: 'http://[::ffff:a9fe:a9fe]/latest/meta-data/' }),
    /not allowed/,
  );
});

test('refuses the IPv4-mapped IPv6 spelling of the task-role endpoint', () => {
  assert.throws(
    () => register({ name: 'ecs-mapped', url: 'http://[::ffff:169.254.170.2]/v2/credentials' }),
    /not allowed/,
  );
});

// The spellings the original code already blocked must keep blocking, so the numeric
// check cannot regress in the other direction.
test('still refuses the plain v4 and v6 spellings it always refused', () => {
  assert.throws(() => register({ name: 'plain-v4', url: 'http://169.254.169.254/latest/meta-data/' }), /not allowed/);
  assert.throws(() => register({ name: 'plain-v4b', url: 'http://169.254.169.1/' }), /not allowed/);
  assert.throws(() => register({ name: 'v6-task-role', url: 'http://[fd00:ec2::254]/' }), /not allowed/);
});

// The fix must block 169.254/16 only, not the rest of the address space: ordinary v4,
// ordinary v6, v4-mapped-non-link-local, and DNS names keep registering.
test('ordinary v4, v6, mapped, and named hosts still register', () => {
  assert.equal(register({ name: 'ok-v4', url: 'http://10.1.2.3/' }).name, 'ok-v4');
  assert.equal(register({ name: 'ok-v6', url: 'http://[2001:db8::1]/' }).name, 'ok-v6');
  assert.equal(register({ name: 'ok-mapped', url: 'http://[::ffff:10.1.2.3]/' }).name, 'ok-mapped');
  assert.equal(register({ name: 'ok-name', url: 'http://chains.example/' }).name, 'ok-name');
});
