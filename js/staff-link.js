/**
 * Staff links: a private link per staff member for entering the dates they
 * can't work, with nothing readable on the server.
 *
 * Each link carries a random key after the `#`, which browsers never send to
 * a server. The owner's app keeps a copy of the key inside its own encrypted
 * data. From the key come two mailbox ids and one encryption key:
 *
 *   link key
 *     ├─ SHA-256("rosterwarden-staff-in:"  + key) ──▶ "in" box id   (staff → owner)
 *     ├─ SHA-256("rosterwarden-staff-out:" + key) ──▶ "out" box id  (owner → staff)
 *     └─ SHA-256("rosterwarden-staff-key:" + key) ──▶ AES-GCM key   NEVER sent
 *
 * So the sync worker holds two small encrypted boxes per person and can read
 * neither, and the key cannot be worked back from the ids it does see.
 * Replacing a link marks its boxes replaced on the worker, so an old or leaked
 * link can never write again.
 *
 * Both boxes share the one key, so each is sealed for its own id (see `unseal`
 * in js/sync.js): what the owner published can't be handed back as what the
 * staff member sent, or the other way round.
 */
import { SYNC_URL } from './config.js';
import { encrypt, decrypt, unseal } from './sync.js';

const encoder = new TextEncoder();

/** A link key's shape: 32 random bytes as unpadded base64url. */
const KEY_PATTERN = /^[A-Za-z0-9_-]{43}$/;

/** Raised when a link has been replaced by a newer one. */
export class LinkReplaced extends Error {}

/** Raised for anything else the user should be told about. */
export class LinkError extends Error {}

/** A fresh, unguessable link key. */
export function newLinkKey() {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  return btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/** The key in a `#staff=…` address, or null if it doesn't hold a valid one. */
export function keyFromHash(hash) {
  const m = /^#?staff=([A-Za-z0-9_-]+)$/.exec(hash || '');
  return m && KEY_PATTERN.test(m[1]) ? m[1] : null;
}

/**
 * An email as a staff page shows it ("m…@example.com"), or '' if there's none. A link can be forwarded, so
 * the page only ever gets this hint, never the email itself.
 */
export function maskEmail(email) {
  const m = /^(.)[^@]*(@.+)$/.exec(String(email || '').trim());
  return m ? `${m[1]}…${m[2]}` : '';
}

/** A mobile as a staff page shows it ("Ends in 42"), or '' if there's none; see `maskEmail`. */
export function maskMobile(mobile) {
  const digits = String(mobile || '').replace(/\D/g, '');
  return digits.length >= 2 ? `Ends in ${digits.slice(-2)}` : '';
}

/** The address of the app itself (no file name, query or hash), for building links. */
export function appBase() {
  return location.origin + location.pathname.replace(/index\.html$/, '');
}

/** The link to send a staff member. */
export function linkUrl(key, base = appBase()) {
  return `${base}#staff=${key}`;
}

/** Hex SHA-256 of a string. */
async function hexHash(text) {
  const bytes = new Uint8Array(await crypto.subtle.digest('SHA-256', encoder.encode(text)));
  return [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/** The two mailbox ids and the encryption key that a link key gives. */
export async function boxesFor(key) {
  const keyBytes = await crypto.subtle.digest('SHA-256', encoder.encode(`rosterwarden-staff-key:${key}`));
  return {
    inId: await hexHash(`rosterwarden-staff-in:${key}`),
    outId: await hexHash(`rosterwarden-staff-out:${key}`),
    cryptoKey: await crypto.subtle.importKey('raw', keyBytes, { name: 'AES-GCM' }, false, ['encrypt', 'decrypt']),
  };
}

/** Make a request to the worker, turning network failure into a readable error. */
async function request(path, options = {}) {
  if (!SYNC_URL) throw new LinkError('Staff links need sync to be set up.');
  try {
    return await fetch(`${SYNC_URL}${path}`, {
      ...options, headers: { 'Content-Type': 'application/json', ...(options.headers || {}) },
    });
  } catch {
    throw new LinkError('Could not reach the server. Check your connection.');
  }
}

/** Encrypt `value` into a mailbox. Throws LinkReplaced if the link has been replaced. */
export async function writeBox(id, cryptoKey, value) {
  const updatedAt = new Date().toISOString();
  const res = await request(`/box/${id}`, {
    method: 'PUT', body: JSON.stringify({ ...(await encrypt(value, cryptoKey, id)), updatedAt }),
  });
  if (res.status === 410) throw new LinkReplaced('This link has been replaced.');
  if (!res.ok) throw new LinkError('Saving failed. Try again in a moment.');
  return updatedAt;
}

/**
 * A mailbox's contents as `{ value, updatedAt, bound }`, null if empty; LinkReplaced if replaced.
 * `strict` refuses a copy not sealed for this box (pass it once a `bound` one has been seen there).
 */
export async function readBox(id, cryptoKey, strict = false) {
  const res = await request(`/box/${id}`);
  if (res.status === 404) return null;
  if (res.status === 410) throw new LinkReplaced('This link has been replaced.');
  if (!res.ok) throw new LinkError('Loading failed. Try again in a moment.');
  const body = await res.json();
  return { ...(await unseal(body, cryptoKey, id, strict)), updatedAt: body.updatedAt };
}

/**
 * Several mailboxes in one request: `entries` is `[{ id, cryptoKey, strict }]`
 * (`strict` as for `readBox`). Returns a Map of id to `{ value, updatedAt, bound }`
 * or `{ replaced: true }`; empty boxes, and any that will not decrypt, are left out.
 */
export async function readBoxes(entries) {
  const out = new Map();
  for (let i = 0; i < entries.length; i += 200) {
    const batch = entries.slice(i, i + 200);
    const res = await request('/boxes', { method: 'POST', body: JSON.stringify({ ids: batch.map((e) => e.id) }) });
    if (!res.ok) throw new LinkError('Checking staff links failed.');
    const found = await res.json();
    for (const { id, cryptoKey, strict } of batch) {
      const box = found[id];
      if (!box) continue;
      if (box.replaced) { out.set(id, { replaced: true }); continue; }
      try {
        out.set(id, { ...(await unseal(box, cryptoKey, id, strict)), updatedAt: box.updatedAt });
      } catch {
        // Not decryptable with this key: not ours to read, so treated as empty.
      }
    }
  }
  return out;
}

/** Mark a mailbox replaced, so the link it came from stops working for good. */
export async function replaceBox(id) {
  const res = await request(`/box/${id}`, { method: 'DELETE' });
  if (!res.ok) throw new LinkError('Could not cancel the old link. Try again in a moment.');
}

// ---------------------------------------------------------- open shifts --
/*
 * Shifts sent out to be taken (see js/open-shifts.js). Each set has its own
 * random key, given to every staff page, and from it come the claim ids and
 * the key that seals them:
 *
 *   open key ─┬─ SHA-256("rosterwarden-claim:" + key + ":" + slot ref) ──▶ claim id
 *             └─ SHA-256("rosterwarden-open-key:" + key)                ──▶ AES-GCM key
 *
 * A person proves a claim is theirs with a token from their own link key,
 * SHA-256("rosterwarden-claimer:" + link key). The worker keeps only the
 * token's hash, `by`, which every page sees, so a page can tell its own
 * claims apart, and the owner can check who really took each one.
 */

/** The sealing key for an open set's claims. */
export async function openCryptoKey(openKey) {
  const keyBytes = await crypto.subtle.digest('SHA-256', encoder.encode(`rosterwarden-open-key:${openKey}`));
  return crypto.subtle.importKey('raw', keyBytes, { name: 'AES-GCM' }, false, ['encrypt', 'decrypt']);
}

/** The server id of one slot's claim. */
export function claimId(openKey, ref) {
  return hexHash(`rosterwarden-claim:${openKey}:${ref}`);
}

/** A person's claim token (kept secret) and its hash `by` (what the worker shows), from their link key. */
export async function claimer(linkKey) {
  const token = await hexHash(`rosterwarden-claimer:${linkKey}`);
  return { token, by: await hexHash(token) };
}

/**
 * Take a slot: `value` (who, sealed) goes in under `id` if nobody else holds
 * it. True if it's now theirs, false if someone else got it first. `bound`
 * (the open set's own `bound`) seals the claim for its slot, so it can't be
 * moved onto another one; sets sent out before that existed stay as they were.
 */
export async function takeClaim(id, token, cryptoKey, value, bound = false) {
  const res = await request(`/claim/${id}`, {
    method: 'PUT', body: JSON.stringify({ ...(await encrypt(value, cryptoKey, bound ? id : null)), token }),
  });
  if (res.status === 409) return false;
  if (!res.ok) throw new LinkError('Could not take that shift. Try again in a moment.');
  return true;
}

/** Let a slot go again (only works for whoever took it). */
export async function releaseClaim(id, token) {
  const res = await request(`/claim/${id}`, { method: 'DELETE', body: JSON.stringify({ token }) });
  if (!res.ok) throw new LinkError('Could not let that shift go. Try again in a moment.');
}

/**
 * The claims held on some slots: a Map of id to `{ value, by }`. Free slots,
 * and any claim that won't open with `cryptoKey`, are left out. With `bound`
 * (see `takeClaim`) a claim must have been sealed for the very slot it is on.
 */
export async function readClaims(ids, cryptoKey, bound = false) {
  const out = new Map();
  for (let i = 0; i < ids.length; i += 200) {
    const batch = ids.slice(i, i + 200);
    const res = await request('/claims', { method: 'POST', body: JSON.stringify({ ids: batch }) });
    if (!res.ok) throw new LinkError('Checking the open shifts failed.');
    const found = await res.json();
    for (const id of batch) {
      if (!found[id]) continue;
      try {
        out.set(id, { value: await decrypt(found[id], cryptoKey, bound ? id : null), by: found[id].by });
      } catch {
        // Not sealed with this set's key: not a real claim.
      }
    }
  }
  return out;
}
