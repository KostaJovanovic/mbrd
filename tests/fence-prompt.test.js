// The offer that follows a rubber band, in the two parts of it that are decisions
// rather than DOM: what it says, and when it goes away.
//
// Both are exported for exactly this reason. The rest of ui/fence-prompt.js is a
// div and a button, which a unit test can only restate; the reach rule is where
// the feature can actually be wrong, because "far enough away" has a corner case
// on every edge of the box and a user would experience getting it wrong as the
// button vanishing while they were on their way to press it.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  fencePromptLabel, outOfReach, REACH,
} from '../web/assets/js/ui/fence-prompt.ts';

test('the offer counts what the band caught', () => {
  assert.equal(fencePromptLabel(5), 'Fence these 5');
  assert.equal(fencePromptLabel(2), 'Fence these 2');
});

test('one card is not "these 1"', () => {
  assert.equal(fencePromptLabel(1), 'Fence this one');
});

test('a band that caught nothing offers the region instead', () => {
  // Not a refusal: an empty fence is a fence you fill later, and the rectangle
  // is the only thing that could say how big it is.
  assert.equal(fencePromptLabel(0), 'Fence this area');
});

const BOX = { left: 100, top: 100, right: 200, bottom: 140 };

test('anywhere on the button itself is in reach', () => {
  assert.equal(outOfReach(BOX, 150, 120, REACH), false);
  assert.equal(outOfReach(BOX, 100, 100, REACH), false);
  assert.equal(outOfReach(BOX, 200, 140, REACH), false);
});

test('reach is measured from the edge the pointer is nearest', () => {
  // Level with the button and off to the side: the sideways distance is the
  // whole of it, so the last pixel in reach is REACH past the edge.
  assert.equal(outOfReach(BOX, 200 + REACH, 120, REACH), false);
  assert.equal(outOfReach(BOX, 200 + REACH + 1, 120, REACH), true);
  assert.equal(outOfReach(BOX, 100 - REACH - 1, 120, REACH), true);
  assert.equal(outOfReach(BOX, 150, 140 + REACH + 1, REACH), true);
});

test('going diagonally out of a corner spends both axes', () => {
  // Only the overshoot on each axis counts, so a pointer past a corner is judged
  // on the diagonal from that corner and not from the middle of the box.
  const d = REACH / Math.SQRT2;
  assert.equal(outOfReach(BOX, 200 + d - 1, 140 + d - 1, REACH), false);
  assert.equal(outOfReach(BOX, 200 + d + 1, 140 + d + 1, REACH), true);
});

test('the reach is roughly the couple of centimetres it claims to be', () => {
  // CSS fixes 96px to the inch whatever the display does, so this is arithmetic
  // rather than a guess about hardware - and it is here so that a later tweak to
  // the constant has to be a deliberate one.
  const cm = REACH / (96 / 2.54);
  assert.ok(cm > 2 && cm < 3, `${cm.toFixed(2)}cm is outside the 2-3cm this is meant to be`);
});
