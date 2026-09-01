'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { verifyAuth, verifyAdmin, createRateLimiter, extractBearer, callerKey, CODES } = require('./auth.js');

const VALID = { id: 'user_1', email: 'operator@example.com' };

function deps(overrides) {
  return Object.assign({
    fetchUser: async (token) => (token === 'good-token' ? VALID : null),
    fetchRole: async (id) => (id === 'user_1' ? 'member' : null),
  }, overrides || {});
}

const req = (headers) => ({ headers: headers || {} });

test('extractBearer handles casing and whitespace', () => {
  assert.equal(extractBearer({ authorization: 'Bearer abc' }), 'abc');
  assert.equal(extractBearer({ Authorization: 'bearer  abc  ' }), 'abc');
  assert.equal(extractBearer({ authorization: 'Basic abc' }), null);
  assert.equal(extractBearer({}), null);
});

test('a valid token resolves to the provider identity', async () => {
  const r = await verifyAuth(req({ authorization: 'Bearer good-token' }), deps());

  assert.equal(r.user_id, 'user_1');
  assert.equal(r.email, 'operator@example.com');
  assert.equal(r.error, undefined);
});

test('a missing token is rejected', async () => {
  const r = await verifyAuth(req(), deps());
  assert.equal(r.code, CODES.NO_TOKEN);
});

test('an invalid token is rejected', async () => {
  const r = await verifyAuth(req({ authorization: 'Bearer bad-token' }), deps());
  assert.equal(r.code, CODES.INVALID_TOKEN);
});

test('a user_id in the request body is never trusted', async () => {
  const event = {
    headers: { authorization: 'Bearer good-token' },
    body: JSON.stringify({ user_id: 'admin_impersonated' }),
  };
  const r = await verifyAuth(event, deps());

  assert.equal(r.user_id, 'user_1', 'identity must come from the provider, not the body');
  assert.notEqual(r.user_id, 'admin_impersonated');
});

test('a provider outage fails closed', async () => {
  const r = await verifyAuth(
    req({ authorization: 'Bearer good-token' }),
    deps({ fetchUser: async () => { throw new Error('network down'); } })
  );

  assert.equal(r.code, CODES.VERIFY_FAILED);
  assert.equal(r.user_id, undefined, 'must not grant identity when verification fails');
});

test('a provider response without an id is rejected', async () => {
  const r = await verifyAuth(
    req({ authorization: 'Bearer good-token' }),
    deps({ fetchUser: async () => ({ email: 'x@example.com' }) })
  );
  assert.equal(r.code, CODES.NO_IDENTITY);
});

test('a valid token alone does not confer admin', async () => {
  const r = await verifyAdmin(req({ authorization: 'Bearer good-token' }), deps());

  assert.equal(r.code, CODES.NOT_ADMIN);
  assert.equal(r.is_admin, undefined);
});

test('an admin role passes', async () => {
  const r = await verifyAdmin(
    req({ authorization: 'Bearer good-token' }),
    deps({ fetchRole: async () => 'admin' })
  );

  assert.equal(r.is_admin, true);
  assert.equal(r.user_id, 'user_1');
});

test('admin check short-circuits on a bad token', async () => {
  let roleLookups = 0;
  const r = await verifyAdmin(
    req({ authorization: 'Bearer bad-token' }),
    deps({ fetchRole: async () => { roleLookups++; return 'admin'; } })
  );

  assert.equal(r.code, CODES.INVALID_TOKEN);
  assert.equal(roleLookups, 0, 'must not look up a role for an unauthenticated caller');
});

test('rate limiter allows up to the cap then blocks', () => {
  const rl = createRateLimiter({ maxPerWindow: 3, windowMs: 60000 });
  const t = 1_000_000;

  assert.equal(rl.check('1.1.1.1', t), null);
  assert.equal(rl.check('1.1.1.1', t), null);
  assert.equal(rl.check('1.1.1.1', t), null);
  assert.equal(rl.check('1.1.1.1', t).code, CODES.RATE_LIMITED);
});

test('rate limiter isolates callers', () => {
  const rl = createRateLimiter({ maxPerWindow: 1, windowMs: 60000 });
  const t = 1_000_000;

  assert.equal(rl.check('1.1.1.1', t), null);
  assert.equal(rl.check('2.2.2.2', t), null, 'one caller must not exhaust another');
  assert.equal(rl.check('1.1.1.1', t).code, CODES.RATE_LIMITED);
});

test('the window rolls forward', () => {
  const rl = createRateLimiter({ maxPerWindow: 1, windowMs: 1000 });

  assert.equal(rl.check('1.1.1.1', 0), null);
  assert.equal(rl.check('1.1.1.1', 500).code, CODES.RATE_LIMITED);
  assert.equal(rl.check('1.1.1.1', 1500), null, 'blocked caller recovers after the window');
});

test('idle keys are evicted rather than accumulating', () => {
  const rl = createRateLimiter({ maxPerWindow: 5, windowMs: 1000 });

  for (let i = 0; i < 500; i++) rl.check('ip-' + i, 0);
  assert.equal(rl.size(), 500);

  rl.check('ip-fresh', 5000);
  assert.equal(rl.size(), 1, 'expired keys must be dropped, not just trimmed');
});

test('key count is capped so unique-key spray cannot exhaust memory', () => {
  const rl = createRateLimiter({ maxPerWindow: 5, windowMs: 60000, maxKeys: 50 });

  for (let i = 0; i < 50; i++) assert.equal(rl.check('ip-' + i, 1000), null);

  const overflow = rl.check('ip-overflow', 1000);
  assert.equal(overflow.code, CODES.RATE_LIMITED);
  assert.ok(rl.size() <= 50);
});

test('callerKey takes only the first hop of x-forwarded-for', () => {
  assert.equal(callerKey({ headers: { 'x-forwarded-for': '9.9.9.9, 10.0.0.1, 10.0.0.2' } }), '9.9.9.9');
  assert.equal(callerKey({ headers: { 'client-ip': '8.8.8.8' } }), '8.8.8.8');
  assert.equal(callerKey({ headers: {} }), 'unknown');
});
