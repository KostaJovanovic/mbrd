// The zoom fade on the paper grain.
//
// The band exists because a grain that scales with the board runs out of room
// on the way out: by 30% the tile is 154px and a fleck is a third of a pixel,
// so the texture stops being texture and becomes a flat grey film over the
// whole sheet - the mean darkening with none of the detail that paid for it.
// See canvas/grain.js.
//
// Worth a test rather than a look, because the failure is quiet. Both ends of
// the band are correct-looking on their own: at 1.0 the grain is right, and at
// 0.05 it is gone either way. What breaks is the middle, and a board only
// passes through it while somebody is pinching.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { FADE_FULL, FADE_GONE, fadeFor } from '../web/assets/js/canvas/grain.js';

test('the band is a fade out, not a fade in', () => {
  assert.ok(FADE_GONE < FADE_FULL, 'gone must be the lower zoom of the two');
});

test('full strength at and above the top of the band', () => {
  assert.equal(fadeFor(FADE_FULL), 1);
  assert.equal(fadeFor(0.5), 1);
  assert.equal(fadeFor(1), 1);
  assert.equal(fadeFor(8), 1);
});

test('gone at and below the bottom of the band', () => {
  assert.equal(fadeFor(FADE_GONE), 0);
  assert.equal(fadeFor(0.2), 0);
  assert.equal(fadeFor(0.01), 0);
});

test('the middle of the band is half', () => {
  // Within a rounding, not exactly: the midpoint of two decimal fractions is
  // not representable, and grain.js writes the result at three places anyway.
  assert.ok(Math.abs(fadeFor((FADE_FULL + FADE_GONE) / 2) - 0.5) < 1e-9);
});

test('a quarter of the way up the band is a quarter of the strength', () => {
  const at = FADE_GONE + (FADE_FULL - FADE_GONE) * 0.25;
  assert.ok(Math.abs(fadeFor(at) - 0.25) < 1e-9, `got ${fadeFor(at)}`);
});

test('it never leaves 0..1, and never doubles back', () => {
  // Monotonic matters as much as the endpoints: a fade that rose anywhere on
  // the way out would read as the grain flickering back during a pinch.
  let prev = -1;
  for (let z = 0.01; z <= 2; z += 0.005) {
    const f = fadeFor(z);
    assert.ok(f >= 0 && f <= 1, `fadeFor(${z}) = ${f} is outside 0..1`);
    assert.ok(f >= prev, `fadeFor is not monotonic at ${z}`);
    prev = f;
  }
});

test('a nonsense zoom does not produce a nonsense opacity', () => {
  // paintGrain guards tile > 0 before it gets here, but the arithmetic should
  // not be the thing that decides whether that guard was enough.
  assert.equal(fadeFor(0), 0);
  assert.equal(fadeFor(-1), 0);
});
