/**
 * The owner's RosterWarden account: a Sixth Day account (password, Google or
 * Microsoft) that keeps this workplace's sync code, so a new phone gets its
 * rosters back by signing in instead of typing a code.
 *
 * Signing in is a standard redirect (authorization code with PKCE), so the
 * app never sees a password: `begin()` sends the person to sixthdaystudios.com,
 * which signs them in if needed and sends them straight back here with a
 * one-time code, and `finish()` swaps that code for a token. The token is kept
 * here and used to read and keep the sync code (see sixthdaystudios's
 * src/rwaccount.js). The rosters themselves stay encrypted with that code.
 */
import { ACCOUNT_URL } from './config.js';
import * as sync from './sync.js';

/** localStorage key for the signed-in account. */
const ACCOUNT_KEY = 'rosterwarden.account';

/** Raised for anything the person should read, such as an expired code. */
export class AccountError extends Error {}

/** The signed-in account `{ token, email, name }`, or null. */
function stored() {
  try {
    return JSON.parse(localStorage.getItem(ACCOUNT_KEY) || 'null');
  } catch {
    return null;
  }
}

/** Remember (or, given null, forget) the signed-in account. */
function store(account) {
  try {
    if (account) localStorage.setItem(ACCOUNT_KEY, JSON.stringify(account));
    else localStorage.removeItem(ACCOUNT_KEY);
  } catch { /* private mode: they will be asked to sign in again next time */ }
}

/** Who is signed in as `{ email, name }`, or null. */
export function current() {
  const a = stored();
  return a ? { email: a.email, name: a.name } : null;
}

/** The signed-in account's token, for the sync worker to check who is asking (js/email.js), or null. */
export function token() {
  return stored()?.token || null;
}

/** Whether the app was built with an account server to sign in to. */
export function isConfigured() {
  return Boolean(ACCOUNT_URL);
}

/** Call the account server and return `{ status, data }`; a network failure becomes an AccountError. */
async function call(method, path, body, token = null) {
  let res;
  try {
    res = await fetch(`${ACCOUNT_URL}${path}`, {
      method,
      headers: { ...(body ? { 'Content-Type': 'application/json' } : {}), ...(token ? { Authorization: `Bearer ${token}` } : {}) },
      body: body ? JSON.stringify(body) : undefined,
    });
  } catch {
    throw new AccountError('Could not reach the account server. Check your connection.');
  }
  let data = {};
  try { data = await res.json(); } catch { /* an empty body */ }
  return { status: res.status, data };
}

/**
 * localStorage key for a sign-in that has gone off to the site: its state and
 * PKCE verifier, until the site sends the person back. localStorage rather
 * than sessionStorage, so it survives a phone handing the site to the browser.
 */
const PENDING_KEY = 'rosterwarden.account.pending';
const PENDING_MINUTES = 15;

/** `n` random bytes as base64url text. */
function randomText(n) {
  return base64url(crypto.getRandomValues(new Uint8Array(n)));
}

/** Bytes as base64url (no padding), as PKCE wants. */
function base64url(bytes) {
  return btoa(String.fromCharCode(...new Uint8Array(bytes))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/** The address the site sends the person back to: this page, without its query or #route. */
function returnAddress() {
  return location.origin + location.pathname;
}

/**
 * Begin signing in: make a PKCE verifier and state, remember them for when
 * this page comes back from the site, and return the site's sign-in address
 * to send the person to. `signUp` goes to the sign-up page instead.
 */
export async function begin(signUp = false) {
  // Signing up has nothing to come back with yet: they make the account, then tap Sign in.
  if (signUp) return `${ACCOUNT_URL}/register`;
  const verifier = randomText(32);
  const state = randomText(16);
  const redirectUri = returnAddress();
  const challenge = base64url(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier)));
  try {
    localStorage.setItem(PENDING_KEY, JSON.stringify({ state, verifier, redirectUri, until: Date.now() + PENDING_MINUTES * 60000 }));
  } catch {
    throw new AccountError('This browser is blocking storage, so signing in can\'t finish. Try a normal (not private) window.');
  }
  const q = new URLSearchParams({ redirect_uri: redirectUri, state, code_challenge: challenge, code_challenge_method: 'S256' });
  return `${ACCOUNT_URL}/rw/authorize?${q}`;
}

/** Whether `search` (a page's `location.search`) is the site sending a sign-in back. */
export function isReturning(search) {
  const q = new URLSearchParams(search);
  return q.has('code') && q.has('state');
}

/**
 * Finish a sign-in the site sent back (`search` is `location.search`): check
 * it is the one this device started, swap the code for a token and keep it.
 * Returns `{ email, name }`, or null if this address isn't a sign-in coming back.
 */
export async function finish(search) {
  if (!isReturning(search)) return null;
  const q = new URLSearchParams(search);
  let p = null;
  try {
    p = JSON.parse(localStorage.getItem(PENDING_KEY) || 'null');
    localStorage.removeItem(PENDING_KEY);      // used once, whatever happens next
  } catch { /* nothing kept: treated as not started here */ }
  // Already signed in with no sign-in under way: a stray second trip back from
  // the site (say, Back through its sign-in page) has nothing to finish.
  if (!p && stored()) return null;
  if (!p || p.until < Date.now() || p.state !== q.get('state')) {
    throw new AccountError('That sign-in wasn\'t started on this device, or took too long. Please tap Sign in again.');
  }
  const { status, data } = await call('POST', '/api/rw/token', { code: q.get('code'), code_verifier: p.verifier, redirect_uri: p.redirectUri });
  if (status !== 200 || !data.token) throw new AccountError(data.error || 'That sign-in did not work.');
  store({ token: data.token, email: data.email, name: data.name });
  return { email: data.email, name: data.name };
}

/** Sign out of this device (the sync code stays, so sync keeps working). */
export function signOut() {
  store(null);
}

/**
 * Swap the token for a fresh one so use of the app keeps the person signed in.
 * Signed out for good if the server says the account is no longer valid.
 */
export async function keepFresh() {
  const a = stored();
  if (!a) return;
  try {
    const { status, data } = await call('POST', '/api/rw/refresh', { token: a.token });
    if (data.token) store({ ...a, token: data.token });
    else if (status === 401) store(null);
  } catch { /* offline: the old token still has weeks left */ }
}

/**
 * Line this device's sync code up with the account's, after signing in:
 *
 *   'uploaded'  the account kept nothing yet, so this device's code is now kept
 *   'same'      the account already keeps this device's code
 *   'differs'   the account keeps another code, returned as `code`; the caller
 *               chooses between `adopt` (take the account's) and `replace`
 */
export async function matchCode() {
  const a = stored();
  if (!a) throw new AccountError('Sign in first.');
  const { status, data } = await call('GET', '/api/rw/key', null, a.token);
  if (status === 404) {
    const code = sync.currentCode();
    if (!code) return { mode: 'uploaded' };
    await keepCode(code);
    return { mode: 'uploaded' };
  }
  if (status !== 200) throw new AccountError(data.error || 'Could not read your account.');
  return sync.normaliseCode(data.code) === sync.currentCode() ? { mode: 'same' } : { mode: 'differs', code: data.code };
}

/** Keep `code` on the account, replacing a different one already there only when `replace` is true. */
export async function keepCode(code, replace = false) {
  const a = stored();
  if (!a) return;
  const { status, data } = await call('PUT', '/api/rw/key', { code: sync.normaliseCode(code), replace }, a.token);
  if (status !== 200) throw new AccountError(data.error || 'Could not save your sync code to your account.');
}
