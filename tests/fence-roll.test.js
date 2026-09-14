// Fences v2 (research/rapid-fixes-2026-09-14.md, R24): a fence rolls up to its
// name bar with its cards out of sight, and takes a colour of its own. What is
// out of sight is out of reach too - select-all passes it by, and Find rolls
// the fence down to show it. Both are meta on the fence, one undo step each.

import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

import {
  addItems, byId, undo, selectAll, selection, setBoardMode, setFenceRolled,
  setFenceTint, rolledAway, unrollFor, serializeBoard, loadBoard,
} from '../web/assets/js/state.ts';
import { fresh, fence, photo } from './state-fixtures.js';

beforeEach(() => {
  setBoardMode('desktop');
  fresh();
});

/** A fence at the origin with one card inside it and one well outside. */
function fenced() {
  const [f] = addItems([fence({ x: 0, y: 0, w: 800, h: 600 })]);
  const [inside, outside] = addItems([photo({ x: 50, y: 50 }), photo({ x: 2000, y: 0 })]);
  return { f, inside, outside };
}

test('a rolled fence folds away the cards inside it, and only those', () => {
  const { f, inside, outside } = fenced();
  assert.equal(rolledAway(byId(inside.id)), false, 'an open fence hides nothing');
  setFenceRolled(f.id, true);
  assert.equal(byId(f.id).meta.rolled, true);
  assert.equal(rolledAway(byId(inside.id)), true);
  assert.equal(rolledAway(byId(outside.id)), false);
  assert.equal(rolledAway(byId(f.id)), false, 'the fence keeps its bar');
});

test('a fence inside a rolled one is folded away with its cards', () => {
  const [outer] = addItems([fence({ x: 0, y: 0, w: 1600, h: 1200 })]);
  const [inner] = addItems([fence({ x: 0, y: 0, w: 600, h: 400, name: 'G' })]);
  const [card] = addItems([photo({ x: 0, y: 0 })]);
  setFenceRolled(outer.id, true);
  assert.equal(rolledAway(byId(inner.id)), true);
  assert.equal(rolledAway(byId(card.id)), true);
});

test('a roll is one undo step, and an open fence stores nothing', () => {
  const { f, inside } = fenced();
  setFenceRolled(f.id, true);
  undo();
  assert.equal('rolled' in byId(f.id).meta, false);
  assert.equal(rolledAway(byId(inside.id)), false);
});

test('a fence takes a note sheet as its colour, and 0 takes it off', () => {
  const { f } = fenced();
  setFenceTint(f.id, 3);
  assert.equal(byId(f.id).meta.tint, 3);
  setFenceTint(f.id, 0);
  assert.equal('tint' in byId(f.id).meta, false);
  setFenceTint(f.id, 2.5);
  assert.equal('tint' in byId(f.id).meta, false, 'not a sheet, so no colour');
});

test('select-all passes by what a rolled fence has folded away', () => {
  const { f, inside, outside } = fenced();
  setFenceRolled(f.id, true);
  selectAll();
  assert.equal(selection.has(inside.id), false);
  assert.equal(selection.has(outside.id), true);
  assert.equal(selection.has(f.id), true);
});

test('Find rolls down every fence that hides the card it picked', () => {
  const [outer] = addItems([fence({ x: 0, y: 0, w: 1600, h: 1200 })]);
  const [inner] = addItems([fence({ x: 0, y: 0, w: 600, h: 400, name: 'G' })]);
  const [card] = addItems([photo({ x: 0, y: 0 })]);
  setFenceRolled(outer.id, true);
  setFenceRolled(inner.id, true);
  unrollFor(card.id);
  assert.equal(rolledAway(byId(card.id)), false);
  assert.equal('rolled' in byId(outer.id).meta, false);
  assert.equal('rolled' in byId(inner.id).meta, false);
});

test('the roll and the colour survive a save', () => {
  const { f, inside } = fenced();
  setFenceRolled(f.id, true);
  setFenceTint(f.id, 2);
  loadBoard(serializeBoard());
  assert.equal(byId(f.id).meta.rolled, true);
  assert.equal(byId(f.id).meta.tint, 2);
  assert.equal(rolledAway(byId(inside.id)), true);
});
