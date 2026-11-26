/**
 * Emailing a roster: each person on it gets their own shifts (the text
 * `messageFor` builds), sent by the sync worker so no mail app opens. It comes
 * from "<workplace> via RosterWarden" and replies go to the workplace's
 * business email. Only a signed-in owner can send (the worker checks), and
 * this is the one time roster text leaves the phone unencrypted.
 */
import { SYNC_URL } from './config.js';
import { messageFor } from './export.js';
import * as account from './account.js';

/** Raised for anything the person should read, such as being over today's limit. */
export class EmailError extends Error {}

/** Whether `text` looks like an email address. */
export function looksLikeEmail(text) {
  return /^[^\s@<>",;]+@[^\s@<>",;]+\.[^\s@<>",;]+$/.test(String(text || '').trim());
}

/**
 * Who on a roster gets an email: `{ messages: [{ person, to, text }], skipped: [{ person, why }] }`,
 * each sorted by name. People not on the roster are left out of both. Someone
 * on it is skipped with no usable email, or when their address is already
 * getting another person's email (one email per address).
 */
export function emailList(roster, people, shifts, roles = []) {
  return addressed([...people]
    .sort((a, b) => a.name.localeCompare(b.name))
    .map((person) => ({ person, text: messageFor(roster, person, shifts, roles) }))
    .filter((x) => x.text));
}

/**
 * Turn `[{ person, text }]` into who gets an email, as `emailList` returns it:
 * someone with no usable email, or one already getting another person's
 * email, is skipped with the reason. Keeps the order given.
 */
export function addressed(rows) {
  const messages = [];
  const skipped = [];
  const used = new Map();   // lower-cased address -> the person getting it
  for (const { person, text } of rows) {
    const to = String(person.email || '').trim();
    if (!looksLikeEmail(to)) {
      skipped.push({ person, why: to ? 'email doesn\'t look right' :'no email saved' });
      continue;
    }
    const sharer = used.get(to.toLowerCase());
    if (sharer) {
      skipped.push({ person, why: `same email as ${sharer.name}` });
      continue;
    }
    used.set(to.toLowerCase(), person);
    messages.push({ person, to, text });
  }
  return { messages, skipped };
}

/** Whether this app has a server to send email through. */
export function isAvailable() {
  return Boolean(SYNC_URL) && account.isConfigured();
}

/**
 * Send `messages` (from `emailList`) for the workplace `org`, titled with the
 * roster's name. Resolves to how many were sent; anything that went wrong
 * becomes an EmailError worth showing.
 */
export async function sendRoster(org, title, messages) {
  const token = account.token();
  if (!token) throw new EmailError('Sign in first (Settings, Account) to send emails.');
  let res;
  try {
    res = await fetch(`${SYNC_URL}/email`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify({
        business: org.name,
        replyTo: org.replyEmail || '',
        title,
        messages: messages.map((m) => ({ to: m.to, text: m.text })),
      }),
    });
  } catch {
    throw new EmailError('Could not reach the server. Check your connection and try again.');
  }
  const data = await res.json().catch(() => ({}));
  if (res.status === 401) throw new EmailError('Please sign in again (Settings, Account), then send.');
  if (!res.ok) throw new EmailError(data.error || 'The emails did not send. Try again in a moment.');
  return data.sent;
}
