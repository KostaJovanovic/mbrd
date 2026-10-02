// removeConnectionsOf(): every line touching a set of cards, gone in one
// commit, so one Ctrl+Z brings them all back - the card menu's "Remove N
// connections".

import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

import {
  addItems, addConnections, board, undo, setBoardMode, removeConnectionsOf, areConnected,
} from '../web/assets/js/state.ts';
import { fresh, photo } from './state-fixtures.js';

beforeEach(() => {
  setBoardMode('desktop');
  fresh();
});

test('the lines touching the set go, the rest stay, and one undo restores them', () => {
  const [a, b, c, d] = addItems([0, 1, 2, 3].map(i => photo({ x: i * 300, y: 0 })));
  addConnections([[a.id, b.id], [a.id, c.id], [c.id, d.id]]);
  assert.equal(removeConnectionsOf([a.id]), 2);
  assert.equal(board.connections.length, 1);
  assert.ok(areConnected(c.id, d.id), 'a line between two others is not touched');
  undo();
  assert.equal(board.connections.length, 3, 'one step, so one undo');
});

test('a set with no lines removes nothing and commits nothing', () => {
  const [a] = addItems([photo({ x: 0, y: 0 })]);
  assert.equal(removeConnectionsOf([a.id]), 0);
});
