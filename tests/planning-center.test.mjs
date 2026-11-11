/**
 * Planning Center source module, run against a fake API.
 *
 * There is no Planning Center account to test against, so `fetch` and
 * `localStorage` are stubbed and every request the module makes is checked:
 * token refresh, paging, blockout dates in the blockout's own time zone, and
 * that sending a roster adds only what is missing and reports the rest.
 *
 *   node --test tests/planning-center.test.mjs
 */
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

/** In-memory localStorage stand-in. */
class MemoryStorage {
  constructor() { this.items = new Map(); }
  getItem(k) { return this.items.has(k) ? this.items.get(k) : null; }
  setItem(k, v) { this.items.set(k, String(v)); }
  removeItem(k) { this.items.delete(k); }
}
globalThis.localStorage = new MemoryStorage();

const pco = await import('../js/sources/planning-center.js');

/** Requests made in the current test, as `{ method, url, body }`. */
let calls = [];
/** Route table for the fake API: `(method, url) => response JSON` or a Response. */
let routes = () => { throw new Error('no route'); };

/** A JSON fetch Response. */
function reply(body, status = 200, headers = {}) {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json', ...headers } });
}

globalThis.fetch = async (url, init = {}) => {
  const method = init.method || 'GET';
  const body = init.body ? JSON.parse(init.body) : undefined;
  calls.push({ method, url, body, auth: init.headers?.Authorization });
  const out = routes(method, url, body);
  return out instanceof Response ? out : reply(out);
};

/** Sign the fake device in with a token that is still valid. */
function signIn(expiresIn = 3600) {
  localStorage.setItem('rosterwarden.pco', JSON.stringify({
    access_token: 'tok', refresh_token: 'ref', expires_at: Date.now() + expiresIn * 1000,
  }));
}

beforeEach(() => {
  calls = [];
  localStorage.items.clear();
});

test('sign-in sends a PKCE challenge, then swaps the code with its verifier', async () => {
  // A minimal browser for the redirect out and back.
  globalThis.sessionStorage = new MemoryStorage();
  let sentTo = null;
  globalThis.location = {
    origin: 'https://example.test', pathname: '/RosterWarden/', search: '', hash: '#settings',
    assign: (url) => { sentTo = new URL(url); },
  };
  globalThis.history = { replaceState: () => {} };

  await pco.startSignIn();
  const q = sentTo.searchParams;
  assert.equal(q.get('code_challenge_method'), 'S256');
  assert.equal(q.get('redirect_uri'), 'https://example.test/RosterWarden/');
  assert.equal(q.get('scope'), 'services');

  // The challenge must be the base64url SHA-256 of the verifier kept for later.
  const verifier = sessionStorage.getItem('rosterwarden.pco.verifier');
  assert.ok(verifier.length >= 43);
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier)));
  assert.equal(q.get('code_challenge'), Buffer.from(digest).toString('base64url'));

  // Back from Planning Center with a code and the same state.
  location.search = `?code=abc&state=${q.get('state')}`;
  routes = () => ({ access_token: 'a', refresh_token: 'r', expires_in: 7200 });
  assert.equal(await pco.finishSignIn(), 'connected');
  assert.match(calls[0].url, /\/pco\/token$/);
  assert.deepEqual(calls[0].body, {
    code: 'abc', redirect_uri: 'https://example.test/RosterWarden/', code_verifier: verifier,
  });
  assert.equal(pco.isConnected(), true);

  // A second return trip with no matching state is refused.
  location.search = '?code=xyz&state=11111111-2222-3333-4444-555555555555';
  await assert.rejects(pco.finishSignIn(), pco.PCOError);
});

test('a stray return from the other sign-in is ignored quietly when none is pending here', async () => {
  globalThis.sessionStorage = new MemoryStorage();
  globalThis.location = {
    origin: 'https://example.test', pathname: '/RosterWarden/', search: '', hash: '',
    assign: () => {},
  };
  globalThis.history = { replaceState: () => {} };
  // A Sixth Day sign-in state: 22 base64url characters, nothing like a UUID.
  location.search = '?code=x&state=abcdefghijklmnopqrstuv';
  assert.equal(await pco.finishSignIn(), null);
});

test('disconnect forgets the tokens and asks the worker to revoke them', async () => {
  signIn();
  routes = () => ({ ok: true });
  await pco.disconnect();
  assert.equal(pco.isConnected(), false);
  assert.match(calls[0].url, /\/pco\/revoke$/);
  assert.deepEqual(calls[0].body, { token: 'ref' });
});

test('blockoutRange keeps an all-day blockout on its own day in its own zone', () => {
  // Sat 11 Oct 2026, midnight to midnight in Sydney (UTC+11 in October).
  const r = pco.blockoutRange({
    starts_at: '2026-10-10T13:00:00Z', ends_at: '2026-10-11T13:00:00Z', time_zone: 'Australia/Sydney',
  });
  assert.deepEqual(r, { start: '2026-10-11', end: '2026-10-11' });
});

test('blockoutRange spans several days inclusively', () => {
  const r = pco.blockoutRange({
    starts_at: '2026-10-10T13:00:00Z', ends_at: '2026-10-14T13:00:00Z', time_zone: 'Australia/Sydney',
  });
  assert.deepEqual(r, { start: '2026-10-11', end: '2026-10-14' });
});

test('an expired token is refreshed through the worker before calling the API', async () => {
  signIn(-10);
  routes = (method, url) => {
    if (url.endsWith('/pco/refresh')) return { access_token: 'new', refresh_token: 'ref2', expires_in: 7200 };
    return { data: [{ id: '1', type: 'Team', attributes: { name: 'Cafe' }, relationships: { service_type: { data: { id: '9' } } } }],
      included: [{ type: 'ServiceType', id: '9', attributes: { name: 'Sunday' } }], links: {} };
  };
  const teams = await pco.listTeams();
  assert.deepEqual(teams, [{ id: '1', name: 'Cafe', serviceTypeId: '9', serviceTypeName: 'Sunday' }]);
  assert.match(calls[0].url, /\/pco\/refresh$/);
  assert.equal(calls[1].auth, 'Bearer new');
  assert.equal(JSON.parse(localStorage.getItem('rosterwarden.pco')).refresh_token, 'ref2');
});

test('a refused refresh signs the device out with a readable error', async () => {
  signIn(-10);
  routes = () => reply({ error: 'nope' }, 400);
  await assert.rejects(pco.listTeams(), pco.PCOError);
  assert.equal(pco.isConnected(), false);
});

test("the sync worker's rate limit (429) during refresh keeps the device signed in", async () => {
  signIn(-10);
  routes = () => reply({ error: 'Too many requests from this connection. Try again in a minute.' }, 429);
  await assert.rejects(pco.listTeams(), pco.PCOError);
  assert.equal(pco.isConnected(), true);
});

test('a dropped connection during refresh keeps the device signed in', async () => {
  signIn(-10);
  routes = () => { throw new TypeError('Failed to fetch'); };
  await assert.rejects(pco.listTeams(), pco.PCOError);
  assert.equal(pco.isConnected(), true);
});

test('team members follow pagination, skip archived people and prefer nicknames', async () => {
  signIn();
  routes = (method, url) => {
    if (!url.includes('offset')) {
      return { data: [{ id: '1', attributes: { first_name: 'Robert', nickname: 'Bob', last_name: 'Lee' } },
                      { id: '2', attributes: { first_name: 'Gone', last_name: 'Away', archived: true } }],
        links: { next: 'https://api.planningcenteronline.com/services/v2/teams/5/people?offset=100&per_page=100' } };
    }
    return { data: [{ id: '3', attributes: { first_name: 'Amy', last_name: 'Chan' } }], links: {} };
  };
  const people = await pco.teamMembers('5');
  assert.deepEqual(people, [{ id: '3', name: 'Amy Chan' }, { id: '1', name: 'Bob Lee' }]);
  assert.equal(calls.length, 2);
});

test('repeating blockouts are expanded through their blockout dates', async () => {
  signIn();
  routes = (method, url) => {
    if (url.includes('/blockout_dates')) {
      // As the live API sends them: starts_at/ends_at are local times marked Z,
      // and the real UTC moments are in the *_utc fields.
      return { data: [
        { attributes: { starts_at: '2026-10-18T00:00:00Z', ends_at: '2026-10-19T00:00:00Z',
          starts_at_utc: '2026-10-17T13:00:00Z', ends_at_utc: '2026-10-18T13:00:00Z', time_zone: 'Australia/Sydney' } },
        { attributes: { starts_at: '2026-10-25T00:00:00Z', ends_at: '2026-10-26T00:00:00Z',
          starts_at_utc: '2026-10-24T13:00:00Z', ends_at_utc: '2026-10-25T13:00:00Z', time_zone: 'Australia/Sydney' } },
      ], links: {} };
    }
    return { data: [
      { id: 'b1', attributes: { repeat_frequency: 'no_repeat', reason: 'Holiday',
        starts_at: '2026-10-10T13:00:00Z', ends_at: '2026-10-12T13:00:00Z', time_zone: 'Australia/Sydney' } },
      { id: 'b2', attributes: { repeat_frequency: 'every_1', reason: 'Kids sport' } },
    ], links: {} };
  };
  const ranges = await pco.blockoutsFor('77', '2026-10-01');
  assert.deepEqual(ranges, [
    { start: '2026-10-11', end: '2026-10-12', reason: 'Holiday' },
    { start: '2026-10-18', end: '2026-10-18', reason: 'Kids sport' },
    { start: '2026-10-25', end: '2026-10-25', reason: 'Kids sport' },
  ]);
});

test('sendRoster adds what is missing, skips what is there, and reports the rest', async () => {
  signIn();
  routes = (method, url, body) => {
    if (url.includes('/plans?')) {
      // An evening service: local 6:30pm, marked Z. It must stay on the 11th.
      return { data: [{ id: 'p1', attributes: { sort_date: '2026-10-11T18:30:00Z' } }], links: {} };
    }
    if (method === 'GET' && url.includes('/team_members')) {
      // Amy is already on the plan as Barista.
      return { data: [{ attributes: { team_position_name: 'Barista' }, relationships: { person: { data: { id: '301' } } } }], links: {} };
    }
    if (method === 'POST') return { data: { id: 'new', attributes: body.data.attributes } };
    throw new Error(`unexpected ${method} ${url}`);
  };

  const assignments = [
    { date: '2026-10-11', shiftId: 1, personId: 10 },   // Amy, already there
    { date: '2026-10-11', shiftId: 1, personId: 11 },   // Bob, added
    { date: '2026-10-11', shiftId: 2, personId: 11 },   // shift 2 has no position
    { date: '2026-10-11', shiftId: 1, personId: 12 },   // Cat, not on the team
    { date: '2026-10-18', shiftId: 1, personId: 11 },   // no plan that day
  ];
  const result = await pco.sendRoster(assignments, {
    teamId: '5', serviceTypeId: '9',
    personPcoId: (id) => ({ 10: '301', 11: '302' })[id] || null,
    positionFor: (id) => (id === 1 ? 'Barista' : null),
  });

  assert.equal(result.added, 1);
  assert.equal(result.already, 1);
  assert.deepEqual([...result.noPlan], ['2026-10-18']);
  assert.deepEqual([...result.unlinked], [12]);
  assert.deepEqual([...result.unmapped], [2]);

  const post = calls.find((c) => c.method === 'POST');
  assert.match(post.url, /service_types\/9\/plans\/p1\/team_members$/);
  assert.deepEqual(post.body.data.attributes, {
    person_id: 302, team_id: 5, team_position_name: 'Barista', status: 'U', prepare_notification: true,
  });
});

test('sending quietly adds people without preparing notifications, and lists the plans', async () => {
  signIn();
  routes = (method, url, body) => {
    if (url.includes('/plans?')) {
      return { data: [{ id: 'p1', attributes: { sort_date: '2026-10-11T09:00:00Z',
        planning_center_url: 'https://services.planningcenteronline.com/plans/p1' } }], links: {} };
    }
    if (method === 'GET') return { data: [], links: {} };
    return { data: { id: 'new', attributes: body.data.attributes } };
  };
  const result = await pco.sendRoster([{ date: '2026-10-11', shiftId: 1, personId: 11 }], {
    teamId: '5', serviceTypeId: '9', personPcoId: () => '302', positionFor: () => 'Barista',
  }, { notify: false });
  assert.equal(calls.find((c) => c.method === 'POST').body.data.attributes.prepare_notification, false);
  assert.deepEqual(result.plans, [{ date: '2026-10-11', url: 'https://services.planningcenteronline.com/plans/p1' }]);
});

test('a rate-limited request waits and retries', async () => {
  signIn();
  let first = true;
  routes = () => {
    if (first) { first = false; return reply({}, 429, { 'Retry-After': '0' }); }
    return { data: [], links: {} };
  };
  assert.deepEqual(await pco.teamPositions('5'), []);
  assert.equal(calls.length, 2);
});

test('a preview counts what would be sent and changes nothing', async () => {
  signIn();
  routes = (method, url) => {
    if (url.includes('/plans?')) {
      return { data: [{ id: 'p1', attributes: { sort_date: '2026-10-11T09:00:00Z' } }], links: {} };
    }
    if (method === 'GET') {
      return { data: [{ attributes: { team_position_name: 'Barista' }, relationships: { person: { data: { id: '301' } } } }], links: {} };
    }
    throw new Error(`a preview must only read, got ${method} ${url}`);
  };
  const preview = await pco.previewRoster([
    { date: '2026-10-11', shiftId: 1, personId: 10 },   // Amy, already there
    { date: '2026-10-11', shiftId: 1, personId: 11 },   // Bob, would be added
    { date: '2026-10-11', shiftId: 2, personId: 11 },   // shift 2 has no position
    { date: '2026-10-11', shiftId: 1, personId: 12 },   // Cat, not on the team
    { date: '2026-10-18', shiftId: 1, personId: 11 },   // no plan that day
  ], {
    teamId: '5', serviceTypeId: '9',
    personPcoId: (id) => ({ 10: '301', 11: '302' })[id] || null,
    positionFor: (id) => (id === 1 ? 'Barista' : null),
  });
  assert.deepEqual([preview.toAdd, preview.already, preview.plans], [1, 1, 1]);
  assert.deepEqual([...preview.noPlan], ['2026-10-18']);
  assert.deepEqual([...preview.unlinked], [12]);
  assert.deepEqual([...preview.unmapped], [2]);
  assert.ok(calls.every((c) => c.method === 'GET'));
});

test('replies are read back as confirmed, waiting or declined, and nothing is changed', async () => {
  signIn();
  routes = (method, url) => {
    if (url.includes('/plans?')) {
      return { data: [{ id: 'p1', attributes: { sort_date: '2026-10-11T09:00:00Z' } }], links: {} };
    }
    if (method === 'GET') {
      const member = (id, status) => ({
        attributes: { team_position_name: 'Barista', status }, relationships: { person: { data: { id } } },
      });
      return { data: [member('301', 'C'), member('302', 'D'), member('303', 'U')], links: {} };
    }
    throw new Error(`reading replies must only read, got ${method} ${url}`);
  };
  const replies = await pco.responsesFor([
    { date: '2026-10-11', shiftId: 1, personId: 10 },
    { date: '2026-10-11', shiftId: 1, personId: 11 },
    { date: '2026-10-11', shiftId: 1, personId: 12 },
    { date: '2026-10-11', shiftId: 1, personId: 13 },   // not on the plan
  ], {
    teamId: '5', serviceTypeId: '9',
    personPcoId: (id) => ({ 10: '301', 11: '302', 12: '303', 13: '304' })[id],
    positionFor: () => 'Barista',
  });
  assert.deepEqual(replies, {
    [pco.responseKey({ date: '2026-10-11', shiftId: 1, personId: 10 })]: 'C',
    [pco.responseKey({ date: '2026-10-11', shiftId: 1, personId: 11 })]: 'D',
    [pco.responseKey({ date: '2026-10-11', shiftId: 1, personId: 12 })]: 'U',
  });
  assert.ok(calls.every((c) => c.method === 'GET'));
});

test('requests that find the token expired at the same moment share one refresh', async () => {
  signIn(-10);
  let refreshes = 0;
  routes = (method, url) => {
    if (url.endsWith('/pco/refresh')) {
      refreshes += 1;
      // A refresh token works once: a second refresh with the old one would be refused, and sign the device out.
      return refreshes === 1 ? { access_token: 'new', refresh_token: 'ref2', expires_in: 7200 } : reply({ error: 'invalid_grant' }, 400);
    }
    return { data: [], included: [], links: {} };
  };
  await Promise.all([pco.listTeams(), pco.listTeams()]);
  assert.equal(refreshes, 1);
  assert.equal(pco.isConnected(), true);
});
