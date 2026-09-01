'use strict';

// ─────────────────────────────────────────────────────────────────────────────
// Server-side request authentication for serverless handlers.
// ─────────────────────────────────────────────────────────────────────────────
// The rule: the client sends a token, never an identity. Any handler that reads
// `user_id` from the request body is trusting the caller to say who they are,
// which means any caller can be anyone. The user id must come back from the
// auth provider's verification response and nothing else.
//
// Every failure returns a stable machine-readable code. Support tickets arrive
// as "it says AUTH-02", which is answerable, instead of "it says error".
// ─────────────────────────────────────────────────────────────────────────────

const CODES = {
  NO_TOKEN: 'AUTH-01',
  INVALID_TOKEN: 'AUTH-02',
  NO_IDENTITY: 'AUTH-03',
  VERIFY_FAILED: 'AUTH-04',
  NOT_ADMIN: 'AUTH-05',
  RATE_LIMITED: 'RATE-01',
};

function extractBearer(headers) {
  const raw = (headers && (headers.authorization || headers.Authorization)) || '';
  const match = /^Bearer\s+(.+)$/i.exec(String(raw).trim());
  return match ? match[1].trim() : null;
}

/**
 * Verify a request's bearer token against the auth provider.
 *
 * `deps.fetchUser(token)` must return the provider's user object or null.
 */
async function verifyAuth(event, deps) {
  const token = extractBearer(event && event.headers);
  if (!token) return { error: 'No authorization token provided', code: CODES.NO_TOKEN };

  let user;
  try {
    user = await deps.fetchUser(token);
  } catch (err) {
    return { error: 'Auth verification failed', code: CODES.VERIFY_FAILED };
  }

  if (!user) return { error: 'Invalid or expired token', code: CODES.INVALID_TOKEN };
  if (!user.id) return { error: 'Could not verify user identity', code: CODES.NO_IDENTITY };

  // The id comes from the provider, never from the request body.
  return { user_id: user.id, email: user.email || null };
}

/**
 * Authorize an admin-only handler.
 *
 * Authentication and authorization stay separate calls: a valid token proves
 * who you are, and a role lookup proves what you may do. Collapsing them is how
 * an endpoint ends up admin-gated by the presence of a token alone.
 */
async function verifyAdmin(event, deps) {
  const auth = await verifyAuth(event, deps);
  if (auth.error) return auth;

  let role;
  try {
    role = await deps.fetchRole(auth.user_id);
  } catch (err) {
    return { error: 'Admin verification failed', code: CODES.VERIFY_FAILED };
  }

  if (role !== 'admin') return { error: 'Admin access required', code: CODES.NOT_ADMIN };

  return { user_id: auth.user_id, email: auth.email, is_admin: true };
}

/**
 * Fixed-window per-caller rate limiter.
 *
 * Two properties worth stating plainly:
 *
 *   1. It is per-instance. Serverless runtimes hold many concurrent instances,
 *      so the effective global limit is roughly maxPerWindow × instances. This
 *      is a burst guard, not a quota. Anything that needs a real quota belongs
 *      in shared storage.
 *
 *   2. It evicts. A naive implementation keys a map by IP and trims timestamps
 *      inside each entry, but never removes the entry itself — so the map grows
 *      with every unique caller for the life of the instance. On a long-lived
 *      container that is an unbounded memory leak. `sweep` drops empty keys.
 */
function createRateLimiter(opts) {
  const maxPerWindow = (opts && opts.maxPerWindow) || 10;
  const windowMs = (opts && opts.windowMs) || 60000;
  const maxKeys = (opts && opts.maxKeys) || 10000;
  const store = new Map();

  function sweep(now) {
    for (const [key, hits] of store) {
      const live = hits.filter((t) => now - t < windowMs);
      if (live.length === 0) store.delete(key);
      else store.set(key, live);
    }
  }

  function check(callerKey, nowMs) {
    const now = nowMs == null ? Date.now() : nowMs;
    const key = callerKey || 'unknown';

    sweep(now);

    // Hard ceiling so a spray of unique keys cannot exhaust memory.
    if (!store.has(key) && store.size >= maxKeys) {
      return { error: 'Too many requests. Please wait a moment.', code: CODES.RATE_LIMITED };
    }

    const hits = store.get(key) || [];
    if (hits.length >= maxPerWindow) {
      return { error: 'Too many requests. Please wait a moment.', code: CODES.RATE_LIMITED };
    }

    hits.push(now);
    store.set(key, hits);
    return null;
  }

  return { check, size: () => store.size, _store: store };
}

function callerKey(event) {
  const h = (event && event.headers) || {};
  const fwd = h['x-forwarded-for'] || h['X-Forwarded-For'] || '';
  // x-forwarded-for is a client-controlled list; only the first hop is meaningful.
  if (fwd) return String(fwd).split(',')[0].trim();
  return h['client-ip'] || 'unknown';
}

module.exports = { verifyAuth, verifyAdmin, createRateLimiter, extractBearer, callerKey, CODES };
