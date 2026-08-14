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
const VERSION = 'mbrd-v199';
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
  // The changelog, which is the second page this site has - and is the app,
  // opening a board that ships with it. Three files, all needed together:
  // this page and the stylesheet that lays it out (further down, at the end of
  // the sheets). Precached for the reason index.html is - and it is cheaper
  // than the app: the changelog is one document with its prose inside it, so
  // the page and the sheets it shares with the app are the whole of what an
  // offline visit needs.
  //
  // Listed by filename rather than as ./patch, which is the address it is
  // served at - cache.add fetches what it is given, and tests/sw.test.js checks
  // every entry against a file on disk. The navigate handler below maps the
  // address to this entry.
  './patch.html',
  // The privacy page, and its one stylesheet further down with the others. Two
  // files, both tiny, and precached for the reason the changelog is: it is a
  // page of this site rather than a page of the app, and a page about what
  // happens to your files that cannot be read offline is a poor advertisement
  // for an app whose whole claim is that it needs no network.
  //
  // Listed by filename rather than as ./privacy, which is the address it is
  // served at - the navigate handler below maps one to the other, exactly as it
  // does for the changelog.
  './privacy.html',
  './manifest.json',
  './assets/css/tokens.css',
  // The subsystem stylesheets, in the order index.html loads them, which is the
  // cascade - see the banner at the top of base.css. quality.css is last there
  // and is last here.
  './assets/css/base.css',
  './assets/css/canvas.css',
  './assets/css/items.css',
  // The five sheets the old items.css was split into, in cascade order. The
  // first and the last are load-bearing: items.css declares .card before the
  // type sheets redress it, and item-chrome.css settles three ties on document
  // order. See the banner at the top of items.css.
  './assets/css/ghosts.css',
  './assets/css/fences.css',
  './assets/css/media.css',
  './assets/css/cards.css',
  './assets/css/item-chrome.css',
  './assets/css/sidebar.css',
  './assets/css/chrome.css',
  './assets/css/trash.css',
  './assets/css/menu.css',
  './assets/css/library.css',
  './assets/css/status.css',
  './assets/css/dialog.css',
  './assets/css/viewer.css',
  './assets/css/color-picker.css',
  './assets/css/sticker-pad.css',
  './assets/css/mobile.css',
  './assets/css/timeline.css',
  './assets/css/quality.css',
  // Not one of the twenty above and not in the cascade with them - this one
  // dresses patch.html and is loaded by nothing else. It is here because
  // tests/sw.test.js walks the stylesheet directory and precaches what it finds,
  // which is the right rule: a sheet that ships and cannot be fetched offline is
  // a page that renders naked. See the banner at the top of the file.
  './assets/css/patch.css',
  // And the same again for the privacy page, which like the changelog is a
  // document rather than the app: it loads tokens.css for the palette and this
  // for the rest, and nothing else in the tree loads either of them together.
  './assets/css/privacy.css',
  // Every icon in the app, in one sprite. Referenced by <use> from index.html
  // and built into the right-click menu by ui/menu.js, so a board opened offline
  // without it is a board of blank buttons - it belongs in the shell as much as
  // a stylesheet does. Unlike the two below, this one is never an installed app
  // icon; it is chrome.
  './assets/icons.svg',
  // The sticker shapes, and a second sprite on purpose - see the head of the
  // file for why they are not in the one above. Same argument for caching it:
  // a board covered in stars, opened on a plane, would draw forty holes.
  './assets/stickers.svg',
  // And the licence for them, because the shapes were drawn by other people.
  // Phosphor is MIT and its one condition is that the notice travels with the
  // copies, so an installed app that carries the drawings offline and leaves
  // the notice on the server is an installed app that does not meet it. The
  // bundled faces predate this reading and their OFL files are not here; that
  // is a gap rather than a decision. See THIRD-PARTY.md.
  // (No apostrophes anywhere in this array, comments included - see CLAUDE.md.
  // tests/sw.test.js reads SHELL by pulling out single-quoted runs, and one
  // apostrophe up here silently unlists every entry below it.)
  './assets/phosphor-LICENSE.txt',
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
  // The stock the sheet is printed on - the CSS multiplies it over body. Not
  // decoration that can fail to no-op: without it the board loses its tooth
  // offline and the paper reads a shade lighter than it does online.
  './assets/img/paper-grain.webp',
  // And the stock a *region* is on at the softish end of the whimsy axis, where
  // a fence is a cork board. Same bargain as the grain above, with one
  // difference that makes it matter more: without this a fence offline falls
  // back to --cork, the mean of that tile, so it is a flat brown rectangle
  // rather than a slightly smoother one. The failure shows at every zoom instead
  // of only up close. (No apostrophes in here - tests/sw.test.js reads this list
  // by pairing quotes, so one in a comment shifts every entry after it.)
  './assets/img/cork-board.webp',
  // The two faces on the credits sheet. Committed rather than fetched from
  // GitHub - see the note above the dialog in index.html - which is exactly why
  // they belong in here: a file this app ships is a file this app caches.
  './assets/img/credit-valjdakosta.webp',
  './assets/img/credit-omarzunic.webp',
  // No 404 page in here, though a 404.html now exists beside index.html. It is
  // a byte copy of it - the static host wants the miss spelled as a file, and
  // caching a second copy of the shell would double the download to say the
  // same thing twice. The app is served at addresses it does not have and works
  // out from the URL that it is one of them, so what a miss needs cached is
  // index.html - the first entry in this list, and the same document the
  // navigation fallback already hands back offline.
  // One artifact, not ninety-six modules. The app is TypeScript now and a
  // browser cannot fetch a .ts file, so what ships is the bundle esbuild
  // writes - see the script tag in index.html. Every module that used to be
  // listed here one by one is inside it, and the map beside it points back at
  // the sources, which still ship.
  './assets/app.js',
  // The exception, and a real one: the media worker is fetched by URL at
  // runtime rather than imported, so it is not in the bundle and stays a
  // plain .js file the browser can load. See optimize/media.ts.
  './assets/js/optimize/media-worker.js',
  './assets/css/fonts.css',
  // Every face, not a subset. Geist is --font-body in every look, and at the
  // plain end of the whimsy axis it is --font-display and Geist Mono is
  // --font-mono as well - so a shell cached without these boots offline in
  // fallback faces, which is the one failure a service worker exists to
  // prevent and the one nobody checks for. tests/sw.test.js now asserts this
  // list against the files on disk, because it drifted silently once already.
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

  // Everything below looks in *this version's* cache by name, never through the
  // origin-wide caches.match(). Cache Storage is shared across every worker on
  // the origin, so a global match could answer with a stale response another
  // app - or an older shell of this one - left behind. See AUD-14.

  // Navigations fall back to the cached shell so an offline launch still boots.
  //
  // Which shell depends on where the navigation was going, and that is the whole
  // of this branch. Every path this app does not have is answered with the app
  // itself - see the base tag in index.html and notFound in main.ts - so before
  // there was a second page, index.html was the only honest answer to any
  // address. /patch is now a path the app DOES have, and handing back the board
  // for it offline would be the one case where the not-found design tells a lie:
  // the page exists, it is in the cache two dozen lines up, and the visitor
  // asked for it by name.
  //
  // Matched on the tail rather than against the registration scope, which would
  // mean reading self.location.href at load time. A nested /somewhere/patch
  // therefore also matches, and that is a path this app does not have either -
  // so the cost of the loose match is showing the changelog instead of the
  // board on an address that is a 404 in both readings. The trailing slash is in
  // the pattern because the host redirects /patch/ to /patch and there is no
  // host to do that when this branch is the one answering.
  //
  // The privacy page is the third address and answers on exactly the same
  // terms: it exists, it is in the cache, and a visitor who typed it should not
  // be handed a board.
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

  // Cache-first: the cache is version-epoched, so a hit needs no revalidation
  // and a new VERSION (bumped by save.bat) is what ships fresh code.
  event.respondWith((async () => {
    const cache = await caches.open(VERSION);
    const hit = await cache.match(req, { ignoreSearch: true });
    if (hit) return hit;
    const res = await fetch(req);
    if (res.ok && res.type === 'basic') {
      // Kept alive past the response and scoped to this cache: a worker
      // terminating mid-put would otherwise drop the write, and a bare promise
      // could reject unhandled.
      event.waitUntil(cache.put(req, res.clone()));
    }
    return res;
  })());
});
