/**
 * The sync worker's roster emails (POST /email), run against a stand-in
 * account server and a stand-in email service (both by `fetch`) and a
 * stand-in database answering the daily count SQL: only a signed-in owner
 * sends, each email goes to one person from "<business> via RosterWarden"
 * with replies to the owner, and each account is held to a daily limit.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import worker, { EMAIL_SQL, DAILY_EMAILS } from '../worker/src/index.js';

/**
 * An in-memory D1 that understands exactly the daily count statements, each
 * run as one step (as SQLite runs one statement), with `meta.changes` as D1 gives it.
 */
function fakeDB() {
  const rows = new Map();
  return {
    rows,
    prepare(sql) {
      return {
        bind(...args) {
          return {
            async first() {
              assert.equal(sql, EMAIL_SQL.read);
              const key = `${args[0]}|${args[1]}`;
              return rows.has(key) ? { sent: rows.get(key) } : null;
            },
            async run() {
              if (sql === EMAIL_SQL.reserve) {
                const [account, day, n, cap] = args;
                const key = `${account}|${day}`;
                // A new row always goes in; an existing one only grows while it stays within the cap.
                if (rows.has(key) && rows.get(key) + n > cap) return { meta: { changes: 0 } };
                rows.set(key, (rows.get(key) || 0) + n);
                return { meta: { changes: 1 } };
              }
              assert.equal(sql, EMAIL_SQL.release);
              const [n, account, day] = args;
              const key = `${account}|${day}`;
              if (rows.has(key)) rows.set(key, Math.max(rows.get(key) - n, 0));
              return { meta: { changes: rows.has(key) ? 1 : 0 } };
            },
          };
        },
      };
    },
  };
}

// The account server knows one token; the email service records what it is given.
const sent = [];
let serviceFails = false;
globalThis.fetch = async (url, opts = {}) => {
  const reply = (data, status = 200) => new Response(JSON.stringify(data), { status });
  if (url === 'https://acct.test/api/rw/me') {
    return opts.headers.Authorization === 'Bearer good'
      ? reply({ email: 'boss@example.com', name: 'Boss' })
      : reply({ error: 'Not signed in.' }, 401);
  }
  if (url === 'https://api.resend.com/emails/batch') {
    assert.equal(opts.headers.Authorization, 'Bearer re_test');
    if (serviceFails) return reply({ message: 'domain not verified' }, 403);
    sent.push(...JSON.parse(opts.body));
    return reply({ data: [] });
  }
  throw new Error(`unexpected fetch: ${url}`);
};

/** A worker env with email set up. */
const env = () => ({ DB: fakeDB(), RESEND_API_KEY: 're_test', EMAIL_FROM: 'rosters@rw.test', ACCOUNT_URL: 'https://acct.test' });

/** POST /email with `body`, signed in with `token` (or not, given null). */
const send = (e, body, token = 'good') => worker.fetch(new Request('https://w.test/email', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
  body: JSON.stringify(body),
}), e);

const ROSTER = {
  business: 'Test Cafe', replyTo: 'hello@testcafe.example', title: 'Week of 2 Nov',
  messages: [{ to: 'ann@example.com', text: 'Hi Ann, Mon' }, { to: 'sam@example.com', text: 'Hi Sam, Tue' }],
};

test('a signed-in owner emails each person their own message', async () => {
  sent.length = 0;
  const e = env();
  const res = await send(e, ROSTER);
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { sent: 2 });
  assert.equal(sent.length, 2);
  assert.deepEqual(sent[0].to, ['ann@example.com']);
  assert.equal(sent[0].from, '"Test Cafe via RosterWarden" <rosters@rw.test>');
  assert.equal(sent[0].reply_to, 'hello@testcafe.example');
  assert.equal(sent[0].subject, 'Your shifts: Week of 2 Nov');
  assert.match(sent[0].text, /^Hi Ann, Mon\n\n--\nSent by RosterWarden for Test Cafe\./);
  assert.match(sent[1].text, /^Hi Sam, Tue/);
  assert.equal([...e.DB.rows.values()][0], 2, 'counted against the day');
  assert.ok(![...e.DB.rows.keys()][0].includes('boss@'), 'the account is kept as a hash, not its email');
});

test('replies go to the account email when no business email is given', async () => {
  sent.length = 0;
  await send(env(), { ...ROSTER, replyTo: '' });
  assert.equal(sent[0].reply_to, 'boss@example.com');
});

test('nobody signed in sends nothing', async () => {
  sent.length = 0;
  assert.equal((await send(env(), ROSTER, null)).status, 401);
  assert.equal((await send(env(), ROSTER, 'stolen')).status, 401);
  assert.equal(sent.length, 0);
});

test('a header cannot be slipped in through the business name or an address', async () => {
  sent.length = 0;
  await send(env(), { ...ROSTER, business: 'Cafe"\r\nBcc: x@evil.example <x>' });
  assert.equal(sent[0].from, '"Cafe Bcc: x@evil.example x via RosterWarden" <rosters@rw.test>');
  const bad = { ...ROSTER, messages: [{ to: 'a@b.com\r\nBcc: x@evil.example', text: 'hi' }] };
  assert.equal((await send(env(), bad)).status, 400);
});

test('each email goes to a different address, with some text', async () => {
  const twice = { ...ROSTER, messages: [{ to: 'ann@example.com', text: 'a' }, { to: 'ANN@example.com', text: 'b' }] };
  assert.equal((await send(env(), twice)).status, 400);
  assert.equal((await send(env(), { ...ROSTER, messages: [{ to: 'ann@example.com', text: ' ' }] })).status, 400);
  assert.equal((await send(env(), { ...ROSTER, messages: [] })).status, 400);
});

test('an account is held to its daily limit', async () => {
  sent.length = 0;
  const e = env();
  const many = (n, from = 0) => ({
    ...ROSTER, messages: Array.from({ length: n }, (_, i) => ({ to: `p${from + i}@example.com`, text: 'hi' })),
  });
  assert.equal((await send(e, many(DAILY_EMAILS - 1))).status, 200);
  const over = await send(e, many(2, 500));
  assert.equal(over.status, 429);
  assert.match((await over.json()).error, /1 more email today/);
  assert.equal((await send(e, many(1, 900))).status, 200);
  assert.equal(sent.length, DAILY_EMAILS);
});

test('sends at the same moment are still held to the daily limit between them', async () => {
  sent.length = 0;
  const e = env();
  const batch = (from) => ({
    ...ROSTER, messages: Array.from({ length: DAILY_EMAILS }, (_, i) => ({ to: `p${from + i}@example.com`, text: 'hi' })),
  });
  // Three full-day sends at once: before the count was taken up front, all three went out.
  const statuses = (await Promise.all([send(e, batch(0)), send(e, batch(1000)), send(e, batch(2000))])).map((r) => r.status);
  assert.deepEqual(statuses.sort(), [200, 429, 429]);
  assert.equal(sent.length, DAILY_EMAILS);
  assert.equal([...e.DB.rows.values()][0], DAILY_EMAILS);
});

test('a refusal from the email service is passed on and not counted', async () => {
  serviceFails = true;
  const e = env();
  const res = await send(e, ROSTER);
  serviceFails = false;
  assert.equal(res.status, 502);
  assert.match((await res.json()).error, /domain not verified/);
  assert.ok([...e.DB.rows.values()].every((n) => n === 0), 'the refused send is given back');
});

test('without an API key it says email is not set up', async () => {
  assert.equal((await send({ ...env(), RESEND_API_KEY: '' }, ROSTER)).status, 501);
});
