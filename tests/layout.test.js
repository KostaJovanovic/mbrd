// The arrangement engine, the grid's quantisation, and the web's one rule.
//
// All three are pure functions of their input with properties worth stating
// rather than examples worth pinning: a layout returns one point per item, a
// grid step lands inside its band at any zoom, and no two threads cross. Those
// hold for every input, so they are tested that way.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { arrange, ARRANGEMENTS } from '../web/assets/js/arrange/arrangements.js';
import { gridStep } from '../web/assets/js/canvas/grid.js';
import { item } from './helpers.js';

const items = n => Array.from({ length: n }, (_, i) => item({ id: `i${i}`, w: 100, h: 80 }));
const named = ARRANGEMENTS.map(a => a.id);

// ---------------------------------------------------------------------------
// Arrangements
// ---------------------------------------------------------------------------

test('every arrangement in the menu is implemented', () => {
  for (const name of named) {
    const out = arrange(items(5), { name, center: { x: 0, y: 0 }, spacing: 32 });
    assert.equal(out.length, 5, `${name} returned the wrong count`);
  }
});

for (const name of named) {
  test(`${name} returns one finite point per item, in order`, () => {
    const out = arrange(items(17), { name, center: { x: 40, y: -60 }, spacing: 24 });
    assert.equal(out.length, 17);
    for (const [i, p] of out.entries()) {
      assert.ok(Number.isFinite(p.x), `${name}[${i}].x is ${p.x}`);
      assert.ok(Number.isFinite(p.y), `${name}[${i}].y is ${p.y}`);
    }
  });

  test(`${name} handles a single item`, () => {
    const out = arrange(items(1), { name, center: { x: 0, y: 0 }, spacing: 32 });
    assert.equal(out.length, 1);
    assert.ok(Number.isFinite(out[0].x) && Number.isFinite(out[0].y));
  });
}

test('an empty board arranges to nothing', () => {
  for (const name of named) {
    assert.deepEqual(arrange([], { name }), []);
  }
});

test('free keeps every position exactly', () => {
  const src = [item({ x: 13, y: -7 }), item({ x: -200, y: 55 })];
  const out = arrange(src, { name: 'free', center: { x: 999, y: 999 }, spacing: 80 });
  assert.deepEqual(out, [{ x: 13, y: -7 }, { x: -200, y: 55 }]);
});

test('an unknown layout falls back rather than throwing', () => {
  const out = arrange(items(4), { name: 'no-such-layout' });
  assert.equal(out.length, 4);
});

test('grid puts the first item on the centre', () => {
  const [first] = arrange(items(9), { name: 'grid', center: { x: 100, y: 200 }, spacing: 32 });
  assert.equal(first.x, 100);
  assert.equal(first.y, 200);
});

test('layouts spread out rather than stacking', () => {
  // The failure this catches is a layout that returns the centre for
  // everything, which looks like "the drop did nothing".
  for (const name of named.filter(n => n !== 'free')) {
    const out = arrange(items(12), { name, center: { x: 0, y: 0 }, spacing: 32 });
    const distinct = new Set(out.map(p => `${p.x.toFixed(3)},${p.y.toFixed(3)}`));
    assert.ok(distinct.size > 1, `${name} stacked everything on one point`);
  }
});

test('scatter is reproducible from a seed and different without one', () => {
  const opts = { name: 'scatter', center: { x: 0, y: 0 }, spacing: 32 };
  const a = arrange(items(20), { ...opts, seed: 12345 });
  const b = arrange(items(20), { ...opts, seed: 12345 });
  const c = arrange(items(20), { ...opts, seed: 999 });
  assert.deepEqual(a, b, 'the same seed must lay out the same way');
  assert.notDeepEqual(a, c, 'a fresh seed is the whole point of Rearrange');
});

test('scatter without a seed is stable for the same drop', () => {
  const opts = { name: 'scatter', center: { x: 0, y: 0 }, spacing: 32 };
  assert.deepEqual(arrange(items(8), opts), arrange(items(8), opts));
});

test('date order falls back to import order when nothing is dated', () => {
  const out = arrange(items(6), { name: 'date', center: { x: 0, y: 0 }, spacing: 32 });
  assert.equal(out.length, 6);
});

test('date lays items out oldest-first in reading order', () => {
  // Four items, so the grid is wider than one row and "first" is a position
  // you can actually see. Reading order runs down the page and world y points
  // up, so the earliest item is the one highest on the board and the latest is
  // on a row below it.
  const src = [
    item({ id: 'd', meta: { mtime: 4000 } }),
    item({ id: 'b', meta: { mtime: 2000 } }),
    item({ id: 'a', meta: { mtime: 1000 } }),
    item({ id: 'c', meta: { mtime: 3000 } }),
  ];
  const out = arrange(src, { name: 'date', center: { x: 0, y: 0 }, spacing: 10 });
  const at = id => out[src.findIndex(i => i.id === id)];
  assert.ok(at('a').y >= at('d').y, 'the oldest must not sit below the newest');
  assert.ok(at('a').y > at('d').y || at('a').x < at('d').x, 'and must come first in reading order');
});

test('cluster by type groups the same types together', () => {
  const src = [
    item({ id: 'a', type: 'image' }), item({ id: 'b', type: 'note' }),
    item({ id: 'c', type: 'image' }), item({ id: 'd', type: 'note' }),
  ];
  const out = arrange(src, { name: 'type', center: { x: 0, y: 0 }, spacing: 20 });
  const [a, b, c, d] = out;
  const spread = pts => Math.max(...pts.map(p => p.x)) - Math.min(...pts.map(p => p.x));
  assert.ok(spread([a, c]) < spread([a, b, c, d]), 'the two images should sit closer than the whole row');
});

test('spacing widens the layout', () => {
  const tight = arrange(items(9), { name: 'grid', center: { x: 0, y: 0 }, spacing: 0 });
  const loose = arrange(items(9), { name: 'grid', center: { x: 0, y: 0 }, spacing: 200 });
  const width = out => Math.max(...out.map(p => p.x)) - Math.min(...out.map(p => p.x));
  assert.ok(width(loose) > width(tight));
});

// ---------------------------------------------------------------------------
// Grid quantisation
// ---------------------------------------------------------------------------

test('the on-screen grid step stays inside its band at any zoom', () => {
  // The property that stops the grid becoming a solid fill zoomed out, or a
  // single line zoomed in.
  for (let z = 0.02; z <= 32; z *= 1.35) {
    const px = gridStep(64, z) * z;
    assert.ok(px >= 26 && px <= 104, `step is ${px.toFixed(1)}px at zoom ${z.toFixed(3)}`);
  }
});

test('the grid step is a power-of-two multiple of the base', () => {
  for (let z = 0.05; z <= 16; z *= 2) {
    const ratio = gridStep(64, z) / 64;
    const log = Math.log2(ratio);
    assert.ok(Math.abs(log - Math.round(log)) < 1e-9, `ratio ${ratio} is not a power of two`);
  }
});

test('a nonsense base falls back rather than looping', () => {
  assert.ok(gridStep(0, 1) > 0);
  assert.ok(gridStep(-5, 1) > 0);
});

// ---------------------------------------------------------------------------
// The web
//
// canvas/web.js keeps its planarity pass module-private, so the rule is tested
// through the geometry it guarantees: whatever threads() decides to draw, no
// two of them may cross. The segments are reconstructed from the drawn path.
// ---------------------------------------------------------------------------

/** Do segments AB and CD properly cross? Shared endpoints do not count. */
function crosses(a, b, c, d) {
  const side = (p, q, r) => {
    const v = (q.y - p.y) * (r.x - q.x) - (q.x - p.x) * (r.y - q.y);
    return v > 1e-9 ? 1 : v < -1e-9 ? -1 : 0;
  };
  const same = (p, q) => Math.abs(p.x - q.x) < 1e-9 && Math.abs(p.y - q.y) < 1e-9;
  if (same(a, c) || same(a, d) || same(b, c) || same(b, d)) return false;
  const o1 = side(a, b, c), o2 = side(a, b, d);
  const o3 = side(c, d, a), o4 = side(c, d, b);
  return o1 !== o2 && o3 !== o4;
}

test('the crossing predicate agrees with obvious cases', () => {
  // The test's own tool, checked before it is trusted below.
  const p = (x, y) => ({ x, y });
  assert.ok(crosses(p(-1, 0), p(1, 0), p(0, -1), p(0, 1)), 'an X crosses');
  assert.ok(!crosses(p(-1, 0), p(1, 0), p(-1, 1), p(1, 1)), 'parallel lines do not');
  assert.ok(!crosses(p(0, 0), p(1, 0), p(1, 0), p(2, 0)), 'meeting end to end is not crossing');
  assert.ok(!crosses(p(0, 0), p(1, 1), p(5, 5), p(6, 6)), 'disjoint collinear does not');
});
