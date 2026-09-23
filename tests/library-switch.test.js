// Switching to a board on a full shelf. The switch shelves the board on screen
// first, and that trims the shelf to its ceiling - oldest first, which is often
// the very row being opened. On the web that row's blob is its only copy.
// Also a reload after a switch, before the session slot heard of the switch.

import { test, before } from 'node:test';
import assert from 'node:assert/strict';

import { memoryStore } from './helpers.js';
import { setStoreBackend } from '../web/assets/js/storage/idb.ts';
import { putLibraryBoard, libraryIndex } from '../web/assets/js/storage/library.ts';
import { board, loadBoard, addItems, leaveNotFoundBoard } from '../web/assets/js/state.ts';
import {
  newBoard, listLibrary, ensureCurrentOnShelf, switchBoard, initStorage, autosave, restoreSession,
} from '../web/assets/js/storage/storage.ts';

let store;
before(() => {
  store = memoryStore();
  setStoreBackend(store);
  // The 20 s autosave tick would hold the runner open; nothing here wants it.
  const realSetInterval = globalThis.setInterval;
  globalThis.setInterval = () => 0;
  initStorage();
  globalThis.setInterval = realSetInterval;
  // The autosave cooldown timer, unref'd so the runner does not wait it out.
  const realSetTimeout = globalThis.setTimeout;
  globalThis.setTimeout = (...args) => {
    const t = realSetTimeout(...args);
    t?.unref?.();
    return t;
  };
});

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

test('a reload after a switch whose slot write never landed keeps each board under its id', async () => {
  // The board on screen is 'Target' (the test above). Its slot is written.
  assert.equal(await autosave(), true);
  const slot = store.stores.get('kv').get('session');
  const here = (await listLibrary()).find(e => e.current);
  const other = (await listLibrary()).find(e => !e.current && e.title !== 'Target' && !e.id.startsWith('filler'));
  assert.ok(other, 'a second real board is on the shelf');

  assert.equal(await switchBoard(other.id), true);
  // The tab closes before the next autosave: the slot still holds 'Target',
  // and `current-board` already names the other board.
  store.stores.get('kv').set('session', slot);
  loadBoard({ title: 'Blank after reload' });
  assert.equal(await restoreSession(), true);
  assert.equal(board.title, 'Target');
  const current = (await listLibrary()).find(e => e.current);
  assert.equal(current.id, here.id, 'the restored board took the id of the board switched to');
});
