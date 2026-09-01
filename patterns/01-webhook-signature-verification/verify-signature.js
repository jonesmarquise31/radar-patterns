'use strict';

// ─────────────────────────────────────────────────────────────────────────────
// Webhook signature verification, without the SDK.
// ─────────────────────────────────────────────────────────────────────────────
// Stripe's Node SDK will do this for you. This implementation exists because
// on a serverless platform the SDK's constructEvent needs the *raw* body, and
// the platform may hand you a base64-encoded string instead. Rather than fight
// the encoding through an abstraction, verify the HMAC directly.
//
// Three things have to be true before the payload is trusted:
//   1. The signature header parses into a timestamp and a v1 digest.
//   2. The timestamp is inside the replay tolerance window.
//   3. The computed HMAC matches the provided digest, compared in constant time.
//
// Failing any of them returns 400 and writes nothing.
// ─────────────────────────────────────────────────────────────────────────────

const crypto = require('crypto');

const DEFAULT_TOLERANCE_SECONDS = 300;

/**
 * Parse a `t=...,v1=...` signature header into its parts.
 */
function parseSignatureHeader(header) {
  const parts = {};
  String(header || '')
    .split(',')
    .forEach(function (segment) {
      const idx = segment.indexOf('=');
      if (idx === -1) return;
      const key = segment.slice(0, idx).trim();
      const value = segment.slice(idx + 1).trim();
      if (key) parts[key] = value;
    });
  return parts;
}

/**
 * Compare two hex digests without leaking timing information.
 *
 * A plain `===` on a digest comparison returns faster the earlier it finds a
 * mismatched byte. That difference is measurable across enough requests and
 * lets an attacker recover the expected digest one byte at a time. Node's
 * timingSafeEqual always reads both buffers fully.
 *
 * It throws when the buffers differ in length, so the length check comes first
 * — a length mismatch is already a definitive failure and reveals nothing.
 */
function safeCompare(a, b) {
  const bufA = Buffer.from(String(a), 'utf-8');
  const bufB = Buffer.from(String(b), 'utf-8');
  if (bufA.length !== bufB.length) return false;
  return crypto.timingSafeEqual(bufA, bufB);
}

/**
 * Verify a webhook payload.
 *
 * @param {object}  args
 * @param {string}  args.rawBody           Exact bytes as received. Never re-serialized JSON.
 * @param {string}  args.signatureHeader   Value of the signature header.
 * @param {string}  args.secret            Shared signing secret.
 * @param {number} [args.toleranceSeconds] Replay window. Defaults to 300.
 * @param {number} [args.nowSeconds]       Injectable clock, for tests.
 * @returns {{ ok: true, event: object } | { ok: false, reason: string }}
 */
function verifyWebhook(args) {
  const rawBody = args.rawBody;
  const secret = args.secret;
  const tolerance = args.toleranceSeconds == null ? DEFAULT_TOLERANCE_SECONDS : args.toleranceSeconds;
  const now = args.nowSeconds == null ? Math.floor(Date.now() / 1000) : args.nowSeconds;

  if (!secret) return { ok: false, reason: 'missing_secret' };
  if (typeof rawBody !== 'string') return { ok: false, reason: 'missing_body' };

  const parts = parseSignatureHeader(args.signatureHeader);
  const timestamp = parts['t'];
  const provided = parts['v1'];

  if (!timestamp || !provided) return { ok: false, reason: 'malformed_signature' };

  const ts = parseInt(timestamp, 10);
  if (!Number.isFinite(ts)) return { ok: false, reason: 'malformed_signature' };

  // Replay guard. A valid signature stays valid forever without this — an
  // attacker who captures one request can resend it indefinitely.
  if (Math.abs(now - ts) > tolerance) return { ok: false, reason: 'timestamp_out_of_tolerance' };

  const signedPayload = timestamp + '.' + rawBody;
  const computed = crypto.createHmac('sha256', secret).update(signedPayload, 'utf-8').digest('hex');

  if (!safeCompare(computed, provided)) return { ok: false, reason: 'signature_mismatch' };

  let event;
  try {
    event = JSON.parse(rawBody);
  } catch (err) {
    return { ok: false, reason: 'invalid_json' };
  }

  return { ok: true, event: event };
}

/**
 * Serverless handlers may receive the body base64-encoded. Decode before
 * verifying — hashing the encoded form produces a mismatch every time.
 */
function readRawBody(event) {
  if (!event || event.body == null) return null;
  return event.isBase64Encoded ? Buffer.from(event.body, 'base64').toString('utf-8') : event.body;
}

module.exports = { verifyWebhook, parseSignatureHeader, safeCompare, readRawBody };
