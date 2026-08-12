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
  // The one place in the app that guesses at a scheme. linkURL() refuses this
  // everywhere else and is right to - a pasted `example.com/things` is as
  // likely to be a sentence - but here the user pressed Add a link and typed
  // into a box showing https://example.com. See linkTyped().
  assert.equal(linkTyped('example.com')?.href, 'https://example.com/');
  assert.equal(linkTyped('www.example.com/things')?.href, 'https://www.example.com/things');
});

test('a scheme this cannot open is refused rather than rewritten', () => {
  // Already carrying a scheme, so the guess never runs: whatever it is, the
  // user said it, and prefixing https:// onto ftp://… would produce an address
  // nobody typed. mailto and javascript are the two that matter - a link card
  // becomes an iframe or an anchor per click, and neither should be able to.
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
// mbrd's only mode, so its four cases are asserted rather than described. Each
// of these is a sentence somebody has to be able to check against the app.
// ---------------------------------------------------------------------------

test('the first press picks an end and joins nothing', () => {
  assert.deepEqual(connectStep(null, 'a'), { pick: 'a', connect: null });
});

test('the second press on another card joins the pair and clears the pick', () => {
  assert.deepEqual(connectStep('a', 'b'), { pick: null, connect: ['a', 'b'] });
});

test('pressing the card you just picked is how you change your mind', () => {
  // Not a connection from a card to itself, which is a dot, and not a no-op
  // either - the pick has to be droppable without reaching for Escape.
  assert.deepEqual(connectStep('a', 'a'), { pick: null, connect: null });
});

test('empty canvas drops the pick and joins nothing', () => {
  assert.deepEqual(connectStep('a', null), { pick: null, connect: null });
  assert.deepEqual(connectStep(null, null), { pick: null, connect: null });
});

test('nothing in the step ever disarms', () => {
  // The property the whole mode hangs on: staying armed after a pair is what
  // makes joining five things one trip to the toolbar rather than five. So
  // there is no case here that says stop - the button and Escape are the two
  // ways out, and both of them are things somebody did on purpose.
  for (const [from, id] of [[null, 'a'], ['a', 'b'], ['a', 'a'], ['a', null], [null, null]]) {
    const out = connectStep(from, id);
    assert.deepEqual(Object.keys(out).sort(), ['connect', 'pick'],
      'the step reports a pick and a pair, and has no way to say "disarm"');
  }
});
