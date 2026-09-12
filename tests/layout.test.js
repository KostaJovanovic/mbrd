// The arrangement engine, the grid's quantisation, and the web's one rule.
//
// All three are pure functions of their input with properties worth stating
// rather than examples worth pinning: a layout returns one point per item, a
// grid step lands inside its band at any zoom, and no two threads cross. Those
// hold for every input, so they are tested that way.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  arrange, ARRANGEMENTS,
  mobileOrder, mobileArrangement, MOBILE_ARRANGEMENTS, MOBILE_DEFAULT,
} from '../web/assets/js/arrange/arrangements.ts';
import { latticeBox } from '../web/assets/js/geometry.ts';
import {
  gridStep, boardGridStep, inkBox, MOBILE_GRID_EDGE_CLEARANCE,
  MIN_PX, MAX_PX, MIN_PX_TOUCH, MAX_PX_TOUCH, MAJOR,
} from '../web/assets/js/canvas/grid.ts';
import { farZoom, onSmallScreen, stillZoom, thumbZoom, MIN_ZOOM, MAX_ZOOM } from '../web/assets/js/canvas/viewport.ts';
import { item } from './helpers.js';

const items = n => Array.from({ length: n }, (_, i) => item({ id: `i${i}`, w: 100, h: 80 }));
const named = ARRANGEMENTS.map(a => a.id);

test('Mobile grid ink excludes complete marks centred on board edges', () => {
  const box = inkBox({
    width: 400,
    height: 800,
    isMobile: true,
    mobileScreenRect: () => ({
      left: 20,
      top: 30,
      width: 320,
      height: 900,
      bottom: 930,
    }),
  });

  assert.equal(MOBILE_GRID_EDGE_CLEARANCE, 7);
  assert.equal(box.x, 27);
  assert.equal(box.y, 37);
  assert.equal(box.w, 306);
  assert.equal(box.h, 763);
});

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

/** Do the interiors of two centred boxes intersect? Touching does not count. */
const boxesOverlap = (a, b) =>
  Math.abs(a.x - b.x) < (a.w + b.w) / 2 - 1e-6 &&
  Math.abs(a.y - b.y) < (a.h + b.h) / 2 - 1e-6;

test('a snapped layout does not overlap once every card is snapped to the grid', () => {
  // The overlap only showed with snapping on: each card's edge snaps to the
  // lattice on its own, and two tight cards round toward the same cell.
  // `cellStep` reserves whole cells, which survives the snap. Sizes chosen
  // to not be whole cells, so rounding is exercised. See arrange()/toCells
  // and main.ts/rearrange.
  const step = 64;
  const sizes = [[100, 80], [130, 90], [70, 70], [210, 140], [305, 240], [90, 190], [160, 60], [64, 96]];
  const src = sizes.map(([w, h], i) => item({ id: `s${i}`, w, h }));
  for (const spacing of [0, 8, 12]) {
    for (const name of named.filter(n => n !== 'free')) {
      // Body sizes on the lattice, exactly as main.ts/rearrange derives them.
      const sized = src.map(it => { const b = latticeBox(it, step); return { ...it, w: b.w, h: b.h }; });
      const spots = arrange(sized, { name, center: { x: 0, y: 0 }, spacing, cellStep: step, seed: 7 });
      // Then each card's edge is snapped to the grid, the last thing rearrange does.
      const boxes = spots.map((p, i) => latticeBox({ x: p.x, y: p.y, w: sized[i].w, h: sized[i].h }, step));
      for (let a = 0; a < boxes.length; a++) {
        for (let b = a + 1; b < boxes.length; b++) {
          assert.ok(!boxesOverlap(boxes[a], boxes[b]),
            `${name} at spacing ${spacing}: snapped cards ${a} and ${b} overlap`);
        }
      }
    }
  }
});

test('obstacles keep a fresh block off what is already on the board', () => {
  // A folder dropped onto a busy board flows around existing items instead
  // of landing on top of them. See arrange()/avoidObstacles and drop.ts.
  const obstacles = [
    { x: 0, y: 0, w: 300, h: 300 },
    { x: 260, y: -120, w: 200, h: 160 },
    { x: -220, y: 140, w: 180, h: 180 },
  ];
  const src = items(10);
  for (const name of named.filter(n => n !== 'free')) {
    const spots = arrange(src, { name, center: { x: 0, y: 0 }, spacing: 12, obstacles, seed: 5 });
    const boxes = spots.map((p, i) => ({ x: p.x, y: p.y, w: src[i].w, h: src[i].h }));
    for (const [i, box] of boxes.entries()) {
      for (const ob of obstacles) {
        assert.ok(!boxesOverlap(box, ob), `${name}: dropped card ${i} landed on an existing item`);
      }
      for (let j = i + 1; j < boxes.length; j++) {
        assert.ok(!boxesOverlap(box, boxes[j]), `${name}: dropped cards ${i} and ${j} overlap`);
      }
    }
  }
});

// ---------------------------------------------------------------------------
// The seed
//
// A seed is a layout's licence to move the slots themselves, not just fill
// them in a new order - otherwise Rearrange hands back the same shape with
// swapped cards. Asserted: something varies, it's reproducible, and the
// layout stays recognisably itself.
// ---------------------------------------------------------------------------

test('every layout answers a seed with a different arrangement', () => {
  // Some layouts vary in steps - one step in four can legitimately be "the
  // same again" - so the property is that *some* seed moves it.
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
  // The rotation permutes integer cells, so every point must still land on
  // the lattice with no two sharing a cell.
  const out = arrange(items(17), { name: 'grid', center: { x: 0, y: 0 }, spacing: 32, seed: 3 });
  const [cw, ch] = [100 + 32, 80 + 32];
  for (const [i, p] of out.entries()) {
    assert.ok(Math.abs(p.x / cw - Math.round(p.x / cw)) < 1e-9, `point ${i} is off the lattice in x`);
    assert.ok(Math.abs(p.y / ch - Math.round(p.y / ch)) < 1e-9, `point ${i} is off the lattice in y`);
  }
  assert.equal(new Set(out.map(p => `${p.x},${p.y}`)).size, out.length, 'two items share a cell');
});

test('a seeded free shakes items loose without relocating them', () => {
  // Free's promise is that it won't impose a shape, so a shaken item may
  // move about half its own size and no further - any more and the
  // hand-built arrangement stops being recognisable.
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

test('date puts undated items last, not in 1970', () => {
  // A missing modification time is not a time of zero. Notes and pasted links
  // have none, and sorting those to the front made the first row of a "By
  // date" layout the things that have no date.
  const src = [
    item({ id: 'note' }),
    item({ id: 'old', meta: { mtime: 1000 } }),
    item({ id: 'new', meta: { mtime: 9000 } }),
    item({ id: 'link' }),
  ];
  const out = arrange(src, { name: 'date', center: { x: 0, y: 0 }, spacing: 10 });
  const at = id => out[src.findIndex(i => i.id === id)];
  // Reading order runs down the page and +y is up, so later means lower.
  const after = (a, b) => at(a).y < at(b).y || (at(a).y === at(b).y && at(a).x > at(b).x);
  assert.ok(after('note', 'new'), 'an undated item sorted ahead of a dated one');
  assert.ok(after('link', 'new'), 'an undated item sorted ahead of a dated one');
  assert.ok(after('new', 'old'), 'the dated pair lost its order');
});

test('date breaks a tie on the name, naturally', () => {
  // One camera burst, one second, ten frames: without this they come out in
  // whatever order the file system listed them.
  const src = ['IMG_10', 'IMG_2', 'IMG_1'].map(name =>
    item({ id: name, name, meta: { mtime: 5000 } }));
  const out = arrange(src, { name: 'date', center: { x: 0, y: 0 }, spacing: 10 });
  const at = name => out[src.findIndex(i => i.name === name)];
  assert.ok(at('IMG_1').x < at('IMG_2').x, 'IMG_1 should read before IMG_2');
  assert.ok(at('IMG_2').x < at('IMG_10').x, 'IMG_2 should read before IMG_10 - 2 is not 20');
});

// ---------------------------------------------------------------------------
// Room
//
// Two properties: no layout may return overlapping cards, and one big card
// must cost the board its own size, not multiply every cell on it. `free` is
// the only exception, since it starts from positions you made.
// ---------------------------------------------------------------------------

/** A mixed board: notes, cards, one panorama, one poster. */
const mixed = n => Array.from({ length: n }, (_, i) => item({
  id: `m${i}`,
  type: ['image', 'note', 'video', 'audio'][i % 4],
  name: `m${i}`,
  meta: { mtime: 1000 + i * 60_000 },
  ...(i === 3 ? { w: 1200, h: 260 }        // panorama
    : i === 7 ? { w: 300, h: 900 }         // poster
    : i % 4 === 1 ? { w: 120, h: 120 }     // note
    : { w: 320, h: 240 }),
}));

const placing = named.filter(n => n !== 'free');

for (const name of placing) {
  test(`${name} never leaves two cards closer than the spacing`, () => {
    const gap = 24;
    const src = mixed(23);
    const out = arrange(src, { name, center: { x: 0, y: 0 }, spacing: gap });
    for (let a = 0; a < src.length; a++) {
      for (let b = a + 1; b < src.length; b++) {
        // Boxes grown by half a gap each: overlapping those is the same
        // statement as being closer than one gap apart.
        const dx = Math.abs(out[a].x - out[b].x) - (src[a].w + src[b].w) / 2 - gap;
        const dy = Math.abs(out[a].y - out[b].y) - (src[a].h + src[b].h) / 2 - gap;
        assert.ok(dx >= -1e-9 || dy >= -1e-9,
          `${name}: ${src[a].id} and ${src[b].id} are ${(-Math.max(dx, dy)).toFixed(1)} too close`);
      }
    }
  });

  test(`${name} charges a big card for itself, not for the whole board`, () => {
    // Catches a layout giving every item a cell the size of the largest one:
    // drop a poster on a board of notes and each note gets a poster's room.
    const small = Array.from({ length: 25 }, (_, i) => item({ id: `s${i}`, w: 100, h: 80 }));
    const giant = item({ id: 'giant', w: 1200, h: 900 });
    const area = out => {
      const w = Math.max(...out.map(p => p.x)) - Math.min(...out.map(p => p.x));
      const h = Math.max(...out.map(p => p.y)) - Math.min(...out.map(p => p.y));
      return (w + 100) * (h + 80);   // outer edges, roughly
    };
    const opts = { name, center: { x: 0, y: 0 }, spacing: 24 };
    const without = area(arrange(small, opts));
    const with_ = area(arrange([...small.slice(0, 24), giant], opts));
    // Generous, since a lattice pays for a wide card across its whole column.
    // Rules out the old cost: twenty-five cells of 1200x900.
    assert.ok(with_ < (without + 1200 * 900) * 4,
      `${name}: one big card took the board from ${(without / 1e6).toFixed(2)}M to ${(with_ / 1e6).toFixed(2)}M`);
  });
}

// ---------------------------------------------------------------------------
// Grid quantisation
// ---------------------------------------------------------------------------

test('the on-screen grid step stays inside its band at any zoom', () => {
  // Stops the grid becoming a solid fill zoomed out, or a single line
  // zoomed in. The touch band is passed outright, since Node has no
  // pointer to detect.
  for (const [touch, min, max] of [[false, MIN_PX, MAX_PX], [true, MIN_PX_TOUCH, MAX_PX_TOUCH]]) {
    for (let z = 0.02; z <= 32; z *= 1.35) {
      const px = gridStep(64, z, touch) * z;
      assert.ok(px >= min && px <= max,
        `${touch ? 'touch' : 'mouse'} step is ${px.toFixed(1)}px at zoom ${z.toFixed(3)}`);
    }
  }
});

test('two grid dots are never closer than 1.41 cm under a finger', () => {
  // The whole point of the touch band, in the unit it was chosen in - a CSS
  // pixel is 1/96 inch, the only conversion a browser offers, so this is the
  // nominal centimetre measure.ts also uses.
  const cmPerPx = 2.54 / 96;
  assert.ok(MIN_PX_TOUCH * cmPerPx >= 1.41 - 1e-9,
    `${(MIN_PX_TOUCH * cmPerPx).toFixed(3)} cm is under the floor`);
  // And it really is a rise: the desktop band would have drawn them closer.
  assert.ok(MIN_PX_TOUCH > MIN_PX);
  // Both bands keep the same factor (MAJOR) between their ends, so the minor
  // lattice at its tightest is as dense as the major lattice at its loosest.
  // Asserted against MAJOR itself rather than the number it happens to be.
  assert.equal(MAX_PX / MIN_PX, MAJOR);
  assert.equal(MAX_PX / MIN_PX, MAX_PX_TOUCH / MIN_PX_TOUCH);
});

test('an eight-wide Mobile board keeps all eight snap spaces', () => {
  const fittedZoom = 328 / 512;
  const mobile = { isMobile: true, zoom: fittedZoom };
  const desktop = { isMobile: false, zoom: fittedZoom };

  assert.equal(boardGridStep(64, mobile, true), 64);
  assert.equal(512 / boardGridStep(64, mobile, true), 8);
  assert.equal(boardGridStep(64, desktop, true), 128,
    'Desktop still coarsens a touch grid at the same zoom');
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
  // These were 0.35 and 0.3, imperceptibly different thresholds that made
  // "zoomed out" mean two things depending on which module asked. One rung
  // now, under two names for two purposes - if a future change means them
  // to differ, this test is where to record that decision.
  //
  // The web left this ladder deliberately: the far view is the only one
  // that shows the whole graph, so connections no longer leave at far zoom.
  //
  // Read through the functions, not off constants: the rung sits higher on
  // a phone than a desk. Node has no matchMedia, so this sees the desk
  // rung - a fallback quietly answering "phone" would move the whole ladder.
  assert.equal(farZoom(), stillZoom(), 'the ladder has grown a second rung');
  assert.equal(farZoom(), thumbZoom(), 'the ladder has grown a second rung');
  assert.ok(farZoom() > MIN_ZOOM && farZoom() < MAX_ZOOM, 'the rung is outside the zoom range');
});

test('the high rung is a phone, not a touchscreen', () => {
  // `(pointer: coarse)` alone was the wrong question: the argument for the
  // high rung is about screen width, not fingers. Windows reports a coarse
  // pointer on an ordinary touchscreen laptop with the keyboard folded away,
  // so a desk machine ran the phone rung and dropped detail early.
  //
  // Stubbed because the failure this guards against is a query that
  // matches too much. The module caches its query on first use, so this
  // must run before anything else here asks - the only test that touches
  // matchMedia. The stub answers through a getter so switching it off in
  // `finally` reaches the cached object; a plain field would leave every
  // later test in this file silently running on a phone.
  const seen = [];
  let live = true;
  globalThis.matchMedia = q => { seen.push(q); return { get matches() { return live; } }; };
  try {
    assert.ok(onSmallScreen(), 'the stub says yes, so the rung has to see it');
    assert.equal(seen.length, 1, 'one query, asked once and cached');
    assert.match(seen[0], /pointer:\s*coarse/, 'a phone is still a touch device');
    assert.match(seen[0], /max-width/, 'and a phone is small, which is the half that was missing');
  } finally {
    live = false;
    delete globalThis.matchMedia;
  }
  assert.equal(onSmallScreen(), false, 'the stub outlived the test it was written for');
});

// ---------------------------------------------------------------------------
// Mobile: the orders
//
// A Mobile board is a packed column, so a layout only decides what order the
// packer meets items in. `(items, opts) => items`, pure, always a
// permutation of what it was handed. See MOBILE_ARRANGEMENTS.
// ---------------------------------------------------------------------------

const ids = list => list.map(i => i.id);

test('every Mobile order is a permutation, and only that', () => {
  // The packer depends on this: nothing invented, dropped, or geometrically
  // moved - fitMobile()/packMobileGrid() decide that afterwards.
  const src = mixed(23);
  for (const { id } of MOBILE_ARRANGEMENTS) {
    const out = mobileOrder(src, { name: id, seed: 4 });
    assert.equal(out.length, src.length, `${id} changed the count`);
    assert.deepEqual([...ids(out)].sort(), [...ids(src)].sort(), `${id} is not a permutation`);
    assert.deepEqual(ids(src), ids(mixed(23).map(i => i)), 'the input was reordered in place');
    for (const item of out) {
      const was = src.find(s => s.id === item.id);
      assert.equal(item.x, was.x, `${id} moved ${item.id}`);
      assert.equal(item.y, was.y, `${id} moved ${item.id}`);
    }
  }
});

test('a Mobile order with no seed is the same order twice', () => {
  // What makes a drop reproducible: the same files land the same way.
  // Shuffle included on purpose - unseeded it's the order it was handed.
  const src = mixed(17);
  for (const { id } of MOBILE_ARRANGEMENTS) {
    assert.deepEqual(
      ids(mobileOrder(src, { name: id })),
      ids(mobileOrder(src, { name: id })),
      `${id} is not reproducible without a seed`);
  }
  assert.deepEqual(ids(mobileOrder(src, { name: 'shuffle' })), ids(src));
});

test('each Mobile order sorts on the thing it is named after', () => {
  const src = mixed(12);
  const by = name => mobileOrder(src, { name });

  // Tall first: height is what walls off a row in a row-major pack.
  const heights = by('fit').map(i => i.h);
  assert.deepEqual(heights, [...heights].sort((a, b) => b - a));

  // Oldest first, the same key and direction as Desktop's `date`.
  const times = by('date').map(i => i.meta.mtime);
  assert.deepEqual(times, [...times].sort((a, b) => a - b));

  // Kinds gathered, and in one run each rather than interleaved.
  const kinds = by('type').map(i => i.type);
  assert.deepEqual(kinds, [...kinds].sort());

  const names = by('name').map(i => i.name);
  assert.deepEqual(names, [...names].sort((a, b) => a.localeCompare(b, undefined, { numeric: true })));
});

test('a stored Desktop arrangement reads as the nearest Mobile order', () => {
  // Every board saved before the two catalogues split carries one of
  // Desktop's seven for Mobile too. Three mean something in a column and
  // carry over; scatter keeps its column-showable half; pure-geometry ones
  // become the default rather than silently doing nothing.
  assert.equal(mobileArrangement('free'), 'free');
  assert.equal(mobileArrangement('date'), 'date');
  assert.equal(mobileArrangement('type'), 'type');
  assert.equal(mobileArrangement('scatter'), 'shuffle');
  for (const name of ['spiral', 'grid', 'masonry', '', undefined, 'nonsense']) {
    assert.equal(mobileArrangement(name), MOBILE_DEFAULT, `${name} should fall back`);
  }
  // And the fallback is a real entry, not a name that only this function knows.
  assert.ok(MOBILE_ARRANGEMENTS.some(a => a.id === MOBILE_DEFAULT));
});

test('the two catalogues share only the ids that mean the same thing', () => {
  // `free`, `date`, `tag` and `type` are deliberately the same string in
  // both, so switching to Mobile and back keeps the setting. The list grows
  // only when an arrangement genuinely means the same thing on both
  // surfaces - "the same grouping, with the page taken away".
  const shared = MOBILE_ARRANGEMENTS
    .map(a => a.id)
    .filter(id => named.includes(id));
  assert.deepEqual(shared.sort(), ['date', 'free', 'tag', 'type']);
});

// ---------------------------------------------------------------------------
// The web
//
// canvas/web.ts keeps its planarity pass module-private, so this tests the
// geometry it guarantees instead: no two drawn threads may cross.
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
  // The test's own tool - but nothing below uses it. `threads()` isn't
  // imported here, so this just checks the helper against itself. Kept
  // because it's a readable statement of "crossing"; the property it was
  // written for lives in tests/web.test.js, where noCrossings() runs the
  // same predicate over real threads().
  const p = (x, y) => ({ x, y });
  assert.ok(crosses(p(-1, 0), p(1, 0), p(0, -1), p(0, 1)), 'an X crosses');
  assert.ok(!crosses(p(-1, 0), p(1, 0), p(-1, 1), p(1, 1)), 'parallel lines do not');
  assert.ok(!crosses(p(0, 0), p(1, 0), p(1, 0), p(2, 0)), 'meeting end to end is not crossing');
  assert.ok(!crosses(p(0, 0), p(1, 1), p(5, 5), p(6, 6)), 'disjoint collinear does not');
});
