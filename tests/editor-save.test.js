// The text editor's save (ui/viewer.ts through setItemText in state.ts) and
// its size ceiling. A save swaps the item's asset in place, every save in one
// opening of the editor folds into one undo step, and a file past EDIT_MAX is
// a ceiling somebody can lift - never a plain Error.

import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

import { board, addItems, setItemText, undo, redo, byId, setBoardMode, historyDepth } from '../web/assets/js/state.ts';
import { measureForEdit, EDIT_MAX } from '../web/assets/js/ui/editor/markdown.ts';
import { isOversize } from '../web/assets/js/consent.ts';
import { fresh } from './state-fixtures.js';

const H = n => String(n).repeat(64).slice(0, 64);
const doc = (props = {}) => ({ type: 'text', w: 300, h: 360, name: 'a.md', asset: { hash: H(1) }, meta: { ext: 'md' }, ...props });

beforeEach(() => {
  setBoardMode('desktop');
  fresh();
});

test('a save points the same item at the new bytes', () => {
  const [a] = addItems([doc()]);
  setItemText(a.id, H(2));
  assert.equal(byId(a.id).asset.hash, H(2));
  assert.equal(board.items.length, 1, 'the item is swapped in place, not replaced');
  assert.ok(undo());
  assert.equal(byId(a.id).asset.hash, H(1));
  assert.ok(redo());
  assert.equal(byId(a.id).asset.hash, H(2));
});

test('every save in one opening is one undo step', () => {
  const [a] = addItems([doc()]);
  const depth = historyDepth().undo;
  let step = setItemText(a.id, H(2), null);
  step = setItemText(a.id, H(3), step);
  step = setItemText(a.id, H(4), step);
  assert.equal(historyDepth().undo, depth + 1);
  assert.ok(undo());
  assert.equal(byId(a.id).asset.hash, H(1), 'one undo goes back past every save');
  assert.ok(redo());
  assert.equal(byId(a.id).asset.hash, H(4));
});

test('a second opening is a second step', () => {
  const [a] = addItems([doc()]);
  setItemText(a.id, H(2), setItemText(a.id, H(2), null));
  setItemText(a.id, H(3), null);
  assert.ok(undo());
  assert.equal(byId(a.id).asset.hash, H(2));
});

test('the same bytes, or no such item, is no step at all', () => {
  const [a] = addItems([doc()]);
  const depth = historyDepth().undo;
  assert.equal(setItemText(a.id, H(1), null), null);
  assert.equal(setItemText('nope', H(2), null), null);
  assert.equal(setItemText(a.id, 'not a hash', null), null);
  assert.equal(historyDepth().undo, depth);
});

test('a file past the ceiling throws Oversize, and a lifted one passes', () => {
  assert.doesNotThrow(() => measureForEdit(EDIT_MAX));
  let caught = null;
  try { measureForEdit(EDIT_MAX + 1); } catch (err) { caught = err; }
  assert.ok(isOversize(caught), `threw ${caught?.name}, not Oversize`);
  assert.equal(caught.ceiling, 'text-edit');
  assert.doesNotThrow(() => measureForEdit(EDIT_MAX * 10, true));
});
