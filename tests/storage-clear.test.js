// clearSession() used to swallow every failure and return nothing, so "Clear
// everything" could report success while user data survived a failed wipe. It
// now throws on a wipe that does not commit. This drives it through a
// controllable fake-IDB: an aborting clear transaction must reject, a
// committing one must resolve.
//
// The overlapping-save (A/B inversion) and clear-during-save races are browser
// boundary flows - they need the bus wiring and page globals initStorage()
// installs - and live in the browser smoke suite (AUD-13), not here.

import { test } from 'node:test';
import assert from 'node:assert/strict';

const soon = fn => Promise.resolve().then(fn);

// One shared connection serves both cases; the transaction outcome is read from
// this flag at settle-time, so flipping it between tests needs no reconnect
// (idb.js caches the connection for the process, and the relative import means
// there is only one idb.js instance to cache it).
let outcome = 'complete';

globalThis.indexedDB = {
  open() {
    const req = {};
    soon(() => {
      const store = { clear: () => makeRequest() };
      req.result = {
        objectStoreNames: { contains: () => true },
        createObjectStore() {}, close() {},
        transaction() { const t = { objectStore: () => store }; makeRequest.tx = t; return t; },
      };
      req.onsuccess && req.onsuccess();
    });
    function makeRequest() {
      const r = {};
      soon(() => {
        r.result = undefined;
        r.onsuccess && r.onsuccess();
        soon(() => {
          const t = makeRequest.tx;
          if (outcome === 'abort') { t.error = new Error('aborted'); t.onabort && t.onabort(); }
          else t.oncomplete && t.oncomplete();
        });
      });
      return r;
    }
    return req;
  },
};

const { clearSession } = await import('../web/assets/js/storage/storage.js');

test('clearSession rejects when the wipe transaction does not commit', async () => {
  outcome = 'abort';
  await assert.rejects(clearSession(), /aborted/);
});

test('clearSession resolves when the wipe commits', async () => {
  outcome = 'complete';
  await assert.doesNotReject(clearSession());
});
