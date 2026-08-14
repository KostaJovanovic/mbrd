// The board at an address the app does not have, and the two destructive paths
// that must not touch it.
//
// A not-found boot deliberately never reads the session slot: the visitor's own
// board is not loaded, not shown, and - this is the part with teeth - not
// *asked about*. So New and Clear everything are both aiming at a board that is
// not on screen. New asked nothing at all, wiped the slot, and then re-armed the
// writer so the blank replacement autosaved over the hole. That is a stranger's
// wrong URL costing somebody their board, so it is refused here rather than
// confirmed harder.
//
// The guard matters more since New stopped asking about unsaved work entirely
// and started filing the outgoing board on the library shelf instead. On this
// board that would file the blank not-found message under the visitor's own
// board id - overwriting on the shelf what it used to only overwrite in the
// session slot.
//
// Driven through a fake IndexedDB whose only job is to say whether a wipe was
// reached. state.js is a module singleton, so each case sets the latch it needs.

import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

const soon = fn => Promise.resolve().then(fn);

/** Bumped by every clear() the app issues, which is the thing under test. */
let clears = 0;

globalThis.indexedDB = {
  open() {
    const req = {};
    soon(() => {
      // `clear` is the thing under test; the rest are stubs so that the code
      // path *reaching* it can run. New files the outgoing board onto the
      // library shelf before it wipes anything, and refuses outright if that
      // write fails - which is the point of the change and is correct, but it
      // means a store with only clear() on it now makes New decline before it
      // gets anywhere near the wipe. These four say "the write worked" and
      // nothing more; none of them records anything, because nothing here
      // asserts on what was written.
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
  loadBoard, ensureGhostCards, isNotFoundBoard, leaveNotFoundBoard, board,
  setTitle, defaultBoardTitle, addItems,
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
  // The dialog offers "Export first" over the board on screen, which on this
  // board is a message. Refusing before the question is asked is the difference
  // between a wrong answer and no question.
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
  // What leaveNotFound() in main.js does in the `else` of `if (had)`. The name
  // is set at boot so the title card and the Mobile masthead say what happened;
  // on the branch where no stored board arrives, nothing else overwrites it, and
  // 'Not found' would go on to be the board's name in the file Export writes.
  setTitle('Not found');
  ensureGhostCards({ notFound: true });
  addItems([{ type: 'note', w: 200, h: 200 }]);
  leaveNotFoundBoard();
  setTitle(defaultBoardTitle());
  assert.equal(board.title, defaultBoardTitle());
  assert.notEqual(board.title, 'Not found');
});
