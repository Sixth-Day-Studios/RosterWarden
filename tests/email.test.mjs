/**
 * Emailing a roster from the app (js/email.js): who gets an email and who is
 * skipped and why, and the request the app sends the worker, against a
 * stand-in `fetch`.
 *
 *   node --test tests/email.test.mjs
 */
import test from 'node:test';
import assert from 'node:assert/strict';

const mem = new Map();
globalThis.localStorage = {
  getItem: (k) => (mem.has(k) ? mem.get(k) : null),
  setItem: (k, v) => mem.set(k, String(v)),
  removeItem: (k) => mem.delete(k),
};

const { emailList, sendRoster, looksLikeEmail, EmailError } = await import('../js/email.js');

const shifts = [{ id: 10, name: 'Cafe', start: '08:00', end: '12:00', headcount: 3 }];
const people = [
  { id: 1, name: 'Sam Lee', email: 'sam@example.com' },
  { id: 2, name: 'Ann Ho', email: '' },
  { id: 3, name: 'Bea Fox', email: 'not an email' },
  { id: 4, name: 'Tia Lee', email: 'SAM@example.com ' },
  { id: 5, name: 'Dee Off', email: 'dee@example.com' },     // not on the roster
  { id: 6, name: 'Abe Ng', email: ' abe@example.com' },
];
const roster = {
  name: 'Week of 2 Nov',
  days: ['2026-11-02'],
  assignments: [1, 2, 3, 4, 6].map((personId) => ({ date: '2026-11-02', shiftId: 10, personId })),
};

test('everyone on the roster with an email gets their own message, by name', () => {
  const { messages } = emailList(roster, people, shifts);
  assert.deepEqual(messages.map((m) => [m.person.name, m.to]), [['Abe Ng', 'abe@example.com'], ['Sam Lee', 'sam@example.com']]);
  assert.match(messages[1].text, /^Hi Sam, you're on the roster \(Week of 2 Nov\):\n• Mon 2 Nov: Cafe 8:00–12:00$/);
});

test('people without a usable email are skipped with the reason, and off-roster people are left out', () => {
  const { skipped } = emailList(roster, people, shifts);
  assert.deepEqual(skipped.map((s) => [s.person.name, s.why]), [
    ['Ann Ho', 'no email saved'],
    ['Bea Fox', "email doesn't look right"],
    ['Tia Lee', 'same email as Sam Lee'],
  ]);
});

test('looksLikeEmail accepts plain addresses only', () => {
  assert.ok(looksLikeEmail('a.b@c.co'));
  for (const bad of ['', 'a@b', 'a b@c.com', 'a@b.com\nBcc: x@y.z', '"a"@b.com', 'a@b.com,c@d.com']) {
    assert.ok(!looksLikeEmail(bad), bad);
  }
});

test('sending asks the worker as the signed-in owner, with the business and reply email', async () => {
  let asked = null;
  globalThis.fetch = async (url, opts) => {
    asked = { url, opts };
    return new Response(JSON.stringify({ sent: 2 }), { status: 200 });
  };
  await assert.rejects(sendRoster({ name: 'Cafe' }, 'R', []), EmailError, 'signed out sends nothing');
  assert.equal(asked, null);

  localStorage.setItem('rosterwarden.account', JSON.stringify({ token: 'tok', email: 'boss@example.com' }));
  const { messages } = emailList(roster, people, shifts);
  assert.equal(await sendRoster({ name: 'Test Cafe', replyEmail: 'hi@cafe.example' }, roster.name, messages), 2);
  assert.match(asked.url, /\/email$/);
  assert.equal(asked.opts.headers.Authorization, 'Bearer tok');
  const body = JSON.parse(asked.opts.body);
  assert.deepEqual(Object.keys(body), ['business', 'replyTo', 'title', 'messages']);
  assert.equal(body.business, 'Test Cafe');
  assert.equal(body.replyTo, 'hi@cafe.example');
  assert.deepEqual(body.messages.map((m) => m.to), ['abe@example.com', 'sam@example.com']);
});

test("the worker's reason comes back as something to read", async () => {
  globalThis.fetch = async () => new Response(JSON.stringify({ error: 'You can send 3 more emails today' }), { status: 429 });
  await assert.rejects(sendRoster({ name: 'C' }, 'R', [{ to: 'a@b.co', text: 'x' }]), /3 more emails today/);
  globalThis.fetch = async () => new Response('{}', { status: 401 });
  await assert.rejects(sendRoster({ name: 'C' }, 'R', [{ to: 'a@b.co', text: 'x' }]), /sign in again/);
  globalThis.fetch = async () => { throw new TypeError('Failed to fetch'); };
  await assert.rejects(sendRoster({ name: 'C' }, 'R', [{ to: 'a@b.co', text: 'x' }]), /Could not reach/);
});

test('addressed applies the same email rules to any list of messages, in the order given', async () => {
  const { addressed } = await import('../js/email.js');
  const { messages, skipped } = addressed([
    { person: people[3], text: 'b' }, { person: people[0], text: 'a' }, { person: people[1], text: 'c' },
  ]);
  assert.deepEqual(messages.map((m) => [m.person.name, m.to, m.text]), [['Tia Lee', 'SAM@example.com', 'b']]);
  assert.deepEqual(skipped.map((s) => [s.person.name, s.why]), [['Sam Lee', 'same email as Tia Lee'], ['Ann Ho', 'no email saved']]);
});
