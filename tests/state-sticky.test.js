// The sticky relation: which note is stuck to what, and what it rides.
// state.ts is a module singleton, so every case starts by loading an empty
// board, exercising the reset too. One of six files split from
// tests/state.test.js to mirror state.ts's own split; see tests/layers.test.js.

import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

import {
  loadBoard, serializeBoard, addItems, removeItems, restoreItems, byId, select,
  stuckTo, stuckFollowers, stuckPlacement, restick, STICK_MIN, snapshotGeom,
  applyGeom, commitGeom, setBoardMode, raiseSelection, lowerSelection,
  visualStackOrder, selectionHasStackOverlap, wouldStick, board, ensureTitleCard,
  ensureGhostCards, TITLE_ID, undo, redo, setItemsLocked, isLocked,
} from '../web/assets/js/state.ts';
import { overlapFraction } from '../web/assets/js/geometry.ts';
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

  // Move an unrelated photo, above the host in raw z, across the note. A note
  // is never buried by a picture, so it stays on top of both, whatever the
  // raw z. Raw z keeps the host-below-note order stickiness is measured from.
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

  // The layer falls below `other` in raw z, but the note stays in the note
  // band on top, since a note is never covered by a picture.
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

test('a leaning card is still found overlapping', () => {
  // A 45-degree card reaches further along x than its own width, so a sweep
  // keyed on `w` would drop the pair before the polygon clipper ever saw it -
  // a wrong answer, not a slower one. Extents used here are the rotated ones.
  const [a] = addItems([photo({ x: 0, y: 0, w: 200, h: 200, rot: 45 })]);
  // Outside a's axis-aligned half-width (100), inside its rotated one (~141).
  const [b] = addItems([photo({ x: 120, y: 0, w: 20, h: 400 })]);
  assert.ok(overlapFraction(byId(a.id), byId(b.id)) > 0,
    'the two really do overlap - if this fails the fixture moved, not the sweep');
  select([a.id]);
  assert.equal(selectionHasStackOverlap(), true);
  // Pushed clear along x, the sweep never forms the pair.
  applyGeom([{ ...snapshotGeom([b.id])[0], x: 4000 }]);
  assert.equal(selectionHasStackOverlap(), false);
});

test('overlap is found whichever order the boards items arrive in', () => {
  // The sweep sorts by left edge, so the answer must not depend on add
  // order - a bug the pairwise version it replaced could not have.
  for (const first of [true, false]) {
    fresh();
    const left = { x: 0, y: 0, w: 200, h: 200 };
    const right = { x: 80, y: 0, w: 200, h: 200 };
    const [a, b] = addItems(first ? [photo(left), photo(right)] : [photo(right), photo(left)]);
    select([a.id]);
    assert.equal(selectionHasStackOverlap(), true, `selected first, order ${first}`);
    select([b.id]);
    assert.equal(selectionHasStackOverlap(), true, `selected second, order ${first}`);
  }
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

  // A file may say pinned while the note lies nowhere near its host (drift,
  // rounding). The stored pin must win over a fresh measurement.
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
  // The resize bug: shrinking a card left the note hanging in mid-air, still
  // "stuck" by record but no longer over the card. stuckPlacement (input.ts)
  // now carries each rider at the same fraction of the card.
  fresh();
  const hostBefore = { x: 0, y: 0, w: 300, h: 300 };
  const [pic] = addItems([photo(hostBefore)]);
  const [n] = addItems([note({ x: -120, y: 120, w: 60, h: 60 })]);
  assert.equal(stuckTo(byId(n.id))?.id, pic.id, 'note starts stuck to the card');

  // Card pulled to a third of its size; the note keeps its -0.4/+0.4 fraction.
  const hostAfter = { x: 0, y: 0, w: 100, h: 100 };
  assert.deepEqual(stuckPlacement(byId(n.id), hostBefore, hostAfter), { x: -40, y: 40 });

  // Left at (-120, 120) the note would be off a card spanning only -50..50.
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
  // The threshold is a fraction of the *note*, so the test can sit either
  // side of it by a pixel. A 100x100 note beside a 200x200 photo (right edge
  // at x=100): overlapping by `d` in x and fully in y gives d/100 of the note.
  const overlapping = d => {
    fresh();
    addItems([photo({ x: 0, y: 0, w: 200, h: 200 })]);
    const [n] = addItems([note({ x: 100 + 50 - d, y: 0, w: 100, h: 100 })]);
    return stuckTo(byId(n.id));
  };
  assert.equal(overlapping(100 * STICK_MIN + 1)?.type, 'image', 'just over should stick');
  assert.equal(overlapping(100 * STICK_MIN - 1), null, 'just under should not');
  // Exactly at the threshold is not "more than".
  assert.equal(overlapping(100 * STICK_MIN), null);
});

test('a corner overlap sticks, where a centre test would say nothing', () => {
  // The photo spans -100 to 100; the note spans 60 to 160, so 40x40 of its
  // 100x100 lies on the photo - well over the twentieth - while its centre
  // at (110, 110) is off the photo entirely.
  fresh();
  const [pic] = addItems([photo({ x: 0, y: 0, w: 200, h: 200 })]);
  const [n] = addItems([note({ x: 110, y: 110, w: 100, h: 100 })]);
  assert.equal(overlapFraction(n, pic), 0.16);
  assert.equal(stuckTo(byId(n.id))?.id, pic.id);
});

// ---- when the question is asked again --------------------------------------

test('moving the host does not re-parent the notes lying on it', () => {
  // Two photos side by side, a note on the first; slide the *second* photo
  // under the note. The note has not moved, so it is still stuck to the one
  // it was put on.
  fresh();
  const [first] = addItems([photo({ x: 0, y: 0, w: 200, h: 200 })]);
  const [second] = addItems([photo({ x: 600, y: 0, w: 200, h: 200 })]);
  const [n] = addItems([note({ x: 0, y: 0, w: 80, h: 80 })]);
  assert.equal(stuckTo(byId(n.id))?.id, first.id, 'stuck to the one it was put on');

  const before = snapshotGeom([second.id]);
  applyGeom([{ ...before[0], x: 0, y: 0 }]);
  commitGeom('Move', before, [second.id]);

  // `second` is now directly under the note and higher in the stack than
  // `first` - a fresh measurement would hand the note over. It must not.
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
  // The memo must never outlive the geometry that justified it. Undo puts
  // the note back without the gesture path running, so commitGeom - the only
  // thing that resticks - must carry the pair: moving is moving whether a
  // hand or the history did it.
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
  // The follower case, arranged so re-measuring would give a *different*
  // answer - `pic` at the bottom, `under` above it, the note above both.
  // Nearest-underneath wins, so once towed onto `under`, a fresh measurement
  // would hand the note to `under`. It must stay with `pic`.
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
  // The note really is over the other photo now, so the memo is what kept
  // it, not a lack of a candidate.
  restick([n.id]);
  assert.equal(stuckTo(byId(n.id))?.id, under.id, 'asked again, it would have moved');
});

test('a note stuck to nothing stays stuck to nothing until it is moved', () => {
  // Null is a remembered answer too - otherwise a loose note would be
  // re-parented by anything sliding underneath it. The photo goes down first
  // so it is below the note and a legitimate host the moment it arrives.
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
  // The alternative is a note that can never stick to anything again until
  // dragged. A delete now takes the note with the card (riderCascade,
  // trash.ts), so restoring the note *alone* out of the drawer - memo still
  // naming a photograph that stays in the drawer - is the way to strand one.
  fresh();
  const [big] = addItems([photo({ x: 0, y: 0, w: 400, h: 400 })]);
  const [small] = addItems([photo({ x: 0, y: 0, w: 300, h: 300 })]);
  const [n] = addItems([note({ x: 0, y: 0, w: 80, h: 80 })]);
  assert.equal(stuckTo(byId(n.id))?.id, small.id);

  removeItems([small.id]);
  restoreItems([n.id]);
  assert.equal(byId(small.id), undefined, 'the remembered host is still in the drawer');
  assert.equal(stuckTo(byId(n.id))?.id, big.id);
});


// ---------------------------------------------------------------------------
// Furniture is not a host
// ---------------------------------------------------------------------------

test('a note over the title card is stuck to nothing', () => {
  // A note stuck to the title card travelled with it, and on Mobile - where
  // the card is parked off-board - landed in the packed first row as a rider
  // nothing treated as an obstacle.
  ensureTitleCard();
  const title = byId(TITLE_ID);
  const [n] = addItems([note({ x: title.x, y: title.y, w: 80, h: 80 })]);
  assert.ok(overlapFraction(byId(n.id), title) > STICK_MIN, 'the fixture must overlap');
  assert.equal(stuckTo(byId(n.id)), null);
});

test('a note over a hint card is stuck to nothing', () => {
  // Shorter fuse than the title card: a hint is deleted the moment real
  // content arrives, so the host would vanish under the note on next import.
  ensureGhostCards();
  const ghost = board.items.find(i => i.type === 'ghost');
  assert.ok(ghost, 'the fixture must have put hints on the board');
  const [n] = addItems([note({ x: ghost.x, y: ghost.y, w: 80, h: 80 })]);
  assert.ok(overlapFraction(byId(n.id), ghost) > STICK_MIN, 'the fixture must overlap');
  assert.equal(stuckTo(byId(n.id)), null);
});

test('a prospective drop onto the title card would stick to nothing', () => {
  // wouldStick() is asked mid-gesture and must give the same answer as the
  // measurement that follows it.
  ensureTitleCard();
  const title = byId(TITLE_ID);
  assert.equal(wouldStick({ x: title.x, y: title.y, w: 80, h: 80 }, 'nothing'), null);
});

test('a file that pins a note to the title card opens with it loose', () => {
  // The memo wins over measurement and is never re-measured while its host
  // is on the board, so an older file's pin must not reintroduce the relation
  // measureStick() now refuses.
  loadBoard({ title: 'T', items: [
    { id: 'n', type: 'note', x: 0, y: 0, w: 80, h: 80, meta: { text: 'n', stuckTo: TITLE_ID } },
  ] });
  ensureTitleCard();
  assert.equal(stuckTo(byId('n')), null);
});

// ---------------------------------------------------------------------------
// Anchoring, which a rider is not offered and cannot be given
// ---------------------------------------------------------------------------

test('a note stuck to a photo cannot be anchored', () => {
  // A rider has no geometry of its own - it is placed from its host every
  // move - and the drag path drops anchored items from the set it carries.
  // An anchored sticky would be left standing while its host slid away.
  const [pic] = addItems([photo({ x: 0, y: 0, w: 300, h: 300 })]);
  const [n] = addItems([note({ x: 0, y: 0, w: 80, h: 80 })]);
  assert.equal(stuckTo(byId(n.id))?.id, pic.id, 'the fixture must be a rider');

  setItemsLocked([n.id], true);
  assert.equal(isLocked(byId(n.id)), false, 'the rider took an anchor');
});

test('anchoring a photo and its own sticky anchors only the photo', () => {
  // The door must refuse too, not just the menu: lockSelection() hands over
  // the whole selection, and a photograph is often picked with its note.
  const [pic] = addItems([photo({ x: 0, y: 0, w: 300, h: 300 })]);
  const [n] = addItems([note({ x: 0, y: 0, w: 80, h: 80 })]);

  setItemsLocked([pic.id, n.id], true);
  assert.equal(isLocked(byId(pic.id)), true, 'the host should be anchored');
  assert.equal(isLocked(byId(n.id)), false, 'the rider should not be');
});

test('a note lying on bare board can be anchored like anything else', () => {
  // The exclusion is about being stuck, not being a note: a sticky on
  // nothing is an ordinary card with an ordinary position.
  const [n] = addItems([note({ x: 900, y: 900, w: 80, h: 80 })]);
  assert.equal(stuckTo(byId(n.id)), null, 'the fixture must not be a rider');

  setItemsLocked([n.id], true);
  assert.equal(isLocked(byId(n.id)), true);
});

test('a note stuck to itself does not freeze the board', { timeout: 5000 }, () => {
  // Before the fix this hung the process: dragRoot() walks up the pile on
  // pointerdown, and seedSticks() accepted whatever meta.stuckTo said, so
  // `n -> n` was a loop with no exit and no allocation.
  loadBoard({ title: 'T', items: [
    { id: 'n', type: 'note', x: 0, y: 0, w: 80, h: 80, meta: { text: 'n', stuckTo: 'n' } },
  ] });
  assert.equal(stuckTo(byId('n')), null, 'a note cannot be stuck to itself');
});

test('two notes stuck to each other do not freeze the board', { timeout: 5000 }, () => {
  loadBoard({ title: 'T', items: [
    { id: 'a', type: 'note', x: 0, y: 0, w: 80, h: 80, meta: { text: 'a', stuckTo: 'b' } },
    { id: 'b', type: 'note', x: 90, y: 0, w: 80, h: 80, meta: { text: 'b', stuckTo: 'a' } },
  ] });
  // One of the two loses its pin, whichever closes the loop - which one is
  // not the interesting part, that both terminate is.
  const pins = [stuckTo(byId('a')), stuckTo(byId('b'))];
  assert.ok(pins.some(p => p === null), 'the cycle was not broken anywhere');
});

test('a longer cycle is broken, and the honest pins below it survive', { timeout: 5000 }, () => {
  loadBoard({ title: 'T', items: [
    { id: 'pic', type: 'image', x: 0, y: 0, w: 300, h: 300 },
    { id: 'a', type: 'note', x: 0, y: 0, w: 80, h: 80, meta: { text: 'a', stuckTo: 'b' } },
    { id: 'b', type: 'note', x: 90, y: 0, w: 80, h: 80, meta: { text: 'b', stuckTo: 'c' } },
    { id: 'c', type: 'note', x: 180, y: 0, w: 80, h: 80, meta: { text: 'c', stuckTo: 'a' } },
    { id: 'd', type: 'note', x: 10, y: 10, w: 80, h: 80, meta: { text: 'd', stuckTo: 'pic' } },
  ] });
  assert.equal(stuckTo(byId('d'))?.id, 'pic', 'an unrelated pin is not collateral');
  const pins = ['a', 'b', 'c'].map(id => stuckTo(byId(id)));
  assert.equal(pins.filter(p => p === null).length, 1, 'exactly one link in the ring goes');
});
