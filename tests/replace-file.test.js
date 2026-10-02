// replaceItemFile() (import/drop.ts): Replace file… keeps the card - its
// place, width, tags, anchor and lines - and the card holds the new file.
// One undo puts the old card back.

import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

import { replaceItemFile } from '../web/assets/js/import/drop.ts';
import {
  addItems, addConnections, areConnected, board, undo, setBoardMode,
} from '../web/assets/js/state.ts';
import { fresh, photo } from './state-fixtures.js';

beforeEach(() => {
  setBoardMode('desktop');
  fresh();
});

test('the card keeps its place, width, tags, anchor and lines, and holds the new file', async () => {
  const [card, other] = addItems([
    photo({ x: 100, y: 50, w: 300, h: 200, meta: { tags: ['kitchen'], locked: true, crop: { x: 0.1, y: 0, w: 0.5, h: 1 } } }),
    photo({ x: 900, y: 0 }),
  ]);
  addConnections([[card.id, other.id]]);
  await replaceItemFile(card.id, new File(['plain words'], 'notes.txt', { type: 'text/plain' }));

  assert.equal(board.items.length, 2);
  const now = board.items.find(i => i.id !== other.id);
  assert.notEqual(now.id, card.id, 'a retype is a fresh id, which the renderer rebuilds on');
  assert.equal(now.name, 'notes.txt');
  assert.equal(now.x, 100);
  assert.equal(now.y, 50);
  assert.equal(now.w, 300, 'the width the card was given stays');
  assert.deepEqual(now.meta.tags, ['kitchen']);
  assert.equal(now.meta.locked, true);
  assert.equal('crop' in now.meta, false, 'a crop belonged to the old picture');
  assert.ok(areConnected(now.id, other.id), 'its line follows it');

  undo();
  assert.ok(board.items.some(i => i.id === card.id), 'one undo brings the old card back');
  assert.ok(areConnected(card.id, other.id));
});
