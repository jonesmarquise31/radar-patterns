# The system these came out of

Context for the five patterns, without the parts that are proprietary.

## Shape

A serverless commerce and generation platform. Static frontend on a CDN, roughly
sixty functions behind it, a managed Postgres with row-level security, Stripe
for payments, and an LLM in the request path for the parts that cannot be
computed deterministically.

```
        browser
           │
           ▼
   ┌───────────────┐
   │  CDN / edge   │   static assets, routing, redirects
   └───────┬───────┘
           │  /api/*
           ▼
   ┌───────────────────────────────────────────┐
   │  serverless functions (Node 20)           │
   │                                           │
   │  payments ── webhook ── verify ── route   │  patterns 01, 02
   │  submissions ── validate ── score ── write│  pattern 03
   │  generation ── dispatch ─┐                │  pattern 04
   │  auth ── verify ── authorize              │  pattern 05
   └───────┬──────────────────┼────────────────┘
           │                  │ (out of band, long timeout)
           ▼                  ▼
   ┌──────────────┐   ┌────────────────┐
   │  Postgres    │   │  model API     │
   │  + RLS       │   │                │
   └──────────────┘   └────────────────┘
           │
           ▼
   ┌──────────────┐
   │  ops alerts  │   refusals and failures page a human
   └──────────────┘
```

## Boundaries that carry weight

**The webhook boundary.** Everything arriving from the payment provider is
hostile until the HMAC verifies. Pattern 01 is the only thing standing between
an open endpoint and arbitrary writes to the payments table. It runs before the
body is parsed, because parsing unverified JSON is already trusting it.

**The identity boundary.** Functions never accept a `user_id` from a request
body. The id is whatever the auth provider returns for the presented token.
Pattern 05 exists so that rule is enforced in one place rather than remembered
in sixty.

**The generation boundary.** Model output is untrusted input. It is parsed
defensively, shape-checked against required fields, and a failure marks the row
terminally rather than leaving it pending. A row that sits in `pending` forever
is a support ticket nobody knows about yet.

## Two decisions worth stating

**Deterministic where possible, generated only where necessary.** Scores are
computed in code and are reproducible. Only the prose interpretation is
generated. This means output is auditable, the expensive path is bounded, and a
model outage degrades the product instead of breaking it.

**Alerts go to a human, not to a dashboard.** Refusals from pattern 02 and
terminal failures from pattern 04 push to an operator channel directly. On a
small system, a dashboard nobody opens is equivalent to no monitoring. The bar
is: if the system refuses to write a customer's payment, someone finds out in
seconds.

## Operational notes

- **Rate limiting is per-instance.** Serverless runtimes hold many concurrent
  instances, so the in-memory limiter in pattern 05 is a burst guard, not a
  quota. A real quota needs shared storage. Stated plainly in the code because
  the failure mode is silent.
- **Retries are the norm.** Every write path assumes at-least-once delivery.
  Pattern 03 covers the three cases: natural-key find-or-create, constraint-
  backed upsert, and a processed-events ledger for side effects that cannot be
  made naturally idempotent.
- **Background functions are re-fireable by id.** Every failed generation can be
  replayed by posting the row id back to the endpoint. This is why dispatch
  failure is non-fatal in the foreground handler.

## Testing approach

Each module takes its I/O through an injected `deps` object. No network, no
database, no mock framework — the tests are the specification of the failure
modes, and they run in under a second.

The tests are written against behavior that matters rather than line coverage:
a forged signature is rejected, an ambiguous payment writes nothing, a replayed
webhook does not duplicate a row, a failed generation does not leave the row
pending, a valid token does not confer admin.
