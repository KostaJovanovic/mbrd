// Nudge board's solver: no two boxes overlap afterwards, fixed boxes stay put,
// and the board keeps its shape - what was left of what stays left of it.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { nudgeApart } from '../web/assets/js/arrange/nudge.ts';

/** Pairs that still overlap by more than float noise, given the gap. */
function overlaps(boxes, pos, gap = 0) {
  const bad = [];
  for (let i = 0; i < boxes.length; i++) {
    for (let j = i + 1; j < boxes.length; j++) {
      const ox = (boxes[i].w + boxes[j].w) / 2 + gap - Math.abs(pos[i].x - pos[j].x);
      const oy = (boxes[i].h + boxes[j].h) / 2 + gap - Math.abs(pos[i].y - pos[j].y);
      if (ox > 1e-3 && oy > 1e-3) bad.push([i, j]);
    }
  }
  return bad;
}

test('a board with nothing overlapping is left exactly where it is', () => {
  const boxes = [{ x: 0, y: 0, w: 100, h: 80 }, { x: 200, y: 0, w: 100, h: 80 }, { x: 0, y: 300, w: 50, h: 50 }];
  assert.deepEqual(nudgeApart(boxes, { gap: 12 }), boxes.map(b => ({ x: b.x, y: b.y })));
});

test('two overlapping cards part along the axis they overlap least on, by the least', () => {
  // 20 of overlap across, 80 down: they part sideways, each taking half plus the gap.
  const boxes = [{ x: 0, y: 0, w: 100, h: 80 }, { x: 80, y: 0, w: 100, h: 80 }];
  const pos = nudgeApart(boxes, { gap: 10 });
  assert.deepEqual(pos, [{ x: -15, y: 0 }, { x: 95, y: 0 }]);
});

test('a fixed card never moves, and the other takes the whole move', () => {
  const boxes = [{ x: 0, y: 0, w: 100, h: 100, fixed: true }, { x: 0, y: 60, w: 100, h: 100 }];
  const pos = nudgeApart(boxes);
  assert.deepEqual(pos[0], { x: 0, y: 0 });
  assert.equal(pos[1].y, 100);
  assert.equal(pos[1].x, 0);
});

test('a pile on one spot spreads until nothing overlaps', () => {
  const boxes = Array.from({ length: 60 }, (_, i) => ({ x: 0, y: 0, w: 80 + (i % 5) * 20, h: 60 + (i % 3) * 30 }));
  const pos = nudgeApart(boxes, { gap: 12 });
  assert.deepEqual(overlaps(boxes, pos, 12), []);
  // Spread, not a line: a pile pushed one way only would be one card tall.
  const ys = pos.map(p => p.y);
  assert.ok(Math.max(...ys) - Math.min(...ys) > 200);
});

test('a crowded grid keeps its reading order', () => {
  // A 6x6 grid laid at 80% of the room it needs: every row and column overlaps
  // its neighbour, and after the nudge each card is still right of the one
  // before it in its row and below the one above it in its column.
  const boxes = [];
  for (let r = 0; r < 6; r++) for (let c = 0; c < 6; c++) {
    boxes.push({ x: c * 80 + (r % 2) * 3, y: r * 80, w: 100, h: 100 });
  }
  const pos = nudgeApart(boxes, { gap: 8 });
  assert.deepEqual(overlaps(boxes, pos, 8), []);
  for (let r = 0; r < 6; r++) for (let c = 1; c < 6; c++) {
    assert.ok(pos[r * 6 + c].x > pos[r * 6 + c - 1].x, `row ${r} col ${c}`);
  }
  for (let c = 0; c < 6; c++) for (let r = 1; r < 6; r++) {
    assert.ok(pos[r * 6 + c].y > pos[(r - 1) * 6 + c].y, `col ${c} row ${r}`);
  }
});

test('on a lattice every move is a whole number of steps', () => {
  const step = 20;
  const boxes = Array.from({ length: 25 }, (_, i) => ({
    x: (i % 5) * 60, y: Math.floor(i / 5) * 60, w: 80, h: 80,
  }));
  boxes.push({ x: 100, y: 100, w: 80, h: 80, fixed: true });
  const pos = nudgeApart(boxes, { step });
  assert.deepEqual(overlaps(boxes, pos), []);
  pos.forEach((p, i) => {
    assert.equal(Math.abs((p.x - boxes[i].x) % step), 0, `x of ${i}`);
    assert.equal(Math.abs((p.y - boxes[i].y) % step), 0, `y of ${i}`);
  });
  assert.deepEqual(pos[25], { x: 100, y: 100 });
});
