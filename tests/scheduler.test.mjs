/**
 * Unit tests for the deterministic scheduler.
 *
 * A direct port of the Python suite these guarantees were originally proven by:
 * fairness, availability, blackouts, clashes and honest reporting of what could
 * not be filled. Run with:  node --test tests/
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  buildRoster, dateRange, counts, weekdayOf, toDays, fromDays,
} from '../js/scheduler.js';

const ALL_DAYS = new Set([0, 1, 2, 3, 4, 5, 6]);
const WEEKDAYS = new Set([0, 1, 2, 3, 4]);

/** Build a test person, available every day unless told otherwise. */
function person(id, name, days = [0, 1, 2, 3, 4, 5, 6], extra = {}) {
  return { id, name, active: true, availableWeekdays: days, blackouts: [], maxShifts: null, ...extra };
}

/** Build a test shift. */
function shift(id, name, headcount = 1) {
  return { id, name, start: '', end: '', headcount };
}

/** Run the scheduler with sensible test defaults. */
function build(people, shifts, clashes, start, end, weekdays) {
  return buildRoster({ orgId: 1, name: 't', people, shifts, clashes, start, end, weekdays });
}

test('date helpers round-trip and index weekdays Monday-first', () => {
  assert.equal(fromDays(toDays('2026-06-01')), '2026-06-01');
  assert.equal(weekdayOf('2026-06-01'), 0);   // 1 Jun 2026 is a Monday
  assert.equal(weekdayOf('2026-06-07'), 6);   // Sunday
});

test('dateRange filters to the selected weekdays, in order', () => {
  const days = dateRange('2026-06-01', '2026-06-14', WEEKDAYS);
  assert.equal(days.length, 10);
  assert.ok(days.every((d) => weekdayOf(d) < 5));
  assert.deepEqual(days, [...days].sort());
});

test('dateRange tolerates swapped bounds', () => {
  assert.deepEqual(
    dateRange('2026-06-05', '2026-06-01', ALL_DAYS),
    dateRange('2026-06-01', '2026-06-05', ALL_DAYS)
  );
});

test('shifts are spread evenly across interchangeable staff', () => {
  const people = ['Alice', 'Bob', 'Carol', 'Dave'].map((n, i) => person(i + 1, n));
  const r = build(people, [shift(1, 'Day', 1)], [], '2026-06-01', '2026-06-08', ALL_DAYS);
  assert.deepEqual([...counts(r).values()].sort(), [2, 2, 2, 2]);
});

test('output is deterministic', () => {
  const make = () => {
    const people = ['Alice', 'Bob', 'Carol'].map((n, i) => person(i + 1, n));
    return build(people, [shift(1, 'Day', 2)], [], '2026-06-01', '2026-06-10', ALL_DAYS);
  };
  assert.deepEqual(make().assignments, make().assignments);
});

test('a per-person cap is never exceeded', () => {
  const people = [person(1, 'Alice', undefined, { maxShifts: 2 }), person(2, 'Bob')];
  const r = build(people, [shift(1, 'Day', 1)], [], '2026-06-01', '2026-06-10', ALL_DAYS);
  assert.ok((counts(r).get(1) || 0) <= 2);
});

test('weekday availability is honoured', () => {
  const weekendOnly = person(1, 'Alice', [5, 6]);
  const r = build([weekendOnly, person(2, 'Bob')], [shift(1, 'Day', 1)], [],
    '2026-06-01', '2026-06-14', ALL_DAYS);
  const hers = r.assignments.filter((a) => a.personId === 1).map((a) => a.date);
  assert.ok(hers.length > 0, 'Alice should still get her weekends');
  assert.ok(hers.every((d) => weekdayOf(d) >= 5));
});

test('blackout dates are honoured', () => {
  const alice = person(1, 'Alice');
  alice.blackouts = [{ start: '2026-06-03', end: '2026-06-05' }];
  const r = build([alice, person(2, 'Bob')], [shift(1, 'Day', 1)], [],
    '2026-06-01', '2026-06-10', ALL_DAYS);
  const blocked = new Set(['2026-06-03', '2026-06-04', '2026-06-05']);
  assert.equal(
    r.assignments.filter((a) => a.personId === 1 && blocked.has(a.date)).length, 0
  );
});

test('a clashing pair never share a shift', () => {
  const people = ['Alice', 'Bob', 'Carol', 'Dave'].map((n, i) => person(i + 1, n));
  const r = build(people, [shift(1, 'Day', 2)], [[1, 2]], '2026-06-01', '2026-06-14', ALL_DAYS);
  const crews = new Map();
  for (const a of r.assignments) {
    const k = `${a.date}|${a.shiftId}`;
    if (!crews.has(k)) crews.set(k, new Set());
    crews.get(k).add(a.personId);
  }
  for (const crew of crews.values()) {
    assert.ok(!(crew.has(1) && crew.has(2)), 'Alice and Bob were rostered together');
  }
});

test('nobody works two shifts on the same day', () => {
  const people = ['Alice', 'Bob', 'Carol'].map((n, i) => person(i + 1, n));
  const r = build(people, [shift(1, 'Early', 1), shift(2, 'Late', 1)], [],
    '2026-06-01', '2026-06-07', ALL_DAYS);
  const seen = new Set();
  for (const a of r.assignments) {
    const k = `${a.date}|${a.personId}`;
    assert.ok(!seen.has(k), 'someone was double-booked');
    seen.add(k);
  }
});

test('a shortfall is flagged, once per affected day', () => {
  const r = build([person(1, 'Alice')], [shift(1, 'Day', 3)], [],
    '2026-06-01', '2026-06-02', ALL_DAYS);
  assert.equal(r.notes.length, 2);
  assert.ok(r.notes[0].includes('only 1 of 3 filled'));
});

test('someone with no availability is reported, not silently dropped', () => {
  const ghost = person(1, 'Ghost', []);
  const r = build([ghost, person(2, 'Bob')], [shift(1, 'Day', 1)], [],
    '2026-06-01', '2026-06-05', ALL_DAYS);
  assert.ok(r.notes.some((n) => n.includes('Ghost was not rostered')));
});

test('empty inputs return a roster carrying a note instead of crashing', () => {
  const cases = [
    [[], [shift(1, 'Day', 1)], ALL_DAYS],
    [[person(1, 'Alice')], [], ALL_DAYS],
    [[person(1, 'Alice')], [shift(1, 'Day', 1)], new Set()],
  ];
  for (const [people, shifts, days] of cases) {
    const r = build(people, shifts, [], '2026-06-01', '2026-06-05', days);
    assert.equal(r.assignments.length, 0);
    assert.ok(r.notes.length > 0);
  }
});

test('an explicit date list rosters exactly those dates', () => {
  // The calendar picks arbitrary dates, including ones no weekday rule would
  // produce - a cafe skips one weekend and adds a Wednesday market.
  const people = ['Alice', 'Bob'].map((n, i) => person(i + 1, n));
  const dates = ['2026-06-06', '2026-06-07', '2026-06-20', '2026-06-24'];
  const r = buildRoster({
    orgId: 1, name: 't', people, shifts: [shift(1, 'Day', 1)], clashes: [], dates,
  });
  assert.deepEqual([...new Set(r.assignments.map((a) => a.date))].sort(), dates);
  assert.deepEqual(r.days, dates);
  assert.equal(r.startDate, '2026-06-06');
  assert.equal(r.endDate, '2026-06-24');
});

test('an explicit date list is de-duplicated and sorted', () => {
  const people = [person(1, 'Alice')];
  const r = buildRoster({
    orgId: 1, name: 't', people, shifts: [shift(1, 'Day', 1)], clashes: [],
    dates: ['2026-06-10', '2026-06-02', '2026-06-10'],
  });
  assert.deepEqual(r.days, ['2026-06-02', '2026-06-10']);
});

test('no dates picked is reported rather than crashing', () => {
  const r = buildRoster({
    orgId: 1, name: 't', people: [person(1, 'Alice')],
    shifts: [shift(1, 'Day', 1)], clashes: [], dates: [],
  });
  assert.equal(r.assignments.length, 0);
  assert.ok(r.notes.length > 0);
});

test('constraints still apply when dates come from the calendar', () => {
  // Alice is weekends-only; the picked list includes a Wednesday she can't do.
  const alice = person(1, 'Alice', [5, 6]);
  const bob = person(2, 'Bob');
  const r = buildRoster({
    orgId: 1, name: 't', people: [alice, bob], shifts: [shift(1, 'Day', 1)], clashes: [],
    dates: ['2026-06-06', '2026-06-10'],          // Sat, Wed
  });
  const aliceDates = r.assignments.filter((a) => a.personId === 1).map((a) => a.date);
  assert.ok(!aliceDates.includes('2026-06-10'), 'Alice cannot work the Wednesday');
});

test('a requested date puts that person ahead of the queue', () => {
  // Bob would normally get the first shift on name order; Alice asked for it.
  const alice = person(1, 'Alice');
  const bob = person(2, 'Bob');
  alice.requests = ['2026-06-02'];
  const r = buildRoster({
    orgId: 1, name: 't', people: [alice, bob], shifts: [shift(1, 'Day', 1)],
    clashes: [], dates: ['2026-06-01', '2026-06-02'],
  });
  const on2nd = r.assignments.find((a) => a.date === '2026-06-02');
  assert.equal(on2nd.personId, 1, 'Alice asked for the 2nd and should have it');
});

test('a requested date overrides the standing weekday pattern', () => {
  // Alice is weekdays-only but has asked for a Saturday one-off; the request is
  // the more deliberate signal, so she should get it rather than be skipped.
  const alice = person(1, 'Alice', [0, 1, 2, 3, 4]);
  const bob = person(2, 'Bob', [0, 1, 2, 3, 4]);
  alice.requests = ['2026-06-06'];                 // a Saturday
  const r = buildRoster({
    orgId: 1, name: 't', people: [alice, bob], shifts: [shift(1, 'Day', 1)],
    clashes: [], dates: ['2026-06-06'],
  });
  assert.equal(r.assignments[0].personId, 1, 'Alice asked for the Saturday');
  assert.ok(!r.notes.some((n) => n.includes('Alice asked for')), 'and it was granted');
});

test('a request never overrides a hard constraint', () => {
  // Asking for a day you are away on must not put you on it.
  const alice = person(1, 'Alice');
  alice.requests = ['2026-06-03'];
  alice.blackouts = [{ start: '2026-06-03', end: '2026-06-03' }];
  const r = buildRoster({
    orgId: 1, name: 't', people: [alice, person(2, 'Bob')],
    shifts: [shift(1, 'Day', 1)], clashes: [], dates: ['2026-06-03'],
  });
  assert.equal(r.assignments[0].personId, 2, 'Bob should cover it, not Alice');
  assert.ok(r.notes.some((n) => n.includes('Alice asked for')));
});

test('an unmet request is reported', () => {
  // One slot, two people both asking for it: one of them must miss out, and
  // the roster has to say so rather than let it pass unnoticed.
  const alice = person(1, 'Alice');
  const bob = person(2, 'Bob');
  alice.requests = ['2026-06-06'];
  bob.requests = ['2026-06-06'];
  const r = buildRoster({
    orgId: 1, name: 't', people: [alice, bob], shifts: [shift(1, 'Day', 1)],
    clashes: [], dates: ['2026-06-06'],
  });
  const misses = r.notes.filter((n) => n.includes('asked for'));
  assert.equal(misses.length, 1, 'exactly one of them missed out');
});

test('a request outside the rostered dates is not reported as missed', () => {
  const alice = person(1, 'Alice');
  alice.requests = ['2026-07-04'];          // not in the roster at all
  const r = buildRoster({
    orgId: 1, name: 't', people: [alice], shifts: [shift(1, 'Day', 1)],
    clashes: [], dates: ['2026-06-06'],
  });
  assert.ok(!r.notes.some((n) => n.includes('asked for')));
});


test('a max-shifts cap holds when the person has a locked place later in the roster', () => {
  // Aaron can do one shift, and has taken the last date (say, through shifts offered to staff).
  const aaron = person(1, 'Aaron', undefined, { maxShifts: 1 });
  const people = [aaron, person(2, 'Zoe')];
  const dates = ['2026-11-07', '2026-11-14', '2026-11-21'];
  const r = buildRoster({
    orgId: 1, name: 't', people, shifts: [shift(1, 'Cafe')], clashes: [], dates,
    locked: [{ date: '2026-11-21', shiftId: 1, personId: 1 }],
  });
  assert.deepEqual(r.assignments.filter((a) => a.personId === 1).map((a) => a.date), ['2026-11-21']);
});

test('a rebuild with nobody active keeps the locked places', () => {
  const r = buildRoster({
    orgId: 1, name: 't', people: [person(1, 'Aaron', undefined, { active: false })], shifts: [shift(1, 'Cafe')], clashes: [],
    dates: ['2026-11-07'], locked: [{ date: '2026-11-07', shiftId: 1, personId: 1 }],
  });
  assert.deepEqual(r.assignments.map((a) => [a.date, a.personId, a.locked]), [['2026-11-07', 1, true]]);
});
