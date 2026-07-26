import { test } from 'node:test';
import assert from 'node:assert/strict';

import { isDoubleTap } from '../web/assets/js/canvas/input.js';

test('double taps match within the touch timing and distance windows', () => {
  const first = { x: 100, y: 200, at: 1_000 };

  assert.equal(isDoubleTap(first, { x: 120, y: 210, at: 1_320 }), true);
  assert.equal(isDoubleTap(first, { x: 100, y: 200, at: 1_351 }), false);
  assert.equal(isDoubleTap(first, { x: 129, y: 200, at: 1_200 }), false);
});

test('double taps reject missing or backwards samples', () => {
  assert.equal(isDoubleTap(null, { x: 0, y: 0, at: 1 }), false);
  assert.equal(isDoubleTap({ x: 0, y: 0, at: 2 }, { x: 0, y: 0, at: 1 }), false);
});
