/**
 * Ways to get a roster out of the app: a message for a group chat, a line per
 * person, a spreadsheet and a calendar file. (Printing is a view, in
 * views/roster-parts.js; it uses the same day-by-day shape as `rosterLines`.)
 *
 * Pure functions over plain data - no DOM - so they run under `node --test`.
 * Every format lists every rostered day and every shift, so an unfilled shift
 * shows as a gap to chase rather than quietly vanishing.
 */
import { formatDate, weekdayName, shiftsOn, shiftOn, rosterShiftList, daysDiffer } from './scheduler.js';

/**
 * The dates a roster covers, in order.
 *
 * Prefers the day list recorded when it was built, so a day where nothing
 * could be filled still shows. Rosters saved before that field existed fall
 * back to the dates that actually got someone.
 */
export function rosterDays(roster) {
  return roster.days?.length
    ? [...roster.days].sort()
    : [...new Set(roster.assignments.map((a) => a.date))].sort();
}

/** "8:00–12:00" from "08:00"/"12:00", or '' when a shift has no times. */
export function shiftTimes(shift) {
  if (!shift?.start || !shift?.end) return '';
  const short = (t) => t.replace(/^0(\d)/, '$1');
  return `${short(shift.start)}–${short(shift.end)}`;
}

/**
 * Hours in a shift, from its start and end times; a shift that ends at or
 * before it starts runs past midnight. Zero when it has no times.
 */
export function shiftHours(shift) {
  if (!shift?.start || !shift?.end) return 0;
  const minutes = (t) => Number(t.slice(0, 2)) * 60 + Number(t.slice(3, 5));
  let span = minutes(shift.end) - minutes(shift.start);
  if (span <= 0) span += 24 * 60;
  return span / 60;
}

/** Hours rostered per person, as a Map of person id to hours. */
export function hoursByPerson(roster, shifts) {
  const out = new Map();
  for (const a of roster.assignments) {
    // Hours come from the shift as it runs on that assignment's day.
    const hours = shiftHours(shiftOn(roster, a.date, a.shiftId, shifts));
    out.set(a.personId, (out.get(a.personId) || 0) + hours);
  }
  return out;
}

/**
 * A message for one person: just their own dates, ready to text or email.
 * Null when they are not on the roster.
 */
export function messageFor(roster, person, shifts, roles = []) {
  const roleNames = new Map(roles.map((r) => [r.id, r.name]));
  const mine = roster.assignments
    .filter((a) => a.personId === person.id)
    .sort((x, y) => x.date.localeCompare(y.date));
  if (mine.length === 0) return null;

  const lines = mine.map((a) => {
    const shift = shiftOn(roster, a.date, a.shiftId, shifts);
    const times = shiftTimes(shift);
    const detail = [
      shift ? [shift.name, times].filter(Boolean).join(' ') : 'removed shift',
      a.roleId != null ? (roleNames.get(a.roleId) || 'removed role') : null,
    ].filter(Boolean).join(', ');
    return `• ${shortDate(a.date)}: ${detail}`;
  });
  return `Hi ${person.name.split(' ')[0]}, you're on the roster (${roster.name}):\n${lines.join('\n')}`;
}

/** "Sun 11 Oct" - the short date used in messages, where the year is noise. */
function shortDate(iso) {
  return `${weekdayName(iso)} ${formatDate(iso, { withWeekday: false }).replace(/ \d{4}$/, '').replace(/^0/, '')}`;
}

/**
 * Who is on a shift, grouped by role: `[{ role, names, short }]`.
 *
 * A shift made of roles gets one group per role it lists, in order, each with
 * how many more it needed. A shift with none gets one group with `role: null`.
 * Anyone on the shift under some other role (one removed from the shift since,
 * or a roster made before the shift had roles) follows as extra groups, so
 * nobody on a saved roster ever disappears from the output.
 */
function groupsOf(shift, here, nameOf, roleName) {
  const mine = (id) => here.filter((a) => (a.roleId ?? null) === id);
  const who = (list) => list.map((a) => nameOf.get(a.personId) || '(removed)');
  const listed = shift.roles?.length ? shift.roles : [];
  const groups = [];
  if (listed.length) {
    for (const r of listed) {
      const list = mine(r.roleId);
      groups.push({ role: roleName(r.roleId), names: who(list), short: Math.max(0, r.count - list.length) });
    }
  } else {
    const list = mine(null);
    groups.push({ role: null, names: who(list), short: Math.max(0, shift.headcount - list.length) });
  }
  const shown = new Set(listed.length ? listed.map((r) => r.roleId) : [null]);
  for (const id of [...new Set(here.map((a) => a.roleId ?? null))].filter((id) => !shown.has(id))) {
    groups.push({ role: id === null ? '(no role)' : roleName(id), names: who(mine(id)), short: 0 });
  }
  return groups;
}

/** "Anna (Lead singer)" for each person in some groups; just the name where there is no role. */
function labelled(groups) {
  return groups.flatMap((g) => g.names.map((n) => (g.role ? `${n} (${g.role})` : n)));
}

/** True when a roster is made of roles, so its spreadsheet needs a Role column. */
function usesRoles(roster, shifts) {
  return rosterShiftList(roster, shifts).some((s) => s.roles?.length) || roster.assignments.some((a) => a.roleId != null);
}

/**
 * The roster as rows: one per day, each with one entry per shift.
 *
 * Shifts follow each day's own list (the organisation's current order unless
 * the roster has its own); a shift deleted since the roster was saved still
 * appears (as "(removed)") if anyone was on it.
 * Each shift entry is `{ shift, names, short, groups }`: `names` everyone on
 * it, `short` how many more people it needed, and `groups` the same split by
 * role (see groupsOf).
 */
export function rosterLines(roster, people, shifts, roles = []) {
  const nameOf = new Map(people.map((p) => [p.id, p.name]));
  const roleNames = new Map(roles.map((r) => [r.id, r.name]));
  const roleName = (id) => roleNames.get(id) || '(removed role)';

  return rosterDays(roster).map((date) => {
    const todays = roster.assignments.filter((a) => a.date === date);
    const dayList = shiftsOn(roster, date, shifts);
    const known = new Set(dayList.map((s) => s.id));
    const extra = [...new Set(todays.map((a) => a.shiftId))]
      .filter((id) => !known.has(id))
      .map((id) => ({ id, name: '(removed)', headcount: 0, start: '', end: '' }));

    return {
      date,
      shifts: [...dayList, ...extra].map((shift) => {
        const here = todays.filter((a) => a.shiftId === shift.id);
        const names = here.map((a) => nameOf.get(a.personId) || '(removed)');
        const groups = groupsOf(shift, here, nameOf, roleName);
        return { shift, names, short: groups.reduce((sum, g) => sum + g.short, 0), groups };
      }),
    };
  });
}

/** "11 Oct – 25 Oct 2026" for a title line. */
function span(roster) {
  const days = rosterDays(roster);
  if (!days.length) return '';
  const first = formatDate(days[0], { withWeekday: false }).replace(/^0/, '');
  const last = formatDate(days[days.length - 1], { withWeekday: false }).replace(/^0/, '');
  return days.length === 1 ? last : `${first.replace(/ \d{4}$/, '')} – ${last}`;
}

/**
 * The roster as a message for WhatsApp, SMS or email: a title, then each day
 * with its shifts. Plain text with no table, because a fixed-width table
 * breaks the moment a phone wraps it.
 */
export function formatMessage(roster, people, shifts, roles = []) {
  const lines = [`${roster.name} (${span(roster)})`];
  for (const day of rosterLines(roster, people, shifts, roles)) {
    lines.push('', shortDate(day.date));
    for (const { shift, names, short, groups } of day.shifts) {
      if (names.length === 0 && shift.headcount === 0) continue;   // a shift nobody is needed on
      const times = shiftTimes(shift);
      const base = times ? `${shift.name} ${times}` : shift.name;
      const label = shift.note ? `${base} (${shift.note})` : base;
      if (groups.length === 1 && groups[0].role === null) {
        const who = names.length ? names.join(', ') : 'nobody yet';
        lines.push(`• ${label}: ${who}${names.length && short ? ` (needs ${short} more)` : ''}`);
        continue;
      }
      // A shift of roles: its name, then a line per role.
      lines.push(`• ${label}`);
      for (const g of groups) {
        const who = g.names.length ? g.names.join(', ') : 'nobody yet';
        lines.push(`   ${g.role || 'Others'}: ${who}${g.names.length && g.short ? ` (needs ${g.short} more)` : ''}`);
      }
    }
  }
  return lines.join('\n');
}

/**
 * One line per person with the days they're on - for messaging people
 * individually. The shift name is added only when the roster has more than
 * one shift, since "Sun 11 Oct (Cafe)" is clutter if Cafe is all there is.
 */
export function formatPerPerson(roster, people, shifts, roles = []) {
  const nameOf = new Map(people.map((p) => [p.id, p.name]));
  const roleNames = new Map(roles.map((r) => [r.id, r.name]));
  const manyShifts = new Set(roster.assignments.map((a) => a.shiftId)).size > 1;

  // Keyed by person id, so two people who share a name stay separate.
  const byPerson = new Map();
  for (const a of [...roster.assignments].sort((x, y) => x.date.localeCompare(y.date))) {
    const name = nameOf.get(a.personId) || '(removed)';
    const shift = shiftOn(roster, a.date, a.shiftId, shifts);
    // The shift name only when there are several; the role whenever the place had one.
    const detail = [
      manyShifts ? (shift ? shift.name : 'removed shift') : null,
      a.roleId != null ? (roleNames.get(a.roleId) || 'removed role') : null,
    ].filter(Boolean).join(', ');
    const when = shortDate(a.date) + (detail ? ` (${detail})` : '');
    if (!byPerson.has(a.personId)) byPerson.set(a.personId, { name, whens: [] });
    byPerson.get(a.personId).whens.push(when);
  }

  const lines = [`${roster.name}: who's on when`, ''];
  const entries = [...byPerson.values()].sort((a, b) => a.name.localeCompare(b.name));
  for (const { name, whens } of entries) lines.push(`${name}: ${whens.join(', ')}`);
  return lines.join('\n');
}

/** One CSV field, quoted when it holds a comma, quote or line break (RFC 4180). */
function csvField(value) {
  let s = String(value ?? '');
  // Stop a spreadsheet running a name like =HYPERLINK(...) as a formula: lead it with a
  // quote. Plain numbers (even negative) are left alone.
  if (/^[=+\-@\t\r]/.test(s) && !/^-?\d+(\.\d+)?$/.test(s)) s = `'${s}`;
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

/**
 * The spreadsheet for a roster whose days run different shifts: one row per
 * date and shift, with everyone on it in one People cell and the shift's note.
 */
function toCSVByShift(roster, people, shifts, roles) {
  const rows = [['Date', 'Day', 'Shift', 'Start', 'End', 'People', 'Note']];
  for (const day of rosterLines(roster, people, shifts, roles)) {
    for (const { shift, groups } of day.shifts) {
      rows.push([
        day.date, weekdayName(day.date), shift.name, shift.start || '', shift.end || '',
        labelled(groups).join(', '), shift.note || '',
      ]);
    }
  }
  return '\uFEFF' + rows.map((r) => r.map(csvField).join(',')).join('\r\n') + '\r\n';
}

/**
 * A spreadsheet: one row per person per shift, plus a row for each place
 * still unfilled, so the sheet can be sorted or filtered by person or date.
 * Starts with a byte-order mark so Excel reads names with accents correctly.
 */
export function toCSV(roster, people, shifts, roles = []) {
  if (daysDiffer(roster, shifts)) return toCSVByShift(roster, people, shifts, roles);
  // A Role column only when the roster is made of roles, so a plain roster's
  // spreadsheet is exactly what it always was.
  const withRole = usesRoles(roster, shifts);
  const rows = [['Date', 'Day', 'Shift', 'Start', 'End', 'Person', ...(withRole ? ['Role'] : [])]];
  for (const day of rosterLines(roster, people, shifts, roles)) {
    for (const { shift, groups } of day.shifts) {
      const base = [day.date, weekdayName(day.date), shift.name, shift.start || '', shift.end || ''];
      for (const g of groups) {
        const role = withRole ? [g.role || ''] : [];
        for (const name of g.names) rows.push([...base, name, ...role]);
        for (let i = 0; i < g.short; i++) rows.push([...base, '(unfilled)', ...role]);
      }
    }
  }
  return '\uFEFF' + rows.map((r) => r.map(csvField).join(',')).join('\r\n') + '\r\n';
}

/** Text escaped for an iCalendar value (backslash, semicolon, comma, newline). */
function icsText(s) {
  return String(s).replace(/\\/g, '\\\\').replace(/;/g, '\\;').replace(/,/g, '\\,').replace(/\n/g, '\\n');
}

/** "2026-10-11" + "08:00" -> "20261011T080000"; date only -> "20261011". */
function icsStamp(date, time) {
  const d = date.replace(/-/g, '');
  return time ? `${d}T${time.replace(':', '')}00` : d;
}

/** The ISO date the day after `iso`. */
function nextDay(iso) {
  const t = new Date(`${iso}T00:00:00Z`);
  t.setUTCDate(t.getUTCDate() + 1);
  return t.toISOString().slice(0, 10);
}

/**
 * A calendar file (.ics) with one event per shift per day, listing who is on.
 *
 * Times are "floating" (no time zone): 8am means 8am wherever the phone is,
 * which is what a local roster means. A shift without times becomes an
 * all-day event; one that ends before it starts runs past midnight.
 * `now` is only a parameter so tests get a fixed timestamp.
 */
export function toICS(roster, people, shifts, now = new Date(), roles = []) {
  const stamp = now.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');
  const out = [
    'BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//Sixth Day Studios//RosterWarden//EN',
    'CALSCALE:GREGORIAN', `X-WR-CALNAME:${icsText(roster.name)}`,
  ];
  for (const day of rosterLines(roster, people, shifts, roles)) {
    for (const { shift, groups } of day.shifts) {
      const names = labelled(groups);
      if (names.length === 0) continue;
      const timed = Boolean(shift.start && shift.end);
      const endDate = timed && shift.end <= shift.start ? nextDay(day.date) : day.date;
      out.push(
        'BEGIN:VEVENT',
        `UID:${roster.id || 'roster'}-${day.date}-${shift.id}@rosterwarden`,
        `DTSTAMP:${stamp}`,
        timed ? `DTSTART:${icsStamp(day.date, shift.start)}` : `DTSTART;VALUE=DATE:${icsStamp(day.date)}`,
        timed ? `DTEND:${icsStamp(endDate, shift.end)}` : `DTEND;VALUE=DATE:${icsStamp(nextDay(day.date))}`,
        `SUMMARY:${icsText(`${shift.name}: ${names.join(', ')}`)}`,
        `DESCRIPTION:${icsText(`${roster.name}\n${shift.name}: ${names.join(', ')}`)}`,
        'END:VEVENT',
      );
    }
  }
  out.push('END:VCALENDAR');
  return out.join('\r\n') + '\r\n';
}

/** A filename-safe version of the roster's name, e.g. "Roster-11-Oct-2026". */
export function fileBase(roster) {
  return (roster.name || 'roster').replace(/[^\w-]+/g, '-').replace(/^-+|-+$/g, '') || 'roster';
}
