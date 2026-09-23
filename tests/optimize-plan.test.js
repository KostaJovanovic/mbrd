// What planOptimize() promises, held against what runOptimize() can deliver.
// The swap at the end of a run rewrites a card's file and its cover and
// nothing else, so a job for any other reference is work that is encoded,
// counted as saved, and never applied. The encoders need a browser; the plan
// does not, and the plan is where the promise is made.

import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

import { loadBoard, setBoardMode } from '../web/assets/js/state.ts';
import { putAsset, clearAssets } from '../web/assets/js/storage/assets.ts';
import { planOptimize } from '../web/assets/js/optimize/optimize.ts';
import { hash } from './helpers.js';
import { photo, clip } from './state-fixtures.js';

const FILE = hash('file');
const COVER = hash('cover');
const DERIVED = ['display', 'preview', 'shot', 'art', 'poster', 'folder'].map(hash);

const png = (h, name, bytes = 4096) =>
  putAsset(h, new Blob([new Uint8Array(bytes)], { type: 'image/png' }), { name, ext: 'png', mime: 'image/png' });

beforeEach(() => {
  setBoardMode('desktop');
  clearAssets();
  png(FILE, 'file.png');
  png(COVER, 'cover.png');
  for (const h of DERIVED) png(h, 'derived.png');
  loadBoard({ title: 'T', items: [] });
});

test('only the file and the cover are planned, because only they are swapped', () => {
  const [display, preview, shot, art, poster, folder] = DERIVED;
  loadBoard({
    title: 'T',
    items: [
      photo({ id: 'a', asset: { hash: FILE }, meta: { display, preview, art, files: [{ hash: folder }] } }),
      clip({ id: 'v', asset: { hash: hash('clip') }, meta: { cover: COVER, shot, poster } }),
    ],
  });
  const plan = planOptimize();
  assert.deepEqual(plan.pictures.map(j => j.hash).sort(), [COVER, FILE].sort());
  assert.equal(plan.total, 8192, 'the dialog weighs only what the run can rewrite');
});
