// The cloud doors in storage.ts, against Google Drive's provider object with a
// store made of Maps put in place of the network. sync.test.js holds the
// algorithm; this holds what storage.ts does around it: that a pulled board
// opens whole, and that two pushes from one tab never overlap.

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';

import { memoryStore } from './helpers.js';
import { setStoreBackend } from '../web/assets/js/storage/idb.ts';
import { googleDrive } from '../web/assets/js/storage/cloud/google.ts';
import { board, loadBoard, serializeBoard, leaveNotFoundBoard } from '../web/assets/js/state.ts';
import { openCloudBoard, pushBoardToCloud } from '../web/assets/js/storage/storage.ts';

/** A folder tree in a Map. `gate`, when set, holds every list() until opened. */
function fakeStore() {
  const files = new Map();
  let next = 1;
  let clock = 0;
  const stamp = () => new Date(1700000000000 + (++clock) * 1000).toISOString();
  const fake = {
    files,
    lists: 0,
    gate: null,
    async folder(name, parent) {
      for (const f of files.values()) if (f.folder && f.name === name && f.parent === parent) return f.id;
      const id = `d${next++}`;
      files.set(id, { id, name, parent, folder: true, modifiedTime: stamp() });
      return id;
    },
    async list(folder) {
      fake.lists++;
      if (fake.gate) await fake.gate;
      return [...files.values()].filter(f => f.parent === folder)
        .map(({ id, name, modifiedTime }) => ({ id, name, modifiedTime }));
    },
    async put(folder, name, blob, replacing) {
      const id = replacing && files.has(replacing) ? replacing : `f${next++}`;
      files.set(id, { id, name, parent: folder, blob, modifiedTime: stamp() });
      return id;
    },
    async fetch(id) { return files.get(id).blob; },
    async trash(id) { files.delete(id); },
  };
  return fake;
}

const saved = { store: googleDrive.store, signedIn: googleDrive.signedIn };
let drive;

before(() => {
  setStoreBackend(memoryStore());
  drive = fakeStore();
  googleDrive.store = drive;
  googleDrive.signedIn = () => true;
});

after(() => {
  Object.assign(googleDrive, saved);
  setStoreBackend(null);
});

test('a board opened from the cloud keeps its settings and arrangement', async () => {
  assert.ok(googleDrive.configured(), 'the checkout ships the web identifiers');
  loadBoard({
    title: 'Remote',
    settings: { gridStep: 77, palette: 'forest' },
    arrangement: 'grid',
    items: [{ id: 'n1', type: 'note', name: 'n', meta: { text: 'n' } }],
  });
  leaveNotFoundBoard();
  const sent = serializeBoard();
  assert.equal(sent.settings.gridStep, 77, 'the fixture sets what it means to');

  const folder = await drive.folder('brd-remote', await drive.folder('mbrd', null));
  await drive.put(folder, 'board.json', new Blob([JSON.stringify(sent)]), null);
  const modifiedTime = [...drive.files.values()].find(f => f.name === 'board.json').modifiedTime;

  loadBoard({ title: 'Something else' });
  assert.equal(await openCloudBoard({ boardId: 'brd-remote', folder, modifiedTime }), true);
  assert.equal(board.title, 'Remote');
  const got = serializeBoard();
  assert.deepEqual(got.settings, sent.settings);
  assert.equal(got.arrangement, sent.arrangement);
  assert.deepEqual(got.layouts, sent.layouts);
});

test('a push waits for the push before it, and a waiting push is shared', async () => {
  // The board the test above opened, which it filed as synced.
  assert.equal(board.title, 'Remote');
  let open;
  drive.gate = new Promise(resolve => { open = resolve; });
  const before = drive.lists;
  const first = pushBoardToCloud();
  // Until the first push is inside the store.
  while (drive.lists === before) await new Promise(r => setTimeout(r, 1));
  const second = pushBoardToCloud();
  const third = pushBoardToCloud();
  await new Promise(r => setTimeout(r, 10));
  assert.equal(drive.lists, before + 1, 'the second push reached the store while the first was in it');
  assert.equal(second, third, 'a push behind one that has not started yet adds nothing');

  drive.gate = null;
  open();
  const [a, b] = await Promise.all([first, second]);
  // Overlapping, the second push checked the row the first had not yet
  // written, and read the first's own write as somebody else's.
  assert.equal(a.ok, true);
  assert.equal(b.ok, true, 'the second push saw the first as a conflict');
});
