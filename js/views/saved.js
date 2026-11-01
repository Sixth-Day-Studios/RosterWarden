/**
 * Rosters screen: the rosters you have, and the one place a roster is looked
 * at and worked on - checked, edited, rebuilt, shared, rolled on to the next
 * one, renamed or deleted. New roster opens the builder, which saves the result
 * and opens it here, so a roster you just built and one from last month behave the same.
 * Follows the same list-then-detail pattern as the People screen - there is no
 * side-by-side layout on a phone.
 */
import { store } from '../store.js';
import { formatDate, auditRoster, buildRoster, rosterDates, rollOn, usualDayShifts } from '../scheduler.js';
import {
  el, fill, toast, confirmDialog, emptyState, promptText, openSheet, closeSheet, monthGrid, collapsible,
} from '../ui.js';
import {
  editableDayCards, dayCards, tally, notesBox, declinedCard, exportButton, gapFixes,
} from './roster-parts.js';
import { openDayShifts, rosterDaySource } from './day-shifts.js';
import * as builderView from './roster.js';
import * as teamView from './team.js';
import * as account from '../account.js';
import { signInButtons } from './account.js';
import * as staff from '../staff.js';
import { openUpdates } from './updates.js';
import { show } from '../app.js';

// Id of the saved roster currently open, or null when showing the list.
let openId = null;

// Whether the open roster is in manual-edit mode. Reset whenever the list is
// shown or a different roster is opened.
let editing = false;

/**
 * Open a roster on the next render - used by the builder straight after a
 * build. `edit` starts it in the editor (a roster to fill in by hand).
 */
export function openRoster(id, { edit = false } = {}) {
  openId = id;
  editing = edit;
}

/** Entry point: render the list, or the opened roster, into `container`. */
export function render(container) {
  const rosters = store.rosters();
  if (rosters.length === 0) {
    openId = null;
    // Nothing to list yet, so the builder shows straight away. The nudge
    // belongs here too: people and shifts are worth losing even before a
    // single roster has been saved.
    builderView.render(container);
    container.prepend(...backupNudge());
    return;
  }

  const opened = openId != null ? rosters.find((r) => r.id === openId) : null;
  if (opened) {
    fill(container, renderOpen(opened, container));
  } else {
    openId = null;
    editing = false;
    fill(container, [...backupNudge(), updatesButton(), swapsCard(null, () => render(container)), ...renderList(rosters, container)]);
  }
}

/** Open the Updates sheet from anywhere; choosing a roster there goes straight to it. */
export function showUpdates() {
  openUpdates({
    openRoster: (id) => { closeSheet(); openRoster(id); show('roster'); },
    onClose: () => show('roster'),
  });
}

/** The Updates button with its unseen count, or null while the log is empty. */
function updatesButton() {
  if (staff.activityLog().length === 0) return null;
  const n = staff.unseenCount();
  return el('div', { className: 'row' }, [el('button', {
    className: n ? 'btn btn-primary' : 'btn', textContent: n ? `Updates (${n})` : 'Updates', onclick: showUpdates,
  })]);
}

/**
 * Asks someone who isn't signed in to sign in, on the screen people actually open.
 *
 * Sync backs the rosters up by itself, but the code that unlocks them lives only on this device until an
 * account keeps it. Signed in, a new or wiped phone gets everything back; signed out, losing this phone loses
 * them. There's no code to write down any more, so signing in is the one way to be safe.
 */
function backupNudge() {
  if (!account.isConfigured() || account.current()) return [];
  const err = el('div', { className: 'err' });
  return [el('div', { className: 'notice' }, [
    el('strong', { textContent: 'Keep your rosters safe' }),
    el('div', { textContent: 'Sign in and they come back on any phone, even if this one is lost or wiped.' }),
    err,
    el('div', { style: 'margin-top:.5rem' }, [signInButtons(err, () => {})]),
  ])];
}

/**
 * Shift swaps staff asked for through their links that are still going, on
 * one roster or (with null) all of them: ones both agreed, waiting for the
 * owner's Approve or Decline, and ones still waiting for the colleague's
 * answer. Null when there are none.
 */
function swapsCard(rosterId, redraw) {
  const open = staff.openSwaps(rosterId);
  if (open.length === 0) return null;
  /** Approve or decline, and say what happened. */
  const answer = (swap, approve) => {
    const ok = staff.decideSwap(swap.id, approve);
    toast(!approve ? 'Swap declined' : ok ? 'Swapped' : 'Their shift has changed since, so the swap was cancelled');
    redraw();
  };
  return el('div', { className: 'notice' }, [
    el('strong', { textContent: 'Shift swaps' }),
    ...open.map(({ swap, label }) => (swap.status === 'accepted'
      ? el('div', { className: 'spread' }, [
        el('span', { textContent: label }),
        el('span', { className: 'row-tight' }, [
          el('button', { className: 'btn btn-sm btn-primary', textContent: 'Approve', onclick: () => answer(swap, true) }),
          el('button', { className: 'btn btn-sm', textContent: 'Decline', onclick: () => answer(swap, false) }),
        ]),
      ])
      : el('div', { className: 'faint', textContent: `${label} · waiting for their answer` }))),
  ]);
}

/**
 * Build the list of saved rosters and drafts, by the dates they cover: newest
 * first, or oldest first when that is the setting chosen. Drafts with no dates
 * yet go last either way.
 */
function renderList(rosters, container) {
  const order = store.setting('rosterSort') === 'oldest' ? 'oldest' : 'newest';
  const sorted = [...rosters].sort((a, b) => {
    if (!a.startDate || !b.startDate) return (a.startDate ? 0 : 1) - (b.startDate ? 0 : 1);
    return order === 'oldest' ? a.startDate.localeCompare(b.startDate) : b.startDate.localeCompare(a.startDate);
  });
  const sort = el('select', { 'aria-label': 'Sort rosters' }, [
    el('option', { value: 'newest', textContent: 'Newest first', selected: order === 'newest' }),
    el('option', { value: 'oldest', textContent: 'Oldest first', selected: order === 'oldest' }),
  ]);
  sort.addEventListener('change', () => { store.setSetting('rosterSort', sort.value); render(container); });
  const items = sorted.map((r) => (r.draft ? draftRow(r) : savedRow(r, container)));
  const newBtn = el('button', {
    type: 'button', className: 'btn btn-sm btn-primary', textContent: '+ New roster', onclick: () => show('new'),
  });
  return [
    el('div', { className: 'spread' }, [el('strong', { textContent: 'Rosters' }), el('div', { className: 'row-tight' }, [sort, newBtn])]),
    el('div', { className: 'list' }, items),
  ];
}

/** A row for a saved roster: opens the read-only day-by-day view. */
function savedRow(r, container) {
  const shiftsCount = r.assignments.length;
  return el('button', {
    type: 'button', className: 'item',
    onclick: () => { openId = r.id; render(container); },
  }, [
    el('div', { className: 'item-main' }, [
      el('div', { className: 'item-title', textContent: r.name }),
      el('div', {
        className: 'item-sub',
        textContent: `${formatDate(r.startDate, { withWeekday: false })} – ${formatDate(r.endDate, { withWeekday: false })} · ${shiftsCount} shift${shiftsCount === 1 ? '' : 's'} assigned`,
      }),
    ]),
  ]);
}

/** A row for a draft: reopens it in the builder to keep working on it. */
function draftRow(r) {
  const range = r.startDate
    ? `${formatDate(r.startDate, { withWeekday: false })} – ${formatDate(r.endDate, { withWeekday: false })}`
    : 'No dates picked yet';
  return el('button', {
    type: 'button', className: 'item',
    onclick: () => { builderView.openDraft(r.id); show('new'); },
  }, [
    el('div', { className: 'item-main' }, [
      el('div', { className: 'item-title', textContent: r.name }),
      el('div', { className: 'item-sub', textContent: `${range} · not built yet` }),
    ]),
    el('span', { className: 'item-tag', textContent: 'Draft' }),
  ]);
}

/**
 * Start the next roster from this one: the same days of the week, moved on by
 * whole weeks past its last day, picked in the builder ready to build.
 */
function rollForward(roster) {
  const days = rosterDates(roster);
  if (days.length === 0) return;
  // The roster is passed too, so its per-day shifts carry over to the new dates.
  builderView.startWith(rollOn(days), roster);
  show('new');
}

/**
 * Refill a roster's dates with the scheduler, keeping the places it must:
 * the locked ones, or on a roster being filled in by hand, everyone placed so
 * far. Returns the new assignments and notes; nothing is saved here.
 */
function refill(roster) {
  const kept = roster.byHand
    ? roster.assignments.map((a) => ({ ...a, locked: true }))
    : roster.assignments.filter((a) => a.locked);
  const fresh = buildRoster({
    orgId: roster.orgId, name: roster.name, dates: rosterDates(roster),
    people: store.people(), shifts: store.shifts(), clashes: store.clashes(), roles: store.roles(),
    // Other saved rosters count towards who is due next. This one's own
    // current turns must not, or everyone on it would look over-used.
    history: store.rosters().filter((r) => !r.draft && r.id !== roster.id).flatMap((r) => r.assignments || []),
    locked: kept, dayShifts: roster.dayShifts,
  });
  return { assignments: fresh.assignments, notes: fresh.notes };
}

// Earlier assignments, day shifts and days of the open roster, newest last, for Undo.
const undo = { id: null, stack: [] };

// The last date tapped on the edit screen's days calendar, so the redraw after
// a tap stays on that month rather than jumping back to the roster's first:
// `{ id, date }`, used only while that roster is the one open.
let daysGridAt = null;

/**
 * Edit mode's "Days on this roster": a month calendar with the roster's dates
 * marked. `onTap(date)` adds or takes off the date tapped.
 */
function daysEditor(roster, onTap) {
  const days = new Set(rosterDates(roster));
  const start = daysGridAt?.id === roster.id ? daysGridAt.date : [...days].sort()[0];
  const grid = monthGrid({
    start, openDays: store.openDays(), onTap,
    classOf: (iso) => (days.has(iso) ? 'range-edge' : ''),
  });
  return collapsible('roster-days', 'Days on this roster', [
    el('div', { className: 'faint', textContent: 'Tap a date to add it to this roster, or tap a marked one to take it off.' }),
    grid.node,
  ], { open: false });
}

/** Build the full day-by-day view of one roster, plus everything you can do with it. */
function renderOpen(roster, container) {
  const people = store.people();
  const shifts = store.shifts();
  const redraw = () => render(container);

  const back = el('button', {
    className: 'btn', textContent: '← Rosters',
    onclick: () => { openId = null; redraw(); },
  });

  /** Remember the current assignments and day shifts for Undo before they change. */
  const remember = () => {
    if (undo.id !== roster.id) { undo.id = roster.id; undo.stack = []; }
    const now = store.roster(roster.id);
    undo.stack.push({ assignments: now.assignments, dayShifts: now.dayShifts, days: now.days });
  };

  /**
   * Add `date` to the roster with the usual shifts that run that weekday, or
   * take it off along with anyone placed on it (Undo puts them back).
   */
  const toggleDay = (date) => {
    const current = store.roster(roster.id);
    const had = rosterDates(current);
    const on = had.includes(date);
    if (on && had.length === 1) {
      toast('A roster needs at least one day. Delete it instead.');
      return;
    }
    remember();
    daysGridAt = { id: roster.id, date };
    const days = on ? had.filter((d) => d !== date) : [...had, date].sort();
    const assignments = current.assignments.filter((a) => !on || a.date !== date);
    // A roster without its own day lists (older ones) runs the usual shifts anyway.
    const dayShifts = current.dayShifts ? { ...current.dayShifts } : undefined;
    if (dayShifts && on) delete dayShifts[date];
    if (dayShifts && !on) dayShifts[date] = usualDayShifts(store.shifts(), [date])[date];
    // Counted before saving: updateRoster changes `current` in place.
    const dropped = current.assignments.length - assignments.length;
    const next = { ...current, days, dayShifts, assignments, startDate: days[0], endDate: days[days.length - 1] };
    store.updateRoster(roster.id, {
      days, dayShifts, assignments, startDate: next.startDate, endDate: next.endDate,
      notes: auditRoster(next, store.people(), store.shifts(), store.roles()),
    });
    toast(on
      ? `Took off ${formatDate(date)}${dropped ? ` and ${dropped} place${dropped === 1 ? '' : 's'}` : ''}`
      : `Added ${formatDate(date)}`);
    redraw();
  };

  /** Save a changed list of assignments (an edit or a swap) with its notes re-checked. */
  const change = (next) => {
    remember();
    store.updateRoster(roster.id, {
      assignments: next,
      notes: auditRoster({ ...roster, assignments: next }, store.people(), store.shifts(), store.roles()),
    });
    redraw();
  };

  /** Save a changed set of day shifts (and the assignments that go with it) with its notes re-checked. */
  const changeDays = (dayShifts, assignments) => {
    remember();
    store.updateRoster(roster.id, {
      dayShifts, assignments,
      notes: auditRoster({ ...roster, dayShifts, assignments }, store.people(), store.shifts(), store.roles()),
    });
  };

  /** Refill the roster around what it keeps, and show the result. */
  const rebuild = () => {
    remember();
    // Read it afresh: Fill the gaps ticks someone for a role just before this.
    const current = store.roster(roster.id);
    store.updateRoster(roster.id, { ...refill(current), byHand: false });
    editing = false;
    toast(current.byHand ? 'Filled the rest — your picks are kept' : 'Rebuilt around the locked places');
    redraw();
  };

  /** The who-can-do-what grid over this screen; closing it redraws the roster. */
  const openSkills = () => {
    teamView.openSection('skills');
    openSheet('Who you roster', (body) => teamView.render(body), redraw);
  };

  /** Rename by tapping the title. */
  const rename = async () => {
    const name = await promptText('Rename roster', 'Name', roster.name);
    if (!name) return;
    store.updateRoster(roster.id, { name });
    redraw();
  };

  const cards = editing
    ? editableDayCards(roster, people, shifts, change, (day) => openDayShifts(rosterDaySource(roster.id, changeDays), day, redraw))
    : dayCards(roster, people, shifts, change);

  // Fixing a roster sits right under the title. The main actions (leave, Edit,
  // Send) are in the bar pinned at the foot, and rarer ones wait below the days.
  const actions = [
    undo.id === roster.id && undo.stack.length ? el('button', {
      className: 'btn', textContent: 'Undo',
      onclick: () => {
        const prev = undo.stack.pop();
        const days = prev.days?.length ? prev.days : rosterDates({ ...roster, ...prev });
        store.updateRoster(roster.id, {
          assignments: prev.assignments, dayShifts: prev.dayShifts,
          days: prev.days, startDate: days[0], endDate: days[days.length - 1],
          notes: auditRoster({ ...roster, ...prev }, store.people(), store.shifts(), store.roles()),
        });
        redraw();
      },
    }) : null,
    // By hand: the scheduler can take over the places still empty. Otherwise:
    // refill everything except the locked places.
    roster.byHand ? el('button', {
      className: 'btn btn-primary', textContent: 'Fill the rest for me', onclick: rebuild,
    }) : roster.assignments.some((a) => a.locked) ? el('button', {
      className: 'btn', textContent: 'Rebuild around locked', onclick: rebuild,
    }) : null,
  ];

  const footer = [
    el('button', {
      className: 'btn', textContent: 'Next roster',
      onclick: () => rollForward(roster),
    }),
    el('button', {
      className: 'btn btn-danger', textContent: 'Delete',
      onclick: async () => {
        const ok = await confirmDialog('Delete roster?', 'This cannot be undone.', 'Delete');
        if (!ok) return;
        store.deleteRoster(roster.id);
        openId = null;
        toast('Deleted');
        redraw();
      },
    }),
  ];

  // Changes save as you go, so Done only leaves edit mode and says so.
  const bar = el('div', { className: 'build-bar action-bar' }, [
    el('div', { className: 'build-actions' }, [
      back,
      el('button', {
        className: 'btn', textContent: editing ? 'Done' : 'Edit',
        onclick: () => { if (editing) toast('Saved'); editing = !editing; redraw(); },
      }),
      exportButton(roster, people, shifts, (replies) => {
        // Merged, so answers staff gave on their own link aren't wiped by a check.
        store.updateRoster(roster.id, { responses: { ...roster.responses, ...replies } });
        redraw();
      }),
    ]),
  ]);

  return [
    el('button', {
      type: 'button', className: 'title-btn', onclick: rename, 'aria-label': `Rename ${roster.name}`,
    }, [el('h2', { textContent: roster.name }), el('span', { className: 'faint', textContent: '✎', 'aria-hidden': 'true' })]),
    actions.some(Boolean) ? el('div', { className: 'row' }, actions) : null,
    editing ? null : swapsCard(roster.id, redraw),
    roster.byHand && editing ? el('div', { className: 'notice' }, [
      el('strong', { textContent: 'Filling in by hand' }),
      el('div', {
        textContent: 'Use “+ add” on each shift to put someone on; everyone free that day is listed. '
          + '“Fill the rest for me” keeps who you placed and fills the gaps fairly.',
      }),
    ]) : null,
    editing ? daysEditor(roster, toggleDay) : null,
    // Checked afresh each time, so a date someone sent since it was saved shows here.
    notesBox({ ...roster, notes: auditRoster(roster, people, shifts, store.roles()) }),
    editing ? null : declinedCard(roster, people, shifts, change),
    editing ? null : gapFixes(roster, people, shifts, { rebuild, openSkills }),
    ...cards,
    tally(roster, people, shifts),
    el('div', { className: 'row' }, footer),
    bar,
  ];
}
