// A held arrow key is one undo: commitGeom()'s `fold` option, which the nudge
// in canvas/input.ts passes while a run of presses continues. Folding keeps the
// first press's undo, so one Ctrl+Z puts the card back where the run began.

import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

import {
  addItems, byId, undo, setBoardMode, snapshotGeom, applyGeom, commitGeom, historyDepth,
} from '../web/assets/js/state.ts';
import { fresh, photo } from './state-fixtures.js';

beforeEach(() => {
  setBoardMode('desktop');
  fresh();
});

/** One press: move the card by dx and commit, folding into `prev` if given. */
function press(id, dx, prev = null) {
  const before = snapshotGeom([id]);
  applyGeom(before.map(b => ({ ...b, x: b.x + dx })));
  return commitGeom('Nudge', before, [id], { fold: prev });
}

test('a run of folded nudges is one undo back to where it began', () => {
  const [a] = addItems([photo({ x: 0, y: 0 })]);
  const start = byId(a.id).x;
  const depth = historyDepth().undo;
  let cmd = press(a.id, 10);
  cmd = press(a.id, 10, cmd);
  press(a.id, 10, cmd);
  assert.equal(byId(a.id).x, start + 30);
  assert.equal(historyDepth().undo, depth + 1, 'three presses, one entry');
  undo();
  assert.equal(byId(a.id).x, start, 'one undo goes back past all three');
});

test('presses that do not fold stay one undo each', () => {
  const [a] = addItems([photo({ x: 0, y: 0 })]);
  const start = byId(a.id).x;
  press(a.id, 10);
  press(a.id, 10);
  undo();
  assert.equal(byId(a.id).x, start + 10, 'the first press is still there');
});
