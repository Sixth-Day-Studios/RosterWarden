/**
 * Signing in to a RosterWarden account, as the screens show it: the Sign in
 * and Sign up buttons (welcome screen and Settings), the trip to
 * sixthdaystudios.com and back, and what happens to the rosters afterwards.
 * The account itself is js/account.js.
 */
import { store } from '../store.js';
import { el, toast, dialog } from '../ui.js';
import { refreshOrgs, show } from '../app.js';
import * as account from '../account.js';
import * as sync from '../sync.js';

/** Take the account's sync code on this device, bringing in its rosters if it has any. */
async function adopt(code) {
  const result = await sync.pull(code);
  if (result) store.importJSON(JSON.stringify(result.data));
  sync.setDisabled(false);
  sync.setCode(code);
  // This device now holds that copy, so its next upload goes over it rather than being taken for a clash.
  if (result) sync.agreedWith(result.updatedAt);
  refreshOrgs();
}

/**
 * After signing in, make the account and this device agree on one sync code.
 * A new phone with nothing on it just takes the account's rosters; a phone
 * with its own rosters asks which to keep. Resolves false when that question
 * was dismissed, which leaves both as they were.
 */
async function matchAccount() {
  const matched = await account.matchCode();
  if (matched.mode !== 'differs') return;
  const fresh = store.orgs().length === 0;
  const useAccount = fresh || await dialog((close) => [
    el('h2', { textContent: 'Which rosters do you want?' }),
    el('p', {
      className: 'muted',
      textContent: 'Your account already has rosters saved, and this device has its own. Use the ones on your account '
        + '(this device\'s are replaced), or keep this device\'s and replace what your account has.',
    }),
    el('div', { className: 'modal-actions' }, [
      el('button', { className: 'btn', textContent: 'Keep this device\'s', onclick: () => close(false) }),
      el('button', { className: 'btn btn-primary', textContent: 'Use my account\'s', onclick: () => close(true) }),
    ]),
  ]);
  // Dismissed (Esc or Back) is not an answer: change nothing on either side, and say so.
  if (useAccount === null) return false;
  if (useAccount) {
    await adopt(matched.code);
    toast('Your rosters are back');
    show('roster');
  } else {
    await account.keepCode(sync.currentCode(), true);
    toast('Your account now keeps this device\'s rosters');
  }
}

/**
 * Sign in (or sign up): send the person to the site, which brings them back
 * here signed in (see `resumeSignIn`). Problems are written into `err`.
 */
export async function signIn({ signUp = false } = {}, err, done = () => {}) {
  err.textContent = '';
  try {
    location.href = await account.begin(signUp);
  } catch (e) {
    err.textContent = e.message;
    done();
  }
}

/**
 * Called when the app opens: if the site has just sent the person back from
 * signing in (`?code=…&state=…`), finish it, then sort out the sync code.
 * Resolves true if it signed in.
 */
export async function resumeSignIn() {
  const search = location.search;
  if (!account.isReturning(search)) return false;
  // The one-time code is spent either way: take it out of the address (and history) straight away.
  history.replaceState(null, '', location.pathname + location.hash);
  toast('Finishing signing in…');
  try {
    if (!(await account.finish(search))) return false;
    const settled = await matchAccount();
    toast(settled === false
      ? `Signed in as ${account.current().email}. Nothing changed: sign out and in again to choose which rosters to keep.`
      : `Signed in as ${account.current().email}`);
    return true;
  } catch (e) {
    toast(e.message);
    return false;
  }
}

/** The Sign in and Sign up buttons, side by side. */
export function signInButtons(err, done) {
  return el('div', { className: 'row-tight' }, [
    el('button', {
      type: 'button', className: 'btn btn-primary', style: 'flex:1', textContent: 'Sign in',
      onclick: () => signIn({}, err, done),
    }),
    el('button', {
      type: 'button', className: 'btn', style: 'flex:1', textContent: 'Sign up',
      onclick: () => signIn({ signUp: true }, err, done),
    }),
  ]);
}
