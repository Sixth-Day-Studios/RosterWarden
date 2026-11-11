/**
 * Deterministic roster allocation.
 *
 * A direct port of the original Python scheduler, kept behaviour-identical:
 * given the same inputs it always produces the same roster, every constraint it
 * is given is actually enforced, and anything it cannot satisfy is reported as
 * an explicit note rather than quietly fudged.
 *
 * The algorithm is a greedy fill with a fairness ranking. Days are processed in
 * order; within a day, shifts are filled in the organisation's own shift order.
 * For each vacancy the eligible pool is ranked by
 *
 *   1. fewest shifts worked so far in this roster   (spread the load)
 *   2. longest since last worked                    (spread the days out)
 *   3. name                                         (a stable, arbitrary tiebreak)
 *
 * Greedy rather than an exhaustive search because rosters are small, the result
 * must be explainable to whoever reads it ("Alice got Saturday because she'd
 * worked the fewest shifts"), and a solver that silently reshuffles everything
 * on a one-person change is worse to live with than one that does the obvious
 * thing.
 *
 * Dates are handled throughout as "YYYY-MM-DD" strings converted to whole-day
 * integers in UTC. Doing arithmetic on local-time Date objects would shift days
 * across daylight-saving boundaries, which for a roster is a real bug.
 */

/** Sentinel "has never worked" value; any real day sorts after it. */
const NEVER = -Infinity;

/**
 * Day numbers already worked out, by date string. Building a roster asks for the same few hundred dates
 * (the rostered days, everyone's away dates) hundreds of thousands of times, and parsing each one afresh
 * was most of the time a big build took.
 */
const dayNumbers = new Map();

/** Convert a "YYYY-MM-DD" string to a whole number of days since the epoch. */
export function toDays(iso) {
  let n = dayNumbers.get(iso);
  if (n === undefined) {
    const [y, m, d] = iso.split('-').map(Number);
    n = Math.floor(Date.UTC(y, m - 1, d) / 86400000);
    // Kept bounded: a year of dates is a few hundred entries, so this only ever trips on something odd.
    if (dayNumbers.size > 20000) dayNumbers.clear();
    dayNumbers.set(iso, n);
  }
  return n;
}

/** Convert a whole-day number back to a "YYYY-MM-DD" string. */
export function fromDays(n) {
  return new Date(n * 86400000).toISOString().slice(0, 10);
}

/**
 * Today's date on this device's own clock, as "YYYY-MM-DD".
 *
 * Not `toISOString()`: that is UTC, so in Australia it reports yesterday until
 * mid-morning - the calendar rings the wrong day and this morning's away dates
 * count as already past.
 */
export function todayISO(now = new Date()) {
  const pad = (n) => String(n).padStart(2, '0');
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
}

/** Weekday index for a date, Monday=0 through Sunday=6 (matches the UI order). */
export function weekdayOf(iso) {
  return (new Date(toDays(iso) * 86400000).getUTCDay() + 6) % 7;
}

/**
 * A date in the month an empty calendar should open on: `today`'s month, or
 * the 1st of next month in a month's last 10 days, when what is left of this
 * one is too little to roster.
 */
export function openingMonthDate(today) {
  const [y, m, d] = today.split('-').map(Number);
  const daysInMonth = new Date(Date.UTC(y, m, 0)).getUTCDate();
  if (daysInMonth - d >= 10) return today;
  return fromDays(toDays(today) + daysInMonth - d + 1);
}

/** A roster's dates, sorted: its picked days, or for older rosters the days it has places on. */
export function rosterDates(roster) {
  return [...(roster.days?.length ? roster.days : [...new Set(roster.assignments.map((a) => a.date))])].sort();
}

/**
 * The same days of the week moved on by whole weeks past the last of them, so
 * a fortnight's roster rolls on to the next fortnight. A roster covering a
 * calendar month (starting in its first week, ending in its last) rolls on to
 * those weekdays across the whole next month instead: five weeks on would
 * start it days late and run it into the month after. `days` must be sorted.
 */
export function rollOn(days) {
  const first = days[0];
  const last = days[days.length - 1];
  const [y, m] = first.split('-').map(Number);
  const daysInMonth = new Date(Date.UTC(y, m, 0)).getUTCDate();
  if (first.slice(0, 7) === last.slice(0, 7)
      && Number(first.slice(8)) <= 7 && Number(last.slice(8)) > daysInMonth - 7) {
    const start = fromDays(toDays(first) + daysInMonth - Number(first.slice(8)) + 1); // 1st of next month
    const [ny, nm] = start.split('-').map(Number);
    const end = `${start.slice(0, 8)}${new Date(Date.UTC(ny, nm, 0)).getUTCDate()}`;
    return dateRange(start, end, new Set(days.map(weekdayOf)));
  }
  const span = toDays(days[days.length - 1]) - toDays(days[0]) + 1;
  const step = Math.ceil(span / 7) * 7;
  return days.map((d) => fromDays(toDays(d) + step));
}

/** The saved roster (not a draft) with the latest last date, or undefined when there is none. */
export function latestRoster(rosters) {
  let latest;
  let latestEnd = '';
  for (const r of rosters) {
    if (r.draft) continue;
    const days = rosterDates(r);
    if (days.length && days[days.length - 1] > latestEnd) {
      latest = r;
      latestEnd = days[days.length - 1];
    }
  }
  return latest;
}

/**
 * The dates the next roster most likely needs: the latest saved roster (by its
 * last date) rolled on until it starts no earlier than `today`, so a roster
 * from months back still lands on upcoming weeks. Days outside `openDays`
 * (0-6, Monday=0) are left out, so a one-off special opening isn't carried
 * on. [] when there is none.
 */
export function followOnDates(rosters, today = todayISO(), openDays = [0, 1, 2, 3, 4, 5, 6]) {
  const source = latestRoster(rosters);
  const latest = source ? rosterDates(source) : [];
  if (!latest.length) return [];
  let next = rollOn(latest);
  while (next[0] < today) next = rollOn(next);
  return next.filter((d) => openDays.includes(weekdayOf(d)));
}

/**
 * Month and weekday names, fixed rather than taken from the browser locale.
 *
 * Locale formatting would vary by device (en-GB renders September as "Sept",
 * four characters where every other month gives three) which both breaks the
 * column alignment in the text table and means two people copying the same
 * roster could get different text. A roster is shared output, so it is pinned.
 */
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun',
                'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const WEEKDAY_NAMES = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];

/** Short weekday name for a date, e.g. "Sat". */
export function weekdayName(iso) {
  return WEEKDAY_NAMES[weekdayOf(iso)];
}

/** Format a date for display, e.g. "Sat 06 Jun 2026". */
export function formatDate(iso, { withWeekday = true } = {}) {
  const [y, m, d] = iso.split('-').map(Number);
  const stamp = `${String(d).padStart(2, '0')} ${MONTHS[m - 1]} ${y}`;
  return withWeekday ? `${weekdayName(iso)} ${stamp}` : stamp;
}

/**
 * Every date from start to end inclusive whose weekday is rostered.
 * `weekdays` is a Set of 0-6 values; an empty set yields no days at all.
 */
export function dateRange(start, end, weekdays) {
  let a = toDays(start);
  let b = toDays(end);
  if (b < a) [a, b] = [b, a];

  const out = [];
  for (let n = a; n <= b; n++) {
    const iso = fromDays(n);
    if (weekdays.has(weekdayOf(iso))) out.push(iso);
  }
  return out;
}

/** Expand unordered clash pairs into a person-id -> Set(incompatible ids) map. */
function clashMap(clashes) {
  const map = new Map();
  for (const [a, b] of clashes) {
    if (!map.has(a)) map.set(a, new Set());
    if (!map.has(b)) map.set(b, new Set());
    map.get(a).add(b);
    map.get(b).add(a);
  }
  return map;
}

/**
 * True if a person can work `iso`.
 *
 * A blackout is a hard "can't" and always wins. The standing weekday pattern is
 * the default, but an explicit request for this exact date overrides it: "I
 * want to work that day" is a stronger, more deliberate signal than "I don't
 * usually work Saturdays", so a one-off request lets someone work a weekday
 * their pattern would otherwise exclude.
 */
export function canWork(person, iso) {
  if (!person.active) return false;
  const n = toDays(iso);
  if ((person.blackouts || []).some((b) => toDays(b.start) <= n && n <= toDays(b.end))) {
    return false;
  }
  if ((person.requests || []).includes(iso)) return true;
  // "Only the 1st and 3rd week of the month": the nth Sunday (or Monday...) of its month.
  const weeks = person.weeksOfMonth || [];
  if (weeks.length && !weeks.includes(Math.ceil(Number(iso.slice(8, 10)) / 7))) return false;
  return person.availableWeekdays.includes(weekdayOf(iso));
}

/**
 * True if `person` can do `roleId`: the role is open to anyone, or they are
 * ticked for it. A role this list doesn't know (deleted) is open to nobody -
 * an empty slot that gets reported beats a guess.
 *
 * `roleId` null means "no role": the shift has no roles, so there is nothing
 * to be ticked for.
 */
export function canDoRole(person, roleId, roleById) {
  if (roleId == null) return true;
  if (roleById.get(roleId)?.anyone) return true;
  return (person.roleIds || []).includes(roleId);
}

/**
 * The places a shift needs filled: one per role with how many, or - when the
 * shift has no roles - a single place with no role and its plain headcount.
 */
export function slotsOf(shift) {
  if (shift.roles?.length) {
    return shift.roles
      .filter((r) => r.count > 0)
      .map((r) => ({ roleId: r.roleId, count: r.count }));
  }
  return [{ roleId: null, count: Math.max(0, shift.headcount) }];
}

/**
 * The shifts that run on `date` in `roster`: its own list for that day when it
 * has one (`roster.dayShifts`), otherwise the organisation's usual shifts.
 */
export function shiftsOn(roster, date, usual) {
  return roster?.dayShifts?.[date] ?? usual;
}

/**
 * One shift as it runs on `date` in `roster`, found by id: the day's own entry
 * first, then the usual shifts. Undefined when neither knows it (removed).
 */
export function shiftOn(roster, date, shiftId, usual) {
  return shiftsOn(roster, date, usual).find((s) => s.id === shiftId)
    ?? usual.find((s) => s.id === shiftId);
}

/**
 * The shifts to lay out as columns for the whole roster: the usual shifts when
 * it has no per-day lists, otherwise every distinct shift (by id) across its
 * days, in order of first appearance.
 */
export function rosterShiftList(roster, usual) {
  if (!roster?.dayShifts) return usual;
  const seen = new Set();
  const out = [];
  // Every rostered day, so one without a list of its own still adds the usual shifts.
  for (const day of rosterDates(roster)) {
    for (const s of shiftsOn(roster, day, usual)) {
      if (seen.has(s.id)) continue;
      seen.add(s.id);
      out.push(s);
    }
  }
  return out;
}

/** True when a usual shift runs on `date`: no `days` set means every day. */
export function runsOn(shift, date) {
  return !Array.isArray(shift.days) || shift.days.includes(weekdayOf(date));
}

/**
 * Each date's own copy of the usual shifts that run that weekday, for a roster
 * to keep. Copies keep the usual shift's id, so places, locks and swaps still
 * match it; later edits on the Team tab no longer reach a roster already built.
 */
export function usualDayShifts(shifts, dates) {
  return Object.fromEntries(dates.map((date) => [date, shifts
    .filter((s) => runsOn(s, date))
    .map(({ id, name, start, end, headcount, roles }) => ({
      id, name, start, end, headcount, roles: (roles || []).map((r) => ({ ...r })),
    }))]));
}

/**
 * Every date of a roster with a list of its own, ready to edit: lists it
 * already has are kept as they are, and a missing date gets a deep copy of ALL
 * the usual shifts (not filtered by weekday), as older rosters were built with
 * every shift on every day. Returns a new `{ date: entries }` object.
 */
export function copyDayShifts(roster, usual) {
  const out = { ...(roster.dayShifts || {}) };
  for (const date of rosterDates(roster)) {
    if (out[date]) continue;
    out[date] = usual.map(({ id, name, start, end, headcount, roles }) => ({
      id, name, start, end, headcount, roles: (roles || []).map((r) => ({ ...r })),
    }));
  }
  return out;
}

/**
 * The day lists to carry from `sourceRoster` onto `newDates`: for each new
 * date, a deep copy of the source's list for the nearest earlier date a whole
 * number of weeks before it (same weekday) that the source has a list for.
 * Only dates whose carried list differs from the usual shifts of that date
 * (`usual`, the Team tab's shifts) are returned, as `{ date: entries }`; a
 * roster without `dayShifts` carries nothing. Events (`event: true`) are
 * one-offs, so they stay behind.
 */
export function carryDayShifts(sourceRoster, newDates, usual) {
  const out = {};
  const lists = sourceRoster?.dayShifts;
  if (!lists) return out;
  const have = Object.keys(lists).sort();
  const usualLists = usualDayShifts(usual, newDates);
  for (const date of newDates) {
    // Nearest earlier source date on the same weekday (a multiple of 7 days back).
    const from = have.filter((d) => d < date && (toDays(date) - toDays(d)) % 7 === 0).pop();
    if (from === undefined) continue;
    const copy = JSON.parse(JSON.stringify(lists[from].filter((e) => !e.event)));
    // A day that was just the usual shifts of the time the source was built is not a change to carry: the
    // usual shifts as they are now go in instead, so a shift changed on the Team tab since reaches the new
    // roster. (A roster from before `usualShifts` was kept can't tell, so it carries any difference.)
    if (sourceRoster.usualShifts) {
      const usualThen = usualDayShifts(sourceRoster.usualShifts, [from])[from];
      if (JSON.stringify(copy) === JSON.stringify(usualThen)) continue;
    }
    if (JSON.stringify(copy) !== JSON.stringify(usualLists[date])) out[date] = copy;
  }
  return out;
}

/**
 * A copy of the usual shifts as they are now, for a new roster to keep as
 * `usualShifts`, so carrying its days on later can tell a day changed by hand
 * from one that was simply the usual shifts of its time (see carryDayShifts).
 */
export function shiftsSnapshot(shifts) {
  return shifts.map(({ id, name, start, end, headcount, roles, days }) => ({
    id, name, start, end, headcount, roles: (roles || []).map((r) => ({ ...r })),
    ...(Array.isArray(days) ? { days: [...days] } : {}),
  }));
}

/** How far back (in days) a saved roster still counts towards who is due a turn. */
const HISTORY_DAYS = 90;

/**
 * Choose the fairest eligible person for one vacancy, or null if there is none.
 * `roleOk` narrows the pool to people who can do the role being filled.
 */
function pick(day, people, usedToday, placedIds, incompatible, worked, lastWorked, roleOk = () => true, bias = new Map(), ahead = new Map()) {
  const eligible = people.filter(
    (p) =>
      !usedToday.has(p.id) &&                                  // not already on today
      canWork(p, day) &&                                       // availability + blackouts
      roleOk(p) &&                                             // can do this role
      ![...(incompatible.get(p.id) || [])].some((id) => placedIds.has(id)) && // no clash
      // A max-shifts cap counts their locked places still to come (`ahead`) as already taken.
      (p.maxShifts == null || worked.get(p.id) + (ahead.get(p.id) || 0) < p.maxShifts)
  );
  if (eligible.length === 0) return null;

  // Ranking. Someone who asked for this date goes first - a request is a
  // preference, not a guarantee, so it orders the queue but never overrides a
  // hard constraint. Fairness then applies as usual, and comparing `name` last
  // makes the ordering total, so the result is reproducible run to run.
  eligible.sort((x, y) => {
    const rx = (x.requests || []).includes(day) ? 0 : 1;
    const ry = (y.requests || []).includes(day) ? 0 : 1;
    if (rx !== ry) return rx - ry;
    // Someone who asked to serve less often (`minGapWeeks`) goes behind everyone
    // whose gap has passed - but is still used if nobody else is left.
    const cool = (p) => (p.minGapWeeks && toDays(day) - lastWorked.get(p.id) < p.minGapWeeks * 7 ? 1 : 0);
    if (cool(x) !== cool(y)) return cool(x) - cool(y);
    // Turns taken in recent saved rosters count too, so fairness holds from one roster to the next.
    const wx = worked.get(x.id) + (bias.get(x.id) || 0), wy = worked.get(y.id) + (bias.get(y.id) || 0);
    if (wx !== wy) return wx - wy;
    const lx = lastWorked.get(x.id), ly = lastWorked.get(y.id);
    if (lx !== ly) return lx - ly;
    return x.name.toLowerCase().localeCompare(y.name.toLowerCase());
  });
  return eligible[0];
}

/**
 * Allocate staff across the date range and return the finished roster.
 *
 * Anything that could not be satisfied - an unfillable shift, a person with no
 * availability at all - is pushed onto `roster.notes` instead of being silently
 * dropped, so the UI can surface it next to the result.
 */
export function buildRoster({
  orgId, name, people, shifts, clashes, start, end, weekdays, dates, roles = [],
  history = [], locked = [], dayShifts,
}) {
  // `dates` is the canonical input: the exact days to roster, as chosen on the
  // calendar. start/end/weekdays remain supported as a shorthand that derives
  // the same list, which is what the test suite and older saved rosters use.
  // Presence, not length, picks the branch - an empty `dates` means "nothing
  // selected" and must report that, not silently fall back to a date range
  // whose bounds were never supplied.
  const days = Array.isArray(dates)
    ? [...new Set(dates)].sort()
    : dateRange(start, end, weekdays);
  const roster = {
    orgId,
    name,
    startDate: days.length ? days[0] : start,
    endDate: days.length ? days[days.length - 1] : end,
    // The exact dates rostered, kept on the roster so a saved one can be
    // redrawn faithfully later. Without it a day where nothing could be filled
    // would simply vanish from the saved view, hiding the very gap that most
    // needs looking at.
    days,
    assignments: [],
    notes: [],
  };
  // Every roster keeps its own shifts for each day: the lists given, kept only
  // for the days actually rostered, and the usual shifts that run on any day
  // without one.
  const given = dayShifts || {};
  const usualFor = usualDayShifts(shifts, days.filter((d) => !given[d]));
  roster.dayShifts = Object.fromEntries(days.map((d) => [d, given[d] || usualFor[d]]));

  // Guard the degenerate inputs up front so the main loop can assume it has
  // something to work with.
  const roll = people.filter((p) => p.active);
  if (days.length === 0) {
    roster.notes.push(dates
      ? 'No dates picked on the calendar.'
      : 'No rostered days fall in the selected date range.');
    return roster;
  }
  // Nothing can be filled in the next two cases, but places the user locked are still kept: a rebuild with
  // everyone paused must not quietly empty the roster.
  const keepLocked = () => locked.filter((a) => days.includes(a.date)).map((a) => ({ ...a, locked: true }));
  if (days.every((d) => shiftsOn(roster, d, shifts).length === 0)) {
    roster.notes.push(shifts.length
      ? 'None of your shifts run on the dates picked.'
      : 'This organisation has no shifts set up.');
    roster.assignments = keepLocked();
    return roster;
  }
  if (roll.length === 0) {
    roster.notes.push('No active people to roster.');
    roster.assignments = keepLocked();
    return roster;
  }

  const incompatible = clashMap(clashes);
  const roleById = new Map(roles.map((r) => [r.id, r]));
  const worked = new Map(roll.map((p) => [p.id, 0]));
  const lastWorked = new Map(roll.map((p) => [p.id, NEVER]));

  // Recent turns from saved rosters (`history`: their assignments), so someone
  // who served the last few weeks waits behind someone who didn't. Only the
  // 90 days before the first day count (HISTORY_DAYS), and `worked` itself stays this
  // roster's own tally, which is what a person's max-shifts limit is checked against.
  const bias = new Map();
  // Each person's locked places on days not yet reached. They count against a max-shifts cap from the start:
  // otherwise the days before a locked place could fill someone up, and the locked place then puts them over.
  const ahead = new Map();
  for (const a of locked) if (days.includes(a.date)) ahead.set(a.personId, (ahead.get(a.personId) || 0) + 1);
  const first = toDays(days[0]);
  for (const a of history) {
    const d = toDays(a.date);
    if (d >= first || first - d > HISTORY_DAYS || !worked.has(a.personId)) continue;
    bias.set(a.personId, (bias.get(a.personId) || 0) + 1);
    lastWorked.set(a.personId, Math.max(lastWorked.get(a.personId), d));
  }

  for (const day of days) {
    // One shift per person per day: whoever is already on today is out of the
    // pool for the day's remaining shifts.
    const usedToday = new Set();

    // Places the user pinned (locked) on this day go in first, exactly as they
    // were, and the scheduler only fills what is left around them.
    const pinned = locked.filter((a) => a.date === day);
    for (const a of pinned) {
      usedToday.add(a.personId);
      ahead.set(a.personId, ahead.get(a.personId) - 1);
      if (worked.has(a.personId)) {
        worked.set(a.personId, worked.get(a.personId) + 1);
        lastWorked.set(a.personId, toDays(day));
      }
      roster.assignments.push({ ...a, locked: true });
    }

    for (const shift of shiftsOn(roster, day, shifts)) {
      const placedIds = new Set(pinned.filter((a) => a.shiftId === shift.id).map((a) => a.personId));
      let slots = slotsOf(shift);

      // A shift with several roles fills the hardest one first: the role with
      // the fewest spare people. Otherwise the only drummer could be used up on
      // an easier role, leaving the drums - which nobody else can play - empty.
      if (slots.length > 1) {
        const spare = (slot) => roll.filter(
          (p) => !usedToday.has(p.id) && canWork(p, day) && canDoRole(p, slot.roleId, roleById)
        ).length - slot.count;
        slots = slots
          .map((slot, order) => ({ ...slot, order, spare: spare(slot) }))
          .sort((a, b) => a.spare - b.spare || a.order - b.order);
      }

      // How many places each slot still has, after anything pinned there.
      const remaining = slots.map((slot) => slot.count - pinned.filter(
        (a) => a.shiftId === shift.id && (a.roleId ?? null) === slot.roleId
      ).length);

      /** Put `who` in slot `k` of this shift. */
      const place = (who, k) => {
        placedIds.add(who.id);
        usedToday.add(who.id);
        worked.set(who.id, worked.get(who.id) + 1);
        lastWorked.set(who.id, toDays(day));
        remaining[k] -= 1;
        roster.assignments.push({
          date: day, shiftId: shift.id, personId: who.id,
          ...(slots[k].roleId != null ? { roleId: slots[k].roleId } : {}),
        });
      };

      for (let k = 0; k < slots.length; k++) {
        const roleOk = (p) => canDoRole(p, slots[k].roleId, roleById);
        while (remaining[k] > 0) {
          const who = pick(day, roll, usedToday, placedIds, incompatible, worked, lastWorked, roleOk, bias, ahead);
          if (!who) break;
          place(who, k);

          // People who serve together come along: each partner takes the first
          // place left on this shift they can do, if they are free and fit.
          for (const mateId of who.withIds || []) {
            const mate = roll.find((p) => p.id === mateId);
            if (!mate || usedToday.has(mate.id) || !canWork(mate, day)) continue;
            if (mate.maxShifts != null && worked.get(mate.id) + (ahead.get(mate.id) || 0) >= mate.maxShifts) continue;
            if ([...(incompatible.get(mate.id) || [])].some((id) => placedIds.has(id))) continue;
            const t = slots.findIndex((s, j) => remaining[j] > 0 && canDoRole(mate, s.roleId, roleById));
            if (t >= 0) place(mate, t);
          }
        }
      }
    }
  }

  roster.notes = auditRoster(roster, roll, shifts, roles);
  return roster;
}

/**
 * Regenerate a roster's notes from its current assignments.
 *
 * Run at the end of a build and again after any manual edit, so the "things to
 * check" list stays true to what the roster actually says now rather than to
 * how it first came out of the scheduler. Covers: understaffed shifts, requests
 * that were asked for but not granted, and active people used nowhere.
 */
export function auditRoster(roster, people, shifts, roles = []) {
  const notes = [];
  const roleById = new Map(roles.map((r) => [r.id, r]));
  const active = people.filter((p) => p.active);
  const days = roster.days?.length
    ? [...roster.days].sort()
    : [...new Set(roster.assignments.map((a) => a.date))].sort();

  // Understaffed shifts, day by day, in shift order. A shift with roles is
  // checked role by role, so "needs a drummer" is not hidden by a full band.
  for (const day of days) {
    for (const shift of shiftsOn(roster, day, shifts)) {
      if (shift.roles?.length) {
        for (const r of shift.roles) {
          const n = roster.assignments.filter(
            (a) => a.date === day && a.shiftId === shift.id && a.roleId === r.roleId
          ).length;
          if (n < r.count) {
            const label = roleById.get(r.roleId)?.name || '(removed role)';
            notes.push(`${formatDate(day)} - ${shift.name}, ${label}: only ${n} of ${r.count} filled.`);
          }
        }
        continue;
      }
      const n = roster.assignments.filter(
        (a) => a.date === day && a.shiftId === shift.id
      ).length;
      if (n < shift.headcount) {
        notes.push(`${formatDate(day)} - ${shift.name}: only ${n} of ${shift.headcount} filled.`);
      }
    }
  }

  // Someone on the roster on a day they are now away: their dates changed
  // after it was made (from their own link, Planning Center, or by hand).
  const personOf = new Map(people.map((p) => [p.id, p]));
  for (const a of roster.assignments) {
    const p = personOf.get(a.personId);
    const n = toDays(a.date);
    if (p && (p.blackouts || []).some((b) => toDays(b.start) <= n && n <= toDays(b.end))) {
      notes.push(`${formatDate(a.date)} - ${p.name} is rostered but is now away.`);
    } else if (p && p.active && !canWork(p, a.date)) {
      // Outside their usual days or weeks: put on by hand, kept by a lock, or their days changed since.
      notes.push(`${formatDate(a.date)} - ${p.name} is rostered on a day they are not available.`);
    }
  }

  const datesByPerson = new Map();
  for (const a of roster.assignments) {
    if (!datesByPerson.has(a.personId)) datesByPerson.set(a.personId, new Set());
    datesByPerson.get(a.personId).add(a.date);
  }
  const rostered = new Set(days);

  // Requests asked for within the rostered period but not granted.
  for (const p of active) {
    const got = datesByPerson.get(p.id) || new Set();
    for (const date of (p.requests || [])) {
      if (rostered.has(date) && !got.has(date)) {
        notes.push(`${p.name} asked for ${formatDate(date)} but could not be fitted in.`);
      }
    }
  }

  // Active people the roster never used. Only worth a note when they *couldn't*
  // have worked any of these days - no availability ticked, or unavailable on
  // every one. Someone who could have worked but wasn't picked (fair rotation,
  // or a deliberate manual edit) is not a problem to flag.
  for (const p of active) {
    if (datesByPerson.has(p.id)) continue;
    if ((p.availableWeekdays || []).length === 0) {
      notes.push(`${p.name} was not rostered at all - no days ticked in their availability.`);
    } else if (days.every((d) => !canWork(p, d))) {
      notes.push(`${p.name} was not rostered at all - unavailable on every rostered day.`);
    } else if (!rosterShiftList(roster, shifts).some((s) => !s.roles?.length || s.roles.some((r) => canDoRole(p, r.roleId, roleById)))) {
      // Every shift here is made of roles and they can do none of them.
      notes.push((p.roleIds || []).length === 0
        ? `${p.name} was not rostered at all - no roles ticked.`
        : `${p.name} was not rostered at all - none of their roles are needed on these shifts.`);
    }
  }

  return notes;
}

/** Shifts worked per person id, for the fairness summary. */
export function counts(roster) {
  const out = new Map();
  for (const a of roster.assignments) {
    out.set(a.personId, (out.get(a.personId) || 0) + 1);
  }
  return out;
}

/**
 * True when a roster has its own day lists and its rostered days do not all
 * run the same shift ids in the same order, so a column per shift won't fit.
 */
export function daysDiffer(roster, usual) {
  if (!roster?.dayShifts) return false;
  const keys = rosterDates(roster).map((d) => shiftsOn(roster, d, usual).map((s) => s.id).join(','));
  return keys.some((k) => k !== keys[0]);
}
