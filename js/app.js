/**
 * RosterWarden bootstrap: loads saved data, wires the nav and organisation
 * switcher, and hands control to whichever view is showing.
 *
 * Views are plain modules exporting `render(container)`. Switching view simply
 * re-renders; there is no virtual DOM and no client-side router beyond the hash,
 * which is enough for three sections and keeps the back button working.
 */
import { store } from './store.js';
import { el, fill, promptText, toast, closeSheet } from './ui.js';

import * as builderView from './views/roster.js';
import * as savedView from './views/saved.js';
import * as settingsView from './views/settings.js';
import * as teamView from './views/team.js';
// Imported for its side effect: it has to be listening for the browser's
// install event from the moment the app starts, not when Settings is opened.
import './install.js';
import * as sync from './sync.js';
import * as pco from './sources/planning-center.js';
import * as staff from './staff.js';
import * as account from './account.js';
import { signInButtons, resumeSignIn } from './views/account.js';
import { keyFromHash } from './staff-link.js';
import * as staffPage from './views/staff.js';
import { openWizard } from './views/wizard.js';
import { openAskGuardian } from './askguardian.js';
import { addShifts, templateShifts, addTemplateRoles } from './setup.js';

// Three tabs. "Rosters" is the rosters you have saved - the thing you open the
// app to look at - and the builder ("new") opens from it, under the same tab.
// "Team" is who you roster and what they do (people, shifts and their roles);
// Settings is the rest: the workplace itself, connections, and the app.
const VIEWS = {
  roster: savedView,
  new: builderView,
  team: teamView,
  settings: settingsView,
};

// Older hash links (and this app's own earlier tab names) still resolve, so a
// bookmark or a pinned home-screen link doesn't land on a blank screen.
const LEGACY_VIEWS = {
  saved: 'roster',
  build: 'new',
  people: 'team',
  shifts: 'team',
};

const NEW_ORG = '__new__';
const NEW_ORG_GUIDED = '__new_guided__';

let current = 'roster';

/** Render the active view into <main>, or prompt for an organisation first. */
export function render() {
  const container = document.getElementById('view');

  // Every screen except Settings needs an organisation to act on. The tabs
  // hide meanwhile, as all but Settings would only show this screen again.
  const welcoming = !store.currentOrg() && current !== 'settings';
  document.body.classList.toggle('no-workplace', welcoming);
  if (welcoming) {
    fill(container, welcome());
    return;
  }
  VIEWS[current].render(container);
  container.scrollTop = 0;
  // On a phone it is the page that scrolls, not <main>: without this, opening
  // a roster from the foot of the builder lands at the foot of the roster.
  window.scrollTo(0, 0);
}

/** First-run screen: name the workplace right here, no pop-up. */
function welcome() {
  const staffKey = rememberedLink();
  const nameInput = el('input', {
    type: 'text', placeholder: 'e.g. Church Cafe', 'aria-label': 'Workplace name',
  });
  const kindSelect = el('select', { 'aria-label': 'Start from' }, [
    el('option', { value: 'cafe', textContent: 'A cafe or similar (a shift of 2 people)' }),
    el('option', { value: 'band', textContent: 'A worship team (lead singer, guitar, drums…)' }),
    el('option', { value: 'catering', textContent: 'Catering or events (new events each week)' }),
    el('option', { value: 'blank', textContent: 'A blank start' }),
  ]);
  const create = (event) => {
    event.preventDefault();
    const name = nameInput.value.trim();
    if (!name) { nameInput.focus(); return; }
    createOrg(name, kindSelect.value);
  };
  const joinErr = el('div', { className: 'err' });

  return el('form', { className: 'card', onsubmit: create }, [
    staffKey ? el('div', { className: 'notice' }, [
      el('strong', { textContent: 'Looking for your shifts?' }),
      el('a', { className: 'btn btn-sm', textContent: 'Open my staff page', href: `${location.pathname}#staff=${staffKey}`, style: 'margin-top:.5rem' }),
    ]) : null,
    el('h2', { textContent: 'Welcome to RosterWarden' }),
    el('p', { className: 'muted' }, [
      'Fair rosters in seconds: add your people, say which days each can work, '
      + 'and RosterWarden does the shuffling. Everything stays on your devices.',
    ]),
    el('label', { className: 'label', textContent: 'What do you roster for?' }),
    nameInput,
    el('label', { className: 'label', textContent: 'Start from' }),
    kindSelect,
    el('button', {
      type: 'submit', className: 'btn btn-primary btn-lg btn-block', textContent: 'Get started',
    }),
    el('div', { className: 'or-line', textContent: 'or' }),
    // The guided route: opening hours, shifts, team and skills, one step at a time.
    el('button', {
      type: 'button', className: 'btn btn-lg btn-block', textContent: 'Walk me through it step by step',
      onclick: () => openWizard({ name: nameInput.value.trim(), kind: kindSelect.value }),
    }),
    // A replacement phone lands here first: offer the way back to its rosters.
    ...(sync.isConfigured() ? [
      el('div', { className: 'or-line', textContent: 'or' }),
      // Signed in already (an account with no rosters yet): say so, rather than offering Sign in again.
      ...(account.current() ? [
        el('div', { className: 'muted', textContent: `Signed in as ${account.current().email}. The workplace you set up here is kept with your account.` }),
      ] : []),
      // An account is the way back to the rosters on a new phone (it keeps the sync code, so nobody types one).
      ...(account.isConfigured() && !account.current() ? [
        el('div', { className: 'muted', textContent: 'Already use RosterWarden, or want your rosters kept safe?' }),
        signInButtons(joinErr, () => show('roster')),
      ] : []),
      joinErr,
    ] : []),
    // The tabs are hidden here, so Settings (install, help) gets a way in of its own.
    el('div', { className: 'or-line' }, [
      el('button', { type: 'button', className: 'link-btn', textContent: 'Settings and help', onclick: () => show('settings') }),
    ]),
  ]);
}

/**
 * Create an organisation with its starting shifts and roles (catering starts
 * with roles but no shifts) and take the user to People,
 * the next thing a new roster needs (by hand, or from Planning Center).
 */
function createOrg(name, kind = 'cafe') {
  store.addOrg(name);
  seedDefaults(kind);
  refreshOrgs();
  show('team', { section: 'people' });
  toast(`${name} created — now add your people`);
}

/**
 * Give a brand-new organisation one weekend shift to start from.
 * An empty Shifts screen is a dead end; a sensible default means the user can
 * go straight to adding people and press Build.
 */
function seedDefaults(kind = 'cafe') {
  addTemplateRoles(kind);
  addShifts(templateShifts(kind));
}

/** The order of the tabs, left to right, so a change of screen knows which way to slide. */
const TAB_ORDER = ['roster', 'new', 'team', 'settings'];

/**
 * Slide the screen in from the side of the tab that was tapped, with a fade.
 * Skipped when the person asks their phone for less motion, and a no-op where
 * the browser can't animate.
 */
function slideIn(direction) {
  const view = document.getElementById('view');
  if (!direction || !view.animate || matchMedia('(prefers-reduced-motion: reduce)').matches) return;
  view.animate(
    [{ opacity: 0, transform: `translateX(${direction * 28}px)` }, { opacity: 1, transform: 'none' }],
    { duration: 220, easing: 'cubic-bezier(.2,.7,.2,1)' },
  );
}

/** Switch the visible view and update the tab bar. */
export function show(name, options = {}) {
  closeSheet();   // moving to another screen leaves any sheet behind
  if (LEGACY_VIEWS[name]) {
    // A legacy name that now lives inside Settings or Team opens straight at
    // its section, so "shifts" still takes you to the shifts editor.
    if (['settings', 'team'].includes(LEGACY_VIEWS[name])) options = { section: name, ...options };
    name = LEGACY_VIEWS[name];
  }
  if (!VIEWS[name]) name = 'roster';
  if (name === 'settings') settingsView.openSection(options.section ?? null);
  if (name === 'team') teamView.openSection(options.section ?? null);
  const direction = Math.sign(TAB_ORDER.indexOf(name) - TAB_ORDER.indexOf(current));
  current = name;
  // The builder has no tab of its own: it lives under Rosters.
  const tabName = name === 'new' ? 'roster' : name;
  for (const tab of document.querySelectorAll('.tab')) {
    const active = tab.dataset.view === tabName;
    tab.setAttribute('aria-current', active ? 'page' : 'false');
  }
  if (location.hash !== `#${name}`) {
    history.replaceState(null, '', `#${name}`);
  }
  render();
  slideIn(direction);
}

/**
 * Show who is signed in at the right of the app bar, or nothing while signed out. Just the first name (else
 * the email before the @) so a phone still has room for the workplace; the full name and email are its tooltip.
 */
export function refreshAccount() {
  const chip = document.getElementById('account-chip');
  const who = account.current();
  chip.hidden = !who;
  chip.textContent = who ? (who.name || '').trim().split(/\s+/)[0] || who.email.split('@')[0] : '';
  chip.title = who ? `Your account: ${[who.name, who.email].filter(Boolean).join(', ')}` : '';
}

/** Rebuild the organisation dropdown from the store. */
export function refreshOrgs() {
  const select = document.getElementById('org-select');
  const orgs = store.orgs();
  const currentId = store.data.currentOrgId;

  fill(select, [
    ...orgs.map((o) => el('option', {
      value: String(o.id), textContent: o.name, selected: o.id === currentId,
    })),
    el('option', { value: NEW_ORG, textContent: '+ New organisation…' }),
    el('option', { value: NEW_ORG_GUIDED, textContent: '+ New organisation, step by step…' }),
  ]);
  select.hidden = orgs.length === 0;
}

/** Handle a change in the organisation dropdown. */
async function onOrgChange(event) {
  const value = event.target.value;
  if (value === NEW_ORG) {
    const name = await promptText('New organisation', 'What do you call this workplace?');
    refreshOrgs();                       // revert the select if they cancelled
    if (name) createOrg(name);
    return;
  }
  if (value === NEW_ORG_GUIDED) {
    refreshOrgs();                       // the select goes back to the current workplace
    openWizard();
    return;
  }
  store.setCurrentOrg(Number(value));
  render();
}

/** Register the service worker so the app opens with no connection. */
function registerWorker() {
  if (!('serviceWorker' in navigator)) return;

  // Not during local development: the worker serves the previous version from
  // its cache on first load, so an edit appears not to have taken effect. That
  // is the right behaviour for an installed app and the wrong one at a code
  // editor. Offline is verified against the deployed site instead.
  if (['localhost', '127.0.0.1', '::1'].includes(location.hostname)) return;

  // The worker refreshes its cache in the background (stale-while-revalidate),
  // but without this the new code only runs on the next cold start - so a phone
  // that is opened, glanced at and pocketed keeps showing the old version for
  // days. Reload once, the moment the worker says it has pulled a newer copy of
  // the app itself.
  let reloading = false;
  const reloadOnce = () => {
    if (reloading) return;
    reloading = true;
    location.reload();
  };

  // Sent by sw.js when it replaces a precached shell file with a changed one.
  navigator.serviceWorker.addEventListener('message', (event) => {
    if (event.data === 'shell-updated') reloadOnce();
  });

  // A brand-new worker took control. Ignored on a first-ever visit (there was
  // no controller to replace), where it just means the worker has claimed the
  // page rather than that anything changed.
  if (navigator.serviceWorker.controller) {
    navigator.serviceWorker.addEventListener('controllerchange', reloadOnce);
  }

  // Registration failure is not fatal - the app still works online - so this
  // must never surface an error to the user. Ask for an update check on every
  // launch rather than waiting for the browser's own schedule.
  navigator.serviceWorker.register('sw.js')
    .then((reg) => reg.update())
    .catch(() => {});
}

/**
 * A staff member's link: show only their page. Nothing else starts - no
 * workplace, and no sync of this phone's data - so opening a link can never
 * create or upload anything of its own.
 */
function startStaffPage(key) {
  registerWorker();
  window.addEventListener('hashchange', () => location.reload());
  staffPage.render(document.getElementById('view'), key);
}

/** The link this phone remembers from opening it before, or null. */
function rememberedLink() {
  try { return localStorage.getItem(staffPage.STORED_KEY); } catch { return null; }
}

/** Wire everything up and show the first screen. */
function init() {
  const linkKey = keyFromHash(location.hash);
  if (linkKey) { startStaffPage(linkKey); return; }

  store.load();

  // A staff member reopening the installed app (no hash) comes back to their page, as long as this phone isn't
  // also someone's roster, or signed in to (or just back from signing in to) an account. Close this page on the
  // staff page forgets it, so the icon then opens the ordinary app.
  if (!location.hash && store.orgs().length === 0 && !account.current() && !account.isReturning(location.search)
    && rememberedLink()) { startStaffPage(rememberedLink()); return; }

  // Sync is on unless the user has turned it off. Enabling it uploads what is
  // already here rather than replacing it, so switching on never costs anyone
  // the rosters they already had.
  sync.autoEnable();
  // keepFresh signs this device out if the account has gone, so the bar is redrawn once it answers.
  account.keepFresh().then(refreshAccount);
  // Back from signing in on the site: finish it, then show the rosters that came with the account.
  resumeSignIn().then((signedIn) => { if (signedIn) { refreshAccount(); render(); } });

  // Every save marks the device as having moved on, and queues an upload.
  store.onSaved((data) => {
    sync.markChanged();
    sync.schedulePush(data);
    // Staff link pages show upcoming shifts; refresh them a little after changes settle.
    clearTimeout(staffPublishTimer);
    staffPublishTimer = setTimeout(() => staff.publish().catch(() => {}), 5000);
  });
  refreshOrgs();
  refreshAccount();
  // The name in the bar opens Settings, whose last line is the account and Sign out.
  document.getElementById('account-chip').addEventListener('click', () => show('settings'));
  // Guardian's face in the bar opens the help chat, as Settings > Ask Guardian does.
  const askBtn = document.getElementById('ask-guardian');
  askBtn.addEventListener('click', () => openAskGuardian(askBtn));

  for (const tab of document.querySelectorAll('.tab')) {
    tab.addEventListener('click', () => show(tab.dataset.view));
  }
  document.getElementById('org-select').addEventListener('change', onOrgChange);
  window.addEventListener('hashchange', () => {
    if (keyFromHash(location.hash)) { location.reload(); return; }
    show(location.hash.slice(1));
  });
  // Coming back to the app is a good moment to look for dates staff have sent.
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') collectStaff();
  });
  // And every couple of minutes while it stays open on screen, so a reply shows up without leaving the app.
  setInterval(() => {
    if (document.visibilityState === 'visible') collectStaff();
  }, STAFF_CHECK_EVERY);

  show(location.hash.slice(1) || 'roster');
  registerWorker();
  startSync();
  finishPlanningCenterSignIn();
}

/**
 * Coming back from Planning Center's sign-in page: swap the code for a token
 * and open the Planning Center settings so the next step (pick a team) is
 * right there.
 */
async function finishPlanningCenterSignIn() {
  try {
    const outcome = await pco.finishSignIn();
    if (!outcome) return;
    show('settings', { section: 'planning-center' });
    toast(outcome === 'connected' ? 'Connected to Planning Center' : 'Planning Center sign-in cancelled');
  } catch (err) {
    show('settings', { section: 'planning-center' });
    toast(err instanceof pco.PCOError ? err.message : 'Planning Center sign-in failed');
  }
}

/**
 * Catch up with the server once the screen is already usable.
 *
 * Deliberately after the first render and never awaited: the device's own copy
 * is enough to work from, so nobody should be looking at a spinner while a
 * request completes - least of all on a bad connection.
 */
async function startSync() {
  const result = await sync.reconcile(store.data, (serverData) => {
    store.replaceAll(serverData);
    refreshOrgs();
    render();
  });

  if (result.action === 'downloaded') toast('Updated from your other device');
  if (result.action === 'conflict') {
    toast('This and another device both changed things — kept what is on this one');
  }
  collectStaff();
}

// Debounce timer for refreshing staff link pages after a save.
let staffPublishTimer = null;

// When staff links were last checked, so flicking between apps doesn't hammer the server.
let staffCheckedAt = 0;

// How often to look for staff replies while the app is open on screen.
const STAFF_CHECK_EVERY = 2 * 60 * 1000;

/**
 * Pick up dates and shift swaps staff have sent through their links, apply
 * them, and say so - loudly if a new date clashes with a saved roster. Quiet
 * when offline.
 */
async function collectStaff() {
  if (Date.now() - staffCheckedAt < 60 * 1000) return;
  staffCheckedAt = Date.now();
  try {
    const changed = await staff.syncStaff();
    if (changed.length === 0) return;
    const names = changed.length > 2 ? `${changed.length} people` : changed.map((p) => p.name.split(' ')[0]).join(' and ');
    const clashes = staff.clashes(changed);
    // What they sent may have been a shift swap, or a yes or no to a shift, rather than dates.
    const swapNews = staff.takeSwapNews();
    toast(swapNews.length ? swapNews.join('. ') : clashes.length
      ? `New dates from ${names}: ${clashes.length} clash with a saved roster`
      : `New dates from ${names}`, { label: 'See all', onclick: savedView.showUpdates });
    render();
  } catch {
    // Offline or the server is down: the next check will catch up.
  }
}

init();
