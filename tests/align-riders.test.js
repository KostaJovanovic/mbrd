// Align, Distribute and Same size move what rides the cards they move: a stuck
// note keeps its spot on its card, and a card pushed out of a fence the layout
// did not include grows that fence to keep it. One undo step puts all of it back.

import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

import { board, byId, addItems, select, undo, setBoardMode, stuckTo } from '../web/assets/js/state.ts';
import { createCommands } from '../web/assets/js/commands.ts';
import { fresh, note, photo, fence } from './state-fixtures.js';

const commands = () => createCommands(
  { toWorld: () => ({ x: 0, y: 0 }), left: 0, top: 0, cx: 0, cy: 0 },
  { resetAppearance() {}, setWhimsy() {} });

beforeEach(() => {
  setBoardMode('desktop');
  fresh();
});

test('a note stuck to an aligned card goes with it', () => {
  const [a, b] = addItems([photo({ x: 0, y: 0 }), photo({ x: 400, y: 300 })]);
  const [n] = addItems([note({ x: 440, y: 320 })]);
  assert.equal(stuckTo(byId(n.id))?.id, b.id);
  select([a.id, b.id]);
  commands().alignSelection('top');
  const card = byId(b.id), stuck = byId(n.id);
  assert.equal(card.y, byId(a.id).y);
  assert.equal(stuck.x - card.x, 40);
  assert.equal(stuck.y - card.y, 20);
  undo();
  assert.equal(byId(b.id).y, 300);
  assert.equal(byId(n.id).y, 320);
});

test('Same size moves a stuck note by its fraction of the card', () => {
  const [a, b] = addItems([photo({ x: 0, y: 0, w: 400, h: 200 }), photo({ x: 600, y: 0, w: 200, h: 200 })]);
  const [n] = addItems([note({ x: 650, y: 0 })]);
  select([a.id, b.id]);
  commands().matchSizeSelection(a.id, 'w');
  const card = byId(b.id);
  assert.equal(card.w, 400);
  // A quarter of the width right of centre, before and after.
  assert.equal(byId(n.id).x - card.x, 100);
});

test('a card aligned out of its fence grows the fence', () => {
  const [f] = addItems([fence({ x: 1000, y: 0, w: 600, h: 600 })]);
  const [a, b] = addItems([photo({ x: 0, y: -900 }), photo({ x: 1000, y: 0 })]);
  select([a.id, b.id]);
  commands().alignSelection('top');
  const fen = byId(f.id), card = byId(b.id);
  assert.ok(fen.y - fen.h / 2 <= card.y - card.h / 2, 'the fence reaches the card');
  assert.equal(board.items.filter(i => i.id === f.id).length, 1);
  undo();
  assert.equal(byId(f.id).h, 600);
});

test('a locked fence does not grow', () => {
  const [f] = addItems([fence({ x: 1000, y: 0, w: 600, h: 600, meta: { locked: true } })]);
  const [a, b] = addItems([photo({ x: 0, y: -900 }), photo({ x: 1000, y: 0 })]);
  select([a.id, b.id]);
  commands().alignSelection('top');
  assert.equal(byId(f.id).h, 600);
});
