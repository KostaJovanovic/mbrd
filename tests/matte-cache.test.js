// The cut-out cache is the one derived thing in this app that outlives the
// session, and it earns that by being expensive: a matted card is a pass through
// u2netp on the wasm backend, serialized against every other matted card, and
// before this existed a board of cut-outs re-derived all of them on every single
// load. See the header of web/assets/js/storage/matte-cache.ts.
//
// Three properties are worth a test, and they are not the same property:
//
//  - it survives a reload. Modelled by a second module instance reading what the
//    first wrote, which is what a fresh page is: new module scope, same
//    database.
//  - it never serves the wrong picture. Every input that moves a pixel is in the
//    variant string, and a variant that differs by one character must miss.
//  - it lets go. Emptying the bin takes the cut-outs with it, because a cut-out
//    is the photograph, and the eviction arithmetic bounds what one browser can
//    accumulate.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { fakeIndexedDB } from './helpers.js';
// Canonical, deliberately un-cache-busted, for the same reason display.test.js
// imports the asset registry that way: matte-cache.ts resolves './idb.ts' with
// no query, so a query-busted copy here would be a second wrapper holding a
// second connection, and every assertion below would be about the wrong one.
import { idbSet, idbKeys } from '../web/assets/js/storage/idb.ts';

// Installed before anything opens a connection. idb.ts reaches for the global
// inside open() and nowhere else, so this lands in time even though the imports
// above have already run.
globalThis.indexedDB = fakeIndexedDB();

/**
 * A new module instance over the same database - which is what a reload is.
 *
 * matte-cache.ts keeps its index in module scope, so a test that wants to prove
 * something crossed a page boundary has to cross a module boundary. The database
 * behind it is the one fake installed above and is deliberately shared, so each
 * test works on hashes nobody else uses.
 */
let n = 0;
const freshCache = () => import(`../web/assets/js/storage/matte-cache.ts?case=${n++}`);

const blob = (size, type = 'image/webp') => new Blob([new Uint8Array(size)], { type });

// ---------------------------------------------------------------------------
// The eviction arithmetic, which needs no database
// ---------------------------------------------------------------------------

const entries = (count, bytes = 1) =>
  Array.from({ length: count }, (_, i) => ({ k: `k${i}`, h: `h${i}`, n: bytes }));

test('eviction drops the oldest until the count cap holds', async () => {
  const { evict } = await freshCache();
  const list = entries(205);
  const gone = evict(list);
  assert.equal(list.length, 200, 'the cap is what is left standing');
  assert.deepEqual(gone, ['k0', 'k1', 'k2', 'k3', 'k4'], 'and the oldest are what went');
  assert.equal(list[list.length - 1].k, 'k204', 'the newest entry always survives');
});

test('eviction drops the oldest until the byte cap holds', async () => {
  const { evict } = await freshCache();
  // Ten entries of 8 MB against a 64 MB cap: two have to go.
  const list = entries(10, 8 * 1024 * 1024);
  const gone = evict(list);
  assert.deepEqual(gone, ['k0', 'k1']);
  assert.equal(list.length, 8);
});

test('eviction keeps a single entry even if it is over the byte cap on its own', async () => {
  // Writing a picture and deleting it in the next breath is a cache that cannot
  // cache. The next write evicts it normally.
  const { evict } = await freshCache();
  const list = entries(1, 200 * 1024 * 1024);
  assert.deepEqual(evict(list), []);
  assert.equal(list.length, 1);
});

test('a list already inside both caps is left alone', async () => {
  const { evict } = await freshCache();
  const list = entries(3);
  assert.deepEqual(evict(list), []);
  assert.equal(list.length, 3);
});

// ---------------------------------------------------------------------------
// The point of the whole file
// ---------------------------------------------------------------------------

test('a cut-out written by one session is read back by the next', async () => {
  const first = await freshCache();
  await first.saveMatte('aa', '%~1280', blob(4096));

  const second = await freshCache();
  const back = await second.loadMatte('aa', '%~1280');
  assert.ok(back instanceof Blob, 'the copy comes back as a blob, not as nothing');
  assert.equal(back.size, 4096, 'and it is the same picture, not a different one');
});

test('a variant that differs at all misses', async () => {
  // The sharpness ceiling, the crop, the turn, the model version - every one of
  // them is in this string, and a hit on the wrong one is a picture drawn at a
  // resolution or a rotation nobody asked for. A miss only costs time.
  const cache = await freshCache();
  await cache.saveMatte('bb', '%~1280', blob(64));
  assert.equal(await cache.loadMatte('bb', '%~1024'), null, 'a different ceiling misses');
  assert.equal(await cache.loadMatte('bb', '@90%~1280'), null, 'a turned copy misses');
  assert.equal(await cache.loadMatte('cc', '%~1280'), null, 'another picture misses');
});

test('a listed entry whose bytes are not a picture answers null rather than serving it', async () => {
  const cache = await freshCache();
  await cache.saveMatte('dd', '%~1280', blob(64));
  // Something else under the key: an older build, or another tab mid-upgrade.
  await idbSet('matte', 'dd%~1280', 'not a picture');
  assert.equal(await cache.loadMatte('dd', '%~1280'), null);
  // And it is forgotten rather than asked for again on every mount.
  assert.equal(await cache.loadMatte('dd', '%~1280'), null);
});

test('emptying the bin takes the cut-outs of those pictures and nothing else', async () => {
  const cache = await freshCache();
  await cache.saveMatte('ee', '%~1280', blob(64));
  await cache.saveMatte('ee', '@90%~1280', blob(64));   // same picture, second variant
  await cache.saveMatte('ff', '%~1280', blob(64));

  await cache.forgetMatte(['ee']);

  assert.equal(await cache.loadMatte('ee', '%~1280'), null, 'every variant of it goes');
  assert.equal(await cache.loadMatte('ee', '@90%~1280'), null);
  assert.ok(await cache.loadMatte('ff', '%~1280'), 'and nothing else does');

  const keys = await idbKeys('matte');
  assert.ok(!keys.includes('ee%~1280'), 'the bytes are gone from the store, not just unlisted');
  assert.ok(!keys.includes('ee@90%~1280'));
});

test('a blob nobody listed is collected on the next session', async () => {
  // A write whose index write never landed, or another tab whose additions this
  // tab overwrote. The store is the truth and the index is a hint, so the pass
  // that reconciles them has to delete what nothing can reach.
  await idbSet('matte', 'orphan-key', blob(64));
  const cache = await freshCache();
  await cache.loadMatte('gg', '%~1280');   // any call reconciles
  for (let i = 0; i < 20; i++) await Promise.resolve();
  assert.ok(!(await idbKeys('matte')).includes('orphan-key'));
});

test('clearing takes every cut-out with it', async () => {
  const cache = await freshCache();
  await cache.saveMatte('hh', '%~1280', blob(64));
  await cache.clearMatteCache();
  assert.deepEqual(await idbKeys('matte'), [], 'the store is empty, index record included');
  assert.equal(await cache.loadMatte('hh', '%~1280'), null);
  const next = await freshCache();
  assert.equal(await next.loadMatte('hh', '%~1280'), null, 'and it stays empty across a reload');
});
