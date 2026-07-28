// The cull index only has to be right about one thing: it must never drop an
// item that overlaps the query. A false positive costs one precise test the
// caller was going to run anyway; a false negative is a card that fails to mount
// where the eye can see it should. So the load-bearing test here is the property
// one - random boxes, random rectangles, and the assertion that the index's
// answer is a *superset* of the boxes that truly overlap. Dedupe, update and
// remove are checked besides, because a multi-cell item listed twice or a moved
// item left in its old cell are the two ways the bookkeeping goes wrong.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  rebuild, update, remove, queryRect,
} from '../web/assets/js/canvas/spatial.js';

const box = (id, x, y, w, h) => ({ id, x, y, w, h });

/** The exact overlap test the index approximates: do the boxes' spans meet the
 *  rectangle's on both axes. Centre-and-size boxes, an {x0,y0,x1,y1} rect. */
function trulyOverlaps(b, rect) {
  return b.x + b.w / 2 >= rect.x0 && b.x - b.w / 2 <= rect.x1 &&
         b.y + b.h / 2 >= rect.y0 && b.y - b.h / 2 <= rect.y1;
}

// A deterministic PRNG, so a failure is reproducible rather than a Tuesday.
function lcg(seed) {
  let s = seed >>> 0;
  return () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 0x100000000; };
}

test('a query returns a box sharing its cell', () => {
  rebuild([box('a', 0, 0, 10, 10)]);
  assert.ok(queryRect({ x0: -5, y0: -5, x1: 5, y1: 5 }).has('a'));
});

test('a box well outside the query is not returned', () => {
  rebuild([box('a', 0, 0, 10, 10)]);
  assert.ok(!queryRect({ x0: 5000, y0: 5000, x1: 6000, y1: 6000 }).has('a'));
});

test('a box spanning several cells comes back exactly once', () => {
  // Wider than any sane cell, so it is registered across a row of them.
  rebuild([box('wide', 0, 0, 4000, 50)], 200);
  const ids = [...queryRect({ x0: -3000, y0: -25, x1: 3000, y1: 25 })]
    .filter(id => id === 'wide');
  assert.deepEqual(ids, ['wide']);
});

test('update moves a box out of its old cells and into new ones', () => {
  rebuild([box('a', 0, 0, 10, 10)], 200);
  update('a', box('a', 5000, 5000, 10, 10));
  assert.ok(!queryRect({ x0: -5, y0: -5, x1: 5, y1: 5 }).has('a'));
  assert.ok(queryRect({ x0: 4995, y0: 4995, x1: 5005, y1: 5005 }).has('a'));
});

test('a null box update removes the id', () => {
  rebuild([box('a', 0, 0, 10, 10)]);
  update('a', null);
  assert.ok(!queryRect({ x0: -5, y0: -5, x1: 5, y1: 5 }).has('a'));
});

test('remove drops a box from the index and is safe on an unknown id', () => {
  rebuild([box('a', 0, 0, 10, 10)]);
  remove('a');
  remove('never-was-here');
  assert.ok(!queryRect({ x0: -5, y0: -5, x1: 5, y1: 5 }).has('a'));
});

test('the query never drops a box that truly overlaps (no false negatives)', () => {
  const rand = lcg(20260727);
  const span = 8000;
  const coord = () => (rand() - 0.5) * span;
  const size = () => 5 + rand() * 900;   // from tiny to several cells wide

  for (let cellSize of [50, 200, 512, 1500]) {
    const boxes = [];
    for (let i = 0; i < 400; i++) boxes.push(box('b' + i, coord(), coord(), size(), size()));
    rebuild(boxes, cellSize);

    for (let q = 0; q < 200; q++) {
      const cx = coord(), cy = coord();
      const rw = rand() * 2000, rh = rand() * 2000;
      const rect = { x0: cx - rw / 2, y0: cy - rh / 2, x1: cx + rw / 2, y1: cy + rh / 2 };
      const got = queryRect(rect);
      for (const b of boxes) {
        if (trulyOverlaps(b, rect)) {
          assert.ok(got.has(b.id),
            `cell=${cellSize} rect=${JSON.stringify(rect)} missed ${b.id} at ${b.x},${b.y} ${b.w}x${b.h}`);
        }
      }
    }
  }
});

test('after moves, the index still has no false negatives', () => {
  const rand = lcg(1234567);
  const coord = () => (rand() - 0.5) * 6000;
  const boxes = [];
  for (let i = 0; i < 200; i++) boxes.push(box('m' + i, coord(), coord(), 100, 100));
  rebuild(boxes, 300);
  // Shove half of them somewhere new, the way a drag or a rearrange would.
  for (let i = 0; i < boxes.length; i += 2) {
    boxes[i] = box(boxes[i].id, coord(), coord(), 100, 100);
    update(boxes[i].id, boxes[i]);
  }
  for (let q = 0; q < 200; q++) {
    const cx = coord(), cy = coord();
    const rect = { x0: cx - 400, y0: cy - 400, x1: cx + 400, y1: cy + 400 };
    const got = queryRect(rect);
    for (const b of boxes) {
      if (trulyOverlaps(b, rect)) assert.ok(got.has(b.id), `missed ${b.id}`);
    }
  }
});
