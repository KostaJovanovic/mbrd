// Display copies are made asynchronously, and both events that invalidate
// them (loading a board, moving the sharpness dial) arrive as clearDisplay().
// A full decode is slow enough that a clear routinely lands mid-flight, so
// the module must decide "who won" rather than let the last promise write.
//
// The invariant: a job started before a clear publishes nothing - it must
// not repopulate the emptied cache, and must not create an object URL a
// gone board would leak.

import { test } from 'node:test';
import assert from 'node:assert/strict';
// Deliberately un-cache-busted: display.ts resolves this path without a
// query, so a busted copy here would be a second, empty registry where every
// lookup misses - looking exactly like the pass this file tries to prove.
import { putAsset, clearAssets } from '../web/assets/js/storage/assets.ts';
import { saveMatte } from '../web/assets/js/storage/matte-cache.ts';
import { fakeIndexedDB } from './helpers.js';

// A database for the cut-out cache. Installed before anything opens a
// connection; storage/idb.ts reaches for the global only inside open(), so
// this lands in time despite the imports above having already run.
globalThis.indexedDB = fakeIndexedDB();

/** A blob-alike: display.ts only reads .type, and putAsset only reads .size. */
const imageBlob = (type = 'image/png') => ({ type, size: 1024 });

/**
 * Install the four browser APIs display.ts reaches for, with the decode held
 * open so a test can interleave a clear with a generation in flight.
 *
 * Returns `release()` to let the decode finish, counters proving nothing was
 * allocated behind a refused job, and `restore()`.
 *
 * `restore()` matters: `globalThis.URL` is replaced by an object, while
 * Node's real URL is a class the rest of the suite constructs - leaving the
 * stub standing would break `new URL(...)` in unrelated test files later.
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

  // Counts entries, not completions - a decode is live until the bitmap
  // closes, and holding two full-resolution bitmaps at once is the blow-up
  // this module prevents.
  globalThis.createImageBitmap = () => {
    peak = Math.max(peak, ++live);
    return decoding.then(() => ({
      width: 4000, height: 3000, close() { live--; },
    }));
  };

  // Models a real encoder, not a cooperative one: the spec says an
  // unsupported type comes back as PNG without complaint, as every Safari
  // does for WebP. A stub always answering 'image/webp' hid that for a while.
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

// display.ts keeps its cache in module scope, so each test needs its own
// copy; the asset registry is shared, so it's emptied instead.
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

  // Drain pending microtasks: a fresh chain from the clear would reach
  // createImageBitmap here and push peak to 2.
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

// The crash this module prevents, reached by itself. No Safari encodes WebP
// from a canvas; returning null used to make the renderer mount the original
// at full resolution for every picture - a gigabyte of decode and a dead tab.
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

// The one retry is conditional: a JPEG source provably has no alpha, so
// re-encoding as JPEG can't flatten anything, but a PNG might be a cut-out -
// gaining a black background would trade a crash for a wrong picture.
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

// A copy is a decode, a resize and an encode at every start. A board optimised
// to 1200px under Balanced's 1152 made one of every photograph to shave 4% off
// it, and the queue ran for the first minute of every session.
test('a copy barely smaller than its source is not made', async () => {
  const { copyScale } = await freshDisplay();
  assert.equal(copyScale(1200, 1152), 1, 'a 4% shave shows the source');
  assert.equal(copyScale(1260, 1152), 1, 'so does a tenth');
  assert.ok(Math.abs(copyScale(1200, 1024) - 1024 / 1200) < 1e-9, 'Soft on the same picture still copies');
  assert.ok(Math.abs(copyScale(4000, 1280) - 0.32) < 1e-9, 'and a camera original always does');
  assert.equal(copyScale(800, 1280), 1, 'a picture under the ceiling was never copied');
});

// The queue holds one full-resolution decode at a time; a cached cut-out
// (already decoded and written to IndexedDB on an earlier load) isn't one.
// Queuing it anyway is what the first persisted-cache version did - a
// thirty-photo board still waited seconds for a picture already on disk.
// A deadline, because this regression doesn't fail, it waits: without the
// unqueued path, the assertion below parks behind a decode this test never
// releases, and a hanging suite says nothing.
test('a cached cut-out does not wait behind a full-resolution decode', { timeout: 5000 }, async (t) => {
  const api = stubImageAPIs();
  t.after(api.restore);
  const { ensureDisplay, matteVariant } = await freshDisplay();

  putAsset('slow', imageBlob('image/jpeg'));
  putAsset('cut', imageBlob('image/png'));
  // What an earlier load would have left behind, under the key this module
  // asks for.
  await saveMatte('cut', matteVariant('cut', null, null), new Blob([new Uint8Array(2048)]));

  // Occupies the one permitted decode and never finishes - api.release() is
  // called only after the assertion below has its answer.
  const parked = ensureDisplay('slow');
  const quick = ensureDisplay('cut', null, null, true);

  assert.match(await quick, /^blob:copy-/, 'the cached copy is published while the decode is parked');
  assert.equal(api.peak(), 1, 'and it started no decode of its own');

  api.release();
  await parked;
});
