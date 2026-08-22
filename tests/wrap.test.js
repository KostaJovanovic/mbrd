// The positive remainder the two tiled background layers offset themselves by.
//
// Worth a test of its own because of what it is standing in front of. #grain
// and #grid-ink are painted by moving a repeating background under a fixed
// element, and the offset they move it by is the world origin in screen
// coordinates - a number that grows without bound, because the board does.
// `background-position` does not: the browser resolves it to a fixed-point
// number that runs out a little past 33 million CSS px, and past that the eight
// gradient layers of the grid each lose a different amount and the lattice
// comes apart into unevenly spaced dots. That was a real bug report, found by
// panning far enough to the right that the arithmetic gave up.
//
// The fix is that a tiled background is *periodic*, so the offset can be
// reduced into one tile before it is written and the picture is unchanged. That
// makes the two properties below the whole contract, and neither is obvious
// from reading the one-liner:
//
//   the result is inside [0, tile)        - so the number written is small
//   the result is congruent to the input  - so it is the same lattice
//
// A plain `%` has the first property for positive inputs only, which is exactly
// the half the board does not spend its time in: pan right and the origin's
// screen x goes negative.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { wrap } from '../web/assets/js/util.ts';
import { MIN_PX, MAX_PX, MAJOR } from '../web/assets/js/canvas/grid.ts';

/** The tile sizes the grid can actually ask for, minor and major, at the ends. */
const TILES = [MIN_PX, MAX_PX, MIN_PX * MAJOR, MAX_PX * MAJOR, 512];

test('a negative offset comes back positive', () => {
  // The case the bare operator gets wrong, and the one the board is in whenever
  // it has been panned right or down.
  assert.equal(-3 % 512, -3);
  assert.equal(wrap(-3, 512), 509);
});

test('an offset already inside the tile is left alone', () => {
  assert.equal(wrap(0, 40), 0);
  assert.equal(wrap(13.5, 40), 13.5);
  assert.equal(wrap(39.9, 40), 39.9);
});

test('a whole number of tiles lands back on zero, at either sign', () => {
  assert.equal(wrap(40 * 7, 40), 0);
  assert.equal(wrap(-40 * 7, 40), 0);
});

test('the result is inside the tile for every tile the grid uses', () => {
  // Both signs and both magnitudes - the offsets a board actually produces
  // sweep continuously from a few pixels to whatever the pan has reached.
  for (const tile of TILES) {
    for (const n of [0, 1, -1, 0.5, -0.5, 1e3, -1e3, 1e6, -1e6, 9e9, -9e9]) {
      const got = wrap(n, tile);
      assert.ok(got >= 0 && got < tile,
        `wrap(${n}, ${tile}) = ${got} is outside [0, ${tile})`);
    }
  }
});

test('the result is the same lattice - it differs from the input by whole tiles', () => {
  // The property that makes this a rewrite rather than a fudge. If it failed,
  // the grid would be in the right place only by accident.
  for (const tile of TILES) {
    for (const n of [7.25, -7.25, 1234.5, -1234.5, 1e6 + 0.5, -(1e6 + 0.5)]) {
      const steps = (wrap(n, tile) - n) / tile;
      assert.equal(steps, Math.round(steps),
        `wrap(${n}, ${tile}) moved by ${steps} tiles, which is not a whole number`);
    }
  }
});

test('far out, where the bug was, it is still exact', () => {
  // Nine billion pixels right of the origin: the distance the report was made
  // at. 9e9 and the offsets below are all exactly representable in a double and
  // 9e9 is a whole number of 40px tiles, so these are exact answers rather than
  // near ones - the arithmetic here never was the problem, which is the point.
  assert.equal(wrap(-9e9, 40), 0);
  assert.equal(wrap(-9e9 + 13.5, 40), 13.5);
  assert.equal(wrap(9e9 - 13.5, 40), 26.5);
});

test('half a tile past the origin stays half a tile past it, however far out', () => {
  // What between() in grid.js leans on: it places the three extra marks of a
  // finer lattice at +size/2, and wrapping must not disturb that relationship
  // or the fading lattice would arrive in the wrong place.
  for (const tile of TILES) {
    const near = wrap(3 + tile / 2, tile) - wrap(3, tile);
    const far = wrap(-9e9 + 3 + tile / 2, tile) - wrap(-9e9 + 3, tile);
    assert.equal(near, tile / 2);
    assert.equal(far, tile / 2, `the offset drifted to ${far} at nine billion px`);
  }
});
