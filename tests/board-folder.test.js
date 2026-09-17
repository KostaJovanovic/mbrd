// The desktop's boards folder, driven through storage.ts with a fake shell
// whose disk is a Map. No board stays inside the app: the first start moves the
// packed boards into the folder, New makes a file at once, an edit reaches the
// file, a rename renames it, and the board list is the shelf plus the folder.
// The tests run in order and share one folder, as one run of the app would.

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';

import { memoryStore } from './helpers.js';
import { setPlatform } from '../web/assets/js/platform/platform.ts';
import { setStoreBackend } from '../web/assets/js/storage/idb.ts';
import { putLibraryBoard, getLibraryBoard, libraryIndex } from '../web/assets/js/storage/library.ts';
import { packBoard, unpackBoard } from '../web/assets/js/storage/mbrd.ts';
import {
  adoptFolder, newBoard, saveDocument, listBoards, deleteLibraryBoard, boardFolder,
  switchBoard, fileNameFor,
} from '../web/assets/js/storage/storage.ts';
import {
  loadBoard, board, markDirty, setTitle, isDirty, serializeBoard,
} from '../web/assets/js/state.ts';

const HOME = '/home/k/Documents/mbrd';
const at = name => HOME + '/' + name;
const nameOf = path => path.slice(path.lastIndexOf('/') + 1);

/** path -> Blob. What the shell's disk holds. */
const disk = new Map();
const trashed = [];

/** The first free path, as desktop/boards.ts finds it. */
function freePath(name, self = '') {
  for (let n = 1; ; n++) {
    const path = at(n === 1 ? name : name.replace(/\.mbrd$/, `_(${n}).mbrd`));
    if (path === self || !disk.has(path)) return path;
  }
}

const shell = {
  files: {
    folder: {
      list: async () => ({
        folder: HOME,
        files: [...disk.keys()].filter(p => p.startsWith(HOME + '/'))
          .map(p => ({ name: nameOf(p), path: p, at: 1 })),
      }),
      create: async (suggested, blob) => {
        const path = freePath(suggested);
        disk.set(path, blob);
        return { name: nameOf(path), path };
      },
      rename: async (ref, suggested) => {
        if (!ref.path.startsWith(HOME + '/')) return null;
        const path = freePath(suggested, ref.path);
        if (path !== ref.path) {
          disk.set(path, disk.get(ref.path));
          disk.delete(ref.path);
        }
        return { name: nameOf(path), path };
      },
      trash: async ref => { trashed.push(ref.path); disk.delete(ref.path); },
      reveal: async () => {},
    },
    canPick: () => true,
    pickOpen: async () => { throw Object.assign(new Error('no'), { name: 'AbortError' }); },
    pickSave: async suggested => ({ name: suggested, path: '/elsewhere/' + suggested }),
    write: async (ref, blob) => { disk.set(ref.path, blob); },
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

/** A packed board with this title, as the shelf or a file holds one. */
async function packed(title) {
  const live = serializeBoard();
  loadBoard({ title, items: [] });
  const { blob } = await packBoard(serializeBoard());
  loadBoard(live);
  return blob;
}

const titleIn = async path => (await unpackBoard(new File([disk.get(path)], nameOf(path)))).board.title;
const row = async id => (await libraryIndex()).find(e => e.id === id);
const currentRow = async () => (await listBoards()).find(e => e.current);

before(() => {
  setStoreBackend(memoryStore());
  setPlatform(shell);
  loadBoard({ title: 'On screen', items: [] });
});

after(() => { setPlatform(null); setStoreBackend(null); });

test('the first start moves the packed boards into the folder, and gives the board on screen a file', async () => {
  await putLibraryBoard('brd-a', await packed('Summer'), { title: 'Summer', at: 5, thumb: 'data:a' });
  await putLibraryBoard('brd-b', await packed('Winter'), { title: 'Winter', at: 6 });

  await adoptFolder();
  assert.equal(boardFolder(), HOME);

  for (const [id, title] of [['brd-a', 'Summer'], ['brd-b', 'Winter']]) {
    const entry = await row(id);
    assert.equal(entry.path, at(title + '.mbrd'), `${title} points at its file`);
    assert.equal(await getLibraryBoard(id), null, `and ${title} keeps no copy inside the app`);
    assert.equal(await titleIn(entry.path), title, 'and the file is the board');
  }
  assert.equal((await row('brd-a')).thumb, 'data:a', 'the picture stays with the row');

  const mine = await currentRow();
  assert.equal(mine.path, at('On_screen.mbrd'), 'the board on screen is a file too');
  assert.equal(await titleIn(mine.path), 'On screen');
});

test('New makes a file at once, and keeps the list of boards', async () => {
  const before = (await libraryIndex()).length;
  assert.equal(await newBoard(), true);
  const path = at(fileNameFor(board.title));
  assert.ok(disk.has(path), 'the new board is a file before anything is on it');
  assert.equal((await libraryIndex()).length, before + 1,
    'every row is still there, and the new board has one');
  assert.equal((await currentRow()).path, path);
});

test('an edit reaches the file, and the dirty mark comes off', async () => {
  const path = (await currentRow()).path;
  const was = disk.get(path);
  markDirty();
  assert.equal(await saveDocument(), true);
  assert.equal(isDirty(), false);
  assert.notEqual(disk.get(path), was, 'the file was written again');
});

test('a rename renames the file in the folder', async () => {
  const old = (await currentRow()).path;
  setTitle('Plans for May');
  markDirty();
  await saveDocument();
  assert.ok(disk.has(at('Plans_for_May.mbrd')), 'the file has the new name');
  assert.equal(disk.has(old), false, 'and not the old one as well');
  assert.equal((await currentRow()).path, at('Plans_for_May.mbrd'), 'the row follows it');
  assert.equal(await titleIn(at('Plans_for_May.mbrd')), 'Plans for May');
});

test('the list is the shelf and the folder together', async () => {
  disk.set(at('Dropped_in.mbrd'), await packed('Dropped in'));
  await putLibraryBoard('brd-x', null, { title: 'Away', at: 7, path: '/elsewhere/Away.mbrd' });
  disk.delete((await row('brd-b')).path);

  const list = await listBoards();
  const dropped = list.find(e => e.path === at('Dropped_in.mbrd'));
  assert.ok(dropped, 'a file put in the folder by hand is on the list');
  assert.ok(dropped.id.startsWith('file:'), 'under a file id, with no row yet');
  assert.equal(dropped.title, 'Dropped in');
  assert.equal(dropped.inFolder, true);

  assert.equal(list.some(e => e.id === 'brd-b'), false, 'a file deleted from the folder leaves the list');
  assert.equal(await row('brd-b'), undefined, 'and its row goes with it');

  const away = list.find(e => e.id === 'brd-x');
  assert.ok(away, 'a file elsewhere stays on the list, there or not');
  assert.equal(away.inFolder, false);
});

test('a file in the folder opens from the list, and is listed once', async () => {
  assert.equal(await switchBoard('file:' + at('Dropped_in.mbrd')), true);
  assert.equal(board.title, 'Dropped in');
  const rows = (await listBoards()).filter(e => e.path === at('Dropped_in.mbrd'));
  assert.equal(rows.length, 1);
  assert.equal(rows[0].current, true);
  assert.ok(!rows[0].id.startsWith('file:'), 'it has a row of its own now');
});

test('the cross moves a folder board to the bin, and only takes a file elsewhere off the list', async () => {
  assert.equal(await deleteLibraryBoard('brd-a', { file: at('Summer.mbrd') }), true);
  assert.deepEqual(trashed, [at('Summer.mbrd')]);
  assert.equal(await row('brd-a'), undefined);

  assert.equal(await deleteLibraryBoard('brd-x'), true);
  assert.equal(await row('brd-x'), undefined);
  assert.deepEqual(trashed, [at('Summer.mbrd')], 'the file elsewhere was not touched');
});
