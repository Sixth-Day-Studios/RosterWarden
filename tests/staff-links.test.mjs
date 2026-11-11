/**
 * Staff links end to end, with the real worker code behind a stand-in
 * database: the owner makes a link, the staff member sends dates, the owner's
 * app applies them without touching dates the owner entered, and a replaced
 * link can never write again while the dates carry over.
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

/** A fresh store with one person. */
function setUp() {
  mem.clear(); rows.clear();
  store.reset(); store.load(); store.addOrg('Catering');
  return store.addPerson('Sam Jones');
}
/** What the staff member's page does: send their dates through their link. */
async function staffSends(key, awayDates, note = '') {
  const { inId, cryptoKey } = await link.boxesFor(key);
  // Distinct timestamps, so each send is newer than the last.
  await new Promise((r) => setTimeout(r, 5));
  return link.writeBox(inId, cryptoKey, { awayDates, note });
}

test('a new link publishes their name for their page, and nothing on the server is readable', async () => {
  const sam = setUp();
  await staff.createLink(sam.id);
  const key = store.people()[0].staffLink.key;
  const { outId, cryptoKey } = await link.boxesFor(key);
  const page = await link.readBox(outId, cryptoKey);
  assert.equal(page.value.name, 'Sam Jones');
  assert.equal(page.value.org, 'Catering');
  assert.ok(![...rows.values()].some((r) => r.ciphertext.includes('Sam')), 'names never reach the server');
});

test('dates sent through the link become away dates, and leave the owner\'s own alone', async () => {
  const sam = setUp();
  store.addBlackout(sam.id, '2026-12-25', '2026-12-25', 'Christmas');
  await staff.createLink(sam.id);
  const key = store.people()[0].staffLink.key;

  await staffSends(key, ['2026-11-08', '2026-11-15'], 'wedding');
  const changed = await staff.syncStaff();
  assert.equal(changed.length, 1);
  let p = store.people()[0];
  assert.deepEqual(staff.staffDates(p), ['2026-11-08', '2026-11-15']);
  assert.equal(p.staffLink.note, 'wedding');
  assert.ok(p.blackouts.some((b) => b.start === '2026-12-25' && !b.source), 'owner-entered date kept');

  // A second send replaces the first; nothing new means nothing changes.
  await staffSends(key, ['2026-11-22']);
  await staff.syncStaff();
  p = store.people()[0];
  assert.deepEqual(staff.staffDates(p), ['2026-11-22']);
  assert.equal((await staff.syncStaff()).length, 0);
});

test('a replaced link can never send again, and the dates carry over to the new one', async () => {
  const sam = setUp();
  await staff.createLink(sam.id);
  const oldKey = store.people()[0].staffLink.key;
  await staffSends(oldKey, ['2026-11-08']);

  await staff.replaceLink(sam.id);   // picks up the waiting send first
  const p = store.people()[0];
  assert.notEqual(p.staffLink.key, oldKey);
  assert.deepEqual(staff.staffDates(p), ['2026-11-08']);
  await assert.rejects(staffSends(oldKey, ['2026-11-29']), link.LinkReplaced);

  const { outId, cryptoKey } = await link.boxesFor(p.staffLink.key);
  assert.deepEqual((await link.readBox(outId, cryptoKey)).value.awayDates, ['2026-11-08'], 'new link starts with their dates');
});

test('clearing takes away only the dates from their link', async () => {
  const sam = setUp();
  store.addBlackout(sam.id, '2026-12-25', '2026-12-25', 'Christmas');
  await staff.createLink(sam.id);
  await staffSends(store.people()[0].staffLink.key, ['2026-11-08']);
  await staff.syncStaff();
  staff.clearStaffDates(sam.id);
  assert.deepEqual(store.people()[0].blackouts.map((b) => b.start), ['2026-12-25']);
});

test('a date that is not a real date is ignored, and staff sync carries on', async () => {
  const sam = setUp();
  await staff.createLink(sam.id);
  // A tampered page: before dates were checked, "2026-13-45" was kept and every sync after it threw.
  await staffSends(store.people()[0].staffLink.key, ['2026-13-45', '2026-02-30', '2026-11-08']);
  await staff.syncStaff();
  assert.deepEqual(staff.staffDates(store.people()[0]), ['2026-11-08']);
  await staff.syncStaff();
});

test('a bad date already kept from before is skipped rather than breaking their page', () => {
  const sam = setUp();
  store.replaceSourcedBlackouts(sam.id, staff.SOURCE, [{ start: '2026-13-45', end: '2026-13-45', reason: 'from their link' }]);
  assert.deepEqual(staff.staffDates(store.people()[0]), []);
});

test('one person sending the wrong shape of data does not stop everyone after them being read', async () => {
  setUp();
  const bob = store.addPerson('Bob Green');
  const sam = store.people().find((p) => p.name === 'Sam Jones');
  await staff.createLink(sam.id);
  await staff.createLink(bob.id);
  const poison = { toString: 1, valueOf: 1 };   // String() of this throws
  const { inId, cryptoKey } = await link.boxesFor(store.people().find((p) => p.id === sam.id).staffLink.key);
  await link.writeBox(inId, cryptoKey, {
    awayDates: [poison], note: poison, profile: { name: poison, email: poison }, shiftReplies: [{ ref: poison, yes: true }],
  });
  await staffSends(store.people().find((p) => p.id === bob.id).staffLink.key, ['2026-11-08']);

  await staff.syncStaff();
  assert.deepEqual(staff.staffDates(store.people().find((p) => p.id === bob.id)), ['2026-11-08']);
  // Making Sam a new link works too (it reads their mailbox first).
  await staff.replaceLink(sam.id);
});

test('an email with mailto: extras in it is not taken in', async () => {
  const sam = setUp();
  await staff.createLink(sam.id);
  await staffSendsProfile(store.people()[0].staffLink.key, { name: 'Sam Jones', email: 'sam@x.com?cc=boss%40evil.example&body=Pay%20here&z=.y', mobile: '' });
  await staff.syncStaff();
  assert.equal(store.people()[0].email || '', '');
});

test('a new away date that clashes with a saved roster is found', async () => {
  const sam = setUp();
  const shift = store.addShift({ name: 'Wedding', start: '10:00', end: '16:00', headcount: 1 });
  store.saveRoster({ orgId: store.currentOrg().id, name: 'Nov', days: ['2099-11-08'], notes: [],
    assignments: [{ date: '2099-11-08', shiftId: shift.id, personId: sam.id }] });
  await staff.createLink(sam.id);
  await staffSends(store.people()[0].staffLink.key, ['2099-11-08']);
  const changed = await staff.syncStaff();
  assert.deepEqual(staff.clashes(changed).map((c) => [c.date, c.roster]), [['2099-11-08', 'Nov']]);
});

/** What the staff member's page does when they save their details too. */
async function staffSendsProfile(key, profile) {
  const { inId, cryptoKey } = await link.boxesFor(key);
  await new Promise((r) => setTimeout(r, 5));
  return link.writeBox(inId, cryptoKey, { awayDates: [], note: '', profile });
}

test('their email and mobile apply straight away; a new name waits as a suggestion', async () => {
  const sam = setUp();
  await staff.createLink(sam.id);
  const key = store.people()[0].staffLink.key;
  await staffSendsProfile(key, { name: 'Samuel Jones', email: 'sam@example.com', mobile: '0400 123 456' });
  await staff.syncStaff();
  const p = store.people()[0];
  assert.equal(p.email, 'sam@example.com');
  assert.equal(p.phone, '0400 123 456');
  assert.equal(p.name, 'Sam Jones', 'the name is not changed yet');
  assert.deepEqual(p.staffLink.profileSuggestion, { name: 'Samuel Jones' });
  assert.deepEqual(staff.takeSwapNews(), ['Sam updated their details']);
});

test('accepting a suggested name changes it; dismissing keeps it and does not come back', async () => {
  const sam = setUp();
  await staff.createLink(sam.id);
  const key = store.people()[0].staffLink.key;
  await staffSendsProfile(key, { name: 'Samuel Jones', email: '', mobile: '' });
  await staff.syncStaff();
  staff.resolveNameSuggestion(sam.id, false);
  assert.equal(store.people()[0].name, 'Sam Jones');
  assert.equal(store.people()[0].staffLink.profileSuggestion, null);
  await staffSendsProfile(key, { name: 'Samuel Jones', email: '', mobile: '' });   // same again
  await staff.syncStaff();
  assert.equal(store.people()[0].staffLink.profileSuggestion, null, 'a repeat send is ignored');

  await staffSendsProfile(key, { name: 'Sammy Jones', email: '', mobile: '' });
  await staff.syncStaff();
  staff.resolveNameSuggestion(sam.id, true);
  assert.equal(store.people()[0].name, 'Sammy Jones');
});

test('a badly formed email is ignored, and a repeat send does not undo the owner\'s edit', async () => {
  const sam = setUp();
  await staff.createLink(sam.id);
  const key = store.people()[0].staffLink.key;
  await staffSendsProfile(key, { name: 'Sam Jones', email: 'not-an-email', mobile: 'call me <b>' });
  await staff.syncStaff();
  assert.equal(store.people()[0].email, '');
  assert.equal(store.people()[0].phone, '');

  await staffSendsProfile(key, { name: 'Sam Jones', email: 'sam@example.com', mobile: '0400 111 222' });
  await staff.syncStaff();
  store.updatePerson(sam.id, { email: 'new@example.com' });   // the owner changes it later
  await staffSendsProfile(key, { name: 'Sam Jones', email: 'sam@example.com', mobile: '0400 111 222' });
  await staff.syncStaff();
  assert.equal(store.people()[0].email, 'new@example.com');
});

test('a Planning Center person keeps their name and email, but their mobile still updates', async () => {
  const sam = setUp();
  store.updatePerson(sam.id, { pcoId: 'pc1', email: 'pc@example.com' });
  await staff.createLink(sam.id);
  await staffSendsProfile(store.people()[0].staffLink.key, { name: 'Samuel', email: 'other@example.com', mobile: '0400 999 888' });
  await staff.syncStaff();
  const p = store.people()[0];
  assert.equal(p.email, 'pc@example.com');
  assert.equal(p.staffLink.profileSuggestion, null);
  assert.equal(p.phone, '0400 999 888');
});

test('their page gets only hints of their email and mobile, never the details themselves', async () => {
  const sam = setUp();
  store.updatePerson(sam.id, { email: 'sam@example.com', phone: '0400 000 042' });
  await staff.createLink(sam.id);
  const { outId, cryptoKey } = await link.boxesFor(store.people()[0].staffLink.key);
  const page = await link.readBox(outId, cryptoKey);
  assert.deepEqual(page.value.profile, { name: 'Sam Jones', emailHint: 's…@example.com', mobileHint: 'Ends in 42' });
  const whole = JSON.stringify(page.value);
  assert.ok(!whole.includes('sam@example.com') && !whole.includes('0400'), 'a forwarded link shows neither');
  assert.equal(page.value.pco, false);
});

test('their page is told how far the owner has read, so it can stop resending details', async () => {
  const sam = setUp();
  await staff.createLink(sam.id);
  const key = store.people()[0].staffLink.key;
  const { outId, cryptoKey } = await link.boxesFor(key);
  assert.equal((await link.readBox(outId, cryptoKey)).value.seenUpTo, null);
  const sentAt = await staffSendsProfile(key, { name: 'Sam Jones', email: '', mobile: '0411 111 111' });
  await staff.syncStaff();
  assert.equal(store.people()[0].phone, '0411 111 111');
  assert.equal((await link.readBox(outId, cryptoKey)).value.seenUpTo, sentAt);
});

test('masks show a little of an email or mobile, and nothing for a missing one', () => {
  assert.equal(link.maskEmail('mikey@live.com.au'), 'm…@live.com.au');
  assert.equal(link.maskEmail('not an email'), '');
  assert.equal(link.maskEmail(''), '');
  assert.equal(link.maskMobile('+61 400 123 456'), 'Ends in 56');
  assert.equal(link.maskMobile('7'), '');
  assert.equal(link.maskMobile(null), '');
});

const named = (n) => store.people().find((p) => p.name === n);

test('a new person is given a link automatically, with a key no one else has', async () => {
  const sam = setUp();
  await staff.createLink(sam.id);
  const ann = store.addPerson('Ann Lee');
  staff.autoLink(ann);
  await new Promise((r) => setTimeout(r, 50));   // the page is published in the background
  const key = named('Ann Lee').staffLink.key;
  assert.ok(key);
  assert.notEqual(key, named('Sam Jones').staffLink.key);
  staff.autoLink(named('Ann Lee'));              // already has one: unchanged
  assert.equal(named('Ann Lee').staffLink.key, key);
  const { outId, cryptoKey } = await link.boxesFor(key);
  assert.equal((await link.readBox(outId, cryptoKey)).value.name, 'Ann Lee');
});

test('a link key that is already taken is never reused', async () => {
  const sam = setUp();
  await staff.createLink(sam.id);
  const taken = named('Sam Jones').staffLink.key;
  // Make the next key come out identical to Sam's (once), as a freak collision would.
  const bytes = Uint8Array.from(Buffer.from(taken.replace(/-/g, '+').replace(/_/g, '/') + '=', 'base64'));
  const real = crypto.getRandomValues.bind(crypto);
  let forced = true;
  crypto.getRandomValues = (arr) => { if (forced && arr.length === 32) { forced = false; arr.set(bytes); return arr; } return real(arr); };
  try {
    const ann = store.addPerson('Ann Lee');
    await staff.createLink(ann.id);
  } finally { crypto.getRandomValues = real; }
  assert.equal(forced, false, 'the collision was really forced');
  assert.notEqual(named('Ann Lee').staffLink.key, taken);
});

test('switching off one person\'s link leaves everyone else\'s working', async () => {
  setUp();
  const bob = store.addPerson('Bob Green');
  const sam = store.people().find((p) => p.name === 'Sam Jones');
  await staff.createLink(sam.id);
  await staff.createLink(bob.id);
  const keyOf = (id) => store.people().find((p) => p.id === id).staffLink.key;
  // What deleting Sam does first, so their page stops showing old shifts.
  await staff.retireLinks([sam.id]);
  await assert.rejects(staffSends(keyOf(sam.id), ['2026-11-08']), link.LinkReplaced);
  await staffSends(keyOf(bob.id), ['2026-11-08']);
});

test('a send from a phone whose clock is behind the last send is still taken in', async () => {
  const sam = setUp();
  await staff.createLink(sam.id);
  const key = store.people()[0].staffLink.key;
  await staffSends(key, ['2026-11-08']);
  await staff.collect();

  // Their next send comes from a phone whose clock is wrong, so its stamp is years before the last one.
  const { encrypt } = await import('../js/sync.js');
  const { SYNC_URL } = await import('../js/config.js');
  const { inId, cryptoKey } = await link.boxesFor(key);
  await fetch(`${SYNC_URL}/box/${inId}`, {
    method: 'PUT', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ ...(await encrypt({ awayDates: ['2026-11-15'], note: '' }, cryptoKey)), updatedAt: '2020-01-01T00:00:00.000Z' }),
  });
  const changed = await staff.collect();
  assert.equal(changed.length, 1, 'the send is read, whatever its stamp says');
  assert.deepEqual(staff.staffDates(store.people()[0]), ['2026-11-15']);
  // The same send again changes nothing.
  assert.equal((await staff.collect()).length, 0);
});

test('taking in what several people sent saves once, not once for every change', async () => {
  const sam = setUp();
  const ann = store.addPerson('Ann Lee');
  const bob = store.addPerson('Bob Green');
  for (const p of [sam, ann, bob]) await staff.createLink(p.id);
  for (const p of store.people()) await staffSends(p.staffLink.key, ['2026-11-08'], 'see you then');

  let saves = 0;
  store.onSaved(() => { saves += 1; });
  try {
    const changed = await staff.collect();
    assert.equal(changed.length, 3);
    assert.equal(saves, 1);
  } finally {
    store.onSaved(null);
  }
  // And it really was written: a fresh load has everyone's date.
  store.load();
  for (const p of store.people()) assert.deepEqual(staff.staffDates(p), ['2026-11-08']);
});
