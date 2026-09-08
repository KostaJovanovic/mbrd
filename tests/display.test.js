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
// Canonical, deliberately un-cache-busted: display.ts resolves '../storage/
// assets.ts' without a query, so a query-busted copy here would be a second,
// empty registry and every lookup would miss - which looks exactly like the
// pass this file is trying to prove. The cut-out cache is imported the same way
// and for the same reason.
import { putAsset, clearAssets } from '../web/assets/js/storage/assets.ts';
import { saveMatte } from '../web/assets/js/storage/matte-cache.ts';
import { fakeIndexedDB } from './helpers.js';

// A database for the cut-out cache to sit on. Installed before anything opens a
// connection; storage/idb.ts reaches for the global inside open() and nowhere
// else, so this lands in time even though the imports above have already run.
globalThis.indexedDB = fakeIndexedDB();

/** A blob-alike: display.ts only reads .type, and putAsset only reads .size. */
const imageBlob = (type = 'image/png') => ({ type, size: 1024 });

/**
 * Install the four browser APIs display.ts reaches for, with the decode held
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
function stubImageAPIs({ encodes = ['image/webp'] } = {}) {
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

  // Models a real encoder rather than a cooperative one: the specification says
  // an unsupported type comes back as PNG *without complaint*, which is what
  // every Safari does when asked for WebP. A stub that always answers
  // 'image/webp' is why that went unnoticed here for as long as it did.
  const asked = [];
  globalThis.OffscreenCanvas = class {
    constructor(w, h) { this.width = w; this.height = h; }
    getContext() { return { drawImage() {}, imageSmoothingEnabled: true, imageSmoothingQuality: '' }; }
    async convertToBlob({ type } = {}) {
      asked.push(type);
      return { type: encodes.includes(type) ? type : 'image/png', size: 64 };
    }
  };

  globalThis.URL = {
    createObjectURL: () => `blob:copy-${++created}`,
    revokeObjectURL: () => { revoked++; },
  };

  return { release, restore, urls: () => created, revoked: () => revoked, peak: () => peak, asked: () => asked };
}

// display.ts keeps its cache in module scope, so each test needs its own copy.
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

// The crash this module exists to prevent, reached by the module itself. No
// version of Safari encodes WebP from a canvas, and this used to answer that by
// returning null - which the renderer reads as "mount the original", at full
// resolution, for every picture on the board. Two dozen phone photographs is a
// gigabyte of decode and a dead tab, on the one engine that dies.
test('a copy is still published where the engine cannot write WebP', async (t) => {
  const api = stubImageAPIs({ encodes: ['image/png'] });
  t.after(api.restore);
  const { ensureDisplay, displayURLReady } = await freshDisplay();

  putAsset('png', imageBlob('image/png'));
  const job = ensureDisplay('png');
  api.release();

  assert.match(await job, /^blob:copy-/, 'a PNG copy is a bounded copy and must be kept');
  assert.match(displayURLReady('png'), /^blob:copy-/, 'and it must be cached like any other');
});

// The one retry, and the reason it is conditional. A JPEG source provably has
// no alpha, so re-encoding as JPEG cannot flatten anything; a PNG source might
// be a cut-out, and gaining a black background would be this module trading a
// crash for a wrong picture.
test('a JPEG source retries as JPEG where WebP is refused, a PNG one does not', async (t) => {
  const api = stubImageAPIs({ encodes: ['image/jpeg', 'image/png'] });
  t.after(api.restore);
  const { ensureDisplay } = await freshDisplay();

  putAsset('jpg', imageBlob('image/jpeg'));
  putAsset('png', imageBlob('image/png'));
  const jpg = ensureDisplay('jpg');
  const png = ensureDisplay('png');
  api.release();
  await jpg;
  await png;

  assert.deepEqual(api.asked(), ['image/webp', 'image/jpeg', 'image/webp'],
    'the JPEG source asks twice and the PNG source keeps what came out');
});

// The queue holds this app to one full-resolution decode at a time, and a cached
// cut-out is not one: it is a card-sized WebP that was decoded, cut and encoded
// on some earlier load and written to IndexedDB. Putting it in the queue anyway
// is what the first version of the persisted cache did, and it gave back almost
// nothing - on a board of thirty photographs the queue is seconds long, so a
// picture sitting ready on disk still appeared about as late as it had when the
// model was running. The model no longer ran and the wait was unchanged.
// A deadline, because the regression this guards does not fail - it *waits*.
// Without the unqueued path the assertion below is parked behind a decode that
// this test deliberately never releases, and a hanging suite says nothing.
test('a cached cut-out does not wait behind a full-resolution decode', { timeout: 5000 }, async (t) => {
  const api = stubImageAPIs();
  t.after(api.restore);
  const { ensureDisplay, matteVariant } = await freshDisplay();

  putAsset('slow', imageBlob('image/jpeg'));
  putAsset('cut', imageBlob('image/png'));
  // What an earlier load would have left behind, under the key this module will
  // ask for rather than under one spelled out again here.
  await saveMatte('cut', matteVariant('cut', null, null), new Blob([new Uint8Array(2048)]));

  // Occupies the one permitted decode and never finishes: api.release() is not
  // called until the assertion below has already had its answer.
  const parked = ensureDisplay('slow');
  const quick = ensureDisplay('cut', null, null, true);

  assert.match(await quick, /^blob:copy-/, 'the cached copy is published while the decode is parked');
  assert.equal(api.peak(), 1, 'and it started no decode of its own');

  api.release();
  await parked;
});
