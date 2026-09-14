// Fences: which card is inside which region, and what travels when one moves.
//
// Sibling of tests/state-sticky.test.js - the two relations are deliberately
// parallel and differ in three places, each with a case here: containment
// by centre not area, membership measured on Desktop geometry only, and
// resizing a fence re-measures where resizing a photo does not.
//
// state.ts is a module singleton, so every case starts by loading an empty
// board, the same door a .mbrd opens through.

import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

import {
  loadBoard, serializeBoard, addItems, removeItems, byId, select, board,
  fenceOf, fenceMembers, fenceFollowers, refence, isContent,
  stuckTo, travelling, snapshotGeom, applyGeom, commitGeom, undo,
  setBoardMode, raiseSelection, hasContent, ensureGhostCards, hasGhosts,
  mobileBoardWidth, baseStep, visualStackOrder,
} from '../web/assets/js/state.ts';
import { mobileRuns, fenceBox, nextFenceName } from '../web/assets/js/fences.ts';
import { sharedFence } from '../web/assets/js/commands.ts';
import { itemBounds } from '../web/assets/js/geometry.ts';
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
  // The straddle: half a metre of this card is over the fence, which under
  // sticky.ts's area rule would stick it - a region has edges, so it lands
  // on exactly one side.
  addItems([fence({ x: 0, y: 0, w: 800, h: 600 })]);
  const [pic] = addItems([photo({ x: 420, y: 0, w: 200, h: 200 })]);
  assert.equal(fenceOf(byId(pic.id)), null);
});

test('the smallest containing fence wins', () => {
  const [big] = addItems([fence({ x: 0, y: 0, w: 2000, h: 2000 })]);
  const [small] = addItems([fence({ x: 0, y: 0, w: 600, h: 600 })]);
  const [pic] = addItems([photo({ x: 0, y: 0 })]);
  assert.equal(fenceOf(byId(pic.id))?.id, small.id);
  // The small fence is itself inside the big one - a subsection, not two
  // fences arguing over a card.
  assert.equal(fenceOf(byId(small.id))?.id, big.id);
});

test('two fences the same size cannot contain each other', () => {
  // Containment needs strictly greater area, or the chain isn't a strict
  // order and every walk over it could loop.
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
  // The memo earning its keep - without it a fence hoovers up everything it
  // passes over.
  const [f] = addItems([fence({ x: 0, y: 0, w: 800, h: 600 })]);
  const [stray] = addItems([photo({ x: 2000, y: 0 })]);
  assert.equal(fenceOf(byId(stray.id)), null);

  drag([f.id], 2000, 0, [f.id]);
  assert.equal(fenceOf(byId(stray.id)), null, 'it was passed over, not picked up');
  // It really is inside the rectangle now - the memo is what kept it out.
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
  // The fixed point: neither relation sees this alone - fenceFollowers
  // doesn't know the note is stuck to the photo, stuckFollowers doesn't know
  // the photo is in the fence.
  const [f] = addItems([fence({ x: 0, y: 0, w: 900, h: 700 })]);
  const [pic] = addItems([photo({ x: 0, y: 0, w: 300, h: 300 })]);
  const [n] = addItems([note({ x: 0, y: 0, w: 80, h: 80 })]);
  assert.equal(stuckTo(byId(n.id))?.id, pic.id);
  assert.equal(fenceOf(byId(pic.id))?.id, f.id);

  const moving = travelling([f.id]);
  assert.deepEqual([...moving].sort(), [f.id, pic.id, n.id].sort());
  // Once each - a double entry would move the note twice as far.
  assert.equal(new Set(moving).size, moving.length);
});

test('and the closure goes down only - a card does not travel with its region', () => {
  // The property both readers of travelling() stand on: a drag of one card
  // must not tow the fence around it - the same statement canvas/items.ts's
  // hover lift makes, pointing at a card lifts the card, pointing at the
  // region lifts everything in it.
  addItems([fence({ x: 0, y: 0, w: 900, h: 700 })]);
  const [pic] = addItems([photo({ x: 0, y: 0, w: 300, h: 300 })]);
  const [n] = addItems([note({ x: 0, y: 0, w: 80, h: 80 })]);

  assert.deepEqual(travelling([pic.id]).sort(), [pic.id, n.id].sort());
  assert.deepEqual(travelling([n.id]), [n.id]);
});

// ---------------------------------------------------------------------------
// When the band's offer stands down
//
// A band inside a region is how you get at some of what's in it, so the
// offer to fence what it caught must tell a new grouping from a reach-into.
// sharedFence() is that test; cmds.fencePrompt reads it and returns without
// opening anything.
// ---------------------------------------------------------------------------

test('cards all from one region propose nothing - the region is already there', () => {
  const [f] = addItems([fence({ x: 0, y: 0, w: 2000, h: 2000 })]);
  const [a] = addItems([photo({ x: -300, y: 0 })]);
  const [b] = addItems([photo({ x: 300, y: 0 })]);
  assert.equal(sharedFence([byId(a.id), byId(b.id)])?.id, f.id);
});

test('but a band that reached outside one has caught a new grouping', () => {
  addItems([fence({ x: 0, y: 0, w: 800, h: 800 })]);
  const [inside] = addItems([photo({ x: 0, y: 0 })]);
  const [outside] = addItems([photo({ x: 3000, y: 0 })]);
  assert.equal(sharedFence([byId(inside.id), byId(outside.id)]), null);
});

test('two regions worth of cards are not one region', () => {
  const [left] = addItems([fence({ x: -2000, y: 0, w: 800, h: 800 })]);
  const [right] = addItems([fence({ x: 2000, y: 0, w: 800, h: 800 })]);
  const [a] = addItems([photo({ x: -2000, y: 0 })]);
  const [b] = addItems([photo({ x: 2000, y: 0 })]);
  assert.equal(fenceOf(byId(a.id))?.id, left.id);
  assert.equal(fenceOf(byId(b.id))?.id, right.id);
  assert.equal(sharedFence([byId(a.id), byId(b.id)]), null);
});

test('a band that swallowed the region itself still offers to fence it', () => {
  // The region is one of the caught items, and its own fence isn't itself -
  // so the set shares none, and a fence round a fence stays available.
  const [f] = addItems([fence({ x: 0, y: 0, w: 800, h: 800 })]);
  const [pic] = addItems([photo({ x: 0, y: 0 })]);
  assert.equal(sharedFence([byId(f.id), byId(pic.id)]), null);
});

test('loose cards propose a region, which is the offer\'s whole job', () => {
  const [a] = addItems([photo({ x: 0, y: 0 })]);
  const [b] = addItems([photo({ x: 900, y: 0 })]);
  assert.equal(sharedFence([byId(a.id), byId(b.id)]), null);
  assert.equal(sharedFence([]), null);
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
  // A resize in one corner of the board must not re-parent the other.
  const [near] = addItems([fence({ x: 0, y: 0, w: 400, h: 400 })]);
  const [far] = addItems([fence({ x: 5000, y: 0, w: 900, h: 900 })]);
  const [pic] = addItems([photo({ x: 5000, y: 0 })]);
  assert.equal(fenceOf(byId(pic.id))?.id, far.id);

  resize(near.id, 800, 800);
  assert.equal(fenceOf(byId(pic.id))?.id, far.id, 'untouched, and not re-measured');
});

test('resizing a photo does not re-parent what is lying on it', () => {
  // Only a fence re-measures on resize - a photo's edges are incidental to
  // what's over it.
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

test('a fences-only board still shows its hints after a save and a reload', () => {
  // loadBoard() arms the ghost latch from `type !== 'title'` rather than
  // isContent(), so a board of nothing but regions came back latched as
  // though it had content, and the hints never appeared again that session.
  addItems([fence({ x: 0, y: 0 })]);
  const file = serializeBoard();
  loadBoard(file);
  assert.equal(hasContent(), false, 'still a board holding nothing');
  ensureGhostCards();
  assert.equal(hasGhosts(), true, 'so it still gets told what to do with it');
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
  // The fence never made it into the file, as a hand-edit or half-finished
  // merge looks like - normalizeLayout() drops geometry naming an absent id.
  file.items = file.items.filter(i => i.id !== f.id);

  loadBoard(file);
  assert.equal(fenceOf(byId(pic.id)), null, 'measured, and there is nothing to be in');
});

test('membership survives a Desktop to Mobile and back round trip with a save', () => {
  // On Mobile a fence is a band with members packed under it, so nothing is
  // geometrically inside its fence there - measuring in that layout would
  // find every fence empty and save that.
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
  // Every board saved until now is this board - it must come back unchanged.
  const items = [photo({ id: 'a' }), photo({ id: 'b' })];
  const runs = mobileRuns(items);
  assert.equal(runs.length, 1);
  assert.equal(runs[0].band, null);
  assert.deepEqual(runs[0].items.map(i => i.id), ['a', 'b']);
});

test('a run holds its fence members and the loose card after it follows', () => {
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

test('fence runs and loose cards interleave in the order handed in', () => {
  // The maintainer's rule (research/todo-2026-09-14.md): fences have no
  // priority, so the column reads loose cards, a fence, more loose cards,
  // another fence - never every fence first or every loose card last.
  addItems([
    fence({ id: 'f1', x: 0, y: 0, w: 900, h: 700 }),
    fence({ id: 'f2', x: 8000, y: 0, w: 900, h: 700 }),
  ]);
  addItems([
    photo({ id: 'a', x: -4000, y: 0 }),
    photo({ id: 'in1', x: 0, y: 0 }),
    photo({ id: 'b', x: 4000, y: 0 }),
    photo({ id: 'c', x: 5000, y: 0 }),
    photo({ id: 'in2', x: 8000, y: 0 }),
    photo({ id: 'd', x: 12000, y: 0 }),
  ]);
  const order = ['a', 'in1', 'b', 'c', 'in2', 'd', 'f1', 'f2'].map(byId);

  const runs = mobileRuns(order);
  assert.deepEqual(runs.map(r => [r.band?.id ?? null, r.items.map(i => i.id)]), [
    [null, ['a']],
    ['f1', ['in1']],
    [null, ['b', 'c']],
    ['f2', ['in2']],
    [null, ['d']],
  ]);
});

test('every member of a fence sits in one run, however the order scatters them', () => {
  // A By-name or Tight-fit order puts a loose card between two members. The
  // run gathers them at the earliest member and the loose card follows it.
  addItems([fence({ id: 'f', x: 0, y: 0, w: 900, h: 700 })]);
  addItems([
    photo({ id: 'm1', x: -200, y: 0 }),
    photo({ id: 'loose', x: 4000, y: 0 }),
    photo({ id: 'm2', x: 200, y: 0 }),
  ]);

  const runs = mobileRuns(['m1', 'loose', 'm2', 'f'].map(byId));
  assert.deepEqual(runs.map(r => [r.band?.id ?? null, r.items.map(i => i.id)]), [
    ['f', ['m1', 'm2']],
    [null, ['loose']],
  ]);
});

test('a nested fence becomes its own band after its parent', () => {
  const [outer] = addItems([fence({ x: 0, y: 0, w: 3000, h: 3000 })]);
  const [direct] = addItems([photo({ x: 1200, y: 1200 })]);
  const [inner] = addItems([fence({ x: 0, y: 0, w: 800, h: 600 })]);
  const [deep] = addItems([photo({ x: 0, y: 0 })]);

  // No trailing bandless run - every card is in one of the two fences.
  const runs = mobileRuns(board.items);
  assert.deepEqual(runs.map(r => r.band?.id ?? null), [outer.id, inner.id]);
  assert.deepEqual(runs[0].items.map(i => i.id), [direct.id]);
  assert.deepEqual(runs[1].items.map(i => i.id), [deep.id]);
});

test('a run ranks where its earliest member does, not where its fence does', () => {
  // The fence is added last but still leads the column, since the card it
  // holds is first in the order handed in.
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
  // Nothing outside the run may climb into a gap beside its cards.
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
  // The second band, and everything under it, sits entirely below the first run.
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
// Pure arithmetic over two optional rectangles, where drawing a fence and
// measuring one meet: what comes out must satisfy the containment rule
// immediately. The asymmetries matter - the drawn rectangle is taken as
// drawn, items get a margin, and neither is allowed to lose.
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
  // The case the union exists for: itemInRect() catches anything the band
  // overlaps, so a wide photo can be selected by a rectangle ending well
  // inside it - a fence cut to the rectangle would open not containing its
  // own contents.
  const box = fenceBox({ x0: 0, y0: 0, x1: 100, y1: 100 }, { x0: 0, y0: 0, x1: 400, y1: 100 }, 10);
  assert.equal(box.x + box.w / 2, 410, 'the fence reaches past the band to hold the card');
  assert.equal(box.x - box.w / 2, -10);
});

test('a band drawn wider than its catch keeps the width somebody drew', () => {
  const box = fenceBox({ x0: -500, y0: -500, x1: 500, y1: 500 }, { x0: 0, y0: 0, x1: 10, y1: 10 }, 40);
  assert.deepEqual(box, { x: 0, y: 0, w: 1000, h: 1000 });
});

test('the box a selection gets holds every card it was measured from', () => {
  // Through the real predicate, not arithmetic: what makes this box right
  // is that fenceOf() agrees with it.
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
  // One past the highest, not the lowest free - filling the gap would give
  // a new region a name a different region had last week.
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
// "A fence is behind its cards" used to be an arrangement, true only when
// made. visualStackOrder() puts every fence in a band under every card
// instead, which can't drift because nothing is stored to drift.
// ---------------------------------------------------------------------------

test('a fence is painted behind a card that was already lower than it', () => {
  // The bug this band exists for: the photo is at the bottom of the board,
  // the fence drawn over it later has the higher raw z, and under the old
  // rule it covered the very card it had just picked up.
  const [pic] = addItems([photo({ x: 0, y: 0, z: -50 })]);
  const [f] = addItems([fence({ x: 0, y: 0, w: 900, h: 700, z: 10 })]);
  assert.equal(fenceOf(byId(pic.id))?.id, f.id, 'it is in the fence');
  const order = visualStackOrder();
  assert.ok(order.indexOf(f.id) < order.indexOf(pic.id), 'and behind it');
});

test('a fence grown out over a card ends up behind it', () => {
  // The gesture from the other end: the card has its own z and the resize
  // is what picks it up.
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
  // Three bands, not two: the note band is above the card band as it was.
  const [f] = addItems([fence({ x: 0, y: 0, w: 900, h: 700 })]);
  const [pic] = addItems([photo({ x: 0, y: 0, w: 300, h: 300 })]);
  const [n] = addItems([note({ x: 0, y: 0, w: 80, h: 80 })]);
  assert.deepEqual(visualStackOrder(), [f.id, pic.id, n.id]);
});

test('a fence inside a fence is painted in front of the one holding it', () => {
  // z can't express this: the inner fence needs to be under its own cards
  // and over its parent, with no such value on a board a whole number
  // apart - both came out at the same z, a coin toss. Area settles it,
  // since containment already requires strictly more of it.
  const [outer] = addItems([fence({ x: 0, y: 0, w: 2000, h: 1600, z: -1 })]);
  const [inner] = addItems([fence({ x: 0, y: 0, w: 600, h: 400, z: -1 })]);
  assert.equal(fenceOf(byId(inner.id))?.id, outer.id, 'it is nested');
  const order = visualStackOrder();
  assert.ok(order.indexOf(outer.id) < order.indexOf(inner.id));
});

test('the fence band ignores raw z only where nesting decides it', () => {
  // Same size, so neither can hold the other - raw z still orders them.
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
