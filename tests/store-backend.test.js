// The recovery store, driven through the seam rather than through IndexedDB.
// storage/idb.ts is a port - eight functions over four stores, IndexedDB one
// implementation and the desktop's file directory the other - and session.ts
// is written against only those eight, so a round trip on a Maps-backed
// fake proves it round-trips on files too. Also holds idb.ts's two
// contracts: batch writes may tear (writeSnapshot()'s order must survive a
// half-landed setMany()), and clear() may not (a partial wipe must reject -
// PERSIST-03, the privacy failure of reporting a wipe that did not happen).

import { test, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';

import { memoryStore, hash } from './helpers.js';
import { setStoreBackend } from '../web/assets/js/storage/idb.ts';
import {
  initSession, initSessionStorage, autosave, restoreSession, clearSession,
  resetSessionLatches, drainSave, saveRefused, suspendCache,
} from '../web/assets/js/storage/session.ts';
import { loadBoard, addItems, board, setBoardMode, bus } from '../web/assets/js/state.ts';
import { putAsset, clearAssets, getAsset } from '../web/assets/js/storage/assets.ts';

const PHOTO = hash('photo');
const GONE = hash('unreferenced');

// A real Blob, unlike the stub session.test.js uses: restoreSession() tests
// `rec.blob instanceof Blob` before rebuilding a card, so the round trip
// needs something that passes it.
const blob = () => new Blob([new Uint8Array([1, 2, 3, 4])], { type: 'image/jpeg' });

initSession({
  fileName: () => null,
  created: () => 1,
  setCreated() {},
  exportBoard: async () => false,
  prompt: async () => 'cancel',
});
// The 20s tick would hold the runner's event loop open for the process's
// life. Same stub session.test.js uses, for the same reason.
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

let store;

beforeEach(() => {
  store = memoryStore();
  setStoreBackend(store);
  clearAssets();
  resetSessionLatches();
  setBoardMode('desktop');
  loadBoard({ title: 'Backed', items: [] });
});

after(() => setStoreBackend(null));

const asItem = () => ({
  type: 'image', w: 100, h: 100, name: 'p.jpg',
  asset: { hash: PHOTO, ext: 'jpg', mime: 'image/jpeg', name: 'p.jpg' },
});

test('a board with an asset round-trips through a backend that is not a database', async () => {
  putAsset(PHOTO, blob(), { ext: 'jpg', mime: 'image/jpeg', name: 'p.jpg' });
  addItems([asItem()]);
  assert.equal(await autosave(), true);

  // Wipe in-memory state, so the restore is a real read, not a look at
  // what's still lying about.
  clearAssets();
  loadBoard({ title: 'something else', items: [] });

  assert.equal(await restoreSession(), true);
  assert.equal(board.title, 'Backed');
  assert.equal(board.items.length, 1);
  assert.ok(getAsset(PHOTO), 'and the bytes came back with it');
});

test('the sweep still deletes what the snapshot stopped referring to', async () => {
  // The dangerous half of writeSnapshot(), and easiest for a swapped backend
  // to break: it deletes every stored asset the new snapshot does not mention.
  putAsset(PHOTO, blob(), { ext: 'jpg', mime: 'image/jpeg', name: 'p.jpg' });
  putAsset(GONE, blob(), { ext: 'jpg', mime: 'image/jpeg', name: 'g.jpg' });
  addItems([asItem()]);

  assert.equal(await autosave(), true);
  const assets = store.stores.get('assets');
  assert.ok(assets.has(PHOTO), 'the referenced asset is stored');
  assert.equal(assets.has(GONE), false, 'the unreferenced one was swept');
});

test('the snapshot lands after the assets it names, so a torn write is survivable', async () => {
  // A test of *order*, not success - the reason a transaction-free backend
  // is allowed here. Recorded by watching the store, not by mocking.
  const seen = [];
  const real = store.set;
  store.set = async (s, k, v) => { seen.push(s); return real(s, k, v); };
  const realMany = store.setMany;
  store.setMany = async (s, entries) => { if (entries.length) seen.push(s); return realMany(s, entries); };

  putAsset(PHOTO, blob(), { ext: 'jpg', mime: 'image/jpeg', name: 'p.jpg' });
  addItems([asItem()]);
  assert.equal(await autosave(), true);

  assert.ok(seen.includes('assets'), 'assets were written');
  assert.ok(
    seen.indexOf('assets') < seen.lastIndexOf('kv'),
    'and the snapshot in kv landed after them, so it never points at bytes that are not there',
  );
});

test('a wipe that cannot finish rejects rather than reporting success', async () => {
  // PERSIST-03 against the port: clearAllData() surfaces a failed wipe only
  // if the backend says a partial clear failed. One that deleted what it
  // could and resolved anyway would turn the report into a lie.
  putAsset(PHOTO, blob(), { ext: 'jpg', mime: 'image/jpeg', name: 'p.jpg' });
  addItems([asItem()]);
  await autosave();

  store.clear = async name => {
    if (name === 'assets') throw new Error('one file was locked');
  };
  await assert.rejects(clearSession(), /locked/);
});

test('a wipe that finishes empties every store', async () => {
  putAsset(PHOTO, blob(), { ext: 'jpg', mime: 'image/jpeg', name: 'p.jpg' });
  addItems([asItem()]);
  await autosave();
  assert.ok(store.stores.get('assets').size > 0);

  await assert.doesNotReject(clearSession());
  for (const [name, map] of store.stores) {
    assert.equal(map.size, 0, name + ' still holds something after a wipe');
  }
});

test('a refused write is announced and stays announced until the latches reset', async () => {
  // The HUD's standing "Not saved" mark and the close guard both hang off this.
  const heard = [];
  const off = bus.on('save:refused', on => heard.push(on));
  store.set = async () => { throw new Error('QuotaExceededError'); };
  store.setMany = async () => { throw new Error('QuotaExceededError'); };
  addItems([asItem()]);
  assert.equal(await autosave(), false);
  assert.equal(saveRefused(), true);
  resetSessionLatches();
  assert.equal(saveRefused(), false);
  assert.deepEqual(heard, [true, false]);
  off();
});

test('turning the cache off on purpose is not a refusal', () => {
  // suspendCache() is the not-found board, /patch and the bench: nothing of
  // the user's is at risk, so nothing may warn about it.
  suspendCache();
  assert.equal(saveRefused(), false);
  resetSessionLatches();
});

test('the writer drains before a wipe, so nothing lands behind it', async () => {
  putAsset(PHOTO, blob(), { ext: 'jpg', mime: 'image/jpeg', name: 'p.jpg' });
  addItems([asItem()]);
  const saving = autosave();
  await drainSave();
  await saving;
  await clearSession();
  assert.equal(store.stores.get('kv').size, 0, 'the drained save did not repopulate the store');
});
