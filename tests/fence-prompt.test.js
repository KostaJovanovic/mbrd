// The offer that follows a rubber band, in the two parts that are decisions
// rather than DOM: what it says, and when it goes away.
//
// Both exported for that reason - the rest of ui/fence-prompt.ts is a div
// and a button a unit test can only restate. The reach rule is where "far
// enough away" has a corner case on every edge, felt as the button
// vanishing mid-approach.

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
  // Not a refusal - an empty fence is one filled later, and the rectangle
  // is the only thing that says how big.
  assert.equal(fencePromptLabel(0), 'Fence this area');
});

const BOX = { left: 100, top: 100, right: 200, bottom: 140 };

test('anywhere on the button itself is in reach', () => {
  assert.equal(outOfReach(BOX, 150, 120, REACH), false);
  assert.equal(outOfReach(BOX, 100, 100, REACH), false);
  assert.equal(outOfReach(BOX, 200, 140, REACH), false);
});

test('reach is measured from the edge the pointer is nearest', () => {
  // Level with the button, off to the side - the last pixel in reach is
  // REACH past the edge.
  assert.equal(outOfReach(BOX, 200 + REACH, 120, REACH), false);
  assert.equal(outOfReach(BOX, 200 + REACH + 1, 120, REACH), true);
  assert.equal(outOfReach(BOX, 100 - REACH - 1, 120, REACH), true);
  assert.equal(outOfReach(BOX, 150, 140 + REACH + 1, REACH), true);
});

test('going diagonally out of a corner spends both axes', () => {
  // Only the overshoot per axis counts - a pointer past a corner is judged
  // on the diagonal from that corner, not the box's middle.
  const d = REACH / Math.SQRT2;
  assert.equal(outOfReach(BOX, 200 + d - 1, 140 + d - 1, REACH), false);
  assert.equal(outOfReach(BOX, 200 + d + 1, 140 + d + 1, REACH), true);
});

test('the reach is roughly the couple of centimetres it claims to be', () => {
  // CSS fixes 96px to the inch whatever the display does, so this is
  // arithmetic, not a hardware guess - a later tweak has to be deliberate.
  const cm = REACH / (96 / 2.54);
  assert.ok(cm > 2 && cm < 3, `${cm.toFixed(2)}cm is outside the 2-3cm this is meant to be`);
});
