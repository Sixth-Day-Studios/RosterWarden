/**
 * Open shifts: shifts sent out before building for staff to take, first come,
 * first served. The pure rules (slots, names, one a day, locking in), the
 * worker's claims (first holder wins, only they can let go), and the whole
 * trip from sending out to a built roster with the taken shifts locked in.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import worker, { BOX_SQL, CLAIM_SQL } from '../worker/src/index.js';
import { slotsFor, slotsForPerson, shortName, settleClaims, lockedFrom, answered } from '../js/open-shifts.js';

// ── a browser-ish environment: localStorage, and fetch routed into the worker ──
const mem = new Map();
globalThis.localStorage = {
  getItem: (k) => (mem.has(k) ? mem.get(k) : null),
  setItem: (k, v) => mem.set(k, String(v)),
  removeItem: (k) => mem.delete(k),
};
const boxes = new Map();
const claims = new Map();
/** A stand-in D1 answering exactly the worker's mailbox and claim statements. */
const DB = {
  // What D1's batch() gives: each statement's rows, in order.
  batch: async (statements) => Promise.all(statements.map(async (s) => ({ results: [await s.first()].filter(Boolean) }))),
  prepare(sql) {
    return {
      bind(...a) {
        return {
          first: async () => (sql === CLAIM_SQL.read ? claims.get(a[0]) : boxes.get(a[0])) || null,
          run: async () => {
            if (sql === BOX_SQL.write && !boxes.get(a[0])?.revoked) {
              boxes.set(a[0], { ciphertext: a[1], iv: a[2], updated_at: a[3], revoked: 0 });
            } else if (sql === BOX_SQL.revoke) {
              boxes.set(a[0], { ciphertext: '', iv: '', updated_at: a[1], revoked: 1 });
            } else if (sql === CLAIM_SQL.take) {
              const row = claims.get(a[0]);
              if (!row || row.by_hash === a[3]) claims.set(a[0], { ciphertext: a[1], iv: a[2], by_hash: a[3] });
            } else if (sql === CLAIM_SQL.release) {
              if (claims.get(a[0])?.by_hash === a[1]) claims.delete(a[0]);
            } else {
              throw new Error(`unexpected SQL: ${sql}`);
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
const { buildRoster } = await import('../js/scheduler.js');

// ── the pure rules ──

const CAFE = { id: 1, name: 'Cafe', start: '08:00', end: '12:00', headcount: 2, roles: [] };
const BAND = { id: 2, name: 'Band', headcount: 0, roles: [{ roleId: 9, count: 1 }, { roleId: 8, count: 2 }] };
const OPEN = { id: 'o1', key: 'k', days: ['2026-11-08', '2026-11-07'], dayShifts: { '2026-11-07': [CAFE], '2026-11-08': [CAFE, BAND] }, claims: {} };

test('every place to fill is its own slot, by date, shift and role', () => {
  assert.deepEqual(slotsFor(OPEN).map((s) => s.ref), [
    '2026-11-07:1::0', '2026-11-07:1::1',
    '2026-11-08:1::0', '2026-11-08:1::1', '2026-11-08:2:9:0', '2026-11-08:2:8:0', '2026-11-08:2:8:1',
  ]);
  // A person only sees the role places they can do (role 9 is ticked-only).
  const roles = new Map([[9, { id: 9, anyone: false }], [8, { id: 8, anyone: true }]]);
  const refs = slotsForPerson(OPEN, { roleIds: [] }, roles).map((s) => s.ref);
  assert.ok(!refs.includes('2026-11-08:2:9:0') && refs.includes('2026-11-08:2:8:1'));
});

test('a taken shift shows a first name and last initial', () => {
  assert.equal(shortName('Sam Taylor'), 'Sam T.');
  assert.equal(shortName('  mary anne smith '), 'mary S.');
  assert.equal(shortName('Cher'), 'Cher');
  assert.equal(shortName(''), 'Someone');
});

test('two people who would look the same get more of their last name', () => {
  assert.equal(shortName('Sam Taylor', ['Sam Turner', 'Ann Taylor']), 'Sam Ta.');
  assert.equal(shortName('Sam Turner', ['Sam Taylor']), 'Sam Tu.');
  assert.equal(shortName('Sam Tay', ['Sam Taylor']), 'Sam Tay', 'a whole short last name has no full stop');
  assert.equal(shortName('Sam Taylor', ['Sam']), 'Sam T.', 'a single name is no rival');
});

test('a person keeps only the first shift they took on any one day', () => {
  const got = settleClaims([
    { ref: '2026-11-08:2:8:0', personId: 5, name: 'Sam T.', at: '2026-11-01T10:00:02Z' },
    { ref: '2026-11-08:1::0', personId: 5, name: 'Sam T.', at: '2026-11-01T10:00:01Z' },
    { ref: '2026-11-07:1::0', personId: 5, name: 'Sam T.', at: '2026-11-01T10:00:03Z' },
    { ref: '2026-11-08:1::1', personId: 6, name: 'Ann B.', at: '2026-11-01T10:00:04Z' },
  ]);
  assert.deepEqual(Object.keys(got).sort(), ['2026-11-07:1::0', '2026-11-08:1::0', '2026-11-08:1::1']);
});

test('taken shifts become locked places, dropping any whose shift has gone or shrunk', () => {
  const open = {
    ...OPEN,
    claims: {
      '2026-11-07:1::1': { personId: 5 }, '2026-11-08:1::0': { personId: 6 },
      '2026-11-08:2:9:0': { personId: 7 }, '2026-11-08:1::1': { personId: 8 },
    },
  };
  // Since sending, the Cafe on the 7th went down to one person and the band was dropped on the 8th.
  const now = { '2026-11-07': [{ ...CAFE, headcount: 1 }], '2026-11-08': [CAFE] };
  const locked = lockedFrom(open, ['2026-11-07', '2026-11-08'], (d) => now[d], (id) => id !== 8);
  assert.deepEqual(locked, [{ date: '2026-11-08', shiftId: 1, personId: 6, locked: true }]);
});

test('anyone who took a shift or answered from their page counts as answered', () => {
  const open = { ...OPEN, claims: { '2026-11-07:1::0': { personId: 1 } } };
  const people = [{ id: 1 }, { id: 2, staffLink: { openReplied: 'o1' } }, { id: 3, staffLink: { openReplied: 'old' } }];
  const { answered: yes, waiting } = answered(open, people);
  assert.deepEqual(yes.map((p) => p.id), [1, 2]);
  assert.deepEqual(waiting.map((p) => p.id), [3]);
});

// ── the worker's claims ──

/** Call the worker. */
const call = (method, path, body) => worker.fetch(new Request(`https://w.test${path}`, {
  method, headers: { 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined,
}), { DB });
const ID = 'c'.repeat(64);
const SAM = '1'.repeat(64);
const ANN = '2'.repeat(64);

test('the first to take a shift gets it, and only they can let it go', async () => {
  claims.clear();
  assert.equal((await call('PUT', `/claim/${ID}`, { ciphertext: 'sam', iv: 'i', token: SAM })).status, 200);
  assert.equal((await call('PUT', `/claim/${ID}`, { ciphertext: 'ann', iv: 'i', token: ANN })).status, 409);
  await call('DELETE', `/claim/${ID}`, { token: ANN });
  const held = await (await call('POST', '/claims', { ids: [ID] })).json();
  assert.equal(held[ID].ciphertext, 'sam', 'still Sam\'s');
  assert.notEqual(held[ID].by, SAM, 'the token itself is never shown');

  await call('DELETE', `/claim/${ID}`, { token: SAM });
  assert.deepEqual(await (await call('POST', '/claims', { ids: [ID] })).json(), {});
  assert.equal((await call('PUT', `/claim/${ID}`, { ciphertext: 'ann', iv: 'i', token: ANN })).status, 200, 'free again');
  assert.equal((await call('PUT', `/claim/${ID}`, { ciphertext: 'x', iv: 'i', token: 'nope' })).status, 400);
});

// ── end to end ──

/** One workplace with a two-person Saturday cafe shift, and three staff with links. */
async function setUp() {
  mem.clear(); boxes.clear(); claims.clear();
  store.reset(); store.load(); store.addOrg('Cafe');
  store.addShift({ name: 'Cafe', start: '08:00', end: '12:00', headcount: 2 });
  const people = ['Sam Taylor', 'Ann Brown', 'Joe Smith'].map((n) => store.addPerson(n));
  for (const p of people) await staff.createLink(p.id);
  return people.map((p) => store.people().find((x) => x.id === p.id));
}

/** What a person's page shows for the open set. */
async function pageOf(person) {
  const { outId, cryptoKey } = await link.boxesFor(person.staffLink.key);
  return (await link.readBox(outId, cryptoKey)).value.open;
}

/** What a person's page does when they tap "I'll take it". */
async function take(person, ref) {
  const open = await pageOf(person);
  const { token } = await link.claimer(person.staffLink.key);
  return link.takeClaim(await link.claimId(open.key, ref), token, await link.openCryptoKey(open.key),
    { name: open.me, at: new Date().toISOString() });
}

test('sent out, taken first come first served, then built with the taken shifts locked in', async () => {
  const [sam, ann, joe] = await setUp();
  const days = ['2026-11-07', '2026-11-14'];
  const dayShifts = Object.fromEntries(days.map((d) => [d, store.shifts()]));
  await staff.sendOpenShifts(days, dayShifts);

  const page = await pageOf(sam);
  assert.equal(page.me, 'Sam T.');
  assert.equal(page.slots.length, 4);
  assert.ok(![...boxes.values(), ...claims.values()].some((r) => r.ciphertext.includes('Sam')), 'names never reach the server');

  const first = page.slots[0].ref;
  assert.equal(await take(sam, first), true);
  assert.equal(await take(ann, first), false, 'Sam got there first');
  assert.equal(await take(ann, page.slots[2].ref), true);

  // Joe can't do the 14th: an away date from his link, like any other.
  const { inId, cryptoKey } = await link.boxesFor(joe.staffLink.key);
  await link.writeBox(inId, cryptoKey, { awayDates: ['2026-11-14'], openReplied: page.id });

  await staff.syncStaff();
  const open = staff.openShifts();
  assert.deepEqual(Object.values(open.claims).map((c) => c.personId).sort(), [sam.id, ann.id].sort());
  const { waiting } = answered(open, staff.openAudience(open.orgId));
  assert.deepEqual(waiting, [], 'Sam and Ann took shifts, Joe turned a day down');

  const locked = staff.openLocked(days, () => store.shifts());
  const roster = buildRoster({ orgId: open.orgId, name: 'Nov', people: store.people(), shifts: store.shifts(), clashes: [], dates: days, locked });
  const on = (d) => roster.assignments.filter((a) => a.date === d);
  assert.ok(on('2026-11-07').some((a) => a.personId === sam.id && a.locked));
  assert.ok(on('2026-11-14').some((a) => a.personId === ann.id && a.locked));
  assert.ok(!on('2026-11-14').some((a) => a.personId === joe.id), 'Joe is away on the 14th');

  // Stopping takes the set off everyone's page.
  staff.stopOpenShifts(open.id);
  await staff.publish();
  assert.equal(await pageOf(sam), null);
});
