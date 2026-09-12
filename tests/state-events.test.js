// The 'items' event's delta - { added, removed } lists of ids - so listeners
// act on what changed rather than rescanning. Every add, delete, restore and
// their undos must name only the ids they touched; a load names nothing,
// the "rescan, extent unknown" signal. Nothing else catches a wrong delta -
// the render path has no test coverage of its own.

import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

import {
  bus, loadBoard, addItems, removeItems, restoreItems, undo, redo,
} from '../web/assets/js/state.ts';

const fresh = (items = []) => loadBoard({ title: 'T', items });
const photo = (props = {}) => ({ type: 'image', w: 200, h: 200, ...props });

// The most recent 'items' emit's payload, and whether one has happened.
let last;
let saw;
bus.on('items', delta => { last = delta; saw = true; });

beforeEach(() => { fresh(); last = undefined; saw = false; });

const sorted = a => [...a].sort();

test('a load emits items with no delta - the rescan signal', () => {
  fresh([photo()]);
  assert.ok(saw, 'a load still emits items');
  assert.equal(last, undefined, 'a load carries no add/remove list');
});

test('adding items names them as added and nothing as removed', () => {
  const added = addItems([photo(), photo()]);
  assert.deepEqual(last.removed, []);
  assert.deepEqual(sorted(last.added), sorted(added.map(i => i.id)));
});

test('deleting items names them as removed and nothing as added', () => {
  const added = addItems([photo(), photo()]);
  const ids = added.map(i => i.id);
  removeItems([ids[0]]);
  assert.deepEqual(last.added, []);
  assert.deepEqual(last.removed, [ids[0]]);
});

test('undoing an add removes exactly what the add added', () => {
  const added = addItems([photo(), photo()]);
  undo();
  assert.deepEqual(last.added, []);
  assert.deepEqual(sorted(last.removed), sorted(added.map(i => i.id)));
});

test('undoing a delete adds back exactly what the delete removed', () => {
  const added = addItems([photo(), photo()]);
  const ids = added.map(i => i.id);
  removeItems(ids);
  undo();
  assert.deepEqual(last.removed, []);
  assert.deepEqual(sorted(last.added), sorted(ids));
});

test('redoing an add re-adds the same ids', () => {
  const added = addItems([photo()]);
  undo();
  redo();
  assert.deepEqual(last.removed, []);
  assert.deepEqual(last.added, added.map(i => i.id));
});

test('restoring from the bin names the restored ids as added', () => {
  const added = addItems([photo(), photo()]);
  const ids = added.map(i => i.id);
  removeItems(ids);
  const back = restoreItems(ids);
  assert.deepEqual(last.removed, []);
  assert.deepEqual(sorted(last.added), sorted(back.map(i => i.id)));
});

test('a fresh add reports only the newcomers, not the board', () => {
  addItems([photo(), photo()]);          // already on the board
  const more = addItems([photo()]);      // the new arrival
  assert.equal(last.added.length, 1, 'only the arrival, not the whole board');
  assert.deepEqual(last.added, more.map(i => i.id));
});
