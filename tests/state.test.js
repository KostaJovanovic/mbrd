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
  select, deselect, clearSelection, selectAll, duplicateItems,
  copyItems, cutItems, pasteItems, clipboardSize, clipboardHasOurs, clipboardBounds,
  stuckTo, stuckFollowers, stuckPlacement, restick, STICK_MIN, setItemText, renameItem, NOTE_MAX,
  setSetting, setItemFit, snapshotGeom, applyGeom, commitGeom,
  setBoardMode, mobileBoardWidth, mobileBoardTop, mobileBoardBottom,
  recheckBoardGeometry, baseStep, placeMobileItems,
  raiseSelection, lowerSelection, visualStackOrder, selectionHasStackOverlap,
  setTitle, cleanBoardTitle, cleanBoardTitleDraft, BOARD_TITLE_MAX,
  ensureTitleCard, restoreTitleCard, isTitleHidden, resetTitlePosition, TITLE_ID,
} from '../web/assets/js/state.js';
import { itemBounds, overlapFraction, CELL_GAP } from '../web/assets/js/geometry.js';
import { hash } from './helpers.js';

const fresh = (items = []) => loadBoard({ title: 'T', items });

const note = (props = {}) => ({ type: 'note', w: 100, h: 100, meta: { text: 'n' }, ...props });
const photo = (props = {}) => ({ type: 'image', w: 200, h: 200, ...props });

beforeEach(() => {
  setBoardMode('desktop');
  fresh();
});

test('board names are short portable filename stems wherever they enter state', () => {
  assert.equal(BOARD_TITLE_MAX, 32);
  assert.equal(cleanBoardTitleDraft('Mood '), 'Mood ',
    'live editing keeps the trailing space needed to type another word');
  assert.equal(cleanBoardTitleDraft('Mood Board'), 'Mood Board');
  assert.equal(cleanBoardTitle('  My / Board:*?  '), 'My Board');
  assert.equal(cleanBoardTitle('Mood Board'), 'Mood Board');
  assert.equal(cleanBoardTitle('123456789012345678901234567890123'), '12345678901234567890123456789012');
  assert.equal(cleanBoardTitle('CON'), '_CON', 'Windows device names are not filenames');
  assert.equal(cleanBoardTitle('A title.  '), 'A title');

  setTitle('An / invalid : board title');
  assert.equal(board.title, 'An invalid board title');

  loadBoard({ title: 'A far too long loaded board name that keeps going', items: [] });
  assert.equal(board.title, 'A far too long loaded board name',
    'opened boards obey the same limit as names typed in the UI');
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

test('deselect removes one selected item and leaves the rest', () => {
  const [a, b] = addItems([photo(), photo()]);
  select([a.id, b.id]);
  assert.equal(deselect(a.id), true);
  assert.deepEqual([...selection], [b.id]);
  assert.equal(deselect(a.id), false);
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

test('Mobile can use a six-column grid layout', () => {
  fresh([
    photo({ id: 'wide', x: 300, y: 200, w: 800, h: 400 }),
    note({ id: 'note', x: -500, y: 100 }),
  ]);

  assert.ok(setBoardMode('mobile'));
  setSetting('mobileColumns', 6);
  assert.equal(mobileBoardWidth(), 384);
  assert.equal(mobileBoardTop(), 384);
  const [wide, noteItem] = board.items;
  const inset = baseStep() * CELL_GAP;
  assert.equal(wide.w + 2 * inset, mobileBoardWidth());
  assert.equal(wide.meta.presnap.w + 2 * inset, mobileBoardWidth());
  assert.equal(
    wide.meta.presnap.h,
    wide.meta.presnap.w / 2,
    'the pre-grid fit keeps the original aspect ratio',
  );
  assert.equal((wide.h + 2 * inset) / baseStep(), 3, 'the visible item spans three rows');
  for (const item of board.items) {
    assert.ok(item.x - item.w / 2 >= -mobileBoardWidth() / 2);
    assert.ok(item.x + item.w / 2 <= mobileBoardWidth() / 2);
    assert.equal(item.rot, 0);
  }
  assert.equal(
    wide.y + wide.h / 2,
    mobileBoardTop() - inset,
    'the first item starts at the first inset grid edge',
  );
  assert.ok(Math.abs(
    wide.y - wide.h / 2 - (noteItem.y + noteItem.h / 2) - 2 * inset,
  ) < 1e-9, 'adjacent grid spans keep the lattice seam');
});

test('Mobile can switch between six- and eight-column grids', () => {
  fresh(Array.from({ length: 4 }, (_, index) =>
    photo({ id: `card-${index}`, w: 100, h: 100 })));
  setBoardMode('mobile');
  assert.equal(board.settings.mobileColumns, 8, 'eight columns are the Mobile default');
  setSetting('mobileColumns', 6);
  assert.equal(board.settings.mobileColumns, 6);
  assert.equal(mobileBoardWidth(), 384);
  assert.notEqual(byId('card-0').y, byId('card-3').y,
    'six columns fit three two-cell cards per row');

  setSetting('mobileColumns', 8);
  assert.equal(board.settings.mobileColumns, 8);
  assert.equal(mobileBoardWidth(), 512);
  assert.equal(new Set(board.items.map(item => item.y)).size, 1,
    'eight columns fit four two-cell cards in the first row');
  for (let i = 0; i < board.items.length; i++) {
    assert.ok(board.items[i].x - board.items[i].w / 2 >= -mobileBoardWidth() / 2);
    assert.ok(board.items[i].x + board.items[i].w / 2 <= mobileBoardWidth() / 2);
    for (let j = i + 1; j < board.items.length; j++) {
      assert.equal(overlapFraction(board.items[i], board.items[j]), 0);
    }
  }

  setBoardMode('desktop');
  assert.equal(board.settings.mobileColumns, 6, 'Desktop does not inherit the Mobile width');
  setSetting('mobileColumns', 8);
  assert.equal(board.settings.mobileColumns, 6, 'Desktop cannot change the Mobile-only setting');
  setBoardMode('mobile');
  assert.equal(board.settings.mobileColumns, 8, 'the Mobile profile keeps its choice');
});

test('missing or invalid Mobile grid widths fall back to eight columns', () => {
  setBoardMode('mobile');
  setSetting('mobileColumns', 6);
  loadBoard({ items: [] });
  assert.equal(board.settings.mobileColumns, 8,
    'a new board does not inherit the previous board width');

  loadBoard({
    items: [],
    layouts: {
      mobile: { items: [], settings: { mobileColumns: 7 } },
    },
  });
  assert.equal(board.settings.mobileColumns, 8);
});

test('a new Mobile board starts with grid snapping on', () => {
  fresh();
  assert.equal(board.settings.snap, false);
  setBoardMode('mobile');
  assert.equal(board.settings.snap, true);
  fresh();
  assert.equal(board.settings.snap, true, 'New keeps the Mobile default');
  loadBoard({ title: 'Saved choice', settings: { snap: false } });
  assert.equal(board.settings.snap, false, 'an opened board keeps its explicit choice');
});

test('a Mobile folder import is appended without overlaps', () => {
  fresh();
  setBoardMode('mobile');
  addItems([photo({ id: 'existing', x: 0, y: 0, w: 300, h: 220 })]);
  const imported = addItems([
    photo({ x: 900, y: 100, w: 800, h: 400 }),
    note({ x: -900, y: 100, w: 260, h: 180 }),
    photo({ x: 0, y: 100, w: 320, h: 500 }),
  ], 'Add folder', { avoidOverlap: true });

  const all = [byId('existing'), ...imported];
  for (let i = 0; i < all.length; i++) {
    for (let j = i + 1; j < all.length; j++) {
      assert.equal(overlapFraction(all[i], all[j]), 0,
        `${all[i].id} overlaps ${all[j].id}`);
    }
  }
  for (const item of imported) {
    assert.ok(item.x - item.w / 2 >= -mobileBoardWidth() / 2);
    assert.ok(item.x + item.w / 2 <= mobileBoardWidth() / 2);
  }

  setSetting('snap', false);
  for (let i = 0; i < board.items.length; i++) {
    for (let j = i + 1; j < board.items.length; j++) {
      assert.equal(overlapFraction(board.items[i], board.items[j]), 0,
        'leaving the grid restored an overlapping import');
    }
  }
});

test('Mobile placement packs a large batch into grid rows and columns', () => {
  fresh();
  setBoardMode('mobile');
  const batch = Array.from({ length: 60 }, (_, i) =>
    photo({ id: `dense-${i}`, x: 0, y: 0, w: [100, 164, 228][i % 3], h: 100 }));
  const placed = placeMobileItems(batch, []);

  for (let i = 0; i < placed.length; i++) {
    for (let j = i + 1; j < placed.length; j++) {
      assert.ok(overlapFraction(placed[i], placed[j]) < 1e-12,
        `${placed[i].id} overlaps ${placed[j].id}`);
    }
  }

  const step = baseStep();
  const inset = step * CELL_GAP;
  for (const item of placed) {
    const bounds = itemBounds([item]);
    assert.ok(Math.abs((bounds.x0 - inset) / step -
      Math.round((bounds.x0 - inset) / step)) < 1e-9);
    assert.ok(Math.abs((bounds.y0 - inset) / step -
      Math.round((bounds.y0 - inset) / step)) < 1e-9);
    assert.ok(Math.abs((item.w + 2 * inset) / step -
      Math.round((item.w + 2 * inset) / step)) < 1e-9);
    assert.ok(Math.abs((item.h + 2 * inset) / step -
      Math.round((item.h + 2 * inset) / step)) < 1e-9);
  }
  assert.equal(placed[0].y, placed[1].y, 'compatible spans share a row');
  assert.ok(placed[0].x < placed[1].x, 'the shared row fills left to right');
  assert.ok(new Set(placed.slice(0, 6).map(item => item.x)).size > 1,
    'packing uses more than the centre column');
});

test('Mobile rearrangement preserves visible sizes and stays inside cell seams', () => {
  fresh();
  setBoardMode('mobile');
  const step = baseStep();
  const inset = step * CELL_GAP;
  const latticeSizes = [
    { w: 2 * step - 2 * inset, h: step - 2 * inset },
    { w: step - 2 * inset, h: 2 * step - 2 * inset },
    { w: 3 * step - 2 * inset, h: 2 * step - 2 * inset },
  ];
  const items = latticeSizes.map((size, index) => photo({
    id: `stable-${index}`,
    ...size,
    meta: {
      presnap: {
        x: 800 - index * 300,
        y: index * 90,
        w: 91 + index * 17,
        h: 73 + index * 13,
      },
    },
  }));

  const first = placeMobileItems(items, [], { preserveSize: true });
  const second = placeMobileItems(first, [], { preserveSize: true });
  assert.deepEqual(
    second.map(item => ({ w: item.w, h: item.h })),
    latticeSizes,
    'repeated rearrangement must not rebuild visible sizes from presnap',
  );

  for (const item of second) {
    const bounds = itemBounds([item]);
    assert.ok(Math.abs((bounds.x0 - inset) / step -
      Math.round((bounds.x0 - inset) / step)) < 1e-9);
    assert.ok(Math.abs((bounds.y1 + inset) / step -
      Math.round((bounds.y1 + inset) / step)) < 1e-9);
    assert.ok(bounds.x0 >= -mobileBoardWidth() / 2 + inset - 1e-9);
    assert.ok(bounds.x1 <= mobileBoardWidth() / 2 - inset + 1e-9);
  }
  for (let i = 0; i < second.length; i++) {
    for (let j = i + 1; j < second.length; j++) {
      assert.equal(overlapFraction(second[i], second[j]), 0);
    }
  }
});

test('Mobile keeps freely moved items clear of the board border', () => {
  fresh();
  setBoardMode('mobile');
  setSetting('snap', false);
  const step = baseStep();
  const inset = step * CELL_GAP;
  const [item] = addItems([photo({
    id: 'edge',
    x: -10000,
    y: 10000,
    w: mobileBoardWidth(),
    h: 100,
  })]);
  const bounds = itemBounds([item]);

  assert.equal(item.w, mobileBoardWidth() - 2 * inset);
  assert.ok(Math.abs(bounds.x0 - (-mobileBoardWidth() / 2 + inset)) < 1e-9);
  assert.ok(Math.abs(bounds.x1 - (mobileBoardWidth() / 2 - inset)) < 1e-9);
  assert.ok(Math.abs(bounds.y1 - (mobileBoardTop() - inset)) < 1e-9);
});

test('a Mobile rearrangement can restore its collision-free unsnapped grid', () => {
  fresh([
    photo({ id: 'left', x: 900, y: 0, w: 100, h: 100 }),
    photo({ id: 'right', x: -900, y: 0, w: 164, h: 100 }),
  ]);
  setBoardMode('mobile');
  const before = snapshotGeom(['left', 'right']);
  const packed = placeMobileItems(board.items, []);
  applyGeom(before.map((geometry, index) => ({
    ...geometry,
    x: packed[index].x,
    y: packed[index].y,
    w: packed[index].w,
    h: packed[index].h,
    rot: packed[index].rot,
    presnap: packed[index].meta.presnap,
  })));
  commitGeom('Rearrange', before, ['left', 'right'], { preservePresnap: true });

  const packedX = byId('left').x;
  undo();
  assert.equal(byId('left').x, before[0].x);
  assert.deepEqual(byId('left').meta.presnap, before[0].presnap);
  redo();
  assert.equal(byId('left').x, packedX);

  setSetting('snap', false);
  assert.equal(byId('left').y, byId('right').y, 'the raw spans still share a row');
  assert.equal(overlapFraction(byId('left'), byId('right')), 0);
});

test('Mobile is at least twenty-five rows tall and follows its lowest item', () => {
  fresh([photo({ id: 'card', w: 200, h: 100 })]);
  setBoardMode('mobile');

  const step = baseStep();
  const inset = step * CELL_GAP;
  assert.equal(mobileBoardTop() - mobileBoardBottom(), 25 * step);
  applyGeom([{ ...snapshotGeom(['card'])[0], y: 100000 }]);
  assert.equal(byId('card').y + byId('card').h / 2, mobileBoardTop() - inset);
  applyGeom([{ ...snapshotGeom(['card'])[0], y: -100000 }]);
  assert.equal(byId('card').y, -100000);
  assert.equal(
    mobileBoardBottom(),
    byId('card').y - byId('card').h / 2 - 15 * step,
  );
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
  assert.equal(data.layouts.desktop.items[0].x, 500);
  assert.equal(data.layouts.mobile.items[0].y, -700);
  assert.equal('layoutMode' in data, false, 'the device choice does not travel');

  loadBoard(data);
  assert.equal(byId('card').y, -700);
  setBoardMode('desktop');
  assert.equal(byId('card').x, 500);
});

test('content is shared between both layouts, settings are not', () => {
  fresh([note({ id: 'shared', name: 'before', meta: { text: 'same note' } })]);
  setBoardMode('mobile');
  renameItem('shared', 'after');
  setSetting('spacing', 36);
  setBoardMode('desktop');

  // One set of items under two arrangements: a rename made in either is a
  // rename of the same note.
  assert.equal(byId('shared').name, 'after');
  assert.equal(byId('shared').meta.text, 'same note');

  // Desktop spacing is private. Mobile has no spacing control and always packs
  // edge-to-edge - see docs/layout-settings.md.
  assert.equal(board.settings.spacing, 12, 'Desktop keeps its own spacing');
  setBoardMode('mobile');
  assert.equal(board.settings.spacing, 0, 'Mobile refuses a spacing value');
});

test('The board name style is board-wide, editable from either layout, and round-trips', () => {
  fresh();
  setBoardMode('mobile');
  setSetting('mobileHeader', {
    font: 'Fraunces',
    size: 17.5,
    stretch: 135,
    weight: 625,
    italic: true,
    axes: { opsz: 72, BAD: 4, 'TOO-LONG': 9 },
  });
  // Board-level now (board.mobileHeader), not per-layout: the Mobile masthead
  // and the Desktop title card are one style. Bad or over-long axis tags are
  // dropped; the unwritten fields land on their defaults - 100 is the face's own
  // line height, wrap is on, offset centres. See DEFAULT_MOBILE_HEADER.
  assert.deepEqual(board.mobileHeader, {
    font: 'Fraunces',
    size: 17.5,
    stretch: 135,
    leading: 100,
    weight: 625,
    offset: 0,
    italic: true,
    wrap: true,
    axes: { opsz: 72 },
  });

  const data = serializeBoard();

  // Shared, not per-layout: Desktop sees the very same style...
  setBoardMode('desktop');
  assert.equal(board.mobileHeader.size, 17.5, 'Desktop sees the shared style');
  // ...and may edit it (the title card's pen), with Mobile then seeing the change.
  setSetting('mobileHeader', { ...board.mobileHeader, size: 24 });
  assert.equal(board.mobileHeader.size, 24, 'Desktop can edit the shared style');
  setBoardMode('mobile');
  assert.equal(board.mobileHeader.size, 24, 'the edit crossed to the other layout');

  // The serialised style comes back whole.
  loadBoard(data);
  assert.equal(board.mobileHeader.size, 17.5);
  assert.equal(board.mobileHeader.stretch, 135);
  assert.equal(board.mobileHeader.leading, 100);
  assert.equal(board.mobileHeader.weight, 625);
  assert.equal(board.mobileHeader.italic, true);
  assert.deepEqual(board.mobileHeader.axes, { opsz: 72 });
});

test('media fit is a board-wide default with an undoable per-item override', () => {
  fresh([
    { id: 'pic', type: 'image', asset: { hash: hash('a'), embedded: true } },
    { id: 'clip', type: 'video', asset: { hash: hash('b'), embedded: true } },
  ]);
  // Defaults to fit (fill is opt-in), whatever a caller passes that is not the
  // one other value.
  assert.equal(board.mediaFit, 'contain');

  // Board-wide, and one value for both layouts.
  setSetting('mediaFit', 'cover');
  assert.equal(board.mediaFit, 'cover');
  setBoardMode('mobile');
  assert.equal(board.mediaFit, 'cover', 'the default is board-wide, not per-layout');
  setBoardMode('desktop');

  // A per-item override is undoable and independent of the default.
  setItemFit('pic', 'contain');
  assert.equal(byId('pic').meta.fit, 'contain');
  undo();
  assert.equal(byId('pic').meta.fit, undefined, 'undo clears the override');
  redo();
  assert.equal(byId('pic').meta.fit, 'contain', 'redo restores it');

  // Only photos and videos are steerable, and the value is validated.
  setItemFit('clip', 'sideways');
  assert.equal(byId('clip').meta.fit, undefined, 'a bad value is ignored');

  // Both the default and the override survive a round-trip.
  const data = serializeBoard();
  loadBoard(data);
  assert.equal(board.mediaFit, 'cover', 'the board default round-trips');
  assert.equal(byId('pic').meta.fit, 'contain', 'the per-item override round-trips');
});

test('paletteSources is a board-wide count, clamped and round-tripped', () => {
  fresh();
  assert.equal(board.paletteSources, 12, 'defaults to the count the feature always used');

  setSetting('paletteSources', 6);
  assert.equal(board.paletteSources, 6);
  setBoardMode('mobile');
  assert.equal(board.paletteSources, 6, 'the count is board-wide, not per-layout');
  setBoardMode('desktop');

  // Clamped to [1, 24] and rounded, whatever a caller or an edited file offers.
  setSetting('paletteSources', 99);
  assert.equal(board.paletteSources, 24, 'held under the sampler ceiling');
  setSetting('paletteSources', 0);
  assert.equal(board.paletteSources, 1, 'at least one picture');

  const data = serializeBoard();
  loadBoard(data);
  assert.equal(board.paletteSources, 1, 'round-trips');
  loadBoard({ title: 'T', items: [] });
  assert.equal(board.paletteSources, 12, 'a file without the key reads as the default');
});

test('A board that stored the name style under settings still loads it', () => {
  fresh();
  // Files written before the style moved to board level carry it inside
  // settings; loadBoard reads that as the fallback source.
  loadBoard({ settings: { mobileHeader: { font: 'Georgia', size: 20 } } });
  assert.equal(board.mobileHeader.font, 'Georgia');
  assert.equal(board.mobileHeader.size, 20);
});

test('the title card is a singleton the app seeds and holds to one', () => {
  fresh();
  // loadBoard leaves it to the app - a bare board of items carries none.
  assert.equal(board.items.filter(i => i.type === 'title').length, 0);
  ensureTitleCard();
  const titles = board.items.filter(i => i.type === 'title');
  assert.equal(titles.length, 1);
  assert.equal(titles[0].id, TITLE_ID);
  ensureTitleCard();
  assert.equal(board.items.filter(i => i.type === 'title').length, 1, 'seeding twice adds nothing');
});

test('deleting the title card hides it rather than binning it, and undo reverses that', () => {
  fresh();
  ensureTitleCard();
  const binned = board.trash.length;
  removeItems([TITLE_ID]);
  assert.equal(isTitleHidden(), true);
  assert.equal(board.items.some(i => i.type === 'title'), false);
  assert.equal(board.trash.length, binned, 'the title card never enters the bin');
  undo();
  assert.equal(isTitleHidden(), false);
  assert.equal(board.items.some(i => i.id === TITLE_ID), true, 'undo puts it back');
});

test('a mixed delete bins the ordinary items and only hides the title card', () => {
  fresh([photo({ id: 'p' })]);
  ensureTitleCard();
  removeItems(['p', TITLE_ID]);
  assert.equal(isTitleHidden(), true);
  assert.equal(board.trash.length, 1, 'the photo is binned');
  assert.equal(board.trash[0].item.id, 'p');
  assert.equal(board.trash.some(t => t.item.id === TITLE_ID), false);
});

test('restoreTitleCard brings the deleted card back', () => {
  fresh();
  ensureTitleCard();
  removeItems([TITLE_ID]);
  assert.equal(isTitleHidden(), true);
  restoreTitleCard();
  assert.equal(isTitleHidden(), false);
  assert.equal(board.items.some(i => i.id === TITLE_ID), true);
});

test('the title card and its deleted state survive a save and reload', () => {
  fresh();
  ensureTitleCard();
  loadBoard(serializeBoard());
  assert.equal(board.items.filter(i => i.type === 'title').length, 1, 'the saved card comes back');
  assert.equal(isTitleHidden(), false);

  removeItems([TITLE_ID]);
  loadBoard(serializeBoard());
  assert.equal(isTitleHidden(), true, 'the deleted state persists');
  ensureTitleCard();
  assert.equal(board.items.some(i => i.type === 'title'), false,
    'a board that threw the card away keeps it away');
});

test('the title card cannot be copied, cut or duplicated, and a group skips it', () => {
  fresh([photo({ id: 'a', w: 100, h: 100 })]);
  ensureTitleCard();

  // On its own: nothing lands on the clipboard, nothing is duplicated.
  assert.equal(copyItems([TITLE_ID]), '', 'the title card copies to nothing');
  assert.equal(clipboardSize(), 0);
  assert.equal(duplicateItems([TITLE_ID]).length, 0, 'the title card does not duplicate');
  assert.equal(board.items.filter(i => i.type === 'title').length, 1, 'still a singleton');

  // In a group: the ordinary card comes along, the title card is left behind.
  copyItems(['a', TITLE_ID]);
  assert.equal(clipboardSize(), 1, 'only the ordinary card is on the clipboard');
  const copies = duplicateItems(['a', TITLE_ID]);
  assert.equal(copies.length, 1, 'the group duplicates without the title card');
  assert.equal(copies.every(c => c.type !== 'title'), true);

  // Cutting a group leaves the title card on the board (not copied, not binned).
  cutItems(['a', TITLE_ID]);
  assert.equal(board.items.some(i => i.id === TITLE_ID), true, 'the title card survives a cut');
});

test('resetTitlePosition sends the card home, undoably, and no-ops when already there', () => {
  fresh();
  ensureTitleCard();
  const title = () => board.items.find(i => i.type === 'title');
  const home = { x: title().x, y: title().y };

  resetTitlePosition();
  assert.equal(undo(), false, 'already home: nothing to undo');

  applyGeom([{ id: title().id, x: 500, y: -500, w: title().w, h: title().h, rot: 0, z: title().z }]);
  resetTitlePosition();
  assert.deepEqual({ x: title().x, y: title().y }, home, 'back to the default spot');
  assert.ok(undo(), 'the reset is one undo step');
  assert.deepEqual({ x: title().x, y: title().y }, { x: 500, y: -500 }, 'undo restores where it was');
});

test('Mobile refuses a paper sheet however it is asked', () => {
  fresh([photo({ id: 'card', w: 200, h: 100 })]);
  setSetting('paper', 'a4');
  setSetting('paperResize', true);

  setBoardMode('mobile');
  assert.equal(board.settings.paper, '', 'the switch takes the sheet down');
  assert.equal(board.settings.paperResize, false);

  // The switch-time fixup runs once; this is the write that used to get past it.
  setSetting('paper', 'letter');
  setSetting('paperLandscape', true);
  setSetting('paperResize', true);
  assert.equal(board.settings.paper, '');
  assert.equal(board.settings.paperLandscape, false);
  assert.equal(board.settings.paperResize, false);

  setBoardMode('desktop');
  assert.equal(board.settings.paper, 'a4', 'Desktop still has the sheet it had');
  assert.equal(board.settings.paperResize, true);
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

// --- persisted-state invariants (AUD-07) -----------------------------------

test('infinite and non-positive geometry is refused on load', () => {
  loadBoard({ title: 'T', items: [{ id: 'a', x: Infinity, y: -Infinity, w: -5, h: 0, rot: NaN }] });
  const [it] = board.items;
  assert.equal(it.x, 0);
  assert.equal(it.y, 0);
  assert.equal(it.w, 240);
  assert.equal(it.h, 180);
  assert.equal(it.rot, 0);
});

test('a coordinate far past the range is clamped, not carried', () => {
  loadBoard({ title: 'T', items: [{ id: 'a', x: 1e9, y: -1e9 }] });
  const [it] = board.items;
  assert.equal(it.x, 1e7);
  assert.equal(it.y, -1e7);
});

test('duplicate item ids are made unique on load', () => {
  loadBoard({ title: 'T', items: [
    { id: 'dup', type: 'note' }, { id: 'dup', type: 'note' }, { id: 'dup', type: 'note' },
  ] });
  const ids = board.items.map(i => i.id);
  assert.equal(new Set(ids).size, 3);
  assert.equal(ids[0], 'dup');
});

test('a restored bin item cannot collide with a live id', () => {
  loadBoard({ title: 'T',
    items: [{ id: 'x', type: 'note' }],
    trash: [{ at: 1, item: { id: 'x', type: 'note' } }] });
  assert.notEqual(board.items[0].id, board.trash[0].item.id);
});

test('an over-long items array is capped on load', () => {
  const many = Array.from({ length: 20050 }, (_, i) => ({ id: 'i' + i, type: 'note' }));
  loadBoard({ title: 'T', items: many });
  assert.equal(board.items.length, 20000);
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

test('custom font axes survive but malformed axis metadata does not', () => {
  loadBoard({ title: 'T', items: [], settings: { fonts: [
    {
      hash: FONT_HASH,
      family: 'Variable Face',
      axes: [
        { tag: 'wght', min: 100, default: 425, max: 900 },
        { tag: 'bad', min: 0, default: 0, max: 1 },
        { tag: 'opsz', min: 9, default: 500, max: 144 },
      ],
    },
  ] } });
  assert.deepEqual(board.settings.fonts, [{
    hash: FONT_HASH,
    family: 'Variable Face',
    axes: [
      { tag: 'wght', min: 100, default: 425, max: 900 },
      { tag: 'opsz', min: 9, default: 144, max: 144 },
    ],
  }]);
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
