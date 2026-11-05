/**
 * The pieces of a roster on screen, shared by the just-built result (New
 * Roster) and an opened saved roster: the day-by-day cards, the "who's on how
 * much" tally, Copy/Share, and manual editing.
 *
 * Manual editing swaps, adds or removes the people on any shift. The scheduler's fill is deterministic and usually right, but the real world
 * throws late swaps at it - someone calls in sick, two people trade a day - and
 * going back to change availability and rebuilding would reshuffle everything
 * else. This lets the roster be nudged in place instead.
 */
import { store } from '../store.js';
import { el, copyText, dialog, downloadText, toast, collapsible } from '../ui.js';
import { canSend, sendToPlanningCenter, checkReplies } from './planning-center.js';
import { responseKey } from '../sources/planning-center.js';
import { formatDate, toDays, counts, canDoRole, canWork, shiftsOn, shiftOn } from '../scheduler.js';
import {
  rosterDays, rosterLines, shiftTimes, formatMessage, formatPerPerson, toCSV, toICS, fileBase,
  hoursByPerson, messageFor,
} from '../export.js';
import * as email from '../email.js';
import * as account from '../account.js';

/**
 * People who could be put on `date` without double-booking them or working
 * them through a blackout.
 *
 * Sorted by name. Someone whose standing weekday pattern doesn't cover the date
 * is still offered - a manual edit is a deliberate override - but the caller
 * flags them so it is a conscious choice, not a slip.
 */
export function candidatesFor(roster, people, date) {
  const busy = new Set(
    roster.assignments.filter((a) => a.date === date).map((a) => a.personId)
  );
  const n = toDays(date);
  return people
    .filter((p) => p.active && !busy.has(p.id))
    .filter((p) => !(p.blackouts || []).some(
      (b) => toDays(b.start) <= n && n <= toDays(b.end)
    ))
    .sort((a, b) => a.name.localeCompare(b.name));
}

/** The shift's name cell on a day card, with its note (if any) faint underneath. */
function shiftName(shift) {
  return el('span', { className: 'sname' }, [
    shift.name,
    shift.note ? el('div', { className: 'faint', textContent: shift.note }) : null,
  ]);
}

/** The faint line a day with no shifts shows. */
function noShifts() {
  return el('div', { className: 'faint', textContent: 'No shifts this day' });
}

/**
 * The "Shifts and events" button under a date in edit mode, or null when
 * there is nothing to call (`onEditDay` not given).
 */
function editDayButton(day, onEditDay) {
  return onEditDay ? el('button', {
    type: 'button', className: 'btn btn-sm', textContent: 'Shifts and events ›',
    onclick: () => onEditDay(day),
  }) : null;
}

/**
 * One shift's row in edit mode when the shift is made of roles: a line per
 * role with its people as removable chips and a picker of those who can do it.
 * Anyone on the shift under a role it no longer lists keeps a chip under
 * "Others", so editing never hides a saved assignment.
 */
function editableRoleRow(roster, people, shift, day, here, roleById, apply) {
  const nameOf = (id) => people.find((p) => p.id === id)?.name || '(removed)';
  const listed = new Set(shift.roles.map((r) => r.roleId));
  const slots = shift.roles.map((r) => ({
    roleId: r.roleId, count: r.count, label: roleById.get(r.roleId)?.name || '(removed role)',
    mine: here.filter((a) => a.roleId === r.roleId),
  }));
  const strays = here.filter((a) => !listed.has(a.roleId ?? null));
  if (strays.length) slots.push({ roleId: null, count: 0, label: 'Others', mine: strays, noAdd: true });

  const lines = slots.map((slot) => {
    const chips = slot.mine.map((a) => el('span', { className: 'edit-chip' }, [
      nameOf(a.personId),
      el('button', {
        type: 'button', className: 'edit-x', textContent: '×',
        'aria-label': `Remove ${nameOf(a.personId)} from ${shift.name}, ${slot.label}, on ${day}`,
        onclick: () => apply(roster.assignments.filter((x) => x !== a)),
      }),
    ]));
    const candidates = slot.noAdd ? [] : candidatesFor(roster, people, day)
      .filter((p) => canDoRole(p, slot.roleId, roleById));
    let adder = null;
    if (candidates.length) {
      const select = el('select', { className: 'edit-add' }, [
        el('option', { value: '', textContent: slot.mine.length < slot.count ? '+ add' : '+ add another' }),
        ...candidates.map((p) => el('option', {
          value: String(p.id),
          textContent: canWork(p, day) ? p.name : `${p.name} · usually off`,
        })),
      ]);
      select.addEventListener('change', () => {
        const id = Number(select.value);
        if (id) apply([...roster.assignments, { date: day, shiftId: shift.id, personId: id, roleId: slot.roleId, locked: true }]);
      });
      adder = select;
    }
    const short = slot.mine.length < slot.count;
    return el('div', { className: short ? 'swho edit gap' : 'swho edit' }, [
      el('span', { className: 'faint', textContent: `${slot.label}: ` }),
      ...chips,
      adder,
      !chips.length && !adder ? el('span', { className: 'faint', textContent: 'nobody free' }) : null,
    ]);
  });
  return el('div', { className: 'day-shift' }, [shiftName(shift), el('div', {}, lines)]);
}

/**
 * The day-by-day cards in edit mode: every shift row shows its people as
 * removable chips plus an "add" picker. `apply(nextAssignments)` is called with
 * a new assignments array on every change and is responsible for persisting it
 * and re-rendering. `onEditDay(day)`, when given, adds a button under each date
 * that opens that day's shifts for changing.
 */
export function editableDayCards(roster, people, shifts, apply, onEditDay = null) {
  const nameOf = (id) => people.find((p) => p.id === id)?.name || '(removed)';
  const roles = store.roles();
  const roleById = new Map(roles.map((r) => [r.id, r]));
  return rosterDays(roster).map((day) => {
    const rows = shiftsOn(roster, day, shifts).map((shift) => {
      const here = roster.assignments.filter(
        (a) => a.date === day && a.shiftId === shift.id
      );
      if (shift.roles?.length) return editableRoleRow(roster, people, shift, day, here, roleById, apply);
      const candidates = candidatesFor(roster, people, day);

      // One removable chip per person currently on this shift.
      const chips = here.map((a) => el('span', { className: 'edit-chip' }, [
        nameOf(a.personId),
        el('button', {
          type: 'button', className: 'edit-x', textContent: '×',
          'aria-label': `Remove ${nameOf(a.personId)} from ${shift.name} on ${day}`,
          onclick: () => apply(roster.assignments.filter((x) => x !== a)),
        }),
      ]));

      // A picker of everyone who could take a place on this shift.
      let adder = null;
      if (candidates.length) {
        const select = el('select', { className: 'edit-add' }, [
          el('option', {
            value: '',
            textContent: here.length < shift.headcount ? '+ add' : '+ add another',
          }),
          ...candidates.map((p) => el('option', {
            value: String(p.id),
            textContent: canWork(p, day)
              ? p.name
              : `${p.name} · usually off`,
          })),
        ]);
        select.addEventListener('change', () => {
          const id = Number(select.value);
          if (id) {
            apply([...roster.assignments, { date: day, shiftId: shift.id, personId: id, locked: true }]);
          }
        });
        adder = select;
      }

      const short = here.length < shift.headcount;
      return el('div', { className: 'day-shift' }, [
        shiftName(shift),
        el('span', { className: short ? 'swho edit gap' : 'swho edit' }, [
          ...chips,
          adder,
          !chips.length && !adder
            ? el('span', { className: 'faint', textContent: 'nobody free' })
            : null,
        ]),
      ]);
    });

    return el('div', { className: 'day-card' }, [
      el('div', { className: 'day-date', textContent: formatDate(day) }),
      editDayButton(day, onEditDay),
      ...(rows.length ? rows : [noShifts()]),
    ]);
  });
}

/**
 * Offer a replacement for one person on a built roster: anyone not already on
 * that day who can do the role (even someone away, marked, since they may want
 * the extra shift), or a swap with someone on another place, that day or any
 * other day of the roster. Choosing one applies the change through `apply`;
 * "Take off" just removes them.
 */
export async function pickReplacement(roster, people, shifts, assignment, roleById, apply) {
  const nameOf = (id) => people.find((p) => p.id === id)?.name || '(removed)';
  const shiftOf = (id, date) => shiftOn(roster, date, id, shifts)?.name || '(removed)';
  const roleLabel = (a) => (a.roleId != null ? `, ${roleById.get(a.roleId)?.name || 'removed role'}` : '');
  const day = assignment.date;
  const onDay = (personId, date) => roster.assignments.some((a) => a.date === date && a.personId === personId);

  // Free people who can do this place first, then those away that day.
  const free = candidatesFor(roster, people, day);
  const away = people
    .filter((p) => p.active && !onDay(p.id, day) && !free.includes(p))
    .sort((a, b) => a.name.localeCompare(b.name));
  const givable = [...free, ...away].filter((p) => canDoRole(p, assignment.roleId ?? null, roleById));
  // Others on the roster, if each can do the other's place and neither would
  // end up on the same day twice.
  const swaps = roster.assignments.filter((b) => {
    if (b === assignment || b.personId === assignment.personId) return false;
    const pa = people.find((p) => p.id === assignment.personId);
    const pb = people.find((p) => p.id === b.personId);
    if (!pa || !pb || !canDoRole(pb, assignment.roleId ?? null, roleById) || !canDoRole(pa, b.roleId ?? null, roleById)) return false;
    return b.date === day || (!onDay(pa.id, b.date) && !onDay(pb.id, day));
  }).sort((x, y) => x.date.localeCompare(y.date));
  const sameDay = swaps.filter((b) => b.date === day);
  const otherDays = swaps.filter((b) => b.date !== day);

  const choice = await dialog((close) => {
    const option = (label, sub, next) => el('button', {
      type: 'button', className: 'item', onclick: () => close({ next }),
    }, [el('div', { className: 'item-main' }, [
      el('div', { className: 'item-title', textContent: label }),
      sub ? el('div', { className: 'item-sub', textContent: sub }) : null,
    ])]);
    return [
      el('h2', { textContent: nameOf(assignment.personId) }),
      el('div', { className: 'faint', textContent: `${formatDate(day)} · ${shiftOf(assignment.shiftId, day)}${roleLabel(assignment)}` }),
      givable.length ? el('label', { className: 'label', textContent: 'Replace with' }) : null,
      el('div', { className: 'list' }, givable.map((p) => option(
        p.name,
        !free.includes(p) ? 'away that day'
          : canWork(p, day) ? null : 'usually off this day',
        // A hand-made change is pinned, so a rebuild keeps it.
        roster.assignments.map((a) => (a === assignment ? { ...a, personId: p.id, locked: true } : a)),
      ))),
      ...[['Swap with', sameDay], ['Swap with someone on another day', otherDays]].flatMap(([title, list]) => [
        list.length ? el('label', { className: 'label', textContent: title }) : null,
        el('div', { className: 'list' }, list.map((b) => option(
          nameOf(b.personId),
          `${b.date === day ? '' : `${formatDate(b.date)} · `}${shiftOf(b.shiftId, b.date)}${roleLabel(b)}`,
          // Each takes the other's place, both pinned.
          roster.assignments.map((a) => {
            if (a === assignment) return { ...a, personId: b.personId, locked: true };
            if (a === b) return { ...a, personId: assignment.personId, locked: true };
            return a;
          }),
        ))),
      ]),
      !givable.length && !swaps.length ? el('div', { className: 'muted', textContent: 'Nobody else can take this place.' }) : null,
      el('div', { className: 'modal-actions' }, [
        el('button', {
          className: 'btn', textContent: assignment.locked ? 'Unlock' : 'Lock here',
          onclick: () => close({ next: roster.assignments.map((a) => (a === assignment ? { ...a, locked: !a.locked } : a)) }),
        }),
        el('button', {
          className: 'btn btn-danger', textContent: 'Take off',
          onclick: () => close({ next: roster.assignments.filter((a) => a !== assignment) }),
        }),
        el('button', { className: 'btn', textContent: 'Cancel', onclick: () => close(null) }),
      ]),
    ];
  });
  if (choice) apply(choice.next);
}

/**
 * Offer everyone who could fill an empty place - free that day, not already
 * on, and able to do the role - and put the one chosen on it. Like any
 * hand-made change it is locked, so a rebuild keeps it. Someone who doesn't
 * usually work that weekday is still offered, marked, as a deliberate choice.
 */
async function pickToAdd(roster, people, shift, day, roleId, roleById, apply) {
  const free = candidatesFor(roster, people, day).filter((p) => canDoRole(p, roleId, roleById));
  const role = roleId != null ? roleById.get(roleId)?.name : null;

  const chosen = await dialog((close) => [
    el('h2', { textContent: `Add to ${shift.name}${role ? `, ${role}` : ''}` }),
    el('div', { className: 'faint', textContent: formatDate(day) }),
    free.length
      ? el('div', { className: 'list' }, free.map((p) => el('button', {
        type: 'button', className: 'item', onclick: () => close(p),
      }, [el('div', { className: 'item-main' }, [
        el('div', { className: 'item-title', textContent: p.name }),
        canWork(p, day) ? null
          : el('div', { className: 'item-sub', textContent: 'usually off this day' }),
      ])])))
      : el('div', { className: 'muted', textContent: role
        ? `Nobody else free that day can do ${role}. Tick more people for it on Team → Skills.`
        : 'Everyone is either on already or away that day.' }),
    el('div', { className: 'modal-actions' }, [
      el('button', { className: 'btn', textContent: 'Cancel', onclick: () => close(null) }),
    ]),
  ]);
  if (chosen) {
    // A shift without roles keeps its places role-free, as the scheduler makes them.
    const place = { date: day, shiftId: shift.id, personId: chosen.id, locked: true };
    if (roleId != null) place.roleId = roleId;
    apply([...roster.assignments, place]);
  }
}

/**
 * A card listing everyone who declined, on Planning Center or on their own
 * link, each with a button to replace them. Null when nobody has.
 */
export function declinedCard(roster, people, shifts, apply) {
  const roleById = new Map(store.roles().map((r) => [r.id, r]));
  const declined = roster.assignments.filter((a) => roster.responses?.[responseKey(a)] === 'D');
  if (declined.length === 0) return null;
  const nameOf = (id) => people.find((p) => p.id === id)?.name || '(removed)';
  const shiftOf = (id, date) => shiftOn(roster, date, id, shifts)?.name || '(removed)';
  return el('div', { className: 'notice bad' }, [
    el('strong', { textContent: `${declined.length} declined` }),
    ...declined.map((a) => el('div', { className: 'spread' }, [
      el('span', { textContent: `${nameOf(a.personId)} · ${formatDate(a.date, { withWeekday: false })} · ${shiftOf(a.shiftId, a.date)}` }),
      el('button', {
        className: 'btn btn-sm', textContent: 'Replace',
        onclick: () => pickReplacement(roster, people, shifts, a, roleById, apply),
      }),
    ])),
  ]);
}

/**
 * Read-only day cards: one per date, one row per shift.
 *
 * Every current shift is shown on every day, so a shift nobody could take
 * reads "Nobody available" rather than silently vanishing. A shift deleted
 * since the roster was saved still shows its people, last, as "(removed)".
 */
export function dayCards(roster, people, shifts, apply = null) {
  const nameOf = new Map(people.map((p) => [p.id, p.name]));
  const roles = store.roles();
  const roleById = new Map(roles.map((r) => [r.id, r]));

  /** The people on a place, as names - buttons that offer a swap when `apply` is given. */
  const nameNodes = (list) => list.flatMap((a, i) => {
    const name = nameOf.get(a.personId) || '(removed)';
    // Padlock for a pinned place; tick or cross for a Planning Center reply.
    const reply = roster.responses?.[responseKey(a)];
    const label = `${name}${a.locked ? ' 🔒' : ''}${reply === 'C' ? ' ✓' : reply === 'D' ? ' ✕' : ''}`;
    const mark = reply === 'D' ? 'name-btn declined' : 'name-btn';
    return [i ? ', ' : null, apply ? el('button', {
      type: 'button', className: mark, textContent: label,
      onclick: () => pickReplacement(roster, people, shifts, a, roleById, apply),
    }) : el('span', { className: reply === 'D' ? 'declined' : '', textContent: label })];
  });

  /**
   * "+ add" beside a place that is short, so a gap can be filled with a tap
   * rather than a trip into Edit. Only when the roster can be changed.
   */
  const addButton = (day, shift, roleId) => (apply ? el('button', {
    type: 'button', className: 'btn btn-sm gap-add', textContent: '+ add',
    'aria-label': `Add someone to ${shift.name}${roleId != null ? `, ${roleById.get(roleId)?.name || ''}` : ''} on ${day}`,
    onclick: () => pickToAdd(roster, people, shift, day, roleId, roleById, apply),
  }) : null);

  return rosterDays(roster).map((day) => {
    const todays = roster.assignments.filter((a) => a.date === day);
    // The shifts this day runs; a shift not among them is "(removed)".
    const dayList = shiftsOn(roster, day, shifts);
    const known = new Set(dayList.map((s) => s.id));
    const extraIds = [...new Set(todays.map((a) => a.shiftId))].filter((id) => !known.has(id));

    const rows = [...dayList, ...extraIds.map((id) => ({ id, name: '(removed)', headcount: 0 }))]
      .map((shift) => {
        // A shift made of roles: a line per role, flagged when it is short.
        const here = todays.filter((a) => a.shiftId === shift.id);
        if (shift.roles?.length) {
          const listed = new Set(shift.roles.map((r) => r.roleId));
          const places = shift.roles.map((r) => ({
            roleId: r.roleId,
            label: roleById.get(r.roleId)?.name || '(removed role)', count: r.count,
            mine: here.filter((a) => a.roleId === r.roleId),
          }));
          const strays = here.filter((a) => !listed.has(a.roleId ?? null));
          if (strays.length) places.push({ label: 'Others', count: 0, mine: strays });
          return el('div', { className: 'day-shift' }, [
            shiftName(shift),
            el('div', {}, places.map((p) => {
              const short = Math.max(0, p.count - p.mine.length);
              return el('div', { className: short ? 'swho gap' : 'swho' }, [
                `${p.label}: `,
                ...(p.mine.length ? nameNodes(p.mine) : ['nobody']),
                short && p.mine.length ? ` (needs ${short} more)` : null,
                short && p.roleId !== undefined ? addButton(day, shift, p.roleId) : null,
              ]);
            })),
          ]);
        }

        let gap = false;
        let tail = null;
        if (here.length === 0) {
          gap = true;
        } else if (here.length < shift.headcount) {
          tail = ` (needs ${shift.headcount - here.length} more)`;
          gap = true;
        }
        return el('div', { className: 'day-shift' }, [
          shiftName(shift),
          el('span', { className: gap ? 'swho gap' : 'swho' }, [
            ...(here.length ? nameNodes(here) : ['Nobody available']), tail,
            // A removed shift has nothing left to fill.
            gap && known.has(shift.id) ? addButton(day, shift, null) : null,
          ]),
        ]);
      });

    return el('div', { className: 'day-card' }, [
      el('div', { className: 'day-date', textContent: formatDate(day) }),
      ...(rows.length ? rows : [noShifts()]),
    ]);
  });
}

/** "Who's on how much": one chip per person, busiest first. */
export function tally(roster, people, shifts = []) {
  const nameOf = new Map(people.map((p) => [p.id, p.name]));
  const hours = hoursByPerson(roster, shifts);
  const entries = [...counts(roster).entries()]
    .map(([id, n]) => [nameOf.get(id) || '(removed)', n, hours.get(id) || 0, id])
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));

  // Hours only when the shifts have times; an estimated pay total only when someone has a rate.
  const fmt = (h) => `${Math.round(h * 10) / 10}h`;
  const chips = entries.map(([name, n, h]) => (
    el('span', { className: 'chip' }, [`${name} `, el('b', { textContent: String(n) }), h ? ` · ${fmt(h)}` : ''])
  ));
  const cost = people.reduce((sum, p) => sum + (p.hourlyRate ? (hours.get(p.id) || 0) * p.hourlyRate : 0), 0);
  return el('div', {}, [
    el('div', { className: 'tally' }, chips),
    cost ? el('div', { className: 'faint', textContent: `Estimated pay: $${cost.toFixed(2)} for people with a pay rate set` }) : null,
  ]);
}

/**
 * A list of everyone on the roster with their own message, to text, email or
 * share one by one. People with a mobile or email saved get a button that opens
 * the phone's messages or mail with the message filled in.
 */
function openMessages(roster, people, shifts) {
  const roles = store.roles();
  const rows = people
    .map((person) => ({ person, text: messageFor(roster, person, shifts, roles) }))
    .filter((x) => x.text)
    .sort((a, b) => a.person.name.localeCompare(b.person.name))
    .map(({ person, text }) => {
      const link = (label, href) => el('a', { className: 'btn btn-sm', href, textContent: label });
      return el('div', { className: 'export-row' }, [
        el('div', { className: 'item-main' }, [
          el('div', { className: 'item-title', textContent: person.name }),
          el('div', { className: 'item-sub', textContent: text.split('\n').slice(1).join(' ').replace(/• /g, '') }),
        ]),
        el('div', { className: 'row-tight' }, [
          person.phone ? link('Text', `sms:${person.phone}?&body=${encodeURIComponent(text)}`) : null,
          person.email ? link('Email', `mailto:${encodeURIComponent(person.email).replace(/%40/g, '@')}?subject=${encodeURIComponent(roster.name)}&body=${encodeURIComponent(text)}`) : null,
          el('button', {
            className: 'btn btn-sm', textContent: navigator.share ? 'Share' : 'Copy',
            onclick: () => (navigator.share ? shareText(roster.name, text) : copyText(text)),
          }),
        ]),
      ]);
    });
  return dialog((close) => [
    el('h2', { textContent: 'Message each person' }),
    rows.length ? el('div', { className: 'list' }, rows) : el('div', { className: 'muted', textContent: 'Nobody is on this roster yet.' }),
    el('div', { className: 'faint', textContent: 'Add a mobile or email on a person\'s page to get a Text or Email button.' }),
    el('div', { className: 'modal-actions' }, [
      el('button', { className: 'btn btn-primary', textContent: 'Done', onclick: () => close() }),
    ]),
  ]);
}

/** "Ann, Sam and Lee" - names in a sentence. */
function nameList(names) {
  return names.length < 2 ? names.join('') : `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`;
}

/**
 * Email everyone on the roster their own shifts, sent by the server so no
 * mail app opens. It always asks first: who will get one, who won't and why,
 * who it comes from and where replies go, and that this is the one time the
 * roster leaves the phone unencrypted. Afterwards it says who was emailed.
 */
async function emailEveryone(roster, people, shifts) {
  const { messages, skipped } = email.emailList(roster, people, shifts, store.roles());
  const org = store.currentOrg();
  const signedIn = account.current();
  const skippedLine = skipped.length
    ? el('p', {
      className: 'muted',
      textContent: `Not emailed: ${skipped.map((s) => `${s.person.name} (${s.why})`).join(', ')}. `
        + 'Add an email on their page, or use Message each person.',
    })
    : null;

  if (!signedIn || !messages.length) {
    return dialog((close) => [
      el('h2', { textContent: 'Email everyone' }),
      el('p', {
        textContent: !signedIn
          ? 'Sign in first (Settings, Account). Emails are sent for your account, so only you can send them.'
          : 'Nobody on this roster has an email saved.',
      }),
      signedIn ? skippedLine : null,
      el('div', { className: 'modal-actions' }, [
        el('button', { className: 'btn btn-primary', textContent: 'OK', onclick: () => close() }),
      ]),
    ]);
  }

  const replyTo = org.replyEmail || signedIn.email;
  const n = messages.length;
  const err = el('div', { className: 'err' });
  const sendBtn = el('button', { className: 'btn btn-primary', textContent: `Send ${n} email${n === 1 ? '' : 's'}` });
  const sent = await dialog((close) => {
    sendBtn.onclick = async () => {
      sendBtn.disabled = true;
      sendBtn.textContent = 'Sending…';
      err.textContent = '';
      try {
        await email.sendRoster(org, roster.name, messages);
        close(true);
      } catch (e) {
        err.textContent = e.message;
        sendBtn.disabled = false;
        sendBtn.textContent = 'Try again';
      }
    };
    return [
      el('h2', { textContent: 'Email everyone?' }),
      el('p', {
        textContent: `${n === 1 ? '1 person gets' : `${n} people get`} an email with just their own shifts: `
          + nameList(messages.map((m) => m.person.name)) + '.',
      }),
      skippedLine,
      el('p', {
        className: 'muted',
        textContent: `It comes from "${org.name} via RosterWarden", and replies go to ${replyTo}.`
          + (org.replyEmail ? '' : ' To use a business email instead, set one in Settings, Name, email and opening hours.'),
      }),
      el('p', {
        className: 'faint',
        textContent: "Your rosters are encrypted, so our server can't read them. To send these, each person's "
          + "message goes to our server and our email service as plain text. We don't keep it; the email service "
          + 'keeps a copy of sent emails for a short while, as any email service does.',
      }),
      err,
      el('div', { className: 'modal-actions' }, [
        el('button', { className: 'btn', textContent: 'Cancel', onclick: () => close(false) }),
        sendBtn,
      ]),
    ];
  });
  if (!sent) return null;
  return dialog((close) => [
    el('h2', { textContent: 'Emails sent' }),
    el('p', { textContent: `Emailed ${nameList(messages.map((m) => m.person.name))}.` }),
    skippedLine,
    el('div', { className: 'modal-actions' }, [
      el('button', { className: 'btn btn-primary', textContent: 'Done', onclick: () => close() }),
    ]),
  ]);
}

/** The "N things to check" box above a roster, or null when there are none. */
/**
 * The roles a built roster left short, with who could fill them if they were
 * ticked for it: `[{ role, days, missing, candidates }]`. A candidate is an
 * active person not yet ticked for the role who is free on at least one of the
 * days it was short. Roles open to anyone are never short for want of a tick.
 */
export function roleGaps(roster, people, shifts, roles) {
  const days = roster.days?.length ? roster.days : [...new Set(roster.assignments.map((a) => a.date))];
  const found = new Map();   // roleId -> { days: Set, missing, shortDays: [] }
  for (const day of days) {
    for (const shift of shiftsOn(roster, day, shifts)) {
      for (const r of shift.roles || []) {
        const n = roster.assignments.filter(
          (a) => a.date === day && a.shiftId === shift.id && a.roleId === r.roleId
        ).length;
        if (n >= r.count) continue;
        const f = found.get(r.roleId) || { days: new Set(), missing: 0, shortDays: [] };
        f.days.add(day); f.missing += r.count - n; f.shortDays.push(day);
        found.set(r.roleId, f);
      }
    }
  }
  return [...found].map(([roleId, f]) => ({
    role: roles.find((r) => r.id === roleId),
    days: f.days.size,
    missing: f.missing,
    candidates: people
      .filter((p) => p.active && !(p.roleIds || []).includes(roleId) && f.shortDays.some((d) => canWork(p, d)))
      .sort((a, b) => a.name.localeCompare(b.name)),
  })).filter((g) => g.role && !g.role.anyone);
}

/**
 * A card that turns "Drums: only 0 of 1 filled" into a fix: pick someone who
 * can play it, and they are ticked for the role and the roster is rebuilt.
 * `rebuild` rebuilds the roster; `openSkills` opens the who-can-do-what grid.
 */
export function gapFixes(roster, people, shifts, { rebuild, openSkills }) {
  const gaps = roleGaps(roster, people, shifts, store.roles());
  if (gaps.length === 0) return null;
  const rows = gaps.map((g) => {
    const label = `${g.role.name}: short on ${g.days} day${g.days === 1 ? '' : 's'}`;
    if (g.candidates.length === 0) {
      return el('div', {}, [label, el('div', { className: 'faint', textContent: 'Nobody else is free on those days.' })]);
    }
    const pick = el('select', {}, [
      el('option', { value: '', textContent: `Who else can do ${g.role.name}?` }),
      ...g.candidates.map((p) => el('option', { value: String(p.id), textContent: p.name })),
    ]);
    pick.addEventListener('change', () => {
      const person = people.find((p) => p.id === Number(pick.value));
      if (!person) return;
      store.updatePerson(person.id, { roleIds: [...(person.roleIds || []), g.role.id] });
      toast(`${person.name} can now do ${g.role.name}`);
      rebuild();
    });
    return el('div', {}, [label, pick]);
  });
  return el('div', { className: 'card' }, [
    el('strong', { textContent: 'Fill the gaps' }),
    ...rows,
    el('button', { className: 'btn btn-sm', textContent: 'See who can do what', onclick: openSkills }),
  ]);
}

/**
 * The notes as display lines: every "X asked for <date> but could not be
 * fitted in." for one person becomes a single line listing their dates.
 */
function groupNotes(notes) {
  const out = [];
  const askers = new Map();   // name -> the line object holding their dates
  for (const note of notes) {
    const m = /^(.+) asked for (.+) but could not be fitted in\.$/.exec(note);
    if (!m) { out.push(note); continue; }
    if (!askers.has(m[1])) {
      const line = { name: m[1], dates: [] };
      askers.set(m[1], line);
      out.push(line);
    }
    askers.get(m[1]).dates.push(m[2].replace(/ \d{4}$/, ''));
  }
  return out.map((x) => (typeof x === 'string' ? x
    : `${x.name} asked for ${x.dates.join(', ')} but could not be fitted in.`));
}

/** The things to check, folded away until opened so a long list doesn't push the roster off screen. */
export function notesBox(roster) {
  if (roster.notes.length === 0) return null;
  const lines = groupNotes(roster.notes);
  const n = lines.length;
  return collapsible(
    'notes', `${n} thing${n === 1 ? '' : 's'} to check`,
    el('ul', {}, lines.map((line) => el('li', { textContent: line }))),
    { open: false, className: 'notice bad' },
  );
}

/** The Send button for a roster; opens the share and export menu. */
export function exportButton(roster, people, shifts, onReplies = () => {}) {
  return el('button', {
    className: 'btn btn-primary', textContent: 'Send',
    onclick: () => openExport(roster, people, shifts, onReplies),
  });
}

/**
 * Hand text to the phone's share sheet, falling back to the clipboard where
 * there is none. Closing the share sheet is not an error, so it is swallowed.
 */
async function shareText(title, text) {
  if (!navigator.share) return copyText(text);
  try {
    await navigator.share({ title, text });
  } catch (e) {
    if (e?.name !== 'AbortError') copyText(text);
  }
}

/**
 * The export menu: message and per-person text (copy or share), print, and
 * calendar / spreadsheet files. It stays open so several can be done in a row.
 */
function openExport(roster, people, shifts, onReplies) {
  const base = fileBase(roster);

  /** One row of the menu: what it is, a line on when to use it, its buttons. */
  const row = (title, hint, actions) => el('div', { className: 'export-row' }, [
    el('div', { className: 'item-main' }, [
      el('div', { className: 'item-title', textContent: title }),
      el('div', { className: 'item-sub', textContent: hint }),
    ]),
    el('div', { className: 'row-tight' }, actions),
  ]);
  /** Copy and (where there is a share sheet) Share buttons for some text. */
  const textButtons = (make) => [
    el('button', { className: 'btn btn-sm', textContent: 'Copy', onclick: () => copyText(make()) }),
    navigator.share
      ? el('button', { className: 'btn btn-sm', textContent: 'Share', onclick: () => shareText(roster.name, make()) })
      : null,
  ];
  /** A button that saves a generated file. */
  const fileButton = (label, name, make, type) => el('button', {
    className: 'btn btn-sm', textContent: label,
    onclick: () => downloadText(name, make(), type),
  });

  return dialog((close) => [
    el('h2', { textContent: 'Share or export' }),
    el('div', { className: 'list' }, [
      row('Message', 'For a group chat or email: each day and who is on.',
        textButtons(() => formatMessage(roster, people, shifts, store.roles()))),
      row("Each person's shifts", 'One line per person, to message people one by one.',
        textButtons(() => formatPerPerson(roster, people, shifts, store.roles()))),
      row('Message each person', 'Their own dates, to text, email or share one by one.', [
        el('button', {
          className: 'btn btn-sm', textContent: 'Open',
          onclick: () => { close(); openMessages(roster, people, shifts); },
        }),
      ]),
      email.isAvailable() ? row('Email everyone', 'Each person gets their own shifts by email, sent for you. It asks first.', [
        el('button', {
          className: 'btn btn-sm', textContent: 'Email…',
          onclick: () => { close(); emailEveryone(roster, people, shifts); },
        }),
      ]) : null,
      row('Print or PDF', 'A clean page for the noticeboard. Choose "Save as PDF" to email it.', [
        el('button', {
          className: 'btn btn-sm', textContent: 'Print',
          onclick: () => { close(); printRoster(roster, people, shifts); },
        }),
      ]),
      row('Calendar', "An .ics file people can add to their phone's calendar.", [
        fileButton('Download', `${base}.ics`, () => toICS(roster, people, shifts, new Date(), store.roles()), 'text/calendar'),
      ]),
      row('Spreadsheet', 'A .csv file for Excel or Google Sheets.', [
        fileButton('Download', `${base}.csv`, () => toCSV(roster, people, shifts, store.roles()), 'text/csv'),
      ]),
      canSend() ? row('Planning Center', 'Add everyone to the plans. It shows what will happen first.', [
        el('button', {
          className: 'btn btn-sm', textContent: 'Send…',
          onclick: () => { close(); sendToPlanningCenter(roster, (text) => { if (text) toast(text); }); },
        }),
        el('button', {
          className: 'btn btn-sm', textContent: 'Check replies',
          onclick: async () => {
            close();
            const replies = await checkReplies(roster);
            if (replies) onReplies(replies);
          },
        }),
      ]) : null,
    ]),
    el('div', { className: 'modal-actions' }, [
      el('button', { className: 'btn btn-primary', textContent: 'Done', onclick: () => close() }),
    ]),
  ]);
}

/**
 * Print the roster on its own: a plain table, one row per day and a column
 * per shift, on a white page. The app itself is hidden while printing (see
 * `body.printing` in app.css), and the sheet is removed again afterwards.
 */
export function printRoster(roster, people, shifts) {
  const lines = rosterLines(roster, people, shifts, store.roles());
  // One column per distinct shift across the days (they differ when days have their own shifts).
  const columns = [];
  for (const day of lines) {
    for (const { shift } of day.shifts) {
      if (!columns.some((c) => c.id === shift.id)) columns.push(shift);
    }
  }

  const head = el('tr', {}, [
    el('th', { textContent: 'Date' }),
    ...columns.map((shift) => el('th', {}, [
      shift.name,
      shiftTimes(shift) ? el('div', { className: 'print-times', textContent: shiftTimes(shift) }) : null,
    ])),
  ]);
  const body = lines.map((day) => el('tr', {}, [
    el('td', { className: 'print-date', textContent: formatDate(day.date) }),
    ...columns.map((col) => {
      // A shift that does not run this day leaves its cell empty.
      const { groups, short } = day.shifts.find((x) => x.shift.id === col.id) || { groups: [], short: 0 };
      return el('td', {}, [
        groups.flatMap((g) => g.names.map((n) => (g.role ? `${n} (${g.role})` : n))).join(', ') || null,
        short ? el('div', { className: 'print-gap', textContent: groups.some((g) => g.names.length) ? `needs ${short} more` : 'unfilled' }) : null,
      ]);
    }),
  ]));

  const sheet = el('section', { id: 'print-sheet' }, [
    el('h1', { textContent: roster.name }),
    el('table', {}, [el('thead', {}, head), el('tbody', {}, body)]),
    el('p', { className: 'print-foot', textContent: 'Made with RosterWarden' }),
  ]);

  document.getElementById('print-sheet')?.remove();
  document.body.append(sheet);
  document.body.classList.add('printing');

  /** Put the app back once the print dialog closes. */
  const done = () => {
    document.body.classList.remove('printing');
    sheet.remove();
  };
  window.addEventListener('afterprint', done, { once: true });
  // Let the closing dialog leave the screen before the print snapshot is taken.
  setTimeout(() => window.print(), 50);
}
