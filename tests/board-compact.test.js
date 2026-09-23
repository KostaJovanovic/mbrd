// Compacting a board's file at a quiet moment. Saves append what changed, and
// what they replace stays in the file as dead bytes; compactDocument() writes
// the file whole once enough of it is dead. Driven through storage.ts with a
// fake shell whose disk is a Map and which can append, as both shells can.

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';

import { memoryStore, item, bytes, realHash } from './helpers.js';
import { setPlatform } from '../web/assets/js/platform/platform.ts';
import { setStoreBackend } from '../web/assets/js/storage/idb.ts';
import { putAsset } from '../web/assets/js/storage/assets.ts';
import { unpackBoard } from '../web/assets/js/storage/mbrd.ts';
import { layoutFromTail, deadBytes, writeZipLayout, appendZip } from '../web/assets/js/storage/zip.ts';
import {
  adoptFolder, saveDocument, compactDocument, worthCompacting, listBoards,
} from '../web/assets/js/storage/storage.ts';
import { loadBoard, markDirty, isDirty } from '../web/assets/js/state.ts';

const HOME = '/home/k/Documents/mbrd';
const MB = 1024 * 1024;

/** path -> Blob. What the shell's disk holds. */
const disk = new Map();
const nameOf = path => path.slice(path.lastIndexOf('/') + 1);

const shell = {
  files: {
    folder: {
      list: async () => ({
        folder: HOME,
        files: [...disk.keys()].map(p => ({ name: nameOf(p), path: p, at: 1 })),
      }),
      create: async (suggested, blob) => {
        const path = HOME + '/' + suggested;
        disk.set(path, blob);
        return { name: suggested, path };
      },
      rename: async ref => ref,
      trash: async () => {},
      reveal: async () => {},
    },
    canPick: () => true,
    pickOpen: async () => { throw Object.assign(new Error('no'), { name: 'AbortError' }); },
    pickSave: async suggested => ({ name: suggested, path: HOME + '/' + suggested }),
    write: async (ref, blob) => { disk.set(ref.path, blob); },
    append: async (ref, blob, at) => {
      const was = disk.get(ref.path);
      if (was.size !== at) throw new Error('the file changed length');
      disk.set(ref.path, new Blob([was, blob]));
    },
    tail: async (ref, length) => {
      const file = disk.get(ref.path);
      const from = Math.max(0, file.size - length);
      return { size: file.size, bytes: new Uint8Array(await file.slice(from).arrayBuffer()) };
    },
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

/** A picture of `n` bytes in the asset store, as an import files one. */
async function picture(n, seed) {
  const data = bytes(n, seed);
  const id = await realHash(data);
  putAsset(id, new Blob([data], { type: 'image/png' }), { ext: 'png', mime: 'image/png', name: `p${seed}.png` });
  return id;
}

const image = (id, hash) => item({ id, type: 'image', asset: { hash, embedded: true } });

/** The file on screen, and how much of it is dead. */
async function onDisk() {
  const path = (await listBoards()).find(e => e.current).path;
  const file = disk.get(path);
  const layout = layoutFromTail(new Uint8Array(await file.arrayBuffer()), file.size);
  return { path, file, size: file.size, dead: deadBytes(layout) };
}

before(() => {
  setStoreBackend(memoryStore());
  setPlatform(shell);
});

after(() => { setPlatform(null); setStoreBackend(null); });

test('dead bytes read from a file agree with what the append that left them counted', async () => {
  const one = [{ name: 'a.txt', data: bytes(3000, 1) }, { name: 'b.txt', data: bytes(2000, 2) }];
  const { blob, layout } = await writeZipLayout(one);
  assert.equal(deadBytes(layout), 0);
  const { tail, layout: after, waste } = await appendZip([{ name: 'a.txt', data: bytes(3000, 3) }], layout, () => false);
  assert.ok(waste > 5000, 'both old entries and the old directory are dead');
  assert.equal(deadBytes(after), waste);
  const file = new Blob([blob, tail]);
  const read = layoutFromTail(new Uint8Array(await file.arrayBuffer()), file.size);
  assert.equal(deadBytes(read), waste, 'and so does the directory read back from the file');
});

test('dead bytes are worth a whole write at a fifth of the file, or at 64 MB', () => {
  assert.equal(worthCompacting(3 * MB, 10 * MB), false, 'under 4 MB is never worth it');
  assert.equal(worthCompacting(5 * MB, 20 * MB), true, 'a quarter of the file is');
  assert.equal(worthCompacting(5 * MB, 30 * MB), false, 'a sixth is not');
  assert.equal(worthCompacting(64 * MB, 2000 * MB), true, 'and 64 MB always is');
});

test('a picture taken off the board stays in its file until a quiet moment drops it', async () => {
  const keep = await picture(8 * MB, 1);
  const drop = await picture(5 * MB, 2);
  loadBoard({ title: 'Quiet', items: [image('a', keep), image('b', drop)] });
  await adoptFolder();
  const first = await onDisk();
  assert.ok(first.dead < 1024, 'a new file is all live');

  loadBoard({ title: 'Quiet', items: [image('a', keep)] });
  markDirty();
  assert.equal(await saveDocument(), true);
  const appended = await onDisk();
  assert.ok(appended.size > first.size, 'the save appended rather than rewrote');
  assert.ok(appended.dead >= 5 * MB, 'and the dropped picture is dead bytes in it');

  assert.equal(await compactDocument(), true);
  const compacted = await onDisk();
  assert.ok(compacted.size < first.size - 4 * MB, 'the file lost the picture');
  assert.ok(compacted.dead < 1024, 'and nothing in it is dead');
  assert.equal(isDirty(), false);
  const { board } = await unpackBoard(new File([compacted.file], nameOf(compacted.path)));
  assert.deepEqual(board.items.map(i => i.asset?.hash), [keep], 'the board is all still there');

  assert.equal(await compactDocument(), false, 'a second quiet moment finds nothing to do');
  assert.equal(disk.get(compacted.path), compacted.file, 'and does not write');
});
