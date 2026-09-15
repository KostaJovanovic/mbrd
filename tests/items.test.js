// The accessible names cards carry (AUD-09). Cards used to be bare
// <div class="item"> with no name, and every menu button was called only
// "Actions" - a board of indistinguishable controls. These are the pure naming
// helpers behind the fix; the DOM wiring and the full keyboard-selection model
// are exercised in the browser smoke suite.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { farKind, itemAccessibleName, wantsHead } from '../web/assets/js/canvas/items.ts';
import { noteNameOf, shownName } from '../web/assets/js/board-model.ts';

test('a named item announces its own name', () => {
  assert.equal(itemAccessibleName({ name: 'Sunset.jpg', type: 'image' }), 'Sunset.jpg');
});

test('an unnamed item falls back to a human type word, not "generic"', () => {
  assert.equal(itemAccessibleName({ type: 'image' }), 'Untitled picture');
  assert.equal(itemAccessibleName({ type: 'note' }), 'Untitled note');
  assert.equal(itemAccessibleName({ type: 'model' }), 'Untitled model');
  assert.equal(itemAccessibleName({ type: 'generic' }), 'Untitled item');
  assert.equal(itemAccessibleName({}), 'Untitled item');
});

test('a whitespace-only name falls back rather than announcing blank', () => {
  assert.equal(itemAccessibleName({ name: '   ', type: 'audio' }), 'Untitled audio clip');
});

// ---------------------------------------------------------------------------
// The index rung
//
// Between 40% and 10% a card stops drawing its body and draws what it is and
// is called instead. wantsHead() decides which cards get that head, farKind()
// the word above the rule. The split is one question - is there anything to
// look at? A picture keeps the picture and takes no label; a type moving
// across this line is a change to the far view, not a tidy-up.
// ---------------------------------------------------------------------------

test('a card with nothing to look at says what it is', () => {
  for (const type of ['note', 'text', 'link', 'model', 'embed', 'generic', 'audio']) {
    assert.equal(wantsHead({ type, meta: {} }), true, `${type} should carry one`);
  }
});

test('a card that is a picture is left to be one', () => {
  // Image and video are pictures outright; a swatch's printed hex is its
  // only name.
  for (const type of ['image', 'video', 'swatch']) {
    assert.equal(wantsHead({ type, meta: {} }), false, `${type} should not`);
  }
});

test('album art is the stylesheet\'s business, not this list\'s', () => {
  // An audio card only finds out whether it has art when it loads, so the
  // head is always built and hidden over a sleeve by :has(.card-cover) in
  // items.css - deciding here would mean rebuilding the card on arrival.
  assert.equal(wantsHead({ type: 'audio', meta: { cover: 'abc' } }), true);
  assert.equal(wantsHead({ type: 'generic', meta: { cover: 'abc' } }), true);
});

test('the three that already have a label of their own are left alone', () => {
  // A fence's own plate already shows its name at the region's size; the
  // title card's name is already large; a hint talks to the person, not the
  // board, and is stripped on the way into a file.
  for (const type of ['fence', 'title', 'ghost']) {
    assert.equal(wantsHead({ type, meta: {} }), false, `${type} should not`);
  }
});

test('an item with no meta at all is still answerable', () => {
  assert.equal(wantsHead({ type: 'note' }), true);
  assert.equal(wantsHead({ type: 'fence' }), false);
});

test('the kind is the extension, because that is the informative part', () => {
  // PDF, OBJ and WAV say something "file" and "model" cannot - the card's
  // own kicker, see cardShell in canvas/renderers.ts.
  assert.equal(farKind({ type: 'generic', name: 'report.pdf', meta: {} }), 'pdf');
  assert.equal(farKind({ type: 'model', name: 'bracket.obj', meta: {} }), 'obj');
  // meta.ext wins where the importer recorded one: a renamed file still is
  // what it was.
  assert.equal(farKind({ type: 'audio', name: 'take 3', meta: { ext: 'flac' } }), 'flac');
  assert.equal(farKind({ type: 'audio', name: 'take 3', meta: { ext: '.flac' } }), 'flac');
});

test('the type word is the fallback for the things that were never files', () => {
  assert.equal(farKind({ type: 'link', name: 'Anthropic', meta: {} }), 'link');
  assert.equal(farKind({ type: 'text', name: 'pasted', meta: {} }), 'text');
  assert.equal(farKind({ type: 'generic', name: 'no extension here', meta: {} }), 'file');
  assert.equal(farKind({ type: 'generic' }), 'file');
});

test('a note prints no kind at all', () => {
  // A sticky is not a specimen - a note's name is its first line, a
  // sentence a classification would sit on top of.
  assert.equal(farKind({ type: 'note', name: 'Ring Marta about the scaffolding', meta: {} }), '');
});

test('a note is named for its words, not its heading mark', () => {
  // meta.text marks a heading line "# " or "## " (canvas/note-model.ts). The
  // name came off that line whole, so Find, the Timeline and the far view all
  // printed "# Note A".
  assert.equal(noteNameOf('# Note A\nbody'), 'Note A');
  assert.equal(noteNameOf('## Smaller\n'), 'Smaller');
  assert.equal(noteNameOf('Plain first line'), 'Plain first line');
  assert.equal(noteNameOf('# '), 'Note', 'a heading with no words falls back');
  assert.equal(noteNameOf('#hashtag stays'), '#hashtag stays', 'only the mark and its space');
  // A name taken by an older build still carries it, and comes off on screen.
  assert.equal(shownName({ type: 'note', name: '# Note A' }), 'Note A');
  assert.equal(itemAccessibleName({ type: 'note', name: '# Note A' }), 'Note A');
  // Anything else keeps its name as it is.
  assert.equal(shownName({ type: 'text', name: '# README.md' }), '# README.md');
});
