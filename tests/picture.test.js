// The encoders, on an engine that can't write the format they ask for -
// the whole Safari story in one file. `convertToBlob` is specified to
// hand back a PNG silently when it can't write the requested type, and no
// Safari version writes WebP from a canvas through Safari 27. Both
// functions here used to read that substitution as a refusal, so Safari
// got no thumbnails and shrinkPicture() left every picture untouched
// after running the dialog to say otherwise.
//
// Every stub below is a *real* encoder, not a cooperative one: it answers
// with the requested type only when it's in `encodes`, PNG otherwise. A
// stub always returning `image/webp` is exactly why none of this was caught.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { shrinkPicture, makeThumb } from '../web/assets/js/optimize/picture.ts';

/** A real Blob: isAnimated() slices bytes out of it, so a fake will not do. */
const pic = (type, bytes = 40000) => new Blob([new Uint8Array(bytes)], { type });

/**
 * Install `createImageBitmap` and `OffscreenCanvas`. `encodes` is the set
 * of types this engine can write - `['image/png']` is Safari as far as
 * these two functions are concerned. `out` is the size of whatever comes
 * back, which the WORTH_IT and smaller-than-original guards decide on.
 */
function stubEncoder({ encodes = ['image/webp', 'image/jpeg', 'image/png'], out = 4000, w = 4000, h = 3000 } = {}) {
  const saved = ['createImageBitmap', 'OffscreenCanvas']
    .map(name => [name, Object.getOwnPropertyDescriptor(globalThis, name)]);
  const asked = [];

  globalThis.createImageBitmap = (_blob, opts) => Promise.resolve({
    width: opts?.resizeWidth || w,
    height: opts?.resizeWidth ? Math.round(h * (opts.resizeWidth / w)) : h,
    close() {},
  });

  globalThis.OffscreenCanvas = class {
    constructor(width, height) { this.width = width; this.height = height; }
    getContext() {
      return {
        drawImage() {},
        imageSmoothingEnabled: true,
        imageSmoothingQuality: '',
        // looksCutOut() reads this; all-zero alpha answers `false` to it,
        // but that question isn't what this file is about.
        getImageData: (_x, _y, gw, gh) => ({ data: new Uint8ClampedArray(gw * gh * 4) }),
      };
    }
    async convertToBlob({ type } = {}) {
      asked.push(type);
      const got = encodes.includes(type) ? type : 'image/png';
      return new Blob([new Uint8Array(out)], { type: got });
    }
  };

  return {
    asked: () => asked,
    restore() {
      for (const [name, desc] of saved) {
        if (desc) Object.defineProperty(globalThis, name, desc);
        else delete globalThis[name];
      }
    },
  };
}

// ── shrinkPicture ─────────────────────────────────────────────────────────

test('a JPEG retries as JPEG where the engine will not write WebP', async (t) => {
  const api = stubEncoder({ encodes: ['image/jpeg', 'image/png'] });
  t.after(api.restore);

  const shrunk = await shrinkPicture(pic('image/jpeg'));
  assert.ok(shrunk, 'a picture must still be shrunk on an engine without WebP');
  assert.equal(shrunk.blob.type, 'image/jpeg', 'and the retry is what is kept');
  assert.deepEqual(api.asked(), ['image/webp', 'image/jpeg'],
    'WebP is still asked for first - it is the smaller format where it exists');
});

test('a PNG keeps the PNG rather than being flattened onto black', async (t) => {
  const api = stubEncoder({ encodes: ['image/png'] });
  t.after(api.restore);

  const shrunk = await shrinkPicture(pic('image/png'));
  assert.ok(shrunk, 'a PNG must still be shrunk');
  assert.equal(shrunk.blob.type, 'image/png');
  assert.deepEqual(api.asked(), ['image/webp'],
    'no JPEG retry for a source that might be a cut-out: alpha is not ours to lose');
});

test('a pinned type is never substituted', async (t) => {
  const api = stubEncoder({ encodes: ['image/png'] });
  t.after(api.restore);

  // toOpus() tags a track with JPEG cover art. A PNG under a JPEG's name
  // is a broken tag, so a caller naming a type gets it or gets nothing -
  // the behaviour every caller had before.
  const shrunk = await shrinkPicture(pic('image/jpeg'), { type: 'image/jpeg' });
  assert.equal(shrunk, null, 'a caller that pinned a type must not be handed another');
});

test('a substituted encode still has to earn its place', async (t) => {
  const api = stubEncoder({ encodes: ['image/png'], out: 39000 });
  t.after(api.restore);

  // 39000 against a 40000-byte original is a 2.5% saving, under
  // WORTH_IT - the guard that makes keeping a PNG safe: only written to
  // the board if meaningfully smaller.
  const shrunk = await shrinkPicture(pic('image/png', 40000));
  assert.equal(shrunk, null, 'a re-encode that saves nothing must still be refused');
});

// ── makeThumb ─────────────────────────────────────────────────────────────

test('a thumbnail is still cut where the engine will not write WebP', async (t) => {
  const api = stubEncoder({ encodes: ['image/png'], out: 3000 });
  t.after(api.restore);

  // The thumbnail is the memory defence for a zoomed-out board and the
  // stand-in a card shows while its display copy renders. Withholding it
  // from the engine that runs out of memory was backwards.
  const thumb = await makeThumb(pic('image/jpeg', 40000), 4000);
  assert.ok(thumb, 'Safari must get thumbnails');
  assert.equal(thumb.blob.type, 'image/png', 'as whatever the engine could write');
  assert.equal(thumb.width, 100, 'at the usual hundred pixels');
});

test('a thumbnail bigger than its picture is still not a thumbnail', async (t) => {
  const api = stubEncoder({ encodes: ['image/png'], out: 5000 });
  t.after(api.restore);

  const thumb = await makeThumb(pic('image/png', 4000), 4000);
  assert.equal(thumb, null, 'the size guard survives the format change');
});
