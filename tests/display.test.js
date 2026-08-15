// Display copies are made asynchronously, and the two events that invalidate
// them - loading a board, moving the sharpness dial - both arrive as
// clearDisplay(). A full decode is slow enough that a clear lands mid-flight
// routinely, so the module has to answer the question "who won" rather than let
// whichever promise resolves last write the cache.
//
// The invariant: a job that started before a clear publishes nothing. It must
// not repopulate the cache the clear emptied, and it must not create an object
// URL on its way out - a URL nobody receives is a leak, and the board it
// belonged to is already gone.

import { test } from 'node:test';
import assert from 'node:assert/strict';
// Canonical, deliberately un-cache-busted: display.js resolves '../storage/
// assets.js' without a query, so a query-busted copy here would be a second,
// empty registry and every lookup would miss - which looks exactly like the
// pass this file is trying to prove.
import { putAsset, clearAssets } from '../web/assets/js/storage/assets.ts';

/** A blob-alike: display.js only reads .type, and putAsset only reads .size. */
const imageBlob = () => ({ type: 'image/png', size: 1024 });

/**
 * Install the four browser APIs display.js reaches for, with the decode held
 * open so a test can interleave a clear with a generation in flight.
 *
 * Returns `release()` to let the decode finish, plus counters proving nothing
 * was allocated behind a refused job, plus `restore()`.
 *
 * `restore()` matters more than it looks: `globalThis.URL` is replaced below by
 * an object with two methods on it, and Node's real URL is a *class* that the
 * rest of the suite constructs. Leaving the stub standing meant every test file
 * that ran after this one in the same process inherited it, and the failure
 * would land somewhere else entirely - `new URL(...) is not a constructor` in a
 * module that never asked for a stub.
 */
function stubImageAPIs() {
  const saved = ['createImageBitmap', 'OffscreenCanvas', 'URL']
    .map(name => [name, Object.getOwnPropertyDescriptor(globalThis, name)]);
  const restore = () => {
    for (const [name, desc] of saved) {
      if (desc) Object.defineProperty(globalThis, name, desc);
      else delete globalThis[name];
    }
  };
  let release;
  const decoding = new Promise(r => { release = r; });
  let created = 0;
  let revoked = 0;
  let live = 0;
  let peak = 0;

  // Counts *entries*, not completions: a decode is live from the call until the
  // bitmap is closed, and holding two full-resolution bitmaps at once is the
  // memory blow-up this module exists to prevent.
  globalThis.createImageBitmap = () => {
    peak = Math.max(peak, ++live);
    return decoding.then(() => ({
      width: 4000, height: 3000, close() { live--; },
    }));
  };

  globalThis.OffscreenCanvas = class {
    constructor(w, h) { this.width = w; this.height = h; }
    getContext() { return { drawImage() {}, imageSmoothingEnabled: true, imageSmoothingQuality: '' }; }
    async convertToBlob() { return { type: 'image/webp', size: 64 }; }
  };

  globalThis.URL = {
    createObjectURL: () => `blob:copy-${++created}`,
    revokeObjectURL: () => { revoked++; },
  };

  return { release, restore, urls: () => created, revoked: () => revoked, peak: () => peak };
}

// display.js keeps its cache in module scope, so each test needs its own copy.
// The asset registry is shared, so it is emptied instead.
let n = 0;
const freshDisplay = () => { clearAssets(); return import(`../web/assets/js/canvas/display.ts?case=${n++}`); };

test('a copy generated across a clear is discarded, not published', async (t) => {
  const api = stubImageAPIs();
  t.after(api.restore);
  const { ensureDisplay, displayURLReady, clearDisplay } = await freshDisplay();

  putAsset('h1', imageBlob());
  const job = ensureDisplay('h1');      // parks inside createImageBitmap
  clearDisplay();                       // the board changes under it
  api.release();                        // the decode finishes afterwards

  assert.equal(await job, null, 'a job outlived by a clear must resolve to null');
  assert.equal(displayURLReady('h1'), null, 'the cleared cache must stay empty');
  assert.equal(api.urls(), 0, 'a refused job must not create an object URL');
});

test('a clear does not reset the queue, so decodes stay serialized', async (t) => {
  const api = stubImageAPIs();
  t.after(api.restore);
  const { ensureDisplay, clearDisplay } = await freshDisplay();

  putAsset('a', imageBlob());
  putAsset('b', imageBlob());

  const first = ensureDisplay('a');     // holds the one permitted decode
  clearDisplay();
  const second = ensureDisplay('b');    // must queue behind it, not start beside it

  // Let every pending microtask drain: if the clear handed the second job a
  // fresh chain, it reaches createImageBitmap here and the peak becomes 2.
  for (let i = 0; i < 10; i++) await Promise.resolve();
  assert.equal(api.peak(), 1, 'a clear must not let a second decode start beside a live one');

  api.release();
  await first;
  await second;
  assert.equal(api.peak(), 1, 'and the whole run never holds two decodes at once');
});

test('generation still works normally when no clear intervenes', async (t) => {
  const api = stubImageAPIs();
  t.after(api.restore);
  const { ensureDisplay, displayURLReady } = await freshDisplay();

  putAsset('h2', imageBlob());
  const job = ensureDisplay('h2');
  api.release();

  const url = await job;
  assert.match(url, /^blob:copy-/, 'an uninterrupted job publishes its copy');
  assert.equal(displayURLReady('h2'), url, 'and the copy is cached for re-mounts');
});
