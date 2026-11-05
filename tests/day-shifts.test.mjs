/**
 * Rosters with their own shifts per date (`roster.dayShifts`).
 *
 *   node --test tests/day-shifts.test.mjs
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  buildRoster, auditRoster, shiftsOn, shiftOn, rosterShiftList, runsOn, copyDayShifts, carryDayShifts,
  shiftsSnapshot,
} from '../js/scheduler.js';
import { rosterLines, formatMessage, hoursByPerson, messageFor } from '../js/export.js';

const D1 = '2026-06-01';
const D2 = '2026-06-02';
const D3 = '2026-06-03';

/** Build a test person, available every day. */
function person(id, name) {
  return { id, name, active: true, availableWeekdays: [0, 1, 2, 3, 4, 5, 6], blackouts: [], maxShifts: null };
}
const people = [1, 2, 3, 4, 5].map((i) => person(i, `P${i}`));

const usual = [{ id: 10, name: 'Cafe', start: '08:00', end: '12:00', headcount: 1 }];
const oneOff = { id: 900, name: 'Gala', start: '18:00', end: '22:00', headcount: 3, note: 'Black tie' };

/** Build with the usual shifts plus the given per-day lists. */
function build(dayShifts, extra = {}) {
  return buildRoster({
    orgId: 1, name: 't', people, shifts: usual, clashes: [], dates: [D1, D2], dayShifts, ...extra,
  });
}

test('shiftsOn / rosterShiftList fall back to the usual shifts', () => {
  assert.equal(shiftsOn({}, D1, usual), usual);
  assert.equal(shiftsOn({ dayShifts: { [D2]: [] } }, D1, usual), usual);
  assert.deepEqual(shiftsOn({ dayShifts: { [D2]: [] } }, D2, usual), []);
  assert.equal(rosterShiftList({}, usual), usual);
  assert.equal(shiftOn({ dayShifts: { [D1]: [oneOff] } }, D1, 10, usual).name, 'Cafe');
});

test('rosterShiftList is the distinct shifts across the days, first seen first', () => {
  const r = { days: [D1, D2], dayShifts: { [D2]: [usual[0], oneOff], [D1]: [usual[0]] } };
  assert.deepEqual(rosterShiftList(r, usual).map((s) => s.id), [10, 900]);
});

test('rosterShiftList includes the usual shifts of a day with no list of its own', () => {
  const r = { days: [D1, D2], dayShifts: { [D1]: [oneOff] } };
  assert.deepEqual(rosterShiftList(r, usual).map((s) => s.id), [900, 10]);
});

test('buildRoster uses each day\'s own shifts and keeps only the roster\'s days', () => {
  const r = build({ [D1]: usual, [D2]: [oneOff], [D3]: [oneOff] });
  assert.deepEqual(Object.keys(r.dayShifts).sort(), [D1, D2]);
  assert.deepEqual(r.assignments.filter((a) => a.date === D1).map((a) => a.shiftId), [10]);
  assert.deepEqual(r.assignments.filter((a) => a.date === D2).map((a) => a.shiftId), [900, 900, 900]);
});

test('a roster built without dayShifts keeps its own copy of the usual shifts', () => {
  const r = build(undefined);
  assert.deepEqual(r.dayShifts[D1], [{ id: 10, name: 'Cafe', start: '08:00', end: '12:00', headcount: 1, roles: [] }]);
  assert.notEqual(r.dayShifts[D1], usual[0]);
});

test('a usual shift with days set only runs on those weekdays', () => {
  // 2026-06-01 is a Monday (0), 2026-06-02 a Tuesday (1).
  const mondays = [{ ...usual[0], days: [0] }];
  assert.equal(runsOn(mondays[0], D1), true);
  assert.equal(runsOn(mondays[0], D2), false);
  assert.equal(runsOn(usual[0], D2), true);
  const r = buildRoster({ orgId: 1, name: 't', people, shifts: mondays, clashes: [], dates: [D1, D2] });
  assert.deepEqual(r.dayShifts[D2], []);
  assert.deepEqual(r.assignments.map((a) => a.date), [D1]);
});

test('no usual shift running on any date picked says so', () => {
  const r = buildRoster({ orgId: 1, name: 't', people, shifts: [{ ...usual[0], days: [5] }], clashes: [], dates: [D1, D2] });
  assert.deepEqual(r.notes, ['None of your shifts run on the dates picked.']);
});

test('a day with an empty list gets nothing and no understaffed note', () => {
  const r = build({ [D1]: usual, [D2]: [] });
  assert.equal(r.assignments.filter((a) => a.date === D2).length, 0);
  assert.deepEqual(r.notes.filter((n) => n.includes('02 Jun')), []);
});

test('every day empty reports no shifts set up', () => {
  const r = build({ [D1]: [], [D2]: [] });
  assert.deepEqual(r.notes, ['None of your shifts run on the dates picked.']);
  assert.equal(r.assignments.length, 0);
});

test('auditRoster flags a short one-off shift by its own name and headcount', () => {
  const r = build({ [D1]: usual, [D2]: [oneOff] });
  const firstGala = r.assignments.find((a) => a.shiftId === 900);
  const short = { ...r, assignments: r.assignments.filter((a) => a.shiftId !== 900 || a === firstGala) };
  const notes = auditRoster(short, people, usual);
  assert.ok(notes.some((n) => n.includes('Gala: only 1 of 3 filled.')));
});

test('rosterLines and formatMessage show a one-off on its day only', () => {
  const r = build({ [D1]: usual, [D2]: [oneOff] });
  const lines = rosterLines(r, people, usual);
  assert.deepEqual(lines[0].shifts.map((s) => s.shift.name), ['Cafe']);
  assert.deepEqual(lines[1].shifts.map((s) => s.shift.name), ['Gala']);
  const text = formatMessage(r, people, usual);
  assert.ok(text.includes('Gala 18:00–22:00'));
  assert.equal(text.split('Gala').length, 2);
});

test('hours and messages use the shift as it runs that day', () => {
  const longer = { ...usual[0], end: '14:00' };
  const r = { name: 'R', dayShifts: { [D2]: [longer] }, assignments: [
    { date: D1, shiftId: 10, personId: 1 }, { date: D2, shiftId: 10, personId: 1 },
  ] };
  assert.equal(hoursByPerson(r, usual).get(1), 4 + 6);
  assert.ok(messageFor(r, people[0], usual).includes('8:00–14:00'));
});

test('locked places on a one-off shift survive a rebuild', () => {
  const dayShifts = { [D1]: usual, [D2]: [oneOff] };
  const locked = [{ date: D2, shiftId: 900, personId: 5 }];
  const r = build(dayShifts, { locked });
  const kept = r.assignments.filter((a) => a.shiftId === 900);
  assert.equal(kept.length, 3);
  assert.ok(kept.some((a) => a.personId === 5 && a.locked));
});

test('copyDayShifts fills missing dates with unfiltered deep copies and keeps existing lists', () => {
  const mondays = [{ ...usual[0], days: [0], roles: [{ roleId: 7, count: 1 }] }];
  const kept = [oneOff];
  const roster = { days: [D1, D2], dayShifts: { [D1]: kept }, assignments: [] };
  const out = copyDayShifts(roster, mondays);
  assert.equal(out[D1], kept);
  // Tuesday gets the Monday-only shift too, as an older roster had every shift every day.
  assert.deepEqual(out[D2], [{ id: 10, name: 'Cafe', start: '08:00', end: '12:00', headcount: 1, roles: [{ roleId: 7, count: 1 }] }]);
  out[D2][0].roles[0].count = 5;
  assert.equal(mondays[0].roles[0].count, 1);
  // A roster with no lists at all gets one per date.
  assert.deepEqual(Object.keys(copyDayShifts({ days: [D1, D2], assignments: [] }, usual)), [D1, D2]);
});

test('formatMessage shows a shift note after its label', () => {
  const r = build({ [D1]: usual, [D2]: [oneOff] });
  assert.ok(formatMessage(r, people, usual).includes('Gala 18:00–22:00 (Black tie)'));
});

test('auditRoster flags the gap after a headcount is raised', () => {
  const r = build({ [D1]: usual, [D2]: [oneOff] });
  assert.deepEqual(auditRoster(r, people, usual).filter((n) => n.includes('Gala')), []);
  const raised = { ...r, dayShifts: { ...r.dayShifts, [D2]: [{ ...oneOff, headcount: 5 }] } };
  assert.ok(auditRoster(raised, people, usual).some((n) => n.includes('Gala: only 3 of 5 filled.')));
});

test('carryDayShifts takes the list from the same weekday a whole number of weeks back', () => {
  // Mon 1 Jun and Tue 2 Jun planned; Mon 1 Jun runs a one-off.
  const plain = { ...usual[0], roles: [] };   // as a built roster keeps the usual shift
  const source = { days: [D1, D2], dayShifts: { [D1]: [plain, oneOff], [D2]: [plain] } };
  const next = ['2026-06-08', '2026-06-09', '2026-06-15'];
  const carried = carryDayShifts(source, next, usual);
  // The 9th matches the usual shifts, so only the Mondays are carried (the 15th from the 1st).
  assert.deepEqual(Object.keys(carried), ['2026-06-08', '2026-06-15']);
  assert.deepEqual(carried['2026-06-08'].map((s) => s.id), [10, 900]);
  assert.deepEqual(carried['2026-06-15'].map((s) => s.id), [10, 900]);
  // A deep copy: changing it leaves the source alone.
  carried['2026-06-08'][1].name = 'Changed';
  assert.equal(source.dayShifts[D1][1].name, 'Gala');
});

test('carryDayShifts carries a day with no shifts, and nothing from a roster without day lists', () => {
  const source = { days: [D1], dayShifts: { [D1]: [] } };
  assert.deepEqual(carryDayShifts(source, ['2026-06-08'], usual), { '2026-06-08': [] });
  assert.deepEqual(carryDayShifts({ days: [D1] }, ['2026-06-08'], usual), {});
  assert.deepEqual(carryDayShifts(source, ['2026-06-09'], usual), {});   // no Tuesday in the source
});

test('a shift changed on the Team tab reaches the next roster; a day changed by hand still carries', () => {
  // Built when Cafe ran 08:00-12:00. Monday was then changed by hand to start at 07:00; Tuesday was left alone.
  const then = shiftsSnapshot(usual);
  const built = buildRoster({ orgId: 1, name: 't', people, shifts: usual, clashes: [], dates: [D1, D2] });
  const source = {
    ...built, usualShifts: then,
    dayShifts: { ...built.dayShifts, [D1]: [{ ...built.dayShifts[D1][0], start: '07:00' }] },
  };
  // Since then, on the Team tab: Cafe starts at 09:00, and there is a Lunch shift too.
  const now = [{ ...usual[0], start: '09:00' }, { id: 11, name: 'Lunch', start: '12:00', end: '15:00', headcount: 2 }];
  const carried = carryDayShifts(source, ['2026-06-08', '2026-06-09'], now);
  // Tuesday was just the usual shifts of its time, so it gets today's (nothing carried); Monday keeps its 07:00.
  assert.deepEqual(Object.keys(carried), ['2026-06-08']);
  assert.equal(carried['2026-06-08'][0].start, '07:00');
});

test('carryDayShifts leaves events behind: they are one-offs', () => {
  const event = { ...oneOff, event: true };
  const changedLunch = { ...usual[0], start: '09:00' };
  const source = { days: [D1], dayShifts: { [D1]: [changedLunch, event] } };
  const next = '2026-06-08';   // the Monday a week on
  assert.deepEqual(carryDayShifts(source, [next], usual), { [next]: [changedLunch] });
  // Only an event that day: nothing differs from the usual shifts once it is left behind.
  const onlyEvent = { days: [D1], dayShifts: { [D1]: [{ ...usual[0], roles: [] }, event] } };
  assert.deepEqual(carryDayShifts(onlyEvent, [next], usual), {});
});
