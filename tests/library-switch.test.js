// Switching to a board on a full shelf. The switch shelves the board on screen
// first, and that trims the shelf to its ceiling - oldest first, which is often
// the very row being opened. On the web that row's blob is its only copy.

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';

import { memoryStore } from './helpers.js';
import { setStoreBackend } from '../web/assets/js/storage/idb.ts';
import { putLibraryBoard, libraryIndex } from '../web/assets/js/storage/library.ts';
import { board, loadBoard, addItems, leaveNotFoundBoard } from '../web/assets/js/state.ts';
import {
  newBoard, listLibrary, ensureCurrentOnShelf, switchBoard,
} from '../web/assets/js/storage/storage.ts';

before(() => setStoreBackend(memoryStore()));
after(() => setStoreBackend(null));

test('a switch to the oldest row of a full shelf opens it', async () => {
  loadBoard({ title: 'Target', items: [] });
  leaveNotFoundBoard();
  addItems([{ type: 'note', name: 'kept', meta: { text: 'kept' } }]);
  assert.notEqual(await newBoard(), false);
  const target = (await listLibrary()).find(e => e.title === 'Target');
  assert.ok(target, 'the first board is on the shelf');

  // Newer than anything the switch writes, so the target stays the oldest row.
  const later = Date.now() + 60_000;
  for (let i = 0; i < 23; i++) {
    await putLibraryBoard(`filler-${i}`, new Blob(['x']), { title: `f${i}`, at: later + i });
  }
  // What the board list does before it draws: a 25th row, and no trim.
  await ensureCurrentOnShelf();
  assert.equal((await libraryIndex()).length, 25);

  assert.equal(await switchBoard(target.id), true);
  assert.equal(board.title, 'Target');
  assert.ok((await libraryIndex()).some(e => e.id === target.id), 'the row stays on the shelf');
});
