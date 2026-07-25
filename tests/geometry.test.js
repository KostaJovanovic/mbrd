// Where an item is, and what it covers.
//
// These had been four separate implementations in four modules that could not
// see each other, and they disagreed about rotation. The tests that matter
// most here are the rotated ones - not because anything rotates today, but
// because that is precisely why the disagreement survived so long unnoticed.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  rotatedExtents, itemBounds, itemInRect, itemRadius, pointInItem, topEdge,
} from '../web/assets/js/geometry.js';
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
