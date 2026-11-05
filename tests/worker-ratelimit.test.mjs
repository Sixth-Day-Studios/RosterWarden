/**
 * The sync worker's per-client rate limit, run against a stand-in for Cloudflare's rate-limiting binding:
 * a client past its limit gets a readable 429 the app can show (with CORS, so the browser lets the app
 * read it), nothing reaches the database, preflights aren't counted, and with no binding (or a broken
 * one) the worker behaves exactly as before.
 *
 *   node --test tests/worker-ratelimit.test.mjs
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import worker, { BLOB_SQL, clientKey } from '../worker/src/index.js';

/** A stand-in for env.RATE_LIMIT: allows `limit` calls per key, then says no. Records every key asked about. */
function fakeLimiter(limit) {
  const counts = new Map();
  return {
    keys: [],
    async limit({ key }) {
      this.keys.push(key);
      counts.set(key, (counts.get(key) || 0) + 1);
      return { success: counts.get(key) <= limit };
    },
  };
}

/** A stand-in D1 that holds no synced databases, and counts how often it is asked. */
function emptyDB() {
  return {
    queries: 0,
    prepare(sql) {
      assert.equal(sql, BLOB_SQL.read);
      this.queries += 1;
      return { bind: () => ({ first: async () => null }) };
    },
  };
}

const ID = 'a'.repeat(64);
const ORIGIN = 'https://rosterwarden.example';

/** A request from the app, from the given client address. */
const from = (ip, method = 'GET', path = `/db/${ID}`) => new Request(`https://w.test${path}`, {
  method, headers: { Origin: ORIGIN, ...(ip ? { 'CF-Connecting-IP': ip } : {}) },
});

test('a client within its limit is served as usual', async () => {
  const env = { DB: emptyDB(), RATE_LIMIT: fakeLimiter(2) };
  assert.equal((await worker.fetch(from('203.0.113.7'), env)).status, 404);
  assert.equal((await worker.fetch(from('203.0.113.7'), env)).status, 404);
  assert.deepEqual(env.RATE_LIMIT.keys, ['203.0.113.7', '203.0.113.7']);
});

test('past its limit a client gets a readable 429 with CORS, and the database is never asked', async () => {
  const env = { DB: emptyDB(), RATE_LIMIT: fakeLimiter(1) };
  await worker.fetch(from('203.0.113.7'), env);
  const res = await worker.fetch(from('203.0.113.7'), env);
  assert.equal(res.status, 429);
  assert.equal(res.headers.get('Access-Control-Allow-Origin'), ORIGIN);
  assert.match((await res.json()).error, /Too many requests/);
  assert.equal(env.DB.queries, 1);
  // Another client is counted on its own.
  assert.equal((await worker.fetch(from('198.51.100.2'), env)).status, 404);
});

test('CORS preflights are not counted', async () => {
  const env = { DB: emptyDB(), RATE_LIMIT: fakeLimiter(0) };
  const res = await worker.fetch(from('203.0.113.7', 'OPTIONS'), env);
  assert.equal(res.status, 204);
  assert.deepEqual(env.RATE_LIMIT.keys, []);
});

test('with no binding, or a limiter that fails, requests go through', async () => {
  const unbound = { DB: emptyDB() };
  for (let i = 0; i < 5; i += 1) assert.equal((await worker.fetch(from('203.0.113.7'), unbound)).status, 404);
  const broken = { DB: emptyDB(), RATE_LIMIT: { limit: async () => { throw new Error('limiter down'); } } };
  assert.equal((await worker.fetch(from('203.0.113.7'), broken)).status, 404);
});

test('clients are told apart by IPv4 address, or by IPv6 /64 network', () => {
  const key = (ip) => clientKey(from(ip));
  assert.equal(key('203.0.113.7'), '203.0.113.7');
  // An IPv4 address written as IPv6 stays one address, not a /64 shared with every other such client.
  assert.equal(key('::ffff:203.0.113.7'), '::ffff:203.0.113.7');
  assert.equal(key('2001:db8:abcd:12:1:2:3:4'), '2001:db8:abcd:12::/64');
  // Every address in one /64 is the same client, however it is written.
  assert.equal(key('2001:DB8:ABCD:12::99'), '2001:db8:abcd:12::/64');
  assert.equal(key('2001:db8::1'), '2001:db8:0:0::/64');
  assert.equal(key('2001:db8:0:0:ffff::1'), key('2001:db8::2'));
  assert.notEqual(key('2001:db8:0:1::1'), key('2001:db8:0:2::1'));
  assert.equal(key('::1'), '0:0:0:0::/64');
  assert.equal(key(null), 'unknown');
});
