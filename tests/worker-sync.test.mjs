/**
 * The sync worker's database endpoints (GET/PUT /db/:id) and its Planning
 * Center token swap, run against a stand-in database answering exactly the
 * BLOB_SQL statements and a stand-in Planning Center (by `fetch`): a device
 * that says which copy it last saw can't overwrite one another device saved
 * since, and Planning Center being down is not a refusal.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import worker, { BLOB_SQL } from '../worker/src/index.js';

/** An in-memory D1 for the blobs table, each statement one step, with `meta.changes` as D1 gives it. */
function fakeDB() {
  const rows = new Map();
  return {
    rows,
    prepare(sql) {
      return {
        bind(...a) {
          return {
            async first() {
              assert.equal(sql, BLOB_SQL.read);
              return rows.get(a[0]) || null;
            },
            async run() {
              const [id, ciphertext, iv, updatedAt, base] = a;
              const row = { ciphertext, iv, updated_at: updatedAt };
              if (sql === BLOB_SQL.write) {
                rows.set(id, row);
                return { meta: { changes: 1 } };
              }
              assert.equal(sql, BLOB_SQL.writeOver);
              // A new row always goes in; an existing one is replaced only while it is still the `base` copy.
              if (rows.has(id) && rows.get(id).updated_at !== base) return { meta: { changes: 0 } };
              rows.set(id, row);
              return { meta: { changes: 1 } };
            },
          };
        },
      };
    },
  };
}

const ID = 'a'.repeat(64);

/** PUT /db/:id with `body`. */
const put = (env, body) => worker.fetch(new Request(`https://w.test/db/${ID}`, {
  method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
}), env);

test('a write over the copy the device last saw lands, and one over a newer copy is refused', async () => {
  const env = { DB: fakeDB() };
  assert.equal((await put(env, { ciphertext: 'A1', iv: 'i', updatedAt: 't1', base: '' })).status, 200, 'first ever write');
  assert.equal((await put(env, { ciphertext: 'A2', iv: 'i', updatedAt: 't2', base: 't1' })).status, 200, 'over its own copy');

  // Another device still on t1 tries to save: refused, told the stamp of what is there now, nothing lost.
  const stale = await put(env, { ciphertext: 'B', iv: 'i', updatedAt: 't3', base: 't1' });
  assert.equal(stale.status, 409);
  assert.equal((await stale.json()).updatedAt, 't2');
  assert.equal(env.DB.rows.get(ID).ciphertext, 'A2');
});

test('a write with no base (an app from before the check) still replaces what is there', async () => {
  const env = { DB: fakeDB() };
  await put(env, { ciphertext: 'A', iv: 'i', updatedAt: 't1' });
  assert.equal((await put(env, { ciphertext: 'B', iv: 'i', updatedAt: 't2' })).status, 200);
  assert.equal(env.DB.rows.get(ID).ciphertext, 'B');
});

// ── Planning Center token swap ──
let pcoReply = null;
globalThis.fetch = async (url) => {
  assert.equal(url, 'https://api.planningcenteronline.com/oauth/token');
  return new Response(JSON.stringify(pcoReply.body), { status: pcoReply.status });
};

/** POST /pco/refresh for a worker with Planning Center set up. */
const refresh = () => worker.fetch(new Request('https://w.test/pco/refresh', {
  method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ refresh_token: 'r' }),
}), { PCO_CLIENT_ID: 'id', PCO_CLIENT_SECRET: 'secret' });

test('Planning Center being down or busy is a 502, so the app keeps its tokens', async () => {
  for (const status of [500, 503, 429]) {
    pcoReply = { status, body: {} };
    assert.equal((await refresh()).status, 502, `Planning Center ${status}`);
  }
});

test('a token Planning Center refuses is still a 400, so the app signs out', async () => {
  pcoReply = { status: 401, body: { error: 'invalid_grant' } };
  const res = await refresh();
  assert.equal(res.status, 400);
  assert.match((await res.json()).error, /invalid_grant/);
});

test('nothing oversized gets in beside the ciphertext, or under the database\'s own limit', async () => {
  const env = { DB: fakeDB() };
  const send = (path, body, headers = {}) => worker.fetch(new Request(`https://w.test${path}`, {
    method: 'PUT', headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(body),
  }), env);
  const big = 'x'.repeat(5000);

  // Each endpoint caps its ciphertext; the fields beside it are held to their real sizes too.
  for (const path of [`/db/${ID}`, `/box/${ID}`, `/claim/${ID}`]) {
    assert.equal((await send(path, { ciphertext: 'A', iv: big, token: ID })).status, 413, `${path}: a long iv`);
  }
  assert.equal((await send(`/db/${ID}`, { ciphertext: 'A', iv: 'i', updatedAt: big })).status, 413, 'a long stamp');
  assert.equal((await send(`/db/${ID}`, { ciphertext: 'A', iv: 'i', updatedAt: 't', base: big })).status, 413, 'a long base');
  assert.equal((await send(`/box/${ID}`, { ciphertext: 'A', iv: 'i', updatedAt: big })).status, 413, 'a long mailbox stamp');

  // The database stores at most 2,000,000 bytes in one value: a blob just under that is refused here, readably.
  assert.equal((await send(`/db/${ID}`, { ciphertext: 'x'.repeat(1950000), iv: 'i' })).status, 413);
  // A body that says up front it is too big is refused before it is read.
  assert.equal((await send(`/claim/${ID}`, { ciphertext: 'A', iv: 'i', token: ID }, { 'Content-Length': '500000' })).status, 413);
  assert.equal(env.DB.rows.size, 0, 'none of it was stored');

  // A real nonce and ISO stamp still go in.
  assert.equal((await send(`/db/${ID}`, { ciphertext: 'A', iv: 'AAAAAAAAAAAAAAAA', updatedAt: new Date().toISOString(), base: '' })).status, 200);
});
