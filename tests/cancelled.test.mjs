/**
 * Cancelled shifts: a shift someone said they can do that is then taken off
 * them shows on their link page as cancelled (until its day passes), and the
 * owner's confirm names who said yes.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import worker, { BOX_SQL } from '../worker/src/index.js';

// ── a browser-ish environment: localStorage, and fetch routed into the worker ──
const mem = new Map();
globalThis.localStorage = {
  getItem: (k) => (mem.has(k) ? mem.get(k) : null),
  setItem: (k, v) => mem.set(k, String(v)),
  removeItem: (k) => mem.delete(k),
};
const rows = new Map();
const DB = {
  prepare(sql) {
    return {
      bind(...a) {
        return {
          first: async () => rows.get(a[0]) || null,
          run: async () => {
            if (sql === BOX_SQL.write && !rows.get(a[0])?.revoked) {
              rows.set(a[0], { ciphertext: a[1], iv: a[2], updated_at: a[3], revoked: 0 });
            } else if (sql === BOX_SQL.revoke) {
              rows.set(a[0], { ciphertext: '', iv: '', updated_at: a[1], revoked: 1 });
            }
          },
        };
      },
    };
  },
};
globalThis.fetch = (url, opts) => worker.fetch(new Request(url, opts), { DB });

const { store } = await import('../js/store.js');
const staff = await import('../js/staff.js');
const link = await import('../js/staff-link.js');
const { responseKey } = await import('../js/sources/planning-center.js');

const DAY = '2099-01-03';

/** A workplace with Sam rostered on DAY, and Sam and Alex with links. */
async function setUp() {
  mem.clear(); rows.clear();
  store.reset(); store.load();
  const org = store.addOrg('Cafe');
  const shift = store.addShift({ name: 'Morning', start: '08:00', end: '12:00', headcount: 1 });
  const sam = store.addPerson('Sam Jones');
  const alex = store.addPerson('Alex Lee');
  const roster = store.saveRoster({
    orgId: org.id, name: 'January', startDate: DAY, endDate: DAY, days: [DAY],
    assignments: [{ date: DAY, shiftId: shift.id, personId: sam.id }], notes: [],
  });
  for (const p of [sam, alex]) await staff.createLink(p.id);
  return { sam, alex, roster };
}

/** The key in a person's link. */
const keyOf = (id) => store.data.people.find((p) => p.id === id).staffLink.key;

/** What a person's link page shows, as the owner last published it. */
async function pageOf(id) {
  const { outId, cryptoKey } = await link.boxesFor(keyOf(id));
  return (await link.readBox(outId, cryptoKey)).value;
}

/** What a person's link page does: send its whole state through their link. */
async function sends(id, value) {
  const { inId, cryptoKey } = await link.boxesFor(keyOf(id));
  await new Promise((r) => setTimeout(r, 5));   // each send newer than the last
  return link.writeBox(inId, cryptoKey, { awayDates: [], note: '', ...value });
}



/** Sam says yes to their shift, and the page is published with that answer. */
async function samSaysYes(sam) {
  const [shift] = (await pageOf(sam.id)).shifts;
  await sends(sam.id, { shiftReplies: [{ ref: shift.ref, yes: true }] });
  await staff.syncStaff();
  await staff.publish();
  return shift;
}

test('a shift they said yes to and is then removed shows as cancelled', async () => {
  const { sam, roster } = await setUp();
  const shift = await samSaysYes(sam);
  store.updateRoster(roster.id, { assignments: [] });
  await staff.publish();
  const page = await pageOf(sam.id);
  assert.equal(page.shifts.length, 0);
  assert.equal(page.cancelled.length, 1);
  assert.equal(page.cancelled[0].ref, shift.ref);
  assert.equal(page.cancelled[0].shift, 'Morning');
});

test('deleting the whole roster cancels it too, and the owner is told who said yes', async () => {
  const { sam, roster } = await setUp();
  await samSaysYes(sam);
  assert.deepEqual(staff.saidYes(store.roster(roster.id)), ['Sam']);
  assert.match(staff.cancelWarning(['Sam', 'Alex']), /Sam and Alex said they can do it\./);
  assert.equal(staff.cancelWarning([]), '');
  store.deleteRoster(roster.id);
  await staff.publish();
  assert.equal((await pageOf(sam.id)).cancelled.length, 1);
});

test('a shift nobody said yes to just goes, with no cancelled line', async () => {
  const { sam, roster } = await setUp();
  store.updateRoster(roster.id, { assignments: [] });
  await staff.publish();
  assert.deepEqual((await pageOf(sam.id)).cancelled, []);
  assert.deepEqual(staff.saidYes(store.roster(roster.id)), []);
});

test('a cancelled shift that comes back (an undo) drops off the cancelled list', async () => {
  const { sam, roster } = await setUp();
  await samSaysYes(sam);
  const before = store.roster(roster.id).assignments;
  store.updateRoster(roster.id, { assignments: [] });
  await staff.publish();
  store.updateRoster(roster.id, { assignments: before });
  await staff.publish();
  const page = await pageOf(sam.id);
  assert.equal(page.shifts.length, 1);
  assert.deepEqual(page.cancelled, []);
});
