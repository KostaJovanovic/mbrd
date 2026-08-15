// The boot window, and the three things that go wrong inside it.
//
// A new file rather than an addition to errors.test.js, which is about what the
// app says once something has already failed. This is about the seconds before
// anything has happened at all: the stored board has not been read back, the
// address may not be a board's, and the writer is deliberately off. Every claim
// the app makes in that window is a claim about state nobody has looked at yet,
// which is why they were the ones that were wrong.
//
// No DOM. page.ts reads two globals and reads them lazily - that is its own
// stated rule (tests/imports.test.js) - so a plain object for each is the whole
// of the setup, and it has to be in place before the module is imported because
// homePath() memoises on the first ask.

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
  // The trailing slash is the one that was missing, and it is not tidiness. A
  // host that redirects /patch to /patch/ - or one link written with it - fell
  // through to isNotFoundPage(), and the not-found arm suspends the writer but
  // does not freeze preferences. Every whimsy nudge and palette pick a reader
  // made while reading the changelog was then written to their browser and
  // followed them home to their own board.
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
  // The ladder is documented as falling towards 'unknown' rather than towards
  // reassurance, and this rung fell the other way: at boot nothing is dirty
  // because nothing has happened, so the clean-board rung answered 'saved'
  // about a store nobody had opened. An error raised in that window is also the
  // likeliest reason it never will be opened, which is exactly when the
  // sentence matters.
  initSession(DEPS);
  const during = boardSafety();
  assert.equal(during.state, 'unknown');
  assert.match(during.detail, /still being read back/);
});

test('once the store has been looked in, the ladder answers again', async () => {
  initSession(DEPS);
  // There is no IndexedDB here, so this is the failing shape of the same call:
  // it throws inside, catches, and reports that no board came back. The point
  // is that it *went and looked* - the latch is set on every way out, not only
  // on the way that finds something.
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
  // Read off the source, because the behaviour needs an IndexedDB to have and
  // node has none. What is being held here is a shape, and the shape is the
  // whole fix: a `close` handler as well as `versionchange`, so an evicted
  // connection stops being cached, and exactly one retry in tx() so the first
  // save after an eviction reconnects instead of latching cacheOk = false for
  // the rest of the session.
  const src = readFileSync('web/assets/js/storage/idb.ts', 'utf8');
  assert.match(src, /db\.onclose = forget;/);
  assert.match(src, /InvalidStateError/);
  // One retry, not a loop: `once` is named twice in tx() and nowhere else.
  const body = src.slice(src.indexOf('function tx<F extends Issued>'));
  assert.equal((body.match(/\bonce\(store, mode, fn\)/g) || []).length, 2);
});
