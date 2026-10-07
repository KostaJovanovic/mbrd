// The web's earlier versions (storage/library.ts): a few packed snapshots of
// each board, kept in the shelf's own store beside its blob. The newest few
// stay, a sweep takes those of boards that left the shelf, and a removal takes
// a board's snapshots with it.

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';

import { memoryStore } from './helpers.js';
import { setStoreBackend } from '../web/assets/js/storage/idb.ts';
import {
  putLibraryBoard, removeLibraryBoard, sweepLibrary, libraryIndex,
  putSnapshot, snapshotsOf, getSnapshot, SNAPSHOTS_KEPT,
} from '../web/assets/js/storage/library.ts';

const store = memoryStore();
before(() => setStoreBackend(store));
after(() => setStoreBackend(null));

const blob = text => new Blob([text]);

test('a board keeps its newest snapshots, newest first', async () => {
  await putLibraryBoard('brd-a', blob('a'), { title: 'A' });
  for (let at = 1; at <= SNAPSHOTS_KEPT + 3; at++) await putSnapshot('brd-a', blob('v'.repeat(at)), at);
  const list = await snapshotsOf('brd-a');
  assert.equal(list.length, SNAPSHOTS_KEPT);
  assert.deepEqual(list.map(v => v.at), [8, 7, 6, 5, 4]);
  assert.equal(list[0].size, 8);
  assert.equal(await (await getSnapshot(list[0].path)).text(), 'v'.repeat(8));
  assert.equal((await libraryIndex()).length, 1, 'a snapshot is not a board on the shelf');
});

test('a snapshot key is the only key getSnapshot reads', async () => {
  assert.equal(await getSnapshot('brd-a'), null, 'not the board blob itself');
});

test('a sweep keeps the snapshots of boards on the shelf and drops the rest', async () => {
  await putSnapshot('brd-gone', blob('x'), 1);
  await sweepLibrary();
  assert.equal((await snapshotsOf('brd-gone')).length, 0);
  assert.equal((await snapshotsOf('brd-a')).length, SNAPSHOTS_KEPT);
});

test('taking a board off the shelf takes its snapshots with it', async () => {
  await removeLibraryBoard('brd-a');
  assert.equal((await snapshotsOf('brd-a')).length, 0);
});
