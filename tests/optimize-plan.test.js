// What planOptimize() promises, held against what runOptimize() can deliver.
// The swap at the end of a run rewrites a card's file and its cover and
// nothing else, so a job for any other reference is work that is encoded,
// counted as saved, and never applied. The encoders need a browser; the plan
// does not, and the plan is where the promise is made.

import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

import { loadBoard, setBoardMode } from '../web/assets/js/state.ts';
import { putAsset, clearAssets } from '../web/assets/js/storage/assets.ts';
import { planOptimize, renameFor } from '../web/assets/js/optimize/optimize.ts';
import { PHOTO_EXTS, VIDEO_EXTS } from '../web/assets/js/import/formats.ts';
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

test('a picture that is one card file and another card cover is sized as the file', () => {
  // The audio card comes first on the board, so it used to reach the shared
  // hash first and plan it at the cover ceiling for both cards.
  loadBoard({
    title: 'T',
    items: [
      { id: 's', type: 'audio', w: 200, h: 60, asset: { hash: hash('song') }, meta: { cover: FILE } },
      photo({ id: 'a', asset: { hash: FILE } }),
    ],
  });
  const [job, ...rest] = planOptimize().pictures;
  assert.equal(rest.length, 0, 'one job for one set of bytes');
  assert.equal(job.hash, FILE);
  assert.equal(job.isCover, false);
});

test('every type an encoder can hand back is named with an extension the app reads', () => {
  // Safari answers a WebP request with JPEG or PNG, and the desktop transcode
  // writes MP4. A `.bin` name gives the new asset no type after a reopen.
  assert.equal(renameFor('holiday.png', 'image/webp'), 'holiday.webp');
  assert.equal(renameFor('holiday.heic', 'image/jpeg'), 'holiday.jpg');
  assert.equal(renameFor('logo.tiff', 'image/png'), 'logo.png');
  assert.equal(renameFor('song.flac', 'audio/ogg'), 'song.opus');
  assert.equal(renameFor('clip.mov', 'video/mp4'), 'clip.mp4');
  for (const ext of ['jpg', 'png', 'webp']) assert.ok(PHOTO_EXTS.has(ext), ext);
  assert.ok(VIDEO_EXTS.has('mp4'));
});

test('a cover that no card holds as its file is still sized as a cover', () => {
  loadBoard({
    title: 'T',
    items: [{ id: 's', type: 'audio', w: 200, h: 60, asset: { hash: hash('song') }, meta: { cover: COVER } }],
  });
  const [job] = planOptimize().pictures;
  assert.equal(job.hash, COVER);
  assert.equal(job.isCover, true);
});
