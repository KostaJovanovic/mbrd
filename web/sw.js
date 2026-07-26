/* mbrd - service worker
   Precaches the app shell so the board works with no network at all, which is
   the point: everything already runs locally, the only thing a reload needs is
   the shell itself. Boards live in IndexedDB and in .mbrd files - the SW never
   touches user data. */

// Cache Storage is origin-wide and shared with anything else served from the
// same host, so this app's caches are namespaced and the activate sweep below
// only ever deletes its own. Deleting by "not the current version" would take
// another app's cache with it.
//
// Written out in full rather than composed from PREFIX, because save.bat bumps
// this line by regex on every commit and would not recognise an expression.
// tests/sw.test.js holds the two together.
const VERSION = 'mbrd-v48';
const PREFIX = 'mbrd-';

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
  // The same two icons as bitmaps, because not every place an installed icon
  // turns up can read an SVG: iOS wants a PNG for the home screen, and a
  // handful of Android launchers and desktop shells still rasterise nothing.
  // Small enough that carrying both costs a few tens of kilobytes once.
  //
  // No apostrophes anywhere inside this array. tests/sw.test.js reads the list
  // by pulling every single-quoted run out of the source, so one in a comment
  // becomes half a filename and the whole list stops parsing.
  './assets/img/icon-192.png',
  './assets/img/icon-512.png',
  './assets/img/icon-maskable-192.png',
  './assets/img/icon-maskable-512.png',
  './404.html',
  './assets/js/main.js',
  './assets/js/state.js',
  './assets/js/util.js',
  './assets/js/geometry.js',
  './assets/js/measure.js',
  './assets/js/version.js',
  './assets/js/canvas/viewport.js',
  './assets/js/canvas/grid.js',
  './assets/js/canvas/paper.js',
  './assets/js/canvas/items.js',
  './assets/js/canvas/input.js',
  './assets/js/import/drop.js',
  './assets/js/import/artwork.js',
  './assets/js/import/formats.js',
  './assets/js/arrange/arrangements.js',
  './assets/js/storage/assets.js',
  './assets/js/storage/idb.js',
  './assets/js/storage/mbrd.js',
  './assets/js/storage/storage.js',
  './assets/js/storage/zip.js',
  './assets/js/canvas/web.js',
  './assets/js/canvas/stills.js',
  './assets/js/canvas/renderers.js',
  './assets/js/canvas/notes.js',
  './assets/js/canvas/audio.js',
  './assets/js/canvas/video.js',
  './assets/js/canvas/embed.js',
  './assets/js/canvas/model.js',
  './assets/js/import/mesh.js',
  './assets/js/ui/search.js',
  './assets/js/ui/konami.js',
  './assets/js/ui/sidebar.js',
  './assets/js/ui/appearance.js',
  './assets/js/ui/dialog.js',
  './assets/js/ui/fonts.js',
  './assets/js/ui/look.js',
  './assets/js/ui/pigments.js',
  './assets/js/ui/menu.js',
  './assets/js/ui/trash.js',
  './assets/js/ui/idle.js',
  './assets/js/ui/scalebar.js',
  // Optimising a board of photographs and music must work on a plane. Pictures
  // and sound are done by the browser itself, so they are all here - the ffmpeg
  // core the last two reach for is thirty megabytes and is deliberately *not*;
  // video alone is skipped offline until it has been fetched once, and the
  // dialog says so.
  './assets/js/optimize/optimize.js',
  './assets/js/optimize/picture.js',
  './assets/js/optimize/opus.js',
  './assets/js/optimize/ui.js',
  './assets/js/optimize/media.js',
  './assets/js/optimize/media-worker.js',
  './assets/css/fonts.css',
  // Every face, not a subset. Geist is --font-body in every look, and at the
  // plain end of the whimsy axis it is --font-display and Geist Mono is
  // --font-mono as well - so a shell cached without these boots offline in
  // fallback faces, which is the one failure a service worker exists to
  // prevent and the one nobody checks for. tests/sw.test.js now asserts this
  // list against the files on disk, because it drifted silently once already.
  './assets/fonts/fraunces-latin.woff2',
  './assets/fonts/fraunces-latin-ext.woff2',
  './assets/fonts/fraunces-latin-italic.woff2',
  './assets/fonts/fraunces-latin-ext-italic.woff2',
  './assets/fonts/geist-latin.woff2',
  './assets/fonts/geist-latin-ext.woff2',
  './assets/fonts/geist-mono-latin.woff2',
];

// Installing is all-or-nothing, and the activate handler below is why it has to
// be. Activation deletes every older shell, so a worker that installs with a
// half-populated cache does not degrade the offline experience - it destroys
// the last complete copy and replaces it with an incomplete one, at the exact
// moment the network is already unreliable. Letting each entry fail on its own
// was meant to survive a single 404; what it actually did was let one dropped
// response during an update take the working shell down with it.
//
// So a failed fetch fails the install. The new worker never activates, the
// previous one stays live with its cache intact, and the browser retries the
// update later. A genuinely missing file now shows up as an install error in
// DevTools rather than as a silent hole - and tests/sw.test.js asserts SHELL
// against the files on disk, so it should never be a 404 that gets this far.
self.addEventListener('install', event => {
  if (DEV) { self.skipWaiting(); return; }
  event.waitUntil((async () => {
    const cache = await caches.open(VERSION);
    try {
      await Promise.all(SHELL.map(url => cache.add(url)));
    } catch (err) {
      // Leave nothing half-built behind: the next attempt opens this same
      // version name and must not find a partial cache waiting for it.
      await caches.delete(VERSION);
      throw err;
    }
    await self.skipWaiting();
  })());
});

self.addEventListener('activate', event => {
  event.waitUntil((async () => {
    const keys = await caches.keys();
    await Promise.all(
      keys.filter(k => k.startsWith(PREFIX) && k !== VERSION).map(k => caches.delete(k))
    );
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
