/**
 * Tests for the service worker's "a deploy landed" detection.
 *
 * The worker is cache-first for speed, so the only thing that makes a change
 * show up without a cold restart is it noticing a shell file's bytes moved and
 * telling the page. That path is fiddly and never runs on localhost, so it is
 * worth proving here.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const SCOPE = 'https://example.test/';

/**
 * Load sw.js into a fresh fake ServiceWorkerGlobalScope.
 *
 * Returns the captured `fetch` event handler plus the list of messages posted
 * to window clients, so a test can drive one request through and see what the
 * worker told the page.
 */
function loadWorker({ cached, network }) {
  const listeners = {};
  const posted = [];

  const added = [];
  const cacheStub = {
    match: async () => cached,
    put: async () => {},
    // Records each whole-shell refresh: the list of addresses it fetched.
    addAll: async (requests) => { added.push(requests.map((r) => r.url ?? r)); },
  };
  const scope = {
    location: new URL('sw.js', SCOPE),
    addEventListener: (type, fn) => { listeners[type] = fn; },
    skipWaiting: () => {},
    clients: {
      claim: async () => {},
      matchAll: async () => [{ postMessage: (m) => posted.push(m) }],
    },
  };

  globalThis.self = scope;
  globalThis.caches = { open: async () => cacheStub, keys: async () => [], delete: async () => {} };
  globalThis.fetch = async () => network;

  // Evaluate sw.js as a script in this global (it is not a module).
  const src = readFileSync(new URL('../sw.js', import.meta.url), 'utf8');
  // eslint-disable-next-line no-new-func
  new Function(src)();

  return { listeners, posted, added };
}

/** A Response-like object with just the headers the worker inspects. */
function fakeResponse(etag) {
  return {
    ok: true,
    type: 'basic',
    clone() { return this; },
    headers: { get: (h) => (h === 'ETag' ? etag : null) },
  };
}

/** Run one GET for `path` through the worker's fetch handler. */
async function requestOnce(worker, path) {
  let settled;
  const done = new Promise((r) => { settled = r; });
  let background = Promise.resolve();
  worker.listeners.fetch({
    request: { method: 'GET', url: SCOPE + path, mode: 'no-cors' },
    respondWith: (p) => settled(p),
    waitUntil: (p) => { background = p; },
  });
  await done;
  // Let the background refresh finish, as the browser keeps the worker up for it.
  await background;
  await new Promise((r) => setTimeout(r, 0));
}

test('a shell file whose ETag changed tells the page to reload', async () => {
  const worker = loadWorker({
    cached: fakeResponse('"old"'),
    network: fakeResponse('"new"'),
  });
  await requestOnce(worker, 'js/app.js');
  assert.deepEqual(worker.posted, ['shell-updated']);
});

test('an unchanged shell file says nothing', async () => {
  const worker = loadWorker({
    cached: fakeResponse('"same"'),
    network: fakeResponse('"same"'),
  });
  await requestOnce(worker, 'js/app.js');
  assert.deepEqual(worker.posted, []);
});

test('a changed file that is not part of the shell says nothing', async () => {
  const worker = loadWorker({
    cached: fakeResponse('"old"'),
    network: fakeResponse('"new"'),
  });
  await requestOnce(worker, 'js/some-lazy-chunk.js');
  assert.deepEqual(worker.posted, []);
});

test('the first fetch of an uncached shell file says nothing', async () => {
  const worker = loadWorker({
    cached: undefined,
    network: fakeResponse('"new"'),
  });
  await requestOnce(worker, 'js/app.js');
  assert.deepEqual(worker.posted, []);
});

test('a deploy noticed on one file refreshes the whole shell before the page is told', async () => {
  const worker = loadWorker({
    cached: fakeResponse('"old"'),
    network: fakeResponse('"new"'),
  });
  await requestOnce(worker, 'js/views/saved.js');
  // Every shell file was fetched again, together, before 'shell-updated' went out.
  assert.equal(worker.added.length, 1);
  assert.ok(worker.added[0].some((u) => u.endsWith('/js/store.js')));
  assert.deepEqual(worker.posted, ['shell-updated']);
});

/** Every module the app loads, found by following static imports from js/app.js. */
function importGraph() {
  const seen = new Set();
  const walk = (file) => {
    if (seen.has(file.href)) return;
    seen.add(file.href);
    const src = readFileSync(file, 'utf8');
    for (const m of src.matchAll(/^\s*import\s+(?:[^'"]*?\sfrom\s+)?['"](\.{1,2}\/[^'"]+)['"]/gm)) walk(new URL(m[1], file));
  };
  walk(new URL('../js/app.js', import.meta.url));
  const root = new URL('../', import.meta.url).href;
  return [...seen].map((href) => href.slice(root.length));
}

test('every module the app imports is in the offline shell', () => {
  const src = readFileSync(new URL('../sw.js', import.meta.url), 'utf8');
  const shell = new Set([...src.matchAll(/'\.\/([^']+)'/g)].map((m) => m[1]));
  const missing = importGraph().filter((f) => !shell.has(f));
  // A module left out loads online but leaves the app blank on its first launch with no signal.
  assert.deepEqual(missing, []);
});
