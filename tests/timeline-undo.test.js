// The closure stacks and the ledger have to agree after every undo and redo.
// Each case here is one way they came apart (research/bug-hunt-2026-09-23.md,
// H6 to H8): the board on screen and the board a Timeline trip rebuilds were
// two different boards, and a trip or a reload quietly swapped one for the other.

import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

import {
  addItems, renameItem, undo, redo, byId, setBoardMode, snapshotGeom, commitGeom,
} from '../web/assets/js/state.ts';
import {
  timelineSteps, timelineAt, replayTo, fingerprint,
} from '../web/assets/js/timeline.ts';
import { fresh, photo } from './state-fixtures.js';

beforeEach(() => {
  setBoardMode('desktop');
  fresh();
});

/** Move a card the way a finished drag does: mutate, then close the gesture. */
function move(id, dx) {
  const before = snapshotGeom([id]);
  byId(id).x += dx;
  commitGeom('Move', before, [id]);
}

/** The board a Timeline trip to the marker rebuilds must be the board on screen. */
function assertLedgerHolds() {
  const live = fingerprint();
  replayTo(timelineAt());
  assert.equal(fingerprint(), live, 'a replay to the marker changed the board');
}

test('H6: undo past a run that folded to nothing keeps the ledger in step', () => {
  const [b] = addItems([photo({ x: 0, y: 0 })]);
  const [a] = addItems([photo({ x: 400, y: 0 })]);
  move(a.id, 10);
  move(a.id, -10);
  undo();
  undo();
  renameItem(b.id, 'B');
  assert.ok(byId(a.id), 'A is on the board');
  assertLedgerHolds();
  assert.ok(byId(a.id), 'a Timeline trip kept A');
});

test('H6: one undo into a run that folded to nothing is written down', () => {
  const [b] = addItems([photo({ x: 0, y: 0 })]);
  const [a] = addItems([photo({ x: 400, y: 0 })]);
  move(a.id, 10);
  move(a.id, -10);
  undo();
  assert.equal(byId(a.id).x, 410);
  renameItem(b.id, 'B');
  assertLedgerHolds();
  assert.equal(byId(a.id).x, 410);
});

test('H6: redo after undo through a folded run lands where the stack says', () => {
  addItems([photo({ x: 0, y: 0 })]);
  const [a] = addItems([photo({ x: 400, y: 0 })]);
  move(a.id, 10);
  move(a.id, -10);
  undo();
  undo();
  redo();
  assert.equal(byId(a.id).x, 410);
  redo();
  assert.equal(byId(a.id).x, 400);
  // The run folded back to nothing again, so it leaves no step behind.
  assert.equal(timelineSteps().length, 2);
  assertLedgerHolds();
});

test('H6: one redo through a folded run is written down', () => {
  addItems([photo({ x: 0, y: 0 })]);
  const [a] = addItems([photo({ x: 400, y: 0 })]);
  move(a.id, 10);
  move(a.id, -10);
  undo();
  undo();
  redo();
  assert.equal(byId(a.id).x, 410);
  assertLedgerHolds();
});

test('H7: a partial undo inside a run rewrites the run to where it stopped', () => {
  const [a] = addItems([photo({ x: 0, y: 0 })]);
  const [b] = addItems([photo({ x: 400, y: 0 })]);
  move(a.id, 10);
  move(a.id, 10);
  move(a.id, 10);
  undo();
  undo();
  assert.equal(byId(a.id).x, 10);
  assertLedgerHolds();
  renameItem(b.id, 'B');
  assertLedgerHolds();
  assert.equal(byId(a.id).x, 10);
});

test('H7: a redo inside a run grows the run again', () => {
  const [a] = addItems([photo({ x: 0, y: 0 })]);
  move(a.id, 10);
  move(a.id, 10);
  move(a.id, 10);
  undo();
  undo();
  redo();
  assert.equal(byId(a.id).x, 20);
  assertLedgerHolds();
  redo();
  assert.equal(byId(a.id).x, 30);
  assertLedgerHolds();
  // Still one step for the add and one for the run.
  assert.equal(timelineSteps().length, 2);
  // And undo leaves the run by moving the marker, as before.
  undo();
  undo();
  undo();
  assert.equal(byId(a.id).x, 0);
  assert.equal(timelineAt(), 1);
});
