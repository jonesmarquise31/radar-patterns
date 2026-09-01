# 01 · Webhook signature verification

Verify an HMAC-signed webhook without the provider SDK.

**Why not the SDK.** On serverless the SDK's verification needs the exact raw
body, and the platform may hand it over base64-encoded. Rather than fight the
encoding through an abstraction, verify the HMAC directly and decode explicitly.

**Three gates, in order.** The header must parse into a timestamp and a digest;
the timestamp must be inside the replay window; the computed HMAC must match.
Any failure returns 400 and writes nothing.

**Constant-time comparison.** A plain `!==` on digests returns earlier the
sooner it finds a mismatched byte. That timing difference is measurable across
enough requests and leaks the expected digest byte by byte. `crypto.timingSafeEqual`
always reads both buffers fully; the length check comes first because it throws
on a length mismatch, and a length mismatch reveals nothing anyway.

**Replay tolerance.** Without a timestamp window a captured request stays valid
forever. 300 seconds is the provider default and is wide enough for clock skew.

Run: `node --test verify-signature.test.js`
