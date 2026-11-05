/**
 * Two devices sharing one sync code, each its own copy of js/sync.js with its
 * own storage, against the real worker code behind a stand-in database. The
 * promise under test: one device's work is never silently replaced by the
 * other's - not when both are open at once, not when their clocks disagree,
 * and not after a clash has been seen - until the person chooses a copy.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import worker, { BLOB_SQL } from '../worker/src/index.js';

globalThis.btoa ??= (s) => Buffer.from(s, 'binary').toString('base64');
globalThis.atob ??= (s) => Buffer.from(s, 'base64').toString('binary');

/** A stand-in D1 for the blobs table (see tests/worker-sync.test.mjs). */
const rows = new Map();
const DB = {
  prepare(sql) {
    return {
      bind(...a) {
        return {
          first: async () => rows.get(a[0]) || null,
          run: async () => {
            const [id, ciphertext, iv, updatedAt, base] = a;
            if (sql === BLOB_SQL.writeOver && rows.has(id) && rows.get(id).updated_at !== base) return { meta: { changes: 0 } };
            rows.set(id, { ciphertext, iv, updated_at: updatedAt });
            return { meta: { changes: 1 } };
          },
        };
      },
    };
  },
};
globalThis.fetch = (url, opts) => worker.fetch(new Request(url, opts), { DB });

/** A device: its own storage, and its own copy of the sync module. */
async function device(name) {
  const mem = new Map();
  const storage = {
    getItem: (k) => (mem.has(k) ? mem.get(k) : null),
    setItem: (k, v) => mem.set(k, String(v)),
    removeItem: (k) => mem.delete(k),
  };
  const sync = await import(`../js/sync.js?device=${name}-${Math.random()}`);
  const d = {
    data: null,
    conflicts: 0,
    /** Run `fn` with this device's storage in place (one device at a time, start to finish). */
    async use(fn) {
      globalThis.localStorage = storage;
      return fn(sync);
    },
    /** What the app does on a save: mark it, and queue an upload (sent straight away here). */
    async save(data) {
      d.data = data;
      await d.use(async (s) => {
        s.markChanged();
        s.schedulePush(data, 0);
        await new Promise((r) => { setTimeout(r, 60); });
      });
    },
    /** What the app does on opening or coming back. */
    reconcile() {
      return d.use((s) => s.reconcile(d.data, (server) => { d.data = server; }));
    },
  };
  await d.use((s) => { s.setCode(CODE); s.onConflict(() => { d.conflicts += 1; }); });
  return d;
}

const CODE = 'abcd-efgh-jkmn-pqrs';

/** What the server holds now, decrypted. */
async function onServer(d) {
  return d.use(async (s) => (await s.pull()).data);
}

test('two devices open at once: the stale one is stopped, not allowed to wipe the other\'s work', async () => {
  rows.clear();
  const a = await device('a');
  const b = await device('b');
  a.data = { people: ['base'] };
  assert.equal((await a.reconcile()).action, 'uploaded');
  assert.equal((await b.reconcile()).action, 'downloaded');

  await a.save({ people: ['base', 'from A'] });
  // B is still showing the old copy and saves its own edit on top of it.
  await b.save({ people: ['base', 'from B'] });

  assert.equal(b.conflicts, 1, 'B is asked which copy to keep');
  assert.deepEqual(await onServer(a), { people: ['base', 'from A'] }, 'A\'s work is still on the server');

  // Nothing more from B uploads until the person chooses.
  await b.save({ people: ['base', 'from B', 'more'] });
  assert.deepEqual(await onServer(a), { people: ['base', 'from A'] });

  // B takes A's copy.
  await b.use((s) => s.resolveConflict(false, b.data, (server) => { b.data = server; }));
  assert.deepEqual(b.data, { people: ['base', 'from A'] });
  await b.save({ people: ['base', 'from A', 'then B'] });
  assert.deepEqual(await onServer(a), { people: ['base', 'from A', 'then B'] }, 'B uploads normally again');
});

test('keeping this device\'s copy replaces the server\'s, on purpose', async () => {
  rows.clear();
  const a = await device('a');
  const b = await device('b');
  a.data = { people: ['base'] };
  await a.reconcile();
  await b.reconcile();
  await a.save({ people: ['A'] });
  await b.save({ people: ['B'] });
  await b.use((s) => s.resolveConflict(true, b.data, () => assert.fail('keeps its own')));
  assert.deepEqual(await onServer(a), { people: ['B'] });
  assert.equal((await a.reconcile()).action, 'downloaded', 'and the other device picks it up');
  assert.deepEqual(a.data, { people: ['B'] });
});

test('a device whose clock is behind still has its save picked up', async () => {
  rows.clear();
  const a = await device('a');
  const b = await device('b');
  a.data = { people: ['base'] };
  await a.reconcile();
  await b.reconcile();
  await b.save({ people: ['base', 'from B'] });
  // B's clock is years slow, so its save carries a stamp older than anything A has seen.
  const [id] = rows.keys();
  rows.get(id).updated_at = '2001-01-01T00:00:00.000Z';
  await b.use((s) => s.agreedWith('2001-01-01T00:00:00.000Z'));

  assert.equal((await a.reconcile()).action, 'downloaded');
  assert.deepEqual(a.data, { people: ['base', 'from B'] });
});

test('both changed at opening: it is a conflict, and nothing uploads meanwhile', async () => {
  rows.clear();
  const a = await device('a');
  const b = await device('b');
  a.data = { people: ['base'] };
  await a.reconcile();
  await b.reconcile();
  await a.save({ people: ['A'] });
  // B changed things offline: its upload failed, so it only finds out on opening.
  await b.use((s) => s.markChanged());
  b.data = { people: ['B offline'] };

  assert.equal((await b.reconcile()).action, 'conflict');
  await b.save({ people: ['B offline', 'more'] });
  assert.deepEqual(await onServer(a), { people: ['A'] });
});
