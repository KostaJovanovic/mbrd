// Nudge narrowed to a selection or a fence: what is in scope is pushed apart,
// and everything else holds still around it.

import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

import { byId, addItems, select, setBoardMode } from '../web/assets/js/state.ts';
import { createCommands } from '../web/assets/js/commands.ts';
import { fresh, photo, fence } from './state-fixtures.js';

// A new fence opens its name editor on the next frame; there is no frame here.
globalThis.requestAnimationFrame ??= () => 0;

const commands = () => createCommands(
  { toWorld: () => ({ x: 0, y: 0 }), left: 0, top: 0, cx: 0, cy: 0 },
  { resetAppearance() {}, setWhimsy() {} });

beforeEach(() => {
  setBoardMode('desktop');
  fresh();
});

const apart = (a, b) =>
  Math.abs(a.x - b.x) * 2 >= a.w + b.w || Math.abs(a.y - b.y) * 2 >= a.h + b.h;

test('Nudge these moves only the selection', () => {
  const [a, b, c] = addItems([photo({ x: 0, y: 0 }), photo({ x: 50, y: 0 }), photo({ x: 100, y: 0 })]);
  select([a.id, b.id]);
  commands().nudgeSelection();
  assert.equal(byId(c.id).x, 100, 'the card left out stays');
  assert.ok(apart(byId(a.id), byId(b.id)));
  assert.ok(apart(byId(a.id), byId(c.id)) && apart(byId(b.id), byId(c.id)), 'and is cleared off');
});

test('Fit to contents closes a fence round what is in it, in one undo step', async () => {
  const { undo } = await import('../web/assets/js/state.ts');
  const [f] = addItems([fence({ x: 0, y: 0, w: 2000, h: 2000 })]);
  const [a] = addItems([photo({ x: 100, y: 100 })]);
  commands().fitFence(f.id);
  const fen = byId(f.id), card = byId(a.id);
  assert.ok(fen.w < 2000 && fen.h < 2000);
  assert.ok(fen.x - fen.w / 2 < card.x - card.w / 2 && fen.x + fen.w / 2 > card.x + card.w / 2);
  undo();
  assert.equal(byId(f.id).w, 2000);
});

test('one card can be fenced from the menu', async () => {
  const { board } = await import('../web/assets/js/state.ts');
  const [a] = addItems([photo({ x: 0, y: 0 })]);
  select([a.id]);
  commands().fenceSelection();
  assert.equal(board.items.filter(i => i.type === 'fence').length, 1);
});

test('Gather and fence is one undo step', async () => {
  const { board, undo } = await import('../web/assets/js/state.ts');
  const [a, b] = addItems([photo({ x: 0, y: 0 }), photo({ x: 90000, y: 0 })]);
  addItems([photo({ x: -9000, y: 9000 })]);
  select([a.id, b.id]);
  commands().gatherAndFence();
  assert.equal(board.items.filter(i => i.type === 'fence').length, 1);
  assert.ok(Math.abs(byId(a.id).x - byId(b.id).x) < 1000, 'gathered');
  undo();
  assert.equal(board.items.filter(i => i.type === 'fence').length, 0);
  assert.equal(byId(b.id).x, 90000, 'and back where it was');
});

test('Nudge fence moves only what is inside, and grows the fence', () => {
  const [f] = addItems([fence({ x: 0, y: 0, w: 500, h: 500 })]);
  const [a, b] = addItems([photo({ x: 0, y: 0 }), photo({ x: 40, y: 0 })]);
  const [out1, out2] = addItems([photo({ x: 2000, y: 0 }), photo({ x: 2040, y: 0 })]);
  commands().nudgeFence(f.id);
  assert.ok(apart(byId(a.id), byId(b.id)));
  assert.equal(byId(out1.id).x, 2000);
  assert.equal(byId(out2.id).x, 2040, 'an overlap outside the fence is left alone');
});
