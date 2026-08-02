// The internal clipboard, and the receipts it leaves on the system one.
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
  board, addItems, undo, byId, duplicateItems, copyItems,
  cutItems, pasteItems, clipboardSize, clipboardHasOurs, clipboardBounds,
  stuckTo, stuckFollowers, setBoardMode,
} from '../web/assets/js/state.js';
import { hash } from './helpers.js';
import { fresh, note, photo } from './state-fixtures.js';

beforeEach(() => {
  setBoardMode('desktop');
  fresh();
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

