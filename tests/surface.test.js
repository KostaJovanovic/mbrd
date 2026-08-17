// The drawing surface, on an engine that has half of one.
//
// canvas/surface.ts is the single door to every picture this app derives: the
// display copy, the optimiser's shrink and its thumbnails, a video poster, a
// model's still and a GIF's freeze frame. So a fault in it is never one missing
// picture - it is all of them at once, silently, because every one of those call
// sites treats "no surface" as "leave the original alone".
//
// The fault this file was written for is the second kind of absence. The module
// used to fall back to an element only when `new OffscreenCanvas()` *threw*,
// which is the failure an engine without OffscreenCanvas has. Firefox for
// Android has had the other one: the constructor works, the object exists, and
// `getContext('2d')` answers null - so the fallback never ran and the app
// derived no pictures at all on that browser. What that looks like on a board
// is a PDF whose page was rendered and whose card then drew its own alt text at
// the top of an empty rectangle, and a clip with no frame at any zoom.
//
// Every stub here is an *uncooperative* engine rather than a helpful one, for
// the reason tests/picture.test.js gives about the same module's encoders: a
// stub that answers everything is exactly why none of this was caught.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { surface, surfaceToBlob } from '../web/assets/js/canvas/surface.ts';

/** A 2D context with the members the Surface type names, and nothing else. */
const fakeCtx = () => ({
  drawImage() {},
  imageSmoothingEnabled: false,
  imageSmoothingQuality: '',
  getImageData: (_x, _y, w, h) => ({ data: new Uint8ClampedArray(w * h * 4) }),
});

/**
 * Install an engine for the length of one call.
 *
 * `offscreen` is what `new OffscreenCanvas()` does - 'none' for an engine
 * without the global, 'throws' for one that refuses to build it, 'no-2d' for
 * Firefox on Android, and 'works' for everything else. `element` is whether
 * there is a document to make a `<canvas>` in.
 */
function engine({ offscreen = 'works', element = true, encodes = ['image/png'] } = {}) {
  const saved = ['OffscreenCanvas', 'document']
    .map(name => [name, Object.getOwnPropertyDescriptor(globalThis, name)]);
  const made = [];

  if (offscreen !== 'none') {
    globalThis.OffscreenCanvas = class {
      constructor(w, h) {
        if (offscreen === 'throws') throw new Error('no offscreen canvas here');
        this.width = w;
        this.height = h;
        made.push('offscreen');
      }
      getContext() { return offscreen === 'no-2d' ? null : fakeCtx(); }
      async convertToBlob({ type } = {}) {
        if (!encodes.includes(type)) throw new Error(`cannot write ${type}`);
        return new Blob([new Uint8Array(8)], { type });
      }
    };
  } else {
    delete globalThis.OffscreenCanvas;
  }

  if (element) {
    globalThis.document = {
      createElement: () => {
        made.push('element');
        return {
          width: 0,
          height: 0,
          getContext: () => fakeCtx(),
          toBlob(cb, type) {
            cb(new Blob([new Uint8Array(8)], { type: encodes.includes(type) ? type : 'image/png' }));
          },
        };
      },
    };
  } else {
    delete globalThis.document;
  }

  return {
    made,
    restore() {
      for (const [name, desc] of saved) {
        if (desc) Object.defineProperty(globalThis, name, desc);
        else delete globalThis[name];
      }
    },
  };
}

test('an OffscreenCanvas that gives no 2D context falls through to an element', () => {
  // The regression. Firefox on Android: the constructor works and the context
  // does not, and the old shape stopped there and answered null - which every
  // caller reads as "leave it alone", so the app derived no pictures at all.
  const eng = engine({ offscreen: 'no-2d' });
  try {
    const face = surface(64, 64);
    assert.ok(face, 'no surface on an engine that has a perfectly good <canvas>');
    assert.deepEqual(eng.made, ['offscreen', 'element'], 'the element was never tried');
  } finally {
    eng.restore();
  }
});

test('an OffscreenCanvas that works is the one used', () => {
  const eng = engine({ offscreen: 'works' });
  try {
    assert.ok(surface(64, 64));
    assert.deepEqual(eng.made, ['offscreen'], 'an element was made when it was not needed');
  } finally {
    eng.restore();
  }
});

test('a constructor that throws falls through as it always did', () => {
  const eng = engine({ offscreen: 'throws' });
  try {
    assert.ok(surface(64, 64));
    assert.deepEqual(eng.made, ['element']);
  } finally {
    eng.restore();
  }
});

test('no OffscreenCanvas at all is the element path', () => {
  const eng = engine({ offscreen: 'none' });
  try {
    assert.ok(surface(64, 64));
    assert.deepEqual(eng.made, ['element']);
  } finally {
    eng.restore();
  }
});

test('with neither there is no surface, and that is a null rather than a throw', () => {
  // Which is this module in a Node test, and is what keeps it importable by
  // tests/imports.test.js like every other module.
  const eng = engine({ offscreen: 'none', element: false });
  try {
    assert.equal(surface(64, 64), null);
  } finally {
    eng.restore();
  }
});

test('the size asked for is the size the element gets', () => {
  const eng = engine({ offscreen: 'none' });
  try {
    const face = surface(320, 240);
    assert.equal(face.canvas.width, 320);
    assert.equal(face.canvas.height, 240);
  } finally {
    eng.restore();
  }
});

test('smoothing is set on whichever surface came back', () => {
  for (const offscreen of ['works', 'no-2d', 'none']) {
    const eng = engine({ offscreen });
    try {
      const face = surface(8, 8);
      assert.equal(face.ctx.imageSmoothingEnabled, true, offscreen);
      assert.equal(face.ctx.imageSmoothingQuality, 'high', offscreen);
    } finally {
      eng.restore();
    }
  }
});

// ---------------------------------------------------------------------------
// Getting the bytes back out
// ---------------------------------------------------------------------------

test('a type the engine cannot write comes back as PNG rather than as nothing', async () => {
  // convertToBlob rejects an unsupported type where toBlob silently substitutes,
  // and a caller written against the second loses the picture on the first. No
  // version of Safari writes WebP from a canvas; this is that engine.
  const eng = engine({ offscreen: 'works', encodes: ['image/png', 'image/jpeg'] });
  try {
    const out = await surfaceToBlob(surface(8, 8), 'image/webp', 0.8);
    assert.ok(out, 'the frame was decoded and then thrown away');
    assert.equal(out.type, 'image/png');
  } finally {
    eng.restore();
  }
});

test('the element path substitutes for itself, and the type says which', async () => {
  const eng = engine({ offscreen: 'none', encodes: ['image/png'] });
  try {
    const out = await surfaceToBlob(surface(8, 8), 'image/webp', 0.8);
    assert.equal(out.type, 'image/png', 'the caller cannot tell what it got');
  } finally {
    eng.restore();
  }
});

test('a canvas with neither method answers null instead of throwing', async () => {
  // The same half-an-engine as the first test, one method further on: calling
  // the method the other kind of canvas has is a TypeError out of a promise
  // nobody expected to reject.
  const out = await surfaceToBlob({ canvas: { width: 8, height: 8 }, ctx: fakeCtx() }, 'image/webp', 0.8);
  assert.equal(out, null);
});
