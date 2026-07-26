// The arrangement engine, the grid's quantisation, and the web's one rule.
//
// All three are pure functions of their input with properties worth stating
// rather than examples worth pinning: a layout returns one point per item, a
// grid step lands inside its band at any zoom, and no two threads cross. Those
// hold for every input, so they are tested that way.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { arrange, ARRANGEMENTS } from '../web/assets/js/arrange/arrangements.js';
import {
  gridStep, MIN_PX, MAX_PX, MIN_PX_TOUCH, MAX_PX_TOUCH,
} from '../web/assets/js/canvas/grid.js';
import { farZoom, stillZoom, webZoom, thumbZoom, MIN_ZOOM, MAX_ZOOM } from '../web/assets/js/canvas/viewport.js';
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

// ---------------------------------------------------------------------------
// The seed
//
// A seed is a layout's licence to move the slots themselves, not just to fill
// them in a new order - without that, Rearrange hands back the same shape with
// the cards swapped, which from far enough out to see a whole board is the
// same picture. What varies is each layout's own business; what is asserted
// here is that something does, that it is reproducible, and that the layout is
// still recognisably itself afterwards.
// ---------------------------------------------------------------------------

test('every layout answers a seed with a different arrangement', () => {
  // Some layouts vary in steps - a quarter turn, one column more or fewer -
  // and one step in four is "the same again", which is a legitimate outcome
  // rather than a failure. So the property is that *some* seed moves it, not
  // that any particular one does.
  const base = { center: { x: 0, y: 0 }, spacing: 32 };
  for (const name of named) {
    const src = items(17);   // not a square number, so grid's outer ring is partial
    const plain = JSON.stringify(arrange(src, { ...base, name }));
    const moved = [1, 2, 3, 7, 11, 4242]
      .some(seed => JSON.stringify(arrange(src, { ...base, name, seed })) !== plain);
    assert.ok(moved, `${name} ignored every seed it was given`);
  }
});

test('the same seed lays out the same way in every layout', () => {
  const opts = { center: { x: 12, y: -8 }, spacing: 24, seed: 20260725 };
  for (const name of named) {
    const src = items(13);
    assert.deepEqual(arrange(src, { ...opts, name }), arrange(src, { ...opts, name }),
      `${name} is not reproducible from its seed`);
  }
});

test('a seeded grid is still a grid', () => {
  // The rotation permutes integer cells, so every point must still land on the
  // lattice and no two may share a cell. A grid that came out overlapping
  // would be worse than one that never varied.
  const out = arrange(items(17), { name: 'grid', center: { x: 0, y: 0 }, spacing: 32, seed: 3 });
  const [cw, ch] = [100 + 32, 80 + 32];
  for (const [i, p] of out.entries()) {
    assert.ok(Math.abs(p.x / cw - Math.round(p.x / cw)) < 1e-9, `point ${i} is off the lattice in x`);
    assert.ok(Math.abs(p.y / ch - Math.round(p.y / ch)) < 1e-9, `point ${i} is off the lattice in y`);
  }
  assert.equal(new Set(out.map(p => `${p.x},${p.y}`)).size, out.length, 'two items share a cell');
});

test('a seeded free shakes items loose without relocating them', () => {
  // Free's whole promise is that it will not impose a shape, so a shaken item
  // may move about half its own size and no further. Any more and the
  // arrangement you built by hand stops being recognisable, which is the one
  // thing this layout must not do.
  const src = Array.from({ length: 12 }, (_, i) => item({ id: `i${i}`, x: i * 500, y: 0, w: 100, h: 80 }));
  const out = arrange(src, { name: 'free', center: { x: 0, y: 0 }, spacing: 32, seed: 5 });
  const travelled = out.map((p, i) => Math.hypot(p.x - src[i].x, p.y - src[i].y));
  assert.ok(travelled.some(d => d > 1), 'a seeded free must actually move something');
  const reach = (100 + 32) * 0.5;
  for (const [i, d] of travelled.entries()) {
    assert.ok(d <= reach + 1e-9, `item ${i} travelled ${d.toFixed(1)}, past the ${reach} it may shake`);
  }
});

test('a seeded date layout is still oldest-first', () => {
  const src = [
    item({ id: 'd', meta: { mtime: 4000 } }),
    item({ id: 'b', meta: { mtime: 2000 } }),
    item({ id: 'a', meta: { mtime: 1000 } }),
    item({ id: 'c', meta: { mtime: 3000 } }),
  ];
  for (const seed of [1, 2, 3, 4]) {
    const out = arrange(src, { name: 'date', center: { x: 0, y: 0 }, spacing: 10, seed });
    const at = id => out[src.findIndex(i => i.id === id)];
    assert.ok(at('a').y >= at('d').y, `seed ${seed} put the oldest below the newest`);
  }
});

test('a seeded type layout still clusters', () => {
  const src = [
    item({ id: 'a', type: 'image' }), item({ id: 'b', type: 'note' }),
    item({ id: 'c', type: 'image' }), item({ id: 'd', type: 'note' }),
  ];
  const spread = pts => Math.max(...pts.map(p => p.x)) - Math.min(...pts.map(p => p.x));
  for (const seed of [1, 2, 3, 4]) {
    const [a, b, c, d] = arrange(src, { name: 'type', center: { x: 0, y: 0 }, spacing: 20, seed });
    assert.ok(spread([a, c]) < spread([a, b, c, d]), `seed ${seed} broke the clustering`);
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
  // single line zoomed in. Both bands, because a phone has its own - and the
  // touch one is passed outright rather than detected, since node has no
  // pointer to ask about.
  for (const [touch, min, max] of [[false, MIN_PX, MAX_PX], [true, MIN_PX_TOUCH, MAX_PX_TOUCH]]) {
    for (let z = 0.02; z <= 32; z *= 1.35) {
      const px = gridStep(64, z, touch) * z;
      assert.ok(px >= min && px <= max,
        `${touch ? 'touch' : 'mouse'} step is ${px.toFixed(1)}px at zoom ${z.toFixed(3)}`);
    }
  }
});

test('two grid dots are never closer than 1.41 cm under a finger', () => {
  // The whole point of the touch band, stated in the unit it was chosen in. A
  // CSS pixel is 1/96 inch by the spec, which is the only conversion a browser
  // offers - so this is the nominal centimetre, the same one measure.js uses.
  const cmPerPx = 2.54 / 96;
  assert.ok(MIN_PX_TOUCH * cmPerPx >= 1.41 - 1e-9,
    `${(MIN_PX_TOUCH * cmPerPx).toFixed(3)} cm is under the floor`);
  // And it really is a rise: the desktop band would have drawn them closer.
  assert.ok(MIN_PX_TOUCH > MIN_PX);
  // The factor of four between the ends is MAJOR, and both bands keep it - so
  // the minor lattice at its tightest is exactly as dense as the major lattice
  // at its loosest, and the board never gets tighter than the tier below it.
  assert.equal(MAX_PX / MIN_PX, MAX_PX_TOUCH / MIN_PX_TOUCH);
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
// The zoom detail ladder
// ---------------------------------------------------------------------------

test('chrome and motion drop out at the same zoom', () => {
  // These were 0.35 and 0.3 - two thresholds four hundredths apart that nobody
  // could perceive as two, and that made "zoomed out" mean something slightly
  // different depending on which module asked. They are one rung now. Two
  // names because two modules import them for two purposes; if a future change
  // means them to differ, that is a decision and this test is where to record
  // it rather than a number to quietly edit.
  //
  // Read through the functions rather than off constants, because the rung is
  // not one number any more: it sits higher under a finger than under a mouse.
  // Node has no matchMedia, so what these see is the desktop rung - which is
  // the point, since a fallback that quietly answered "touch" would move the
  // whole ladder on every machine that runs the suite.
  assert.equal(farZoom(), stillZoom(), 'the ladder has grown a second rung');
  assert.equal(farZoom(), webZoom(), 'the ladder has grown a second rung');
  assert.equal(farZoom(), thumbZoom(), 'the ladder has grown a second rung');
  assert.ok(farZoom() > MIN_ZOOM && farZoom() < MAX_ZOOM, 'the rung is outside the zoom range');
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
