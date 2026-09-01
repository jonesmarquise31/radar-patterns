'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');

const { verifyWebhook, parseSignatureHeader, safeCompare, readRawBody } = require('./verify-signature.js');

const SECRET = 'whsec_test_secret';

function sign(body, opts) {
  opts = opts || {};
  const ts = opts.timestamp == null ? Math.floor(Date.now() / 1000) : opts.timestamp;
  const digest = crypto.createHmac('sha256', opts.secret || SECRET).update(ts + '.' + body, 'utf-8').digest('hex');
  return 't=' + ts + ',v1=' + digest;
}

test('accepts a correctly signed payload', () => {
  const body = JSON.stringify({ type: 'checkout.session.completed', id: 'evt_1' });
  const result = verifyWebhook({ rawBody: body, signatureHeader: sign(body), secret: SECRET });

  assert.equal(result.ok, true);
  assert.equal(result.event.id, 'evt_1');
});

test('rejects a payload signed with the wrong secret', () => {
  const body = JSON.stringify({ id: 'evt_2' });
  const header = sign(body, { secret: 'whsec_attacker' });
  const result = verifyWebhook({ rawBody: body, signatureHeader: header, secret: SECRET });

  assert.equal(result.ok, false);
  assert.equal(result.reason, 'signature_mismatch');
});

test('rejects a body mutated after signing', () => {
  const body = JSON.stringify({ amount_total: 9700 });
  const header = sign(body);
  const tampered = JSON.stringify({ amount_total: 1 });
  const result = verifyWebhook({ rawBody: tampered, signatureHeader: header, secret: SECRET });

  assert.equal(result.ok, false);
  assert.equal(result.reason, 'signature_mismatch');
});

test('rejects a replayed request outside the tolerance window', () => {
  const body = JSON.stringify({ id: 'evt_3' });
  const oldTs = 1_700_000_000;
  const header = sign(body, { timestamp: oldTs });
  const result = verifyWebhook({
    rawBody: body,
    signatureHeader: header,
    secret: SECRET,
    nowSeconds: oldTs + 3600,
  });

  assert.equal(result.ok, false);
  assert.equal(result.reason, 'timestamp_out_of_tolerance');
});

test('accepts a request inside the tolerance window', () => {
  const body = JSON.stringify({ id: 'evt_4' });
  const ts = 1_700_000_000;
  const header = sign(body, { timestamp: ts });
  const result = verifyWebhook({
    rawBody: body,
    signatureHeader: header,
    secret: SECRET,
    nowSeconds: ts + 120,
  });

  assert.equal(result.ok, true);
});

test('rejects a malformed signature header', () => {
  const body = JSON.stringify({ id: 'evt_5' });
  for (const header of ['', 'garbage', 't=123', 'v1=abc']) {
    const result = verifyWebhook({ rawBody: body, signatureHeader: header, secret: SECRET });
    assert.equal(result.ok, false, 'header: ' + JSON.stringify(header));
    assert.equal(result.reason, 'malformed_signature');
  }
});

test('rejects a valid signature over a non-JSON body', () => {
  const body = 'not json at all';
  const result = verifyWebhook({ rawBody: body, signatureHeader: sign(body), secret: SECRET });

  assert.equal(result.ok, false);
  assert.equal(result.reason, 'invalid_json');
});

test('refuses to verify when the secret is absent', () => {
  const body = JSON.stringify({ id: 'evt_6' });
  const result = verifyWebhook({ rawBody: body, signatureHeader: sign(body), secret: undefined });

  assert.equal(result.ok, false);
  assert.equal(result.reason, 'missing_secret');
});

test('parseSignatureHeader tolerates whitespace and extra schemes', () => {
  const parts = parseSignatureHeader(' t=123 , v1=abc , v0=legacy ');
  assert.equal(parts.t, '123');
  assert.equal(parts.v1, 'abc');
  assert.equal(parts.v0, 'legacy');
});

test('safeCompare returns false on length mismatch instead of throwing', () => {
  assert.equal(safeCompare('abc', 'abcd'), false);
  assert.equal(safeCompare('abc', 'abc'), true);
});

test('readRawBody decodes base64 bodies', () => {
  const body = JSON.stringify({ id: 'evt_7' });
  const encoded = Buffer.from(body, 'utf-8').toString('base64');

  assert.equal(readRawBody({ body: body, isBase64Encoded: false }), body);
  assert.equal(readRawBody({ body: encoded, isBase64Encoded: true }), body);
});

test('a base64 body verifies only after decoding', () => {
  const body = JSON.stringify({ id: 'evt_8' });
  const header = sign(body);
  const encoded = Buffer.from(body, 'utf-8').toString('base64');

  const rawAttempt = verifyWebhook({ rawBody: encoded, signatureHeader: header, secret: SECRET });
  assert.equal(rawAttempt.ok, false);

  const decoded = readRawBody({ body: encoded, isBase64Encoded: true });
  assert.equal(verifyWebhook({ rawBody: decoded, signatureHeader: header, secret: SECRET }).ok, true);
});
