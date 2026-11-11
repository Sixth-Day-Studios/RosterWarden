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
// Reads can be slowed (`slowReads`), so a test can have an upload queue up behind a sync still on its way.
let slowReads = false;
globalThis.fetch = async (url, opts) => {
  if (slowReads && (opts?.method || 'GET') === 'GET') await new Promise((r) => { setTimeout(r, 40); });
  return worker.fetch(new Request(url, opts), { DB });
};

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

test('a fresh device syncing several times at once is not taken for a clash with itself', async () => {
  rows.clear();
  const a = await device('a');
  a.data = { people: ['first'] };
  // Launch and a few quick visibility changes, all before the first upload is back: each found nothing
  // stored, each uploaded over "nothing", and every one after the first was refused as a clash.
  const results = await a.use((s) => Promise.all(Array.from({ length: 5 }, () => s.reconcile(a.data, () => {}))));
  assert.ok(results.every((r) => r.action !== 'conflict'), JSON.stringify(results.map((r) => r.action)));
  assert.deepEqual(await onServer(a), { people: ['first'] });
  // And it is not left holding uploads back.
  await a.save({ people: ['first', 'then'] });
  assert.equal(a.conflicts, 0);
  assert.deepEqual(await onServer(a), { people: ['first', 'then'] });
});

test('an upload queued while a sync is under way waits for it, rather than clashing with it', async () => {
  rows.clear();
  const a = await device('a');
  a.data = { people: ['base'] };
  await a.reconcile();
  await a.use(async (s) => {
    s.markChanged();
    a.data = { people: ['base', 'edit'] };
    s.schedulePush(a.data, 0);           // fires while the sync below is still on its way
    await s.reconcile(a.data, () => {});
    await new Promise((r) => { setTimeout(r, 80); });
  });
  assert.equal(a.conflicts, 0);
  assert.deepEqual(await onServer(a), { people: ['base', 'edit'] });
});

test('an upload that was waiting while the other device\'s copy came in is dropped, not sent', async () => {
  rows.clear();
  const a = await device('a');
  const b = await device('b');
  a.data = { people: ['base'] };
  await a.reconcile();
  await b.reconcile();
  await a.save({ people: ['from A'] });
  // B has not changed anything, but an upload of its old copy is queued just as it syncs and takes A's.
  await b.use(async (s) => {
    slowReads = true;
    const sync = s.reconcile(b.data, (server) => { b.data = server; });
    s.schedulePush({ people: ['base'] }, 0);   // fires while the sync's read is still on its way
    await sync;
    slowReads = false;
    await new Promise((r) => { setTimeout(r, 80); });
  });
  assert.deepEqual(b.data, { people: ['from A'] });
  assert.deepEqual(await onServer(a), { people: ['from A'] }, 'B\'s old copy was not sent over it');
});

test('a device with no workplace yet leaves nothing on the server, until it has one', async () => {
  rows.clear();
  const a = await device('a');
  a.data = { orgs: [] };
  assert.equal((await a.reconcile()).action, 'nothing-yet');
  await a.save({ orgs: [] });
  assert.equal(rows.size, 0, 'merely opening the app makes no server copy');

  await a.save({ orgs: [{ id: 1, name: 'Cafe' }] });
  assert.deepEqual(await onServer(a), { orgs: [{ id: 1, name: 'Cafe' }] });
  // Delete all data still empties the copy the server already holds.
  await a.save({ orgs: [] });
  assert.deepEqual(await onServer(a), { orgs: [] });
});

test('backing up that the server keeps refusing is said once; a dropped connection stays quiet', async () => {
  rows.clear();
  const a = await device('a');
  const told = [];
  await a.use((s) => s.onTrouble((reason) => told.push(reason)));
  await a.save({ orgs: [{ id: 1 }] });
  const okAt = await a.use((s) => s.backupState().okAt);
  assert.ok(okAt, 'a sync that worked is remembered');

  const real = globalThis.fetch;
  try {
    // Offline: every try fails, and nobody is interrupted about it.
    globalThis.fetch = async () => { throw new TypeError('offline'); };
    for (let i = 0; i < 4; i++) await a.save({ orgs: [{ id: 1 }], n: i });
    assert.deepEqual(told, []);

    // The server answering no is different: after three in a row the person is told, once.
    globalThis.fetch = async () => new Response('{}', { status: 413 });
    for (let i = 0; i < 5; i++) await a.save({ orgs: [{ id: 1 }], n: i });
    assert.equal(told.length, 1);
    assert.match(told[0], /too big to back up/);
    assert.deepEqual(await a.use((s) => s.backupState()), { okAt, problem: told[0] }, 'Settings can say why, and since when');
  } finally {
    globalThis.fetch = real;
  }

  // Working again clears the problem, and a later run of refusals would be said again.
  await a.save({ orgs: [{ id: 1 }], n: 'again' });
  assert.equal(await a.use((s) => s.backupState().problem), '');
});

test('the synced copy is sealed for its own place on the server, and an older app\'s copy still opens once', async () => {
  rows.clear();
  // A copy written by the app from before sealing: the key alone, for no place in particular.
  const a = await device('a');
  const { storageId, cryptoKey } = await a.use((s) => s.deriveKeys(CODE));
  const unsealed = async (data, at) => rows.set(storageId, { ...(await a.use((s) => s.encrypt(data, cryptoKey))), updated_at: at });
  await unsealed({ orgs: [{ id: 1, name: 'Old app' }] }, 't-old');
  a.data = { orgs: [] };
  assert.equal((await a.reconcile()).action, 'downloaded', 'the old copy is read');

  // This device's own upload is sealed for that place...
  await a.save({ orgs: [{ id: 1, name: 'New app' }] });
  const stored = rows.get(storageId);
  await assert.rejects(a.use((s) => s.decrypt(stored, cryptoKey)), 'it no longer opens with the key alone');
  assert.deepEqual(await a.use((s) => s.decrypt(stored, cryptoKey, storageId)), { orgs: [{ id: 1, name: 'New app' }] });

  // ...so from now on a copy that isn't is refused, rather than taken for an old one.
  await unsealed({ orgs: [{ id: 1, name: 'Swapped in' }] }, 't-swap');
  await assert.rejects(a.use((s) => s.pull()), /did not unlock/);
  assert.deepEqual(a.data, { orgs: [{ id: 1, name: 'New app' }] });
});
