/**
 * "Ask Guardian" help chat: opens an overlay holding the Sixth Day Studios chat page in an iframe.
 * The chat itself (and its human check) lives on sixthdaystudios.com; this app only frames it, so no
 * help traffic passes through here. The page asks to be closed by posting { type: 'sds-help-close' }.
 */
import { el } from './ui.js';

const CHAT_ORIGIN = 'https://sixthdaystudios.com';
const CHAT_URL = `${CHAT_ORIGIN}/ask?app=rosterwarden`;

let overlay = null;   // the dialog, built on first open and kept for the life of the page
let opener = null;    // the control that last opened it, so focus can go back there
let closeBtn = null;

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
  const frame = el('iframe', { className: 'ask-frame', title: 'Ask Guardian', src: CHAT_URL, referrerPolicy: 'origin' });
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
    if (e.origin === CHAT_ORIGIN && e.data && e.data.type === 'sds-help-close') closeChat();
  });
}

/** Show the overlay (building it the first time) and move focus to its close button; `from` gets focus back on close. */
export function openAskGuardian(from) {
  opener = from || document.activeElement;
  if (!overlay) build();
  overlay.hidden = false;
  document.addEventListener('keydown', onKey);
  closeBtn.focus();
}
