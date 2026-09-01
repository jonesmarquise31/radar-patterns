# 02 · Verify before write

Refuse to guess which product a payment refers to.

**The bug this prevents.** Routing a payment by amount works until two products
share a price point. Then the amount is ambiguous, and a router that guesses
writes a real customer's payment into the wrong table — silently, returning 200,
in a path nobody watches.

**The rule.** Checkout metadata is authoritative. A price-book lookup is a
fallback, and only when the amount maps to exactly one product. An ambiguous or
unrecognized amount is a hard refusal: alert, write nothing, return 400.

**Why 400 and not 500.** A 500 tells the sender this is transient and to keep
retrying. It is not transient — the payload is missing metadata, and it will be
missing on every retry. 400 stops the retry storm and leaves the event
replayable once the checkout path is fixed.

**The asymmetry that justifies it.** A refused webhook is recoverable in
minutes from the provider dashboard. A payment written to the wrong product is
found weeks later by a customer who did not get what they paid for.

Run: `node --test route-payment.test.js`
