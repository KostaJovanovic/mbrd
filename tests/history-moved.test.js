// 'history:moved': an undo or redo says what it did, for ui/hud.ts to show
// beside the buttons. And undoAction(), the Undo on a receipt, which undoes
// only while its change is still on top.

import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

import {
  addItems, undo, redo, bus, setBoardMode, undoAction, board,
} from '../web/assets/js/state.ts';
import { fresh, photo } from './state-fixtures.js';

beforeEach(() => {
  setBoardMode('desktop');
  fresh();
});

test('undo and redo announce the step by name', () => {
  const heard = [];
  const off = bus.on('history:moved', e => heard.push(e));
  addItems([photo()], 'Add');
  undo();
  redo();
  off?.();
  assert.deepEqual(heard, [{ undo: true, label: 'Add' }, { undo: false, label: 'Add' }]);
});

test("a receipt's Undo takes back its own change, and nothing done after it", () => {
  addItems([photo()], 'First');
  const action = undoAction();
  addItems([photo()], 'Second');
  action.run();
  assert.equal(board.items.length, 2, 'a stale Undo must not undo the later change');
  const fresh = undoAction();
  fresh.run();
  assert.equal(board.items.length, 1);
});

test('nothing to undo says nothing', () => {
  const heard = [];
  const off = bus.on('history:moved', e => heard.push(e));
  undo();
  off?.();
  assert.deepEqual(heard, []);
});
