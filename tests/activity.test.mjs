/**
 * The Updates log: what staff send through their links is written to
 * store.data.activity for the owner to review - one entry per reply, change
 * of dates, note and swap - once only, pruned after 90 days, and counted until seen.
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


test('a reply is logged once, with where it is, and a repeat send adds nothing', async () => {
  const { sam, roster } = await setUp();
  const [shift] = (await pageOf(sam.id)).shifts;
  await sends(sam.id, { shiftReplies: [{ ref: shift.ref, yes: false }] });
  await staff.syncStaff();
  let log = staff.activityLog();
  assert.equal(log.length, 1);
  assert.equal(log[0].kind, 'reply');
  assert.equal(log[0].rosterId, roster.id);
  assert.equal(log[0].yes, false);
  assert.equal(log[0].seen, false);

  await sends(sam.id, { shiftReplies: [{ ref: shift.ref, yes: false }] });
  await staff.syncStaff();
  assert.equal(staff.activityLog().length, 1);
});

test('dates added and removed, a clash, and a changed note are each logged', async () => {
  const { sam } = await setUp();
  await sends(sam.id, { awayDates: [DAY, '2099-01-10'], note: 'wedding' });
  await staff.syncStaff();
  let log = staff.activityLog();
  const dates = log.find((e) => e.kind === 'dates');
  assert.match(dates.text, /Sam can't work .* and .*clashes with January/);
  assert.ok(dates.rosterId);
  assert.ok(log.some((e) => e.kind === 'note' && e.text.includes('wedding')));

  await sends(sam.id, { awayDates: ['2099-01-10'], note: 'wedding' });
  await staff.syncStaff();
  log = staff.activityLog();
  assert.ok(log.some((e) => /can work .* again/.test(e.text)));
  assert.equal(log.filter((e) => e.kind === 'note').length, 1, 'an unchanged note is not logged again');
});

test('swap asks and answers are logged', async () => {
  const { sam, alex } = await setUp();
  store.updateOrg(store.currentOrg().id, { swapMode: 'self' });
  await staff.publish();
  const [shift] = (await pageOf(sam.id)).shifts;
  await sends(sam.id, { swapAsks: [{ id: 'ask-12345678', ref: shift.ref, toId: alex.id }] });
  await staff.syncStaff();
  await sends(alex.id, { swapAnswers: [{ id: 'ask-12345678', accept: true }] });
  await staff.syncStaff();
  const texts = staff.activityLog().filter((e) => e.kind === 'swap').map((e) => e.text);
  assert.equal(texts.length, 2);
  assert.ok(texts.some((t) => t.includes('asked Alex')));
  assert.ok(texts.some((t) => t.includes('Alex took')));
});

test('the unseen count goes down as entries are seen, and old entries are pruned', async () => {
  const { sam } = await setUp();
  await sends(sam.id, { awayDates: ['2099-02-01'], note: 'hi' });
  await staff.syncStaff();
  assert.equal(staff.unseenCount(), 2);
  staff.markSeen([staff.activityLog()[0].id]);
  assert.equal(staff.unseenCount(), 1);
  staff.markSeen();
  assert.equal(staff.unseenCount(), 0);

  store.data.activity[0].at = new Date(Date.now() - 91 * 86400000).toISOString();
  await sends(sam.id, { awayDates: ['2099-02-02'], note: 'hi' });
  await staff.syncStaff();
  assert.ok(store.data.activity.every((e) => Date.now() - Date.parse(e.at) < 90 * 86400000));
});
