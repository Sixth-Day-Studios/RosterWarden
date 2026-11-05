/**
 * RosterWarden sync worker.
 *
 * A deliberately dumb blob store: it takes an opaque lump of bytes under an
 * opaque id, and hands it back on request. It has no idea what a roster is,
 * and it cannot read anything it holds - the app encrypts everything before it
 * ever leaves the phone, and the key never comes near this server.
 *
 * That matters because it is the operator's own Cloudflare account. Hosting
 * other people's staff names and availability would make you responsible for
 * them; hosting ciphertext you cannot decrypt does not.
 *
 * Sync endpoints:
 *   GET  /db/:id  ->  { ciphertext, iv, updatedAt }   (404 if never written)
 *   PUT  /db/:id  <-  { ciphertext, iv, updatedAt, base? }
 *                     with `base`, 409 { updatedAt } if the stored copy is no longer the one stamped `base`
 *
 * `:id` is a 64-character hex SHA-256 derived from the user's secret. It is
 * unguessable, and it is NOT the encryption key - see js/sync.js.
 *
 * Staff link mailboxes (see js/staff-link.js) - small encrypted boxes, one
 * each way per staff member, under ids derived from that person's link key:
 *   GET    /box/:id  ->  { ciphertext, iv, updatedAt }  (404 empty, 410 replaced)
 *   PUT    /box/:id  <-  { ciphertext, iv, updatedAt }  (410 once replaced)
 *   DELETE /box/:id  ->  { ok: true }  marks it replaced, so the old link stops working
 *   POST   /boxes    <-  { ids: [...] } -> { [id]: { ciphertext, iv, updatedAt } | { replaced: true } }
 *
 * Open-shift claims (see js/open-shifts.js) - one tiny encrypted record per
 * shift sent out to be taken, first come, first served, under an id derived
 * from that set's shared key. `token` is a secret only the claimer's link
 * gives; the worker keeps just its hash (`by`), so it can tell the holder
 * from everyone else without knowing who either is:
 *   PUT    /claim/:id  <-  { ciphertext, iv, token }  (409 if someone else holds it)
 *   DELETE /claim/:id  <-  { token }                  lets it go, only for its holder
 *   POST   /claims     <-  { ids: [...] } -> { [id]: { ciphertext, iv, by } }
 *
 * Emailing a roster (see js/email.js) - the one place roster text reaches this
 * server unencrypted. The owner's app sends each person's own message; the
 * worker checks the sign-in with the account server, holds each account to a
 * daily number of emails, and hands them to the email service. Nothing of the
 * messages is kept here, only a count per account per day:
 *   POST   /email  <-  { business, replyTo, title, messages: [{ to, text }] }
 *                      with Authorization: Bearer <account token>  -> { sent }
 *
 * Planning Center sign-in endpoints (see js/sources/planning-center.js):
 *   POST /pco/token    <- { code, redirect_uri, code_verifier } -> Planning Center's token response
 *   POST /pco/refresh  <- { refresh_token }        -> Planning Center's token response
 *   POST /pco/revoke   <- { token }                -> { ok: true }  (on disconnect)
 *
 * These exist only because swapping a sign-in code for a token needs the app's
 * client secret, which cannot ship inside a web page. The worker adds the
 * secret, passes the request on, and hands the tokens straight back - it
 * stores nothing, and roster data never comes through here.
 */

/**
 * Sent on every request to Planning Center, which may refuse (403) requests
 * without an identifying User-Agent - and a Worker's fetch sends none.
 */
const USER_AGENT = 'RosterWarden (https://sixthdaystudios.com)';

/** Biggest blob accepted, in bytes. A large roster is a few tens of KB. */
const MAX_BYTES = 2 * 1024 * 1024;

/** Biggest mailbox accepted, in bytes: a person's dates, a note and their shifts. */
const BOX_MAX_BYTES = 64 * 1024;

/** Most mailboxes read in one batch request. */
const BOX_BATCH_MAX = 200;

/**
 * The mailbox SQL, named so the tests can run the worker against a stand-in
 * database that answers exactly these statements.
 */
export const BOX_SQL = {
  read: 'SELECT ciphertext, iv, updated_at, revoked FROM mailboxes WHERE id = ?',
  write: 'INSERT INTO mailboxes (id, ciphertext, iv, updated_at, revoked) VALUES (?, ?, ?, ?, 0) '
    + 'ON CONFLICT(id) DO UPDATE SET ciphertext = excluded.ciphertext, iv = excluded.iv, '
    + 'updated_at = excluded.updated_at WHERE mailboxes.revoked = 0',
  revoke: "INSERT INTO mailboxes (id, ciphertext, iv, updated_at, revoked) VALUES (?, '', '', ?, 1) "
    + "ON CONFLICT(id) DO UPDATE SET ciphertext = '', iv = '', updated_at = excluded.updated_at, revoked = 1",
};

/** Biggest claim accepted, in bytes: a person id, a short name and a time. */
const CLAIM_MAX_BYTES = 2 * 1024;

/** The claim SQL, named like BOX_SQL for the tests' stand-in database. */
export const CLAIM_SQL = {
  read: 'SELECT ciphertext, iv, by_hash FROM claims WHERE id = ?',
  // A new claim goes in; an existing one changes only for its own holder.
  take: 'INSERT INTO claims (id, ciphertext, iv, by_hash, claimed_at) VALUES (?, ?, ?, ?, ?) '
    + 'ON CONFLICT(id) DO UPDATE SET ciphertext = excluded.ciphertext, iv = excluded.iv '
    + 'WHERE claims.by_hash = excluded.by_hash',
  release: 'DELETE FROM claims WHERE id = ? AND by_hash = ?',
};

/** Most emails one account can send in a day, all rosters together. */
export const DAILY_EMAILS = 100;

/** Most emails in one send: the email service's batch limit. */
const EMAIL_BATCH_MAX = 100;

/** Longest message text accepted, in characters. A month of shifts is well under this. */
const EMAIL_TEXT_MAX = 4000;

/** The daily email count SQL, named like BOX_SQL for the tests' stand-in database. */
export const EMAIL_SQL = {
  read: 'SELECT sent FROM email_sends WHERE account = ? AND day = ?',
  // Count a send before it goes, and only if it still fits under the day's limit. One statement, so two
  // sends at the same moment can't both read "room left" and then both go out.
  reserve: 'INSERT INTO email_sends (account, day, sent) VALUES (?, ?, ?) '
    + 'ON CONFLICT(account, day) DO UPDATE SET sent = email_sends.sent + excluded.sent '
    + 'WHERE email_sends.sent + excluded.sent <= ?',
  // Give back a send the email service refused, so it doesn't count against the day.
  release: 'UPDATE email_sends SET sent = MAX(sent - ?, 0) WHERE account = ? AND day = ?',
};

/** The synced database SQL, named like BOX_SQL for the tests' stand-in database. */
export const BLOB_SQL = {
  read: 'SELECT ciphertext, iv, updated_at FROM blobs WHERE id = ?',
  write: 'INSERT INTO blobs (id, ciphertext, iv, updated_at) VALUES (?, ?, ?, ?) '
    + 'ON CONFLICT(id) DO UPDATE SET ciphertext = excluded.ciphertext, '
    + 'iv = excluded.iv, updated_at = excluded.updated_at',
  // The same, but only over the copy the device last saw (its `base` stamp): if another device saved in
  // between, nothing is written and the device is told, instead of its copy silently replacing that work.
  writeOver: 'INSERT INTO blobs (id, ciphertext, iv, updated_at) VALUES (?, ?, ?, ?) '
    + 'ON CONFLICT(id) DO UPDATE SET ciphertext = excluded.ciphertext, '
    + 'iv = excluded.iv, updated_at = excluded.updated_at WHERE blobs.updated_at = ?',
};

/** A plain email address, with nothing that could add a header. */
const EMAIL_PATTERN = /^[^\s@<>",;]+@[^\s@<>",;]+\.[^\s@<>",;]+$/;

/** Ids are always a hex SHA-256; anything else is a bad request, not a lookup. */
const ID_PATTERN = /^[0-9a-f]{64}$/;

/** CORS headers. The app is served from a different origin to this worker. */
function cors(origin) {
  return {
    'Access-Control-Allow-Origin': origin || '*',
    'Access-Control-Allow-Methods': 'GET, PUT, POST, DELETE, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    'Access-Control-Max-Age': '86400',
  };
}

/** JSON response with CORS applied. */
function json(body, status, origin) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', ...cors(origin) },
  });
}

export default {
  /** Route one request. */
  async fetch(request, env) {
    const origin = request.headers.get('Origin');
    const url = new URL(request.url);

    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: cors(origin) });
    }

    if (request.method === 'POST' && url.pathname === '/pco/token') {
      return pcoToken(request, env, origin, 'authorization_code');
    }
    if (request.method === 'POST' && url.pathname === '/pco/refresh') {
      return pcoToken(request, env, origin, 'refresh_token');
    }
    if (request.method === 'POST' && url.pathname === '/pco/revoke') {
      return pcoRevoke(request, env, origin);
    }

    if (request.method === 'POST' && url.pathname === '/email') return emailRoster(request, env, origin);
    if (request.method === 'POST' && url.pathname === '/boxes') return boxBatch(request, env, origin);
    if (request.method === 'POST' && url.pathname === '/claims') return claimBatch(request, env, origin);
    const claim = url.pathname.match(/^\/claim\/([^/]+)$/);
    if (claim) {
      if (!ID_PATTERN.test(claim[1])) return json({ error: 'Bad id' }, 400, origin);
      if (request.method === 'PUT') return claimTake(claim[1], request, env, origin);
      if (request.method === 'DELETE') return claimRelease(claim[1], request, env, origin);
      return json({ error: 'Method not allowed' }, 405, origin);
    }
    const box = url.pathname.match(/^\/box\/([^/]+)$/);
    if (box) {
      if (!ID_PATTERN.test(box[1])) return json({ error: 'Bad id' }, 400, origin);
      if (request.method === 'GET') return boxRead(box[1], env, origin);
      if (request.method === 'PUT') return boxWrite(box[1], request, env, origin);
      if (request.method === 'DELETE') return boxRevoke(box[1], env, origin);
      return json({ error: 'Method not allowed' }, 405, origin);
    }

    const match = url.pathname.match(/^\/db\/([^/]+)$/);
    if (!match) return json({ error: 'Not found' }, 404, origin);

    const id = match[1];
    if (!ID_PATTERN.test(id)) return json({ error: 'Bad id' }, 400, origin);

    if (request.method === 'GET') return read(id, env, origin);
    if (request.method === 'PUT') return write(id, request, env, origin);
    return json({ error: 'Method not allowed' }, 405, origin);
  },
};

/** One mailbox: its contents, 404 if never written, 410 once its link was replaced. */
async function boxRead(id, env, origin) {
  const row = await env.DB.prepare(BOX_SQL.read).bind(id).first();
  if (!row) return json({ error: 'Nothing here yet' }, 404, origin);
  if (row.revoked) return json({ error: 'This link has been replaced' }, 410, origin);
  return json({ ciphertext: row.ciphertext, iv: row.iv, updatedAt: row.updated_at }, 200, origin);
}

/** Store a mailbox's contents - refused once its link has been replaced. */
async function boxWrite(id, request, env, origin) {
  let body;
  try {
    body = await request.json();
  } catch {
    return json({ error: 'Body must be JSON' }, 400, origin);
  }
  const { ciphertext, iv, updatedAt } = body || {};
  if (typeof ciphertext !== 'string' || typeof iv !== 'string') {
    return json({ error: 'ciphertext and iv are required' }, 400, origin);
  }
  if (ciphertext.length > BOX_MAX_BYTES) return json({ error: 'Too large' }, 413, origin);

  const row = await env.DB.prepare(BOX_SQL.read).bind(id).first();
  if (row?.revoked) return json({ error: 'This link has been replaced' }, 410, origin);

  const stamp = typeof updatedAt === 'string' ? updatedAt : new Date().toISOString();
  await env.DB.prepare(BOX_SQL.write).bind(id, ciphertext, iv, stamp).run();
  return json({ ok: true, updatedAt: stamp }, 200, origin);
}

/** Mark a mailbox replaced: its contents go, and its link can never write again. */
async function boxRevoke(id, env, origin) {
  await env.DB.prepare(BOX_SQL.revoke).bind(id, new Date().toISOString()).run();
  return json({ ok: true }, 200, origin);
}

/** Several mailboxes at once, so the owner's app checks every staff link in one request. */
async function boxBatch(request, env, origin) {
  let ids;
  try {
    ({ ids } = await request.json());
  } catch {
    return json({ error: 'Body must be JSON' }, 400, origin);
  }
  if (!Array.isArray(ids) || ids.length > BOX_BATCH_MAX || !ids.every((id) => ID_PATTERN.test(id))) {
    return json({ error: 'ids must be up to 200 hex ids' }, 400, origin);
  }
  const out = {};
  for (const id of ids) {
    const row = await env.DB.prepare(BOX_SQL.read).bind(id).first();
    if (!row) continue;
    out[id] = row.revoked
      ? { replaced: true }
      : { ciphertext: row.ciphertext, iv: row.iv, updatedAt: row.updated_at };
  }
  return json(out, 200, origin);
}

/** Hex SHA-256 of some text: a claimer's token, or an account's email, kept instead of the thing itself. */
async function tokenHash(token) {
  const bytes = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(token)));
  return [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/** The JSON body of a request, or null if it isn't JSON. */
async function bodyOf(request) {
  try {
    return await request.json();
  } catch {
    return null;
  }
}

/**
 * Take a shift for whoever holds `token`, unless someone else already has it.
 * The insert is one statement, so of two people tapping at once only the
 * first gets it; reading the row back says who that was.
 */
async function claimTake(id, request, env, origin) {
  const body = await bodyOf(request);
  const { ciphertext, iv, token } = body || {};
  if (typeof ciphertext !== 'string' || typeof iv !== 'string' || !ID_PATTERN.test(token || '')) {
    return json({ error: 'ciphertext, iv and token are required' }, 400, origin);
  }
  if (ciphertext.length > CLAIM_MAX_BYTES) return json({ error: 'Too large' }, 413, origin);
  const by = await tokenHash(token);
  await env.DB.prepare(CLAIM_SQL.take).bind(id, ciphertext, iv, by, new Date().toISOString()).run();
  const row = await env.DB.prepare(CLAIM_SQL.read).bind(id).first();
  if (row?.by_hash !== by) return json({ error: 'Someone else took it first' }, 409, origin);
  return json({ ok: true, by }, 200, origin);
}

/** Let a shift go: only the token that took it can. */
async function claimRelease(id, request, env, origin) {
  const body = await bodyOf(request);
  if (!ID_PATTERN.test(body?.token || '')) return json({ error: 'token is required' }, 400, origin);
  await env.DB.prepare(CLAIM_SQL.release).bind(id, await tokenHash(body.token)).run();
  return json({ ok: true }, 200, origin);
}

/** Several claims at once: each one's sealed contents and its holder's hash. Free shifts are left out. */
async function claimBatch(request, env, origin) {
  const ids = (await bodyOf(request))?.ids;
  if (!Array.isArray(ids) || ids.length > BOX_BATCH_MAX || !ids.every((id) => ID_PATTERN.test(id))) {
    return json({ error: 'ids must be up to 200 hex ids' }, 400, origin);
  }
  const out = {};
  for (const id of ids) {
    const row = await env.DB.prepare(CLAIM_SQL.read).bind(id).first();
    if (row) out[id] = { ciphertext: row.ciphertext, iv: row.iv, by: row.by_hash };
  }
  return json(out, 200, origin);
}

/**
 * The signed-in owner behind a request's bearer token, as `{ email, name }`,
 * or null. The account server (sixthdaystudios.com) is the one that knows.
 */
async function ownerOf(request, env) {
  const auth = request.headers.get('Authorization') || '';
  if (!/^Bearer \S+$/.test(auth)) return null;
  const res = await fetch(`${env.ACCOUNT_URL}/api/rw/me`, { headers: { Authorization: auth } });
  if (!res.ok) return null;
  const me = await res.json().catch(() => null);
  return me?.email ? me : null;
}

/** Text for an email header: one line, no quotes or angle brackets, at most `max` characters. */
function headerText(text, max) {
  return String(text || '').replace(/[\s"<>]+/g, ' ').trim().slice(0, max);
}

/**
 * Hand a batch of emails to the email service, all or none. The one place
 * that knows which service it is (Resend); each email is
 * `{ from, replyTo, to, subject, text }`. Throws if the service refuses.
 */
async function sendEmails(env, emails) {
  const res = await fetch('https://api.resend.com/emails/batch', {
    method: 'POST',
    headers: { Authorization: `Bearer ${env.RESEND_API_KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(emails.map((e) => ({
      from: e.from, reply_to: e.replyTo, to: [e.to], subject: e.subject, text: e.text,
    }))),
  });
  if (!res.ok) {
    const data = await res.json().catch(() => ({}));
    throw new Error(data.message || `HTTP ${res.status}`);
  }
}

/**
 * Email each person on a roster their own shifts, for a signed-in owner.
 * It comes from "<business> via RosterWarden" at EMAIL_FROM, replies go to
 * the owner's business email (or their account email), and a line at the
 * bottom says who sent it. The server can't read rosters, so it can't check
 * these are the roster's people - the app picks them; here each account is
 * held to DAILY_EMAILS a day, one address per email.
 */
async function emailRoster(request, env, origin) {
  if (!env.RESEND_API_KEY || !env.EMAIL_FROM || !env.ACCOUNT_URL) {
    return json({ error: 'Email is not set up on this server yet.' }, 501, origin);
  }
  let owner;
  try {
    owner = await ownerOf(request, env);
  } catch {
    return json({ error: 'Could not reach the account server. Try again in a moment.' }, 502, origin);
  }
  if (!owner) return json({ error: 'Please sign in again to send emails.' }, 401, origin);

  const body = await bodyOf(request);
  const messages = body?.messages;
  if (!Array.isArray(messages) || messages.length === 0 || messages.length > EMAIL_BATCH_MAX) {
    return json({ error: `Send between 1 and ${EMAIL_BATCH_MAX} messages.` }, 400, origin);
  }
  const seen = new Set();
  for (const m of messages) {
    const to = typeof m?.to === 'string' ? m.to.trim().toLowerCase() : '';
    if (!EMAIL_PATTERN.test(to) || seen.has(to) || typeof m.text !== 'string' || !m.text.trim()) {
      return json({ error: 'Each message needs its own email address and some text.' }, 400, origin);
    }
    if (m.text.length > EMAIL_TEXT_MAX) return json({ error: 'A message is too long.' }, 413, origin);
    seen.add(to);
  }
  const business = headerText(body.business, 80) || 'Your roster';
  const title = headerText(body.title, 120);
  const replyTo = EMAIL_PATTERN.test(body.replyTo || '') ? body.replyTo : owner.email;

  // The daily cap, counted under a hash of the account's email rather than the email itself. The send is
  // counted first, in one statement that refuses it if it won't fit, so sends at the same moment can't
  // between them go over the limit; one the email service then refuses is given back.
  const account = await tokenHash(owner.email.toLowerCase());
  const day = new Date().toISOString().slice(0, 10);
  const reserved = messages.length <= DAILY_EMAILS
    && (await env.DB.prepare(EMAIL_SQL.reserve).bind(account, day, messages.length, DAILY_EMAILS).run())?.meta?.changes > 0;
  if (!reserved) {
    const row = await env.DB.prepare(EMAIL_SQL.read).bind(account, day).first();
    const left = Math.max(DAILY_EMAILS - (row?.sent || 0), 0);
    return json({
      error: left > 0
        ? `You can send ${left} more email${left === 1 ? '' : 's'} today, and this is ${messages.length}. Try again tomorrow.`
        : `That's the most emails for today (${DAILY_EMAILS}). Try again tomorrow.`,
    }, 429, origin);
  }

  const footer = `\n\n--\nSent by RosterWarden for ${business}. Reply to this email to reach them.`;
  try {
    await sendEmails(env, messages.map((m) => ({
      from: `"${business} via RosterWarden" <${env.EMAIL_FROM}>`,
      replyTo,
      to: m.to.trim(),
      subject: title ? `Your shifts: ${title}` : 'Your shifts',
      text: m.text + footer,
    })));
  } catch (e) {
    await env.DB.prepare(EMAIL_SQL.release).bind(messages.length, account, day).run();
    return json({ error: `The email service refused: ${e.message}` }, 502, origin);
  }
  return json({ sent: messages.length }, 200, origin);
}

/** Return the stored blob for `id`, or 404 if there has never been one. */
async function read(id, env, origin) {
  const row = await env.DB.prepare(BLOB_SQL.read).bind(id).first();

  if (!row) return json({ error: 'No data for that code' }, 404, origin);
  return json({ ciphertext: row.ciphertext, iv: row.iv, updatedAt: row.updated_at }, 200, origin);
}

/** Store the blob for `id`, replacing whatever was there. */
async function write(id, request, env, origin) {
  let body;
  try {
    body = await request.json();
  } catch {
    return json({ error: 'Body must be JSON' }, 400, origin);
  }

  const { ciphertext, iv, updatedAt, base } = body || {};
  if (typeof ciphertext !== 'string' || typeof iv !== 'string') {
    return json({ error: 'ciphertext and iv are required' }, 400, origin);
  }
  if (ciphertext.length > MAX_BYTES) {
    return json({ error: 'Too large' }, 413, origin);
  }

  const stamp = typeof updatedAt === 'string' ? updatedAt : new Date().toISOString();
  // With `base` (the stamp of the copy the device last agreed with), the write only lands if nobody else
  // saved since: two devices open at once must not silently wipe each other's work. Without it (apps from
  // before this check), last write wins as it always did.
  if (typeof base === 'string') {
    const result = await env.DB.prepare(BLOB_SQL.writeOver).bind(id, ciphertext, iv, stamp, base).run();
    if (!(result?.meta?.changes > 0)) {
      const row = await env.DB.prepare(BLOB_SQL.read).bind(id).first();
      return json({ error: 'Changed on another device', updatedAt: row?.updated_at ?? null }, 409, origin);
    }
  } else {
    await env.DB.prepare(BLOB_SQL.write).bind(id, ciphertext, iv, stamp).run();
  }

  return json({ ok: true, updatedAt: stamp }, 200, origin);
}

/**
 * Exchange a Planning Center sign-in code (or refresh token) for tokens.
 *
 * `PCO_CLIENT_ID` is a plain var in wrangler.toml; `PCO_CLIENT_SECRET` is a
 * Worker secret (`npx wrangler secret put PCO_CLIENT_SECRET`). Planning Center
 * itself checks `redirect_uri` against the app's registered list, so a code
 * cannot be redeemed for some other site.
 */
async function pcoToken(request, env, origin, grantType) {
  if (!env.PCO_CLIENT_ID || !env.PCO_CLIENT_SECRET) {
    return json({ error: 'Planning Center is not set up on this server yet.' }, 501, origin);
  }

  let body;
  try {
    body = await request.json();
  } catch {
    return json({ error: 'Body must be JSON' }, 400, origin);
  }

  const form = { grant_type: grantType, client_id: env.PCO_CLIENT_ID, client_secret: env.PCO_CLIENT_SECRET };
  if (grantType === 'authorization_code') {
    if (typeof body?.code !== 'string' || typeof body?.redirect_uri !== 'string') {
      return json({ error: 'code and redirect_uri are required' }, 400, origin);
    }
    form.code = body.code;
    form.redirect_uri = body.redirect_uri;
    // PKCE: the verifier proves this is the same app that started the sign-in.
    if (typeof body.code_verifier === 'string') form.code_verifier = body.code_verifier;
  } else {
    if (typeof body?.refresh_token !== 'string') {
      return json({ error: 'refresh_token is required' }, 400, origin);
    }
    form.refresh_token = body.refresh_token;
  }

  let res;
  try {
    res = await fetch('https://api.planningcenteronline.com/oauth/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'User-Agent': USER_AGENT },
      body: new URLSearchParams(form),
    });
  } catch {
    return json({ error: 'Could not reach Planning Center. Try again in a moment.' }, 502, origin);
  }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    // Planning Center down or rate-limiting is a bad moment, not a refusal: answered 502 so the app keeps
    // its tokens and tries again, where a 4xx would sign the device out of Planning Center.
    if (res.status >= 500 || res.status === 429) {
      return json({ error: 'Planning Center is busy or down. Try again in a moment.' }, 502, origin);
    }
    // Pass Planning Center's own reason on; it is the useful part of the error.
    const reason = data.error_description || data.error || `HTTP ${res.status}`;
    return json({ error: `Planning Center refused the sign-in: ${reason}` }, 400, origin);
  }
  return json({
    access_token: data.access_token,
    refresh_token: data.refresh_token,
    expires_in: data.expires_in,
  }, 200, origin);
}

/**
 * Revoke a refresh token when a device disconnects, so a copy left in that
 * browser's storage stops working. Revoking the refresh token also kills its
 * access token. Planning Center answers 200 even for a token already dead, so
 * failures here are not worth reporting back.
 */
async function pcoRevoke(request, env, origin) {
  if (!env.PCO_CLIENT_ID || !env.PCO_CLIENT_SECRET) {
    return json({ error: 'Planning Center is not set up on this server yet.' }, 501, origin);
  }
  const body = await request.json().catch(() => null);
  if (typeof body?.token !== 'string') return json({ error: 'token is required' }, 400, origin);

  try {
    await fetch('https://api.planningcenteronline.com/oauth/revoke', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'User-Agent': USER_AGENT },
      body: new URLSearchParams({
        token: body.token,
        token_type_hint: 'refresh_token',
        client_id: env.PCO_CLIENT_ID,
        client_secret: env.PCO_CLIENT_SECRET,
      }),
    });
  } catch {
    return json({ error: 'Could not reach Planning Center.' }, 502, origin);
  }
  return json({ ok: true }, 200, origin);
}
