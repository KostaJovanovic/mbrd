// The boot window, and the three things that go wrong inside it: the stored
// board not yet read back, an address that may not be a board's, and the
// writer deliberately off. Separate from errors.test.js, which is about after
// something has already failed.
//
// No DOM - page.ts reads two globals lazily, so a plain object for each is
// the whole setup, in place before import since homePath() memoises on first ask.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

globalThis.document = { baseURI: 'https://mbrd.pages.dev/' };
globalThis.location = { pathname: '/' };

const { isPatchPage, isNotFoundPage } = await import('../web/assets/js/page.ts');
const { boardSafety, initSession, restoreSession } =
  await import('../web/assets/js/storage/session.ts');

const at = path => { globalThis.location.pathname = path; };

// ---------------------------------------------------------------------------
// Which page this is
// ---------------------------------------------------------------------------

test('the changelog is the changelog however the host spells it', () => {
  // The trailing slash was missing, and it's not tidiness: a host redirecting
  // /patch to /patch/ fell through to isNotFoundPage(), whose not-found arm
  // suspends the writer but doesn't freeze preferences - so a reader's whimsy
  // nudges while reading the changelog followed them home to their own board.
  for (const path of ['/patch', '/patch/', '/patch.html']) {
    at(path);
    assert.equal(isPatchPage(), true, path);
    assert.equal(isNotFoundPage(), false, path);
  }
});

test('a dead address is still a dead address', () => {
  for (const path of ['/nope', '/patched', '/patch/notes', '/board/1']) {
    at(path);
    assert.equal(isPatchPage(), false, path);
    assert.equal(isNotFoundPage(), true, path);
  }
  for (const path of ['/', '/index.html']) {
    at(path);
    assert.equal(isNotFoundPage(), false, path);
  }
});

// ---------------------------------------------------------------------------
// What the app says about a board it has not read yet
// ---------------------------------------------------------------------------

const DEPS = {
  fileName: () => null,
  created: () => null,
  setCreated: () => {},
  exportBoard: async () => true,
  prompt: async () => null,
};

test('a board that has not been read back yet is not called saved', () => {
  // The ladder is documented as falling towards 'unknown', not reassurance -
  // this rung fell the other way: at boot nothing is dirty, so the clean-board
  // rung answered 'saved' about a store nobody had opened yet.
  initSession(DEPS);
  const during = boardSafety();
  assert.equal(during.state, 'unknown');
  assert.match(during.detail, /still being read back/);
});

test('once the store has been looked in, the ladder answers again', async () => {
  initSession(DEPS);
  // No IndexedDB here, so this is the failing shape of the same call: it
  // throws, catches, reports no board. The point is it went and looked - the
  // latch is set on every way out, not only the one that finds something.
  const real = console.warn;
  console.warn = () => {};
  try {
    assert.equal(await restoreSession(), false);
  } finally {
    console.warn = real;
  }
  assert.notEqual(boardSafety().state, 'unknown');
});

// ---------------------------------------------------------------------------
// The connection under all of it
// ---------------------------------------------------------------------------

test('a force-closed database is noticed and reconnected once', () => {
  // Read off the source since node has no IndexedDB. The shape is the fix: a
  // `close` handler as well as `versionchange` so an evicted connection stops
  // being cached, and exactly one retry in tx() so the first save after an
  // eviction reconnects instead of latching cacheOk = false forever.
  const src = readFileSync('web/assets/js/storage/idb.ts', 'utf8');
  assert.match(src, /db\.onclose = forget;/);
  assert.match(src, /InvalidStateError/);
  // One retry, not a loop - `once` named twice in tx() and nowhere else.
  const body = src.slice(src.indexOf('function tx<F extends Issued>'));
  assert.equal((body.match(/\bonce\(store, mode, fn\)/g) || []).length, 2);
});
