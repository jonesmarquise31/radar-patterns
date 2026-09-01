# 05 · Request auth

The client sends a token, never an identity.

**The rule.** Any handler that reads `user_id` from a request body trusts the
caller to say who they are, which means any caller can be anyone. The id comes
back from the auth provider's verification response and from nowhere else.
There is a test asserting exactly this.

**Authentication and authorization stay separate.** A valid token proves who you
are; a role lookup proves what you may do. Collapsing them is how an endpoint
ends up admin-gated by the mere presence of a token. The admin check also
short-circuits before the role lookup, so an unauthenticated caller never
triggers a database read.

**Fail closed.** If the provider is unreachable, verification returns an error
rather than an identity.

**Stable error codes.** Every failure carries a code (`AUTH-01` … `RATE-01`), so
support tickets arrive as "it says AUTH-02" instead of "it says error".

**The rate limiter evicts.** The obvious implementation keys a map by IP and
trims timestamps inside each entry, but never removes the entry — so the map
grows with every unique caller for the life of the instance. On a long-lived
container that is an unbounded memory leak. This one sweeps empty keys and caps
total key count, and there are tests for both.

It is also per-instance, and therefore a burst guard rather than a quota.
Anything needing a real quota belongs in shared storage.

Run: `node --test auth.test.js`
