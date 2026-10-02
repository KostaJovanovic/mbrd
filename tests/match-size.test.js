// matchSizeTargets(): Same width / Same height from Align & distribute. The
// card the menu was opened on is the measure, each other card keeps its
// top-left corner, and a picture keeps its proportion.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { matchSizeTargets } from '../web/assets/js/geometry.ts';

const box = (id, x, y, w, h) => ({ id, x, y, w, h });

test('the others take the reference width and keep their top-left corner', () => {
  const ref = box('r', 0, 0, 300, 200);
  const a = box('a', 500, 0, 100, 100);
  const [t] = matchSizeTargets([ref, a], 'r', 'w');
  assert.equal(t.id, 'a');
  assert.equal(t.w, 300);
  assert.equal(t.h, 100, 'a card that is not a picture changes in one dimension');
  assert.equal(t.x - t.w / 2, a.x - a.w / 2, 'left edge held');
  assert.equal(t.y + t.h / 2, a.y + a.h / 2, 'top edge held (world y points up)');
});

test('a picture keeps its proportion', () => {
  const ref = box('r', 0, 0, 300, 400);
  const p = box('p', 500, 0, 200, 100);
  const [t] = matchSizeTargets([ref, p], 'r', 'h', () => true);
  assert.equal(t.h, 400);
  assert.equal(t.w, 800);
});

test('the reference is not moved, and an unknown reference changes nothing', () => {
  const ref = box('r', 0, 0, 300, 200);
  assert.equal(matchSizeTargets([ref], 'r', 'w').length, 0);
  assert.deepEqual(matchSizeTargets([ref], 'missing', 'w'), []);
});
