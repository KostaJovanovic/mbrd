/* mbrd - service worker
   Precaches the shell so the board works offline. Boards live in IndexedDB
   and .mbrd files; the SW never touches user data. */

// Namespaced: activate only deletes its own PREFIX caches.
// VERSION is literal because save.bat bumps it by regex.
const VERSION = 'mbrd-v599';
const PREFIX = 'mbrd-';

// Local dev: pass-through so a refresh always shows the latest edit. 169.254 is
// link-local, where a dev server bound to a direct cable or an unconfigured
// adapter answers; cached there, every stylesheet stayed at the last VERSION.
const HOST = self.location.hostname;
const DEV = HOST === 'localhost' || HOST === '127.0.0.1' || HOST === '0.0.0.0' ||
  /^(10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|169\.254\.)/.test(HOST);

const SHELL = [
  './',
  './index.html',
  // By filename, not address: the navigate handler maps /patch to this entry.
  './patch.html',
  // The site pages, precached so they work offline.
  './privacy.html',
  './manifest.json',
  './assets/css/tokens.css',
  // Subsystem sheets, in cascade order (quality.css last).
  './assets/css/base.css',
  './assets/css/canvas.css',
  './assets/css/items.css',
  // The five sheets items.css was split into, in cascade order.
  './assets/css/ghosts.css',
  './assets/css/fences.css',
  './assets/css/media.css',
  './assets/css/cards.css',
  './assets/css/item-chrome.css',
  './assets/css/sidebar.css',
  './assets/css/chrome.css',
  './assets/css/drawer.css',
  './assets/css/menu.css',
  './assets/css/library.css',
  './assets/css/status.css',
  './assets/css/dialog.css',
  './assets/css/viewer.css',
  './assets/css/editor.css',
  './assets/css/color-picker.css',
  './assets/css/sticker-pad.css',
  './assets/css/mobile.css',
  './assets/css/timeline.css',
  './assets/css/clean.css',
  './assets/css/quality.css',
  // Document-page sheets (not in the cascade above).
  './assets/css/patch.css',
  './assets/css/privacy.css',
  // Chrome sprite (buttons, menus). Stickers are a separate sprite.
  './assets/icons.svg',
  './assets/stickers.svg',
  // Licence notices for vendored assets (MIT, OFL, LGPL).
  // (No apostrophes anywhere in this array, comments included.
  // tests/sw.test.js reads SHELL by pulling out single-quoted runs.)
  './assets/phosphor-LICENSE.txt',
  './assets/cuelume-LICENSE.txt',
  // Notice only; the 7 MB wasm binary is not precached.
  './assets/vendor/occt/LICENSE.txt',
  './assets/fonts/geist-OFL.txt',
  './assets/fonts/fraunces-OFL.txt',
  './assets/fonts/playfair-OFL.txt',
  './assets/img/icon.svg',
  './assets/img/icon-maskable.svg',
  // Bitmap icons for platforms that cannot read SVG.
  './assets/img/icon-192.png',
  './assets/img/icon-512.png',
  './assets/img/icon-maskable-192.png',
  './assets/img/icon-maskable-512.png',
  // Textures: without these the board loses its paper grain offline.
  './assets/img/paper-grain.webp',
  './assets/img/cork-board.webp',
  // Committed bitmaps, not fetched at runtime.
  './assets/img/credit-valjdakosta.webp',
  './assets/img/credit-omarzunic.webp',
  // The bundle. No 404.html: it is a byte copy of index.html above.
  './assets/app.js',
  // Outside the bundle: fetched by URL at runtime (see optimize/media.ts).
  './assets/js/optimize/media-worker.js',
  './assets/css/fonts.css',
  // All font files; tests/sw.test.js asserts this list against the directory.
  './assets/fonts/playfair-latin.woff2',
  './assets/fonts/playfair-latin-ext.woff2',
  './assets/fonts/playfair-latin-italic.woff2',
  './assets/fonts/playfair-latin-ext-italic.woff2',
  './assets/fonts/fraunces-latin.woff2',
  './assets/fonts/fraunces-latin-ext.woff2',
  './assets/fonts/fraunces-latin-italic.woff2',
  './assets/fonts/fraunces-latin-ext-italic.woff2',
  './assets/fonts/geist-latin.woff2',
  './assets/fonts/geist-latin-ext.woff2',
  './assets/fonts/geist-mono-latin.woff2',
];

// cache.add(), minus the redirect flag. The host answers index.html, patch.html
// and privacy.html with a 307 to the bare path, and a navigation refuses a
// redirected response, so the offline fallback would serve an error page.
async function precache(cache, url) {
  const res = await fetch(url);
  if (!res.ok) throw new TypeError(`precache ${url}: ${res.status}`);
  await cache.put(url, res.redirected ? new Response(res.body, res) : res);
}

// All-or-nothing: a failed fetch fails the install, so a partial cache never
// replaces a working one. The previous worker stays live until the next attempt.
self.addEventListener('install', event => {
  if (DEV) { self.skipWaiting(); return; }
  event.waitUntil((async () => {
    const cache = await caches.open(VERSION);
    try {
      await Promise.all(SHELL.map(url => precache(cache, url)));
    } catch (err) {
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

  // Looks in this version's cache only, never the origin-wide caches.match().

  // Navigations: known pages get their own cached shell; everything else gets
  // index.html (the app handles unknown paths as not-found).
  if (req.mode === 'navigate') {
    const page = /\/patch(\.html)?\/?$/.test(url.pathname) ? './patch.html'
      : /\/privacy(\.html)?\/?$/.test(url.pathname) ? './privacy.html'
        : './index.html';
    event.respondWith((async () => {
      try {
        return await fetch(req);
      } catch {
        const cache = await caches.open(VERSION);
        return (await cache.match(page, { ignoreSearch: true })) || fetch(req);
      }
    })());
    return;
  }

  // Cache-first; a new VERSION (bumped by save.bat) is what ships fresh code.
  event.respondWith((async () => {
    const cache = await caches.open(VERSION);
    const hit = await cache.match(req, { ignoreSearch: true });
    if (hit) return hit;
    const res = await fetch(req);
    if (res.ok && res.type === 'basic') {
      event.waitUntil(cache.put(req, res.clone()));
    }
    return res;
  })());
});
