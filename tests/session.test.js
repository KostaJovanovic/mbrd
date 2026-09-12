// The browser's own copy of the board: what the autosave sweep keeps,
// and what it says when it can't keep everything. The sweep is the
// dangerous half of writeSnapshot() - it deletes every stored asset the
// snapshot doesn't mention, so anything referencedHashes() forgets is
// deleted from under a board that still needs it, and the board never
// goes clean again. Driven through a fake IndexedDB with one map per
// store, so the test can see exactly what survived.

import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

import { hash } from './helpers.js';

const soon = fn => Promise.resolve().then(fn);

/** One map per store, unlike the shared one in idb.test.js - the sweep
 *  touches `assets` and the snapshot lives in `kv`, so a test unable to
 *  tell them apart couldn't see the bug. */
const stores = { kv: new Map(), assets: new Map() };

globalThis.indexedDB = {
  open() {
    const req = {};
    soon(() => {
      req.result = {
        objectStoreNames: { contains: () => true },
        createObjectStore() {}, close() {},
        transaction(name) {
          const data = stores[Array.isArray(name) ? name[0] : name];
          const t = { pending: 0 };
          makeRequest.tx = t;
          t.objectStore = () => ({
            put(v, k) { data.set(k, v); return makeRequest(v); },
            get(k) { return makeRequest(data.get(k)); },
            delete(k) { data.delete(k); return makeRequest(undefined); },
            clear() { data.clear(); return makeRequest(undefined); },
            getAllKeys() { return makeRequest([...data.keys()]); },
          });
          return t;
        },
      };
      req.onsuccess && req.onsuccess();
    });
    function makeRequest(result) {
      const t = makeRequest.tx;
      t.pending++;
      const r = {};
      soon(() => {
        r.result = result;
        r.onsuccess && r.onsuccess();
        soon(() => { if (--t.pending <= 0) t.oncomplete && t.oncomplete(); });
      });
      return r;
    }
    return req;
  },
};

// The engine directly, wired by hand. initSession() hands it the four
// things it borrows from the file half; initSessionStorage() is the half
// that matters here, since it binds the change counter - without it
// autosave() answers every caller from the first run's result and never
// writes again.
const { initSession, initSessionStorage, autosave, lastSaveFailure, resetSessionLatches } =
  await import('../web/assets/js/storage/session.ts');
const { loadBoard, addItems, removeItems, board, setBoardMode } =
  await import('../web/assets/js/state.ts');
const { putAsset, clearAssets } = await import('../web/assets/js/storage/assets.ts');

initSession({
  fileName: () => null,
  created: () => 1,
  setCreated() {},
  exportBoard: async () => false,
  prompt: async () => 'cancel',
});
// The 20s tick would hold the runner's event loop open for the process's
// life, and nothing here wants a background writer anyway. Stubbed
// across the call rather than mocked out of the module, so the rest of
// initSessionStorage() is the real thing.
const realSetInterval = globalThis.setInterval;
globalThis.setInterval = () => 0;
initSessionStorage();
globalThis.setInterval = realSetInterval;
// The cooldown timer requestAutosave() arms from a bus event, unref'd
// rather than refused since it's armed later - so the runner doesn't sit
// out its five seconds after the last assertion passes.
const realSetTimeout = globalThis.setTimeout;
globalThis.setTimeout = (...args) => {
  const t = realSetTimeout(...args);
  t?.unref?.();
  return t;
};

const SMALL = hash('small');
const ORIGINAL = hash('original');

const blob = () => ({ size: 4, type: 'image/jpeg' });

beforeEach(() => {
  stores.kv.clear();
  stores.assets.clear();
  clearAssets();
  resetSessionLatches();
  setBoardMode('desktop');
  loadBoard({ title: 'T', items: [] });
});

test('a binned optimised item keeps its original bytes through the sweep', async () => {
  // The optimiser leaves meta.was naming the file it replaced, and the
  // sweep keeps those so undo can put the full-size photo back. The walk
  // only looked at live items, so binning the card had its original
  // deleted - discardOriginals() never clears the memo, restoreItems()
  // brings the item back live, and every save then reported a hash it
  // couldn't store.
  putAsset(SMALL, blob(), { ext: 'jpg', mime: 'image/jpeg', name: 's.jpg' });
  putAsset(ORIGINAL, blob(), { ext: 'jpg', mime: 'image/jpeg', name: 'o.jpg' });
  const [it] = addItems([{
    type: 'image', w: 200, h: 200, name: 's.jpg',
    asset: { hash: SMALL, ext: 'jpg', mime: 'image/jpeg', name: 's.jpg' },
    meta: { was: ORIGINAL },
  }]);

  assert.equal(await autosave(), true, 'the live board saves complete');
  assert.ok(stores.assets.has(ORIGINAL), 'and the original is on disk');

  removeItems([it.id]);
  assert.equal(board.trash.length, 1, 'the card is in the bin, not gone');

  assert.equal(await autosave(), true, 'the save after the delete still completes');
  assert.ok(stores.assets.has(ORIGINAL),
    'the bin was walked for meta.was, so the original survived the sweep');
});

test('a missing file nobody can name is still reported as a count', async () => {
  // describeMissing() matches item.asset.hash only, and a missing hash
  // can belong to none of them - a cover, an optimiser original, a face
  // the board is set in. Nothing matched, so the sentence was "0 items
  // () have no stored data" - naming, counting and asking for nothing.
  putAsset(SMALL, blob(), { ext: 'jpg', mime: 'image/jpeg', name: 's.jpg' });
  addItems([{
    type: 'image', w: 200, h: 200, name: 's.jpg',
    asset: { hash: SMALL, ext: 'jpg', mime: 'image/jpeg', name: 's.jpg' },
    // Referenced, kept by the sweep, named by nothing: the original
    // isn't any item's own asset, so the loop over items matches none of it.
    meta: { was: ORIGINAL },
  }]);

  assert.equal(await autosave(), false, 'a board it cannot store whole is not saved whole');
  const said = lastSaveFailure();
  assert.doesNotMatch(said, /^0 items/, 'never "0 items ()"');
  assert.match(said, /1 file this board needs is not stored/);
});
