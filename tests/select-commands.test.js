// The Select rows that name a set: by tag, by the tags one card carries, every
// kind in a selection, and the inverse of what is picked.

import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

import { addItems, select, selection, setBoardMode } from '../web/assets/js/state.ts';
import { createCommands } from '../web/assets/js/commands.ts';
import { fresh, note, photo } from './state-fixtures.js';

const commands = () => createCommands(
  { toWorld: () => ({ x: 0, y: 0 }), left: 0, top: 0, cx: 0, cy: 0 },
  { resetAppearance() {}, setWhimsy() {} });

beforeEach(() => {
  setBoardMode('desktop');
  fresh();
});

const picked = () => [...selection].sort();

test('invert picks what was not picked', () => {
  const [a, b, c] = addItems([photo({ x: 0 }), photo({ x: 500 }), photo({ x: 1000 })]);
  select([a.id]);
  commands().invertSelection();
  assert.deepEqual(picked(), [b.id, c.id].sort());
});

test('a tag selects everything carrying it', () => {
  const [a, , c] = addItems([
    photo({ x: 0, meta: { tags: ['red'] } }), photo({ x: 500 }), photo({ x: 1000, meta: { tags: ['red', 'big'] } })]);
  commands().selectTagged('red');
  assert.deepEqual(picked(), [a.id, c.id].sort());
});

test('the same tags means all of this card\'s tags', () => {
  const [a, b, c] = addItems([
    photo({ x: 0, meta: { tags: ['red', 'big'] } }), photo({ x: 500, meta: { tags: ['red'] } }),
    photo({ x: 1000, meta: { tags: ['big', 'red', 'old'] } })]);
  commands().selectSameTags(a.id);
  assert.deepEqual(picked(), [a.id, c.id].sort());
  assert.ok(!selection.has(b.id));
});

test('more like these takes every kind in the selection', () => {
  const [p1, n1, p2, n2] = addItems([photo({ x: 0 }), note({ x: 500 }), photo({ x: 1000 }), note({ x: 1500 })]);
  select([p1.id, n1.id]);
  commands().selectLikeThese();
  assert.deepEqual(picked(), [p1.id, n1.id, p2.id, n2.id].sort());
});
