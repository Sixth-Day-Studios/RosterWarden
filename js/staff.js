/**
 * The owner's side of staff links: make, send and replace a person's link,
 * pick up the dates they sent, and publish their name and upcoming shifts back
 * to their link page.
 *
 * What a staff member sends is their whole current list of dates they can't
 * work, not a change, so applying it is simple and repeatable: their dates
 * replace the away dates that came from their link before (tagged
 * `source: 'staff'`), and away dates the owner entered are never touched.
 *
 * The same mailboxes carry shift swaps (see "Shift swaps" at the end), and
 * each person's yes or no to their own shifts (see takeReplies), and shifts
 * sent out to be taken before a roster is built (see "Open shifts" at the end).
 */
import { store } from './store.js';
import * as link from './staff-link.js';
import { todayISO, toDays, fromDays, formatDate, auditRoster, shiftOn } from './scheduler.js';
import { shiftTimes } from './export.js';
import { responseKey } from './sources/planning-center.js';
import { slotsFor, slotsForPerson, shortName, settleClaims, lockedFrom } from './open-shifts.js';

/** How long, in days, the Updates log keeps an entry. */
const ACTIVITY_DAYS = 90;

/** Tag on away dates that came from a person's own link. */
export const SOURCE = 'staff';

/** Longest note a staff member can leave, in characters. */
const NOTE_MAX = 500;

/** Whether a person has a staff link. */
export function hasLink(person) {
  return Boolean(person?.staffLink?.key);
}

/** Everyone, across all organisations, who has a link. */
function linked(ids = null) {
  return store.data.people.filter((p) => hasLink(p) && (!ids || ids.includes(p.id)));
}

/** Patch a person's link record. */
function patchLink(personId, patch) {
  const person = store.data.people.find((p) => p.id === personId);
  if (person) store.updatePerson(personId, { staffLink: { ...person.staffLink, ...patch } });
}

// -------------------------------------------------------------- activity --
/*
 * Everything a staff member sends is also written to `store.data.activity`, a
 * log the owner can review on the Roster screen after the toast has gone.
 * Entries are `{ id, orgId, at, personId, kind, text, seen, ...where }` where
 * `kind` is reply, dates, note, swap or profile, and `where` says what the
 * entry is about (rosterId, date, shiftId, roleId) so it can be opened.
 */

/** Record something a person did. `where` is optional detail about the roster place. */
function logActivity(person, kind, text, where = {}) {
  store.data.activity.push({
    id: Math.random().toString(36).slice(2, 10) + Date.now().toString(36),
    orgId: person.orgId, at: new Date().toISOString(), personId: person.id, kind, text, ...where, seen: false,
  });
}

/** Entries older than the log keeps are dropped. */
function pruneActivity() {
  const cutoff = new Date(Date.now() - ACTIVITY_DAYS * 86400000).toISOString();
  store.data.activity = store.data.activity.filter((a) => a.at >= cutoff);
}

/** The current organisation's log, newest first. */
export function activityLog() {
  return store.data.activity
    .filter((a) => a.orgId === store.data.currentOrgId)
    .sort((a, b) => b.at.localeCompare(a.at));
}

/** How many entries in the current organisation's log have not been seen. */
export function unseenCount() {
  return activityLog().filter((a) => !a.seen).length;
}

/** Mark entries seen: the given ids, or (with none) all in the current organisation. */
export function markSeen(ids = null) {
  for (const a of activityLog()) if (!ids || ids.includes(a.id)) a.seen = true;
  store.save();
}

/** "8 Nov, 15 Nov and 22 Nov" for some ISO dates (the first three, then a count). */
function listDates(dates) {
  const shown = dates.slice(0, 3).map((d) => formatDate(d, { withWeekday: false }));
  if (dates.length > 3) shown.push(`${dates.length - 3} more`);
  return shown.length > 1 ? `${shown.slice(0, -1).join(', ')} and ${shown.at(-1)}` : shown[0];
}

/** The dates a person entered through their link, sorted. */
export function staffDates(person) {
  const out = [];
  for (const b of person.blackouts || []) {
    if (b.source !== SOURCE) continue;
    for (let d = b.start; d <= b.end; d = nextDay(d)) out.push(d);
  }
  return [...new Set(out)].sort();
}

/** The ISO date after `iso`. */
function nextDay(iso) {
  const d = new Date(`${iso}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + 1);
  return d.toISOString().slice(0, 10);
}

/** A link key no one else already holds (a clash is astronomically unlikely, but costs nothing to rule out). */
function uniqueLinkKey() {
  const taken = new Set(store.data.people.map((p) => p.staffLink?.key).filter(Boolean));
  let key = link.newLinkKey();
  while (taken.has(key)) key = link.newLinkKey();
  return key;
}

/** Give a person a link and put their name and shifts on it. */
export async function createLink(personId) {
  store.updatePerson(personId, {
    staffLink: {
      key: uniqueLinkKey(), sentAt: null, sentVia: null, lastFromStaff: null, note: '', outHash: null,
      profileSeen: null, profileSuggestion: null,
    },
  });
  try { await publish([personId]); } catch { /* published on the next sync instead */ }
}

/**
 * Give a newly added person a link straight away, unless they have one. The
 * key is made at once and works offline; their page is published in the
 * background, or on the next sync if that fails.
 */
export function autoLink(person) {
  if (!person || hasLink(person)) return;
  createLink(person.id).catch(() => { /* published on the next sync instead */ });
}

/** Record that the link was sent, and how (email, text, share, copy). */
export function markSent(personId, via) {
  patchLink(personId, { sentAt: new Date().toISOString(), sentVia: via });
}

/**
 * Replace a person's link: pick up anything waiting on the old one, cancel it
 * on the server so it can never write again, and give them a new one that
 * starts with the same dates.
 */
export async function replaceLink(personId) {
  await collect([personId]);
  const person = store.data.people.find((p) => p.id === personId);
  const { inId, outId } = await link.boxesFor(person.staffLink.key);
  await link.replaceBox(inId);
  await link.replaceBox(outId);
  patchLink(personId, { key: uniqueLinkKey(), sentAt: null, sentVia: null, outHash: null });
  try { await publish([personId]); } catch { /* published on the next sync instead */ }
}

/**
 * Cancel every staff link on the server, before Delete all data forgets their
 * keys. Otherwise the old pages stay up showing old shifts and quietly take
 * answers nobody will ever read; cancelled, they say the link was replaced.
 * Throws when the server can't be reached.
 */
export async function retireAllLinks() {
  for (const p of linked()) {
    const { inId, outId } = await link.boxesFor(p.staffLink.key);
    await link.replaceBox(inId);
    await link.replaceBox(outId);
  }
}

/** Take away every date a person entered through their link. */
export function clearStaffDates(personId) {
  store.replaceSourcedBlackouts(personId, SOURCE, []);
}

/** Only well-formed ISO dates, de-duplicated and sorted, at most 400. */
function cleanDates(list) {
  return [...new Set((Array.isArray(list) ? list : []).filter((d) => /^\d{4}-\d{2}-\d{2}$/.test(d)))]
    .sort().slice(0, 400);
}

/**
 * Pick up what staff have sent since last time and apply it. Returns the
 * people whose dates changed.
 */
export async function collect(ids = null) {
  const people = linked(ids);
  if (people.length === 0) return [];
  const keys = new Map();
  for (const p of people) keys.set(p.id, await link.boxesFor(p.staffLink.key));
  const boxes = await link.readBoxes(people.map((p) => ({ id: keys.get(p.id).inId, cryptoKey: keys.get(p.id).cryptoKey })));

  // Swaps on days long gone are history nobody needs.
  const cutoff = fromDays(toDays(todayISO()) - 30);
  store.data.swaps = store.data.swaps.filter((w) => w.date >= cutoff);

  pruneActivity();
  const changed = [];
  for (const p of people) {
    const box = boxes.get(keys.get(p.id).inId);
    if (!box || box.replaced) continue;
    if (p.staffLink.lastFromStaff && box.updatedAt <= p.staffLink.lastFromStaff) continue;
    takeSwaps(p, box.value);
    takeReplies(p, box.value);
    takeProfile(p, box.value);
    takeOpenReply(p, box.value);
    const before = staffDates(p);
    const dates = cleanDates(box.value?.awayDates);
    store.replaceSourcedBlackouts(p.id, SOURCE, dates.map((d) => ({ start: d, end: d, reason: 'from their link' })));
    const note = String(box.value?.note || '').slice(0, NOTE_MAX);
    logDateChanges(p, before, dates, p.staffLink.note, note);
    patchLink(p.id, { lastFromStaff: box.updatedAt, note });
    changed.push(store.data.people.find((x) => x.id === p.id));
  }
  return changed;
}

/** Log the dates a person added or removed, whether any now clash with a saved roster, and a changed note. */
function logDateChanges(person, before, after, oldNote, note) {
  const first = person.name.split(' ')[0];
  const added = after.filter((d) => !before.includes(d));
  const removed = before.filter((d) => !after.includes(d));
  if (added.length) {
    const fresh = store.data.people.find((x) => x.id === person.id);
    const clash = clashes([fresh]).find((c) => added.includes(c.date));
    logActivity(person, 'dates',
      `${first} can't work ${listDates(added)}${clash ? ` · clashes with ${clash.roster}` : ''}`,
      clash ? { rosterId: clash.rosterId, date: clash.date } : {});
  }
  if (removed.length) logActivity(person, 'dates', `${first} can work ${listDates(removed)} again`);
  if (note && note !== oldNote) logActivity(person, 'note', `${first} left a note: "${note.length > 120 ? `${note.slice(0, 120)}…` : note}"`);
}

/** Longest name, email and mobile a staff member can send, in characters. */
const NAME_MAX = 80;
const EMAIL_MAX = 120;
const MOBILE_MAX = 25;

/** Their details as sent, tidied: blank where missing or malformed (an email must look like one). */
function cleanProfile(value) {
  const text = (v) => String(v ?? '').replace(/\s+/g, ' ').trim();
  const email = text(value?.email).slice(0, EMAIL_MAX);
  return {
    name: text(value?.name).slice(0, NAME_MAX),
    email: /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) ? email : '',
    mobile: text(value?.mobile).replace(/[^0-9+()\- ]/g, '').trim().slice(0, MOBILE_MAX),
  };
}

/**
 * Take in the name, email and mobile a person sent. Like everything a page
 * sends it is their whole current state, so it is only acted on when it differs
 * from what they sent last (the owner may have changed a detail since, and a
 * repeat send must not undo that). Email and mobile apply straight away; a new
 * name waits as `staffLink.profileSuggestion` for the owner to accept. Blank
 * fields change nothing, and a person from Planning Center keeps the name and
 * email Planning Center gave them.
 */
function takeProfile(person, value) {
  if (!value?.profile || typeof value.profile !== 'object') return;
  const sent = cleanProfile(value.profile);
  const seen = JSON.stringify(sent);
  if (seen === person.staffLink.profileSeen) return;

  const patch = {};
  if (sent.mobile && sent.mobile !== person.phone) patch.phone = sent.mobile;
  if (!person.pcoId && sent.email && sent.email !== person.email) patch.email = sent.email;
  const suggest = !person.pcoId && sent.name && sent.name !== person.name ? { name: sent.name } : null;

  if (Object.keys(patch).length) store.updatePerson(person.id, patch);
  patchLink(person.id, { profileSeen: seen, profileSuggestion: suggest });
  if (Object.keys(patch).length || suggest) {
    const text = `${person.name.split(' ')[0]} updated their details`;
    news(person, 'profile', text);
  }
}

/** Accept (or dismiss) the new name a person suggested from their link. */
export function resolveNameSuggestion(personId, accept) {
  const person = store.data.people.find((p) => p.id === personId);
  const name = person?.staffLink?.profileSuggestion?.name;
  if (!name) return;
  if (accept) store.updatePerson(personId, { name });
  patchLink(personId, { profileSuggestion: null });
}

/** A short fingerprint of some text (FNV-1a), to tell whether a link page needs rewriting. */
function shortHash(text) {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(16);
}

/**
 * The date, shift name, times and role of a place, as a link page shows it.
 * `roster` is the roster the place belongs to, so a shift that runs differently
 * on that day is described as it runs then.
 */
function describePlace(place, roster) {
  const shift = shiftOn(roster, place.date, place.shiftId, store.data.shifts);
  const role = place.roleId != null ? store.data.roles.find((r) => r.id === place.roleId) : null;
  return {
    date: place.date,
    shift: shift?.name || 'Shift',
    times: shift ? shiftTimes(shift) : '',
    role: role ? role.name : null,
    note: shift?.note || '',
  };
}

/** 'yes', 'no' or null: the answer a roster holds for one place (from their link or Planning Center). */
function replyOf(roster, place) {
  const code = roster.responses?.[responseKey(place)];
  return code === 'C' ? 'yes' : code === 'D' ? 'no' : null;
}

/** A person's upcoming shifts from saved rosters, for their link page. */
function upcomingShifts(person) {
  const today = todayISO();
  return store.data.rosters
    .filter((r) => r.orgId === person.orgId && !r.draft)
    .flatMap((r) => r.assignments
      .filter((a) => a.personId === person.id && a.date >= today)
      .map((a) => ({ ...describePlace(a, r), ref: placeRef(r.id, a), reply: replyOf(r, a) })))
    .sort((x, y) => x.date.localeCompare(y.date))
    .slice(0, 60);
}

/** The shifts on a page that the person has said they can do, as a Cancelled line would show them. */
function saidYesTo(shifts) {
  return shifts.filter((s) => s.reply === 'yes')
    .map(({ ref, date, shift, times, role }) => ({ ref, date, shift, times, role }));
}

/**
 * Shifts a person said they can do that have since gone from their page -
 * taken off them, or the shift, day or roster removed - kept until the day
 * passes so their page can say so. A shift they swapped to someone else isn't
 * one, and one that comes back (an Undo) drops off again.
 */
function cancelledFor(person, shifts) {
  const today = todayISO();
  const now = new Set(shifts.map((s) => s.ref));
  const swappedAway = new Set(store.data.swaps
    .filter((w) => w.fromId === person.id && w.status === 'done').map((w) => placeRef(w.rosterId, w)));
  const before = person.staffLink.cancelled || [];
  const gone = (person.staffLink.shownYes || [])
    .filter((s) => !now.has(s.ref) && !swappedAway.has(s.ref) && !before.some((c) => c.ref === s.ref));
  return [...before, ...gone].filter((c) => c.date >= today && !now.has(c.ref));
}

/**
 * First names of people who said they can do any of these upcoming places on
 * `roster` (all of its places by default), so a confirm can say who would lose
 * a shift they agreed to.
 */
export function saidYes(roster, places = roster?.assignments || []) {
  const today = todayISO();
  const ids = new Set(places
    .filter((a) => a.date >= today && roster.responses?.[responseKey(a)] === 'C').map((a) => a.personId));
  return [...ids].map((id) => nameOf(id).split(' ')[0]);
}

/** " Sam and Ann said they can do it. …" for the end of a confirm, or "" when nobody did. */
export function cancelWarning(names, what = 'it') {
  if (!names.length) return '';
  const who = names.length === 1 ? names[0] : `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`;
  return ` ${who} said they can do ${what}. Anyone with a staff link will see ${what === 'it' ? 'it' : 'them'} marked cancelled there.`;
}

/**
 * Put each person's name, organisation, the dates they gave, their upcoming
 * shifts, and any they agreed to that were cancelled on their link page. Only
 * written when something changed.
 */
export async function publish(ids = null) {
  settleStale();
  for (const p of linked(ids)) {
    const org = store.data.orgs.find((o) => o.id === p.orgId);
    const shifts = upcomingShifts(p);
    const cancelled = cancelledFor(p, shifts);
    const content = {
      name: p.name, org: org?.name || '', pco: Boolean(p.pcoId),
      // Hints only, never the email or mobile itself: anyone the link is forwarded to sees this page.
      profile: { name: p.name, emailHint: link.maskEmail(p.email), mobileHint: link.maskMobile(p.phone) },
      // How far this app has read their mailbox, so their page can stop resending details already taken in.
      seenUpTo: p.staffLink.lastFromStaff || null,
      awayDates: staffDates(p), shifts, cancelled, swaps: swapPage(p), open: openPage(p),
    };
    const fingerprint = shortHash(JSON.stringify(content));
    if (fingerprint === p.staffLink.outHash) continue;
    const { outId, cryptoKey } = await link.boxesFor(p.staffLink.key);
    try {
      await link.writeBox(outId, cryptoKey, content);
      // Only once it's on their page: what they can now see they agreed to, and what it says was cancelled.
      patchLink(p.id, { outHash: fingerprint, shownYes: saidYesTo(shifts), cancelled });
    } catch (e) {
      if (!(e instanceof link.LinkReplaced)) throw e;
    }
  }
}

/**
 * Places on saved rosters from today on where someone is now away - what a
 * new date from their link (or anywhere) has just clashed with.
 */
export function clashes(people) {
  const today = todayISO();
  const out = [];
  for (const p of people) {
    const away = (d) => (p.blackouts || []).some((b) => b.start <= d && d <= b.end);
    for (const r of store.data.rosters) {
      if (r.draft || r.orgId !== p.orgId) continue;
      for (const a of r.assignments) {
        if (a.personId === p.id && a.date >= today && away(a.date)) out.push({ person: p, date: a.date, roster: r.name, rosterId: r.id });
      }
    }
  }
  return out;
}

/** Collect what staff sent, then refresh everyone's link page. Returns who changed. */
export async function syncStaff() {
  if (linked().length === 0) return [];
  const changed = await collect();
  await refreshClaims();
  await publish();
  return changed;
}

// ------------------------------------------------------------ shift swaps --
/*
 * A staff member can ask anyone else in the workplace to take one of their
 * upcoming shifts, available or not (they may want the extra shift), and that
 * colleague says yes or no on their own page. How far a yes goes is the
 * organisation's `swapMode`:
 *
 *   'off'      no swaps (the default)
 *   'self'     the colleague's yes hands the shift over
 *   'approval' the colleague's yes waits for the owner to approve it
 *
 * Staff have no channel to each other, so it all goes through the owner's
 * app: the ask arrives in the asker's mailbox and is published to the
 * colleague's page, whose answer comes back in their own mailbox. Like away
 * dates, a page always sends its whole list of asks and answers, so taking
 * them in is repeatable. A swap's status is one of: asked, accepted (waiting
 * for the owner), done, declined (by the colleague), rejected (by the owner),
 * or cancelled (withdrawn, swaps turned off, or the shift had changed).
 */

/** The choices for an organisation's `swapMode`. */
export const SWAP_MODES = ['off', 'self', 'approval'];

/** Statuses of a swap that is still going. */
const OPEN = ['asked', 'accepted'];

/** What a swap id from a staff page must look like. */
const SWAP_ID = /^[A-Za-z0-9_-]{8,64}$/;

/** Messages about swaps picked up since the app last asked, for a toast. */
let swapNews = [];

/** An organisation's swap setting, 'off' when it has none. */
export function swapMode(org) {
  return SWAP_MODES.includes(org?.swapMode) ? org.swapMode : 'off';
}

/**
 * Change an organisation's swap setting. Turning swaps off cancels the asks
 * no colleague has answered; ones already agreed still wait for the owner.
 */
export function setSwapMode(orgId, mode) {
  if (mode === 'off') {
    for (const w of store.data.swaps) if (w.orgId === orgId && w.status === 'asked') decide(w, 'cancelled');
  }
  store.updateOrg(orgId, { swapMode: mode });
}

/** Tell the owner something a person did: in the next toast, and in the log. */
function news(person, kind, text, where = {}) {
  swapNews.push(text);
  logActivity(person, kind, text, where);
}

/** Hand back, and forget, what happened with swaps since last asked. */
export function takeSwapNews() {
  const out = swapNews;
  swapNews = [];
  return out;
}

/** How a staff page refers to one place on a roster. */
function placeRef(rosterId, place) {
  return `${rosterId}:${place.date}:${place.shiftId}:${place.roleId ?? ''}`;
}

/** Whether `place` is the one a swap is for, still held by the asker. */
function isSwapPlace(swap, place) {
  return place.date === swap.date && place.shiftId === swap.shiftId
    && (place.roleId ?? null) === swap.roleId && place.personId === swap.fromId;
}

/** A person's name by id. */
function nameOf(id) {
  return store.data.people.find((p) => p.id === id)?.name || 'Someone';
}

/** Give a swap its next status. */
function decide(swap, status) {
  swap.status = status;
  swap.decidedAt = new Date().toISOString();
}

/**
 * Hand a swap's place to the colleague, locked so a rebuild keeps it, with the
 * roster's notes re-checked. False if the asker no longer has that place.
 */
function handOver(swap) {
  const roster = store.roster(swap.rosterId);
  const place = roster?.assignments.find((a) => isSwapPlace(swap, a));
  if (!place) return false;
  const next = roster.assignments.map((a) => (a === place ? { ...a, personId: swap.toId, locked: true } : a));
  // The roster's own organisation, which need not be the one open on screen.
  const ofOrg = (list) => list.filter((x) => x.orgId === roster.orgId).sort((a, b) => a.order - b.order || a.id - b.id);
  store.updateRoster(roster.id, {
    assignments: next,
    notes: auditRoster({ ...roster, assignments: next }, ofOrg(store.data.people), ofOrg(store.data.shifts), ofOrg(store.data.roles)),
  });
  return true;
}

/**
 * Cancel swaps still going whose asker no longer has the place, because the
 * owner changed or rebuilt the roster since, so nobody is left waiting on them.
 */
function settleStale() {
  let changed = false;
  for (const w of store.data.swaps) {
    if (!OPEN.includes(w.status)) continue;
    if (store.roster(w.rosterId)?.assignments.some((a) => isSwapPlace(w, a))) continue;
    decide(w, 'cancelled');
    changed = true;
  }
  if (changed) store.save();
}

/** "Sam's 1 Nov shift", for a toast. */
function swapLabel(swap) {
  return `${nameOf(swap.fromId).split(' ')[0]}'s ${formatDate(swap.date, { withWeekday: false })} shift`;
}

/** The upcoming saved-roster place a person's page means by `ref`, or null. */
function findPlace(person, ref) {
  const today = todayISO();
  for (const roster of store.data.rosters) {
    if (roster.draft || roster.orgId !== person.orgId) continue;
    const place = roster.assignments.find((a) => a.personId === person.id && a.date >= today && placeRef(roster.id, a) === ref);
    if (place) return { roster, place };
  }
  return null;
}

/** Take in the swap asks and answers in what a person last sent. */
function takeSwaps(person, value) {
  const mode = swapMode(store.data.orgs.find((o) => o.id === person.orgId));
  const asks = Array.isArray(value?.swapAsks) ? value.swapAsks.slice(0, 100) : null;
  const answers = Array.isArray(value?.swapAnswers) ? value.swapAnswers.slice(0, 100) : [];

  // A page from before swaps sends no list at all, which withdraws nothing.
  if (asks) {
    const sent = new Set();
    for (const ask of asks) {
      if (typeof ask?.id !== 'string' || !SWAP_ID.test(ask.id)) continue;
      sent.add(ask.id);
      if (mode === 'off' || store.data.swaps.some((w) => w.id === ask.id)) continue;
      // Anyone active in the same workplace, whatever their availability.
      const to = store.data.people.find((p) => p.id === ask.toId && p.orgId === person.orgId && p.id !== person.id && p.active && hasLink(p));
      const found = findPlace(person, String(ask.ref || ''));
      if (!to || !found) continue;
      const { roster, place } = found;
      // One ask at a time for any one place.
      if (store.data.swaps.some((w) => OPEN.includes(w.status) && w.rosterId === roster.id && isSwapPlace(w, place))) continue;
      store.data.swaps.push({
        id: ask.id, orgId: person.orgId, rosterId: roster.id,
        date: place.date, shiftId: place.shiftId, roleId: place.roleId ?? null,
        fromId: person.id, toId: to.id, status: 'asked', askedAt: new Date().toISOString(), decidedAt: null,
      });
      news(person, 'swap', `${person.name.split(' ')[0]} asked ${to.name.split(' ')[0]} to take their ${formatDate(place.date, { withWeekday: false })} shift`,
        { rosterId: roster.id, date: place.date });
    }
    // An ask no longer in their list was withdrawn.
    for (const w of store.data.swaps) {
      if (w.fromId === person.id && OPEN.includes(w.status) && !sent.has(w.id)) decide(w, 'cancelled');
    }
  }

  for (const answer of answers) {
    const swap = store.data.swaps.find((w) => w.id === answer?.id && w.toId === person.id && w.status === 'asked');
    if (!swap || mode === 'off') continue;
    const taker = nameOf(swap.toId).split(' ')[0];
    const where = { rosterId: swap.rosterId, date: swap.date };
    if (answer.accept !== true) {
      decide(swap, 'declined');
      logActivity(person, 'swap', `${taker} said no to ${swapLabel(swap)}`, where);
    } else if (mode === 'approval') {
      decide(swap, 'accepted');
      news(person, 'swap', `${taker} agreed to take ${swapLabel(swap)}: approve it on Roster`, where);
    } else if (handOver(swap)) {
      decide(swap, 'done');
      news(person, 'swap', `${taker} took ${swapLabel(swap)}`, where);
    } else {
      decide(swap, 'cancelled');
    }
  }
  store.save();
}

/**
 * Take in a person's yes or no to their own upcoming shifts. Like everything
 * a page sends, it is their whole list, so taking it in again changes nothing.
 * Answers go in the roster's `responses` with the same codes Planning Center
 * replies use ('C' can do it, 'D' can't), so the roster shows ✓ or ✕ and a
 * "can't" lands in its declined list. A place that has since gone to someone
 * else no longer matches, so their answer simply drops.
 */
function takeReplies(person, value) {
  const replies = Array.isArray(value?.shiftReplies) ? value.shiftReplies.slice(0, 200) : [];
  for (const r of replies) {
    if (typeof r?.yes !== 'boolean') continue;
    const found = findPlace(person, String(r.ref || ''));
    if (!found) continue;
    const { roster, place } = found;
    const key = responseKey(place);
    const code = r.yes ? 'C' : 'D';
    if (roster.responses?.[key] === code) continue;
    store.updateRoster(roster.id, { responses: { ...roster.responses, [key]: code } });
    const { shift } = describePlace(place, roster);
    news(person, 'reply', `${person.name.split(' ')[0]} ${r.yes ? 'can do' : 'can\'t do'} ${formatDate(place.date, { withWeekday: false })} ${shift}`,
      { rosterId: roster.id, date: place.date, shiftId: place.shiftId, roleId: place.roleId ?? null, yes: r.yes });
  }
}

/** What a person's link page needs for swaps: the setting, their colleagues, and the asks to and from them. */
function swapPage(person) {
  const mode = swapMode(store.data.orgs.find((o) => o.id === person.orgId));
  if (mode === 'off') return { mode };
  const today = todayISO();
  const upcoming = store.data.swaps.filter((w) => w.date >= today);
  return {
    mode,
    // Only people with a link of their own can see an ask and answer it.
    colleagues: store.data.people
      .filter((p) => p.orgId === person.orgId && p.active && p.id !== person.id && hasLink(p))
      .sort((a, b) => a.name.localeCompare(b.name))
      .map((p) => ({ id: p.id, name: p.name })),
    // Their own asks, so the page can say how each is going.
    out: upcoming.filter((w) => w.fromId === person.id).map((w) => ({
      id: w.id, ref: placeRef(w.rosterId, w), toId: w.toId, toName: nameOf(w.toId), status: w.status, ...describePlace(w, store.roster(w.rosterId)),
    })),
    // Asks waiting for their answer.
    in: upcoming.filter((w) => w.toId === person.id && w.status === 'asked').map((w) => ({
      id: w.id, fromName: nameOf(w.fromId), ...describePlace(w, store.roster(w.rosterId)),
    })),
  };
}

/** Swaps in the current organisation still going, optionally on one roster, as `{ swap, label }`. */
export function openSwaps(rosterId = null) {
  settleStale();
  const today = todayISO();
  return store.data.swaps
    .filter((w) => w.orgId === store.data.currentOrgId && OPEN.includes(w.status) && w.date >= today)
    .filter((w) => rosterId == null || w.rosterId === rosterId)
    .sort((a, b) => a.date.localeCompare(b.date))
    .map((swap) => {
      const place = describePlace(swap, store.roster(swap.rosterId));
      return {
        swap,
        label: `${nameOf(swap.fromId)} → ${nameOf(swap.toId)} · ${formatDate(swap.date, { withWeekday: false })} · ${place.shift}${place.role ? `, ${place.role}` : ''}`,
      };
    });
}

/**
 * The owner's answer to a swap both staff agreed. Approving hands the shift
 * over; it returns false when it couldn't, because the roster has changed and
 * the asker no longer has that place (the swap is then cancelled).
 */
export function decideSwap(id, approve) {
  const swap = store.data.swaps.find((w) => w.id === id && w.status === 'accepted');
  if (!swap) return false;
  if (!approve) {
    decide(swap, 'rejected');
    store.save();
    return true;
  }
  const ok = handOver(swap);
  decide(swap, ok ? 'done' : 'cancelled');
  store.save();
  return ok;
}

// ------------------------------------------------------------ open shifts --
/*
 * Before building, the owner can send the shifts for some dates out to be
 * taken: every staff page lists the ones that person can do, and the first
 * to tap "I'll take it" gets it (the worker referees, see js/staff-link.js).
 * Others then see "Taken by Sam T.". Each person takes at most one a day, and
 * can say they can't do a day at all, which becomes an away date like any
 * other from their link. Building from the set locks the taken shifts in;
 * the owner can still change or swap anyone after. One set is out per
 * organisation at a time (`store.data.openShifts`, see js/open-shifts.js).
 */

/** The open set an organisation has out now, or null. */
export function openShifts(orgId = store.data.currentOrgId) {
  return store.data.openShifts.find((o) => o.orgId === orgId && !o.closedAt) || null;
}

/** Send out `days`, each running `dayShifts[day]`, replacing any set already out. Then publish to every page. */
export async function sendOpenShifts(days, dayShifts) {
  const orgId = store.data.currentOrgId;
  const open = {
    id: Math.random().toString(36).slice(2, 10) + Date.now().toString(36),
    orgId, key: link.newLinkKey(), days: [...days].sort(),
    dayShifts: Object.fromEntries(days.map((d) => [d, dayShifts[d] || []])),
    sentAt: new Date().toISOString(), closedAt: null, claims: {},
  };
  // Only the set out now is kept; a stopped or replaced one is finished with.
  store.data.openShifts = [...store.data.openShifts.filter((o) => o.orgId !== orgId), open];
  store.save();
  await publish();
  return open;
}

/** Stop an open set: it leaves every page, and claims made after are ignored. Published in the background. */
export function stopOpenShifts(id) {
  if (!store.data.openShifts.some((o) => o.id === id)) return;
  store.data.openShifts = store.data.openShifts.filter((o) => o.id !== id);
  store.save();
  publish().catch(() => { /* published on the next sync instead */ });
}

/** The people in an organisation an open set is sent to: active, with a link. */
export function openAudience(orgId) {
  return store.data.people.filter((p) => p.orgId === orgId && p.active && hasLink(p));
}

/** The name a shift a person takes shows to everyone else: "Sam T.", told apart from anyone in their workplace it could be mistaken for. */
function pickName(person) {
  const others = store.data.people.filter((p) => p.orgId === person.orgId && p.id !== person.id).map((p) => p.name);
  return shortName(person.name, others);
}

/**
 * What a person's page needs for the open set: its key, the name to show on
 * what they take, and the slots they could take. Null when none is out, or
 * they aren't active.
 */
function openPage(person) {
  const open = openShifts(person.orgId);
  if (!open || !person.active) return null;
  const roles = store.data.roles.filter((r) => r.orgId === person.orgId);
  const roleById = new Map(roles.map((r) => [r.id, r]));
  return {
    id: open.id, key: open.key, me: pickName(person),
    slots: slotsForPerson(open, person, roleById).map((s) => ({
      ref: s.ref, date: s.date, shift: s.shift.name || 'Shift', times: shiftTimes(s.shift),
      role: s.roleId != null ? roleById.get(s.roleId)?.name || null : null, note: s.shift.note || '',
    })),
  };
}

/** Note that a person has answered an open set (their page says so whenever they take a shift or turn a day down). */
function takeOpenReply(person, value) {
  if (typeof value?.openReplied === 'string' && value.openReplied !== person.staffLink.openReplied) {
    patchLink(person.id, { openReplied: value.openReplied.slice(0, 40) });
  }
}

/**
 * Read who has taken what in every open set, keeping only claims really made
 * from that person's own link, and log the newly taken ones.
 */
export async function refreshClaims() {
  if (store.data.openShifts.length === 0) return;
  for (const open of store.data.openShifts) {
    const slots = slotsFor(open);
    const ids = await Promise.all(slots.map((s) => link.claimId(open.key, s.ref)));
    const found = await link.readClaims(ids, await link.openCryptoKey(open.key));
    // Whose link each claim's `by` comes from, among the people this set went to.
    const byOf = new Map();
    for (const p of openAudience(open.orgId)) byOf.set((await link.claimer(p.staffLink.key)).by, p);
    const claims = [];
    slots.forEach((s, i) => {
      const c = found.get(ids[i]);
      const person = c && byOf.get(c.by);
      if (person) claims.push({ ref: s.ref, personId: person.id, name: pickName(person), at: String(c.value?.at || '') });
    });
    const next = settleClaims(claims);
    for (const s of slots) {
      const c = next[s.ref];
      if (!c || open.claims[s.ref]?.personId === c.personId) continue;
      const person = store.data.people.find((p) => p.id === c.personId);
      news(person, 'open', `${person.name.split(' ')[0]} took ${formatDate(s.date, { withWeekday: false })} ${s.shift.name || 'Shift'}`, { date: s.date });
    }
    open.claims = next;
  }
  store.save();
}

/**
 * The shifts taken in the current organisation's open set, as locked places
 * for building on `dates`; `dayListFor(date)` is what each date runs now.
 */
export function openLocked(dates, dayListFor) {
  const open = openShifts();
  if (!open) return [];
  const keep = (id) => store.data.people.some((p) => p.id === id && p.active);
  return lockedFrom(open, dates, dayListFor, keep);
}
