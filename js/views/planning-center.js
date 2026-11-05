/**
 * Planning Center screens: the Settings card (connect, pick a team, update
 * people and blockouts, map shifts to positions) and the "Send to Planning
 * Center" action on a saved roster.
 *
 * All the API work lives in js/sources/planning-center.js; this file only
 * decides what to ask for and writes the answers into the store.
 */
import { store } from '../store.js';
import { todayISO, formatDate, rosterShiftList } from '../scheduler.js';
import * as pco from '../sources/planning-center.js';
import * as staff from '../staff.js';
import { el, fill, toast, confirmDialog, dialog } from '../ui.js';

/** Tag on away dates imported from Planning Center, so a refresh can replace them. */
const SOURCE = 'pco';

/** Teams loaded this session, so reopening the card doesn't refetch them. */
let teamsCache = null;

/** Whether the current organisation is connected to a team and can send rosters. */
export function canSend() {
  return pco.isConfigured() && pco.isConnected() && Boolean(store.currentOrg()?.pco?.teamId);
}

/**
 * The Settings card. `redraw` re-renders the whole section, used after
 * connecting, disconnecting or choosing a team.
 */
export function renderCard(redraw) {
  const card = el('div', { className: 'card' }, [el('h3', { textContent: 'Planning Center' })]);

  if (!pco.isConfigured()) {
    card.append(el('div', {
      className: 'muted',
      textContent: 'Planning Center is not set up for this copy of RosterWarden yet.',
    }));
    return card;
  }

  if (!pco.isConnected()) {
    card.append(
      el('div', {
        className: 'muted',
        textContent: 'Bring in a Services team and everyone\'s blockout dates, then send '
          + 'finished rosters back into your plans. You can still add people by hand too.',
      }),
      el('button', {
        className: 'btn btn-primary btn-block', textContent: 'Connect Planning Center',
        onclick: () => pco.startSignIn(),
      }),
    );
    return card;
  }

  const org = store.currentOrg();
  const err = el('div', { className: 'err' });
  const body = el('div');
  card.append(body, err);

  /** Turn a failure into a message on the card (and a sign-out into a redraw). */
  const fail = (e) => {
    err.textContent = e instanceof pco.PCOError ? e.message : 'Something went wrong talking to Planning Center.';
    if (!pco.isConnected()) redraw();
  };

  if (!org) {
    fill(body, el('div', { className: 'muted', textContent: 'Create an organisation first.' }));
  } else {
    fill(body, el('div', { className: 'faint', textContent: 'Loading your teams…' }));
    loadTeams()
      .then((teams) => fill(body, connectedBody(org, teams, redraw, fail, err)))
      .catch(fail);
  }

  card.append(el('button', {
    className: 'btn btn-sm', textContent: 'Disconnect this device',
    onclick: async () => {
      const ok = await confirmDialog(
        'Disconnect Planning Center?',
        'This device signs out. Your people, away dates and rosters stay as they are.',
        'Disconnect'
      );
      if (!ok) return;
      await pco.disconnect();
      teamsCache = null;
      redraw();
    },
  }));
  return card;
}

/** Fetch the team list once per session. */
async function loadTeams() {
  if (!teamsCache) teamsCache = await pco.listTeams();
  return teamsCache;
}

/** Team picker, the Update button, and the shift-to-position mapping. */
function connectedBody(org, teams, redraw, fail, err) {
  const link = org.pco || {};
  const label = (t) => (t.serviceTypeName ? `${t.serviceTypeName} · ${t.name}` : t.name);

  const select = el('select', {}, [
    el('option', { value: '', textContent: 'Choose a team…', selected: !link.teamId }),
    ...teams.map((t) => el('option', { value: t.id, textContent: label(t), selected: t.id === link.teamId })),
  ]);
  select.addEventListener('change', () => {
    const team = teams.find((t) => t.id === select.value);
    // Positions belong to a team, so the old team's mapping means nothing now.
    for (const shift of store.shifts()) store.updateShift(shift.id, { pcoPosition: null });
    store.updateOrg(org.id, {
      pco: team
        ? { teamId: team.id, teamName: team.name, serviceTypeId: team.serviceTypeId,
            serviceTypeName: team.serviceTypeName }
        : null,
    });
    redraw();
  });

  const nodes = [
    el('div', {}, [el('label', { className: 'label', textContent: 'Team' }), select]),
  ];
  if (!link.teamId) {
    nodes.push(el('div', {
      className: 'faint',
      textContent: 'Pick the team you roster for this organisation, e.g. Cafe or Hospitality.',
    }));
    return nodes;
  }

  const status = el('div', {
    className: 'faint',
    textContent: link.updatedAt
      ? `Last updated ${formatDate(todayISO(new Date(link.updatedAt)))}.`
      : 'Not updated yet.',
  });
  const updateBtn = el('button', { className: 'btn btn-primary btn-block', textContent: 'Update from Planning Center' });
  updateBtn.addEventListener('click', async () => {
    err.textContent = '';
    updateBtn.disabled = true;
    try {
      const summary = await updateFromTeam(org, link, (text) => { updateBtn.textContent = text; });
      store.updateOrg(org.id, { pco: { ...link, updatedAt: new Date().toISOString() } });
      toast(summary);
      redraw();
    } catch (e) {
      fail(e);
    } finally {
      updateBtn.disabled = false;
      updateBtn.textContent = 'Update from Planning Center';
    }
  });

  nodes.push(
    updateBtn,
    el('div', {
      className: 'faint',
      textContent: 'Adds anyone new on the team and refreshes everyone\'s blockout dates. '
        + 'Days they can work are still set here.',
    }),
    status,
    positionsBlock(link, fail),
  );
  return nodes;
}

/**
 * Bring the team's people and blockouts into the current organisation.
 *
 * People are matched on their Planning Center id first, then on name (so a
 * list built by hand before connecting is linked, not duplicated). New people
 * arrive available every day, same as adding them by hand; their blockouts come in as away dates. Returns a one-line
 * summary for the toast.
 */
async function updateFromTeam(org, link, progress) {
  progress('Reading the team…');
  const members = await pco.teamMembers(link.teamId);
  const people = store.people();
  const byPco = new Map(people.filter((p) => p.pcoId).map((p) => [p.pcoId, p]));
  const byName = new Map(people.map((p) => [p.name.trim().toLowerCase(), p]));

  let added = 0;
  let linked = 0;
  const linkedPeople = [];
  for (const m of members) {
    let person = byPco.get(m.id);
    let isNew = false;
    if (!person) {
      // Someone of the same name not yet linked to anyone is taken to be them;
      // otherwise (no match, or the name already belongs to a different
      // Planning Center person) they are added fresh.
      const sameName = byName.get(m.name.toLowerCase());
      if (sameName && !sameName.pcoId) {
        person = sameName;
        linked += 1;
      } else {
        person = store.addPerson(m.name);
        added += 1;
        isNew = true;
      }
      store.updatePerson(person.id, { pcoId: m.id });
      if (isNew) staff.autoLink(person);
    }
    linkedPeople.push(person);
  }

  // One person at a time: repeating blockouts each need a request of their
  // own, and a burst for a large team would hit the API's rate limit.
  const from = todayISO();
  for (const [i, person] of linkedPeople.entries()) {
    progress(`Blockouts ${i + 1} of ${linkedPeople.length}…`);
    const ranges = await pco.blockoutsFor(person.pcoId, from);
    store.replaceSourcedBlackouts(person.id, SOURCE, ranges.map((r) => ({
      ...r, reason: r.reason ? `Planning Center: ${r.reason}` : 'Planning Center',
    })));
  }

  const parts = [`${members.length} on the team`];
  if (added) parts.push(`${added} added`);
  if (linked) parts.push(`${linked} matched`);
  return `${parts.join(', ')} · blockouts updated`;
}

/**
 * "Send each shift as": one position picker per shift, so a roster can be
 * placed into the right slot on the plan. A shift left on "Don't send" is
 * skipped when sending.
 */
function positionsBlock(link, fail) {
  const wrap = el('div', {}, [
    el('label', { className: 'label', textContent: 'Send each shift as', style: 'margin-top:.6rem' }),
  ]);
  const rows = el('div', { className: 'list' }, el('div', { className: 'faint', textContent: 'Loading positions…' }));
  wrap.append(rows);

  pco.teamPositions(link.teamId).then((positions) => {
    const shifts = store.shifts();
    if (shifts.length === 0) {
      fill(rows, el('div', { className: 'faint', textContent: 'Add shifts first.' }));
      return;
    }
    /** A row: a label and a position picker that saves through `save`. */
    const pickerRow = (label, current, save) => {
      const select = el('select', {}, [
        el('option', { value: '', textContent: 'Don\'t send' }),
        ...positions.map((name) => el('option', { value: name, textContent: name, selected: current === name })),
      ]);
      select.addEventListener('change', () => save(select.value || null));
      return el('div', { className: 'spread' }, [el('div', { textContent: label }), select]);
    };
    fill(rows, [
      ...shifts.map((shift) => pickerRow(shift.name, shift.pcoPosition,
        (v) => store.updateShift(shift.id, { pcoPosition: v }))),
      // A role with its own position overrides its shift's.
      ...store.roles().map((role) => pickerRow(`Role: ${role.name}`, role.pcoPosition,
        (v) => store.updateRole(role.id, { pcoPosition: v }))),
    ]);
  }).catch(fail);

  return wrap;
}

/**
 * Ask how to send: notify people (notifications prepared, ready for Send in
 * Planning Center) or add them quietly. Resolves to true, false, or null if
 * cancelled. Asked every time, because it depends on the roster - a draft
 * roster to check with the team first is a quiet one.
 */
function askNotify(link, preview) {
  /** The lines of what is about to happen, from the read-only preview. */
  const lines = [
    `${preview.toAdd} will be added across ${preview.plans} plan${preview.plans === 1 ? '' : 's'}`
      + (preview.already ? `, ${preview.already} already there` : '') + '.',
    preview.noPlan.size
      ? `No plan yet on ${[...preview.noPlan].map((d) => formatDate(d, { withWeekday: false })).join(', ')}.` : null,
    preview.unlinked.size
      ? `Not on the Planning Center team: ${[...preview.unlinked].map((id) => preview.people.get(id)?.name || '(removed)').join(', ')}.` : null,
    preview.unmapped.size
      ? `No position picked for: ${[...preview.unmapped].map((id) => preview.shifts.get(id)?.name || '(removed)').join(', ')}.` : null,
  ].filter(Boolean);
  const summary = el('ul', { className: 'install-steps' }, lines.map((l) => el('li', { textContent: l })));

  // Nothing to add: say why and stop, rather than offering a send that does nothing.
  if (preview.toAdd === 0) {
    return dialog((close) => [
      el('h2', { textContent: 'Nothing to send' }),
      summary,
      el('div', { className: 'modal-actions' }, [
        el('button', { className: 'btn btn-primary', textContent: 'OK', onclick: () => close(null) }),
      ]),
    ]);
  }
  return dialog((close) => [
    el('h2', { textContent: 'Send to Planning Center' }),
    summary,
    el('p', {
      className: 'muted',
      textContent: `Adds everyone to the ${link.teamName} team in the matching `
        + `${link.serviceTypeName ? `${link.serviceTypeName} ` : ''}plans, as Unconfirmed.`,
    }),
    el('p', { className: 'muted', textContent: 'Should they be notified?' }),
    el('ul', { className: 'install-steps' }, [
      el('li', {}, [el('strong', { textContent: 'Notify: ' }),
        'notifications are prepared, and you press Send in Planning Center to send them '
        + '(Planning Center doesn’t let other apps send them).']),
      el('li', {}, [el('strong', { textContent: 'Don’t notify: ' }),
        'they go on the plans quietly; nobody hears anything.']),
    ]),
    el('div', { className: 'modal-actions' }, [
      el('button', { className: 'btn', textContent: 'Cancel', onclick: () => close(null) }),
      el('button', { className: 'btn', textContent: 'Don’t notify', onclick: () => close(false) }),
      el('button', { className: 'btn btn-primary', textContent: 'Notify', onclick: () => close(true) }),
    ]),
  ]);
}

/**
 * "Send to Planning Center" on a saved roster.
 *
 * Asks whether to notify first (it writes into someone else's system), then
 * reports exactly what went in and what didn't, because a partial send is
 * normal: a date with no plan, a person not on the team, or a shift with no
 * position.
 */
/** How the current organisation's people, shifts and roles map onto Planning Center. */
function lookupFor(link, roster = null) {
  const people = new Map(store.people().map((p) => [p.id, p]));
  const shifts = new Map(store.shifts().map((s) => [s.id, s]));
  // A one-off shift on this roster has no usual shift, but is still named in reports.
  for (const s of rosterShiftList(roster, [])) if (!shifts.has(s.id)) shifts.set(s.id, s);
  const roles = new Map(store.roles().map((r) => [r.id, r]));
  return {
    people, shifts,
    lookup: {
      teamId: link.teamId,
      serviceTypeId: link.serviceTypeId,
      personPcoId: (id) => people.get(id)?.pcoId || null,
      // A role's own position first, else the shift's.
      positionFor: (id, roleId) => (roleId != null && roles.get(roleId)?.pcoPosition) || shifts.get(id)?.pcoPosition || null,
    },
  };
}

/**
 * Ask Planning Center who has accepted or declined the places sent earlier.
 * Reads only. Returns `{ [place]: 'C' | 'U' | 'D' }` (see responseKey), or null on failure.
 */
export async function checkReplies(roster) {
  const { lookup } = lookupFor(store.currentOrg().pco);
  try {
    const replies = await pco.responsesFor(roster.assignments, lookup);
    const n = (s) => Object.values(replies).filter((v) => v === s).length;
    toast(Object.keys(replies).length
      ? `${n('C')} confirmed, ${n('D')} declined, ${n('U')} waiting`
      : 'Nobody from this roster is on a plan yet.');
    return replies;
  } catch (e) {
    toast(e instanceof pco.PCOError ? e.message : 'Could not check Planning Center.');
    return null;
  }
}

/**
 * Put a roster's places into Planning Center: preview what would change, ask
 * whether to notify people, send, then show the report. `status(text)` gets
 * progress lines, and null when finished.
 */
export async function sendToPlanningCenter(roster, status = () => {}) {
  const link = store.currentOrg().pco;
  const { people, shifts, lookup } = lookupFor(link, roster);
  try {
    // Look first, change nothing: show what would happen before asking.
    status('Checking Planning Center…');
    const preview = await pco.previewRoster(roster.assignments, lookup);
    preview.people = people;
    preview.shifts = shifts;
    const notify = await askNotify(link, preview);
    if (notify === null) return;

    const result = await pco.sendRoster(roster.assignments, lookup, { notify },
      (done, total) => status(`Sending ${done} of ${total}…`));
    showSendResult(result, people, shifts, notify);
  } catch (e) {
    toast(e instanceof pco.PCOError ? e.message : 'Sending to Planning Center failed.');
  } finally {
    status(null);
  }
}

/** True when `url` is an https address on planningcenteronline.com (or a subdomain of it). */
function isPcoUrl(url) {
  try {
    const u = new URL(url);
    return u.protocol === 'https:'
      && (u.hostname === 'planningcenteronline.com' || u.hostname.endsWith('.planningcenteronline.com'));
  } catch { return false; }
}

/**
 * The after-send report: what went in, each reason something didn't, and -
 * when notifying - a link to each plan, where Send is one tap away.
 */
function showSendResult(result, people, shifts, notify) {
  const lines = [];
  lines.push(notify
    ? `${result.added} added to Planning Center, with notifications ready to send.`
    : `${result.added} added to Planning Center quietly. Nobody has been notified.`);
  if (result.already) lines.push(`${result.already} were already there, left as they were.`);
  if (result.noPlan.size) {
    lines.push(`No plan on ${[...result.noPlan].map((d) => formatDate(d, { withWeekday: false })).join(', ')}. `
      + 'Create those plans in Planning Center, then send again.');
  }
  if (result.unlinked.size) {
    lines.push(`Not on the Planning Center team: ${[...result.unlinked].map((id) => people.get(id)?.name || '(removed)').join(', ')}.`);
  }
  if (result.unmapped.size) {
    lines.push(`No position picked for: ${[...result.unmapped].map((id) => shifts.get(id)?.name || '(removed)').join(', ')} `
      + '(Settings → Planning Center).');
  }

  // Each plan that gained someone, as a link straight to it in Planning Center.
  const planLinks = notify && result.plans.some((p) => p.url) ? [
    el('p', { className: 'muted', textContent: 'Open each plan and press Send to notify people:' }),
    el('div', { className: 'row' }, result.plans.filter((p) => p.url).map((p) => {
      const textContent = `Open ${formatDate(p.date, { withWeekday: false }).replace(/ \d{4}$/, '')}`;
      // Only a genuine Planning Center address becomes a link; anything else stays plain text.
      return isPcoUrl(p.url)
        ? el('a', { className: 'btn btn-sm', href: p.url, target: '_blank', rel: 'noopener', textContent })
        : el('span', { className: 'btn btn-sm', textContent });
    })),
  ] : [];

  return dialog((close) => [
    el('h2', { textContent: 'Sent to Planning Center' }),
    el('ul', { className: 'install-steps' }, lines.map((l) => el('li', { textContent: l }))),
    ...planLinks,
    el('div', { className: 'modal-actions' }, [
      el('button', { className: 'btn btn-primary', textContent: 'OK', onclick: () => close() }),
    ]),
  ]);
}
