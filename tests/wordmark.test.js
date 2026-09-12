// Which occurrences of the app's name get set in the app's face. The name
// is five ordinary letters - also a file extension, a console handle, and
// half a domain - so a rule catching every "mbrd" catches ".mbrd" too,
// putting the mark where it means nothing. None of that fails loudly: a
// missed or spurious mark just looks like an odd sentence. So the
// deciding half of ui/wordmark.ts is a pure function, and this is what
// holds it; the DocumentFragment half is left to the browser.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { segments } from '../web/assets/js/ui/wordmark.ts';

/** The marked runs, which is what every test below is really asking about. */
const marks = s => segments(s).filter(x => x.mark).map(x => x.text);

test('nothing is lost or invented - the runs rebuild the input exactly', () => {
  // The property everything else rests on: a splitter that dropped a
  // character would leave a hole in a sentence nobody re-reads.
  for (const s of ['', 'mbrd', 'Reload mbrd', 'a .mbrd file', 'mbrd. mbrd. mbrd.',
    'no name here at all', 'mbrdx and lumbrd', '.mbrd', 'mbrd.cmds']) {
    assert.equal(segments(s).map(x => x.text).join(''), s, `rebuilding ${JSON.stringify(s)}`);
  }
});

test('the name on its own is marked', () => {
  assert.deepEqual(marks('Reload mbrd'), ['mbrd']);
  assert.deepEqual(marks('mbrd'), ['mbrd']);
});

test('the full stop is part of the mark when it is there', () => {
  // The sidebar and the splash both read "mbrd." - the stop belongs to
  // the mark, not the sentence.
  assert.deepEqual(marks('mbrd.'), ['mbrd.']);
  assert.deepEqual(marks('This is mbrd.'), ['mbrd.']);
});

test('a file extension is left alone', () => {
  // Costs the most to get wrong: ".mbrd" appears in dialogs about opening
  // and merging files, exactly where a wordmark looks most out of place.
  assert.deepEqual(marks('a .mbrd file'), []);
  assert.deepEqual(marks('.mbrd'), []);
  assert.deepEqual(marks('Drop a .mbrd onto the board'), []);
});

test('a longer word containing the letters is not the name', () => {
  assert.deepEqual(marks('mbrdx'), []);
  assert.deepEqual(marks('lumbrd'), []);
  assert.deepEqual(marks('umbrdella'), []);
});

test('every occurrence in a sentence is marked, not just the first', () => {
  assert.deepEqual(marks('mbrd and mbrd and mbrd'), ['mbrd', 'mbrd', 'mbrd']);
});

test('the name mixed with an extension in one sentence splits correctly', () => {
  // Catches an exclusion written as "skip the whole string if it
  // contains a dot" rather than a per-occurrence test.
  assert.deepEqual(marks('mbrd opens a .mbrd file'), ['mbrd']);
});

test('the prose around it survives as prose', () => {
  const segs = segments('Reload mbrd now');
  assert.deepEqual(segs, [
    { text: 'Reload ', mark: false },
    { text: 'mbrd', mark: true },
    { text: ' now', mark: false },
  ]);
});

test('a string with no name in it is one plain run', () => {
  // The common case by far: almost no dialog or button label says the
  // name, and it must come out as the single text node textContent would
  // have made.
  assert.deepEqual(segments('Cancel'), [{ text: 'Cancel', mark: false }]);
  assert.deepEqual(segments(''), []);
});
