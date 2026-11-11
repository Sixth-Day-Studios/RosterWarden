/**
 * Staff saying yes or no to their own shifts through their link, end to end
 * with the real worker code behind a stand-in database: the answer lands on
 * the roster as ✓ or ✕ (the same codes Planning Center replies use), shows
 * back on their page, and drops when the place goes to someone else.
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
  // What D1's batch() gives: each statement's rows, in order.
  batch: async (statements) => Promise.all(statements.map(async (s) => ({ results: [await s.first()].filter(Boolean) }))),
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

/** The answer code the roster holds for its one place. */
const codeOn = (rosterId) => {
  const r = store.roster(rosterId);
  return r.responses?.[responseKey(r.assignments[0])];
};

test('a yes from their link shows as confirmed, and on their page', async () => {
  const { sam, roster } = await setUp();
  const [shift] = (await pageOf(sam.id)).shifts;
  assert.equal(shift.reply, null);

  await sends(sam.id, { shiftReplies: [{ ref: shift.ref, yes: true }] });
  await staff.syncStaff();
  assert.equal(codeOn(roster.id), 'C');
  assert.deepEqual(staff.takeSwapNews(), ['Sam can do 03 Jan 2099 Morning']);
  assert.equal((await pageOf(sam.id)).shifts[0].reply, 'yes');
});

test('changing to no shows as declined, and the same list again changes nothing', async () => {
  const { sam, roster } = await setUp();
  const [shift] = (await pageOf(sam.id)).shifts;
  await sends(sam.id, { shiftReplies: [{ ref: shift.ref, yes: true }] });
  await staff.syncStaff();
  staff.takeSwapNews();

  await sends(sam.id, { shiftReplies: [{ ref: shift.ref, yes: false }] });
  await staff.syncStaff();
  assert.equal(codeOn(roster.id), 'D');
  assert.deepEqual(staff.takeSwapNews(), ['Sam can\'t do 03 Jan 2099 Morning']);

  await sends(sam.id, { shiftReplies: [{ ref: shift.ref, yes: false }], note: 'again' });
  await staff.syncStaff();
  assert.deepEqual(staff.takeSwapNews(), []);
});

test('an answer for a place that has gone to someone else is ignored', async () => {
  const { sam, alex, roster } = await setUp();
  const [shift] = (await pageOf(sam.id)).shifts;
  const r = store.roster(roster.id);
  store.updateRoster(roster.id, { assignments: [{ ...r.assignments[0], personId: alex.id }] });

  await sends(sam.id, { shiftReplies: [{ ref: shift.ref, yes: false }] });
  await staff.syncStaff();
  assert.equal(codeOn(roster.id), undefined);
});

test('answers that aren\'t a plain yes or no are ignored', async () => {
  const { sam, roster } = await setUp();
  const [shift] = (await pageOf(sam.id)).shifts;
  await sends(sam.id, { shiftReplies: [{ ref: shift.ref, yes: 'maybe' }, { ref: 'nonsense', yes: true }, null] });
  await staff.syncStaff();
  assert.equal(codeOn(roster.id), undefined);
});
