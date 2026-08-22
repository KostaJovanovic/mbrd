// The IndexedDB wrapper's one job is an honest promise: a write resolves only
// once its transaction commits, never when the request is merely accepted. A
// tiny controllable fake proves both the abort case (request succeeds, then the
// transaction aborts -> the public promise must reject) and reconnect after a
// failed open. See AUD-01 and AUD-16 in research/old/full-code-audit-2026-07-26.md.

import { test } from 'node:test';
import assert from 'node:assert/strict';

// The fake used to live here. It moved to helpers.js when storage/matte-cache.ts
// - a cache built on this wrapper - needed one too, because two copies of it are
// two definitions of what IndexedDB does. Its documentation moved with it.
import { fakeIndexedDB, soon } from './helpers.js';

// Each test needs its own module instance, because idb.js caches the open
// connection in a module-level promise. A cache-busting query gives a fresh one.
let n = 0;
async function freshIdb(fake) {
  globalThis.indexedDB = fake;
  return import(`../web/assets/js/storage/idb.ts?case=${n++}`);
}

test('a write whose transaction aborts after request success still rejects', async () => {
  const { idbSet } = await freshIdb(fakeIndexedDB({ txOutcome: 'abort' }));
  await assert.rejects(idbSet('kv', 'k', 'v'), /aborted/);
});

test('a write resolves only on transaction complete, and the value round-trips', async () => {
  const { idbSet, idbGet } = await freshIdb(fakeIndexedDB({ txOutcome: 'complete' }));
  await idbSet('kv', 'k', 'v');
  assert.equal(await idbGet('kv', 'k'), 'v');
});

test('a failed open does not poison the connection: a later operation reconnects', async () => {
  const { idbGet } = await freshIdb(fakeIndexedDB({ openFailures: 1 }));
  await assert.rejects(idbGet('kv', 'k'), /open failed/);
  // Second call must reopen rather than reuse the rejected promise.
  assert.equal(await idbGet('kv', 'missing'), undefined);
});

// `blocked` is not a terminal event: the request stays live and can still
// succeed once the blocking tab closes. We answer it by rejecting - a save that
// fails loudly beats one that hangs on another window - but the connection that
// arrives afterwards has no owner, and an idle connection nobody holds is
// itself what blocks the next tab's upgrade. It must be closed.
test('an open blocked and then succeeding does not leave an orphan connection', async () => {
  let closed = 0;
  let succeed;
  const fake = {
    open() {
      const req = {};
      soon(() => {
        req.onblocked && req.onblocked();
        // The blocking tab closes later; the same request then completes.
        succeed = () => {
          req.result = {
            objectStoreNames: { contains: () => true },
            createObjectStore() {},
            close() { closed++; },
            transaction() { throw new Error('an orphan must never serve work'); },
          };
          req.onsuccess && req.onsuccess();
        };
      });
      return req;
    },
  };
  const { idbGet } = await freshIdb(fake);
  await assert.rejects(idbGet('kv', 'k'), /blocked/);
  succeed();
  assert.equal(closed, 1, 'the late connection must be closed, not retained');
});

// The batch calls exist because the autosave sweep and the session restore used
// to open one transaction per asset and await each before issuing the next -
// on a board of five hundred photographs, five hundred sequential round trips
// standing between the user and a board they had been told was saved. What has
// to hold is that they are genuinely one transaction, that they keep the
// wrapper's promise honest (nothing resolves before the commit), and that a
// batch is all-or-nothing.

test('a batch write is one transaction, and every value round-trips', async () => {
  const fake = fakeIndexedDB();
  const { idbSetMany, idbGetMany } = await freshIdb(fake);
  const before = fake.stats.transactions;
  await idbSetMany('assets', [['a', 1], ['b', 2], ['c', 3]]);
  assert.equal(fake.stats.transactions - before, 1, 'three puts, one transaction');
  assert.deepEqual(await idbGetMany('assets', ['a', 'b', 'c']), [1, 2, 3]);
});

test('a batch read answers in the order asked, with holes for missing keys', async () => {
  // Order is the contract: the restore pairs each record back with the hash at
  // the same index, so a reordered answer would file every asset under the
  // wrong card.
  const { idbSetMany, idbGetMany } = await freshIdb(fakeIndexedDB());
  await idbSetMany('assets', [['x', 'ex'], ['y', 'why']]);
  assert.deepEqual(await idbGetMany('assets', ['y', 'gone', 'x']), ['why', undefined, 'ex']);
});

test('an empty batch does no work at all', async () => {
  const fake = fakeIndexedDB();
  const { idbSetMany, idbGetMany, idbDelMany } = await freshIdb(fake);
  // Touch the connection first, so the count below is about the batches.
  await idbSetMany('assets', [['seed', 1]]);
  const before = fake.stats.transactions;
  assert.deepEqual(await idbGetMany('assets', []), []);
  assert.deepEqual(await idbSetMany('assets', []), []);
  assert.deepEqual(await idbDelMany('assets', []), []);
  assert.equal(fake.stats.transactions, before, 'nothing to do opens nothing');
});

test('a batch that aborts rejects rather than reporting a partial write', async () => {
  // The reason the wrapper resolves on oncomplete and not on request success:
  // every put in the batch is accepted, and the transaction still fails.
  const { idbSetMany } = await freshIdb(fakeIndexedDB({ txOutcome: 'abort' }));
  await assert.rejects(idbSetMany('assets', [['a', 1], ['b', 2]]), /aborted/);
});

test('a batch delete removes exactly what it was given', async () => {
  const { idbSetMany, idbDelMany, idbKeys } = await freshIdb(fakeIndexedDB());
  await idbSetMany('assets', [['a', 1], ['b', 2], ['c', 3]]);
  await idbDelMany('assets', ['a', 'c']);
  assert.deepEqual(await idbKeys('assets'), ['b']);
});
