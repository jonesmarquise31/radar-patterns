# 03 · Idempotent writes

Survive at-least-once delivery.

Payment providers retry webhooks. So do queues, cron runners, and load balancers
that time out at the wrong moment. Every handler will eventually run twice on the
same event, and the second run must be a no-op.

**`findOrCreate`** — read by natural key, insert when absent. Simple, and racy
under concurrency: two simultaneous runs can both read "absent" and both insert.
Safe only where a unique constraint catches the loser.

**`upsert`** — one round trip, database resolves the conflict via
`ON CONFLICT DO UPDATE`. No race window. Preferred wherever a unique constraint
exists.

**`processOnce`** — a processed-events ledger, for side effects that cannot be
made naturally idempotent. Sending an email twice is the failure being
prevented, and no amount of upserting fixes that.

Two details that matter:

- The ledger row is claimed **before** the side effect runs. Claiming after
  means a crash in between replays the side effect on retry.
- A failed handler **releases** its claim. Without that, a transient failure
  permanently poisons the event: the ledger says done and the side effect never
  ran.

**Where correctness actually lives.** In the database constraint, not in this
file. Check-then-write with nothing behind it is a race, not idempotency.

Run: `node --test idempotent-writes.test.js`
