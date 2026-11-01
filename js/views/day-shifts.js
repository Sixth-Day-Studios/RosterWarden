/**
 * The "Shifts and events" sheet: change one day's shifts and events - name,
 * times, people needed, roles, a note - take one off that day, or add one (a
 * shift, which recurs, or an event: a one-off marked `event: true`). It
 * works on a saved roster, or on the plan for a roster
 * not built yet (see `rosterDaySource` and New Roster). Like the Team tab it
 * saves as you go. Only that day's list changes unless "Same on every day" is
 * tapped.
 */
import { store } from '../store.js';
import { el, fill, toast, confirmDialog, openSheet, TIME_STEP_SECONDS } from '../ui.js';
import { formatDate, copyDayShifts, rosterDates } from '../scheduler.js';
import { saidYes, cancelWarning } from '../staff.js';

/** Whole number of 0 or more from a text value, or null when it isn't one. */
function wholeNumber(raw) {
  const text = raw.trim();
  const n = Number(text);
  return text === '' || !Number.isInteger(n) || n < 0 ? null : n;
}

/**
 * The source for a saved roster's day sheet. `save(dayShifts, assignments)`
 * persists a change (and is where undo and notes live).
 */
export function rosterDaySource(rosterId, save) {
  return {
    dates: rosterDates(store.roster(rosterId)),
    // Every date's list, filling in any date an older roster lacks.
    getLists: () => copyDayShifts(store.roster(rosterId), store.shifts()),
    setLists: save,
    getAssignments: () => store.roster(rosterId).assignments,
    // Who said they can do these places, for the confirm before taking them off.
    saidYes: (places) => saidYes(store.roster(rosterId), places),
  };
}

/**
 * Open the sheet for `day` of a source: `{ dates, getLists(), setLists(lists,
 * assignments), getAssignments? }`. `getLists` gives the full `{ date:
 * entries }` for `dates`; `setLists` saves it. Without `getAssignments` (a plan
 * with nobody placed yet) removing a shift never asks. `onClose` runs when the
 * sheet closes so the screen behind can redraw.
 */
export function openDayShifts(source, day, onClose) {
  /** The day's lists for every date. */
  const listsNow = () => source.getLists();

  /** The places made so far, or undefined when the source has none. */
  const assignmentsNow = () => source.getAssignments?.();

  /** Save the day's entries as `change(entries)` returns them, keeping other days as they are. */
  const commit = (change, assignments = assignmentsNow()) => {
    const lists = listsNow();
    source.setLists({ ...lists, [day]: change(lists[day]) }, assignments);
  };

  /** The saved version of one entry of the day (inputs may hold older copies). */
  const latestOf = (id) => listsNow()[day].find((e) => e.id === id);

  /** Save a change to one entry of the day; nothing is saved if no field would change. */
  const patchEntry = (id, patch) => {
    const latest = latestOf(id);
    if (!latest || Object.keys(patch).every((k) => JSON.stringify(latest[k]) === JSON.stringify(patch[k]))) return;
    commit((entries) => entries.map((e) => (e.id === id ? { ...e, ...patch } : e)));
  };

  openSheet(formatDate(day), (body) => draw(body), onClose);

  /** Draw the day's shift cards and the "add shift" picker into `body`. */
  function draw(body) {
    const entries = listsNow()[day];
    const nodes = entries.map((entry) => entryCard(entry, body));
    if (!entries.length) nodes.push(el('div', { className: 'faint', textContent: 'No shifts this day' }));
    nodes.push(addPicker(entries, body));
    fill(body, nodes);
  }

  /** One shift's card: its fields, roles and the buttons to copy or remove it. */
  function entryCard(entry, body) {
    const err = el('div', { className: 'err' });
    const roles = entry.roles || [];

    const nameInput = el('input', {
      type: 'text', value: entry.name,
      onblur: () => {
        const value = nameInput.value.trim();
        if (value) patchEntry(entry.id, { name: value });
        else nameInput.value = latestOf(entry.id)?.name ?? entry.name;
      },
    });
    const startInput = el('input', {
      type: 'time', step: String(TIME_STEP_SECONDS), value: entry.start || '',
      onchange: () => patchEntry(entry.id, { start: startInput.value }),
    });
    const endInput = el('input', {
      type: 'time', step: String(TIME_STEP_SECONDS), value: entry.end || '',
      onchange: () => patchEntry(entry.id, { end: endInput.value }),
    });
    const noteInput = el('input', {
      type: 'text', value: entry.note || '', placeholder: 'e.g. Venue, dress code',
      onblur: () => {
        const note = noteInput.value.trim();
        if (note === (latestOf(entry.id)?.note || '')) return;
        // An empty note is dropped from the entry rather than kept as ''.
        commit((list) => list.map((e) => {
          if (e.id !== entry.id) return e;
          const { note: _old, ...rest } = e;
          return note ? { ...rest, note } : rest;
        }));
      },
    });

    // With roles the total is theirs to give, so the field is shown but locked.
    const headcountInput = el('input', {
      type: 'number', min: '0', step: '1', value: String(entry.headcount),
      disabled: roles.length > 0,
    });
    headcountInput.addEventListener('blur', () => {
      const n = wholeNumber(headcountInput.value);
      if (n === null) { err.textContent = 'Enter a whole number of 0 or more.'; return; }
      err.textContent = '';
      patchEntry(entry.id, { headcount: n });
    });

    // A role's count: 0 removes it, and the total follows the roles while any remain.
    const roleName = new Map(store.roles().map((r) => [r.id, r.name]));
    /** Save new roles for this entry, then redraw since the total may have changed. */
    const setRoles = (next) => {
      const patch = { roles: next };
      if (next.length) patch.headcount = next.reduce((sum, r) => sum + r.count, 0);
      patchEntry(entry.id, patch);
      draw(body);
    };
    const roleRows = roles.map((r) => {
      const count = el('input', { type: 'number', min: '0', step: '1', value: String(r.count), style: 'width:4.5rem' });
      count.addEventListener('change', () => {
        const n = wholeNumber(count.value);
        if (n === null) { err.textContent = 'Enter a whole number of 0 or more.'; return; }
        err.textContent = '';
        setRoles(n > 0
          ? roles.map((x) => (x.roleId === r.roleId ? { ...x, count: n } : x))
          : roles.filter((x) => x.roleId !== r.roleId));
      });
      return el('div', { className: 'spread' }, [
        el('div', { textContent: roleName.get(r.roleId) || '(removed role)' }),
        count,
      ]);
    });
    const onEntry = new Set(roles.map((r) => r.roleId));
    const addRole = el('select', {}, [
      el('option', { value: '', textContent: '+ Add a role' }),
      ...store.roles().filter((r) => !onEntry.has(r.id))
        .map((r) => el('option', { value: String(r.id), textContent: r.name })),
    ]);
    addRole.addEventListener('change', () => {
      const roleId = Number(addRole.value);
      if (roleId) setRoles([...roles, { roleId, count: 1 }]);
    });

    // Copy this shift's details onto the same shift on the roster's other days.
    const sameBtn = el('button', {
      type: 'button', className: 'btn btn-sm', textContent: 'Same on every day',
      onclick: () => {
        const latest = listsNow()[day].find((e) => e.id === entry.id);
        if (!latest) return;
        const lists = listsNow();
        let changed = 0;
        for (const date of source.dates) {
          if (date === day || !lists[date].some((e) => e.id === latest.id)) continue;
          lists[date] = lists[date].map((e) => {
            if (e.id !== latest.id) return e;
            const { note: _old, ...rest } = e;
            const copy = {
              ...rest, name: latest.name, start: latest.start, end: latest.end,
              headcount: latest.headcount, roles: (latest.roles || []).map((r) => ({ ...r })),
            };
            if (latest.note) copy.note = latest.note;
            return copy;
          });
          changed++;
        }
        if (changed) source.setLists(lists, assignmentsNow());
        toast(changed ? `Changed on ${changed} more day${changed === 1 ? '' : 's'}` : 'No other day has this shift');
      },
    });

    // Taking a shift off asks first if people are on it, and takes them off too.
    const removeBtn = el('button', {
      type: 'button', className: 'btn btn-danger btn-sm', textContent: 'Remove from this day',
      onclick: async () => {
        const assignments = assignmentsNow() || [];
        const here = assignments.filter((a) => a.date === day && a.shiftId === entry.id);
        if (here.length) {
          const ok = await confirmDialog(
            'Remove shift',
            `Take ${here.length} ${here.length === 1 ? 'person' : 'people'} off ${latestOf(entry.id)?.name ?? entry.name} on ${formatDate(day)} too?`
              + cancelWarning(source.saidYes?.(here) || []),
            'Remove',
          );
          if (!ok) return;
        }
        commit((list) => list.filter((e) => e.id !== entry.id), assignments.filter((a) => !here.includes(a)));
        draw(body);
      },
    });

    return el('div', { className: 'card' }, [
      el('div', { className: 'faint', textContent: entry.event ? 'Event (just this day)' : 'Shift' }),
      el('div', {}, [el('label', { className: 'label', textContent: 'Name' }), nameInput]),
      el('div', { className: 'grid-2' }, [
        el('div', {}, [el('label', { className: 'label', textContent: 'Start' }), startInput]),
        el('div', {}, [el('label', { className: 'label', textContent: 'End' }), endInput]),
      ]),
      el('div', {}, [el('label', { className: 'label', textContent: 'Note' }), noteInput]),
      el('div', {}, [el('label', { className: 'label', textContent: 'Staff needed' }), headcountInput]),
      el('div', {}, [el('label', { className: 'label', textContent: 'Roles' }), ...roleRows, addRole]),
      err,
      // An event is a one-off, so it has no other days to copy to.
      el('div', { className: 'row' }, [entry.event ? null : sameBtn, removeBtn]),
    ]);
  }

  /**
   * The "+ Add shift or event" picker: the usual shifts not already on this
   * day, or a new event. A shift is copied in with its own id; an event gets a
   * new one and is marked as a one-off. Either goes at the end of the day's list.
   */
  function addPicker(entries, body) {
    const onDay = new Set(entries.map((e) => e.id));
    const select = el('select', {}, [
      el('option', { value: '', textContent: '+ Add shift or event' }),
      ...store.shifts().filter((s) => !onDay.has(s.id))
        .map((s) => el('option', { value: String(s.id), textContent: s.name })),
      el('option', { value: 'event', textContent: 'New event (just this day)…' }),
    ]);
    select.addEventListener('change', () => {
      let entry;
      if (select.value === 'event') {
        const org = store.currentOrg();
        entry = {
          id: store.newShiftId(), name: 'Event', start: org?.openTime || '', end: org?.closeTime || '',
          headcount: 1, roles: [], event: true,
        };
      } else {
        const usual = store.shifts().find((s) => s.id === Number(select.value));
        if (!usual) return;
        entry = {
          id: usual.id, name: usual.name, start: usual.start, end: usual.end, headcount: usual.headcount,
          roles: (usual.roles || []).map((r) => ({ ...r })),
        };
      }
      commit((list) => [...list, entry]);
      draw(body);
    });
    return select;
  }
}
