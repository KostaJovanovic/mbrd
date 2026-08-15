// Where an item is, and what it covers.
//
// These had been four separate implementations in four modules that could not
// see each other, and they disagreed about rotation. The tests that matter
// most here are the rotated ones - not because anything rotates today, but
// because that is precisely why the disagreement survived so long unnoticed.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  rotatedExtents, itemBounds, itemInRect, itemWithinRect, itemRadius, pointInItem, topEdge,
  corners, overlapFraction, segmentMeetsRect, viewShift,
} from '../web/assets/js/geometry.ts';
import { item } from './helpers.js';

const near = (a, b, eps = 1e-9) => Math.abs(a - b) <= eps;
const close = (a, b, msg) => assert.ok(near(a, b, 1e-6), `${msg}: ${a} vs ${b}`);

// ---------------------------------------------------------------------------
// Extents
// ---------------------------------------------------------------------------

test('an unrotated item has its own half-extents', () => {
  const { hw, hh } = rotatedExtents(item({ w: 100, h: 40 }));
  assert.equal(hw, 50);
  assert.equal(hh, 20);
});

test('a square turned 45 degrees grows to its diagonal', () => {
  const { hw, hh } = rotatedExtents(item({ w: 100, h: 100, rot: 45 }));
  close(hw, Math.sqrt(2) * 50, 'half-width');
  close(hh, Math.sqrt(2) * 50, 'half-height');
});

test('a quarter turn swaps the extents', () => {
  const { hw, hh } = rotatedExtents(item({ w: 100, h: 40, rot: 90 }));
  close(hw, 20, 'half-width');
  close(hh, 50, 'half-height');
});

test('rotation is symmetric about zero', () => {
  const a = rotatedExtents(item({ w: 80, h: 30, rot: 37 }));
  const b = rotatedExtents(item({ w: 80, h: 30, rot: -37 }));
  close(a.hw, b.hw, 'half-width');
  close(a.hh, b.hh, 'half-height');
});

test('the circumscribed radius covers every rotation', () => {
  const it = item({ w: 100, h: 40 });
  const r = itemRadius(it);
  for (let rot = 0; rot < 360; rot += 15) {
    const { hw, hh } = rotatedExtents({ ...it, rot });
    assert.ok(hw <= r + 1e-9 && hh <= r + 1e-9, `radius too small at ${rot} degrees`);
  }
});

// ---------------------------------------------------------------------------
// Bounds
// ---------------------------------------------------------------------------

test('no items have no bounds', () => {
  assert.equal(itemBounds([]), null);
});

test('bounds cover every item', () => {
  const box = itemBounds([
    item({ x: 0, y: 0, w: 100, h: 100 }),
    item({ x: 300, y: -200, w: 50, h: 50 }),
  ]);
  assert.deepEqual(box, { x0: -50, y0: -225, x1: 325, y1: 50 });
});

test('bounds account for rotation', () => {
  const straight = itemBounds([item({ w: 100, h: 100 })]);
  const turned = itemBounds([item({ w: 100, h: 100, rot: 45 })]);
  assert.ok(turned.x1 > straight.x1, 'a turned square must need more room');
  close(turned.x1, Math.sqrt(2) * 50, 'right edge');
});

test('a single item is its own bounds', () => {
  const box = itemBounds([item({ x: 10, y: 20, w: 40, h: 60 })]);
  assert.deepEqual(box, { x0: -10, y0: -10, x1: 30, y1: 50 });
});

// ---------------------------------------------------------------------------
// Marquee
// ---------------------------------------------------------------------------

test('an item inside the band is caught', () => {
  assert.ok(itemInRect(item({ x: 0, y: 0, w: 10, h: 10 }), -50, -50, 50, 50));
});

test('an item well outside the band is not', () => {
  assert.ok(!itemInRect(item({ x: 500, y: 0, w: 10, h: 10 }), -50, -50, 50, 50));
});

test('touching the band counts as caught', () => {
  // Edge-inclusive: dragging a marquee exactly to an item's edge should take
  // it, which is the forgiving half of a rough gesture.
  assert.ok(itemInRect(item({ x: 55, y: 0, w: 10, h: 10 }), -50, -50, 50, 50));
});

test('the marquee sees a rotated corner that the unrotated box would miss', () => {
  // The regression this consolidation exists to prevent. A square at (60, 0)
  // sized 100 has its left edge at 10 when straight; turned 45 degrees it
  // reaches out to 60 - 70.7 = -10.7. A band ending at 0 therefore touches the
  // turned one and not the straight one, and the old marquee tested the
  // straight extents whatever the item was actually doing.
  const straight = item({ x: 60, y: 0, w: 100, h: 100 });
  const turned = { ...straight, rot: 45 };
  assert.ok(!itemInRect(straight, -200, -5, -5, 5), 'straight square should miss');
  assert.ok(itemInRect(turned, -200, -5, -5, 5), 'turned square should be caught');
});

test('containment is the strict reading of the same band', () => {
  const it = item({ x: 0, y: 0, w: 10, h: 10 });
  assert.ok(itemWithinRect(it, -50, -50, 50, 50));
  // Overlapping is not enough, which is the whole difference between the two.
  const over = item({ x: 52, y: 0, w: 10, h: 10 });
  assert.ok(itemInRect(over, -50, -50, 50, 50));
  assert.ok(!itemWithinRect(over, -50, -50, 50, 50));
});

test('containment is edge-inclusive and rotation-aware', () => {
  // Exactly filling the band still counts, the same way touching it counts above.
  assert.ok(itemWithinRect(item({ x: 0, y: 0, w: 100, h: 100 }), -50, -50, 50, 50));
  // Turned, the same square needs the room its corners actually reach into.
  const turned = { ...item({ x: 0, y: 0, w: 100, h: 100 }), rot: 45 };
  assert.ok(!itemWithinRect(turned, -50, -50, 50, 50));
  assert.ok(itemWithinRect(turned, -71, -71, 71, 71));
});

// ---------------------------------------------------------------------------
// Point in item
// ---------------------------------------------------------------------------

test('the centre is inside', () => {
  assert.ok(pointInItem(0, 0, item({ w: 100, h: 100 })));
});

test('a point beyond the edge is outside', () => {
  assert.ok(!pointInItem(51, 0, item({ w: 100, h: 100 })));
});

test('the corner of a turned square is empty space', () => {
  // A square turned 45 degrees draws a diamond. Its bounding box corner is
  // half a diagonal out and contains nothing - the exact case an axis-aligned
  // test gets wrong, and the reason a note parked there must not claim to be
  // stuck to it.
  const diamond = item({ w: 100, h: 100, rot: 45 });
  assert.ok(!pointInItem(48, 48, diamond), 'bounding-box corner is not inside a diamond');
  assert.ok(pointInItem(0, 60, diamond), 'but the diamond does reach further up');
});

test('rotation does not change what is at the centre', () => {
  for (let rot = 0; rot < 360; rot += 30) {
    assert.ok(pointInItem(0, 0, item({ w: 80, h: 40, rot })), `failed at ${rot}`);
  }
});

test('a point is inside the turned box exactly when it is inside the straight one turned with it', () => {
  // Rotating the item and the probe together must give the same answer.
  const w = 120, h = 50, rot = 33;
  const rad = rot * Math.PI / 180;
  const c = Math.cos(rad), s = Math.sin(rad);
  for (const [px, py] of [[0, 0], [55, 0], [0, 20], [70, 30], [59, 24], [61, 26]]) {
    const straight = pointInItem(px, py, item({ w, h }));
    // The same offset, rotated into the turned item's frame.
    const turned = pointInItem(c * px - s * py, s * px + c * py, item({ w, h, rot }));
    assert.equal(turned, straight, `disagreed at (${px}, ${py})`);
  }
});

// ---------------------------------------------------------------------------
// Top edge
// ---------------------------------------------------------------------------

test('the top edge of an unrotated item is its top corners', () => {
  const [a, b] = topEdge(item({ x: 0, y: 0, w: 100, h: 40 }));
  assert.deepEqual([a.x, a.y], [-50, 20]);
  assert.deepEqual([b.x, b.y], [50, 20]);
});

test('the top edge stays the same length whatever the rotation', () => {
  for (const rot of [0, 17, 45, 90, 180, 270]) {
    const [a, b] = topEdge(item({ w: 100, h: 40, rot }));
    close(Math.hypot(b.x - a.x, b.y - a.y), 100, `length at ${rot} degrees`);
  }
});

// ---------------------------------------------------------------------------
// How much of one item lies over another
// ---------------------------------------------------------------------------
//
// This decides whether a sticky note is stuck, against a threshold of a
// twentieth - so what matters is that it is *exact*, including under rotation.
// A sampled or bounding-box answer would put the same note on either side of
// the line depending on how it happened to be turned.

test('the corners wind anticlockwise and sit where they should', () => {
  const c = corners(item({ x: 0, y: 0, w: 100, h: 40 }));
  assert.deepEqual(c.map(p => [p.x, p.y]),
    [[-50, -20], [50, -20], [50, 20], [-50, 20]]);
  // Shoelace is positive for an anticlockwise polygon, which the clipper relies
  // on to know which side of an edge is inside.
  let sum = 0;
  for (let i = 0, j = 3; i < 4; j = i++) sum += c[j].x * c[i].y - c[i].x * c[j].y;
  assert.ok(sum > 0, 'corners wound the wrong way');
});

test('an item lies entirely over a bigger one', () => {
  const small = item({ x: 0, y: 0, w: 50, h: 50 });
  const big = item({ x: 0, y: 0, w: 400, h: 400 });
  close(overlapFraction(small, big), 1, 'all of it');
  // And the other way round is the ratio of the areas, which is what makes this
  // a fraction *of the first argument* rather than a symmetric measure.
  close(overlapFraction(big, small), 2500 / 160000, 'a sixty-fourth of it');
});

test('two items that miss overlap by nothing', () => {
  const a = item({ x: 0, y: 0, w: 100, h: 100 });
  assert.equal(overlapFraction(a, item({ x: 500, y: 0, w: 100, h: 100 })), 0);
  // Edge to edge is zero area, not a sliver.
  close(overlapFraction(a, item({ x: 100, y: 0, w: 100, h: 100 })), 0, 'touching');
});

test('a partial overlap is measured, not guessed', () => {
  // x and y are the centre, so a 100-wide note at 0 spans -50 to 50 and a photo
  // at 70 spans 20 to 120. The right 30 of the note sits on it: 30 x 100.
  const note = item({ x: 0, y: 0, w: 100, h: 100 });
  const pic = item({ x: 70, y: 0, w: 100, h: 100 });
  close(overlapFraction(note, pic), 0.3, 'three tenths');
  // One corner: 30 across and 40 up, which is 0.12 and not 0.3 x 0.4 read as a
  // sum. Both the note and the photo are square, so a fraction of the note is
  // the product of the two spans over its own area.
  close(overlapFraction(note, item({ x: 70, y: 60, w: 100, h: 100 })), 0.12, 'a corner');
});

test('a square turned 45 degrees over another is exact, not its bounding box', () => {
  // The diamond's corner reaches sqrt(2)*50 = 70.7 along each axis while its
  // bounding box reaches the same - so a bounding-box answer would say these two
  // overlap far more than they do.
  const diamond = item({ x: 0, y: 0, w: 100, h: 100, rot: 45 });
  const square = item({ x: 100, y: 100, w: 100, h: 100 });
  // The diamond is every point with |x| + |y| <= 70.71. The square's nearest
  // corner is (50, 50), where that sum is 100. Nothing of one is inside the
  // other - while their bounding boxes, both reaching to 70.71 and starting at
  // 50, overlap by a 20x20 square.
  assert.equal(overlapFraction(diamond, square), 0);

  // Turned the same way, a diamond centred on a square of equal size keeps the
  // part of itself inside: an octagon. Checked against the closed form rather
  // than a number somebody read off a screenshot.
  const same = item({ x: 0, y: 0, w: 100, h: 100 });
  const area = 2 * (Math.SQRT2 - 1) * 100 * 100;   // the classic 8-sided figure
  close(overlapFraction(diamond, same), area / 10000, 'octagon');
});

test('overlap is never more than all of it', () => {
  // Floating point on a clip that came back a hair larger than the box it
  // started as would report just over 1, and this is compared against a
  // threshold rather than used as an area.
  for (const rot of [0, 13, 45, 90, 137, 271]) {
    const a = item({ x: 3, y: -7, w: 100, h: 60, rot });
    assert.ok(overlapFraction(a, a) <= 1);
    close(overlapFraction(a, a), 1, `a shape over itself at ${rot} degrees`);
  }
});

test('a degenerate item overlaps nothing', () => {
  const a = item({ x: 0, y: 0, w: 0, h: 100 });
  assert.equal(overlapFraction(a, item({ x: 0, y: 0, w: 100, h: 100 })), 0);
  assert.equal(overlapFraction(item({ x: 0, y: 0, w: 100, h: 100 }), a), 0);
});

test('the ends of the top edge lie on the item', () => {
  // Probed a hair inside rather than exactly on the corner. A corner sits on
  // the boundary by construction, and pointInItem compares with <=, so whether
  // it lands in or out is decided by whether the trig rounds to 49.999... or
  // 50.000...1 - which is a question about floating point, not about geometry.
  // The app is indifferent either way: a note is stuck or not stuck by a
  // margin far wider than this.
  const inset = 0.9999;
  for (const rot of [0, 30, 45, 120]) {
    const it = item({ w: 100, h: 40, rot });
    for (const p of topEdge(it)) {
      assert.ok(pointInItem(p.x * inset, p.y * inset, it), `corner off the item at ${rot} degrees`);
    }
  }
});


// ---------------------------------------------------------------------------
// segmentMeetsRect - what the web culls threads with
//
// The reason it is not a bounding-box test is the whole of what these check.
// A box test and an exact one agree on everything axis-aligned; they part
// company on the diagonal, and a web is mostly diagonals.
// ---------------------------------------------------------------------------

const R = { x0: 0, y0: 0, x1: 10, y1: 10 };
const seg = (ax, ay, bx, by) => segmentMeetsRect({ x: ax, y: ay }, { x: bx, y: by }, R);

test('a segment inside the rect meets it', () => {
  assert.ok(seg(2, 2, 8, 8));
  assert.ok(seg(5, 5, 5, 5), 'a degenerate segment inside is still inside');
});

test('a segment crossing the rect meets it, whichever way it enters', () => {
  assert.ok(seg(-5, 5, 15, 5), 'straight through, left to right');
  assert.ok(seg(5, -5, 5, 15), 'straight through, bottom to top');
  assert.ok(seg(-5, -5, 15, 15), 'corner to corner');
  assert.ok(seg(-1, 5, 5, 5), 'one end outside, one in');
  assert.ok(seg(5, 5, 50, 50), 'one end inside, one far out');
});

test('a segment wholly beyond one edge does not', () => {
  assert.ok(!seg(-5, -5, -5, 15), 'left of it');
  assert.ok(!seg(15, -5, 15, 15), 'right of it');
  assert.ok(!seg(-5, -1, 15, -1), 'below it');
  assert.ok(!seg(-5, 11, 15, 11), 'above it');
});

test('the diagonal a box test gets wrong', () => {
  // The line x+y = -2, which passes clean under the rect's near corner without
  // ever reaching it. Its bounding box is (-10,-22)-(20,8), which overlaps the
  // rect on both axes - so the box test the web used to do says yes, and the
  // thread was emitted on every frame of every pan without ever touching the
  // screen.
  const a = { x: 20, y: -22 }, b = { x: -10, y: 8 };
  const boxSays = Math.max(a.x, b.x) >= R.x0 && Math.min(a.x, b.x) <= R.x1 &&
                  Math.max(a.y, b.y) >= R.y0 && Math.min(a.y, b.y) <= R.y1;
  assert.ok(boxSays, 'the box test would have kept it');
  assert.ok(!segmentMeetsRect(a, b, R), 'but the line never enters the rect');
});

test('touching an edge or a corner counts', () => {
  assert.ok(seg(-5, 0, 5, 0), 'along the bottom edge');
  assert.ok(seg(10, 10, 20, 20), 'starting exactly on the far corner');
  assert.ok(seg(-5, 15, 15, -5), 'the anti-diagonal through both corners');
});

test('it never loops, however far out the ends are', { timeout: 5000 }, () => {
  // Cohen-Sutherland settles in four turns; a wrong loop condition hangs rather
  // than failing, and the timeout above is what turns that hang into a failure.
  // It used to be asserted as `typeof seg(...) === 'boolean'`, which seg()
  // cannot fail whatever it computes - so the six cases ran and their answers
  // went unread. They have answers, so they are asserted.
  const far = 1e9;
  for (const [ax, ay, bx, by, want] of [
    [-far, -far, far, far, true],       // the diagonal, straight through it
    [far, -far, -far, far, true],       // the anti-diagonal, through the origin corner
    [-far, 5, far, 5, true],            // horizontal, across the middle
    [5, -far, 5, far, true],            // vertical, up the middle
    [-far, -far, -far, far, false],     // a vertical a billion units to the left
    [far, far, far + 1, far + 1, false],// a short segment nowhere near it
  ]) {
    assert.equal(seg(ax, ay, bx, by), want,
      `seg(${ax}, ${ay}, ${bx}, ${by}) should be ${want}`);
  }
});

// ---------------------------------------------------------------------------
// viewShift - "did that view change move anything anybody can see?"
// ---------------------------------------------------------------------------
//
// The grid repaints full-viewport on every view frame, and two very ordinary
// gestures hand it a stream of frames that move nothing: the tail of an
// inertial pan, and a trackpad delivering zoom in fractions. Skipping those is
// only safe if this function never says "settled" about a frame that moved.

const view = (px, py, zoom) => ({ pan: { x: px, y: py }, zoom });
const RECT = { x0: -500, y0: -400, x1: 500, y1: 400 };

test('an unchanged view has shifted by nothing', () => {
  const v = view(10, -20, 1.5);
  assert.equal(viewShift(v, v, RECT), 0);
});

test('a pure pan shifts by the pan distance times the zoom', () => {
  // Pan is in world units, so the screen distance is scaled. 3 world units at
  // 2x is 6 screen pixels, whichever corner you measure from.
  assert.ok(near(viewShift(view(0, 0, 2), view(3, 0, 2), RECT), 6));
  assert.ok(near(viewShift(view(0, 0, 2), view(0, 3, 2), RECT), 6));
});

test('the sign flip on y does not lose the shift', () => {
  // Screen y runs the other way from world y (viewport.js toScreen). A y-pan
  // that came out as zero here would let a vertical drag repaint nothing.
  assert.ok(viewShift(view(0, 0, 1), view(0, -0.5, 1), RECT) > 0);
});

test('a zoom moves the far corners most and the centre not at all', () => {
  // Zooming about the pan point leaves that point still: at pan (0,0) the
  // rectangle's centre is the fixed point, and 500 world units out at a zoom
  // step of 0.01 is 5 screen pixels.
  const a = view(0, 0, 1), b = view(0, 0, 1.01);
  assert.ok(near(viewShift(a, b, RECT), 5));
  assert.equal(viewShift(a, b, { x0: 0, y0: 0, x1: 0, y1: 0 }), 0);
});

test('a zoom too small to see reports under a pixel', () => {
  // The case the guard exists for: a precision wheel notch. Half a screen
  // pixel across a thousand-unit rectangle.
  const shift = viewShift(view(0, 0, 1), view(0, 0, 1 + 0.5 / 500), RECT);
  assert.ok(shift < 1, `expected sub-pixel, got ${shift}`);
});

test('a pan and a zoom that cancel at one corner still count at another', () => {
  // The trap in measuring one point instead of four: zooming about a corner
  // holds that corner still while the opposite one travels the full distance.
  // Anchoring the zoom at (-500,-400) - the rect's near corner - leaves it
  // fixed and moves the far corner by the whole 1000x800 extent times the step.
  const a = view(-500, -400, 1), b = view(-500, -400, 1.01);
  assert.ok(near(viewShift(a, b, RECT), 10), 'the far corner moved 1000 * 0.01');
});

test('it is symmetric in the two views', () => {
  const a = view(0, 0, 1), b = view(7, -3, 1.4);
  assert.ok(near(viewShift(a, b, RECT), viewShift(b, a, RECT)));
});
