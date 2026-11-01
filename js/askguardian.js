/**
 * "Ask Guardian" help chat: opens an overlay holding the Sixth Day Studios chat page in an iframe.
 * The chat itself (and its human check) lives on sixthdaystudios.com; this app only frames it, so no
 * help traffic passes through here. The page asks to be closed by posting { type: 'sds-help-close' }.
 * We tell it which screen is showing ({ type: 'sds-help-context', place }), and a "Show me" button in an
 * answer posts { type: 'sds-help-go', place }: the chat closes and the app goes to that place and makes it glow.
 */
import { el } from './ui.js';
import { show } from './app.js';
import { showUpdates } from './views/saved.js';

const CHAT_ORIGIN = 'https://sixthdaystudios.com';
const CHAT_URL = `${CHAT_ORIGIN}/ask?app=rosterwarden`;

// Where each place Guardian may name goes: a screen (and section) to show, and the text of the heading or
// button there to make glow. The keys match APP_PLACES for rosterwarden in the site's src/help.js; a key not
// listed here is ignored.
const PLACES = {
  'rosters': { view: 'roster' },
  'new-roster': { view: 'roster', find: '+ New roster' },
  'builder': { view: 'new', find: 'Build roster' },
  'updates': { run: () => showUpdates() },
  'team': { view: 'team', section: 'people', find: 'People' },
  'team-shifts': { view: 'team', section: 'shifts', find: 'Shifts' },
  'team-skills': { view: 'team', section: 'skills', find: 'Skills' },
  'settings': { view: 'settings' },
  'settings-workplace': { view: 'settings', section: 'workplace', find: 'Name, email and opening hours' },
  'settings-swaps': { view: 'settings', section: 'swaps', find: 'Shift swaps' },
  'settings-planning-center': { view: 'settings', section: 'planning-center', find: 'Planning Center' },
  'settings-ai': { view: 'settings', section: 'ai', find: 'AI assist' },
  'settings-install': { view: 'settings', section: 'install', find: 'Add to Home Screen' },
  'delete-all': { view: 'settings', find: 'Delete all data' },
};

// The place key for the screen showing now, from the address (#roster, #new, #team, #settings).
const SCREEN_PLACE = { roster: 'rosters', new: 'builder', team: 'team', settings: 'settings' };

let overlay = null;   // the dialog, built on first open and kept for the life of the page
let opener = null;    // the control that last opened it, so focus can go back there
let closeBtn = null;
let frame = null;

/** Hide the overlay and give focus back to the control that opened it. */
function closeChat() {
  if (!overlay || overlay.hidden) return;
  overlay.hidden = true;
  document.removeEventListener('keydown', onKey);
  if (opener && opener.isConnected) opener.focus();
}

/** Esc closes the overlay (only listened for while it is open). */
function onKey(e) {
  if (e.key === 'Escape') closeChat();
}

/** Build the overlay and its iframe (first open only), and start listening for the chat page's close message. */
function build() {
  closeBtn = el('button', {
    type: 'button', className: 'ask-close', textContent: '\u00d7',
    'aria-label': 'Close Ask Guardian', onclick: closeChat,
  });
  // referrerPolicy=origin so the chat page can see which app is embedding it and may ask us to close.
  frame = el('iframe', { className: 'ask-frame', title: 'Ask Guardian', src: CHAT_URL, referrerPolicy: 'origin' });
  overlay = el('div', { className: 'ask-overlay', 'aria-modal': 'true', 'aria-labelledby': 'ask-title', hidden: true }, [
    el('div', { className: 'ask-panel' }, [
      el('div', { className: 'ask-head' }, [el('h2', { id: 'ask-title', textContent: 'Ask Guardian' }), closeBtn]),
      frame,
    ]),
  ]);
  overlay.setAttribute('role', 'dialog');   // set as an attribute: the el() helper would use the (less supported) role property
  document.body.append(overlay);
  window.addEventListener('message', (e) => {
    // Only the chat page's own origin may close the overlay.
    if (e.origin !== CHAT_ORIGIN || e.source !== frame.contentWindow || !e.data) return;
    if (e.data.type === 'sds-help-close') closeChat();
    if (e.data.type === 'sds-help-go' && Object.hasOwn(PLACES, e.data.place)) {
      closeChat();
      goTo(PLACES[e.data.place]);
    }
  });
  // Once the chat page has loaded it can hear which screen is showing.
  frame.addEventListener('load', tellScreen);
}

/** Tell the chat page which screen is showing, so Guardian can start from where you are. */
function tellScreen() {
  const place = SCREEN_PLACE[location.hash.slice(1)] || '';
  frame?.contentWindow?.postMessage({ type: 'sds-help-context', place }, CHAT_ORIGIN);
}

/** Go to a place and make its heading or button glow for a moment (the tab when it can't be found). */
function goTo(place) {
  if (place.run) { place.run(); return; }
  show(place.view, place.section ? { section: place.section } : {});
  // Wait a beat for the new screen to draw before looking for the thing to glow.
  setTimeout(() => {
    const view = document.getElementById('view');
    const matches = (n) => n.textContent.trim().startsWith(place.find);
    const target = (place.find && view && ([...view.querySelectorAll('h2, h3')].find(matches)
      || [...view.querySelectorAll('button')].find(matches)))
      || document.querySelector('.tab[aria-current="page"]');
    if (!target) return;
    target.scrollIntoView({ block: 'center', behavior: 'smooth' });
    target.classList.remove('guardian-glow');
    void target.offsetWidth;   // restart the glow if the same thing is shown twice
    target.classList.add('guardian-glow');
    setTimeout(() => target.classList.remove('guardian-glow'), 2600);
  }, 350);
}

/** Show the overlay (building it the first time) and move focus to its close button; `from` gets focus back on close. */
export function openAskGuardian(from) {
  opener = from || document.activeElement;
  if (!overlay) build();
  overlay.hidden = false;
  tellScreen();
  document.addEventListener('keydown', onKey);
  closeBtn.focus();
}
