// The five-hundred-file cap, and who is supposed to mention it.
//
// filesFrom() stops walking at MAX_FILES, so its list is never longer than
// the cap - meaning importFiles()'s own overflow check could never fire for
// a drop, and a folder of a thousand photos reported "brought in everything"
// after cutting to five hundred. The cut is made here, so it's reported here.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { filesFrom, MAX_FILES } from '../web/assets/js/import/drop.ts';

/** A FileSystemFileEntry, as much of one as the walk actually asks about. */
const fileEntry = name => ({
  isFile: true,
  isDirectory: false,
  file: cb => cb({ name, size: 1, type: 'image/jpeg' }),
});

/** A directory entry whose reader hands back `count` files, in batches of 100. */
function dirEntry(count) {
  return {
    isFile: false,
    isDirectory: true,
    // A fresh reader starts from the top, as the real one does - which is
    // what lets "Take all of them" walk the same entry again.
    createReader: (served = 0) => ({
      readEntries(cb) {
        // The real API returns at most ~100 per call, empty at the end -
        // the loop condition walkEntry() drains on.
        const batch = Math.min(100, count - served);
        const out = Array.from({ length: batch }, (_, i) => fileEntry(`p${served + i}.jpg`));
        served += batch;
        cb(out);
      },
    }),
  };
}

const drop = entries => ({
  items: entries.map(entry => ({ webkitGetAsEntry: () => entry })),
  files: [],
});

/** A named directory entry holding exactly these children, in one batch. */
function folder(name, children) {
  return {
    name,
    isFile: false,
    isDirectory: true,
    createReader: () => {
      let served = false;
      return { readEntries(cb) { cb(served ? [] : children); served = true; } };
    },
  };
}

test('a dropped folder spreads its own files, and each folder in it is one card', async () => {
  const got = await filesFrom(drop([folder('trip', [
    fileEntry('a.jpg'),
    folder('raw', [fileEntry('b.jpg'), folder('x', [fileEntry('c.jpg')])]),
    folder('empty', []),
  ])]));
  assert.deepEqual(got.files.map(f => f.name), ['a.jpg']);
  // An empty folder lands as nothing, and paths are below the card's folder.
  assert.deepEqual(got.folders.map(f => [f.name, f.entries.map(e => e.path)]), [['raw', ['b.jpg', 'x/c.jpg']]]);
  assert.equal(got.fromFolder, true);
});

test('a folder walked past the cap says so', async () => {
  const got = await filesFrom(drop([dirEntry(MAX_FILES + 250)]));
  assert.equal(got.files.length, MAX_FILES, 'the cap is applied');
  assert.equal(got.fromFolder, true);
  assert.equal(got.truncated, true, 'and the caller is told, rather than left to infer it');
});

test('a folder of exactly the cap is not reported as cut', async () => {
  // The walk used to stop *at* the cap and call that truncated, so five
  // hundred files asked about a limit nothing had crossed.
  const got = await filesFrom(drop([dirEntry(MAX_FILES)]));
  assert.equal(got.files.length, MAX_FILES);
  assert.equal(got.truncated, false);
  const over = await filesFrom(drop([dirEntry(MAX_FILES + 1)]));
  assert.equal(over.files.length, MAX_FILES, 'the file past the cap is seen, not read');
  assert.equal(over.truncated, true);
});

test('"Take all of them" walks the same drop again with no cap', async () => {
  const got = await filesFrom(drop([dirEntry(MAX_FILES + 250)]));
  assert.equal(got.files.length, MAX_FILES);
  const all = await got.all();
  assert.equal(all.files.length, MAX_FILES + 250);
  assert.equal(all.more, false);
});

test('a folder card past the cap is walked whole the second time too', async () => {
  const got = await filesFrom(drop([folder('trip', [dirEntry(0), folder('many', [
    ...Array.from({ length: MAX_FILES + 10 }, (_, i) => fileEntry(`m${i}.jpg`)),
  ])])]));
  assert.equal(got.truncated, true);
  assert.equal(got.folders[0].entries.length, MAX_FILES);
  const all = await got.all();
  assert.equal(all.folders[0].entries.length, MAX_FILES + 10);
});

test('a folder that fits reports nothing cut', async () => {
  const got = await filesFrom(drop([dirEntry(12)]));
  assert.equal(got.files.length, 12);
  assert.equal(got.truncated, false);
});

test('loose files dropped without a folder are not a walk', async () => {
  const got = await filesFrom(drop([fileEntry('a.jpg'), fileEntry('b.jpg')]));
  assert.equal(got.files.length, 2);
  assert.equal(got.fromFolder, false);
  assert.equal(got.truncated, false);
});

test('a browser with no entries API falls back to the flat list', async () => {
  // Reported as untruncated correctly: nothing was walked, so nothing was
  // cut here - importFiles() applies its own cap.
  const got = await filesFrom({
    items: [],
    files: [{ name: 'a.jpg', size: 1, type: 'image/jpeg' }],
  });
  assert.equal(got.files.length, 1);
  assert.equal(got.truncated, false);
});
