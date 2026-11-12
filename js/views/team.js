/**
 * Team: everything you set up about who you roster and what they do, in one
 * place - People, Shifts (with their roles), and a grid of who can do which
 * role. The same view is a tab of its own and the sheet the Build screen opens
 * when you tap its "4 people · 2 shifts" line, so setting up never means
 * leaving the roster you are building.
 */
import { store } from '../store.js';
import { el, fill } from '../ui.js';
import * as peopleView from './people.js';
import * as shiftsView from './shifts.js';

// Which part is showing: 'people', 'shifts' or 'skills'. Kept across renders.
let tab = 'people';

/** Open the Team view at a given part (anything unknown leaves it as it was). */
export function openSection(name) {
  if (name === 'people' || name === 'shifts' || name === 'skills') tab = name;
}

/** Roles that need ticking per person (the ones anyone can do need nothing). */
function skilledRoles() {
  return store.roles().filter((r) => !r.anyone);
}

/** Entry point: the part switcher, then whichever part is selected. */
export function render(container) {
  // Skills only makes sense once there are roles to tick.
  if (tab === 'skills' && skilledRoles().length === 0) tab = 'people';

  const parts = [
    { id: 'people', label: 'People' },
    { id: 'shifts', label: 'Shifts' },
    ...(skilledRoles().length ? [{ id: 'skills', label: 'Skills' }] : []),
  ];
  // On a phone this row is pinned just above the bottom tab bar (see .team-tabs).
  const switcher = el('div', { className: 'team-tabs', role: 'tablist' }, parts.map((p) => el('button', {
    className: 'team-tab', textContent: p.label, role: 'tab',
    'aria-selected': String(tab === p.id),
    onclick: () => { tab = p.id; render(container); },
  })));

  const body = el('div');
  fill(container, [switcher, body]);
  if (tab === 'people') peopleView.render(body);
  else if (tab === 'shifts') shiftsView.render(body);
  else body.append(skillsGrid());
}

/**
 * People down the side, roles across the top, a tick where someone can do the
 * role: the quick way to set who can play what without opening each person.
 */
function skillsGrid() {
  const roles = skilledRoles();
  const people = store.people().filter((p) => p.active);
  if (people.length === 0) {
    return el('div', { className: 'card muted', textContent: 'Add people first, then tick what each can do.' });
  }

  const head = el('tr', {}, [
    el('th', { textContent: '' }),
    ...roles.map((r) => el('th', { className: 'skill-head', textContent: r.name })),
  ]);
  const rows = people.map((person) => el('tr', {}, [
    el('th', { className: 'skill-person', scope: 'row', textContent: person.name }),
    ...roles.map((role) => {
      const box = el('input', {
        type: 'checkbox', checked: (person.roleIds || []).includes(role.id),
        'aria-label': `${person.name} can do ${role.name}`,
        onchange: () => {
          const have = new Set(store.people().find((p) => p.id === person.id)?.roleIds || []);
          if (box.checked) have.add(role.id); else have.delete(role.id);
          store.updatePerson(person.id, { roleIds: [...have] });
        },
      });
      return el('td', {}, [box]);
    }),
  ]));

  return el('div', {}, [
    el('div', { className: 'faint', textContent: 'Tick what each person can do. Roles marked "anyone can do it" are left out.' }),
    el('div', { className: 'skill-wrap' }, [el('table', { className: 'skill-grid' }, [
      el('thead', {}, [head]), el('tbody', {}, rows),
    ])]),
  ]);
}
