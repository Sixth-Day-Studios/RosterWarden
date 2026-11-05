/**
 * People screen: manage the roster of staff who can be scheduled.
 *
 * Two states are rendered into the same container: a list of everyone in the
 * current organisation, and (when a person is selected) a full-page editor for
 * that one person. There is no side-by-side layout - this is a phone app, and
 * a list-then-detail push is the natural pattern here.
 */
import { store } from '../store.js';
import { formatDate, todayISO } from '../scheduler.js';
import { parsePeopleList } from '../people-import.js';
import { isConfigured as pcoConfigured } from '../sources/planning-center.js';
import { show } from '../app.js';
import * as staff from '../staff.js';
import { linkUrl } from '../staff-link.js';
import { SYNC_URL } from '../config.js';
import {
  el, fill, toast, promptText, confirmDialog, promptDateRange, weekdayPicker, monthGrid,
  dialog, DAY_LABELS, copyText, collapsible,
} from '../ui.js';

// Id of the person currently open in the editor, or null when showing the list.
let editingId = null;

// The list's search box, and "select several" mode with who is ticked.
let searchText = '';
let selecting = false;
let selected = new Set();

// When walking new people through the day-picker one at a time: the ids still
// to visit and how far through we are. Null when not in the walk-through.
let stepIds = null;
let stepAt = 0;

/** Entry point: render the day walk-through, the editor, or the list. */
export function render(container) {
  // Drop anyone deleted mid-walk, and leave the walk if nobody's left.
  if (stepIds) {
    stepIds = stepIds.filter((id) => store.people().some((p) => p.id === id));
    if (stepIds.length === 0) stepIds = null;
  }

  if (stepIds) {
    stepAt = Math.max(0, Math.min(stepAt, stepIds.length - 1));
    fill(container, renderStepper(container));
  } else if (editingId != null && store.people().some((p) => p.id === editingId)) {
    fill(container, renderEditor(editingId, container));
  } else {
    editingId = null;
    fill(container, renderList(container));
  }
}

/** Build the "who can I work?" summary shown under each person's name. */
function availabilitySummary(person) {
  const days = person.availableWeekdays || [];
  let text;
  if (days.length === 7) text = 'Every day';
  else if (days.length === 0) text = 'No days ticked';
  else {
    const labels = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
    text = [...days].sort((a, b) => a - b).map((d) => labels[d]).join(', ');
  }
  const away = person.blackouts?.length || 0;
  if (away > 0) text += ` · ${away} away`;
  return text;
}

/** Build the list view: header, add button, and one row per person. */
function renderList(container) {
  const addBtn = el('button', {
    className: 'btn btn-primary btn-sm', textContent: '+ Add',
    onclick: async () => {
      const name = await promptText('New person', "What's their name?");
      if (!name) return;
      const person = store.addPerson(name);
      staff.autoLink(person);
      editingId = person.id;
      render(container);
    },
  });

  const addManyBtn = el('button', {
    className: 'btn btn-sm', textContent: 'Add several',
    onclick: () => openBulkAdd(container),
  });

  const header = el('div', { className: 'spread' }, [
    el('h2', { textContent: 'People' }),
    el('div', { className: 'row-tight' }, [addManyBtn, addBtn]),
  ]);

  // Where people get added is where Planning Center is worth mentioning: a
  // team brought in from there saves typing every name.
  const fromPco = pcoConfigured() ? el('button', {
    className: 'btn btn-sm btn-block',
    textContent: store.currentOrg()?.pco?.teamId
      ? 'Update from Planning Center →'
      : 'Bring people in from Planning Center →',
    onclick: () => show('settings', { section: 'planning-center' }),
  }) : null;

  const people = store.people();
  if (people.length === 0) {
    return [
      header,
      fromPco,
      el('div', { className: 'card' }, [
        el('div', { textContent: 'No people yet' }),
        el('div', {
          className: 'muted',
          textContent: 'Add them one at a time, or use "Add several" to paste a list of names.',
        }),
      ]),
    ];
  }

  // Shortcut into the day walk-through for everyone still without any days -
  // the usual state right after a bulk add.
  const needDays = people.filter((p) => (p.availableWeekdays || []).length === 0);
  const who = `${needDays.length} ${needDays.length === 1 ? 'person' : 'people'}`;
  const setDaysBtn = needDays.length ? el('div', { style: 'margin:.6rem 0', className: 'row-tight' }, [
    el('button', {
      className: 'btn btn-sm', textContent: `Available any day: ${who}`,
      onclick: () => {
        // Everyone without days becomes available every day; untick days per person after.
        for (const p of needDays) store.updatePerson(p.id, { availableWeekdays: [0, 1, 2, 3, 4, 5, 6] });
        toast(`${who} can now work any day`);
        render(container);
      },
    }),
    el('button', {
      className: 'btn btn-sm', textContent: 'Set one by one →',
      onclick: () => { stepIds = needDays.map((p) => p.id); stepAt = 0; render(container); },
    }),
  ]) : null;

  const list = el('div', { className: 'list' });
  const bar = el('div', { className: 'row-tight', style: 'flex-wrap:wrap' });

  /** Draw the rows that match the search, with a tick box in select mode. */
  const drawList = () => {
    const q = searchText.trim().toLowerCase();
    const shown = people.filter((p) => !q || p.name.toLowerCase().includes(q));
    fill(list, shown.length ? shown.map((p) => {
      const mark = selecting ? el('input', {
        type: 'checkbox', checked: selected.has(p.id), 'aria-label': `Select ${p.name}`,
        style: 'pointer-events:none;margin-right:.6rem',
      }) : null;
      return el('button', {
        type: 'button',
        className: `item${p.active ? '' : ' inactive'}`,
        onclick: () => {
          if (!selecting) { editingId = p.id; render(container); return; }
          if (selected.has(p.id)) selected.delete(p.id); else selected.add(p.id);
          drawList(); drawBar();
        },
      }, [
        mark,
        el('div', { className: 'item-main' }, [
          el('div', { className: 'item-title', textContent: p.name }),
          el('div', {
            className: 'item-sub',
            textContent: availabilitySummary(p)
              + (p.staffLink ? (p.staffLink.sentAt ? ' · link sent' : ' · link not sent') : ''),
          }),
        ]),
      ]);
    }) : el('div', { className: 'muted', textContent: 'Nobody matches that.' }));
  };

  /** Apply `patch(person)` to everyone ticked, then redraw. */
  const forSelected = (patch, message) => {
    for (const id of selected) {
      const person = store.people().find((p) => p.id === id);
      if (person) store.updatePerson(id, patch(person));
    }
    toast(message);
    render(container);
  };

  /** Draw the select-several actions, or the Select button when not selecting. */
  const drawBar = () => {
    if (!selecting) {
      fill(bar, el('button', {
        className: 'btn btn-sm', textContent: 'Select several',
        onclick: () => { selecting = true; selected = new Set(); drawBar(); drawList(); },
      }));
      return;
    }
    const n = selected.size;
    const need = (fn) => () => (n ? fn() : toast('Tick some people first'));
    const roles = store.roles().filter((r) => !r.anyone);
    fill(bar, [
      el('span', { className: 'faint', textContent: `${n} selected` }),
      el('button', { className: 'btn btn-sm', textContent: 'All', onclick: () => {
        const q = searchText.trim().toLowerCase();
        for (const p of people) if (!q || p.name.toLowerCase().includes(q)) selected.add(p.id);
        drawList(); drawBar();
      } }),
      el('button', { className: 'btn btn-sm', textContent: 'Days…', onclick: need(async () => {
        let days = [];
        const ok = await dialog((close) => [
          el('h2', { textContent: `Days for ${n} ${n === 1 ? 'person' : 'people'}` }),
          weekdayPicker([], (d) => { days = d; }),
          el('div', { className: 'modal-actions' }, [
            el('button', { className: 'btn', textContent: 'Cancel', onclick: () => close(null) }),
            el('button', { className: 'btn btn-primary', textContent: 'Set days', onclick: () => close(true) }),
          ]),
        ]);
        if (ok) forSelected(() => ({ availableWeekdays: days }), 'Days updated');
      }) }),
      roles.length ? el('button', { className: 'btn btn-sm', textContent: 'Role…', onclick: need(async () => {
        const pick = el('select', {}, roles.map((r) => el('option', { value: String(r.id), textContent: r.name })));
        const choice = await dialog((close) => [
          el('h2', { textContent: `Role for ${n} ${n === 1 ? 'person' : 'people'}` }),
          pick,
          el('div', { className: 'modal-actions' }, [
            el('button', { className: 'btn', textContent: 'Cancel', onclick: () => close(null) }),
            el('button', { className: 'btn', textContent: 'Remove role', onclick: () => close('remove') }),
            el('button', { className: 'btn btn-primary', textContent: 'Can do it', onclick: () => close('add') }),
          ]),
        ]);
        if (!choice) return;
        const id = Number(pick.value);
        forSelected((p) => ({
          roleIds: choice === 'add' ? [...new Set([...(p.roleIds || []), id])] : (p.roleIds || []).filter((r) => r !== id),
        }), 'Roles updated');
      }) }) : null,
      el('button', { className: 'btn btn-sm', textContent: 'Pause', onclick: need(() => forSelected(() => ({ active: false }), 'Paused')) }),
      el('button', { className: 'btn btn-sm', textContent: 'Resume', onclick: need(() => forSelected(() => ({ active: true }), 'Resumed')) }),
      el('button', { className: 'btn btn-sm', textContent: 'Done', onclick: () => {
        selecting = false; selected = new Set(); drawBar(); drawList();
      } }),
    ]);
  };

  // A search box once the list is long enough to need one.
  const search = people.length > 6 ? el('input', {
    type: 'search', placeholder: 'Search people', value: searchText, 'aria-label': 'Search people',
    oninput: (e) => { searchText = e.target.value; drawList(); },
  }) : null;

  drawList();
  drawBar();
  return [header, fromPco, setDaysBtn, search, bar, list];
}

/**
 * Bulk add: paste a list of names (one per line, optional "- days" suffix),
 * review what will be created, then walk anyone without days through the picker.
 *
 * This is the offline, keyless sibling of AI assist: `parsePeopleList` does the
 * reading, and names that already exist in this org are skipped rather than
 * duplicated.
 */
async function openBulkAdd(container) {
  const created = await bulkAddDialog();
  if (created && created.length) {
    const needDays = created.filter((p) => (p.availableWeekdays || []).length === 0);
    if (needDays.length) { stepIds = needDays.map((p) => p.id); stepAt = 0; }
  }
  render(container);
}

/**
 * The paste-a-list dialog. Resolves to the array of created people, or null.
 *
 * The preview updates as you type so it's clear before committing what each
 * line will become - a day pattern, "no days", or "already on the list".
 */
function bulkAddDialog() {
  return dialog((close) => {
    const existing = new Set(store.people().map((p) => p.name.trim().toLowerCase()));

    const textarea = el('textarea', {
      rows: 7,
      placeholder: 'Sarah - Sat, Sun\nTom - weekdays\nRachel\nKate - every day',
    });
    const preview = el('div', { className: 'list', style: 'max-height:30vh;overflow-y:auto' });
    const addBtn = el('button', { className: 'btn btn-primary', textContent: 'Add', disabled: true });

    // Entries that will actually be created, kept in sync by refresh().
    let toAdd = [];

    /** Re-parse the textarea and rebuild the preview and the Add button. */
    const refresh = () => {
      const seen = new Set();
      toAdd = [];
      const rows = parsePeopleList(textarea.value).map((entry) => {
        const key = entry.name.toLowerCase();
        const dup = existing.has(key) || seen.has(key);
        seen.add(key);
        if (!dup) toAdd.push(entry);

        let note;
        if (dup) note = ' — already on the list';
        else if (entry.weekdays && entry.weekdays.length) {
          note = ` — ${entry.weekdays.map((d) => DAY_LABELS[d]).join(', ')}`;
        } else if (entry.weekdays && entry.weekdays.length === 0) note = ' — no days';
        else note = ' — days not set';

        return el('div', {
          className: 'faint',
          style: dup ? 'text-decoration:line-through' : null,
          textContent: entry.name + note,
        });
      });
      fill(preview, rows);
      addBtn.disabled = toAdd.length === 0;
      addBtn.textContent = toAdd.length ? `Add ${toAdd.length}` : 'Add';
    };
    textarea.addEventListener('input', refresh);

    addBtn.addEventListener('click', () => {
      const created = toAdd.map((e) => {
        const person = store.addPerson(e.name, e.weekdays ?? undefined);
        if (e.email || e.mobile) store.updatePerson(person.id, { email: e.email || '', phone: e.mobile || '' });
        return person;
      });
      created.forEach(staff.autoLink);
      toast(`${created.length} added`);
      close(created);
    });

    return [
      el('h2', { textContent: 'Add several people' }),
      el('div', {
        className: 'faint',
        textContent: 'Paste a list from a message or your notes — one name per line. Add a mobile and email after a comma, and days after a dash if you know them: Mon–Sun, weekdays, weekends, every day.',
      }),
      textarea,
      preview,
      el('div', { className: 'modal-actions' }, [
        el('button', { className: 'btn', textContent: 'Cancel', onclick: () => close(null) }),
        addBtn,
      ]),
    ];
  });
}

/**
 * One screen of the day walk-through: the current person's name, the weekday
 * picker, and Previous / Next (or Done on the last). Days save on every tap,
 * so "Finish later" simply leaves - nothing is lost.
 */
function renderStepper(container) {
  const person = store.people().find((p) => p.id === stepIds[stepAt]);
  const leave = () => { stepIds = null; stepAt = 0; render(container); };
  const last = stepAt === stepIds.length - 1;

  const heading = el('div', { className: 'spread' }, [
    el('h2', { textContent: 'Set days' }),
    el('div', { className: 'faint', textContent: `${stepAt + 1} of ${stepIds.length}` }),
  ]);

  const picker = weekdayPicker(person.availableWeekdays, (days) => {
    store.updatePerson(person.id, { availableWeekdays: days });
  });

  const prevBtn = el('button', {
    className: 'btn', textContent: '← Previous', disabled: stepAt === 0,
    onclick: () => { stepAt -= 1; render(container); },
  });
  const nextBtn = el('button', {
    className: 'btn btn-primary', textContent: last ? 'Done' : 'Next →',
    onclick: () => { if (last) { leave(); } else { stepAt += 1; render(container); } },
  });

  return [
    heading,
    el('div', { className: 'card' }, [
      el('div', { className: 'item-title', textContent: person.name }),
      picker,
      el('div', { className: 'faint', textContent: 'Tap the days this person can work. Saved as you go.' }),
    ]),
    el('div', { className: 'row-tight' }, [prevBtn, nextBtn]),
    el('button', { className: 'btn btn-sm', textContent: 'Finish later', onclick: leave }),
  ];
}

/** Build the full editor for one person. */
function renderEditor(id, container) {
  const person = store.people().find((p) => p.id === id);
  const back = () => { editingId = null; render(container); };

  const backBtn = el('button', { className: 'btn btn-sm', textContent: '← Back', onclick: back });
  const header = el('div', { className: 'row-tight' }, [backBtn]);

  const nameCard = renderNameCard(person);
  const availCard = renderAvailabilityCard(person, container);
  const rolesCard = renderRolesCard(person);
  const patternCard = renderPatternCard(person);
  const togetherCard = renderTogetherCard(person, container);
  const linkCard = renderStaffLinkCard(person, container);
  const contactCard = renderContactCard(person);
  const wantedCard = renderWantedDatesCard(person, container);
  const maxCard = renderMaxShiftsCard(person);
  const awayCard = renderAwayCard(person, container);
  const clashCard = renderClashCard(person, container);
  const deleteBtn = el('button', {
    className: 'btn btn-danger btn-block', textContent: 'Delete person',
    onclick: async () => {
      const ok = await confirmDialog('Delete person', `Remove ${person.name}? This cannot be undone.`);
      if (!ok) return;
      // Switch their staff link off while its key is still here, so their page stops showing old shifts.
      try {
        await staff.retireLinks([person.id]);
      } catch {
        const anyway = await confirmDialog(
          'Staff link still on',
          `The server couldn't be reached, so ${person.name}'s staff link will keep showing their old shifts. `
            + 'Delete them anyway, or wait until you\'re online?',
          'Delete anyway'
        );
        if (!anyway) return;
      }
      store.deletePerson(person.id);
      toast('Person deleted');
      back();
    },
  });

  // Everything already saves as you go, so Save is really "I'm done here" -
  // but it still commits the text fields first, so a value typed and never
  // blurred is kept, and it refuses to leave on a bad max-shifts value rather
  // than dropping it silently.
  const saveBtn = el('button', {
    className: 'btn btn-primary btn-block btn-lg', textContent: 'Save',
    onclick: () => {
      nameCard.commit();
      if (!maxCard.commit()) return;
      toast(`${store.people().find((p) => p.id === id)?.name || 'Person'} saved`);
      back();
    },
  });

  // What is needed to roster and reach someone comes first; the rarer rules are folded away.
  const more = collapsible('person-more', 'More options', [
    patternCard, wantedCard, maxCard.node, clashCard, togetherCard,
  ], { open: false, className: 'fold-group' });
  return [
    header, nameCard.node, contactCard, linkCard, availCard, rolesCard, awayCard, more,
    saveBtn, deleteBtn,
  ];
}

/**
 * Card: name text field and the active/inactive toggle.
 *
 * Returns `{ node, commit }`. Fields still save on blur, but Save calls
 * `commit()` too so a value typed and never blurred is not lost.
 */
function renderNameCard(person) {
  /** Save the typed name, falling back to the existing one if it's blank. */
  const commit = () => {
    const value = nameInput.value.trim();
    if (value) store.updatePerson(person.id, { name: value });
    else nameInput.value = person.name;
    return true;
  };

  const nameInput = el('input', {
    type: 'text', value: person.name,
    onblur: commit,
  });

  const activeCheckbox = el('input', {
    type: 'checkbox', checked: person.active,
    onchange: () => store.updatePerson(person.id, { active: activeCheckbox.checked }),
  });

  const node = el('div', { className: 'card' }, [
    el('div', {}, [el('label', { className: 'label', textContent: 'Name' }), nameInput]),
    el('label', { className: 'row-tight' }, [
      activeCheckbox,
      el('span', { textContent: 'Active' }),
    ]),
    el('div', {
      className: 'faint',
      textContent: 'Inactive people are kept on the list but are never rostered.',
    }),
    person.pcoId ? el('div', {
      className: 'faint',
      textContent: 'Linked to Planning Center: their blockouts come in as away dates when you update.',
    }) : null,
  ]);

  return { node, commit };
}

/**
 * Card: which roles this person can do. Roles that anyone can do are not
 * listed (nobody needs ticking for them); the card is hidden when the
 * organisation has no roles that need ticking.
 */
function renderRolesCard(person) {
  const roles = store.roles().filter((r) => !r.anyone);
  if (roles.length === 0) return null;
  const ticks = roles.map((role) => {
    const box = el('input', {
      type: 'checkbox', checked: (person.roleIds || []).includes(role.id),
      onchange: () => {
        const have = new Set(store.people().find((p) => p.id === person.id)?.roleIds || []);
        if (box.checked) have.add(role.id); else have.delete(role.id);
        store.updatePerson(person.id, { roleIds: [...have] });
      },
    });
    return el('label', { className: 'row-tight' }, [box, el('span', { textContent: role.name })]);
  });
  return el('div', { className: 'card' }, [
    el('label', { className: 'label', textContent: 'Can do' }),
    ...ticks,
    el('div', { className: 'faint', textContent: 'On a shift made of roles, they are only put on roles ticked here.' }),
  ]);
}

/**
 * Card: how often they serve and which weeks of the month. Both are optional:
 * "no preference" and "any week" are the defaults.
 */
function renderPatternCard(person) {
  const weeks = new Set(person.weeksOfMonth || []);
  const chips = [1, 2, 3, 4, 5].map((n) => {
    const chip = el('button', {
      type: 'button', className: 'day-chip', textContent: ['1st', '2nd', '3rd', '4th', '5th'][n - 1],
      'aria-pressed': String(weeks.has(n)),
      onclick: () => {
        if (weeks.has(n)) weeks.delete(n); else weeks.add(n);
        chip.setAttribute('aria-pressed', String(weeks.has(n)));
        store.updatePerson(person.id, { weeksOfMonth: [...weeks].sort() });
      },
    });
    return chip;
  });
  const gap = el('select', {
    onchange: () => store.updatePerson(person.id, { minGapWeeks: gap.value ? Number(gap.value) : null }),
  }, [
    ['', 'As often as needed'], ['2', 'Every 2nd week at most'], ['3', 'Every 3rd week at most'],
    ['4', 'About once a month'],
  ].map(([value, text]) => el('option', {
    value, textContent: text, selected: String(person.minGapWeeks ?? '') === value,
  })));
  return el('div', { className: 'card' }, [
    el('label', { className: 'label', textContent: 'How often' }),
    gap,
    el('label', { className: 'label', style: 'margin-top:.6rem', textContent: 'Only these weeks of the month' }),
    el('div', { className: 'days' }, chips),
    el('div', { className: 'faint', textContent: 'Leave the weeks blank for any week. Someone who serves less often is still used if nobody else is free.' }),
  ]);
}

/** Card: people this person serves together with (a couple, a parent and child). */
function renderTogetherCard(person, container) {
  const others = store.people().filter((p) => p.id !== person.id);
  const mates = others.filter((p) => (person.withIds || []).includes(p.id));
  const rows = mates.map((m) => el('div', { className: 'spread' }, [
    el('div', { textContent: m.name }),
    el('button', {
      className: 'btn btn-sm', textContent: 'Remove',
      onclick: () => { store.setTogether(person.id, m.id, false); render(container); },
    }),
  ]));
  const free = others.filter((p) => !mates.includes(p));
  let addRow = null;
  if (free.length) {
    const select = el('select', {}, free.map((p) => el('option', { value: String(p.id), textContent: p.name })));
    addRow = el('div', { className: 'row-tight' }, [select, el('button', {
      className: 'btn btn-sm', textContent: 'Add',
      onclick: () => { store.setTogether(person.id, Number(select.value), true); render(container); },
    })]);
  }
  return el('div', { className: 'card' }, [
    el('label', { className: 'label', textContent: 'Serves with' }),
    rows.length ? el('div', { className: 'list' }, rows) : el('div', { className: 'muted', textContent: 'No one in particular.' }),
    addRow,
    el('div', { className: 'faint', textContent: 'When one is rostered, the other goes on the same shift if they are free.' }),
  ]);
}

/** Card: optional phone, email and pay rate, used to message them and to estimate cost. */
function renderContactCard(person) {
  /** A text field that saves on change. */
  const field = (label, key, type, value) => {
    const input = el('input', { type, value: value ?? '', inputMode: type === 'tel' ? 'tel' : undefined });
    input.addEventListener('change', () => {
      const raw = input.value.trim();
      store.updatePerson(person.id, { [key]: key === 'hourlyRate' ? (raw === '' ? null : Math.max(0, Number(raw) || 0)) : raw });
    });
    return el('div', {}, [el('label', { className: 'label', textContent: label }), input]);
  };
  return el('div', { className: 'card' }, [
    field('Mobile (optional)', 'phone', 'tel', person.phone),
    field('Email (optional)', 'email', 'email', person.email),
    field('Pay per hour (optional)', 'hourlyRate', 'number', person.hourlyRate),
  ]);
}

/**
 * Card: the person's own private link for telling you the dates they can't
 * work. It is sent from your phone (email, text or share), never by the
 * server, so the link and its key stay between you and them. Their dates
 * arrive as away dates marked "from their link".
 */
function renderStaffLinkCard(person, container) {
  if (!SYNC_URL) return null;
  const first = person.name.split(' ')[0];
  const redraw = () => render(container);
  const title = el('label', { className: 'label', textContent: 'Their availability link' });

  if (!staff.hasLink(person)) {
    return el('div', { className: 'card' }, [
      title,
      el('div', { className: 'faint', textContent: `${first} gets a private link to tap the dates they can't work. They show up here as away dates, and nobody else can see them.` }),
      el('button', {
        className: 'btn btn-sm', textContent: 'Create link',
        onclick: async () => { await staff.createLink(person.id); redraw(); },
      }),
    ]);
  }

  const sl = person.staffLink;
  const org = store.currentOrg()?.name || 'us';
  const text = `Hi ${first}, here's your link to tell ${org} the dates you can't work: ${linkUrl(sl.key)}`;
  /** Note that it was sent (a moment later, so the mail or messages app opens first). */
  const sent = (via) => setTimeout(() => { staff.markSent(person.id, via); redraw(); }, 300);
  const send = [
    person.email ? el('a', {
      className: 'btn btn-sm', textContent: 'Email', onclick: () => sent('email'),
      href: `mailto:${encodeURIComponent(person.email).replace(/%40/g, '@')}?subject=${encodeURIComponent('Your availability link')}&body=${encodeURIComponent(text)}`,
    }) : null,
    person.phone ? el('a', {
      className: 'btn btn-sm', textContent: 'Text', onclick: () => sent('text'),
      href: `sms:${person.phone}?&body=${encodeURIComponent(text)}`,
    }) : null,
    navigator.share ? el('button', {
      className: 'btn btn-sm', textContent: 'Share',
      onclick: async () => {
        try { await navigator.share({ title: 'Your availability link', text }); sent('share'); } catch { /* closed */ }
      },
    }) : null,
    el('button', { className: 'btn btn-sm', textContent: 'Copy', onclick: () => { copyText(text); sent('copy'); } }),
  ];

  const sentLine = sl.sentAt
    ? `Sent ${formatDate(todayISO(new Date(sl.sentAt)), { withWeekday: false })} by ${sl.sentVia}`
    : 'Not sent yet';
  const heard = sl.lastFromStaff
    ? `Last updated from their link: ${new Date(sl.lastFromStaff).toLocaleString(undefined, { weekday: 'short', day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit' })}`
    : 'Nothing from them yet.';
  const upcoming = staff.staffDates(person).filter((d) => d >= todayISO());

  return el('div', { className: 'card' }, [
    title,
    el('div', { className: 'row-tight', style: 'flex-wrap:wrap' }, send),
    !person.phone && !person.email
      ? el('div', { className: 'faint', textContent: 'Add their mobile or email above to text or email it from your phone.' })
      : null,
    el('div', { className: 'spread' }, [
      el('div', { className: sl.sentAt ? 'faint' : 'muted', textContent: sentLine }),
      sl.sentAt ? null : el('button', { className: 'btn btn-sm', textContent: 'Mark as sent', onclick: () => sent('hand') }),
    ]),
    el('div', { className: 'faint', textContent: heard }),
    sl.note ? el('div', { className: 'muted', textContent: `"${sl.note}"` }) : null,
    sl.profileSuggestion ? el('div', { className: 'spread' }, [
      el('div', { textContent: `${first} would like their name to be "${sl.profileSuggestion.name}"` }),
      el('div', { className: 'row-tight' }, [
        el('button', { className: 'btn btn-sm btn-primary', textContent: 'Accept', onclick: () => { staff.resolveNameSuggestion(person.id, true); redraw(); } }),
        el('button', { className: 'btn btn-sm', textContent: 'Dismiss', onclick: () => { staff.resolveNameSuggestion(person.id, false); redraw(); } }),
      ]),
    ]) : null,
    upcoming.length ? el('div', { className: 'spread' }, [
      el('div', { textContent: `${upcoming.length} upcoming date${upcoming.length === 1 ? '' : 's'} from their link` }),
      el('button', {
        className: 'btn btn-sm', textContent: 'Clear them',
        onclick: async () => {
          const ok = await confirmDialog('Clear their dates?', `Removes the dates ${first} sent. Away dates you entered stay.`, 'Clear');
          if (ok) { staff.clearStaffDates(person.id); redraw(); }
        },
      }),
    ]) : null,
    el('div', { className: 'row-tight', style: 'flex-wrap:wrap' }, [
      el('button', {
        className: 'btn btn-sm', textContent: 'Check now',
        onclick: async () => {
          try {
            const changed = await staff.syncStaff();
            toast(changed.some((p) => p.id === person.id) ? `New dates from ${first}` : 'Nothing new');
          } catch (e) { toast(e.message); }
          redraw();
        },
      }),
      el('button', {
        className: 'btn btn-sm btn-danger', textContent: 'Make a new link',
        onclick: async () => {
          const ok = await confirmDialog('Make a new link?',
            `The old link stops working straight away. ${first}'s dates are kept. You'll need to send them the new one.`, 'Make new link');
          if (!ok) return;
          try { await staff.replaceLink(person.id); toast('New link made. Send it to them.'); } catch (e) { toast(e.message); }
          redraw();
        },
      }),
    ]),
  ]);
}

/** Card: the weekday picker for standing availability. */
function renderAvailabilityCard(person, container) {
  const hint = el('div', { className: 'faint' });

  /** Say plainly when nobody has picked any days yet. */
  const refreshHint = (days) => {
    hint.textContent = days.length === 0
      ? 'No days ticked, so they will not be rostered. Tap the days they can work.'
      : '';
  };

  const picker = weekdayPicker(person.availableWeekdays, (days) => {
    store.updatePerson(person.id, { availableWeekdays: days });
    refreshHint(days);
  });
  refreshHint(person.availableWeekdays);

  return el('div', { className: 'card' }, [
    el('label', { className: 'label', textContent: 'Available on' }),
    picker,
    hint,
  ]);
}

/**
 * Card: specific dates this person has asked to work.
 *
 * A request is a preference, not a rule: it puts them first in the queue for
 * that day, but a hard constraint or a full shift still wins. The same list is
 * editable on the New Roster screen; this card is for when you already know
 * ("Sarah wants the 12th") and don't have a roster open yet.
 */
function renderWantedDatesCard(person, container) {
  const today = todayISO();
  const summary = el('div', { className: 'faint' });

  // Open on the month of the earliest upcoming request, else this month.
  const upcoming = (person.requests || []).filter((d) => d >= today).sort();
  const startMonth = upcoming[0] || today;

  /** Highlight class for one day: a request, an away date, or nothing. */
  const classOf = (iso) => {
    const state = store.dateState(person.id, iso);
    if (state === 'wants') return 'is-want';
    if (state === 'cant' || state === 'cant-range') return 'is-away';
    return '';
  };

  /** Say how many days are picked, so the card reads at a glance. */
  const refreshSummary = () => {
    const n = (person.requests || []).length;
    summary.textContent = n === 0
      ? 'None picked. Tap the days they have asked to work.'
      : `${n} day${n === 1 ? '' : 's'} picked — they go first in the queue for those.`;
  };

  const onTap = (iso) => {
    // An away date wins: toggling a request under it would be a confusing
    // half-state, so send the user to the Away card instead.
    if (store.dateState(person.id, iso).startsWith('cant')) {
      toast('They have an away date then — clear it below to ask them to work.');
      return;
    }
    store.toggleRequest(person.id, iso);
    cal.redraw();
    refreshSummary();
  };

  const cal = monthGrid({ start: startMonth, openDays: store.openDays(), classOf, onTap });
  refreshSummary();

  return el('div', { className: 'card' }, [
    el('label', { className: 'label', textContent: 'Asked to work' }),
    cal.node,
    summary,
  ]);
}

/**
 * Card: max shifts per roster, validated as blank or a positive integer.
 *
 * Returns `{ node, commit }`; `commit()` is false when the value is invalid,
 * so Save can keep the user on the screen instead of discarding what they typed.
 */
function renderMaxShiftsCard(person) {
  const input = el('input', {
    type: 'number', min: '1', step: '1',
    value: person.maxShifts == null ? '' : String(person.maxShifts),
  });
  const err = el('div', { className: 'err' });

  /** Validate and save the cap. Returns false (and shows why) if unusable. */
  const commit = () => {
    const raw = input.value.trim();
    if (raw === '') {
      err.textContent = '';
      store.updatePerson(person.id, { maxShifts: null });
      return true;
    }
    const n = Number(raw);
    if (!Number.isInteger(n) || n <= 0) {
      err.textContent = 'Enter a positive whole number, or leave blank for no cap.';
      return false;
    }
    err.textContent = '';
    store.updatePerson(person.id, { maxShifts: n });
    return true;
  };

  input.addEventListener('blur', commit);

  const node = el('div', { className: 'card' }, [
    el('label', { className: 'label', textContent: 'Max shifts per roster' }),
    input,
    err,
  ]);

  return { node, commit };
}

/**
 * Card: away-date ranges, with add/remove.
 *
 * Past dates are never deleted on their own - throwing away someone's records
 * without being asked is the kind of thing you only notice once it has already
 * happened. They are folded away instead, with a button to clear them.
 */
function renderAwayCard(person, container) {
  const today = todayISO();
  const all = person.blackouts || [];
  const past = all.filter((b) => b.end < today);
  const current = all.filter((b) => b.end >= today);

  const rows = current.map((b) => {
    const span = b.start === b.end
      ? formatDate(b.start, { withWeekday: false })
      : `${formatDate(b.start, { withWeekday: false })} – ${formatDate(b.end, { withWeekday: false })}`;
    return el('div', { className: 'spread' }, [
      el('div', {}, [
        el('div', { textContent: span }),
        b.reason ? el('div', { className: 'muted', textContent: b.reason }) : null,
      ]),
      el('button', {
        className: 'btn btn-sm', textContent: 'Remove',
        // Index against the real list, not the filtered one, or removing a
        // current entry would delete whichever record happened to sit at that
        // position in the full array.
        onclick: () => {
          store.deleteBlackout(person.id, all.indexOf(b));
          render(container);
        },
      }),
    ]);
  });

  const addBtn = el('button', {
    className: 'btn btn-sm', textContent: '+ Add away dates',
    onclick: async () => {
      const result = await promptDateRange('Away dates', { openDays: store.openDays() });
      if (!result) return;
      store.addBlackout(person.id, result.start, result.end, result.reason);
      render(container);
    },
  });

  // Past entries: collapsed, with a way to clear them once they are just clutter.
  let pastBlock = null;
  if (past.length) {
    const clearBtn = el('button', {
      className: 'btn btn-sm', textContent: `Remove ${past.length} past`,
      onclick: async () => {
        const ok = await confirmDialog(
          'Remove past away dates',
          past.length === 1
            ? 'Delete 1 away date that has already been and gone? This cannot be undone.'
            : `Delete ${past.length} away dates that have already been and gone? This cannot be undone.`,
          'Remove'
        );
        if (!ok) return;
        // Remove back-to-front so earlier indices stay valid as we splice.
        for (const b of [...past].reverse()) store.deleteBlackout(person.id, all.indexOf(b));
        toast('Past dates removed');
        render(container);
      },
    });
    pastBlock = el('details', {}, [
      el('summary', { className: 'muted', textContent: `${past.length} past away date${past.length === 1 ? '' : 's'}` }),
      el('div', { className: 'list', style: 'margin-top:.5rem' }, past.map((b) => el('div', {
        className: 'muted',
        textContent: b.start === b.end
          ? formatDate(b.start, { withWeekday: false })
          : `${formatDate(b.start, { withWeekday: false })} – ${formatDate(b.end, { withWeekday: false })}`,
      }))),
      el('div', { style: 'margin-top:.5rem' }, clearBtn),
    ]);
  }

  return el('div', { className: 'card' }, [
    el('label', { className: 'label', textContent: 'Away dates' }),
    rows.length
      ? el('div', { className: 'list' }, rows)
      : el('div', { className: 'muted', textContent: 'None coming up.' }),
    addBtn,
    pastBlock,
  ]);
}

/** Card: "never with" clash rules against other people. */
function renderClashCard(person, container) {
  const others = store.people().filter((p) => p.id !== person.id);
  const partnerIds = store.clashes()
    .filter(([a, b]) => a === person.id || b === person.id)
    .map(([a, b]) => (a === person.id ? b : a));

  const rows = partnerIds.map((pid) => {
    const other = others.find((p) => p.id === pid);
    return el('div', { className: 'spread' }, [
      el('div', { textContent: other ? other.name : `#${pid}` }),
      el('button', {
        className: 'btn btn-sm', textContent: 'Remove',
        onclick: () => {
          store.deleteClash(person.id, pid);
          render(container);
        },
      }),
    ]);
  });

  const available = others.filter((p) => !partnerIds.includes(p.id));
  let addRow = null;
  if (available.length > 0) {
    const select = el('select', {}, available.map((p) => el('option', { value: String(p.id), textContent: p.name })));
    addRow = el('div', { className: 'row-tight' }, [
      select,
      el('button', {
        className: 'btn btn-sm', textContent: 'Add',
        onclick: () => {
          store.addClash(person.id, Number(select.value));
          render(container);
        },
      }),
    ]);
  }

  return el('div', { className: 'card' }, [
    el('label', { className: 'label', textContent: 'Never with' }),
    rows.length ? el('div', { className: 'list' }, rows) : el('div', { className: 'muted', textContent: 'No clash rules.' }),
    addRow,
  ]);
}
