// Fences: which card is inside which region, and what travels when one moves.
//
// The sibling of tests/state-sticky.test.js, and worth reading beside it - the
// two relations are deliberately parallel and differ in three places, each of
// which has a case here: containment is by centre rather than by area,
// membership is measured on Desktop geometry and nowhere else, and resizing a
// fence re-measures where resizing a photo does not.
//
// state.js is a module singleton, so every case starts by loading an empty
// board, which is the same door opening a .mbrd goes through.

import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

import {
  loadBoard, serializeBoard, addItems, removeItems, byId, select, board,
  fenceOf, fenceMembers, fenceFollowers, refence, isContent,
  stuckTo, stuckFollowers, snapshotGeom, applyGeom, commitGeom, undo,
  setBoardMode, raiseSelection, hasContent, ensureGhostCards, hasGhosts,
  mobileBoardWidth, baseStep, visualStackOrder,
} from '../web/assets/js/state.js';
import { mobileRuns, fenceBox, nextFenceName } from '../web/assets/js/fences.js';
import { itemBounds } from '../web/assets/js/geometry.js';
import { fresh, note, photo, fence } from './state-fixtures.js';

beforeEach(() => {
  setBoardMode('desktop');
  fresh();
});

/** Move things the way a drag does: apply, then close it into one undo entry. */
function drag(ids, dx, dy, driven = ids) {
  const before = snapshotGeom(ids);
  applyGeom(before.map(g => ({ ...g, x: g.x + dx, y: g.y + dy })));
  commitGeom('Move', before, driven);
}

/** Resize a fence the way a grip does. */
function resize(id, w, h) {
  const before = snapshotGeom([id]);
  applyGeom([{ ...before[0], w, h }]);
  commitGeom('Resize', before, [id]);
}

// ---------------------------------------------------------------------------
// Containment
// ---------------------------------------------------------------------------

test('a card whose centre is inside a fence is in it', () => {
  const [f] = addItems([fence({ x: 0, y: 0, w: 800, h: 600 })]);
  const [pic] = addItems([photo({ x: 100, y: 50 })]);
  assert.equal(fenceOf(byId(pic.id))?.id, f.id);
});

test('a card whose centre is outside is not, however much of it overlaps', () => {
  // The straddle. Half a metre of this card is over the fence, which under
  // sticky.js's area rule would stick it - and a region has edges, so it has to
  // land on exactly one side of this one.
  addItems([fence({ x: 0, y: 0, w: 800, h: 600 })]);
  const [pic] = addItems([photo({ x: 420, y: 0, w: 200, h: 200 })]);
  assert.equal(fenceOf(byId(pic.id)), null);
});

test('the smallest containing fence wins', () => {
  const [big] = addItems([fence({ x: 0, y: 0, w: 2000, h: 2000 })]);
  const [small] = addItems([fence({ x: 0, y: 0, w: 600, h: 600 })]);
  const [pic] = addItems([photo({ x: 0, y: 0 })]);
  assert.equal(fenceOf(byId(pic.id))?.id, small.id);
  // And the small fence is itself inside the big one, which is what makes this
  // a subsection rather than two fences arguing over a card.
  assert.equal(fenceOf(byId(small.id))?.id, big.id);
});

test('two fences the same size cannot contain each other', () => {
  // Containment needs strictly greater area. Without that the chain is not a
  // strict order and every walk over it could loop.
  const [a] = addItems([fence({ x: 0, y: 0, w: 800, h: 600 })]);
  const [b] = addItems([fence({ x: 0, y: 0, w: 800, h: 600 })]);
  assert.equal(fenceOf(byId(a.id)), null);
  assert.equal(fenceOf(byId(b.id)), null);
});

test('furniture is never in a fence', () => {
  const [f] = addItems([fence({ x: 0, y: 0, w: 4000, h: 4000 })]);
  ensureGhostCards();
  const ghost = board.items.find(i => i.type === 'ghost');
  assert.ok(ghost, 'the hints are on the board');
  assert.equal(fenceOf(ghost), null);
  assert.equal(fenceMembers(f.id).length, 0);
});

// ---------------------------------------------------------------------------
// What travels
// ---------------------------------------------------------------------------

test('moving a fence carries the cards inside it', () => {
  const [f] = addItems([fence({ x: 0, y: 0, w: 800, h: 600 })]);
  const [pic] = addItems([photo({ x: 100, y: 50 })]);
  assert.deepEqual(fenceFollowers([f.id]), [pic.id]);

  drag([f.id, pic.id], 1000, 0, [f.id]);
  assert.equal(byId(pic.id).x, 1100);
  assert.equal(fenceOf(byId(pic.id))?.id, f.id, 'still in it');
});

test('a fence dragged over a loose card does not swallow it', () => {
  // The memo earning its keep. Without it a fence would hoover up everything it
  // passed over, and the region you drew would not be the region you moved.
  const [f] = addItems([fence({ x: 0, y: 0, w: 800, h: 600 })]);
  const [stray] = addItems([photo({ x: 2000, y: 0 })]);
  assert.equal(fenceOf(byId(stray.id)), null);

  drag([f.id], 2000, 0, [f.id]);
  assert.equal(fenceOf(byId(stray.id)), null, 'it was passed over, not picked up');
  // And it really is inside the rectangle now, so the memo is what kept it out.
  refence([stray.id]);
  assert.equal(fenceOf(byId(stray.id))?.id, f.id, 'asked again, it would have joined');
});

test('a card dragged out of a fence is loose once it is put down', () => {
  const [f] = addItems([fence({ x: 0, y: 0, w: 800, h: 600 })]);
  const [pic] = addItems([photo({ x: 0, y: 0 })]);
  assert.equal(fenceOf(byId(pic.id))?.id, f.id);

  drag([pic.id], 3000, 0, [pic.id]);
  assert.equal(fenceOf(byId(pic.id)), null);
});

test('a card dragged into a fence joins it', () => {
  const [f] = addItems([fence({ x: 0, y: 0, w: 800, h: 600 })]);
  const [pic] = addItems([photo({ x: 3000, y: 0 })]);
  assert.equal(fenceOf(byId(pic.id)), null);

  drag([pic.id], -3000, 0, [pic.id]);
  assert.equal(fenceOf(byId(pic.id))?.id, f.id);
});

test('followers are transitive through a nested fence', () => {
  const [outer] = addItems([fence({ x: 0, y: 0, w: 3000, h: 3000 })]);
  const [inner] = addItems([fence({ x: 0, y: 0, w: 800, h: 600 })]);
  const [pic] = addItems([photo({ x: 0, y: 0 })]);
  const moving = fenceFollowers([outer.id]);
  assert.deepEqual([...moving].sort(), [inner.id, pic.id].sort());
});

test('something already moving is not also a follower', () => {
  const [f] = addItems([fence({ x: 0, y: 0, w: 800, h: 600 })]);
  const [pic] = addItems([photo({ x: 0, y: 0 })]);
  assert.deepEqual(fenceFollowers([f.id, pic.id]), []);
});

test('a note stuck to a card in a fence travels with the fence', () => {
  // The fixed point. Neither relation can see this on its own: fenceFollowers
  // does not know the note is stuck to the photo, and stuckFollowers does not
  // know the photo is in the fence.
  const [f] = addItems([fence({ x: 0, y: 0, w: 900, h: 700 })]);
  const [pic] = addItems([photo({ x: 0, y: 0, w: 300, h: 300 })]);
  const [n] = addItems([note({ x: 0, y: 0, w: 80, h: 80 })]);
  assert.equal(stuckTo(byId(n.id))?.id, pic.id);
  assert.equal(fenceOf(byId(pic.id))?.id, f.id);

  const closure = ids => {
    const out = [...ids];
    for (let grew = true; grew;) {
      grew = false;
      for (const id of [...stuckFollowers(out), ...fenceFollowers(out)]) {
        if (out.includes(id)) continue;
        out.push(id);
        grew = true;
      }
    }
    return out;
  };
  const moving = closure([f.id]);
  assert.deepEqual([...moving].sort(), [f.id, pic.id, n.id].sort());
  // Exactly once each - a double entry would move the note twice as far.
  assert.equal(new Set(moving).size, moving.length);
});

// ---------------------------------------------------------------------------
// The resize rule, which is where fences and stickies part company
// ---------------------------------------------------------------------------

test('growing a fence takes in what it now covers', () => {
  const [f] = addItems([fence({ x: 0, y: 0, w: 400, h: 400 })]);
  const [pic] = addItems([photo({ x: 500, y: 0 })]);
  assert.equal(fenceOf(byId(pic.id)), null);

  resize(f.id, 2000, 400);
  assert.equal(fenceOf(byId(pic.id))?.id, f.id, 'the edge was dragged over it');
});

test('shrinking a fence lets go of what it no longer covers', () => {
  const [f] = addItems([fence({ x: 0, y: 0, w: 2000, h: 400 })]);
  const [pic] = addItems([photo({ x: 800, y: 0 })]);
  assert.equal(fenceOf(byId(pic.id))?.id, f.id);

  resize(f.id, 400, 400);
  assert.equal(fenceOf(byId(pic.id)), null);
});

test('resizing a fence leaves cards outside both rectangles alone', () => {
  // The bound on the rule: a resize in one corner of the board must not
  // re-parent the other corner.
  const [near] = addItems([fence({ x: 0, y: 0, w: 400, h: 400 })]);
  const [far] = addItems([fence({ x: 5000, y: 0, w: 900, h: 900 })]);
  const [pic] = addItems([photo({ x: 5000, y: 0 })]);
  assert.equal(fenceOf(byId(pic.id))?.id, far.id);

  resize(near.id, 800, 800);
  assert.equal(fenceOf(byId(pic.id))?.id, far.id, 'untouched, and not re-measured');
});

test('resizing a photo does not re-parent what is lying on it', () => {
  // The other half of the same rule, kept honest: only a *fence* re-measures on
  // resize. A photograph's edges are incidental to what is over it.
  const [f] = addItems([fence({ x: 0, y: 0, w: 800, h: 600 })]);
  const [pic] = addItems([photo({ x: 0, y: 0, w: 200, h: 200 })]);
  const [stray] = addItems([photo({ x: 2000, y: 0, w: 200, h: 200 })]);
  assert.equal(fenceOf(byId(stray.id)), null);

  resize(pic.id, 400, 400);
  assert.equal(fenceOf(byId(stray.id)), null);
  assert.equal(fenceOf(byId(pic.id))?.id, f.id);
});

// ---------------------------------------------------------------------------
// Z-order
// ---------------------------------------------------------------------------

test('raising a fence carries its cards and stays behind them', () => {
  const [f] = addItems([fence({ x: 0, y: 0, w: 800, h: 600, z: 1 })]);
  const [pic] = addItems([photo({ x: 0, y: 0, z: 2 })]);
  const [other] = addItems([photo({ x: 4000, y: 0, z: 9 })]);

  select([f.id]);
  raiseSelection();
  assert.ok(byId(f.id).z > byId(other.id).z, 'the fence came forward');
  assert.ok(byId(pic.id).z > byId(f.id).z, 'and its card is still in front of it');
});

// ---------------------------------------------------------------------------
// Delete
// ---------------------------------------------------------------------------

test('deleting a fence leaves its cards exactly where they were', () => {
  const [f] = addItems([fence({ x: 0, y: 0, w: 800, h: 600 })]);
  const [pic] = addItems([photo({ x: 100, y: 50 })]);

  removeItems([f.id]);
  assert.equal(byId(pic.id).x, 100, 'it did not move');
  assert.equal(byId(pic.id).y, 50);
  assert.equal(fenceOf(byId(pic.id)), null, 'and it is loose');
});

test('undoing the delete brings the grouping back with nothing recorded', () => {
  const [f] = addItems([fence({ x: 0, y: 0, w: 800, h: 600 })]);
  const [pic] = addItems([photo({ x: 100, y: 50 })]);
  removeItems([f.id]);
  assert.equal(fenceOf(byId(pic.id)), null);

  undo();
  assert.equal(fenceOf(byId(pic.id))?.id, f.id, 'inside it again because it is inside it');
});

// ---------------------------------------------------------------------------
// A fence is not content
// ---------------------------------------------------------------------------

test('a board holding nothing but fences is holding nothing', () => {
  addItems([fence({ x: 0, y: 0 })]);
  assert.equal(hasContent(), false);
  assert.equal(isContent(board.items[0]), false);
  ensureGhostCards();
  assert.equal(hasGhosts(), true, 'the hints have not been earned away');
});

test('a card in a fence is still content', () => {
  addItems([fence({ x: 0, y: 0, w: 800, h: 600 })]);
  addItems([photo({ x: 0, y: 0 })]);
  assert.equal(hasContent(), true);
});

// ---------------------------------------------------------------------------
// The file, and the Desktop-only measurement rule
// ---------------------------------------------------------------------------

test('membership is stamped into the file and seeded back out of it', () => {
  const [f] = addItems([fence({ x: 0, y: 0, w: 800, h: 600 })]);
  const [pic] = addItems([photo({ x: 100, y: 50 })]);
  const file = serializeBoard();

  const stored = file.items.find(i => i.id === pic.id);
  assert.equal(stored.meta.fence, f.id);
  const storedFence = file.items.find(i => i.id === f.id);
  assert.ok(!('fence' in storedFence.meta), 'a top-level fence names none');

  loadBoard(file);
  assert.equal(fenceOf(byId(pic.id))?.id, f.id);
});

test('a loose card carries no fence key at all', () => {
  addItems([photo({ x: 0, y: 0 })]);
  const file = serializeBoard();
  assert.ok(!('fence' in file.items[0].meta), 'absent means loose');
});

test('a card dragged out does not keep the key it arrived with', () => {
  const [f] = addItems([fence({ x: 0, y: 0, w: 800, h: 600 })]);
  const [pic] = addItems([photo({ x: 0, y: 0 })]);
  loadBoard(serializeBoard());
  assert.equal(fenceOf(byId(pic.id))?.id, f.id);

  drag([pic.id], 3000, 0, [pic.id]);
  const file = serializeBoard();
  const stored = file.items.find(i => i.id === pic.id);
  assert.ok(!('fence' in stored.meta), 'the stale key was deleted, not carried');
});

test('a fence id naming nothing falls through to measuring', () => {
  const [f] = addItems([fence({ x: 0, y: 0, w: 800, h: 600 })]);
  const [pic] = addItems([photo({ x: 0, y: 0 })]);
  const file = serializeBoard();
  // The fence never made it into the file, which is what a hand-edit or a
  // half-finished merge looks like. The layout records for it need no cleaning:
  // normalizeLayout() drops any geometry naming an id the file does not carry.
  file.items = file.items.filter(i => i.id !== f.id);

  loadBoard(file);
  assert.equal(fenceOf(byId(pic.id)), null, 'measured, and there is nothing to be in');
});

test('membership survives a Desktop to Mobile and back round trip with a save', () => {
  // The rule that is easiest to get wrong and worst to get wrong. On Mobile a
  // fence is a band with its members packed *under* it, so nothing is
  // geometrically inside its fence there - a measurement taken in that layout
  // would find every fence empty and then save that.
  const [f] = addItems([fence({ x: 0, y: 0, w: 900, h: 700 })]);
  const [pic] = addItems([photo({ x: 100, y: 50 })]);
  assert.equal(fenceOf(byId(pic.id))?.id, f.id);

  setBoardMode('mobile');
  assert.equal(fenceOf(byId(pic.id))?.id, f.id, 'the phone reads it, it does not compute it');
  loadBoard(serializeBoard());
  assert.equal(fenceOf(byId(pic.id))?.id, f.id, 'and a save from Mobile keeps it');

  setBoardMode('desktop');
  assert.equal(fenceOf(byId(pic.id))?.id, f.id);
});

// ---------------------------------------------------------------------------
// The Mobile column: bands and runs
// ---------------------------------------------------------------------------

test('a board with no fences packs into one bandless run', () => {
  // Every board saved until now is this board, and it must come back unchanged.
  const items = [photo({ id: 'a' }), photo({ id: 'b' })];
  const runs = mobileRuns(items);
  assert.equal(runs.length, 1);
  assert.equal(runs[0].band, null);
  assert.deepEqual(runs[0].items.map(i => i.id), ['a', 'b']);
});

test('a run holds its fence members and the loose cards come last', () => {
  const [f] = addItems([fence({ x: 0, y: 0, w: 900, h: 700 })]);
  const [inside] = addItems([photo({ x: 0, y: 0 })]);
  const [outside] = addItems([photo({ x: 4000, y: 0 })]);

  const runs = mobileRuns(board.items);
  assert.equal(runs.length, 2);
  assert.equal(runs[0].band.id, f.id);
  assert.deepEqual(runs[0].items.map(i => i.id), [inside.id]);
  assert.equal(runs[1].band, null);
  assert.deepEqual(runs[1].items.map(i => i.id), [outside.id]);
});

test('a nested fence becomes its own band after its parent', () => {
  const [outer] = addItems([fence({ x: 0, y: 0, w: 3000, h: 3000 })]);
  const [direct] = addItems([photo({ x: 1200, y: 1200 })]);
  const [inner] = addItems([fence({ x: 0, y: 0, w: 800, h: 600 })]);
  const [deep] = addItems([photo({ x: 0, y: 0 })]);

  // No trailing bandless run, because nothing here is loose - every card is in
  // one of the two fences.
  const runs = mobileRuns(board.items);
  assert.deepEqual(runs.map(r => r.band?.id ?? null), [outer.id, inner.id]);
  assert.deepEqual(runs[0].items.map(i => i.id), [direct.id]);
  assert.deepEqual(runs[1].items.map(i => i.id), [deep.id]);
});

test('a run ranks where its earliest member does, not where its fence does', () => {
  // The fence is added last and still leads the column, because the card it
  // holds is the first thing in the order handed in.
  const early = photo({ id: 'early' });
  const late = photo({ id: 'late' });
  const f = fence({ id: 'f', x: 0, y: 0, w: 900, h: 700 });
  addItems([f, early, late]);
  applyGeom([{ ...snapshotGeom(['late'])[0], x: 4000 }]);
  refence(['early', 'late']);

  const runs = mobileRuns([byId('early'), byId('late'), byId('f')]);
  assert.equal(runs[0].band.id, 'f');
  assert.deepEqual(runs[0].items.map(i => i.id), ['early']);
});

test('the band spans the column and every member sits below it', () => {
  const [f] = addItems([fence({ x: 0, y: 0, w: 900, h: 700 })]);
  const [a] = addItems([photo({ x: -200, y: 0, w: 200, h: 200 })]);
  const [b] = addItems([photo({ x: 200, y: 0, w: 200, h: 200 })]);
  const [loose] = addItems([photo({ x: 5000, y: 0, w: 200, h: 200 })]);

  setBoardMode('mobile');
  const band = byId(f.id);
  const width = mobileBoardWidth(baseStep());
  assert.ok(band.w > width * 0.8, 'the band is the column, not a card in it');
  const top = it => it.y + it.h / 2;
  const bottom = it => it.y - it.h / 2;
  assert.ok(top(byId(a.id)) <= bottom(band) + 1e-6, 'a is under the band');
  assert.ok(top(byId(b.id)) <= bottom(band) + 1e-6, 'b is under the band');
  // The barrier: nothing outside the run may climb into a gap beside its cards.
  const runFloor = Math.min(bottom(byId(a.id)), bottom(byId(b.id)));
  assert.ok(top(byId(loose.id)) <= runFloor + 1e-6, 'the loose card stayed below the run');
});

test('two runs do not interleave', () => {
  addItems([fence({ id: 'f1', x: 0, y: 0, w: 900, h: 700 })]);
  const [big] = addItems([photo({ x: 0, y: 0, w: 200, h: 200 })]);
  const [f2] = addItems([fence({ id: 'f2', x: 5000, y: 0, w: 900, h: 700 })]);
  const [small] = addItems([photo({ x: 5000, y: 0, w: 100, h: 100 })]);

  setBoardMode('mobile');
  const bottom = it => it.y - it.h / 2;
  const top = it => it.y + it.h / 2;
  // The second band, and everything under it, is entirely below the first run.
  assert.ok(top(byId(f2.id)) <= bottom(byId(big.id)) + 1e-6,
    'the second band did not fit itself beside the first run');
  assert.ok(top(byId(small.id)) <= bottom(byId(f2.id)) + 1e-6);
});

test('a stuck note rides its host instead of taking a slot in the run', () => {
  addItems([fence({ x: 0, y: 0, w: 900, h: 700 })]);
  const [pic] = addItems([photo({ x: 0, y: 0, w: 300, h: 300 })]);
  const [n] = addItems([note({ x: 0, y: 0, w: 80, h: 80 })]);
  assert.equal(stuckTo(byId(n.id))?.id, pic.id);

  setBoardMode('mobile');
  const host = byId(pic.id);
  const rider = byId(n.id);
  assert.ok(rider.x >= host.x - host.w / 2 - 1 && rider.x <= host.x + host.w / 2 + 1,
    'the note is on its host, not in a slot of its own');
});

// ---------------------------------------------------------------------------
// The box a new fence gets
//
// Pure arithmetic over two optional rectangles, and the one place where drawing
// a fence and measuring one meet: whatever comes out of here has to satisfy the
// containment rule at the top of this file on the very first question asked of
// it. The cases that matter are the asymmetries - the drawn rectangle is taken
// as drawn, the items get a margin, and neither is allowed to lose.
// ---------------------------------------------------------------------------

test('a drawn rectangle alone becomes exactly that rectangle', () => {
  const box = fenceBox({ x0: -100, y0: -50, x1: 300, y1: 150 }, null, 40);
  assert.deepEqual(box, { x: 100, y: 50, w: 400, h: 200 });
});

test('a selection alone gets a step of margin on every side', () => {
  const box = fenceBox(null, { x0: 0, y0: 0, x1: 200, y1: 100 }, 40);
  assert.deepEqual(box, { x: 100, y: 50, w: 280, h: 180 });
});

test('nothing to go on is not a fence', () => {
  assert.equal(fenceBox(null, null, 40), null);
});

test('a card poking out of the band it was caught by is still enclosed', () => {
  // The case the union exists for. itemInRect() catches anything the band
  // *overlaps*, so a wide photo can be selected by a rectangle that ends well
  // inside it - and a fence cut to the rectangle would open not containing its
  // own contents, which is the one state the whole feature must not start in.
  const box = fenceBox({ x0: 0, y0: 0, x1: 100, y1: 100 }, { x0: 0, y0: 0, x1: 400, y1: 100 }, 10);
  assert.equal(box.x + box.w / 2, 410, 'the fence reaches past the band to hold the card');
  assert.equal(box.x - box.w / 2, -10);
});

test('a band drawn wider than its catch keeps the width somebody drew', () => {
  const box = fenceBox({ x0: -500, y0: -500, x1: 500, y1: 500 }, { x0: 0, y0: 0, x1: 10, y1: 10 }, 40);
  assert.deepEqual(box, { x: 0, y: 0, w: 1000, h: 1000 });
});

test('the box a selection gets holds every card it was measured from', () => {
  // Straight through the real predicate rather than by arithmetic: what makes
  // this box right is that fenceOf() agrees with it.
  const [a] = addItems([photo({ x: -300, y: -200, w: 200, h: 200 })]);
  const [b] = addItems([photo({ x: 400, y: 250, w: 300, h: 100 })]);
  const box = fenceBox(null, itemBounds([byId(a.id), byId(b.id)]), baseStep());
  const [f] = addItems([fence(box)]);
  refence([a.id, b.id]);
  assert.equal(fenceOf(byId(a.id))?.id, f.id);
  assert.equal(fenceOf(byId(b.id))?.id, f.id);
});

// ---------------------------------------------------------------------------
// The name a fence opens with
// ---------------------------------------------------------------------------

test('the first fence on a board is number one', () => {
  assert.equal(nextFenceName(), 'Untitled fence 1');
});

test('the number counts up past whatever is already there', () => {
  addItems([fence({ x: 0, y: 0, w: 400, h: 400, name: 'Untitled fence 1' })]);
  addItems([fence({ x: 2000, y: 0, w: 400, h: 400, name: 'Untitled fence 2' })]);
  assert.equal(nextFenceName(), 'Untitled fence 3');
});

test('a fence somebody named does not hold a number down', () => {
  addItems([fence({ x: 0, y: 0, w: 400, h: 400, name: 'Colour studies' })]);
  assert.equal(nextFenceName(), 'Untitled fence 1');
});

test('a deleted number is not handed out again', () => {
  // One past the highest, not the lowest free. Filling the gap would give a new
  // region a name a different region had last week.
  addItems([fence({ x: 0, y: 0, w: 400, h: 400, name: 'Untitled fence 1' })]);
  const [second] = addItems([fence({ x: 2000, y: 0, w: 400, h: 400, name: 'Untitled fence 2' })]);
  addItems([fence({ x: 4000, y: 0, w: 400, h: 400, name: 'Untitled fence 3' })]);
  removeItems([second.id]);
  assert.equal(nextFenceName(), 'Untitled fence 4');
});

test('only fences are counted', () => {
  addItems([photo({ x: 0, y: 0, name: 'Untitled fence 7' })]);
  assert.equal(nextFenceName(), 'Untitled fence 1');
});

// ---------------------------------------------------------------------------
// The fence band
//
// "A fence is behind its cards" used to be an arrangement - a new fence took a z
// below every card it enclosed - and an arrangement is true when it is made and
// not afterwards. visualStackOrder() puts every fence in a band under every card
// instead, which cannot drift because there is nothing stored to drift.
// ---------------------------------------------------------------------------

test('a fence is painted behind a card that was already lower than it', () => {
  // The bug this band exists for. The photo is at the bottom of the board and
  // the fence is drawn over it later, so the fence has the higher raw z - and
  // under the old rule it covered the very card it had just picked up.
  const [pic] = addItems([photo({ x: 0, y: 0, z: -50 })]);
  const [f] = addItems([fence({ x: 0, y: 0, w: 900, h: 700, z: 10 })]);
  assert.equal(fenceOf(byId(pic.id))?.id, f.id, 'it is in the fence');
  const order = visualStackOrder();
  assert.ok(order.indexOf(f.id) < order.indexOf(pic.id), 'and behind it');
});

test('a fence grown out over a card ends up behind it', () => {
  // The gesture from the other end: the card is nowhere near the fence and has a
  // z of its own, and the resize is what picks it up.
  const [f] = addItems([fence({ x: 0, y: 0, w: 400, h: 400 })]);
  const [pic] = addItems([photo({ x: 900, y: 0 })]);
  assert.equal(fenceOf(byId(pic.id)), null);

  resize(f.id, 2400, 400);
  assert.equal(fenceOf(byId(pic.id))?.id, f.id, 'the resize picked it up');
  const order = visualStackOrder();
  assert.ok(order.indexOf(f.id) < order.indexOf(pic.id), 'and it did not bury it');
});

test('every fence is under every card, whatever their z says', () => {
  addItems([photo({ id: 'p1', x: 0, y: 0, z: -900 })]);
  addItems([fence({ id: 'f1', x: 0, y: 0, w: 900, h: 700, z: 900 })]);
  addItems([photo({ id: 'p2', x: 4000, y: 0, z: -800 })]);
  addItems([fence({ id: 'f2', x: 4000, y: 0, w: 900, h: 700, z: 800 })]);
  const order = visualStackOrder();
  const lastFence = Math.max(order.indexOf('f1'), order.indexOf('f2'));
  const firstCard = Math.min(order.indexOf('p1'), order.indexOf('p2'));
  assert.ok(lastFence < firstCard, 'the bands do not interleave');
});

test('a note still sits on top of everything', () => {
  // Three bands, not two: the note band is above the card band exactly as it was.
  const [f] = addItems([fence({ x: 0, y: 0, w: 900, h: 700 })]);
  const [pic] = addItems([photo({ x: 0, y: 0, w: 300, h: 300 })]);
  const [n] = addItems([note({ x: 0, y: 0, w: 80, h: 80 })]);
  assert.deepEqual(visualStackOrder(), [f.id, pic.id, n.id]);
});

test('a fence inside a fence is painted in front of the one holding it', () => {
  // z cannot express this: the inner fence needs to be under its own cards and
  // over its parent, and on a board a whole number apart there is no such value -
  // so both came out at the same z and which name you could read was a coin toss.
  // Area settles it, because containment already requires strictly more of it.
  const [outer] = addItems([fence({ x: 0, y: 0, w: 2000, h: 1600, z: -1 })]);
  const [inner] = addItems([fence({ x: 0, y: 0, w: 600, h: 400, z: -1 })]);
  assert.equal(fenceOf(byId(inner.id))?.id, outer.id, 'it is nested');
  const order = visualStackOrder();
  assert.ok(order.indexOf(outer.id) < order.indexOf(inner.id));
});

test('the fence band ignores raw z only where nesting decides it', () => {
  // Same size, so neither can hold the other: raw z is still what orders them,
  // and Bring to front still means something between two overlapping regions.
  addItems([fence({ id: 'a', x: 0, y: 0, w: 800, h: 600, z: -5 })]);
  addItems([fence({ id: 'b', x: 100, y: 0, w: 800, h: 600, z: -2 })]);
  const order = visualStackOrder();
  assert.ok(order.indexOf('a') < order.indexOf('b'));
});

test('raising a fence carries its cards and stays under them', () => {
  const [f] = addItems([fence({ x: 0, y: 0, w: 900, h: 700 })]);
  const [pic] = addItems([photo({ x: 0, y: 0, w: 300, h: 300 })]);
  const [other] = addItems([photo({ x: 4000, y: 0 })]);
  select([f.id]);
  raiseSelection();

  const order = visualStackOrder();
  assert.ok(order.indexOf(f.id) < order.indexOf(pic.id), 'still behind its own card');
  assert.ok(order.indexOf(other.id) < order.indexOf(pic.id),
    'and its card came forward with it');
});
