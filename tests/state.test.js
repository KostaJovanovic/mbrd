// Board state: the command history, the internal clipboard, and the sticky
// relation.
//
// state.js is a module singleton, which is right for an app with one board and
// awkward for tests, so every case starts by loading an empty board. That is
// the same door opening a .mbrd goes through, so it also exercises the reset.

import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

import {
  board, selection, loadBoard, serializeBoard, addItems, removeItems,
  restoreItems, emptyTrash, undo, redo, isDirty, markDirty, byId, topZ,
  select, clearSelection, selectAll, duplicateItems,
  copyItems, cutItems, pasteItems, clipboardSize, clipboardHasOurs, clipboardBounds,
  stuckTo, stuckFollowers, restick, STICK_MIN, setItemText, renameItem, NOTE_MAX,
  setSetting, snapshotGeom, applyGeom, commitGeom,
  setBoardMode, mobileBoardWidth, mobileBoardTop,
} from '../web/assets/js/state.js';
import { overlapFraction, CELL_GAP } from '../web/assets/js/geometry.js';
import { hash } from './helpers.js';

const fresh = (items = []) => loadBoard({ title: 'T', items });

const note = (props = {}) => ({ type: 'note', w: 100, h: 100, meta: { text: 'n' }, ...props });
const photo = (props = {}) => ({ type: 'image', w: 200, h: 200, ...props });

beforeEach(() => {
  setBoardMode('desktop');
  fresh();
});

// ---------------------------------------------------------------------------
// Items and history
// ---------------------------------------------------------------------------

test('adding items puts them on the board and can be undone', () => {
  const [a] = addItems([photo({ x: 0, y: 0 })]);
  assert.equal(board.items.length, 1);
  assert.ok(undo());
  assert.equal(board.items.length, 0);
  assert.ok(redo());
  assert.equal(byId(a.id).id, a.id);
});

test('undo with nothing to undo is a no-op, not an error', () => {
  assert.equal(undo(), false);
  assert.equal(redo(), false);
});

test('a new action clears the redo branch', () => {
  addItems([photo()]);
  undo();
  addItems([photo()]);
  assert.equal(redo(), false, 'redo should have been discarded');
});

test('deleting sends items to the bin and undo takes them back out', () => {
  const [a] = addItems([photo()]);
  removeItems([a.id]);
  assert.equal(board.items.length, 0);
  assert.equal(board.trash.length, 1);
  undo();
  assert.equal(board.items.length, 1);
  assert.equal(board.trash.length, 0, 'undoing a delete must empty the bin entry too');
});

test('undo restores an item to its old place in the stack', () => {
  const [a, b, c] = addItems([photo({ x: 0 }), photo({ x: 1 }), photo({ x: 2 })]);
  removeItems([b.id]);
  undo();
  assert.deepEqual(board.items.map(i => i.id), [a.id, b.id, c.id]);
});

test('restoring from the bin puts the item on top', () => {
  const [a] = addItems([photo()]);
  const [b] = addItems([photo()]);
  removeItems([a.id]);
  const [back] = restoreItems([a.id]);
  assert.ok(back.z > byId(b.id).z, 'a restored item must not come back underneath');
});

test('restoring to a point moves it there', () => {
  const [a] = addItems([photo({ x: 0, y: 0 })]);
  removeItems([a.id]);
  const [back] = restoreItems([a.id], { x: 500, y: -300 });
  assert.equal(back.x, 500);
  assert.equal(back.y, -300);
});

test('emptying the bin is undoable', () => {
  const [a] = addItems([photo()]);
  removeItems([a.id]);
  emptyTrash();
  assert.equal(board.trash.length, 0);
  undo();
  assert.equal(board.trash.length, 1, 'emptying the bin by accident is a bad afternoon');
});

test('the bin has a ceiling', () => {
  const many = addItems(Array.from({ length: 70 }, (_, i) => photo({ x: i })));
  removeItems(many.map(i => i.id));
  assert.ok(board.trash.length <= 60, `bin grew to ${board.trash.length}`);
});

test('undo puts back what the bin dropped to make room', () => {
  // A command has to reverse everything it did, and pushing the oldest entry
  // out of a full bin is something a delete does. Undo used to remove only the
  // items it had just binned, so on a full bin the entry that fell out the
  // bottom - the one nearest to being unrecoverable already - was gone for good.
  const first = addItems(Array.from({ length: 60 }, (_, i) => photo({ x: i, name: `old${i}.png` })));
  removeItems(first.map(i => i.id));
  const oldest = board.trash[board.trash.length - 1].item.name;
  assert.equal(board.trash.length, 60);

  const [extra] = addItems([photo({ name: 'new.png' })]);
  removeItems([extra.id]);
  assert.equal(board.trash.length, 60, 'the bin should still be at its ceiling');
  assert.ok(!board.trash.some(t => t.item.name === oldest), 'the oldest should have been pushed out');

  undo();
  assert.equal(board.trash.length, 60, 'undo should leave the bin as it found it');
  assert.equal(board.trash[board.trash.length - 1].item.name, oldest, 'the evicted entry did not come back');
});

test('redo evicts again rather than growing the bin', () => {
  const first = addItems(Array.from({ length: 60 }, (_, i) => photo({ x: i })));
  removeItems(first.map(i => i.id));
  const [extra] = addItems([photo({ name: 'new.png' })]);
  removeItems([extra.id]);
  undo();
  redo();
  assert.equal(board.trash.length, 60);
  assert.equal(board.trash[0].item.name, 'new.png');
});

// ---------------------------------------------------------------------------
// Notes
// ---------------------------------------------------------------------------

test('a note is capped on the way in', () => {
  const [a] = addItems([note({ meta: { text: 'x'.repeat(NOTE_MAX + 500) } })]);
  assert.equal(a.meta.text.length, NOTE_MAX);
});

test('editing a note is undoable', () => {
  const [a] = addItems([note({ meta: { text: 'before' } })]);
  setItemText(a.id, 'after');
  assert.equal(byId(a.id).meta.text, 'after');
  undo();
  assert.equal(byId(a.id).meta.text, 'before');
});

test('setting a note to what it already says commits nothing', () => {
  const [a] = addItems([note({ meta: { text: 'same' } })]);
  setItemText(a.id, 'same');
  assert.equal(undo(), true, 'the only undo entry should be the add');
  assert.equal(board.items.length, 0);
});

test('an empty rename falls back to the name rather than clearing it', () => {
  const [a] = addItems([photo({ name: 'holiday.jpg' })]);
  renameItem(a.id, '   ');
  assert.equal(byId(a.id).name, 'holiday.jpg', 'clearing a name is a one-way door');
});

test('clearing a name gives back the file it arrived as', () => {
  const [a] = addItems([photo({ name: 'DSC_0431.JPG', meta: { origName: 'DSC_0431.JPG' } })]);
  renameItem(a.id, 'Sunset over the bay');
  assert.equal(byId(a.id).name, 'Sunset over the bay');
  renameItem(a.id, '');
  assert.equal(byId(a.id).name, 'DSC_0431.JPG');
});

test('the original filename survives a save and reopen', () => {
  // It used to live only in the asset registry, which is rebuilt from the
  // archive on every open - and the archive carries bytes and hashes, not
  // filenames. So after a round trip, clearing a renamed item's name handed
  // back the renamed value and the original was gone for good.
  const [a] = addItems([photo({ name: 'DSC_0431.JPG', meta: { origName: 'DSC_0431.JPG' } })]);
  renameItem(a.id, 'Sunset over the bay');
  const data = serializeBoard();
  fresh();
  loadBoard(data);
  const back = board.items[0];
  assert.equal(back.name, 'Sunset over the bay');
  renameItem(back.id, '');
  assert.equal(byId(back.id).name, 'DSC_0431.JPG');
});

test('renaming is undoable', () => {
  const [a] = addItems([photo({ name: 'a.png' })]);
  renameItem(a.id, 'b.png');
  assert.equal(byId(a.id).name, 'b.png');
  undo();
  assert.equal(byId(a.id).name, 'a.png');
});

// ---------------------------------------------------------------------------
// Selection
// ---------------------------------------------------------------------------

test('select replaces, additive select adds', () => {
  const [a, b] = addItems([photo(), photo()]);
  select([a.id]);
  assert.deepEqual([...selection], [a.id]);
  select([b.id]);
  assert.deepEqual([...selection], [b.id]);
  select([a.id], true);
  assert.equal(selection.size, 2);
});

test('select all takes everything, clear takes nothing', () => {
  addItems([photo(), photo(), photo()]);
  selectAll();
  assert.equal(selection.size, 3);
  clearSelection();
  assert.equal(selection.size, 0);
});

test('deleting an item drops it from the selection', () => {
  const [a] = addItems([photo()]);
  select([a.id]);
  removeItems([a.id]);
  assert.equal(selection.size, 0);
});

// ---------------------------------------------------------------------------
// Clipboard
// ---------------------------------------------------------------------------

test('the clipboard leaves its receipts without a screen to leave them on', () => {
  // copy/cut/paste now toast, and state.js is imported by tests that have no
  // document at all. toast() no-ops when there is nothing to draw on - stated
  // here because a regression in util.js would otherwise fail this whole file
  // with a ReferenceError far from its cause.
  assert.equal(typeof globalThis.document, 'undefined', 'this test is only meaningful headless');
  const [a] = addItems([note({ meta: { text: 'said to nobody' } })]);
  assert.doesNotThrow(() => {
    copyItems([a.id]);
    pasteItems();
    cutItems([a.id]);
  });
});

test('copying returns the text that goes on the system clipboard', () => {
  const [a] = addItems([note({ meta: { text: 'remember the milk' } })]);
  const text = copyItems([a.id]);
  assert.equal(text, 'remember the milk');
  assert.equal(clipboardSize(), 1);
});

test('copying nothing returns nothing', () => {
  assert.equal(copyItems([]), '');
});

test('an unnamed selection still leaves a receipt', () => {
  // The receipt only works while the string is never empty.
  const [a] = addItems([photo({ name: '' })]);
  const text = copyItems([a.id]);
  assert.ok(text.length > 0, 'a copy must always leave something on the clipboard');
  assert.ok(clipboardHasOurs(text));
});

test('our own receipt is recognised and a foreign one is not', () => {
  const [a] = addItems([note({ meta: { text: 'ours' } })]);
  const text = copyItems([a.id]);
  assert.ok(clipboardHasOurs(text), 'our copy should be recognised');
  assert.ok(!clipboardHasOurs('something copied in another app'));
});

test('an empty clipboard owns nothing', () => {
  assert.ok(!clipboardHasOurs(''));
  assert.ok(!clipboardHasOurs('anything'));
});

test('pasting adds a copy with a new id', () => {
  const [a] = addItems([photo({ x: 0, y: 0, name: 'a.png' })]);
  copyItems([a.id]);
  const [copy] = pasteItems();
  assert.notEqual(copy.id, a.id);
  assert.equal(copy.name, 'a.png');
  assert.equal(board.items.length, 2);
});

test('a copy shares the original asset rather than duplicating bytes', () => {
  const id = hash('abc');
  const [a] = addItems([photo({ asset: { hash: id, embedded: true } })]);
  copyItems([a.id]);
  const [copy] = pasteItems();
  assert.equal(copy.asset.hash, id);
  assert.notEqual(copy.asset, a.asset, 'the ref should be a copy, not the same object');
});

test('an asset id that is not a content hash is dropped', () => {
  // A hash is spelled into an archive path by storage/mbrd.js, so an id that
  // was never a digest is both a path this app would be writing on someone
  // else's say-so and a reference that can never resolve to bytes. The card
  // survives as a plain one; the claim does not.
  const [a] = addItems([photo({ asset: { hash: '../escape', embedded: true } })]);
  assert.equal(a.asset, null);
});

test('the reserved external form is carried through', () => {
  const [a] = addItems([photo({ asset: { external: { path: 'C:/pics/a.png' } } })]);
  assert.deepEqual(a.asset, { external: { path: 'C:/pics/a.png' } });
});

test('successive pastes step away from each other', () => {
  const [a] = addItems([photo({ x: 0, y: 0 })]);
  copyItems([a.id]);
  const [first] = pasteItems();
  const [second] = pasteItems();
  assert.notEqual(first.x, second.x, 'the second paste must not hide under the first');
});

test('pasting at a point centres the group there', () => {
  const [a] = addItems([photo({ x: 1000, y: 1000, w: 100, h: 100 })]);
  copyItems([a.id]);
  const [copy] = pasteItems({ x: 0, y: 0 });
  assert.equal(copy.x, 0);
  assert.equal(copy.y, 0);
});

test('cutting copies and deletes in one undo entry', () => {
  const [a] = addItems([note({ meta: { text: 'cut me' } })]);
  const text = cutItems([a.id]);
  assert.equal(text, 'cut me');
  assert.equal(board.items.length, 0);
  assert.equal(board.trash.length, 1, 'a cut you never paste is still recoverable');
  undo();
  assert.equal(board.items.length, 1);
});

test('the clipboard does not cross a board', () => {
  const [a] = addItems([photo()]);
  copyItems([a.id]);
  assert.equal(clipboardSize(), 1);
  fresh();
  assert.equal(clipboardSize(), 0, 'a copy from a closed board would paste a hole');
});

test('clipboard bounds describe what was copied', () => {
  const [a] = addItems([photo({ x: 0, y: 0, w: 100, h: 100 })]);
  copyItems([a.id]);
  assert.deepEqual(clipboardBounds(), { x0: -50, y0: -50, x1: 50, y1: 50 });
});

test('duplicate offsets the copy so it is visible', () => {
  const [a] = addItems([photo({ x: 0, y: 0 })]);
  const [copy] = duplicateItems([a.id]);
  assert.notEqual(copy.x, a.x);
  assert.equal(board.items.length, 2);
});

test('duplicating several keeps their stacking order', () => {
  const [a, b] = addItems([photo({ x: 0 }), photo({ x: 10 })]);
  const copies = duplicateItems([a.id, b.id]);
  assert.equal(copies.length, 2);
  assert.ok(copies[1].z > copies[0].z, 'a pile must not be reshuffled by copying it');
});

test('items added in one call are dealt their own layer', () => {
  // They used to share one. makeItem() reads topZ() off the live board and the
  // batch is not on it yet, so a whole group came out on the same layer - see
  // the note in addItems().
  const [a, b, c] = addItems([photo(), photo(), photo()]);
  assert.ok(a.z < b.z && b.z < c.z, `got ${a.z}, ${b.z}, ${c.z}`);
});

test('an explicit z is still honoured', () => {
  // Loading a board and restoring from the bin both bring their own.
  const [a] = addItems([photo({ z: 42 })]);
  assert.equal(a.z, 42);
});

test('a duplicated note stays stuck to the photo it was duplicated with', () => {
  // The bug the layering fixed, and the one that actually showed: the pair
  // tied on z, stuckTo() needs a strictly lower one, so the copied note
  // skipped its own photo and latched onto whatever else was underneath -
  // which was the *original* note. Dragging the copy left the note behind.
  const [pic] = addItems([photo({ x: 0, y: 0, w: 300, h: 300 })]);
  const [n] = addItems([note({ x: 0, y: 0, w: 80, h: 80 })]);
  assert.equal(stuckTo(byId(n.id))?.id, pic.id, 'the original pair must be stuck');

  const copies = duplicateItems([pic.id, n.id]);
  const copiedPic = copies.find(i => i.type === 'image');
  const copiedNote = copies.find(i => i.type === 'note');
  assert.equal(stuckTo(byId(copiedNote.id))?.id, copiedPic.id, 'the copy must be stuck to its own photo');
  assert.deepEqual(stuckFollowers([copiedPic.id]), [copiedNote.id], 'and must travel with it');
});

// ---------------------------------------------------------------------------
// Sticky notes
// ---------------------------------------------------------------------------

test('a note over a photo is stuck to it', () => {
  const [pic] = addItems([photo({ x: 0, y: 0, w: 300, h: 300 })]);
  const [n] = addItems([note({ x: 0, y: 0, w: 80, h: 80 })]);
  assert.equal(stuckTo(byId(n.id))?.id, pic.id);
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
// Load and serialise
// ---------------------------------------------------------------------------

test('a loaded board is not dirty', () => {
  addItems([photo()]);
  assert.ok(isDirty());
  fresh();
  assert.ok(!isDirty(), 'opening a board must not present it as already edited');
});

test('loading clears the selection and the history', () => {
  const [a] = addItems([photo()]);
  select([a.id]);
  fresh();
  assert.equal(selection.size, 0);
  assert.equal(undo(), false);
});

test('serialising and reloading preserves the items', () => {
  addItems([photo({ x: 12.345, y: -6.7, name: 'a.png' }), note({ meta: { text: 'hi' } })]);
  const data = serializeBoard();
  fresh();
  loadBoard(data);
  assert.equal(board.items.length, 2);
  assert.equal(board.items[0].name, 'a.png');
  assert.equal(board.items[1].meta.text, 'hi');
});

test('Mobile is a six-column vertical layout', () => {
  fresh([
    photo({ id: 'wide', x: 300, y: 200, w: 800, h: 400 }),
    note({ id: 'note', x: -500, y: 100 }),
  ]);

  assert.ok(setBoardMode('mobile'));
  assert.equal(mobileBoardWidth(), 384);
  assert.equal(mobileBoardTop(), 640);
  const [wide, noteItem] = board.items;
  assert.equal(wide.w, mobileBoardWidth());
  assert.equal(wide.h, 192, 'a wide item keeps its aspect ratio when first fitted');
  for (const item of board.items) {
    assert.ok(item.x - item.w / 2 >= -mobileBoardWidth() / 2);
    assert.ok(item.x + item.w / 2 <= mobileBoardWidth() / 2);
    assert.equal(item.rot, 0);
  }
  assert.equal(wide.y + wide.h / 2, mobileBoardTop(), 'the feed starts at its top edge');
  assert.ok(noteItem.y + noteItem.h / 2 < wide.y - wide.h / 2);
});

test('Mobile has a finite top and no lower geometry bound', () => {
  fresh([photo({ id: 'card', w: 200, h: 100 })]);
  setBoardMode('mobile');

  applyGeom([{ ...snapshotGeom(['card'])[0], y: 100000 }]);
  assert.equal(byId('card').y + byId('card').h / 2, mobileBoardTop());
  applyGeom([{ ...snapshotGeom(['card'])[0], y: -100000 }]);
  assert.equal(byId('card').y, -100000);
});

test('Desktop and Mobile keep independent geometry in one file', () => {
  fresh([photo({ id: 'card', x: 120, y: 40, w: 200, h: 100 })]);

  setBoardMode('mobile');
  applyGeom([{ ...snapshotGeom(['card'])[0], x: 0, y: -700, w: 300, h: 180 }]);
  setBoardMode('desktop');
  assert.equal(byId('card').x, 120);
  applyGeom([{ ...snapshotGeom(['card'])[0], x: 500, y: 80 }]);

  setBoardMode('mobile');
  assert.equal(byId('card').y, -700);
  const data = serializeBoard();
  assert.equal(data.items[0].x, 500, 'the legacy item geometry stays Desktop');
  assert.equal(data.layouts.desktop[0].x, 500);
  assert.equal(data.layouts.mobile[0].y, -700);
  assert.equal('layoutMode' in data, false, 'the device choice does not travel');

  loadBoard(data);
  assert.equal(byId('card').y, -700);
  setBoardMode('desktop');
  assert.equal(byId('card').x, 500);
});

test('content and settings are shared between both layouts', () => {
  fresh([note({ id: 'shared', name: 'before', meta: { text: 'same note' } })]);
  setBoardMode('mobile');
  renameItem('shared', 'after');
  setSetting('spacing', 36);
  setBoardMode('desktop');

  assert.equal(byId('shared').name, 'after');
  assert.equal(byId('shared').meta.text, 'same note');
  assert.equal(board.settings.spacing, 36);
});

// ---------------------------------------------------------------------------
// Loading a board that is not one
//
// board.json arrives parsed but unvalidated, out of a file this app did not
// necessarily write. There is no undo across a load, so a load that fails
// half-way has no way back - which makes "all or nothing" the only acceptable
// outcome, and these are the shapes that used to break it.
// ---------------------------------------------------------------------------

test('a board whose items are not a list does not replace anything', () => {
  addItems([photo({ name: 'keep.png' })]);
  loadBoard({ title: 'poison', items: {} });
  assert.equal(board.title, 'poison', 'the load should still complete');
  assert.equal(board.items.length, 0);
  // The failure mode this replaced: title taken from the new board, items left
  // over from the old one, and no way back to either.
  assert.equal(serializeBoard().items.length, 0);
});

test('junk in the item list is dropped, not thrown over', () => {
  loadBoard({ title: 'T', items: [null, 'nonsense', 42, { type: 'note' }] });
  assert.equal(board.items.length, 1);
  assert.equal(board.items[0].type, 'note');
});

test('settings that are not an object fall back to the defaults', () => {
  loadBoard({ title: 'T', items: [], settings: 'nope' });
  assert.equal(board.settings.grid, true);
  assert.deepEqual(board.settings.appearance.vars, {});
});

test('a trash entry with no item is skipped', () => {
  loadBoard({ title: 'T', items: [], trash: [{ at: 1 }, null, { at: 2, item: { type: 'note' } }] });
  assert.equal(board.trash.length, 1);
});

test('an item field of the wrong type falls back rather than throwing', () => {
  loadBoard({ title: 'T', items: [{ id: 7, x: 'left', w: null, meta: 'text', name: 12 }] });
  const [it] = board.items;
  assert.equal(typeof it.id, 'string');
  assert.equal(it.x, 0);
  assert.equal(it.w, 240);
  assert.equal(it.name, '');
  assert.deepEqual(it.meta, {});
});

test('coordinates are rounded on the way out, not mangled', () => {
  addItems([photo({ x: 1 / 3, y: -2 / 3 })]);
  const data = serializeBoard();
  assert.equal(data.items[0].x, 0.33);
  assert.equal(data.items[0].y, -0.67);
});

test('the bin travels with the board', () => {
  const [a] = addItems([photo({ name: 'gone.png' })]);
  removeItems([a.id]);
  const data = serializeBoard();
  assert.equal(data.trash.length, 1);
  fresh();
  loadBoard(data);
  assert.equal(board.trash.length, 1, 'saving must not be a trapdoor under the bin');
  assert.equal(board.trash[0].item.name, 'gone.png');
});

test('topZ grows as items are added', () => {
  assert.equal(topZ(), 0);
  addItems([photo(), photo()]);
  assert.equal(topZ(), 2);
  addItems([photo()]);
  assert.equal(topZ(), 3);
});

test('markDirty is idempotent', () => {
  fresh();
  assert.ok(!isDirty());
  markDirty(true);
  markDirty(true);
  assert.ok(isDirty());
  markDirty(false);
  assert.ok(!isDirty());
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

// ---------------------------------------------------------------------------
// The faces a board carries
// ---------------------------------------------------------------------------

const FONT_HASH = 'a'.repeat(64);
const FONT_HASH_2 = 'b'.repeat(64);

test('a board with no font list gets an empty one, not undefined', () => {
  fresh();
  assert.deepEqual(board.settings.fonts, []);
  // And it survives the round trip out, so the packer has something to walk.
  assert.deepEqual(serializeBoard().settings.fonts, []);
});

test('a well-formed font list is carried through', () => {
  loadBoard({ title: 'T', items: [], settings: { fonts: [
    { hash: FONT_HASH, family: 'Test Face' },
    { hash: FONT_HASH_2, family: 'Other' },
  ] } });
  assert.deepEqual(board.settings.fonts, [
    { hash: FONT_HASH, family: 'Test Face' },
    { hash: FONT_HASH_2, family: 'Other' },
  ]);
});

test('a font entry that could break a stylesheet is dropped', () => {
  // The family becomes a CSS family name inside a real declaration, out of a
  // .mbrd somebody else wrote. One bad entry costs its own entry - the same
  // bargain `vars` gets - rather than costing the board its other faces.
  loadBoard({ title: 'T', items: [], settings: { fonts: [
    { hash: FONT_HASH, family: 'a", monospace; display: none; "' },
    { hash: FONT_HASH_2, family: 'Good' },
    { hash: 'not-a-hash', family: 'Good' },
    { hash: FONT_HASH_2, family: 'Duplicate hash' },
    { family: 'No hash' },
    { hash: 'c'.repeat(64) },
    'not an object',
    null,
  ] } });
  assert.deepEqual(board.settings.fonts, [{ hash: FONT_HASH_2, family: 'Good' }]);
});

test('a font list is not a list', () => {
  for (const junk of ['fonts', 42, { hash: FONT_HASH }, null]) {
    loadBoard({ title: 'T', items: [], settings: { fonts: junk } });
    assert.deepEqual(board.settings.fonts, []);
  }
});

test('a board cannot carry a thousand faces', () => {
  const many = Array.from({ length: 50 }, (_, i) => ({
    hash: String(i).padStart(64, '0'), family: 'Face ' + i,
  }));
  loadBoard({ title: 'T', items: [], settings: { fonts: many } });
  assert.equal(board.settings.fonts.length, 8);
});

test('the defaults are not shared between boards', () => {
  // DEFAULT_SETTINGS holds `fonts` by reference, so a board that pushed onto it
  // in place would be editing the defaults every later board is built from.
  fresh();
  board.settings.fonts.push({ hash: FONT_HASH, family: 'Leaked' });
  fresh();
  assert.deepEqual(board.settings.fonts, []);
});
