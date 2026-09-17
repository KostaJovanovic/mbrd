// The apps' autosave (writeToFile() in storage/session.ts): the board's own
// file is the save. The engine hands the write to saveFile(), keeps which file
// it is and where the view was, deletes any copy of the board the store held
// from before, and at the next start reopens the file rather than a copy.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { hash, memoryStore } from './helpers.js';
import { setStoreBackend, idbGet, idbSet, idbKeys } from '../web/assets/js/storage/idb.ts';
import {
  initSession, autosave, restoreSession, lastSaveFailure,
} from '../web/assets/js/storage/session.ts';
import { loadBoard, board } from '../web/assets/js/state.ts';

const FILE = '/boards/Kept.mbrd';
const calls = { saved: 0, reopened: [] };
let saves = true;
let opens = true;

setStoreBackend(memoryStore());
initSession({
  fileName: () => 'Kept.mbrd',
  created: () => null,
  setCreated() {},
  exportBoard: async () => false,
  prompt: async () => 'cancel',
  fileBacked: () => true,
  filePath: () => FILE,
  settled: async () => {},
  saveFile: async () => { calls.saved++; return saves; },
  reopen: async path => {
    calls.reopened.push(path);
    if (opens) loadBoard({ title: 'Kept', items: [] });
    return opens;
  },
});

// In order: autosave() runs again only while no write has succeeded, and
// nothing here bumps the change counter.
test('a file that could not be written is a failed autosave, and the store is not touched', async () => {
  await idbSet('assets', hash('old'), { blob: new Blob(['x']) });
  saves = false;
  assert.equal(await autosave(), false);
  assert.equal(calls.saved, 1);
  assert.match(lastSaveFailure(), /could not be written to its file/);
  assert.equal(await idbGet('kv', 'session'), undefined);
  assert.deepEqual(await idbKeys('assets'), [hash('old')], 'the copy from before stays while the file is not the board');
});

test('the autosave writes the file, and the store keeps where it is and no copy of the board', async () => {
  saves = true;
  loadBoard({ title: 'Kept', items: [] });
  board.view = { pan: { x: 12, y: -3 }, zoom: 2 };
  assert.equal(await autosave(), true);
  assert.equal(calls.saved, 2);
  const record = await idbGet('kv', 'session');
  assert.equal(record.file, FILE);
  assert.deepEqual(record.view, { pan: { x: 12, y: -3 }, zoom: 2 });
  assert.equal(record.board, undefined, 'no copy of the board');
  assert.deepEqual(await idbKeys('assets'), [], 'and none of its pictures');
});

test('the next start reopens the file and puts the view back', async () => {
  board.view = { pan: { x: 0, y: 0 }, zoom: 1 };
  assert.equal(await restoreSession(), true);
  assert.deepEqual(calls.reopened, [FILE]);
  assert.deepEqual(board.view, { pan: { x: 12, y: -3 }, zoom: 2 });
});

test('a file that will not reopen is no restored board', async () => {
  opens = false;
  assert.equal(await restoreSession(), false);
});
