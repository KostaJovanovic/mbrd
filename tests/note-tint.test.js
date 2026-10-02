// A note's sheet, changed after it was written: setNoteTint() in state.ts, the
// Colour row on a note's menu. One undo step, notes only, sheets 1-4 only.

import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

import {
  addItems, byId, undo, setBoardMode, setNoteTint, serializeBoard, loadBoard,
} from '../web/assets/js/state.ts';
import { fresh, note, photo } from './state-fixtures.js';

beforeEach(() => {
  setBoardMode('desktop');
  fresh();
});

test('a note changes sheet, and one undo puts the old one back', () => {
  const [n] = addItems([note({ x: 0, y: 0, meta: { text: 'n', tint: 1 } })]);
  setNoteTint(n.id, 3);
  assert.equal(byId(n.id).meta.tint, 3);
  undo();
  assert.equal(byId(n.id).meta.tint, 1);
});

test('only a sheet that exists, and only on a note', () => {
  const [n, p] = addItems([note({ x: 0, y: 0, meta: { text: 'n', tint: 2 } }), photo({ x: 300, y: 0 })]);
  setNoteTint(n.id, 2.5);
  assert.equal('tint' in byId(n.id).meta, false, 'not a sheet, so the default one');
  setNoteTint(p.id, 2);
  assert.equal(byId(p.id).meta?.tint, undefined, 'a photograph has no sheet');
});

test('the new sheet survives a save', () => {
  const [n] = addItems([note({ x: 0, y: 0 })]);
  setNoteTint(n.id, 4);
  loadBoard(serializeBoard());
  assert.equal(byId(n.id).meta.tint, 4);
});
