/**
 * The owner's account (js/account.js) against a stand-in for the Sixth Day
 * account server: sign in by going to the site and coming back with a one-time
 * code (PKCE), keep the sync code, and line a device's code up with the account's.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

const mem = new Map();
globalThis.localStorage = {
  getItem: (k) => (mem.has(k) ? mem.get(k) : null),
  setItem: (k, v) => mem.set(k, String(v)),
  removeItem: (k) => mem.delete(k),
};
globalThis.location = { origin: 'https://rosterwarden.sixthdaystudios.com', pathname: '/' };

/** base64url SHA-256, as the site checks a PKCE verifier against its challenge. */
async function s256(text) {
  const d = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return Buffer.from(d).toString('base64url');
}

// A tiny account server: one person, one kept code, bearer-token checked. `issued`
// is the one-time code the site handed out, with the challenge and address it is for.
const server = { issued: null, kept: null, calls: [] };
globalThis.fetch = async (url, opts) => {
  const path = new URL(url).pathname;
  const body = opts.body ? JSON.parse(opts.body) : null;
  server.calls.push([opts.method, path, body]);
  const reply = (data, status = 200) => ({ status, json: async () => data });
  if (path === '/api/rw/token') {
    const issued = server.issued;
    server.issued = null;                                  // a code works once
    const ok = issued && body.code === issued.code && body.redirect_uri === issued.redirectUri
      && await s256(body.code_verifier) === issued.challenge;
    return ok ? reply({ token: 'tok-1', email: 'boss@example.com', name: 'Boss' }) : reply({ error: "That sign-in didn't finish." }, 400);
  }
  if (path === '/api/rw/refresh') return body.token === 'tok-1' ? reply({ token: 'tok-2' }) : reply({ error: 'no' }, 401);
  if (opts.headers.Authorization !== `Bearer ${server.token}`) return reply({ error: 'Not signed in.' }, 401);
  if (path === '/api/rw/key' && opts.method === 'GET') return server.kept ? reply({ code: server.kept }) : reply({ error: 'none' }, 404);
  if (path === '/api/rw/key' && opts.method === 'PUT') {
    if (server.kept && server.kept !== body.code && !body.replace) return reply({ error: 'exists' }, 409);
    server.kept = body.code;
    return reply({ ok: true });
  }
  return reply({ error: 'Not found' }, 404);
};

const account = await import('../js/account.js');
const sync = await import('../js/sync.js');

/** Start over: signed out, no kept code, a device code of its own. */
function setUp(deviceCode = 'abcd2345efgh6789jkmn') {
  mem.clear();
  Object.assign(server, { issued: null, kept: null, calls: [], token: 'tok-1' });
  sync.setCode(deviceCode);
}

/** What the site does with the address `begin()` sends the person to: hand out a code and send them back. */
function siteSendsBack(authorizeUrl, code = 'one-time-1') {
  const q = new URL(authorizeUrl).searchParams;
  server.issued = { code, challenge: q.get('code_challenge'), redirectUri: q.get('redirect_uri') };
  return `?${new URLSearchParams({ code, state: q.get('state') })}`;
}

/** Sign in all the way: off to the site and back. */
async function signIn() {
  return account.finish(siteSendsBack(await account.begin()));
}

test('signing in goes to the site and back, then keeps the token and who it is for', async () => {
  setUp();
  const url = new URL(await account.begin());
  assert.equal(url.origin + url.pathname, 'https://sixthdaystudios.com/rw/authorize');
  assert.equal(url.searchParams.get('redirect_uri'), 'https://rosterwarden.sixthdaystudios.com/');
  assert.equal(url.searchParams.get('code_challenge_method'), 'S256');
  assert.equal(account.current(), null);
  const back = siteSendsBack(url.href);
  assert.ok(account.isReturning(back));
  assert.deepEqual(await account.finish(back), { email: 'boss@example.com', name: 'Boss' });
  assert.equal(account.current().email, 'boss@example.com');
  assert.ok(!server.calls.some(([, path]) => path === '/api/rw/poll'), 'no waiting on the site');
  account.signOut();
  assert.equal(account.current(), null);
});

test('an ordinary address is not a sign-in coming back', async () => {
  setUp();
  assert.equal(account.isReturning(''), false);
  assert.equal(account.isReturning('?code=x'), false);
  assert.equal(await account.finish(''), null);
});

test('a return with a state this device did not start is left alone, for Planning Center', async () => {
  setUp();
  assert.equal(account.isReturning('?code=x&state=y'), false, 'nothing started here');
  assert.equal(await account.finish('?code=x&state=y'), null);
  const back = siteSendsBack(await account.begin());
  const pco = back.replace(/state=[^&]+/, 'state=planning-center');
  assert.equal(account.isReturning(pco), false);
  assert.equal(await account.finish(pco), null);
  assert.deepEqual(await account.finish(back), { email: 'boss@example.com', name: 'Boss' }, 'our own sign-in still finishes');
});

test('a stray trip back from the site once signed in is ignored, not an error', async () => {
  setUp();
  await signIn();
  assert.equal(await account.finish('?code=x&state=y'), null);
  assert.equal(account.current().email, 'boss@example.com');
});

test('a sign-in that took too long is refused', async () => {
  setUp();
  const back = siteSendsBack(await account.begin());
  const pending = JSON.parse(mem.get('rosterwarden.account.pending'));
  mem.set('rosterwarden.account.pending', JSON.stringify({ ...pending, until: Date.now() - 1 }));
  await assert.rejects(account.finish(back), /took too long/);
});

test('the site refusing the code (wrong verifier) is passed on, and nothing is kept', async () => {
  setUp();
  const back = siteSendsBack(await account.begin());
  server.issued.challenge = 'something-else';
  await assert.rejects(account.finish(back), /didn't finish/);
  assert.equal(account.current(), null);
});

test("an account with no code yet keeps this device's, and one with the same code is left alone", async () => {
  setUp();
  await signIn();
  assert.deepEqual(await account.matchCode(), { mode: 'uploaded' });
  assert.equal(server.kept, 'abcd2345efgh6789jkmn');
  assert.deepEqual(await account.matchCode(), { mode: 'same' });
});

test("an account that keeps another code reports it, and the device's can replace it on purpose", async () => {
  setUp();
  server.kept = 'zzzz2345efgh6789jkmn';
  await signIn();
  assert.deepEqual(await account.matchCode(), { mode: 'differs', code: 'zzzz2345efgh6789jkmn' });
  await assert.rejects(account.keepCode('abcd2345efgh6789jkmn'), /exists/);
  await account.keepCode('abcd2345efgh6789jkmn', true);
  assert.equal(server.kept, 'abcd2345efgh6789jkmn');
});

test('a token is refreshed in place, and dropped when the account says no', async () => {
  setUp();
  await signIn();
  await account.keepFresh();
  assert.equal(JSON.parse(mem.get('rosterwarden.account')).token, 'tok-2');
  await account.keepFresh();               // tok-2 is refused by the stand-in
  assert.equal(account.current(), null);
});

test('signing up goes to the registration page and starts nothing waiting', async () => {
  setUp();
  assert.match(await account.begin(true), /\/register$/);
  assert.equal(mem.get('rosterwarden.account.pending'), undefined);
});
