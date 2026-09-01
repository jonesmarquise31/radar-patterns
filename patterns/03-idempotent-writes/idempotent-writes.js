'use strict';

// ─────────────────────────────────────────────────────────────────────────────
// Idempotent writes for at-least-once delivery.
// ─────────────────────────────────────────────────────────────────────────────
// Payment providers retry webhooks. So do queues, cron runners, and anything
// behind a load balancer that times out at the wrong moment. The delivery
// guarantee is at-least-once, which means every handler will eventually run
// twice on the same event, and the second run must be a no-op.
//
// Two techniques cover almost everything:
//
//   findOrCreate  — read by natural key, insert only when absent. Simple, and
//                   racy under concurrency: two simultaneous runs can both read
//                   "absent" and both insert. Acceptable only where the table
//                   has a unique constraint to catch the loser.
//
//   upsert        — let the database decide, via ON CONFLICT / merge-duplicates.
//                   One round trip, no race. Preferred wherever a unique
//                   constraint exists.
//
// The correctness lives in the database constraint, not in this file. Code that
// checks-then-writes without a constraint behind it is a race, not idempotency.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Find a row by natural key, or create it.
 *
 * `db` is injected: { select(table, match), insert(table, row) }.
 * Returns { id, created } so callers can branch on first-versus-repeat.
 */
async function findOrCreate(db, table, match, defaults) {
  const existing = await db.select(table, match);

  if (existing && existing.length > 0) {
    return { id: existing[0].id, created: false, row: existing[0] };
  }

  const inserted = await db.insert(table, Object.assign({}, match, defaults || {}));
  return { id: inserted.id, created: true, row: inserted };
}

/**
 * Upsert on a unique key. The database resolves the conflict.
 *
 * Mirrors PostgREST's `Prefer: resolution=merge-duplicates`, which compiles to
 * INSERT ... ON CONFLICT DO UPDATE.
 */
async function upsert(db, table, row, conflictKey) {
  return db.upsert(table, row, conflictKey);
}

/**
 * Process an event exactly once, keyed by the provider's event id.
 *
 * A processed-events ledger is the general answer when the write itself cannot
 * be made naturally idempotent — for example when handling an event sends an
 * email, and sending twice is the failure you are preventing.
 *
 * The ledger row is claimed BEFORE the side effect runs. Claiming after means a
 * crash between side effect and claim replays the side effect on retry.
 */
async function processOnce(db, eventId, handler, opts) {
  const table = (opts && opts.table) || 'processed_events';

  const claimed = await db.insertIfAbsent(table, { event_id: eventId, claimed_at: new Date().toISOString() });

  if (!claimed) {
    return { skipped: true, reason: 'already_processed', eventId: eventId };
  }

  try {
    const result = await handler();
    return { skipped: false, result: result };
  } catch (err) {
    // Release the claim so a retry can pick it up. Without this a transient
    // failure permanently poisons the event: the ledger says "done" and the
    // side effect never ran.
    await db.remove(table, { event_id: eventId });
    throw err;
  }
}

module.exports = { findOrCreate, upsert, processOnce };
