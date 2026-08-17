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

import { surface, surfaceToBlob, canvasReads, canvasReport } from '../web/assets/js/canvas/surface.ts';

/**
 * A 2D context with the members the Surface type names, and nothing else.
 *
 * `reads` is what getImageData does with what was drawn: 'blank' is the
 * fingerprinting protection that answers with nothing, 'noise' is the form that
 * perturbs the low bits, 'throws' is a tainted canvas, and 'true' is a browser
 * behaving. Nothing here is cooperative by default - a stub that always handed
 * back the fill colour would agree with any implementation at all.
 */
const fakeCtx = (reads = 'blank', paints = false) => {
  let fill = '#000000';
  // Only when `paints` - the default engine here draws nothing, which is the
  // whole point of the stubs in this file. A painting engine is needed for one
  // question and one only: whether canvasReport() can tell a canvas that draws
  // from one that does not, which cannot be asked of a canvas that never draws.
  const painted = new Map();
  const colourOf = (v) => {
    const hex = /^#([\da-f]{2})([\da-f]{2})([\da-f]{2})$/i.exec(v);
    if (hex) return [1, 2, 3].map(i => Number.parseInt(hex[i], 16));
    const rgb = /(\d+)\D+(\d+)\D+(\d+)/.exec(v);
    return rgb ? [1, 2, 3].map(i => Number(rgb[i])) : [0, 0, 0];
  };
  return {
    drawImage() {},
    fillRect(x, y, w, h) {
      if (!paints) return;
      const c = colourOf(fill);
      for (let py = y; py < y + h; py++) for (let px = x; px < x + w; px++) painted.set(`${px},${py}`, c);
    },
    imageSmoothingEnabled: false,
    imageSmoothingQuality: '',
    set fillStyle(v) { fill = v; },
    get fillStyle() { return fill; },
    getImageData: (x, y, w, h) => {
      if (reads === 'throws') throw new Error('the canvas is tainted');
      const data = new Uint8ClampedArray(w * h * 4);
      if (paints) {
        for (let py = 0; py < h; py++) {
          for (let px = 0; px < w; px++) {
            const c = painted.get(`${x + px},${y + py}`);
            const i = (py * w + px) * 4;
            if (c) [data[i], data[i + 1], data[i + 2]] = c;
            data[i + 3] = 255;
          }
        }
        return { data };
      }
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
 * Install an engine for the length of one call.
 *
 * `offscreen` is what `new OffscreenCanvas()` does - 'none' for an engine
 * without the global, 'throws' for one that refuses to build it, 'no-2d' for
 * Firefox on Android, and 'works' for everything else. `element` is whether
 * there is a document to make a `<canvas>` in.
 */
function engine({
  offscreen = 'works', element = true, encodes = ['image/png'], reads = 'blank', paints = false,
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
      getContext() { return offscreen === 'no-2d' ? null : fakeCtx(reads, paints); }
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
          getContext: () => fakeCtx(reads, paints),
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

// ---------------------------------------------------------------------------
// The readout
// ---------------------------------------------------------------------------
//
// canvasReport() is the answer to the question this whole file is about being
// unanswerable from a board: a card with no picture on it looks the same
// whether the canvas would not draw, would not be read, would not encode, or
// handed back bytes an <img> refused. These check that each of those four comes
// back as itself.
//
// Before the canvasReads() block below on purpose - the yes there is remembered
// for the rest of the file, and a report that says `reads: true` on a blocked
// engine would check nothing.

test('the report says which canvas came back', async () => {
  const eng = engine({ offscreen: 'works', encodes: ['image/webp', 'image/png'] });
  try {
    const r = await canvasReport();
    assert.equal(r.offscreen, 'ok');
    assert.equal(r.using, 'offscreen');
    assert.deepEqual(r.writes, ['webp', 'png'], 'a type the engine refuses was reported as written');
  } finally {
    eng.restore();
  }
});

test('a broken OffscreenCanvas is named, and so is the canvas that stood in for it', async () => {
  // The engine the module exists for, read back off the phone it happened on.
  const eng = engine({ offscreen: 'no-2d' });
  try {
    const r = await canvasReport();
    assert.equal(r.offscreen, 'no-2d');
    assert.equal(r.element, 'ok');
    assert.equal(r.using, 'element');
  } finally {
    eng.restore();
  }
});

test('an engine with no canvas at all reports nothing rather than throwing', async () => {
  const eng = engine({ offscreen: 'none', element: false });
  try {
    const r = await canvasReport();
    assert.equal(r.offscreen, 'none');
    assert.equal(r.element, 'none');
    assert.equal(r.using, 'none');
    assert.deepEqual(r.writes, []);
  } finally {
    eng.restore();
  }
});

test('a blocked read is unreadable rather than a failure to draw', async () => {
  // The distinction the readout is for. A browser blocking canvas reads has
  // said nothing whatever about whether it draws, and reporting that as "draws
  // no" sends the next person to look at the decoder.
  const eng = engine({ reads: 'blank' });
  try {
    const r = await canvasReport();
    assert.equal(r.reads, false);
    assert.equal(r.draws, 'unreadable');
    assert.equal(r.roundTrip, 'unreadable');
  } finally {
    eng.restore();
  }
});

test('a canvas that will not encode reports nothing written', async () => {
  // An OffscreenCanvas that rejects every type, including the PNG retry - the
  // element path cannot be this engine, because toBlob substitutes rather than
  // refusing, and a substituted PNG is a picture that came out.
  const eng = engine({ offscreen: 'works', encodes: [] });
  try {
    const r = await canvasReport();
    assert.deepEqual(r.writes, [], 'a type that was never written was reported as written');
    assert.equal(r.mounts, false, 'bytes that do not exist were mounted');
  } finally {
    eng.restore();
  }
});

// ---------------------------------------------------------------------------
// Whether the pixels come back
// ---------------------------------------------------------------------------
//
// The failure that reached a person before it reached a test. Firefox's
// fingerprinting protection - on by default in the strict mode that is its
// default on Android - answers a canvas read with blank data rather than with
// an error, so a poster's flat-frame check discarded every frame of every clip,
// the palette taken from the board's own pictures found none of them, and a
// rendered PDF page would not come back out of the canvas. Nothing threw and
// nothing was logged.
//
// canvasReads() remembers a yes and re-asks after a no - Firefox prompts, and
// somebody who allows it mid-session should not have to reload - so the order
// of these tests does not matter *except* that the yes must come last.

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
  // It perturbs a few least-significant bits, which is harmless to a flat-frame
  // check and to a palette. Reading it as "blocked" would turn a browser that
  // works into one this app refuses to derive anything on.
  const eng = engine({ reads: 'noise' });
  try {
    assert.equal(canvasReads(), true);
  } finally {
    eng.restore();
  }
});

test('a yes is remembered, so the loops that ask do not pay for it', () => {
  // Last on purpose: the yes above has already settled it, and this is the
  // assertion that it *stays* settled once the engine is gone.
  const eng = engine({ offscreen: 'none', element: false });
  try {
    assert.equal(canvasReads(), true, 'a browser that reads once was asked again');
  } finally {
    eng.restore();
  }
});

test('a canvas that really draws is reported as drawing', async () => {
  // The one cooperative engine in this file, and it is here rather than higher
  // up for the same reason the remembered yes is: it has to run after the read
  // has been settled, or the report answers 'unreadable' and checks nothing.
  //
  // It is also the only test of the report's *positive* half. The two colours
  // canvasReport() paints are the point of painting two: a stub returning one
  // constant colour - which is what a blocked read looks like, and what every
  // other engine in this file does - passes a one-colour check and fails this.
  const eng = engine({ offscreen: 'works', encodes: ['image/webp'], reads: 'true', paints: true });
  try {
    const r = await canvasReport();
    assert.equal(r.reads, true);
    assert.equal(r.draws, 'yes', 'a canvas that put both colours down was reported as blank');
    assert.deepEqual(r.writes, ['webp']);
  } finally {
    eng.restore();
  }
});
