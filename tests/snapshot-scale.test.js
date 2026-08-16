// The size an exported board is allowed to be, and the ceiling nobody sees.
//
// iOS Safari refuses any canvas past 16,777,216 pixels, and refuses it in the
// worst available way: no throw, no warning, transparent output from then on.
// MAX_EDGE alone permits 8000 x 8000, which is 64 megapixels - four times that
// - so Export as PNG and Export as PDF came back blank on a phone for any board
// large enough to reach the cap. ui/snapshot.ts had the number written down in
// a comment and applied it to the board *thumbnail* only.
//
// The arithmetic is the whole fix, so the arithmetic is what is tested here.
// renderBoardCanvas() needs a board, a document and forty painters; exportScale()
// needs three numbers, which is why it was pulled out.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { exportScale } from '../web/assets/js/ui/snapshot.ts';

/** What WebKit will draw. Not read from the module - a copy of the limit that
 *  moved with it would stop testing the limit. */
const IOS_CEILING = 16777216;

/**
 * The pixels a board of this size comes out as, both sides rounded up as the
 * renderer rounds them.
 *
 * `areaCap` is the fourth argument because the cap is not universal: an engine
 * that draws whatever it is handed - which is every engine but WebKit - gets
 * Infinity and the edge cap decides alone. renderBoardCanvas() picks between
 * the two by probing an oversized canvas, and only for a board big enough for
 * the answer to matter; what is tested here is the arithmetic on both sides of
 * that choice.
 */
const output = (w, h, maxEdge, areaCap) => {
  const scale = exportScale(w, h, maxEdge, areaCap);
  return { w: Math.max(1, Math.ceil(w * scale)), h: Math.max(1, Math.ceil(h * scale)) };
};

/** The cap the module applies where an engine needs it. */
const CAP = 16_000_000;

test('a board smaller than both ceilings is drawn at 1:1', () => {
  assert.equal(exportScale(1200, 800), 1, 'nothing is ever enlarged, and a small board is untouched');
  const out = output(1200, 800);
  assert.deepEqual(out, { w: 1200, h: 800 });
});

test('a long thin board is still held to the edge cap', () => {
  // 20000 x 500 is only 10 megapixels - inside the area ceiling - so the edge
  // cap is what has to catch it, and it is why there are two ceilings and not
  // one. A 20000px-wide PNG is a picture nobody wants to be handed.
  const out = output(20000, 500);
  assert.ok(Math.max(out.w, out.h) <= 8000, `long edge ${out.w} must be inside MAX_EDGE`);
});

test('a big square board is held to the area ceiling where the engine needs it', () => {
  // The case that was blank on iOS: 6000 x 5000 world units cleared the edge cap
  // at 8000 x 6667 and came to 53 megapixels.
  const out = output(6000, 5000, undefined, CAP);
  assert.ok(out.w * out.h <= IOS_CEILING,
    `${out.w}x${out.h} = ${out.w * out.h} px must be inside the ${IOS_CEILING} ceiling`);
  assert.ok(Math.max(out.w, out.h) < 8000, 'and the area cap, not the edge cap, is what bound it');
});

test('an engine with no area limit is not capped at all', () => {
  // The other half, and the reason the cap is a parameter rather than a
  // constant: everything but WebKit draws whatever it is handed, and a desktop
  // export of a big board should be the full-size picture it always was. The
  // edge cap still applies - that one is about what a person wants to be handed
  // rather than what the engine can hold.
  // 6000 x 5000 is inside the edge cap, so it is drawn at 1:1 - nothing is ever
  // enlarged to meet a ceiling. 30 megapixels, comfortably past what WebKit
  // would have taken, which is the point.
  const asIs = output(6000, 5000, undefined, Infinity);
  assert.deepEqual(asIs, { w: 6000, h: 5000 }, 'a board inside the edge cap is untouched');
  assert.ok(asIs.w * asIs.h > IOS_CEILING, 'and is deliberately past what WebKit would draw');

  // Past the edge cap, that one still binds - it is about what a person wants
  // to be handed rather than what the engine can hold.
  const huge = output(12000, 10000, undefined, Infinity);
  assert.equal(Math.max(huge.w, huge.h), 8000, 'the edge cap alone decides');
  assert.ok(huge.w * huge.h > IOS_CEILING, 'and 8000 x 6667 is 53 MP, uncapped');
});

test('the ceiling holds at every shape and size a board can be', () => {
  // Including the shapes the rounding is worst for: the two sides are each
  // rounded *up* after the scale is applied, so a budget set at exactly the
  // engine's limit lands over it. The headroom in the cap is what this proves.
  for (const w of [500, 1000, 4096, 6000, 8000, 30000, 120000]) {
    for (const h of [500, 1000, 4096, 6000, 8000, 30000, 120000]) {
      const out = output(w, h, undefined, CAP);
      assert.ok(out.w * out.h <= IOS_CEILING,
        `${w}x${h} world -> ${out.w}x${out.h} = ${out.w * out.h} px, past the ceiling`);
      assert.ok(Math.max(out.w, out.h) <= 8000, `${w}x${h} world -> long edge ${Math.max(out.w, out.h)}`);
    }
  }
});

test('the thumbnail keeps its own tighter budget', () => {
  // boardThumb() passes max * 4 rather than relying on this - a different and
  // much smaller ceiling for a different reason, and it must not be loosened by
  // the area cap arriving beside it.
  // Checked on the uncapped side deliberately: the thumbnail must be small
  // because its caller said so, not because an engine happened to insist.
  const out = output(6000, 5000, 1440, Infinity);
  assert.ok(Math.max(out.w, out.h) <= 1440, `long edge ${Math.max(out.w, out.h)} must respect the caller's cap`);
});
