// The accessible names cards carry (AUD-09). Cards used to be bare
// <div class="item"> with no name, and every menu button was called only
// "Actions" - a board of indistinguishable controls. These are the pure naming
// helpers behind the fix; the DOM wiring and the full keyboard-selection model
// are exercised in the browser smoke suite.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { farKind, itemAccessibleName, wantsHead } from '../web/assets/js/canvas/items.js';

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
// what it is called instead: the extension in accent caps, a hairline, and the
// name set large under it. wantsHead() is which cards get that head, and
// farKind() is the word above the rule.
//
// The list is the design, so the test is really about the split. It divides on
// one question - is there anything to look at? A card with a picture keeps the
// picture and takes no label at all, because a photograph is its own name at any
// size and a plate across the bottom of one is a caption on something that did
// not ask for it. A card without one has nothing to lose and everything to gain.
// A type moving across this line is a change to the far view, not a tidy-up.
// ---------------------------------------------------------------------------

test('a card with nothing to look at says what it is', () => {
  for (const type of ['note', 'text', 'link', 'model', 'embed', 'generic', 'audio']) {
    assert.equal(wantsHead({ type, meta: {} }), true, `${type} should carry one`);
  }
});

test('a card that is a picture is left to be one', () => {
  // Image and video are pictures outright; a swatch is a colour, and the hex
  // printed on it is the only name it has.
  for (const type of ['image', 'video', 'swatch']) {
    assert.equal(wantsHead({ type, meta: {} }), false, `${type} should not`);
  }
});

test('album art is the stylesheet\'s business, not this list\'s', () => {
  // An audio card can go either way and only finds out which when the artwork
  // loads, so the head is built for every one of them and hidden over a sleeve
  // by :has(.card-cover) in items.css. Deciding it here would mean rebuilding
  // the card when a cover arrives.
  assert.equal(wantsHead({ type: 'audio', meta: { cover: 'abc' } }), true);
  assert.equal(wantsHead({ type: 'generic', meta: { cover: 'abc' } }), true);
});

test('the three that already have a label of their own are left alone', () => {
  // A fence's own plate survives the rung by name, set at the region's size; the
  // title card is the board's name and is already large; a hint is talking to the
  // person rather than to the board, and is stripped on the way into a file.
  for (const type of ['fence', 'title', 'ghost']) {
    assert.equal(wantsHead({ type, meta: {} }), false, `${type} should not`);
  }
});

test('an item with no meta at all is still answerable', () => {
  assert.equal(wantsHead({ type: 'note' }), true);
  assert.equal(wantsHead({ type: 'fence' }), false);
});

test('the kind is the extension, because that is the informative part', () => {
  // PDF, OBJ and WAV each say something "file" and "model" cannot, and it is the
  // card's own kicker - see cardShell in canvas/renderers.js.
  assert.equal(farKind({ type: 'generic', name: 'report.pdf', meta: {} }), 'pdf');
  assert.equal(farKind({ type: 'model', name: 'bracket.obj', meta: {} }), 'obj');
  // meta.ext wins where the importer recorded one: a name can be edited to
  // anything and the file it came from stays what it was.
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
  // A sticky is not a specimen. NOTE over the top of one says nothing the colour
  // and the handwriting have not already said, and a note's name is its first
  // line - a sentence, which a classification would be sitting on top of.
  assert.equal(farKind({ type: 'note', name: 'Ring Marta about the scaffolding', meta: {} }), '');
});
