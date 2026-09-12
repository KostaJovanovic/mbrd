// The board at an address the app does not have, and the two destructive
// paths (New, Clear everything) that must not touch it. A not-found boot
// never reads the session slot and never asks about it - New used to wipe
// the slot unasked and autosave the blank replacement over the hole, a
// stranger's wrong URL costing somebody their board. Driven through a fake
// IndexedDB that records only whether a wipe was reached.

import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { JS } from './helpers.js';

const soon = fn => Promise.resolve().then(fn);

/** Bumped by every clear() the app issues, which is the thing under test. */
let clears = 0;

globalThis.indexedDB = {
  open() {
    const req = {};
    soon(() => {
      // `clear` is the thing under test; the rest are stubs so the code path
      // *reaching* it can run - New files the outgoing board on the shelf
      // first and refuses if that write fails, so these four just say "the
      // write worked" without recording anything.
      const store = {
        clear: () => { clears++; return makeRequest(); },
        put: () => makeRequest(),
        get: () => makeRequest(),
        getAll: () => makeRequest(),
        getAllKeys: () => makeRequest(),
        delete: () => makeRequest(),
      };
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
        soon(() => { makeRequest.tx.oncomplete && makeRequest.tx.oncomplete(); });
      });
      return r;
    }
    return req;
  },
};

const {
  loadBoard, ensureGhostCards, isNotFoundBoard, leaveNotFoundBoard,
  setTitle, addItems,
} = await import('../web/assets/js/state.ts');
const { newBoard, clearAllData, setPrompt } = await import('../web/assets/js/storage/storage.ts');

/** Every answer the dialogs could give, recorded so a silent skip is visible. */
let asked = 0;

beforeEach(() => {
  clears = 0;
  asked = 0;
  setPrompt(async () => { asked++; return 'go'; });
  loadBoard({ title: 'T', items: [] });
  leaveNotFoundBoard();
});

test('a board seeded with the not-found set knows that is what it is', () => {
  assert.equal(isNotFoundBoard(), false, 'an ordinary blank board is not one');
  ensureGhostCards({ notFound: true });
  assert.equal(isNotFoundBoard(), true);
});

test('New on a not-found board refuses, and never reaches the wipe', async () => {
  ensureGhostCards({ notFound: true });
  const ok = await newBoard();
  assert.equal(ok, false, 'it says it did not start a new board');
  assert.equal(clears, 0, "the visitor's session slot is untouched");
  assert.equal(asked, 0, 'and it did not ask about a board it was not going to take');
});

test('Clear everything on a not-found board refuses before it asks', async () => {
  ensureGhostCards({ notFound: true });
  const ok = await clearAllData();
  assert.equal(ok, false);
  assert.equal(clears, 0);
  // The dialog would offer "Export first" over a message, not a real board -
  // refusing before asking is the difference between a wrong answer and no question.
  assert.equal(asked, 0);
});

test('the handover clears the latch, so the next New behaves normally', async () => {
  ensureGhostCards({ notFound: true });
  leaveNotFoundBoard();
  assert.equal(isNotFoundBoard(), false);
  const ok = await newBoard();
  assert.equal(ok, true, 'an ordinary board starts over');
  assert.ok(clears > 0, 'and the wipe is reached');
});

test('a not-found board that had no session to go back to loses the name too', () => {
  // 'Not found' is set at boot; on the branch with no stored board to
  // return to, nothing else overwrites it, and it would go on to be the
  // name Export writes. The reset lives in main.ts's leaveNotFound(), not
  // in anything importable here, so this asserts state's own half by
  // running it and main.ts's half by reading main.ts's source directly -
  // asserting the value this test just wrote would prove nothing.
  setTitle('Not found');
  ensureGhostCards({ notFound: true });
  addItems([{ type: 'note', w: 200, h: 200 }]);
  leaveNotFoundBoard();
  assert.equal(isNotFoundBoard(), false, 'the latch is what state owns here');

  const main = readFileSync(join(JS, 'main.ts'), 'utf8');
  const handover = /async function leaveNotFound\(\)[\s\S]*?\n}/.exec(main);
  assert.ok(handover, 'leaveNotFound() has moved or been renamed in main.ts');
  const branch = /\n  } else \{([\s\S]*?)\n  }/.exec(handover[0]);
  assert.ok(branch, 'leaveNotFound() no longer has the "nothing to go back to" branch');
  assert.match(branch[1], /setTitle\(defaultBoardTitle\(\)\)/,
    'the branch where no stored board arrives must put the name back, or '
    + "'Not found' is what Export writes");
});
