// The IndexedDB wrapper's one job is an honest promise: a write resolves only
// once its transaction commits, never when the request is merely accepted. A
// tiny controllable fake proves both the abort case (request succeeds, then the
// transaction aborts -> the public promise must reject) and reconnect after a
// failed open. See AUD-01 and AUD-16 in research/full-code-audit-2026-07-26.md.

import { test } from 'node:test';
import assert from 'node:assert/strict';

const soon = fn => Promise.resolve().then(fn);

/**
 * A fake `indexedDB` that lets a test dictate how the transaction ends.
 *
 * `txOutcome` is one of 'complete' | 'abort' | 'error'. `openFailures` is how
 * many times `open()` should fail before it starts succeeding, which is what
 * exercises the reconnect path.
 */
function fakeIndexedDB({ txOutcome = 'complete', openFailures = 0 } = {}) {
  const data = new Map();
  let remainingFailures = openFailures;

  function makeRequest(result) {
    const r = {};
    soon(() => {
      r.result = result;
      r.onsuccess && r.onsuccess();
      // Only after request success does the transaction reach its outcome. An
      // early-resolving wrapper would have already resolved by now - that is
      // exactly the bug the abort case catches.
      soon(() => {
        const t = makeRequest.tx;
        if (txOutcome === 'abort') { t.error = new Error('aborted'); t.onabort && t.onabort(); }
        else if (txOutcome === 'error') { t.error = new Error('tx error'); t.onerror && t.onerror(); }
        else t.oncomplete && t.oncomplete();
      });
    });
    return r;
  }

  return {
    open() {
      const req = {};
      soon(() => {
        if (remainingFailures > 0) {
          remainingFailures--;
          req.error = new Error('open failed');
          req.onerror && req.onerror();
          return;
        }
        const store = {
          put(v, k) { data.set(k, v); return makeRequest(v); },
          get(k) { return makeRequest(data.get(k)); },
          delete(k) { data.delete(k); return makeRequest(undefined); },
          clear() { data.clear(); return makeRequest(undefined); },
          getAllKeys() { return makeRequest([...data.keys()]); },
        };
        const db = {
          objectStoreNames: { contains: () => true },
          createObjectStore() {},
          close() {},
          transaction() {
            const t = { objectStore: () => store };
            makeRequest.tx = t;
            return t;
          },
        };
        req.result = db;
        req.onsuccess && req.onsuccess();
      });
      return req;
    },
  };
}

// Each test needs its own module instance, because idb.js caches the open
// connection in a module-level promise. A cache-busting query gives a fresh one.
let n = 0;
async function freshIdb(fake) {
  globalThis.indexedDB = fake;
  return import(`../web/assets/js/storage/idb.js?case=${n++}`);
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
