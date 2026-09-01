# Radar Patterns

Five production patterns for serverless systems that take payments and run
model generation, extracted from [Workforce Radar](https://workforceradar.com) —
a live platform with real customers, real Stripe volume, and Claude in the
request path.

Every pattern here runs in production. The code has been generalized (no schema,
no business logic, no prompts) but the design decisions and the failure modes
they guard against are the real ones, including the ones that were learned the
expensive way.

```
npm test
```

60 tests, no dependencies, `node:test` only. Node 20+.

---

## The patterns

| | Pattern | Guards against |
|---|---|---|
| 01 | [Webhook signature verification](patterns/01-webhook-signature-verification) | Forged payment events, replay attacks, timing attacks |
| 02 | [Verify before write](patterns/02-verify-before-write) | Writing a payment to the wrong product |
| 03 | [Idempotent writes](patterns/03-idempotent-writes) | Duplicate rows and repeated side effects from retried deliveries |
| 04 | [Background generation](patterns/04-background-generation) | Gateway timeouts, lost work, rows stuck pending forever |
| 05 | [Request auth](patterns/05-request-auth) | Client-asserted identity, privilege escalation, unbounded rate-limit memory |

---

## The through-line

**Refuse rather than guess.** The most expensive class of bug in a payments
system is not the one that throws — it is the one that returns `200` and writes
the wrong row. A webhook that cannot determine which product was purchased
should alert and write nothing. Losing an event is recoverable in minutes.
A payment silently attached to the wrong product is discovered weeks later by a
customer who did not receive what they paid for.

**The database enforces correctness, not the handler.** Check-then-write is a
race unless a unique constraint sits behind it. Pattern 03 is explicit about
which technique is safe under concurrency and which is not.

**Fail closed on the auth path, fail open on the enrichment path.** If identity
verification cannot complete, the request is rejected. If model generation
cannot complete, the user still receives their deterministic result and the row
is re-fireable. Different failures deserve different defaults.

**Never wait on a model for something you can compute.** Deterministic output
returns synchronously. Generated prose arrives out of band. That split is the
whole of pattern 04, and it is what keeps a slow or unavailable model from
becoming a broken checkout.

---

## What is deliberately not here

This is an extraction, not a mirror of the product repository.

- No classification or scoring logic — that is the proprietary core
- No prompts, voice rules, or model instructions
- No schema, table names, or policy definitions
- No infrastructure identifiers or credentials of any kind

The architecture that surrounds these patterns is documented separately in
[Radar-Platform](https://github.com/jonesmarquise31/Radar-Platform), which holds
the build logs, decision records, and system diagrams.

---

## Structure

```
patterns/
  01-webhook-signature-verification/
    verify-signature.js
    verify-signature.test.js
  02-verify-before-write/
    route-payment.js
    route-payment.test.js
  03-idempotent-writes/
    idempotent-writes.js
    idempotent-writes.test.js
  04-background-generation/
    background-generation.js
    background-generation.test.js
  05-request-auth/
    auth.js
    auth.test.js
docs/
  architecture.md
```

Each module takes its I/O through an injected `deps` object, so every pattern is
tested against its real failure modes without a network, a database, or a mock
framework.

MIT licensed. Read [docs/architecture.md](docs/architecture.md) for the system
these came out of.
