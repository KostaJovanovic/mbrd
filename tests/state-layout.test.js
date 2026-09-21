// Snapping the whole board, and the two geometry profiles. state.ts is a
// module singleton, so every case starts by loading an empty board,
// exercising the reset too. One of six files split from tests/state.test.js
// to mirror state.ts's own split; see tests/layers.test.js.

import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

import {
  board, addItems, undo, byId, setSetting, snapshotGeom, commitGeom,
  recheckBoardGeometry, setBoardMode,
} from '../web/assets/js/state.ts';
import { CELL_GAP } from '../web/assets/js/geometry.ts';
import { fresh } from './state-fixtures.js';

beforeEach(() => {
  setBoardMode('desktop');
  fresh();
});
// ---------------------------------------------------------------------------
// Snapping the whole board
// ---------------------------------------------------------------------------
//
// Three halves, and the third is easy to get wrong: on lays everything on
// the lattice, off puts it back, and anything placed by hand in between
// keeps that placement rather than being dragged back.

const boxAt = (x, y, w = 100, h = 100) => ({ type: 'note', x, y, w, h, meta: { text: 'n' } });
const geom = it => ({ x: it.x, y: it.y, w: it.w, h: it.h });

test('turning snapping on lays the board on the lattice', () => {
  fresh();
  const [a] = addItems([boxAt(17, -23, 100, 100)]);
  setSetting('snap', true);
  const it = byId(a.id);
  // Low edges a seam past a grid line, sides a whole cell count less a seam
  // at each end - the resize rule, since laying out is the resize case.
  const step = board.settings.gridStep;
  const inset = step * CELL_GAP;
  // Math.abs: a negative coordinate divides to -0, and assert.equal tells
  // the two zeroes apart.
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
  // Each edge's distance from the grid line just outside it. The old rule
  // gave the whole seam to the high edges and nothing to the low ones; all
  // four are the same number now.
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
  // A cell apart, so they land in adjoining blocks of cells.
  const [a, b] = addItems([boxAt(0, 0, step, step), boxAt(step, 0, step, step)]);
  setSetting('snap', true);
  const left = byId(a.id), right = byId(b.id);
  const seam = (right.x - right.w / 2) - (left.x + left.w / 2);
  // The point of the seam: side by side is not joined, or two adjoining
  // photos read as one with a crease in it.
  assert.ok(seam > 0, 'neighbours are touching');
  // Two halves of a seam, one per item - the same total distance the old
  // whole-seam-on-one-edge rule left; only where the gap sits changed.
  // Within a rounding error, since the seam returns through two subtractions.
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

  // A hand placement, committed as a drag would.
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

test('raising a card keeps its memory of where it sat before the lattice', () => {
  // Bring to front rewrites only z, but commitGeom() gave up the presnap
  // memo on any GEOM_KEYS difference, z included - so raising a card on a
  // snapped board silently lost its pre-lattice place, with no way back.
  fresh();
  const [a] = addItems([boxAt(17, -23, 90, 140)]);
  setSetting('snap', true);
  const laid = geom(byId(a.id));
  const memo = { ...byId(a.id).meta.presnap };

  const before = snapshotGeom([a.id]);
  byId(a.id).z = 99;
  commitGeom('Bring to front', before, [a.id]);

  assert.deepEqual(byId(a.id).meta.presnap, memo, 'the memo survives a z-only commit');
  assert.deepEqual(geom(byId(a.id)), laid, 'and the card has not moved');
  setSetting('snap', false);
  assert.deepEqual(geom(byId(a.id)), { x: 17, y: -23, w: 90, h: 140 });
});

test('resizing a card on a snapped board does give up the memo', () => {
  // The other half - a card sized by hand on the lattice is saying that whole
  // cells are its size now, and there is no earlier size to go back to.
  fresh();
  const [a] = addItems([boxAt(17, -23, 90, 140)]);
  setSetting('snap', true);
  assert.ok(byId(a.id).meta.presnap, 'laid on the lattice, so there is a memo');

  const before = snapshotGeom([a.id]);
  byId(a.id).w += 64;
  commitGeom('Resize', before, [a.id]);

  assert.ok(!byId(a.id).meta.presnap, 'sized by hand, so the memo goes');
});

test('moving a card keeps the size it had before the lattice, at the new place', () => {
  // A drag changes no sides, and used to throw the whole memo away anyway. On a
  // Fit board that made the mats snapping rounds a picture card into permanent:
  // leaving the grid no longer gave the card its picture's proportion back.
  fresh();
  const [a] = addItems([boxAt(17, -23, 90, 140)]);
  setSetting('snap', true);
  const laid = geom(byId(a.id));

  const before = snapshotGeom([a.id]);
  byId(a.id).x += 128;
  commitGeom('Move', before, [a.id]);

  const memo = byId(a.id).meta.presnap;
  assert.ok(memo, 'the memo survives a move');
  assert.equal(memo.x, laid.x + 128, 'and it names where the card is now');
  assert.equal(memo.y, laid.y);
  assert.equal(memo.w, 90, 'with the size nobody touched');
  assert.equal(memo.h, 140);

  setSetting('snap', false);
  assert.deepEqual(geom(byId(a.id)),
    { x: laid.x + 128, y: laid.y, w: 90, h: 140 },
    'leaving the grid gives the size back where the card was put');
});

test('a memo that is not a box is ignored rather than written onto the item', () => {
  // A hand-edited .mbrd could carry a string or a zero size here; restoring
  // it must not write that straight onto the item's geometry.
  fresh([{ type: 'note', x: 40, y: 40, w: 100, h: 100,
           meta: { text: 'n', presnap: { x: 'left', y: 0, w: 100, h: 100 } } }]);
  const a = board.items[0];
  board.settings.snap = true;
  setSetting('snap', false);
  assert.equal(byId(a.id).x, 40);
  assert.ok(!byId(a.id).meta.presnap, 'the bad memo should have been dropped');
});

