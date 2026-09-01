'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  resolveProduct,
  routeCheckoutCompleted,
  ROUTE_OK,
  ROUTE_AMBIGUOUS,
  ROUTE_UNKNOWN,
} = require('./route-payment.js');

function spyDeps() {
  const writes = [];
  const alerts = [];
  return {
    writes,
    alerts,
    writePayment: async (row) => { writes.push(row); },
    alert: async (msg) => { alerts.push(msg); },
  };
}

test('metadata wins over the price book', () => {
  const r = resolveProduct({
    id: 'cs_1',
    amount_total: 9700,
    metadata: { product: 'diagnostic_tier' },
  });

  assert.equal(r.status, ROUTE_OK);
  assert.equal(r.product, 'diagnostic_tier');
  assert.equal(r.source, 'metadata');
});

test('metadata resolves an amount that would otherwise be ambiguous', () => {
  const ambiguous = resolveProduct({ id: 'cs_2', amount_total: 9700, metadata: {} });
  assert.equal(ambiguous.status, ROUTE_AMBIGUOUS);

  const resolved = resolveProduct({
    id: 'cs_2',
    amount_total: 9700,
    metadata: { product: 'report_tier' },
  });
  assert.equal(resolved.status, ROUTE_OK);
  assert.equal(resolved.product, 'report_tier');
});

test('an unshared amount resolves from the price book', () => {
  const r = resolveProduct({ id: 'cs_3', amount_total: 4700, metadata: {} });

  assert.equal(r.status, ROUTE_OK);
  assert.equal(r.product, 'entry_tier');
  assert.equal(r.source, 'amount');
});

test('a shared amount without metadata is ambiguous and names its candidates', () => {
  const r = resolveProduct({ id: 'cs_4', amount_total: 9700, metadata: {} });

  assert.equal(r.status, ROUTE_AMBIGUOUS);
  assert.deepEqual(r.candidates, ['diagnostic_tier', 'monthly_tier', 'report_tier']);
});

test('an unrecognized amount is refused, not guessed', () => {
  const r = resolveProduct({ id: 'cs_5', amount_total: 12345, metadata: {} });

  assert.equal(r.status, ROUTE_UNKNOWN);
  assert.equal(r.product, undefined);
});

test('ambiguous payments write nothing and alert', async () => {
  const deps = spyDeps();
  const result = await routeCheckoutCompleted(
    { id: 'cs_6', amount_total: 9700, currency: 'usd', metadata: {} },
    deps
  );

  assert.equal(result.written, false);
  assert.equal(result.statusCode, 400);
  assert.equal(result.reason, ROUTE_AMBIGUOUS);
  assert.equal(deps.writes.length, 0, 'must not write on ambiguity');
  assert.equal(deps.alerts.length, 1);
  assert.match(deps.alerts[0], /ambiguous/i);
  assert.match(deps.alerts[0], /No row written/);
});

test('unknown amounts write nothing and alert', async () => {
  const deps = spyDeps();
  const result = await routeCheckoutCompleted(
    { id: 'cs_7', amount_total: 55, currency: 'usd', metadata: {} },
    deps
  );

  assert.equal(result.written, false);
  assert.equal(result.reason, ROUTE_UNKNOWN);
  assert.equal(deps.writes.length, 0);
  assert.equal(deps.alerts.length, 1);
});

test('a resolved payment writes exactly one row and does not alert', async () => {
  const deps = spyDeps();
  const result = await routeCheckoutCompleted(
    { id: 'cs_8', amount_total: 19700, currency: 'usd', metadata: {} },
    deps
  );

  assert.equal(result.written, true);
  assert.equal(result.statusCode, 200);
  assert.equal(result.product, 'strategy_tier');
  assert.equal(deps.writes.length, 1);
  assert.equal(deps.alerts.length, 0);
  assert.deepEqual(deps.writes[0], {
    session_id: 'cs_8',
    product: 'strategy_tier',
    amount_total: 19700,
    currency: 'usd',
    resolved_by: 'amount',
  });
});

test('a custom price book overrides the default', async () => {
  const deps = spyDeps();
  const result = await routeCheckoutCompleted(
    { id: 'cs_9', amount_total: 500, currency: 'usd', metadata: {} },
    deps,
    { 500: ['trial_tier'] }
  );

  assert.equal(result.written, true);
  assert.equal(result.product, 'trial_tier');
});

test('refusal returns 400 rather than 500 so the sender stops retrying', async () => {
  const deps = spyDeps();
  const r = await routeCheckoutCompleted(
    { id: 'cs_10', amount_total: 9700, metadata: {} },
    deps
  );

  assert.equal(r.statusCode, 400);
  assert.notEqual(r.statusCode, 500);
});
