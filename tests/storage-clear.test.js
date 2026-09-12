// clearSession() used to swallow every failure and report success while data
// survived a failed wipe. It now throws on a wipe that does not commit,
// driven here through a controllable fake-IDB: abort must reject, commit
// must resolve. The overlapping-save and clear-during-save races need the
// bus wiring and page globals initStorage() installs, and live in the
// browser smoke suite (AUD-13) instead.

import { test } from 'node:test';
import assert from 'node:assert/strict';

const soon = fn => Promise.resolve().then(fn);

// One shared connection serves both cases; the outcome flag is read at
// settle-time, so flipping it between tests needs no reconnect (idb.ts
// caches the connection for the process).
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

const { clearSession } = await import('../web/assets/js/storage/storage.ts');

test('clearSession rejects when the wipe transaction does not commit', async () => {
  outcome = 'abort';
  await assert.rejects(clearSession(), /aborted/);
});

test('clearSession resolves when the wipe commits', async () => {
  outcome = 'complete';
  await assert.doesNotReject(clearSession());
});
