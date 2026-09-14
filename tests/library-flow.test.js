// Save, New, Save, and the Boards list. On the website this was reported to
// leave only the board on screen in the list (G27 in
// research/fixes-2026-09-14.md). It did not reproduce in a browser, with notes
// or pictures, with or without a reload between the steps. This holds the
// shelf half of the sequence - Save on the web writes the browser's own copy,
// which the shelf never reads - so the list is two rows after it, one current.

import { test, before } from 'node:test';
import assert from 'node:assert/strict';

import { memoryStore } from './helpers.js';
import { setStoreBackend } from '../web/assets/js/storage/idb.ts';
import { loadBoard, addItems, leaveNotFoundBoard } from '../web/assets/js/state.ts';
import { newBoard, listBoards, ensureCurrentOnShelf } from '../web/assets/js/storage/storage.ts';

before(() => {
  setStoreBackend(memoryStore());
});

test('a board, New, another board: the list holds both', async () => {
  loadBoard({ title: 'First', items: [] });
  leaveNotFoundBoard();
  addItems([{ type: 'note', name: 'one', meta: { text: 'one' } }]);
  assert.notEqual(await newBoard(), false);
  addItems([{ type: 'note', name: 'two', meta: { text: 'two' } }]);
  // What the list does before it draws (ui/library.ts render()).
  await ensureCurrentOnShelf();
  const rows = await listBoards();
  assert.equal(rows.length, 2, `the list holds ${rows.map(r => r.title).join(', ')}`);
  assert.deepEqual(rows.map(r => r.current).sort(), [false, true]);
  assert.ok(rows.some(r => r.title === 'First' && !r.current), 'the first board is not in the list');
});
