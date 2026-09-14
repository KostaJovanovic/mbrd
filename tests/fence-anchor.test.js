// A new fence starts free and anchors itself ten seconds after its last move,
// once, and not as an undo step (the fresh-fence clock in sticky.ts, and
// anchorQuietly() in state.ts). Also the board's hadMusic flag, which rides
// the same board file: written only when true, and read back as written.

import { test, beforeEach, afterEach, mock } from 'node:test';
import assert from 'node:assert/strict';

import {
  addItems, byId, isLocked, anchorQuietly, startFresh, SETTLE_MS, historyDepth,
  loadBoard, serializeBoard, board, setBoardMode,
} from '../web/assets/js/state.ts';
import { nudgeFresh, seedSticks } from '../web/assets/js/sticky.ts';
import { fresh } from './state-fixtures.js';

beforeEach(() => {
  setBoardMode('desktop');
  fresh();
  mock.timers.enable({ apis: ['setTimeout'] });
});
afterEach(() => mock.timers.reset());

const newFence = () => {
  const [f] = addItems([{ type: 'fence', name: 'Fence 1', x: 0, y: 0, w: 400, h: 300 }]);
  startFresh(f.id, () => anchorQuietly(f.id));
  return f.id;
};

test('a new fence is free, then anchors itself after the settle window', () => {
  const id = newFence();
  assert.equal(isLocked(byId(id)), false);
  mock.timers.tick(SETTLE_MS - 1);
  assert.equal(isLocked(byId(id)), false);
  mock.timers.tick(1);
  assert.equal(isLocked(byId(id)), true);
});

test('a move restarts the clock', () => {
  const id = newFence();
  mock.timers.tick(SETTLE_MS - 1000);
  nudgeFresh([id]);
  mock.timers.tick(SETTLE_MS - 1);
  assert.equal(isLocked(byId(id)), false);
  mock.timers.tick(1);
  assert.equal(isLocked(byId(id)), true);
});

test('the anchor is not an undo step', () => {
  const id = newFence();
  const before = historyDepth().undo;
  mock.timers.tick(SETTLE_MS);
  assert.equal(isLocked(byId(id)), true);
  assert.equal(historyDepth().undo, before);
});

test('another board loading cancels the clock', () => {
  const id = newFence();
  seedSticks();
  mock.timers.tick(SETTLE_MS);
  assert.equal(isLocked(byId(id)), false);
});

test('hadMusic is written only when set, and read back', () => {
  loadBoard({ title: 'Quiet', items: [] });
  assert.equal(board.hadMusic, false);
  assert.equal('hadMusic' in serializeBoard(), false);
  loadBoard({ title: 'Loud', items: [], hadMusic: true });
  assert.equal(board.hadMusic, true);
  assert.equal(serializeBoard().hadMusic, true);
  // Only a literal true counts.
  loadBoard({ title: 'Odd', items: [], hadMusic: 'yes' });
  assert.equal(board.hadMusic, false);
});
