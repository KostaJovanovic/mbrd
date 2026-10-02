// 'history:moved': an undo or redo says what it did, for ui/hud.ts to show
// beside the buttons - including one that falls through to the timeline.

import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

import { addItems, undo, redo, bus, setBoardMode } from '../web/assets/js/state.ts';
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

test('nothing to undo says nothing', () => {
  const heard = [];
  const off = bus.on('history:moved', e => heard.push(e));
  undo();
  off?.();
  assert.deepEqual(heard, []);
});
