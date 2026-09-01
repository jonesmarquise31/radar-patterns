'use strict';

// ─────────────────────────────────────────────────────────────────────────────
// Verify before write: refuse to guess which product was bought.
// ─────────────────────────────────────────────────────────────────────────────
// A payment event has to be mapped to a product before anything is written.
// The obvious mapping is by amount, and it works right up until two products
// share a price point. Then the amount is ambiguous, and a router that guesses
// writes the payment into the wrong table — silently, on a real customer, in a
// path nobody watches because it returned 200.
//
// The rule this encodes: metadata is authoritative, amount is a fallback, and
// an ambiguous amount is a hard failure. Alert loudly, write nothing, and
// return a status that makes the sender retry once the metadata is fixed.
//
// Losing a webhook is recoverable. A payment written to the wrong product is
// discovered weeks later by a customer who did not get what they paid for.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * A price book maps an amount (in minor units) to the products that share it.
 * Any amount mapping to more than one product is ambiguous by construction.
 */
const DEFAULT_PRICE_BOOK = {
  2900: ['subscription_tier'],
  4700: ['entry_tier'],
  9700: ['diagnostic_tier', 'monthly_tier', 'report_tier'],
  19700: ['strategy_tier'],
};

const ROUTE_OK = 'ok';
const ROUTE_AMBIGUOUS = 'ambiguous_amount';
const ROUTE_UNKNOWN = 'unknown_amount';

/**
 * Decide which product a completed checkout refers to.
 *
 * Resolution order:
 *   1. `metadata.product` — set at checkout creation. Authoritative.
 *   2. A price-book lookup, but only when the amount maps to exactly one product.
 *   3. Refuse.
 *
 * @returns {{status: string, product?: string, source?: string, amount?: number, candidates?: string[]}}
 */
function resolveProduct(session, priceBook) {
  const book = priceBook || DEFAULT_PRICE_BOOK;
  const metadata = (session && session.metadata) || {};

  if (metadata.product) {
    return { status: ROUTE_OK, product: metadata.product, source: 'metadata' };
  }

  const amount = session && session.amount_total;
  const candidates = book[amount];

  if (!candidates || candidates.length === 0) {
    return { status: ROUTE_UNKNOWN, amount: amount };
  }

  if (candidates.length > 1) {
    // The failure this whole module exists to prevent.
    return { status: ROUTE_AMBIGUOUS, amount: amount, candidates: candidates.slice() };
  }

  return { status: ROUTE_OK, product: candidates[0], source: 'amount' };
}

/**
 * Route a verified webhook event to a write, or refuse.
 *
 * `deps` is injected so this is testable without a network: { writePayment, alert }.
 */
async function routeCheckoutCompleted(session, deps, priceBook) {
  const resolution = resolveProduct(session, priceBook);

  if (resolution.status === ROUTE_AMBIGUOUS) {
    await deps.alert(
      'Refused to route payment: amount ' + resolution.amount +
      ' is ambiguous between ' + resolution.candidates.join(', ') +
      '. Session ' + session.id + '. No row written.'
    );
    // 400, not 500: the payload is the problem, and the sender should not
    // treat this as a transient error to retry forever.
    return { statusCode: 400, written: false, reason: ROUTE_AMBIGUOUS };
  }

  if (resolution.status === ROUTE_UNKNOWN) {
    await deps.alert(
      'Refused to route payment: unrecognized amount ' + resolution.amount +
      '. Session ' + session.id + '. No row written.'
    );
    return { statusCode: 400, written: false, reason: ROUTE_UNKNOWN };
  }

  await deps.writePayment({
    session_id: session.id,
    product: resolution.product,
    amount_total: session.amount_total,
    currency: session.currency || 'usd',
    resolved_by: resolution.source,
  });

  return { statusCode: 200, written: true, product: resolution.product, reason: ROUTE_OK };
}

module.exports = {
  resolveProduct,
  routeCheckoutCompleted,
  DEFAULT_PRICE_BOOK,
  ROUTE_OK,
  ROUTE_AMBIGUOUS,
  ROUTE_UNKNOWN,
};
