// The sticky relation: which note is stuck to what, and what it rides.
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
  loadBoard, serializeBoard, addItems, removeItems, byId, select,
  stuckTo, stuckFollowers, stuckPlacement, restick, STICK_MIN, snapshotGeom,
  applyGeom, commitGeom, setBoardMode, raiseSelection, lowerSelection,
  visualStackOrder, selectionHasStackOverlap, wouldStick, board, ensureTitleCard,
  ensureGhostCards, TITLE_ID, undo, redo,
} from '../web/assets/js/state.js';
import { overlapFraction } from '../web/assets/js/geometry.js';
import { fresh, note, photo } from './state-fixtures.js';

beforeEach(() => {
  setBoardMode('desktop');
  fresh();
});
// ---------------------------------------------------------------------------
// Sticky notes
// ---------------------------------------------------------------------------

test('a note over a photo is stuck to it', () => {
  const [pic] = addItems([photo({ x: 0, y: 0, w: 300, h: 300 })]);
  const [n] = addItems([note({ x: 0, y: 0, w: 80, h: 80 })]);
  assert.equal(stuckTo(byId(n.id))?.id, pic.id);
});

test('a note rides above the other items whatever the raw z says', () => {
  const [pic] = addItems([photo({ x: 0, y: 0, w: 300, h: 300 })]);
  const [other] = addItems([photo({ x: 600, y: 0, w: 200, h: 200 })]);
  const [n] = addItems([note({ x: 0, y: 0, w: 80, h: 80 })]);
  assert.equal(stuckTo(byId(n.id))?.id, pic.id);

  // Put an unrelated photo above the host in raw z and move it across the note.
  // A note is never buried by a picture, so it stays on top of both photos - and
  // still above the very host it is stuck to - however the raw z falls out. Raw
  // z keeps the host-below-note order stickiness is measured from.
  applyGeom([{ ...snapshotGeom([other.id])[0], x: 0 }]);
  assert.ok(pic.z < other.z && other.z < n.z);
  assert.deepEqual(visualStackOrder(), [pic.id, other.id, n.id]);
});

test('front and back move an entire sticky layer when its note is selected', () => {
  const [pic] = addItems([photo({ x: 0, y: 0, w: 300, h: 300 })]);
  const [other] = addItems([photo({ x: 600, y: 0, w: 200, h: 200 })]);
  const [n] = addItems([note({ x: 0, y: 0, w: 80, h: 80 })]);
  assert.equal(stuckTo(byId(n.id))?.id, pic.id);
  applyGeom([{ ...snapshotGeom([other.id])[0], x: 0 }]);

  select([n.id]);
  raiseSelection();
  assert.deepEqual(visualStackOrder(), [other.id, pic.id, n.id]);
  assert.ok(pic.z > other.z && n.z > pic.z, 'the host and note rose together');

  // The whole layer falls below `other` in raw z, and the host duly drops under
  // it - but the note stays in the note band on top, since a note is never
  // covered by a picture. Raw z still records the host-below-note order.
  lowerSelection();
  assert.deepEqual(visualStackOrder(), [pic.id, other.id, n.id]);
  assert.ok(pic.z < n.z && n.z < other.z, 'the host and note fell together');
});

test('stack actions are useful only across another overlapping layer', () => {
  const [pic] = addItems([photo({ x: 0, y: 0, w: 300, h: 300 })]);
  const [n] = addItems([note({ x: 0, y: 0, w: 80, h: 80 })]);
  assert.equal(stuckTo(byId(n.id))?.id, pic.id);
  select([n.id]);
  assert.equal(selectionHasStackOverlap(), false,
    'a note covering its own host is overlap inside one layer');

  const [other] = addItems([photo({ x: 0, y: 0, w: 100, h: 100 })]);
  assert.equal(selectionHasStackOverlap(), true);
  applyGeom([{ ...snapshotGeom([other.id])[0], x: 1000 }]);
  assert.equal(selectionHasStackOverlap(), false);
});

test('a note nowhere near anything is stuck to nothing', () => {
  addItems([photo({ x: 0, y: 0, w: 100, h: 100 })]);
  const [n] = addItems([note({ x: 5000, y: 5000 })]);
  assert.equal(stuckTo(byId(n.id)), null);
});

test('only notes stick', () => {
  addItems([photo({ x: 0, y: 0, w: 300, h: 300 })]);
  const [other] = addItems([photo({ x: 0, y: 0, w: 50, h: 50 })]);
  assert.equal(stuckTo(byId(other.id)), null);
});

test('a pin is stamped into the file and restored from it', () => {
  const [pic] = addItems([photo({ x: 0, y: 0, w: 300, h: 300 })]);
  const [n] = addItems([note({ x: 0, y: 0, w: 80, h: 80 })]);
  assert.equal(stuckTo(byId(n.id))?.id, pic.id);
  const saved = serializeBoard().items.find(i => i.id === n.id);
  assert.equal(saved.meta.stuckTo, pic.id, 'the pin is written down at save');

  // A file that says pinned while the note lies nowhere near its host - a Mobile
  // geometry that drifted, an older overlap lost to rounding. The stored pin has
  // to win over a fresh measurement, which here would find nothing.
  loadBoard({ title: 'T', items: [
    { id: 'pic', type: 'image', x: 0, y: 0, w: 300, h: 300 },
    { id: 'n', type: 'note', x: 5000, y: 5000, w: 80, h: 80, meta: { text: 'n', stuckTo: 'pic' } },
  ] });
  assert.equal(stuckTo(byId('n'))?.id, 'pic', 'the saved pin is honoured without overlap');
});

test('a stuck note rides its host into the Mobile layout', () => {
  const [pic] = addItems([photo({ x: 0, y: 0, w: 300, h: 300 })]);
  const [n] = addItems([note({ x: 20, y: 20, w: 80, h: 80 })]);
  assert.equal(stuckTo(byId(n.id))?.id, pic.id);
  setBoardMode('mobile');
  assert.ok(overlapFraction(byId(n.id), byId(pic.id)) > STICK_MIN,
    'the note still lies on its host after the board reflows for a phone');
});

test('a note under the thing it covers is not stuck to it', () => {
  // Being stuck requires being above: a relationship nobody can see is not one.
  const [n] = addItems([note({ x: 0, y: 0, w: 80, h: 80 })]);
  addItems([photo({ x: 0, y: 0, w: 300, h: 300 })]);
  assert.equal(stuckTo(byId(n.id)), null);
});

test('the nearest thing underneath wins', () => {
  const [bottom] = addItems([photo({ x: 0, y: 0, w: 400, h: 400 })]);
  const [middle] = addItems([photo({ x: 0, y: 0, w: 300, h: 300 })]);
  const [n] = addItems([note({ x: 0, y: 0, w: 50, h: 50 })]);
  assert.equal(stuckTo(byId(n.id))?.id, middle.id);
  assert.ok(bottom.z < middle.z);
});

test('followers travel with their host', () => {
  const [pic] = addItems([photo({ x: 0, y: 0, w: 300, h: 300 })]);
  const [n] = addItems([note({ x: 0, y: 0, w: 60, h: 60 })]);
  assert.deepEqual(stuckFollowers([pic.id]), [n.id]);
});

test('sticking is transitive - a note on a note on a photo', () => {
  const [pic] = addItems([photo({ x: 0, y: 0, w: 400, h: 400 })]);
  const [n1] = addItems([note({ x: 0, y: 0, w: 100, h: 100 })]);
  const [n2] = addItems([note({ x: 0, y: 0, w: 60, h: 60 })]);
  const followers = stuckFollowers([pic.id]);
  assert.equal(followers.length, 2, 'a pile of stickies reads as one object');
  assert.ok(followers.includes(n1.id) && followers.includes(n2.id));
});

test('a stuck note rides its host as it shrinks and stays on the card', () => {
  // The resize bug: shrinking a card under a sticky left the note hanging in
  // mid-air, still "stuck" by the record but no longer over the card. The gesture
  // now carries each rider by stuckPlacement (input.js), which keeps the note at
  // the same fraction of the card - so it lands on the shrunk card, not beside it.
  fresh();
  const hostBefore = { x: 0, y: 0, w: 300, h: 300 };
  const [pic] = addItems([photo(hostBefore)]);
  const [n] = addItems([note({ x: -120, y: 120, w: 60, h: 60 })]);
  assert.equal(stuckTo(byId(n.id))?.id, pic.id, 'note starts stuck to the card');

  // Card pulled down to a third of its size; the note keeps its -0.4/+0.4 fraction.
  const hostAfter = { x: 0, y: 0, w: 100, h: 100 };
  assert.deepEqual(stuckPlacement(byId(n.id), hostBefore, hostAfter), { x: -40, y: 40 });

  // Left where it was (-120, 120) the note would be off a card now spanning only
  // -50..50; carried to the placement it is still on it.
  Object.assign(byId(pic.id), hostAfter);
  Object.assign(byId(n.id), stuckPlacement({ x: -120, y: 120, w: 60, h: 60 }, hostBefore, hostAfter));
  restick([pic.id, n.id]);
  assert.equal(stuckTo(byId(n.id))?.id, pic.id, 'and it is still on the card afterwards');
});

test('something already moving is not also a follower', () => {
  const [pic] = addItems([photo({ x: 0, y: 0, w: 300, h: 300 })]);
  const [n] = addItems([note({ x: 0, y: 0, w: 60, h: 60 })]);
  assert.deepEqual(stuckFollowers([pic.id, n.id]), [], 'it would be moved twice');
});

// ---- how much overlap counts ----------------------------------------------

test('a twentieth of the note over the item is enough, and less is not', () => {
  // The threshold is a fraction of the *note*, so the arithmetic is exact and
  // the test can sit either side of it by a pixel rather than by a guess.
  //
  // A 100x100 note beside a 200x200 photo whose right edge is at x = 100:
  // overlapping by `d` in x and fully in y gives d/100 of the note.
  const overlapping = d => {
    fresh();
    addItems([photo({ x: 0, y: 0, w: 200, h: 200 })]);
    const [n] = addItems([note({ x: 100 + 50 - d, y: 0, w: 100, h: 100 })]);
    return stuckTo(byId(n.id));
  };
  assert.equal(overlapping(100 * STICK_MIN + 1)?.type, 'image', 'just over should stick');
  assert.equal(overlapping(100 * STICK_MIN - 1), null, 'just under should not');
  // Exactly at the threshold is not "more than", which is the documented rule.
  assert.equal(overlapping(100 * STICK_MIN), null);
});

test('a corner overlap sticks, where a centre test would say nothing', () => {
  // The case the old rule got wrong and the reason for measuring area. The
  // photo spans -100 to 100; the note spans 60 to 160, so 40 x 40 of its own
  // 100 x 100 lies on the photo - well over the twentieth - while its centre,
  // at (110, 110), is off the photo entirely and always was.
  fresh();
  const [pic] = addItems([photo({ x: 0, y: 0, w: 200, h: 200 })]);
  const [n] = addItems([note({ x: 110, y: 110, w: 100, h: 100 })]);
  assert.equal(overlapFraction(n, pic), 0.16);
  assert.equal(stuckTo(byId(n.id))?.id, pic.id);
});

// ---- when the question is asked again --------------------------------------

test('moving the host does not re-parent the notes lying on it', () => {
  // The whole point of remembering. Two photos side by side, a note on the
  // first; slide the *second* photo under the note. The note has not moved, so
  // it is still stuck to the one it was put on.
  fresh();
  const [first] = addItems([photo({ x: 0, y: 0, w: 200, h: 200 })]);
  const [second] = addItems([photo({ x: 600, y: 0, w: 200, h: 200 })]);
  const [n] = addItems([note({ x: 0, y: 0, w: 80, h: 80 })]);
  assert.equal(stuckTo(byId(n.id))?.id, first.id, 'stuck to the one it was put on');

  const before = snapshotGeom([second.id]);
  applyGeom([{ ...before[0], x: 0, y: 0 }]);
  commitGeom('Move', before, [second.id]);

  // `second` is now directly under the note and is higher in the stack than
  // `first`, so a fresh measurement would hand the note over. It must not.
  assert.ok(second.z > first.z);
  assert.equal(stuckTo(byId(n.id))?.id, first.id, 'the pile stayed the pile');
});

test('moving the note itself asks again', () => {
  fresh();
  const [first] = addItems([photo({ x: 0, y: 0, w: 200, h: 200 })]);
  const [second] = addItems([photo({ x: 600, y: 0, w: 200, h: 200 })]);
  const [n] = addItems([note({ x: 0, y: 0, w: 80, h: 80 })]);
  assert.equal(stuckTo(byId(n.id))?.id, first.id);

  const before = snapshotGeom([n.id]);
  applyGeom([{ ...before[0], x: 600, y: 0 }]);
  commitGeom('Move', before, [n.id]);
  assert.equal(stuckTo(byId(n.id))?.id, second.id, 'it was put down somewhere else');
});

test('undoing a move asks again, and so does redoing it', () => {
  // The memo must never outlive the geometry that justified it. Undo puts the
  // note back over the first photo without anybody touching it, so nothing in
  // the gesture path runs - and the answer measured after the drop would stand
  // over a note that is no longer anywhere near what it names.
  //
  // commitGeom is the only thing that resticks, so the pair it commits has to
  // be what carries it: moving is moving whether a hand or the history did it.
  fresh();
  const [first] = addItems([photo({ x: 0, y: 0, w: 200, h: 200 })]);
  const [second] = addItems([photo({ x: 600, y: 0, w: 200, h: 200 })]);
  const [n] = addItems([note({ x: 0, y: 0, w: 80, h: 80 })]);
  assert.equal(stuckTo(byId(n.id))?.id, first.id);

  const before = snapshotGeom([n.id]);
  applyGeom([{ ...before[0], x: 600, y: 0 }]);
  commitGeom('Move', before, [n.id]);
  assert.equal(stuckTo(byId(n.id))?.id, second.id);

  undo();
  assert.equal(byId(n.id).x, 0, 'the geometry went back');
  assert.equal(stuckTo(byId(n.id))?.id, first.id, 'and so did the stick');

  redo();
  assert.equal(stuckTo(byId(n.id))?.id, second.id, 'and forward again');
});

test('a note towed by its host keeps its host', () => {
  // The follower case, and the arrangement is chosen so that re-measuring would
  // give a *different* answer - otherwise the test passes either way.
  //
  // `pic` is at the bottom, `under` above it, the note above both. Nearest
  // underneath wins, so once the pair is towed on top of `under`, a fresh
  // measurement hands the note to `under`. It must stay with `pic`.
  fresh();
  const [pic] = addItems([photo({ x: 0, y: 0, w: 200, h: 200 })]);
  const [under] = addItems([photo({ x: 900, y: 0, w: 400, h: 400 })]);
  const [n] = addItems([note({ x: 0, y: 0, w: 80, h: 80 })]);
  assert.ok(under.z > pic.z && n.z > under.z, 'the stack the test depends on');
  assert.equal(stuckTo(byId(n.id))?.id, pic.id);

  const towed = [pic.id, ...stuckFollowers([pic.id])];
  assert.deepEqual(towed, [pic.id, n.id]);
  const before = snapshotGeom(towed);
  applyGeom(before.map(g => ({ ...g, x: g.x + 900 })));
  commitGeom('Move', before, [pic.id]);

  assert.equal(stuckTo(byId(n.id))?.id, pic.id, 'towing is not putting down');
  // And the note really is over the other photo now, so the memo is what kept
  // it - not a lack of a candidate.
  restick([n.id]);
  assert.equal(stuckTo(byId(n.id))?.id, under.id, 'asked again, it would have moved');
});

test('a note stuck to nothing stays stuck to nothing until it is moved', () => {
  // Null is a remembered answer too. Without that, a loose note would be the
  // one case that still gets re-parented by things sliding underneath it.
  //
  // The photo goes down first so it is below the note in the stack and is a
  // legitimate host the moment it arrives under it.
  fresh();
  const [pic] = addItems([photo({ x: 900, y: 0, w: 300, h: 300 })]);
  const [n] = addItems([note({ x: 0, y: 0, w: 80, h: 80 })]);
  assert.ok(pic.z < n.z);
  assert.equal(stuckTo(byId(n.id)), null, 'nowhere near it yet');

  const before = snapshotGeom([pic.id]);
  applyGeom([{ ...before[0], x: 0, y: 0 }]);
  commitGeom('Move', before, [pic.id]);
  assert.equal(stuckTo(byId(n.id)), null, 'the photo came to the note, so no');

  restick([n.id]);
  assert.equal(stuckTo(byId(n.id))?.id, pic.id, 'and asked again, yes');
});

test('a host that leaves the board lets its note find another', () => {
  // Not "the note moved", but the alternative is a note that can never stick to
  // anything again until somebody happens to drag it.
  fresh();
  const [big] = addItems([photo({ x: 0, y: 0, w: 400, h: 400 })]);
  const [small] = addItems([photo({ x: 0, y: 0, w: 300, h: 300 })]);
  const [n] = addItems([note({ x: 0, y: 0, w: 80, h: 80 })]);
  assert.equal(stuckTo(byId(n.id))?.id, small.id);
  removeItems([small.id]);
  assert.equal(stuckTo(byId(n.id))?.id, big.id);
});


// ---------------------------------------------------------------------------
// Furniture is not a host
// ---------------------------------------------------------------------------

test('a note over the title card is stuck to nothing', () => {
  // A note stuck to the title card travelled with it, and on Mobile - where the
  // card is parked off the board entirely - landed in the packed first row as a
  // rider nothing had treated as an obstacle.
  ensureTitleCard();
  const title = byId(TITLE_ID);
  const [n] = addItems([note({ x: title.x, y: title.y, w: 80, h: 80 })]);
  assert.ok(overlapFraction(byId(n.id), title) > STICK_MIN, 'the fixture must overlap');
  assert.equal(stuckTo(byId(n.id)), null);
});

test('a note over a hint card is stuck to nothing', () => {
  // Shorter fuse than the title card: a hint is deleted the moment real content
  // arrives, so the host would vanish under the note on the next import.
  ensureGhostCards();
  const ghost = board.items.find(i => i.type === 'ghost');
  assert.ok(ghost, 'the fixture must have put hints on the board');
  const [n] = addItems([note({ x: ghost.x, y: ghost.y, w: 80, h: 80 })]);
  assert.ok(overlapFraction(byId(n.id), ghost) > STICK_MIN, 'the fixture must overlap');
  assert.equal(stuckTo(byId(n.id)), null);
});

test('a prospective drop onto the title card would stick to nothing', () => {
  // wouldStick() is asked mid-gesture, before the move is committed, and has to
  // give the same answer as the measurement that follows it.
  ensureTitleCard();
  const title = byId(TITLE_ID);
  assert.equal(wouldStick({ x: title.x, y: title.y, w: 80, h: 80 }, 'nothing'), null);
});

test('a file that pins a note to the title card opens with it loose', () => {
  // The memo wins over measurement, and is never re-measured while its host is
  // on the board - so a pin from an older file would reintroduce from disk
  // exactly the relation measureStick() now refuses.
  loadBoard({ title: 'T', items: [
    { id: 'n', type: 'note', x: 0, y: 0, w: 80, h: 80, meta: { text: 'n', stuckTo: TITLE_ID } },
  ] });
  ensureTitleCard();
  assert.equal(stuckTo(byId('n')), null);
});
