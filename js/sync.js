/**
 * End-to-end encrypted sync.
 *
 * Everything is encrypted on the device before it is sent. The sync server
 * stores an opaque blob under an opaque id and cannot read a single name. The
 * one place the key goes is a signed-in owner's account (js/account.js keeps
 * it there so a new phone can sign in instead of typing it), so whoever runs
 * the account server could unlock that owner's data; the app says so.
 *
 * How one secret produces two different things:
 *
 *   secret  (32 random bytes, shown to the user as the sync code)
 *     ├─ SHA-256("rosterwarden-id:"  + secret) ──▶ storage id   → SENT to the server
 *     └─ SHA-256("rosterwarden-key:" + secret) ──▶ AES-GCM key  → NEVER sent
 *
 * Both are derived from the same secret but neither can be worked back to the
 * other, so the server learns nothing about the key from the id it is given.
 *
 * The consequence, and it is not a small one: **lose the sync code and the
 * data cannot be recovered.** Not by the user, and not by whoever runs the
 * server, because nobody else has ever held the key. That is the price of the
 * server genuinely not being able to read it, and the UI says so plainly.
 *
 * AES-GCM with a fresh 12-byte nonce per write, via WebCrypto - no library.
 */
import { SYNC_URL } from './config.js';

/** localStorage key holding this device's sync secret. */
const SECRET_KEY = 'rosterwarden.sync.secret';

/** Set when the user has deliberately turned sync off on this device. */
const OFF_KEY = 'rosterwarden.sync.off';

/** Server timestamp this device last agreed with. */
const SYNCED_AT_KEY = 'rosterwarden.sync.at';

/** When this device last changed the data itself. */
const CHANGED_AT_KEY = 'rosterwarden.sync.changed';

/**
 * The CHANGED_AT_KEY value this device's data had when it last agreed with the
 * server. Compared for equality, never order, so it doesn't matter whose clock
 * any stamp came from.
 */
const AGREED_CHANGE_KEY = 'rosterwarden.sync.agreedChange';

const encoder = new TextEncoder();
const decoder = new TextDecoder();

/** Bytes → base64. */
function toBase64(bytes) {
  let binary = '';
  for (const b of new Uint8Array(bytes)) binary += String.fromCharCode(b);
  return btoa(binary);
}

/** base64 → bytes. */
function fromBase64(text) {
  const binary = atob(text);
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
  return out;
}

/**
 * Format a secret as a readable code: lower-case base32-ish in groups of four.
 *
 * People have to copy this between devices by hand, so it avoids characters
 * that look alike (0/O, 1/l/I) - a mistyped code is indistinguishable from a
 * wrong one, and there is no "forgot my code" to fall back on.
 */
const ALPHABET = '23456789abcdefghjkmnpqrstuvwxyz';

/** Turn raw bytes into a typo-resistant code string. */
function encodeCode(bytes) {
  let out = '';
  for (const b of bytes) out += ALPHABET[b % ALPHABET.length];
  return (out.match(/.{1,4}/g) || []).join('-');
}

/** Strip formatting so a pasted code with spaces or capitals still works. */
export function normaliseCode(code) {
  return String(code || '').toLowerCase().replace(/[^a-z0-9]/g, '');
}

/** Generate a new random sync code. */
export function generateCode() {
  const bytes = crypto.getRandomValues(new Uint8Array(20));
  return encodeCode(bytes);
}

/** SHA-256 of a string, as raw bytes. */
async function sha256(text) {
  return crypto.subtle.digest('SHA-256', encoder.encode(text));
}

/**
 * Derive the storage id and the encryption key from a sync code.
 * Distinct prefixes keep the two independent: the id can be public, the key
 * never is.
 */
export async function deriveKeys(code) {
  const secret = normaliseCode(code);
  const idBytes = await sha256(`rosterwarden-id:${secret}`);
  const keyBytes = await sha256(`rosterwarden-key:${secret}`);

  const storageId = [...new Uint8Array(idBytes)]
    .map((b) => b.toString(16).padStart(2, '0')).join('');
  const cryptoKey = await crypto.subtle.importKey(
    'raw', keyBytes, { name: 'AES-GCM' }, false, ['encrypt', 'decrypt']
  );
  return { storageId, cryptoKey };
}

/** Encrypt a JS value, returning base64 ciphertext and nonce. */
export async function encrypt(value, cryptoKey) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const plaintext = encoder.encode(JSON.stringify(value));
  const ciphertext = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv }, cryptoKey, plaintext
  );
  return { ciphertext: toBase64(ciphertext), iv: toBase64(iv) };
}

/**
 * Decrypt back to the original value.
 * Throws if the code is wrong or the data was tampered with - AES-GCM
 * authenticates, so a bad key fails loudly rather than returning noise.
 */
export async function decrypt({ ciphertext, iv }, cryptoKey) {
  const plaintext = await crypto.subtle.decrypt(
    { name: 'AES-GCM', iv: fromBase64(iv) }, cryptoKey, fromBase64(ciphertext)
  );
  return JSON.parse(decoder.decode(plaintext));
}

// ─── device state ────────────────────────────────────────────────────────

/** This device's sync code, or null when sync has never been switched on. */
export function currentCode() {
  try {
    return localStorage.getItem(SECRET_KEY);
  } catch {
    return null;
  }
}

/** Store (or, given null, forget) this device's sync code. */
export function setCode(code) {
  try {
    if (code) localStorage.setItem(SECRET_KEY, normaliseCode(code));
    else localStorage.removeItem(SECRET_KEY);
    return true;
  } catch {
    return false;
  }
}

/** True when the user has switched sync off here and meant it. */
export function isDisabled() {
  try {
    return localStorage.getItem(OFF_KEY) === '1';
  } catch {
    return false;
  }
}

/** Record (or clear) a deliberate decision to keep sync off on this device. */
export function setDisabled(off) {
  try {
    if (off) localStorage.setItem(OFF_KEY, '1');
    else localStorage.removeItem(OFF_KEY);
  } catch { /* storage unavailable; sync simply stays off for this session */ }
}

/** Read a stored timestamp, or '' when there isn't one. */
function stamp(key) {
  try {
    return localStorage.getItem(key) || '';
  } catch {
    return '';
  }
}

/** Write a stored timestamp. */
function setStamp(key, value) {
  try {
    localStorage.setItem(key, value);
  } catch { /* storage unavailable; reconciliation just re-runs next launch */ }
}

/** Note that this device has changed the data. Called on every save. */
export function markChanged() {
  setStamp(CHANGED_AT_KEY, new Date().toISOString());
}

/** Whether this device has changed the data since it last agreed with the server. */
function deviceMovedOn() {
  const changedAt = stamp(CHANGED_AT_KEY);
  if (!changedAt) return false;
  const agreed = stamp(AGREED_CHANGE_KEY);
  // A device that last synced before AGREED_CHANGE_KEY existed: the old comparison, this once.
  return agreed ? changedAt !== agreed : changedAt > stamp(SYNCED_AT_KEY);
}

/**
 * Record that this device and the server now hold the same copy: the server's
 * copy stamped `serverAt`, matching this device's data as it was at `changedAt`.
 */
function agree(serverAt, changedAt) {
  setStamp(SYNCED_AT_KEY, serverAt);
  setStamp(AGREED_CHANGE_KEY, changedAt);
}

/** Record that this device has just taken the server's copy stamped `serverAt`. */
function tookServerCopy(serverAt) {
  clearTimeout(pushTimer);   // a queued upload holds the data that was just replaced
  setStamp(CHANGED_AT_KEY, serverAt);
  agree(serverAt, serverAt);
}

/**
 * Note that this device's data is now the server's copy stamped `serverAt`,
 * having been brought in some other way (an account's rosters on a new phone).
 */
export function agreedWith(serverAt) {
  setStamp(SYNCED_AT_KEY, serverAt);
}

/**
 * Raised when an upload is refused because another device saved since this one
 * last agreed with the server. `updatedAt` is the stamp of what the server has.
 */
export class SyncConflict extends Error {
  constructor(updatedAt) {
    super('This device and another both changed things since they last matched.');
    this.updatedAt = updatedAt;
  }
}

/** True while a conflict waits for the person to choose a copy: nothing uploads meanwhile. */
let held = false;

/** Called when a background upload finds a conflict (see `onConflict`). */
let conflictListener = null;

/** Register the one listener told when a background upload finds a conflict. */
export function onConflict(fn) {
  conflictListener = fn;
}

/** Stop uploading until a copy is chosen, and say so. */
function hold() {
  held = true;
  clearTimeout(pushTimer);
  setStatus('conflict', 'This device and another both changed things since they last agreed.');
}

/**
 * Bring this device and the server into agreement: at startup, and each time
 * the app comes back on screen.
 *
 * The server holds the authoritative copy; the device keeps its own so the app
 * still opens and works with no signal. This decides which of the two moved on
 * since they last agreed:
 *
 *   server changed, device unchanged  ->  take the server's copy
 *   device changed, server unchanged  ->  upload
 *   both changed                      ->  hold uploads, and return 'conflict'
 *                                         for the person to choose (`resolveConflict`)
 *
 * The last case is the one that matters. Silently picking a winner is how
 * somebody's afternoon of edits disappears without anyone noticing, so nothing
 * is replaced, here or on the server, until the person says which to keep.
 *
 * "Changed" is judged by whether a stamp is the one last agreed, never by
 * which stamp is later, so devices whose clocks disagree can't fool it.
 *
 * `apply(data)` is called with the server's copy when that is the one to keep.
 */
export async function reconcile(localData, apply) {
  if (!isEnabled()) return { action: 'off' };

  const syncedAt = stamp(SYNCED_AT_KEY);

  let remote;
  try {
    remote = await pull();
  } catch (err) {
    setStatus('error', err.message);
    return { action: 'failed', message: err.message };
  }

  // Judged after the pull, so an edit made while it was on its way counts.
  const changedAt = stamp(CHANGED_AT_KEY);
  const deviceChanged = deviceMovedOn();

  // Nothing stored yet: this device seeds it.
  if (!remote) {
    try {
      agree(await push(localData, currentCode(), syncedAt), changedAt);
      held = false;
      setStatus('synced');
      return { action: 'uploaded' };
    } catch (err) {
      return failed(err);
    }
  }

  const serverMovedOn = remote.updatedAt !== syncedAt;

  if (serverMovedOn && deviceChanged) {
    hold();
    return { action: 'conflict', at: remote.updatedAt };
  }

  if (serverMovedOn) {
    apply(remote.data);
    tookServerCopy(remote.updatedAt);
    held = false;
    setStatus('synced');
    return { action: 'downloaded' };
  }

  if (deviceChanged) {
    try {
      agree(await push(localData, currentCode(), syncedAt), changedAt);
      held = false;
      setStatus('synced');
      return { action: 'uploaded' };
    } catch (err) {
      return failed(err);
    }
  }

  setStatus('synced');
  return { action: held ? 'conflict' : 'in-sync' };
}

/** What `reconcile` returns when an upload fails: a conflict found meanwhile, or the error. */
function failed(err) {
  if (err instanceof SyncConflict) {
    hold();
    return { action: 'conflict', at: err.updatedAt };
  }
  setStatus('error', err.message);
  return { action: 'failed', message: err.message };
}

/**
 * Settle a conflict the person has chosen a side in: keep this device's copy
 * (it replaces the server's) or take the server's (`apply(data)` is given it).
 * Throws SyncConflict if yet another save lands meanwhile, to be asked again.
 */
export async function resolveConflict(keepThisDevice, localData, apply) {
  const remote = await pull();
  if (keepThisDevice || !remote) {
    const changedAt = stamp(CHANGED_AT_KEY);
    agree(await push(localData, currentCode(), remote ? remote.updatedAt : stamp(SYNCED_AT_KEY)), changedAt);
  } else {
    apply(remote.data);
    tookServerCopy(remote.updatedAt);
  }
  held = false;
  setStatus('synced');
}

/**
 * Switch sync on by itself the first time the app runs on a device.
 *
 * On by default because the whole point is that a lost or wiped phone should
 * not mean a lost roster, and something you have to go and find in Settings
 * gets switched on after the data is already gone.
 *
 * It does not override a deliberate choice: once someone turns sync off, it
 * stays off until they turn it back on. Returns true if it just enabled it.
 */
export function autoEnable() {
  if (!isConfigured() || isDisabled() || currentCode()) return false;
  return setCode(generateCode());
}

/** True when a server has been configured and this device has a code. */
export function isEnabled() {
  return Boolean(SYNC_URL) && Boolean(currentCode());
}

/** True when the app was built without a sync server configured. */
export function isConfigured() {
  return Boolean(SYNC_URL);
}

// ─── transport ───────────────────────────────────────────────────────────

/** Raised for anything the user should see rather than a stack trace. */
export class SyncError extends Error {}

// ─── background pushing ──────────────────────────────────────────────────

/** Pending debounce timer for an automatic push. */
let pushTimer = null;

/** Most recent automatic-sync outcome. Nothing on screen shows it since the sync screen went; kept for checking from the console. */
export const status = { state: 'idle', at: null, message: '' };

/** Update the shared status. */
function setStatus(state, message = '') {
  status.state = state;
  status.message = message;
  status.at = new Date().toISOString();
}

/**
 * Queue an encrypted upload a few seconds from now.
 *
 * Debounced because the store saves on every keystroke-sized change, and each
 * push is a network round trip and a write against a daily quota. Failure is
 * deliberately quiet: the device still holds the data, so a dropped connection
 * is not something to interrupt someone mid-roster about - it shows in
 * Settings instead.
 */
export function schedulePush(data, delay = 3000) {
  if (!isEnabled() || held) return;
  clearTimeout(pushTimer);
  setStatus('pending');
  pushTimer = setTimeout(async () => {
    const changedAt = stamp(CHANGED_AT_KEY);
    try {
      // Only over the copy this device last agreed with: if another device saved since, the server says so.
      const at = await push(data, currentCode(), stamp(SYNCED_AT_KEY));
      // Record agreement, so the next launch knows this device is not ahead.
      agree(at, changedAt);
      setStatus('synced');
    } catch (err) {
      if (!(err instanceof SyncConflict)) { setStatus('error', err.message); return; }
      hold();
      conflictListener?.();
    }
  }, delay);
}

/**
 * Upload the encrypted database. Returns the timestamp the server recorded.
 * Given `base` (the stamp of the copy this device last agreed with), the server
 * refuses it with a SyncConflict if another device has saved since.
 */
export async function push(data, code = currentCode(), base = undefined) {
  if (!SYNC_URL) throw new SyncError('No sync server is configured for this app.');
  if (!code) throw new SyncError('Sync is not switched on for this device.');

  const { storageId, cryptoKey } = await deriveKeys(code);
  const payload = await encrypt(data, cryptoKey);
  const updatedAt = new Date().toISOString();

  let res;
  try {
    res = await fetch(`${SYNC_URL}/db/${storageId}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ...payload, updatedAt, ...(base !== undefined ? { base } : {}) }),
    });
  } catch {
    throw new SyncError('Could not reach the sync server. Your data is still safe on this device.');
  }
  if (res.status === 409) throw new SyncConflict((await res.json().catch(() => ({}))).updatedAt ?? null);
  if (!res.ok) throw new SyncError(`Sync server returned ${res.status}.`);
  return updatedAt;
}

/**
 * Download and decrypt the database for a code.
 * Returns null when the server has nothing stored for it yet.
 */
export async function pull(code = currentCode()) {
  if (!SYNC_URL) throw new SyncError('No sync server is configured for this app.');
  if (!code) throw new SyncError('Sync is not switched on for this device.');

  const { storageId, cryptoKey } = await deriveKeys(code);

  let res;
  try {
    res = await fetch(`${SYNC_URL}/db/${storageId}`);
  } catch {
    throw new SyncError('Could not reach the sync server.');
  }
  if (res.status === 404) return null;
  if (!res.ok) throw new SyncError(`Sync server returned ${res.status}.`);

  const body = await res.json();
  try {
    return { data: await decrypt(body, cryptoKey), updatedAt: body.updatedAt };
  } catch {
    // A wrong code lands here: the id happened to exist but the key does not
    // decrypt it. Far more likely is a typo than corruption, so say that.
    throw new SyncError('That code did not unlock the data — check it and try again.');
  }
}
