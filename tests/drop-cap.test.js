// The five-hundred-file cap, and who is supposed to mention it.
//
// filesFrom() stops walking *at* MAX_FILES, so the list it returns is never
// longer than the cap - which meant importFiles()'s `files.length > MAX_FILES`
// could not fire for a drop, and a folder of a thousand photographs brought in
// five hundred while the receipt said it had brought in everything. The cut is
// made here, so it is reported from here.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { filesFrom, MAX_FILES } from '../web/assets/js/import/drop.js';

/** A FileSystemFileEntry, as much of one as the walk actually asks about. */
const fileEntry = name => ({
  isFile: true,
  isDirectory: false,
  file: cb => cb({ name, size: 1, type: 'image/jpeg' }),
});

/** A directory entry whose reader hands back `count` files, in batches of 100. */
function dirEntry(count) {
  let served = 0;
  return {
    isFile: false,
    isDirectory: true,
    createReader: () => ({
      readEntries(cb) {
        // The real API returns at most ~100 per call and an empty array at the
        // end, which is the loop condition walkEntry() drains on.
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

test('a folder walked past the cap says so', async () => {
  const got = await filesFrom(drop([dirEntry(MAX_FILES + 250)]));
  assert.equal(got.files.length, MAX_FILES, 'the cap is applied');
  assert.equal(got.fromFolder, true);
  assert.equal(got.truncated, true, 'and the caller is told, rather than left to infer it');
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
  // Reported as untruncated, and that is right rather than a shortcut: nothing
  // was walked, so nothing was cut here. Whatever the platform handed over is
  // the whole of what it was asked for, and importFiles() applies its own cap.
  const got = await filesFrom({
    items: [],
    files: [{ name: 'a.jpg', size: 1, type: 'image/jpeg' }],
  });
  assert.equal(got.files.length, 1);
  assert.equal(got.truncated, false);
});
