'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { submitAndDispatch, runGeneration, parseModelJson, validateShape } = require('./background-generation.js');

function harness(overrides) {
  const rows = new Map();
  const patches = [];
  const alerts = [];
  const dispatched = [];
  let seq = 0;

  const base = {
    rows, patches, alerts, dispatched,
    validate: (i) => (i && i.answers ? { ok: true, value: i } : { ok: false, error: 'answers required' }),
    computeDeterministic: () => ({ score: 4 }),
    insertRow: async (row) => {
      const created = Object.assign({ id: 'r' + (++seq) }, row);
      rows.set(created.id, created);
      return created;
    },
    dispatchBackground: async (p) => { dispatched.push(p); },
    log: () => {},
    loadRow: async (id) => rows.get(id) || null,
    loadContext: async () => ({ cohort: 'stub' }),
    callModel: async () => JSON.stringify({ narrative: 'generated text' }),
    patchRow: async (id, fields) => {
      patches.push({ id, fields });
      const row = rows.get(id);
      if (row) Object.assign(row, fields);
    },
    alert: async (m) => { alerts.push(m); },
  };
  return Object.assign(base, overrides || {});
}

test('submit returns the deterministic result immediately', async () => {
  const h = harness();
  const res = await submitAndDispatch({ answers: {} }, h);

  assert.equal(res.statusCode, 200);
  assert.equal(res.body.score, 4);
  assert.equal(res.body.generation, 'pending');
  assert.equal(h.dispatched.length, 1);
});

test('invalid input is rejected before any row is written', async () => {
  const h = harness();
  const res = await submitAndDispatch({}, h);

  assert.equal(res.statusCode, 400);
  assert.equal(h.rows.size, 0);
  assert.equal(h.dispatched.length, 0);
});

test('a dispatch failure still returns the deterministic result', async () => {
  const h = harness({ dispatchBackground: async () => { throw new Error('queue unreachable'); } });
  const res = await submitAndDispatch({ answers: {} }, h);

  assert.equal(res.statusCode, 200, 'user must still get their scores');
  assert.equal(res.body.score, 4);
  assert.equal(res.body.generation, 'dispatch_failed');
  assert.equal(h.rows.size, 1, 'row is persisted and can be re-fired');
});

test('generation patches the row and marks it generated', async () => {
  const h = harness();
  const submitted = await submitAndDispatch({ answers: {} }, h);
  const result = await runGeneration(submitted.body.id, h);

  assert.equal(result.ok, true);
  assert.equal(h.rows.get(submitted.body.id).narrative, 'generated text');
  assert.equal(h.rows.get(submitted.body.id).status, 'generated');
});

test('re-firing an already generated row is a no-op', async () => {
  const h = harness();
  const submitted = await submitAndDispatch({ answers: {} }, h);
  await runGeneration(submitted.body.id, h);
  const before = h.patches.length;

  const again = await runGeneration(submitted.body.id, h);
  assert.equal(again.skipped, true);
  assert.equal(h.patches.length, before, 'must not re-patch');
});

test('a missing row fails without throwing', async () => {
  const h = harness();
  const r = await runGeneration('nope', h);
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'row_not_found');
});

test('a model error marks the row failed and alerts', async () => {
  const h = harness({ callModel: async () => { throw new Error('upstream 529'); } });
  const submitted = await submitAndDispatch({ answers: {} }, h);
  const r = await runGeneration(submitted.body.id, h);

  assert.equal(r.ok, false);
  assert.equal(r.reason, 'model_error');
  assert.equal(h.rows.get(submitted.body.id).status, 'generation_failed');
  assert.equal(h.alerts.length, 1);
});

test('a row never stays pending after a failure', async () => {
  const h = harness({ callModel: async () => 'not json' });
  const submitted = await submitAndDispatch({ answers: {} }, h);
  await runGeneration(submitted.body.id, h);

  assert.notEqual(h.rows.get(submitted.body.id).status, 'pending_generation');
});

test('output missing a required field is rejected', async () => {
  const h = harness({ callModel: async () => JSON.stringify({ unrelated: 'x' }) });
  const submitted = await submitAndDispatch({ answers: {} }, h);
  const r = await runGeneration(submitted.body.id, h);

  assert.equal(r.ok, false);
  assert.equal(r.reason, 'missing_fields');
  assert.deepEqual(r.missing, ['narrative']);
});

test('parseModelJson unwraps a fenced block', () => {
  const r = parseModelJson('```json\n{"narrative":"x"}\n```');
  assert.equal(r.ok, true);
  assert.equal(r.value.narrative, 'x');
});

test('parseModelJson ignores prose around the object', () => {
  const r = parseModelJson('Sure, here you go:\n{"narrative":"x"}\nLet me know!');
  assert.equal(r.ok, true);
  assert.equal(r.value.narrative, 'x');
});

test('parseModelJson handles nested objects', () => {
  const r = parseModelJson('{"narrative":"x","dimensions":{"a":"1","b":"2"}}');
  assert.equal(r.ok, true);
  assert.equal(r.value.dimensions.b, '2');
});

test('parseModelJson classifies its failures', () => {
  assert.equal(parseModelJson('').reason, 'empty_response');
  assert.equal(parseModelJson('   ').reason, 'empty_response');
  assert.equal(parseModelJson('no object here').reason, 'no_json_object');
  assert.equal(parseModelJson('{"broken": ').reason, 'no_json_object');
  assert.equal(parseModelJson('{"a": 1,,}').reason, 'invalid_json');
});

test('validateShape reports every missing field at once', () => {
  const r = validateShape({ a: 'set', b: '' }, ['a', 'b', 'c']);
  assert.equal(r.ok, false);
  assert.deepEqual(r.missing, ['b', 'c']);
});
