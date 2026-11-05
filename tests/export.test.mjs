/**
 * Roster export formats: message, per-person, CSV and calendar.
 *
 *   node --test tests/export.test.mjs
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  formatMessage, formatPerPerson, toCSV, toICS, shiftTimes, fileBase, rosterDays,
} from '../js/export.js';

const people = [
  { id: 1, name: 'Sarah' }, { id: 2, name: 'Tom' }, { id: 3, name: 'Rachel' },
];
const shifts = [
  { id: 10, name: 'Cafe', start: '08:00', end: '12:00', headcount: 2 },
  { id: 11, name: 'Setup', start: '', end: '', headcount: 1 },
];
const roster = {
  id: 99,
  name: 'Roster 11 Oct 2026',
  days: ['2026-10-18', '2026-10-11'],
  assignments: [
    { date: '2026-10-11', shiftId: 10, personId: 1 },
    { date: '2026-10-11', shiftId: 10, personId: 2 },
    { date: '2026-10-11', shiftId: 11, personId: 3 },
    { date: '2026-10-18', shiftId: 10, personId: 3 },   // one short; Setup unfilled
  ],
  notes: [],
};

test('rosterDays keeps recorded days in order, including empty ones', () => {
  assert.deepEqual(rosterDays(roster), ['2026-10-11', '2026-10-18']);
});

test('shiftTimes drops leading zeros and is blank without times', () => {
  assert.equal(shiftTimes(shifts[0]), '8:00–12:00');
  assert.equal(shiftTimes(shifts[1]), '');
});

test('the message groups by day and calls out gaps', () => {
  assert.equal(formatMessage(roster, people, shifts), [
    'Roster 11 Oct 2026 (11 Oct – 18 Oct 2026)',
    '',
    'Sun 11 Oct',
    '• Cafe 8:00–12:00: Sarah, Tom',
    '• Setup: Rachel',
    '',
    'Sun 18 Oct',
    '• Cafe 8:00–12:00: Rachel (needs 1 more)',
    '• Setup: nobody yet',
  ].join('\n'));
});

test('per person lists each day, naming the shift when there are several', () => {
  assert.equal(formatPerPerson(roster, people, shifts), [
    "Roster 11 Oct 2026: who's on when",
    '',
    'Rachel: Sun 11 Oct (Setup), Sun 18 Oct (Cafe)',
    'Sarah: Sun 11 Oct (Cafe)',
    'Tom: Sun 11 Oct (Cafe)',
  ].join('\n'));
});

test('per person leaves the shift name out when there is only one', () => {
  const one = { ...roster, assignments: roster.assignments.filter((a) => a.shiftId === 10) };
  assert.match(formatPerPerson(one, people, shifts), /^Rachel: Sun 18 Oct$/m);
});

test('CSV has a row per person, a row per unfilled place, and quotes when needed', () => {
  const tricky = [...people, { id: 4, name: 'Lee, "Jr"' }];
  const r = { ...roster, assignments: [...roster.assignments, { date: '2026-10-18', shiftId: 11, personId: 4 }] };
  const csv = toCSV(r, tricky, shifts);
  assert.ok(csv.startsWith('﻿'));
  assert.deepEqual(csv.slice(1).trim().split('\r\n'), [
    'Date,Day,Shift,Start,End,Person',
    '2026-10-11,Sun,Cafe,08:00,12:00,Sarah',
    '2026-10-11,Sun,Cafe,08:00,12:00,Tom',
    '2026-10-11,Sun,Setup,,,Rachel',
    '2026-10-18,Sun,Cafe,08:00,12:00,Rachel',
    '2026-10-18,Sun,Cafe,08:00,12:00,(unfilled)',
    '2026-10-18,Sun,Setup,,,"Lee, ""Jr"""',
  ]);
});

test('calendar: timed and all-day events, escaping, no event for an empty shift', () => {
  const ics = toICS(roster, people, shifts, new Date('2026-10-07T01:02:03Z'));
  assert.ok(ics.includes('\r\n'));
  const events = ics.split('BEGIN:VEVENT').slice(1);
  assert.equal(events.length, 3);   // 11th Cafe, 11th Setup, 18th Cafe (18th Setup is empty)
  assert.match(events[0], /DTSTART:20261011T080000\r\nDTEND:20261011T120000/);
  assert.match(events[0], /SUMMARY:Cafe: Sarah\\, Tom/);
  assert.match(events[0], /DTSTAMP:20261007T010203Z/);
  assert.match(events[1], /DTSTART;VALUE=DATE:20261011\r\nDTEND;VALUE=DATE:20261012/);
  assert.match(ics, /^BEGIN:VCALENDAR\r\nVERSION:2\.0/);
  assert.match(ics, /END:VCALENDAR\r\n$/);
});

test('calendar: a shift ending after midnight ends the next day', () => {
  const night = [{ id: 10, name: 'Night', start: '22:00', end: '02:00', headcount: 1 }];
  const r = { ...roster, days: ['2026-10-31'], assignments: [{ date: '2026-10-31', shiftId: 10, personId: 1 }] };
  assert.match(toICS(r, people, night), /DTSTART:20261031T220000\r\nDTEND:20261101T020000/);
});

test('fileBase makes a safe file name', () => {
  assert.equal(fileBase({ name: 'Christmas: 24/25 Dec!' }), 'Christmas-24-25-Dec');
  assert.equal(fileBase({ name: '' }), 'roster');
});

// ------------------------------------------------------------- roles --
const roles = [{ id: 1, name: 'Lead singer' }, { id: 2, name: 'Drums' }];
const band = [{ id: 20, name: 'Service', start: '09:00', end: '11:00', headcount: 3,
  roles: [{ roleId: 1, count: 1 }, { roleId: 2, count: 2 }] }];
const bandRoster = {
  id: 100, name: 'Band', days: ['2026-10-11'], notes: [],
  assignments: [
    { date: '2026-10-11', shiftId: 20, personId: 1, roleId: 1 },
    { date: '2026-10-11', shiftId: 20, personId: 2, roleId: 2 },
  ],
};

test('a message lists a line per role and says what is short', () => {
  const text = formatMessage(bandRoster, people, band, roles);
  assert.ok(text.includes('   Lead singer: Sarah'), text);
  assert.ok(text.includes('   Drums: Tom (needs 1 more)'), text);
});

test('the spreadsheet gets a Role column only when roles are in use', () => {
  const withRoles = toCSV(bandRoster, people, band, roles);
  assert.ok(withRoles.split('\r\n')[0].endsWith(',Role'));
  assert.ok(withRoles.includes('Sarah,Lead singer'));
  assert.ok(withRoles.includes('(unfilled),Drums'));
  assert.ok(!toCSV(roster, people, shifts).includes('Role'));
});

test("each person's line says their role, and the calendar names it", () => {
  assert.ok(formatPerPerson(bandRoster, people, band, roles).includes('Sarah'));
  assert.ok(formatPerPerson(bandRoster, people, band, roles).includes('Lead singer'));
  assert.ok(toICS(bandRoster, people, band, new Date(0), roles).includes('Sarah (Lead singer)'));
});

// ------------------------------------------------- hours and per-person messages --
import { shiftHours, hoursByPerson, messageFor } from '../js/export.js';

test('a shift\'s hours come from its times, and run past midnight when it ends before it starts', () => {
  assert.equal(shiftHours({ start: '08:00', end: '12:30' }), 4.5);
  assert.equal(shiftHours({ start: '22:00', end: '02:00' }), 4);
  assert.equal(shiftHours({ start: '', end: '' }), 0);
});

test('hours add up per person across shifts', () => {
  const hours = hoursByPerson(roster, shifts);
  assert.equal(hours.get(1), 4, 'Sarah did one 08:00-12:00 Cafe');
  assert.equal(hours.get(3), 4, 'Rachel did Cafe on the 18th (4h) and Setup (no times, 0h)');
});

test('a message for one person lists only their own dates', () => {
  const text = messageFor(roster, people[2], shifts);
  assert.ok(text.startsWith('Hi Rachel, you\'re on the roster (Roster 11 Oct 2026):'), text);
  assert.ok(text.includes('Cafe 8:00–12:00'), text);
  assert.ok(text.includes('Setup'), text);
  assert.ok(!text.includes('Sarah'));
  assert.equal(messageFor(roster, { id: 99, name: 'Nobody' }, shifts), null);
});

test('toCSV writes a row per date and shift, with a Note, when the days differ', () => {
  const lunch = { id: 10, name: 'Lunch', start: '11:00', end: '15:00', headcount: 2 };
  const gala = { id: 900, name: 'Gala', start: '18:00', end: '22:00', headcount: 1, note: 'Black tie, formal' };
  const mixed = {
    id: 1, name: 'Mixed', days: ['2026-10-11', '2026-10-12'], notes: [],
    dayShifts: { '2026-10-11': [lunch], '2026-10-12': [lunch, gala] },
    assignments: [
      { date: '2026-10-11', shiftId: 10, personId: 1 },
      { date: '2026-10-11', shiftId: 10, personId: 2 },
      { date: '2026-10-12', shiftId: 900, personId: 3 },
    ],
  };
  const lines = toCSV(mixed, people, []).replace('\uFEFF', '').trim().split('\r\n');
  assert.deepEqual(lines, [
    'Date,Day,Shift,Start,End,People,Note',
    '2026-10-11,Sun,Lunch,11:00,15:00,"Sarah, Tom",',
    '2026-10-12,Mon,Lunch,11:00,15:00,,',
    '2026-10-12,Mon,Gala,18:00,22:00,Rachel,"Black tie, formal"',
  ]);
});

test('toCSV keeps the person-per-row layout when every day runs the same shifts', () => {
  const same = { ...roster, dayShifts: { '2026-10-11': shifts, '2026-10-18': shifts } };
  assert.equal(toCSV(same, people, shifts).split('\r\n')[0], '\uFEFFDate,Day,Shift,Start,End,Person');
});

test('toCSV prefixes names that would run as spreadsheet formulas, and leaves ordinary ones', () => {
  const folks = [
    { id: 1, name: '=HYPERLINK("http://evil","x")' }, { id: 2, name: '@SUM(A1)' }, { id: 3, name: 'Sarah' },
  ];
  const r = {
    ...roster,
    assignments: [
      { date: '2026-10-11', shiftId: 10, personId: 1 },
      { date: '2026-10-11', shiftId: 10, personId: 2 },
      { date: '2026-10-11', shiftId: 10, personId: 3 },
    ],
  };
  const csv = toCSV(r, folks, shifts);
  assert.ok(csv.includes(`,"'=HYPERLINK(""http://evil"",""x"")"`));
  assert.ok(csv.includes(`,'@SUM(A1)`));
  assert.ok(csv.includes(',Sarah'));
  assert.ok(!csv.includes(`'Sarah`));
});

test('formatPerPerson keeps two different people with the same name apart', () => {
  const sams = [{ id: 1, name: 'Sam' }, { id: 2, name: 'Sam' }];
  const r = {
    ...roster,
    assignments: [
      { date: '2026-10-11', shiftId: 10, personId: 1 },
      { date: '2026-10-18', shiftId: 10, personId: 2 },
    ],
  };
  const sam = formatPerPerson(r, sams, shifts).split('\n').filter((l) => l.startsWith('Sam:'));
  assert.equal(sam.length, 2);
});
