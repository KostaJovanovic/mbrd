// The toolbar's own decisions.
//
// The bar itself is wiring - a data-cmd goes in, a command comes out - and
// there is nothing in that worth a test. What is here is the handful of places
// where the toolbar decides something rather than forwarding it, each of which
// is pure and has been lifted out of its module for exactly that reason.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { linkTyped } from '../web/assets/js/commands.ts';
import { connectStep } from '../web/assets/js/ui/toolbar.ts';

// ---------------------------------------------------------------------------
// Add a link
// ---------------------------------------------------------------------------

test('a typed address keeps whatever scheme it came with', () => {
  assert.equal(linkTyped('https://example.com/a?b=1')?.href, 'https://example.com/a?b=1');
  assert.equal(linkTyped('http://example.com/')?.href, 'http://example.com/');
});

test('a bare domain gets https, because there is no second reading of it', () => {
  // The one place in the app that guesses at a scheme. linkURL() refuses
  // this everywhere else, rightly - a pasted `example.com/things` could be
  // a sentence - but here the user typed into a box showing https://example.com.
  assert.equal(linkTyped('example.com')?.href, 'https://example.com/');
  assert.equal(linkTyped('www.example.com/things')?.href, 'https://www.example.com/things');
});

test('a scheme this cannot open is refused rather than rewritten', () => {
  // Already carries a scheme, so the guess never runs - prefixing https://
  // onto ftp://... would produce an address nobody typed. mailto and
  // javascript matter most: a link card becomes an iframe or an anchor per
  // click, and neither should be able to.
  for (const bad of ['ftp://example.com', 'mailto:a@b.c', 'javascript://example.com/']) {
    assert.equal(linkTyped(bad), null, `${bad} should not become a card`);
  }
});

test('text that is not an address at all is refused', () => {
  for (const bad of ['', '   ', 'have a look at this', 'https://', '://x']) {
    assert.equal(linkTyped(bad), null, `${JSON.stringify(bad)} should not become a card`);
  }
});

// ---------------------------------------------------------------------------
// The connector tool
//
// mbrd's only mode, so its five cases are asserted, not just described.
// Each is a sentence checkable against the app.
// ---------------------------------------------------------------------------

test('the first press picks an end and joins nothing', () => {
  assert.deepEqual(connectStep(null, 'a'),
    { pick: 'a', connect: null, refused: false, disarm: false });
});

test('the second press on another card joins the pair and clears the pick', () => {
  assert.deepEqual(connectStep('a', 'b'),
    { pick: null, connect: ['a', 'b'], refused: false, disarm: true });
});

test('pressing the card you just picked is how you change your mind', () => {
  // Not a self-connection (a dot) and not a no-op either - the pick must be
  // droppable without reaching for Escape.
  assert.deepEqual(connectStep('a', 'a'),
    { pick: null, connect: null, refused: false, disarm: false });
});

test('empty canvas drops the pick and joins nothing', () => {
  assert.deepEqual(connectStep('a', null),
    { pick: null, connect: null, refused: false, disarm: false });
  assert.deepEqual(connectStep(null, null),
    { pick: null, connect: null, refused: false, disarm: false });
});

test('a card no line can reach is refused, and costs nothing', () => {
  // The defect this exists for: the tap path took any two ids, the draw
  // path refuses stickers, and the pair went into the board undrawn.
  // Refusing is half the fix; the other half is that it must be *free* - a
  // sticker tapped by accident must leave the pick exactly where it was.
  assert.deepEqual(connectStep('a', 'sticker', false),
    { pick: 'a', connect: null, refused: true, disarm: false });
  assert.deepEqual(connectStep(null, 'sticker', false),
    { pick: null, connect: null, refused: true, disarm: false });
});

test('refusing is not the same as pressing empty canvas', () => {
  // Both leave no pair behind; the difference is the pick. Empty canvas is
  // a decision ("not that one"); a sticker is a slip of the hand.
  assert.equal(connectStep('a', null).pick, null);
  assert.equal(connectStep('a', 'sticker', false).pick, 'a');
});

test('an unjoinable end is refused before the same-card case', () => {
  // Order matters where the two overlap: tapping the picked card again
  // means "change my mind", but a sticker can never have been picked, so
  // there is no mind to change.
  assert.deepEqual(connectStep('s', 's', false),
    { pick: 's', connect: null, refused: true, disarm: false });
});

test('a finished pair is the only press that puts the tool down', () => {
  // The reverse of the rule it shipped with: a tester drew one line, kept
  // clicking, and could not tell why the board stopped selecting. Only the
  // press that completes the pair ends the mode - empty canvas is "not that
  // one", a refusal is a slip, neither is "I'm finished".
  assert.equal(connectStep('a', 'b').disarm, true);
  for (const [from, id, joinable] of
    [[null, 'a', true], ['a', 'a', true], ['a', null, true],
      [null, null, true], ['a', 'sticker', false], [null, 'sticker', false]]) {
    assert.equal(connectStep(from, id, joinable).disarm, false,
      `only a completed pair disarms - ${JSON.stringify([from, id])} must not`);
  }
});

test('Shift on the completing press keeps the tool armed', () => {
  // A modifier, not the default: drawing five lines holds a key, drawing
  // one does nothing.
  assert.deepEqual(connectStep('a', 'b', true, true),
    { pick: null, connect: ['a', 'b'], refused: false, disarm: false });
});

test('Shift changes nothing about a press that was not a pair', () => {
  // Read on every press since the caller cannot know which one completes a
  // pair. Everywhere else it must be inert, or holding Shift while picking
  // the first end would mean something nobody asked for.
  for (const [from, id, joinable] of
    [[null, 'a', true], ['a', 'a', true], ['a', null, true], ['a', 'sticker', false]]) {
    assert.deepEqual(connectStep(from, id, joinable, true), connectStep(from, id, joinable),
      `Shift is only about staying armed - ${JSON.stringify([from, id])} must not read it`);
  }
});
