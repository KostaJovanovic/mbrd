// What the Optimize dialog counts as work. It must count every bucket that
// runOptimize() encodes, or a board whose only work is in an uncounted bucket
// is told there is nothing to optimize and the run never starts.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { workCounts } from '../web/assets/js/optimize/ui.ts';

const plan = (over = {}) => ({
  pictures: [], sounds: [], clips: [], skipped: [], empty: [],
  done: 0, total: 0, posters: 0, ...over,
});
const job = { hash: 'h', size: 1, name: 'x', isCover: false, kind: 'video' };

test('clips the desktop can transcode count as work', () => {
  assert.deepEqual(workCounts(plan({ clips: [job, job] })), [[2, 'video']]);
});

test('an empty bucket is not listed', () => {
  assert.deepEqual(workCounts(plan()), []);
  assert.deepEqual(workCounts(plan({ pictures: [job] })), [[1, 'picture']]);
});
