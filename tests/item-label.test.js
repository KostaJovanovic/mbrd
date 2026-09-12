// trackTitle() and noteWords(): what an item is called, and what a note
// says. Four DOM surfaces (Feed, Playlist, bin, export) used to compute
// these separately and drifted - the same MP3 read "Audio" on one and
// "Untitled" on another. Tested here as pure functions instead.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { trackTitle } from '../web/assets/js/state.ts';
import { noteWords } from '../web/assets/js/canvas/note-model.ts';

// ---------------------------------------------------------------------------
// trackTitle
// ---------------------------------------------------------------------------

test('a track is called by its tag before its filename', () => {
  assert.equal(
    trackTitle({ type: 'audio', name: 'track01.mp3', meta: { trackTitle: 'Cirrus' } }),
    'Cirrus',
  );
});

test('an untagged track is its filename without the extension', () => {
  assert.equal(trackTitle({ type: 'audio', name: 'Ocean Floor.flac' }), 'Ocean Floor');
  assert.equal(trackTitle({ type: 'audio', name: 'no-extension' }), 'no-extension',
    'baseName leaves a name with no dot alone, and the || never fires');
  assert.equal(trackTitle({ type: 'audio', name: '.gitignore' }), '.gitignore',
    'a leading dot is not an extension - baseName returns "" and the name stands');
});

test('the placeholder is the surface\'s, not this function\'s', () => {
  // Returns '' rather than a word: a queue row and a tile caption aren't
  // obliged to say the same thing, so the fallback lives at the call site.
  assert.equal(trackTitle({ type: 'audio', name: '' }), '');
  assert.equal(trackTitle({ type: 'audio' }), '');
});

test('meta is open, so a tag that is not a string is a missing tag', () => {
  assert.equal(trackTitle({ name: 'b.mp3', meta: { trackTitle: 42 } }), 'b');
  assert.equal(trackTitle({ name: 'b.mp3', meta: { trackTitle: '' } }), 'b',
    'an empty tag falls through rather than winning');
  assert.equal(trackTitle({ name: 42 }), '', 'a name that is not a string is no name');
  assert.equal(trackTitle(null), '');
  assert.equal(trackTitle('a string is not an item'), '');
});

// ---------------------------------------------------------------------------
// noteWords
// ---------------------------------------------------------------------------

test('a note stored as rich blocks reads as its words, with no markers', () => {
  const meta = {
    rich: {
      blocks: [
        { tag: 'h1', align: 'left', text: 'Kitchen' },
        { tag: 'p', align: 'left', text: 'north wall' },
      ],
    },
  };
  assert.equal(noteWords(meta), 'Kitchen\nnorth wall');
});

test('the same note stored as flat Markdown reads identically', () => {
  // Whichever way a note is stored, this answers the same.
  assert.equal(noteWords({ text: '# Kitchen\nnorth wall' }), 'Kitchen\nnorth wall');
  assert.equal(noteWords({ text: '## Heading' }), 'Heading');
});

test('the storage markers never reach the reader', () => {
  // The bug this fixes: a `#` reaching the bin row or an exported PNG.
  assert.ok(!noteWords({ text: '# Kitchen' }).includes('#'));
  assert.ok(!noteWords({ rich: { blocks: [{ tag: 'h2', align: 'left', text: 'Sub' }] } })
    .includes('#'));
});

test('rich wins over text when both are there', () => {
  // meta.text is what meta.rich flattens to, so they normally agree - this
  // pins which one is the truth when they don't.
  const meta = {
    rich: { blocks: [{ tag: 'p', align: 'left', text: 'from the blocks' }] },
    text: 'from the flat copy',
  };
  assert.equal(noteWords(meta), 'from the blocks');
});

test('an empty rich model falls back rather than winning empty', () => {
  assert.equal(noteWords({ rich: { blocks: [] }, text: 'still here' }), 'still here');
  assert.equal(noteWords({ rich: 'not an object', text: 'still here' }), 'still here');
});

test('a note with nothing in it says nothing', () => {
  assert.equal(noteWords({}), '');
  assert.equal(noteWords({ text: '' }), '');
  assert.equal(noteWords({ text: 42 }), '');
  assert.equal(noteWords(null), '');
  assert.equal(noteWords(undefined), '');
});
