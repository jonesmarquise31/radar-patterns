'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { findOrCreate, upsert, processOnce } = require('./idempotent-writes.js');

/** Minimal in-memory stand-in with a unique-key guard, like a real constraint. */
function fakeDb() {
  const tables = {};
  let seq = 0;

  function rows(t) { if (!tables[t]) tables[t] = []; return tables[t]; }
  function matches(row, match) { return Object.keys(match).every((k) => row[k] === match[k]); }

  return {
    tables,
    calls: { select: 0, insert: 0, upsert: 0 },
    async select(table, match) {
      this.calls.select++;
      return rows(table).filter((r) => matches(r, match));
    },
    async insert(table, row) {
      this.calls.insert++;
      const created = Object.assign({ id: 'row_' + (++seq) }, row);
      rows(table).push(created);
      return created;
    },
    async upsert(table, row, conflictKey) {
      this.calls.upsert++;
      const found = rows(table).find((r) => r[conflictKey] === row[conflictKey]);
      if (found) { Object.assign(found, row); return found; }
      const created = Object.assign({ id: 'row_' + (++seq) }, row);
      rows(table).push(created);
      return created;
    },
    async insertIfAbsent(table, row) {
      const found = rows(table).find((r) => r.event_id === row.event_id);
      if (found) return false;
      rows(table).push(Object.assign({ id: 'row_' + (++seq) }, row));
      return true;
    },
    async remove(table, match) {
      tables[table] = rows(table).filter((r) => !matches(r, match));
    },
  };
}

test('findOrCreate inserts on first call', async () => {
  const db = fakeDb();
  const r = await findOrCreate(db, 'contacts', { email: 'a@example.com' }, { name: 'A' });

  assert.equal(r.created, true);
  assert.equal(db.tables.contacts.length, 1);
});

test('findOrCreate is a no-op on replay', async () => {
  const db = fakeDb();
  const first = await findOrCreate(db, 'contacts', { email: 'a@example.com' }, { name: 'A' });
  const second = await findOrCreate(db, 'contacts', { email: 'a@example.com' }, { name: 'A' });

  assert.equal(second.created, false);
  assert.equal(second.id, first.id, 'replay must resolve to the same row');
  assert.equal(db.tables.contacts.length, 1, 'replay must not duplicate');
  assert.equal(db.calls.insert, 1);
});

test('findOrCreate does not overwrite an existing row', async () => {
  const db = fakeDb();
  await findOrCreate(db, 'contacts', { email: 'a@example.com' }, { name: 'Original' });
  await findOrCreate(db, 'contacts', { email: 'a@example.com' }, { name: 'Replacement' });

  assert.equal(db.tables.contacts[0].name, 'Original');
});

test('upsert creates then merges on the conflict key', async () => {
  const db = fakeDb();
  await upsert(db, 'roles', { user_id: 'u1', role: 'trial' }, 'user_id');
  await upsert(db, 'roles', { user_id: 'u1', role: 'enrolled' }, 'user_id');

  assert.equal(db.tables.roles.length, 1);
  assert.equal(db.tables.roles[0].role, 'enrolled', 'second write updates in place');
});

test('upsert reaches the database once per call', async () => {
  const db = fakeDb();
  await upsert(db, 'roles', { user_id: 'u2', role: 'trial' }, 'user_id');

  assert.equal(db.calls.upsert, 1);
  assert.equal(db.calls.select, 0, 'no read-then-write race window');
});

test('processOnce runs the side effect exactly once across replays', async () => {
  const db = fakeDb();
  let sends = 0;
  const send = async () => { sends++; return 'sent'; };

  const first = await processOnce(db, 'evt_1', send);
  const second = await processOnce(db, 'evt_1', send);
  const third = await processOnce(db, 'evt_1', send);

  assert.equal(sends, 1, 'side effect must not repeat');
  assert.equal(first.skipped, false);
  assert.equal(second.skipped, true);
  assert.equal(second.reason, 'already_processed');
  assert.equal(third.skipped, true);
});

test('processOnce treats distinct events independently', async () => {
  const db = fakeDb();
  let sends = 0;
  const send = async () => { sends++; };

  await processOnce(db, 'evt_a', send);
  await processOnce(db, 'evt_b', send);

  assert.equal(sends, 2);
});

test('a failed handler releases its claim so a retry can succeed', async () => {
  const db = fakeDb();
  let attempts = 0;
  const flaky = async () => {
    attempts++;
    if (attempts === 1) throw new Error('transient upstream failure');
    return 'ok';
  };

  await assert.rejects(() => processOnce(db, 'evt_flaky', flaky), /transient/);

  const retry = await processOnce(db, 'evt_flaky', flaky);
  assert.equal(retry.skipped, false, 'retry must not be blocked by the failed claim');
  assert.equal(retry.result, 'ok');
  assert.equal(attempts, 2);
});
