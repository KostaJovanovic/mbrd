// Snapping the whole board, and the two geometry profiles.
//
// state.js is a module singleton, which is right for an app with one board and
// awkward for tests, so every case starts by loading an empty board. That is
// the same door opening a .mbrd goes through, so it also exercises the reset.
//
// One of six files that were tests/state.test.js, split to mirror the modules
// state.js itself was split onto - see tests/layers.test.js for that list.

import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

import {
  board, addItems, undo, byId, setSetting, snapshotGeom, commitGeom,
  recheckBoardGeometry, setBoardMode,
} from '../web/assets/js/state.js';
import { CELL_GAP } from '../web/assets/js/geometry.js';
import { fresh } from './state-fixtures.js';

beforeEach(() => {
  setBoardMode('desktop');
  fresh();
});
// ---------------------------------------------------------------------------
// Snapping the whole board
// ---------------------------------------------------------------------------
//
// The promise has three halves, and it is the third that is easy to get wrong:
// turning snapping on lays everything on the lattice, turning it off puts it
// back, and anything placed by hand in between keeps where it was put rather
// than being dragged back to a position the user has already overruled.

const boxAt = (x, y, w = 100, h = 100) => ({ type: 'note', x, y, w, h, meta: { text: 'n' } });
const geom = it => ({ x: it.x, y: it.y, w: it.w, h: it.h });

test('turning snapping on lays the board on the lattice', () => {
  fresh();
  const [a] = addItems([boxAt(17, -23, 100, 100)]);
  setSetting('snap', true);
  const it = byId(a.id);
  // Low edges a seam past a grid line, sides a whole number of cells less a seam
  // at each end - the resize rule, since laying out a board is the resize case,
  // not the drag case.
  const step = board.settings.gridStep;
  const inset = step * CELL_GAP;
  // Math.abs, because a negative coordinate divides to -0 and assert.equal is
  // strict enough to tell the two zeroes apart.
  assert.equal(Math.abs((it.x - it.w / 2 - inset) % step), 0, 'left edge off the lattice');
  assert.equal(Math.abs((it.y - it.h / 2 - inset) % step), 0, 'bottom edge off the lattice');
  assert.equal((it.w + 2 * inset) % step, 0);
  assert.equal((it.h + 2 * inset) % step, 0);
});

test('rechecking a snapped board repairs geometry that drifted off the lattice', () => {
  const [a] = addItems([boxAt(17, -23, 100, 100)]);
  setSetting('snap', true);
  const it = byId(a.id);
  it.x += 13;
  it.y -= 9;
  it.w += 7;

  recheckBoardGeometry();

  const step = board.settings.gridStep;
  const inset = step * CELL_GAP;
  assert.equal(Math.abs((it.x - it.w / 2 - inset) % step), 0);
  assert.equal(Math.abs((it.y - it.h / 2 - inset) % step), 0);
  assert.equal((it.w + 2 * inset) % step, 0);
  assert.equal((it.h + 2 * inset) % step, 0);
});

test('a snapped item is inset by the same seam on all four sides', () => {
  fresh();
  const step = board.settings.gridStep;
  const [a] = addItems([boxAt(0, 0, step * 3, step * 2)]);
  setSetting('snap', true);
  const it = byId(a.id);
  const inset = step * CELL_GAP;
  // Each edge's distance from the grid line just outside it. The old rule gave
  // the whole seam to the high edges and nothing to the low ones, so an item was
  // flush left and bottom and short right and top; every one of these is the
  // same number now.
  const off = (edge, sign) => {
    const line = Math.round((edge + sign * inset) / step) * step;
    return Math.abs(edge - line);
  };
  for (const gap of [
    off(it.x - it.w / 2, -1), off(it.x + it.w / 2, 1),
    off(it.y - it.h / 2, -1), off(it.y + it.h / 2, 1),
  ]) assert.ok(Math.abs(gap - inset) < 1e-6, `side was inset by ${gap}, wanted ${inset}`);
});

test('two snapped neighbours have a seam between them', () => {
  fresh();
  const step = board.settings.gridStep;
  // Two boxes a cell apart, so they land in adjoining blocks of cells.
  const [a, b] = addItems([boxAt(0, 0, step, step), boxAt(step, 0, step, step)]);
  setSetting('snap', true);
  const left = byId(a.id), right = byId(b.id);
  const seam = (right.x - right.w / 2) - (left.x + left.w / 2);
  // The whole point of the seam: side by side is not the same as joined, or two
  // photographs in adjoining cells read as one photograph with a crease in it.
  assert.ok(seam > 0, 'neighbours are touching');
  // Two halves of a seam, one from each item - which is the same total distance
  // the whole-seam-on-one-edge rule used to leave, and that is deliberate: the
  // change was to where the gap sits, not to how much of it there is.
  //
  // Within a rounding error: the seam is a fraction of the step and comes back
  // through two subtractions, so it lands on the last bit rather than exactly.
  assert.ok(Math.abs(seam - 2 * step * CELL_GAP) < 1e-6, `seam was ${seam}`);
});

test('turning snapping off puts everything back where it was', () => {
  fresh();
  const [a] = addItems([boxAt(17, -23, 90, 140)]);
  const was = geom(byId(a.id));
  setSetting('snap', true);
  assert.notDeepEqual(geom(byId(a.id)), was, 'nothing moved, so the test proves nothing');
  setSetting('snap', false);
  assert.deepEqual(geom(byId(a.id)), was);
});

test('an item moved while snapped keeps its new place', () => {
  fresh();
  const [a, b] = addItems([boxAt(17, -23), boxAt(300, 300)]);
  const bWas = geom(byId(b.id));
  setSetting('snap', true);

  // A hand placement, committed the way a drag commits.
  const before = snapshotGeom([a.id]);
  const it = byId(a.id);
  it.x = 512; it.y = 512;
  commitGeom('Move', before);

  setSetting('snap', false);
  assert.equal(byId(a.id).x, 512, 'the moved item was dragged back');
  assert.equal(byId(a.id).y, 512);
  assert.deepEqual(geom(byId(b.id)), bWas, 'the untouched item should have gone back');
});

test('snapping twice remembers life before the lattice, not the lattice', () => {
  fresh();
  const [a] = addItems([boxAt(17, -23, 90, 140)]);
  const was = geom(byId(a.id));
  setSetting('snap', true);
  setSetting('snap', false);
  setSetting('snap', true);
  setSetting('snap', false);
  assert.deepEqual(geom(byId(a.id)), was);
});

test('the snap is one undo step', () => {
  fresh();
  const [a] = addItems([boxAt(17, -23, 90, 140)]);
  const was = geom(byId(a.id));
  setSetting('snap', true);
  assert.ok(undo());
  assert.deepEqual(geom(byId(a.id)), was);
});

test('a board with nothing on it does not record an undo step', () => {
  fresh();
  setSetting('snap', true);
  assert.equal(undo(), false);
});

test('a memo that is not a box is ignored rather than written onto the item', () => {
  // What a hand-edited .mbrd can carry. Restoring from it would otherwise put
  // a string, or a zero size, straight onto the item's geometry.
  fresh([{ type: 'note', x: 40, y: 40, w: 100, h: 100,
           meta: { text: 'n', presnap: { x: 'left', y: 0, w: 100, h: 100 } } }]);
  const a = board.items[0];
  board.settings.snap = true;
  setSetting('snap', false);
  assert.equal(byId(a.id).x, 40);
  assert.ok(!byId(a.id).meta.presnap, 'the bad memo should have been dropped');
});

