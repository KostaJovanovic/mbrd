import { test } from 'node:test';
import assert from 'node:assert/strict';

import { exitKindFor } from '../web/assets/js/canvas/exit-anim.ts';

test('the title card always drops a chip, whatever the whimsy tier', () => {
  for (const w of [0, 1, 2, undefined, '9']) {
    assert.equal(exitKindFor('title', w), 'chip');
  }
});

test('the whimsy tier picks the feel for an ordinary card', () => {
  assert.equal(exitKindFor('note', 0), 'fall');       // Softish
  assert.equal(exitKindFor('note', 2), 'shatter');    // Harsh
  assert.equal(exitKindFor('note', 1), 'dissolve');   // Middle
});

test('an unset or unknown tier falls back to a plain dissolve', () => {
  assert.equal(exitKindFor('image', undefined), 'dissolve');
  assert.equal(exitKindFor('image', null), 'dissolve');
  assert.equal(exitKindFor('image', 5), 'dissolve');
});
