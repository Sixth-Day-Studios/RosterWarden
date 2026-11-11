/**
 * Shift swaps through staff links, end to end with the real worker code
 * behind a stand-in database: one person asks a colleague to take a shift,
 * the colleague's page shows the ask, and their yes hands the shift over
 * straight away (self swap) or after the owner approves it (swap with approval).
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

const DAY = '2099-01-03';

/** A workplace with Sam rostered on DAY, and Sam, Alex and Jo all with links. */
async function setUp(mode) {
  mem.clear(); rows.clear();
  store.reset(); store.load();
  const org = store.addOrg('Cafe');
  const shift = store.addShift({ name: 'Morning', start: '08:00', end: '12:00', headcount: 1 });
  const sam = store.addPerson('Sam Jones');
  const alex = store.addPerson('Alex Lee');
  const jo = store.addPerson('Jo Park');
  const roster = store.saveRoster({
    orgId: org.id, name: 'January', startDate: DAY, endDate: DAY, days: [DAY],
    assignments: [{ date: DAY, shiftId: shift.id, personId: sam.id }], notes: [],
  });
  staff.setSwapMode(org.id, mode);
  for (const p of [sam, alex, jo]) await staff.createLink(p.id);
  await staff.publish();   // as the app does after any change, so each page lists the others
  return { org, sam, alex, jo, roster };
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

/** Sam asks `toId` to take their shift, using the reference on Sam's page. */
async function samAsks(sam, toId) {
  const page = await pageOf(sam.id);
  await sends(sam.id, { swapAsks: [{ id: 'ask-0001', ref: page.shifts[0].ref, toId }], swapAnswers: [] });
  await staff.syncStaff();
}

test('with swaps off, the page has no swaps and an ask is ignored', async () => {
  const { sam, alex } = await setUp('off');
  assert.deepEqual((await pageOf(sam.id)).swaps, { mode: 'off' });
  await samAsks(sam, alex.id);
  assert.equal(store.data.swaps.length, 0);
});

test('self swap: the colleague sees the ask, and their yes hands the shift over', async () => {
  const { sam, alex, roster } = await setUp('self');
  const samPage = await pageOf(sam.id);
  assert.equal(samPage.swaps.mode, 'self');
  assert.deepEqual(samPage.swaps.colleagues.map((c) => c.name), ['Alex Lee', 'Jo Park']);

  await samAsks(sam, alex.id);
  assert.equal(store.data.swaps[0].status, 'asked');
  assert.match(staff.takeSwapNews()[0], /Sam asked Alex/);
  const alexPage = await pageOf(alex.id);
  assert.equal(alexPage.swaps.in.length, 1);
  assert.equal(alexPage.swaps.in[0].fromName, 'Sam Jones');
  assert.equal(alexPage.swaps.in[0].shift, 'Morning');

  await sends(alex.id, { swapAsks: [], swapAnswers: [{ id: 'ask-0001', accept: true }] });
  await staff.syncStaff();
  const place = store.roster(roster.id).assignments[0];
  assert.equal(place.personId, alex.id);
  assert.equal(place.locked, true, 'a swap is pinned so a rebuild keeps it');
  assert.equal(store.data.swaps[0].status, 'done');
  assert.equal((await pageOf(alex.id)).shifts.length, 1, 'now on Alex\'s page');
  assert.equal((await pageOf(sam.id)).swaps.out[0].status, 'done');
});

test('swap with approval: a yes waits for the owner, who approves it', async () => {
  const { sam, alex, roster } = await setUp('approval');
  await samAsks(sam, alex.id);
  await sends(alex.id, { swapAsks: [], swapAnswers: [{ id: 'ask-0001', accept: true }] });
  await staff.syncStaff();
  assert.equal(store.data.swaps[0].status, 'accepted');
  assert.equal(store.roster(roster.id).assignments[0].personId, sam.id, 'not until approved');
  assert.equal(staff.openSwaps().length, 1);

  assert.equal(staff.decideSwap('ask-0001', true), true);
  assert.equal(store.roster(roster.id).assignments[0].personId, alex.id);
  assert.equal(staff.openSwaps().length, 0);
});

test('the owner can decline an agreed swap, and a colleague can say no', async () => {
  const { sam, alex, roster } = await setUp('approval');
  await samAsks(sam, alex.id);
  await sends(alex.id, { swapAsks: [], swapAnswers: [{ id: 'ask-0001', accept: true }] });
  await staff.syncStaff();
  staff.decideSwap('ask-0001', false);
  assert.equal(store.data.swaps[0].status, 'rejected');
  assert.equal(store.roster(roster.id).assignments[0].personId, sam.id);

  const again = await setUp('self');
  await samAsks(again.sam, again.alex.id);
  await sends(again.alex.id, { swapAsks: [], swapAnswers: [{ id: 'ask-0001', accept: false }] });
  await staff.syncStaff();
  assert.equal(store.data.swaps[0].status, 'declined');
  assert.equal(store.roster(again.roster.id).assignments[0].personId, again.sam.id);
});

test('anyone can be asked, even someone away that day, but not someone without a link', async () => {
  const { sam, alex } = await setUp('self');
  store.addBlackout(alex.id, DAY, DAY, 'holiday');
  const nolink = store.addPerson('No Link');
  await samAsks(sam, nolink.id);
  assert.equal(store.data.swaps.length, 0);

  await sends(sam.id, { swapAsks: [{ id: 'ask-0002', ref: (await pageOf(sam.id)).shifts[0].ref, toId: alex.id }] });
  await staff.syncStaff();
  assert.equal(store.data.swaps[0].toId, alex.id);
});

test('an ask taken out of the page is withdrawn, and turning swaps off cancels unanswered asks', async () => {
  const { org, sam, alex, jo } = await setUp('self');
  await samAsks(sam, alex.id);
  await sends(sam.id, { swapAsks: [] });
  await staff.syncStaff();
  assert.equal(store.data.swaps[0].status, 'cancelled');

  const page = await pageOf(sam.id);
  await sends(sam.id, { swapAsks: [{ id: 'ask-0003', ref: page.shifts[0].ref, toId: jo.id }] });
  await staff.syncStaff();
  staff.setSwapMode(org.id, 'off');
  assert.equal(store.data.swaps.find((w) => w.id === 'ask-0003').status, 'cancelled');
});

test('an ask for a place the owner has since changed is cancelled', async () => {
  const { sam, alex, jo, roster } = await setUp('approval');
  await samAsks(sam, alex.id);
  const moved = store.roster(roster.id).assignments.map((a) => ({ ...a, personId: jo.id }));
  store.updateRoster(roster.id, { assignments: moved });
  assert.equal(staff.openSwaps().length, 0);
  assert.equal(store.data.swaps[0].status, 'cancelled');
});

test('saving dates from a page that knows nothing of swaps leaves an ask alone', async () => {
  const { sam, alex } = await setUp('self');
  await samAsks(sam, alex.id);
  const { inId, cryptoKey } = await link.boxesFor(keyOf(sam.id));
  await new Promise((r) => setTimeout(r, 5));
  await link.writeBox(inId, cryptoKey, { awayDates: ['2099-02-01'], note: '' });
  await staff.syncStaff();
  assert.equal(store.data.swaps[0].status, 'asked');
});
