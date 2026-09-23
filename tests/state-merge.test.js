// mergeBoard() on the live board: where the arrivals land in the layout on
// screen. planMerge() places them beside the host in Desktop terms, which on
// the Feed is outside the column (research/bug-hunt-2026-09-23.md, M5).

import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

import {
  board, addItems, mergeBoard, setBoardMode, mobileBoardWidth, byId, undo, redo,
} from '../web/assets/js/state.ts';
import { planMerge } from '../web/assets/js/merge.ts';
import { makeItem } from '../web/assets/js/board-model.ts';
import { fresh, photo } from './state-fixtures.js';

beforeEach(() => {
  setBoardMode('desktop');
  fresh();
});

const incoming = items => ({ items: items.map(makeItem), connections: [], audioOrder: [], tour: [] });

/** Whether a card lies inside the Feed's column, which is centred on x = 0. */
const inColumn = item => {
  const half = mobileBoardWidth() / 2;
  return item.x - item.w / 2 >= -half - 1e-6 && item.x + item.w / 2 <= half + 1e-6;
};

test('a merge on the Feed lands the arrivals in the column', () => {
  addItems([photo({ x: 0, y: 0 }), photo({ x: 400, y: 0 })]);
  setBoardMode('mobile');
  const plan = planMerge(incoming([
    { id: 'm1', type: 'image', x: 5000, y: 0, w: 300, h: 300 },
    { id: 'm2', type: 'image', x: 5400, y: 0, w: 300, h: 300 },
  ]), board.items.map(i => i.id), board.items);
  assert.equal(mergeBoard(plan), 2);
  for (const id of ['m1', 'm2']) assert.ok(inColumn(byId(id)), `${id} is in the column`);
  // Undo and redo put back the same places.
  const placed = byId('m1').x;
  undo();
  assert.equal(byId('m1'), undefined);
  redo();
  assert.equal(byId('m1').x, placed);
  // Back on the Canvas the arrivals have no place yet, so they are laid out
  // clear of the host's cards.
  setBoardMode('desktop');
  const [m1, m2] = [byId('m1'), byId('m2')];
  for (const host of board.items.filter(i => i.type === 'image' && !i.id.startsWith('m'))) {
    for (const m of [m1, m2]) {
      const apart = Math.abs(m.x - host.x) * 2 >= m.w + host.w || Math.abs(m.y - host.y) * 2 >= m.h + host.h;
      assert.ok(apart, `${m.id} overlaps ${host.id} on the Canvas`);
    }
  }
});

test('a merge on the Canvas keeps the place planMerge() gave it', () => {
  addItems([photo({ x: 0, y: 0 })]);
  const plan = planMerge(incoming([
    { id: 'm1', type: 'image', x: 5000, y: 0, w: 300, h: 300 },
  ]), board.items.map(i => i.id), board.items);
  const x = plan.items[0].x;
  mergeBoard(plan);
  assert.equal(byId('m1').x, x);
});
