/**
 * Service worker: makes RosterWarden open with no connection.
 *
 * Strategy is stale-while-revalidate for the app shell: answer instantly from
 * cache so a roster can be built in a cafe basement with no signal, but always
 * re-fetch in the background. When that background fetch turns up a changed
 * shell file (a deploy landed), the worker messages the open pages so they can
 * reload onto it, instead of the change only taking effect on the next cold
 * start. CACHE is bumped only to force-drop a bad cache; freshness no longer
 * depends on remembering to.
 *
 * Only same-origin GETs are touched. The AI provider calls in js/ai.js are
 * cross-origin and must always go to the network, never to a cache.
 */

const CACHE = 'rosterwarden-v3';

/** Pathnames (relative to scope) that make up the precached app shell. */
const SHELL_PATHS = new Set();

/** Everything needed to boot the app with no network. */
const SHELL = [
  './',
  './index.html',
  './manifest.webmanifest',
  './css/app.css',
  './js/app.js',
  './js/ui.js',
  './js/store.js',
  './js/scheduler.js',
  './js/ai.js',
  './js/people-import.js',
  './js/setup.js',
  './js/export.js',
  './js/install.js',
  './js/sync.js',
  './js/config.js',
  './js/askguardian.js',
  './js/views/roster.js',
  './js/views/roster-parts.js',
  './js/views/planning-center.js',
  './js/sources/planning-center.js',
  './js/views/people.js',
  './js/views/shifts.js',
  './js/views/team.js',
  './js/views/staff.js',
  './js/staff.js',
  './js/staff-link.js',
  './js/open-shifts.js',
  './js/views/saved.js',
  './js/views/updates.js',
  './js/account.js',
  './js/email.js',
  './js/views/account.js',
  './js/views/settings.js',
  './js/views/wizard.js',
  './icons/icon-192.png',
  './icons/icon-512.png',
  './icons/guardian.png',
];

for (const entry of SHELL) SHELL_PATHS.add(new URL(entry, self.location).pathname);

/**
 * Whether two responses for the same URL are different builds of that file.
 * GitHub Pages sends a strong ETag (and Last-Modified) on every asset, so a
 * header comparison is enough - no need to read and diff the bodies.
 */
function isNewerCopy(cached, fresh) {
  const tag = (r, h) => r && r.headers.get(h);
  const oldTag = tag(cached, 'ETag') || tag(cached, 'Last-Modified');
  const newTag = tag(fresh, 'ETag') || tag(fresh, 'Last-Modified');
  return Boolean(oldTag && newTag && oldTag !== newTag);
}

/** Tell every open page that a precached shell file has just changed. */
async function notifyShellUpdated() {
  const clients = await self.clients.matchAll({ type: 'window' });
  for (const client of clients) client.postMessage('shell-updated');
}

self.addEventListener('install', (event) => {
  // addAll is atomic: if any file 404s the whole install fails, which is what
  // we want rather than a half-cached, subtly broken app.
  event.waitUntil(
    caches.open(CACHE).then((cache) => cache.addAll(SHELL)).then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (event) => {
  const { request } = event;
  if (request.method !== 'GET') return;

  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;   // let AI calls hit the network

  // Stale-while-revalidate: answer instantly from cache (so the app opens with
  // no signal), but always re-fetch in the background and store the new copy,
  // so the next open has the latest. Plain cache-first would mean a forgotten
  // CACHE bump silently pins every installed copy to an old version forever -
  // the wrong failure mode for an app nobody is watching over.
  event.respondWith(
    caches.open(CACHE).then(async (cache) => {
      const hit = await cache.match(request);

      const network = fetch(request)
        .then((response) => {
          if (response.ok && response.type === 'basic') {
            // A shell file whose bytes changed under us means a deploy has
            // landed. Let the running pages reload onto it rather than waiting
            // for the next cold start.
            if (hit && SHELL_PATHS.has(url.pathname) && isNewerCopy(hit, response)) {
              notifyShellUpdated();
            }
            cache.put(request, response.clone());
          }
          return response;
        })
        .catch(() => null);

      if (hit) return hit;

      const fresh = await network;
      if (fresh) return fresh;

      // Offline with nothing cached: a navigation still gets the shell, which
      // is enough for this single-page app to render.
      if (request.mode === 'navigate') {
        return (await cache.match('./index.html')) || Response.error();
      }
      return Response.error();
    })
  );
});
