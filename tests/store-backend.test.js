// The recovery store, driven through the seam rather than through IndexedDB.
//
// storage/idb.ts is a port now: eight functions over four named stores, with the
// IndexedDB code as one implementation and the desktop's directory of files as
// the other. Everything above it - session.ts's snapshot writer, its asset
// sweep, its wipe - is written against those eight and nothing lower, and this
// file is the evidence for that claim. If any of it round-trips here, on a
// backend made of Maps, it round-trips on a backend made of files.
//
// It is also where the two contracts idb.ts's header states are held to:
//
//   the batch forms may tear     - so writeSnapshot()'s order has to survive a
//                                  setMany() that only half landed
//   clear() may not              - a partial wipe has to come back as a
//                                  rejection, because clearAllData() reports a
//                                  failed wipe rather than reloading over it
//
// The second is PERSIST-03 and is the one that would be a privacy failure: a
// person asked for everything to be gone and would have been told it was.

import { test, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';

import { memoryStore, hash } from './helpers.js';
import { setStoreBackend } from '../web/assets/js/storage/idb.ts';
import {
  initSession, initSessionStorage, autosave, restoreSession, clearSession,
  resetSessionLatches, drainSave,
} from '../web/assets/js/storage/session.ts';
import { loadBoard, addItems, board, setBoardMode } from '../web/assets/js/state.ts';
import { putAsset, clearAssets, getAsset } from '../web/assets/js/storage/assets.ts';

const PHOTO = hash('photo');
const GONE = hash('unreferenced');

// A real Blob, unlike the stub session.test.js uses. restoreSession() tests
// `rec.blob instanceof Blob` before rebuilding a card - the check that stops a
// hand-edited store putting a string on the board - so a round-trip test has to
// put back something that passes it.
const blob = () => new Blob([new Uint8Array([1, 2, 3, 4])], { type: 'image/jpeg' });

initSession({
  fileName: () => null,
  created: () => 1,
  setCreated() {},
  exportBoard: async () => false,
  prompt: async () => 'cancel',
});
// The 20s tick would hold the runner's event loop open for the life of the
// process, and every save here is asked for. Same stub session.test.js uses, and
// for the same reason.
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

  // Everything the app knows in memory goes, so the restore is a real read
  // rather than a look at what is still lying about.
  clearAssets();
  loadBoard({ title: 'something else', items: [] });

  assert.equal(await restoreSession(), true);
  assert.equal(board.title, 'Backed');
  assert.equal(board.items.length, 1);
  assert.ok(getAsset(PHOTO), 'and the bytes came back with it');
});

test('the sweep still deletes what the snapshot stopped referring to', async () => {
  // The dangerous half of writeSnapshot(), and the half a swapped backend could
  // most easily break: it deletes every stored asset the snapshot it just wrote
  // does not mention.
  putAsset(PHOTO, blob(), { ext: 'jpg', mime: 'image/jpeg', name: 'p.jpg' });
  putAsset(GONE, blob(), { ext: 'jpg', mime: 'image/jpeg', name: 'g.jpg' });
  addItems([asItem()]);

  assert.equal(await autosave(), true);
  const assets = store.stores.get('assets');
  assert.ok(assets.has(PHOTO), 'the referenced asset is stored');
  assert.equal(assets.has(GONE), false, 'the unreferenced one was swept');
});

test('the snapshot lands after the assets it names, so a torn write is survivable', async () => {
  // Not a test of the writer's success but of its *order*, which is the whole
  // reason a backend without transactions is allowed here. Recorded by watching
  // the store rather than by mocking, so it is the real sequence.
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
  // PERSIST-03, restated against the port. clearAllData() drops the write latch,
  // drains the writer and surfaces a failed wipe; that only works if the backend
  // says a partial clear failed. A backend that deleted what it could and
  // resolved anyway would turn the report into a lie.
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

test('the writer drains before a wipe, so nothing lands behind it', async () => {
  putAsset(PHOTO, blob(), { ext: 'jpg', mime: 'image/jpeg', name: 'p.jpg' });
  addItems([asItem()]);
  const saving = autosave();
  await drainSave();
  await saving;
  await clearSession();
  assert.equal(store.stores.get('kv').size, 0, 'the drained save did not repopulate the store');
});
