/* mbrd - service worker
   Precaches the app shell so the board works with no network at all, which is
   the point: everything already runs locally, the only thing a reload needs is
   the shell itself. Boards live in IndexedDB and in .mbrd files - the SW never
   touches user data. */

const VERSION = 'mbrd-v18';

// Local dev (server.bat on localhost, or a LAN IP for phone testing) turns the
// SW into a pass-through, so a single refresh always shows the latest edit and
// there is never a stale-shell cache to clear by hand.
const HOST = self.location.hostname;
const DEV = HOST === 'localhost' || HOST === '127.0.0.1' || HOST === '0.0.0.0' ||
  /^(10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/.test(HOST);

const SHELL = [
  './',
  './index.html',
  './manifest.json',
  './assets/css/tokens.css',
  './assets/css/app.css',
  './assets/img/icon.svg',
  './assets/img/icon-maskable.svg',
  './404.html',
  './assets/js/main.js',
  './assets/js/state.js',
  './assets/js/util.js',
  './assets/js/version.js',
  './assets/js/canvas/viewport.js',
  './assets/js/canvas/grid.js',
  './assets/js/canvas/items.js',
  './assets/js/canvas/input.js',
  './assets/js/import/drop.js',
  './assets/js/import/renderers.js',
  './assets/js/import/formats.js',
  './assets/js/arrange/arrangements.js',
  './assets/js/storage/assets.js',
  './assets/js/storage/idb.js',
  './assets/js/storage/mbrd.js',
  './assets/js/storage/storage.js',
  './assets/js/storage/zip.js',
  './assets/js/canvas/web.js',
  './assets/js/canvas/stills.js',
  './assets/js/ui/sidebar.js',
  './assets/js/ui/appearance.js',
  './assets/js/ui/menu.js',
  './assets/js/ui/notes.js',
  './assets/js/ui/trash.js',
  './assets/js/ui/audio.js',
  './assets/css/fonts.css',
  './assets/fonts/fraunces-latin.woff2',
  './assets/fonts/fraunces-latin-italic.woff2',
];

self.addEventListener('install', event => {
  self.skipWaiting();
  if (DEV) return;
  event.waitUntil(
    caches.open(VERSION).then(cache =>
      // addAll is all-or-nothing; one 404 would leave the app with no cache at
      // all, so each entry is allowed to fail on its own.
      Promise.all(SHELL.map(url => cache.add(url).catch(err => console.warn('[sw] skip', url, err))))
    )
  );
});

self.addEventListener('activate', event => {
  event.waitUntil((async () => {
    const keys = await caches.keys();
    await Promise.all(keys.filter(k => k !== VERSION).map(k => caches.delete(k)));
    await self.clients.claim();
  })());
});

self.addEventListener('fetch', event => {
  const req = event.request;
  if (DEV || req.method !== 'GET') return;

  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;

  // Navigations fall back to the cached shell so an offline launch still boots.
  if (req.mode === 'navigate') {
    event.respondWith(
      fetch(req).catch(() => caches.match('./index.html', { ignoreSearch: true }))
        .then(res => res || fetch(req))
    );
    return;
  }

  // Cache-first: the cache is version-epoched, so a hit needs no revalidation
  // and a new VERSION (bumped by save.bat) is what ships fresh code.
  event.respondWith((async () => {
    const hit = await caches.match(req, { ignoreSearch: true });
    if (hit) return hit;
    const res = await fetch(req);
    if (res.ok && res.type === 'basic') {
      const cache = await caches.open(VERSION);
      cache.put(req, res.clone());
    }
    return res;
  })());
});
