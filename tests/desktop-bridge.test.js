// The whole desktop store path, without Electron.
//
// tests/store-backend.test.js drives session.ts over a backend made of Maps,
// which proves the seam is a seam. This drives it over the *real* two halves of
// the desktop one: platform/electron.ts turning Blobs into bytes for the
// bridge, and desktop/format.mts turning those bytes into a file and back. Only
// the IPC hop and the filesystem are faked, and neither of them was ever where
// the bug was.
//
// It exists because the bug was in the join. Each half looked right on its own:
// the adapter converted a Blob, and the format wrote bytes. What neither of
// them did was carry a Blob that was one level down inside an asset record -
// so every picture on a restored board came back empty, silently, and the only
// way to see it was to run the shell and read a file on disk. A test of either
// half alone would still pass today with that bug in place.

import { test, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';

import { hash } from './helpers.js';
import { encode, decode } from '../desktop/format.mts';
import { electronStore } from '../web/assets/js/platform/electron.ts';
import { setStoreBackend } from '../web/assets/js/storage/idb.ts';
import {
  initSession, initSessionStorage, autosave, restoreSession, resetSessionLatches,
} from '../web/assets/js/storage/session.ts';
import { loadBoard, addItems, board, setBoardMode } from '../web/assets/js/state.ts';
import { putAsset, clearAssets, getAsset } from '../web/assets/js/storage/assets.ts';

const PHOTO = hash('photo');

/**
 * A bridge whose store is the desktop's file format in memory.
 *
 * Every value goes through encode() on the way in and decode() on the way out,
 * which is exactly what desktop/store.ts does around a writeFile and a
 * readFile. What is left out is the write itself and the IPC hop - one is the
 * operating system's and the other is structured clone, and neither can lose a
 * Blob that the two ends have already agreed about.
 */
function fakeBridge() {
  const files = new Map();
  const at = (store, key) => store + '/' + key;
  const store = {
    get: async (s, k) => {
      const raw = files.get(at(s, k));
      return raw === undefined ? undefined : decode(raw);
    },
    set: async (s, k, v) => { files.set(at(s, k), encode(v)); },
    del: async (s, k) => { files.delete(at(s, k)); },
    keys: async s => [...files.keys()].filter(f => f.startsWith(s + '/')).map(f => f.slice(s.length + 1)),
    clear: async s => {
      for (const f of [...files.keys()]) if (f.startsWith(s + '/')) files.delete(f);
    },
    getMany: async (s, ks) => Promise.all(ks.map(k => store.get(s, k))),
    setMany: async (s, es) => { for (const [k, v] of es) await store.set(s, k, v); },
    delMany: async (s, ks) => { for (const k of ks) await store.del(s, k); },
  };
  return { bridge: 1, store, files };
}

initSession({
  fileName: () => null,
  created: () => 1,
  setCreated() {},
  exportBoard: async () => false,
  prompt: async () => 'cancel',
});
const realSetInterval = globalThis.setInterval;
globalThis.setInterval = () => 0;
initSessionStorage();
globalThis.setInterval = realSetInterval;
const realSetTimeout = globalThis.setTimeout;
globalThis.setTimeout = (...args) => {
  const t = realSetTimeout(...args);
  t?.unref?.();
  return t;
};

let shell;

beforeEach(() => {
  shell = fakeBridge();
  setStoreBackend(electronStore(shell));
  clearAssets();
  resetSessionLatches();
  setBoardMode('desktop');
  loadBoard({ title: 'Over the bridge', items: [] });
});

after(() => setStoreBackend(null));

const PIXELS = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]);
const photo = () => new Blob([PIXELS], { type: 'image/png' });

const item = () => ({
  type: 'image', w: 100, h: 100, name: 'p.png',
  asset: { hash: PHOTO, ext: 'png', mime: 'image/png', name: 'p.png' },
});

test('a picture survives the round trip as a Blob, with its bytes', async () => {
  putAsset(PHOTO, photo(), { ext: 'png', mime: 'image/png', name: 'p.png' });
  addItems([item()]);
  assert.equal(await autosave(), true);

  clearAssets();
  loadBoard({ title: 'gone', items: [] });
  assert.equal(await restoreSession(), true);

  const asset = getAsset(PHOTO);
  assert.ok(asset, 'the asset came back at all');
  assert.ok(asset.blob instanceof Blob, 'and as a Blob - restoreSession() checks this and drops it if not');
  assert.equal(asset.blob.size, PIXELS.length, 'with its bytes, not an empty object');
  assert.deepEqual(new Uint8Array(await asset.blob.arrayBuffer()), PIXELS);
});

test('the picture keeps its MIME type across the bridge', async () => {
  // canvas/display.ts renders an asset from a blob: URL, and a browser draws
  // that by the blob's own type. A round trip that lost it would leave every
  // photograph on a restored board as a file the app offers to download.
  putAsset(PHOTO, photo(), { ext: 'png', mime: 'image/png', name: 'p.png' });
  addItems([item()]);
  await autosave();
  clearAssets();
  await restoreSession();

  assert.equal(getAsset(PHOTO).blob.type, 'image/png');
});

test('what lands on disk is not a JSON object with an empty blob in it', () => {
  // The bug, stated as the artefact it produced. `{"blob":{}}` is what a
  // stringify of an asset record writes, and it is what this whole format
  // exists to stop being written.
  const record = { blob: { __bytes: true, data: PIXELS.buffer, mime: 'image/png' }, ext: 'png' };
  const written = encode(record).toString('latin1');
  assert.doesNotMatch(written, /"blob":\{\}/, 'the Blob was not stringified away');
  assert.match(written, /"__bytes":1/, 'it was lifted out and placed instead');
});

test('the board itself comes back, so the bytes are not the only thing carried', async () => {
  putAsset(PHOTO, photo(), { ext: 'png', mime: 'image/png', name: 'p.png' });
  addItems([item()]);
  await autosave();
  loadBoard({ title: 'gone', items: [] });
  await restoreSession();

  assert.equal(board.title, 'Over the bridge');
  assert.equal(board.items.length, 1);
});

test('the sweep reaches the desktop store too', async () => {
  const stray = hash('stray');
  putAsset(PHOTO, photo(), { ext: 'png', mime: 'image/png', name: 'p.png' });
  putAsset(stray, photo(), { ext: 'png', mime: 'image/png', name: 's.png' });
  addItems([item()]);
  await autosave();

  assert.ok(shell.files.has('assets/' + PHOTO), 'the referenced asset is on disk');
  assert.equal(shell.files.has('assets/' + stray), false, 'the unreferenced one was swept');
});
