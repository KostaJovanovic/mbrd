// The drawing surface, on an engine that has half of one. canvas/surface.ts
// is the single door to every picture this app derives, so a fault here is
// never one missing picture - it's all of them, silently, since every
// caller treats "no surface" as "leave the original alone". This file
// guards the second kind of absence: the module used to fall back to an
// element only when `new OffscreenCanvas()` *threw*, missing the case where
// the constructor works but `getContext('2d')` answers null. No engine has
// been confirmed to do that; kept because the gap is real and cheap to close.
// Every stub is deliberately uncooperative - a stub that answers everything
// is exactly why none of this was caught.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { surface, surfaceToBlob, surfaceToPicture, canvasReads } from '../web/assets/js/canvas/surface.ts';

/**
 * A 2D context with the members the Surface type names, and nothing else.
 * `reads` is what getImageData does: 'blank' is fingerprinting protection
 * answering with nothing, 'noise' perturbs the low bits, 'throws' is a
 * tainted canvas, 'true' is a browser behaving.
 */
const fakeCtx = (reads = 'blank') => {
  let fill = '#000000';
  return {
    drawImage() {},
    fillRect() {},
    imageSmoothingEnabled: false,
    imageSmoothingQuality: '',
    set fillStyle(v) { fill = v; },
    get fillStyle() { return fill; },
    getImageData: (_x, _y, w, h) => {
      if (reads === 'throws') throw new Error('the canvas is tainted');
      const data = new Uint8ClampedArray(w * h * 4);
      if (reads === 'true' || reads === 'noise') {
        const nudge = reads === 'noise' ? 3 : 0;
        for (let i = 0; i < data.length; i += 4) {
          data[i] = 0x3b + nudge;
          data[i + 1] = 0x7d - nudge;
          data[i + 2] = 0xd8 + nudge;
          data[i + 3] = 255;
        }
      }
      return { data };
    },
  };
};

/**
 * Install an engine for the length of one call. `offscreen`: 'none' has no
 * global, 'throws' refuses to build it, 'no-2d' is Firefox on Android,
 * 'works' is everything else. `element` is whether a document exists to
 * make a `<canvas>` in.
 */
function engine({
  offscreen = 'works', element = true, encodes = ['image/png'], reads = 'blank',
} = {}) {
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
      getContext() { return offscreen === 'no-2d' ? null : fakeCtx(reads); }
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
          getContext: () => fakeCtx(reads),
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
  // The regression: Firefox on Android's constructor works but the context
  // does not, and the old code stopped there and answered null - every
  // caller reads that as "leave it alone", so the app derived no pictures at all.
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
  // This is this module in a Node test - keeps it importable by
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
  // convertToBlob rejects an unsupported type where toBlob silently
  // substitutes; a caller written for the second loses the picture on the
  // first. No version of Safari writes WebP from a canvas - this is that engine.
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

test('surfaceToPicture: WebP where the engine writes it', async () => {
  const eng = engine({ offscreen: 'works', encodes: ['image/png', 'image/webp', 'image/jpeg'] });
  try {
    assert.equal((await surfaceToPicture(surface(8, 8), 0.8)).type, 'image/webp');
  } finally {
    eng.restore();
  }
});

test('surfaceToPicture: JPEG on Safari, and the PNG kept when alpha must survive', async () => {
  // The posters, slides and display copies would rather have a JPEG than a
  // forty-megabyte PNG; a cut-out would rather have the PNG than black corners.
  for (const offscreen of ['works', 'none']) {
    const eng = engine({ offscreen, encodes: ['image/png', 'image/jpeg'] });
    try {
      assert.equal((await surfaceToPicture(surface(8, 8), 0.8)).type, 'image/jpeg', offscreen);
      assert.equal((await surfaceToPicture(surface(8, 8), 0.8, { jpeg: false })).type, 'image/png', offscreen);
    } finally {
      eng.restore();
    }
  }
});

test('surfaceToPicture: no JPEG encoder either is still a picture, not nothing', async () => {
  const eng = engine({ offscreen: 'works', encodes: ['image/png'] });
  try {
    assert.equal((await surfaceToPicture(surface(8, 8), 0.8)).type, 'image/png');
  } finally {
    eng.restore();
  }
});

test('a canvas with neither method answers null instead of throwing', async () => {
  // The same half-an-engine one method further on: calling the method the
  // other kind of canvas has is a TypeError out of a promise nobody expected
  // to reject.
  const out = await surfaceToBlob({ canvas: { width: 8, height: 8 }, ctx: fakeCtx() }, 'image/webp', 0.8);
  assert.equal(out, null);
});

// ---------------------------------------------------------------------------
// Whether the pixels come back
// ---------------------------------------------------------------------------
//
// Firefox's fingerprinting protection and Safari's Lockdown Mode answer a
// canvas read with blank or randomised data, not an error - nothing throws
// or logs, so a poster's flat-frame check would discard every frame and the
// palette would find no colour anywhere. canvasReads() stands in for that
// check; see its docstring for why it's never actually been seen to fire.
// It remembers a yes and re-asks after a no (Firefox prompts mid-session),
// so test order does not matter *except* the yes must come last.

test('a browser that hands back blank pixels is not readable', () => {
  const eng = engine({ reads: 'blank' });
  try {
    assert.equal(canvasReads(), false);
  } finally {
    eng.restore();
  }
});

test('a canvas that throws on the read is not readable either', () => {
  const eng = engine({ reads: 'throws' });
  try {
    assert.equal(canvasReads(), false);
  } finally {
    eng.restore();
  }
});

test('no canvas at all reads as not readable rather than throwing', () => {
  const eng = engine({ offscreen: 'none', element: false });
  try {
    assert.equal(canvasReads(), false);
  } finally {
    eng.restore();
  }
});

test('the randomising form of the protection is not treated as blocking', () => {
  // It perturbs a few least-significant bits, harmless to a flat-frame check
  // or a palette. Reading it as "blocked" would refuse a browser that works.
  const eng = engine({ reads: 'noise' });
  try {
    assert.equal(canvasReads(), true);
  } finally {
    eng.restore();
  }
});

test('a yes is remembered, so the loops that ask do not pay for it', () => {
  // Last on purpose: asserts the yes above *stays* settled once the engine is gone.
  const eng = engine({ offscreen: 'none', element: false });
  try {
    assert.equal(canvasReads(), true, 'a browser that reads once was asked again');
  } finally {
    eng.restore();
  }
});
