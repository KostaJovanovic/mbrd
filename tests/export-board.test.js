// Export with a save picker (the File System Access path): what the second
// export to the same file does to the title, and what an edit made while the
// pack runs does to the dirty flag. Driven through setPlatform() with a files
// port that records writes, so no browser is needed.

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';

import { memoryStore } from './helpers.js';
import { setStoreBackend } from '../web/assets/js/storage/idb.ts';
import { setPlatform, platform } from '../web/assets/js/platform/platform.ts';
import {
  board, loadBoard, setTitle, addItems, isDirty, markDirty, leaveNotFoundBoard,
} from '../web/assets/js/state.ts';
import { exportBoard } from '../web/assets/js/storage/storage.ts';

let picks = 0;
/** Runs inside the write, as an edit made while the export works would. */
let duringWrite = null;

before(() => {
  setStoreBackend(memoryStore());
  const web = platform;
  setPlatform({
    lifecycle: web.lifecycle, native: web.native, updates: web.updates, auth: web.auth,
    setDocument() {}, relaunch() {},
    files: {
      ...web.files,
      folder: null,
      canPick: () => true,
      pickSave: async () => { picks++; return { name: 'First_name.mbrd' }; },
      write: async () => { duringWrite?.(); },
    },
  });
});

after(() => {
  setPlatform(null);
  setStoreBackend(null);
});

test('a second export to the same file keeps a rename made since the first', async () => {
  loadBoard({ title: 'Start' });
  leaveNotFoundBoard();
  assert.equal(await exportBoard(), true);
  assert.equal(picks, 1);
  assert.equal(board.title, 'First name', 'the picked name renames the board');

  setTitle('Renamed a_b');
  assert.equal(await exportBoard(), true);
  assert.equal(picks, 1, 'the second export writes to the same file');
  assert.equal(board.title, 'Renamed a_b');
});

test('an edit made while the export runs keeps the board dirty', async () => {
  markDirty(false);
  duringWrite = () => {
    addItems([{ type: 'note', name: 'late', meta: { text: 'late' } }]);
    markDirty(true);
  };
  try {
    assert.equal(await exportBoard(), true);
  } finally {
    duringWrite = null;
  }
  assert.equal(isDirty(), true, 'the late edit is not in the file');
});
