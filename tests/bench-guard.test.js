// The benchmark's standard board never reaches anywhere the user's board lives:
// not the board's file, not the shelf, not the session slot. The worst case is
// set up first - a desktop with a boards folder adopted and the user's board
// already a file in it - and then the bench board is put on screen, dirty, and
// every writer and every door that replaces a board is tried against it. The
// disk and the store must come out exactly as they went in.

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';

import { memoryStore } from './helpers.js';
import { setPlatform } from '../web/assets/js/platform/platform.ts';
import { setStoreBackend } from '../web/assets/js/storage/idb.ts';
import { libraryIndex } from '../web/assets/js/storage/library.ts';
import {
  adoptFolder, newBoard, saveDocument, compactDocument, autosave, stashCurrent,
  ensureCurrentOnShelf, switchBoard, clearAllData, setPrompt,
} from '../web/assets/js/storage/storage.ts';
import {
  loadBoard, markDirty, markBenchBoard, isBenchBoard, notUsersBoard,
} from '../web/assets/js/state.ts';

const HOME = '/home/k/Documents/mbrd';
const nameOf = path => path.slice(path.lastIndexOf('/') + 1);

/** path -> Blob, and every write the shell was asked for. */
const disk = new Map();
let writes = 0;

const shell = {
  files: {
    folder: {
      list: async () => ({
        folder: HOME,
        files: [...disk.keys()].map(p => ({ name: nameOf(p), path: p, at: 1 })),
      }),
      create: async (suggested, blob) => {
        writes++;
        const path = HOME + '/' + suggested;
        disk.set(path, blob);
        return { name: suggested, path };
      },
      rename: async ref => ref,
      trash: async () => { writes++; },
      reveal: async () => {},
    },
    canPick: () => true,
    pickOpen: async () => { throw Object.assign(new Error('no'), { name: 'AbortError' }); },
    pickSave: async suggested => ({ name: suggested, path: '/elsewhere/' + suggested }),
    write: async (ref, blob) => { writes++; disk.set(ref.path, blob); },
    append: async (ref, blob) => { writes++; disk.set(ref.path, blob); },
    pickImport: async () => [],
    read: async ref => new File([disk.get(ref.path)], ref.name),
    exists: async ref => disk.has(ref.path),
  },
  lifecycle: { onCloseRequested() {}, onOpenFiles() {}, onBack() {} },
  native: {
    canTranscode: () => false,
    firstFrame: async () => null, transcode: async () => null,
    matte: async () => null, decode: async () => null,
  },
  updates: { check: async () => {} },
  setDocument() {},
  relaunch() {},
};

const store = memoryStore();
let clears = 0;
const clear = store.clear;
store.clear = async s => { clears++; return clear(s); };

/** Everything the store and the disk hold, as something assert can compare. */
function snapshot() {
  const stores = {};
  for (const [name, map] of store.stores) stores[name] = [...map.keys()].sort();
  return { stores, disk: [...disk.keys()].sort(), sizes: [...disk.values()].map(b => b.size) };
}

let asked = 0;

before(async () => {
  setStoreBackend(store);
  setPlatform(shell);
  setPrompt(async () => { asked++; return 'go'; });
  // The user's board, a file in the adopted folder: the state to protect.
  loadBoard({ title: 'Mine', items: [{ type: 'note', x: 0, y: 0, w: 160, h: 160, meta: { text: 'mine' } }] });
  await adoptFolder();
  assert.ok(disk.size >= 1, 'the fake folder took the user\'s board as a file');
});

after(() => { setPlatform(null); setStoreBackend(null); });

test('the bench board is a board that is not the user\'s', () => {
  assert.equal(isBenchBoard(), false);
  markBenchBoard();
  assert.equal(isBenchBoard(), true);
  assert.equal(notUsersBoard(), true, 'the writers ask the wider question');
});

test('no writer and no door touches the disk or the store', async () => {
  // As buildStandardBoard() does: the latch first, then the board.
  markBenchBoard();
  loadBoard({ title: 'Benchmark 1', items: [{ type: 'note', x: 5, y: 5, w: 160, h: 160, meta: { text: 'bench' } }] });
  markDirty();
  const was = snapshot();
  const shelf = JSON.stringify(await libraryIndex());
  writes = 0;
  clears = 0;
  asked = 0;

  assert.equal(await autosave(), false, 'the autosave writes nothing');
  assert.equal(await saveDocument(), true, 'the file writer stands down, as it does for the 404 board');
  assert.equal(await compactDocument(), false);
  await stashCurrent();
  await ensureCurrentOnShelf();
  assert.equal(await newBoard(), false, 'New is refused');
  assert.equal(await switchBoard('brd-somewhere-else'), false, 'so is switching away');
  assert.equal(await clearAllData(), false, 'and Clear everything');

  assert.equal(writes, 0, 'the shell was asked to write nothing');
  assert.equal(clears, 0, 'no store was cleared');
  assert.equal(asked, 0, 'nothing asked about a board that is not theirs');
  assert.deepEqual(snapshot(), was, 'the disk and the store are as they were');
  assert.equal(JSON.stringify(await libraryIndex()), shelf, 'the shelf is as it was');
});
