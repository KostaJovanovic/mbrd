// The shelf's index has two kinds of row: a board packed into a blob (every
// row on the web), or a pointer at a file on disk (desktop only). The
// second kind's safety is keeping *no* copy - a path row plus a blob is a
// board in two places with nothing to say which is right. Mostly tests that
// a blob is absent when it should be, driving library.ts through
// setStoreBackend() (see memoryStore() in helpers.js).

import { test, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';

import { memoryStore } from './helpers.js';
import { setStoreBackend } from '../web/assets/js/storage/idb.ts';
import {
  libraryIndex, putLibraryBoard, getLibraryBoard, removeLibraryBoard,
  hasLibraryBoard, sweepLibrary, trimLibrary,
} from '../web/assets/js/storage/library.ts';

let store;

beforeEach(() => {
  store = memoryStore();
  setStoreBackend(store);
});

// Put IndexedDB back, so a suite that runs after this one in the same process
// gets the module in the state it ships in.
after(() => setStoreBackend(null));

const blobOf = text => new Blob([text]);
const row = async id => (await libraryIndex()).find(e => e.id === id);

test('a web row keeps its packed blob and carries no path', async () => {
  await putLibraryBoard('brd-1', blobOf('packed'), { title: 'Summer', at: 5 });
  const entry = await row('brd-1');
  assert.equal(entry.title, 'Summer');
  assert.ok(!('path' in entry), 'a row filed without a path does not gain an empty one');
  assert.ok(await getLibraryBoard('brd-1'), 'the blob is the only copy and has to be there');
});

test('a path row stores no blob at all', async () => {
  await putLibraryBoard('brd-2', null, { title: 'On disk', at: 6, path: '/tmp/on-disk.mbrd' });
  const entry = await row('brd-2');
  assert.equal(entry.path, '/tmp/on-disk.mbrd');
  assert.equal(await getLibraryBoard('brd-2'), null,
    'the file is the board; a blob beside it would be the second copy');
  assert.equal(store.stores.get('library')?.size ?? 0, 0, 'nothing was written to the blob store');
});

test('the first Save turns an unsaved row into a path row and drops its blob', async () => {
  // The moment the two kinds meet: the row had a blob because it was
  // untitled, then got a file. Leaks if the delete is forgotten.
  await putLibraryBoard('brd-3', blobOf('packed'), { title: 'Untitled board', at: 1 });
  assert.ok(await getLibraryBoard('brd-3'));

  await putLibraryBoard('brd-3', null, { title: 'Named', at: 2, path: '/tmp/named.mbrd' });
  assert.equal(await getLibraryBoard('brd-3'), null, 'the blob is gone, not merely unreferenced');
  assert.equal((await libraryIndex()).length, 1, 'one row, rewritten in place');
  assert.equal((await row('brd-3')).path, '/tmp/named.mbrd');
});

test('the sweep leaves a path row alone', async () => {
  // The sweep deletes blobs no row points at. A path row points at no blob
  // by construction, which must not read as an orphan in either direction.
  await putLibraryBoard('brd-4', blobOf('packed'), { title: 'Blob row', at: 1 });
  await putLibraryBoard('brd-5', null, { title: 'File row', at: 2, path: '/tmp/f.mbrd' });
  assert.equal(await sweepLibrary(), 0);
  assert.ok(await getLibraryBoard('brd-4'), 'the blob row still has its blob');
  assert.equal((await libraryIndex()).length, 2);
});

test('a path row is on the shelf, and comes off it whole', async () => {
  await putLibraryBoard('brd-6', null, { title: 'File row', at: 1, path: '/tmp/f.mbrd' });
  assert.equal(await hasLibraryBoard('brd-6'), true);
  await removeLibraryBoard('brd-6');
  assert.equal(await hasLibraryBoard('brd-6'), false);
  assert.equal((await libraryIndex()).length, 0);
});

test('trimming the shelf drops path rows by age like any other', async () => {
  await putLibraryBoard('old-blob', blobOf('a'), { title: 'a', at: 1 });
  await putLibraryBoard('old-path', null, { title: 'b', at: 2, path: '/tmp/b.mbrd' });
  await putLibraryBoard('new-path', null, { title: 'c', at: 3, path: '/tmp/c.mbrd' });
  assert.equal(await trimLibrary(1), 2);
  const left = await libraryIndex();
  assert.deepEqual(left.map(e => e.id), ['new-path']);
  assert.equal(await getLibraryBoard('old-blob'), null, 'the evicted blob went with its row');
});
