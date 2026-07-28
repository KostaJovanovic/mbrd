// The accessible names cards carry (AUD-09). Cards used to be bare
// <div class="item"> with no name, and every menu button was called only
// "Actions" - a board of indistinguishable controls. These are the pure naming
// helpers behind the fix; the DOM wiring and the full keyboard-selection model
// are exercised in the browser smoke suite.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { itemAccessibleName } from '../web/assets/js/canvas/items.js';

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
