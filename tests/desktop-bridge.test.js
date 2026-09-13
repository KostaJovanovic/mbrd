// The whole desktop store path, without Electron.
//
// tests/store-backend.test.js proves the seam is a seam over a Map backend;
// this drives the real two halves - platform/electron.ts and
// desktop/format.mts - faking only IPC and the filesystem. It exists because
// the bug was in the join: each half looked right alone, but neither carried
// a Blob nested one level inside an asset record, so every picture on a
// restored board came back empty, silently. Neither half tested alone would
// have caught it.

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
 * Every value goes through encode()/decode(), same as desktop/store.ts around
 * a writeFile/readFile. Left out: the write and the IPC hop, neither of which
 * can lose a Blob the two ends already agreed about.
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
  // A browser draws a blob: URL by the blob's own type - losing it would
  // leave every restored photograph as a download prompt.
  putAsset(PHOTO, photo(), { ext: 'png', mime: 'image/png', name: 'p.png' });
  addItems([item()]);
  await autosave();
  clearAssets();
  await restoreSession();

  assert.equal(getAsset(PHOTO).blob.type, 'image/png');
});

test('what lands on disk is not a JSON object with an empty blob in it', () => {
  // The bug as artefact: `{"blob":{}}` is what a plain stringify writes, and
  // what this format exists to stop.
  const record = { blob: { __bytes: true, data: PIXELS.buffer, mime: 'image/png' }, ext: 'png' };
  // Buffer.from: encode() returns a plain Uint8Array, which has no latin1 view.
  const written = Buffer.from(encode(record)).toString('latin1');
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
