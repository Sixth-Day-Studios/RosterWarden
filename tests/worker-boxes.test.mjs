/**
 * The sync worker's staff-link mailboxes, run against a stand-in database that
 * answers the worker's own mailbox SQL: write and read back, refuse a replaced
 * link for good, and read many at once.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import worker, { BOX_SQL, TIDY_SQL } from '../worker/src/index.js';

/** An in-memory D1 that understands exactly the mailbox statements. */
function fakeDB() {
  const rows = new Map();
  return {
    rows,
    // What D1's batch() gives: each statement's rows, in order.
    batch: async (statements) => Promise.all(statements.map(async (s) => ({ results: [await s.first()].filter(Boolean) }))),
    prepare(sql) {
      return {
        bind(...args) {
          return {
            async first() {
              assert.equal(sql, BOX_SQL.read);
              return rows.get(args[0]) || null;
            },
            async run() {
              const [id] = args;
              if (sql === BOX_SQL.write) {
                if (rows.get(id)?.revoked) return;
                rows.set(id, { ciphertext: args[1], iv: args[2], updated_at: args[3], revoked: 0 });
              } else if (sql === BOX_SQL.revoke) {
                rows.set(id, { ciphertext: '', iv: '', updated_at: args[1], revoked: 1 });
              } else {
                throw new Error(`unexpected SQL: ${sql}`);
              }
            },
          };
        },
      };
    },
  };
}

const ID = 'a'.repeat(64);
const OTHER = 'b'.repeat(64);
/** Call the worker. */
const call = (env, method, path, body) => worker.fetch(new Request(`https://w.test${path}`, {
  method, headers: { 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined,
}), env);

test('a mailbox can be written and read back', async () => {
  const env = { DB: fakeDB() };
  assert.equal((await call(env, 'GET', `/box/${ID}`)).status, 404);
  assert.equal((await call(env, 'PUT', `/box/${ID}`, { ciphertext: 'x', iv: 'y', updatedAt: 't1' })).status, 200);
  const got = await (await call(env, 'GET', `/box/${ID}`)).json();
  assert.deepEqual(got, { ciphertext: 'x', iv: 'y', updatedAt: 't1' });
});

test('a replaced link can never read or write again', async () => {
  const env = { DB: fakeDB() };
  await call(env, 'PUT', `/box/${ID}`, { ciphertext: 'x', iv: 'y' });
  assert.equal((await call(env, 'DELETE', `/box/${ID}`)).status, 200);
  assert.equal((await call(env, 'GET', `/box/${ID}`)).status, 410);
  assert.equal((await call(env, 'PUT', `/box/${ID}`, { ciphertext: 'z', iv: 'y' })).status, 410);
  assert.equal(env.DB.rows.get(ID).ciphertext, '', 'its contents are gone');
});

test('many mailboxes are read in one request, replaced ones marked', async () => {
  const env = { DB: fakeDB() };
  await call(env, 'PUT', `/box/${ID}`, { ciphertext: 'x', iv: 'y', updatedAt: 't1' });
  await call(env, 'DELETE', `/box/${OTHER}`);
  const out = await (await call(env, 'POST', '/boxes', { ids: [ID, OTHER, 'c'.repeat(64)] })).json();
  assert.deepEqual(out, { [ID]: { ciphertext: 'x', iv: 'y', updatedAt: 't1' }, [OTHER]: { replaced: true } });
});

test('bad ids and oversized boxes are refused', async () => {
  const env = { DB: fakeDB() };
  assert.equal((await call(env, 'GET', '/box/not-hex')).status, 400);
  assert.equal((await call(env, 'POST', '/boxes', { ids: ['nope'] })).status, 400);
  const big = 'x'.repeat(64 * 1024 + 1);
  assert.equal((await call(env, 'PUT', `/box/${ID}`, { ciphertext: big, iv: 'y' })).status, 413);
});

test('200 mailboxes are one database query, not 200: the free plan allows a request only 50', async () => {
  let queries = 0;
  const rows = new Map([[ID, { ciphertext: 'x', iv: 'y', updated_at: 't', revoked: 0 }]]);
  // A database that counts what it is asked: one for each lone statement, one for a whole batch.
  const DB = {
    prepare: () => ({ bind: (id) => ({ id, first: async () => { queries += 1; return rows.get(id) || null; } }) }),
    batch: async (statements) => { queries += 1; return statements.map((s) => ({ results: rows.has(s.id) ? [rows.get(s.id)] : [] })); },
  };
  const ids = [ID, ...Array.from({ length: 199 }, (_, i) => i.toString(16).padStart(64, '0'))];
  for (const path of ['/boxes', '/claims']) {
    queries = 0;
    const res = await call({ DB }, 'POST', path, { ids });
    assert.equal(res.status, 200);
    assert.deepEqual(Object.keys(await res.json()), [ID], 'only the one that exists comes back');
    assert.equal(queries, 1, path);
  }
});

test('the daily tidy-up removes old claims and past email counts, and nothing else', async () => {
  const ran = [];
  const DB = {
    prepare: (sql) => ({ bind: (...args) => ({ sql, args }) }),
    batch: async (statements) => { ran.push(...statements); return []; },
  };
  await worker.scheduled({}, { DB });
  assert.deepEqual(ran.map((s) => s.sql), [TIDY_SQL.claims, TIDY_SQL.emailCounts]);
  // Half a year of claims and a week of counts are kept; only what is older goes.
  const daysAgo = (stamp) => Math.round((Date.now() - Date.parse(stamp)) / 86400000);
  assert.equal(daysAgo(ran[0].args[0]), 180);
  assert.match(ran[1].args[0], /^\d{4}-\d{2}-\d{2}$/);
  assert.ok(daysAgo(ran[1].args[0]) >= 7 && daysAgo(ran[1].args[0]) <= 8);
  // Synced rosters and staff mailboxes are never deleted by the server on its own.
  for (const s of ran) assert.doesNotMatch(s.sql, /blobs|mailboxes/);
});
