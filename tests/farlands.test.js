// Where the board's edge is, and that only a real crossing finds it.
//
// The card at the far edge is a joke, but the rule placing it runs on every
// view frame of every pan for the life of the session, and nobody will ever
// check it by looking: the board is eight million units wide and getting there
// by hand is the achievement the card acknowledges.
//
// So the arithmetic is tested and the picture is not. The DOM half of
// canvas/farlands.ts wants a document and is left to the browser; here is the
// half that decides. A threshold that is too eager puts the card on an ordinary
// board - the only failure anybody would see, and they would read it as a bug
// rather than a joke.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { FAR, distance, isFarOut, boxInView } from '../web/assets/js/canvas/farlands.ts';

test('the edge is the last magnitude a 32-bit float resolves to single units', () => {
  // Not a round number and not a taste - see the note on FAR. "Tidied" to
  // 8,000,000 or 10,000,000 the card stops meaning anything: below it nothing
  // has gone wrong yet, above it the marker suffers the drift it marks.
  assert.equal(FAR, 2 ** 23);
  assert.equal(FAR, 8388608);
});

test('an ordinary board never reaches it', () => {
  // The failure worth guarding. A board in use lives within a few thousand
  // units of the origin, and the card appearing there reads as a bug, not a
  // reward.
  for (const [x, y] of [[0, 0], [1, 1], [-1, -1], [1e3, 1e3], [-5e4, 2e4], [1e6, 1e6]]) {
    assert.equal(isFarOut(x, y), false, `${x},${y} should not be far out`);
  }
});

test('it is a distance from the origin, not a reading on either axis', () => {
  // Straight out along one axis counts...
  assert.equal(isFarOut(FAR, 0), true);
  assert.equal(isFarOut(0, -FAR), true);
  // ...and so does the same distance cornerways, which no per-axis comparison
  // catches: neither coordinate here is near FAR.
  const diag = FAR / Math.SQRT2 + 1;
  assert.ok(diag < FAR, 'the diagonal case must not pass on one axis alone');
  assert.equal(isFarOut(diag, diag), true);
});

test('the boundary itself is far enough, and a hair inside it is not', () => {
  assert.equal(isFarOut(FAR, 0), true);
  assert.equal(isFarOut(FAR - 1, 0), false);
});

test('every direction is treated the same', () => {
  // Signs are a place to be wrong and never notice: whoever reaches the edge
  // reaches it in one direction and reports that it worked.
  for (const sx of [1, -1]) {
    for (const sy of [1, -1]) {
      assert.equal(isFarOut(sx * FAR, 0), true);
      assert.equal(isFarOut(0, sy * FAR), true);
      assert.equal(isFarOut(sx * FAR, sy * FAR), true);
    }
  }
});

test('distance is the plain one', () => {
  assert.equal(distance(3, 4), 5);
  assert.equal(distance(0, 0), 0);
  assert.equal(distance(-3, -4), 5);
});

// ---------------------------------------------------------------------------
// Leaving the card behind
// ---------------------------------------------------------------------------
//
// The take-down rule - easy to get right on one axis and wrong everywhere else.
// Every one of these is a journey that does not run along x or y: travelling
// straight out is the case tried by hand, so the case that cannot break
// unnoticed.

/** A view of `w` x `h` world units centred on a pan point - visibleRect()'s shape. */
const view = (px, py, w = 1600, h = 900) =>
  ({ x0: px - w / 2, y0: py - h / 2, x1: px + w / 2, y1: py + h / 2 });

test('a card is on screen at the moment it is placed, wherever that is', () => {
  // It is put at the pan centre, so this is true by construction - and worth
  // pinning, because a take-down rule that fired on the placing frame would
  // mean the card never survived to be seen at all.
  for (const [x, y] of [[FAR, 0], [0, FAR], [-6e6, 6e6], [6e6, -6e6]]) {
    assert.equal(boxInView({ x, y }, view(x, y)), true, `placed at ${x},${y}`);
  }
});

test('panning away cornerways eventually leaves it behind', () => {
  const at = { x: 6e6, y: 6e6 };
  assert.equal(boxInView(at, view(6e6, 6e6)), true, 'still there to begin with');
  assert.equal(boxInView(at, view(6e6 + 5e4, 6e6 + 5e4)), false, 'gone once panned off');
});

test('a corner overlap still counts as on screen', () => {
  // The case a centre-distance test gets wrong. The card is diagonally offset
  // by nearly the whole half-span of both boxes, so its centre is far outside
  // the view - but one corner of it is inside, and a corner is visible.
  const at = { x: 0, y: 0 };
  const r = view(1600 / 2 + 420 / 2 - 1, 900 / 2 + 240 / 2 - 1);
  assert.equal(boxInView(at, r), true, 'a visible corner is visible');
});

test('clearing one axis is enough to be gone, even when the other still overlaps', () => {
  // Boxes do not overlap unless they overlap on *both* axes. Pan straight up
  // far enough and the card is gone regardless of x lining up perfectly.
  const at = { x: 0, y: 0 };
  assert.equal(boxInView(at, view(0, 900 / 2 + 240 / 2 + 1)), false);
  assert.equal(boxInView(at, view(1600 / 2 + 420 / 2 + 1, 0)), false);
});

test('the vertical sense is not flipped', () => {
  // The card is positioned in CSS at top = -y - h/2, and world y runs the other
  // way from CSS y. That flip lives in build(); this test is here so that
  // "fixing" it by flipping the comparison too would fail loudly. Panning up
  // and panning down by the same amount must behave identically.
  const at = { x: 0, y: 0 };
  const up = view(0, 4e5), down = view(0, -4e5);
  assert.equal(boxInView(at, up), boxInView(at, down));
  assert.equal(boxInView(at, up), false);
});
