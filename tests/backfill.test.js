// The idle poster backfill, driven by mock timers. With no clip that wants a
// poster, each pass audits one existing cover for a blank frame and must arm
// the next pass, so every cover on the board is audited in turn. The decode
// needs a browser; a stubbed createImageBitmap counts the covers it reaches.

import { test, mock } from 'node:test';
import assert from 'node:assert/strict';

import { loadBoard, setBoardMode } from '../web/assets/js/state.ts';
import { putAsset, clearAssets } from '../web/assets/js/storage/assets.ts';
import { initBackfill } from '../web/assets/js/optimize/backfill.ts';
import { hash } from './helpers.js';
import { clip } from './state-fixtures.js';

test('the audit walks every cover, not only the first', async () => {
  const decoded = [];
  const saved = {
    document: globalThis.document,
    addEventListener: globalThis.addEventListener,
    createImageBitmap: globalThis.createImageBitmap,
  };
  globalThis.document = { visibilityState: 'visible' };
  globalThis.addEventListener = () => {};
  // pictureIsFlat() catches the throw and answers "not flat".
  globalThis.createImageBitmap = async blob => { decoded.push(blob); throw new Error('no decoder'); };
  mock.timers.enable({ apis: ['setTimeout'] });
  try {
    setBoardMode('desktop');
    clearAssets();
    const covers = ['c1', 'c2', 'c3'].map(hash);
    for (const h of covers) putAsset(h, new Blob([new Uint8Array(64)], { type: 'image/webp' }), { name: 'poster.webp' });
    loadBoard({
      title: 'T',
      items: covers.map((cover, i) => clip({ id: `v${i}`, asset: { hash: hash(`clip${i}`) }, meta: { cover } })),
    });
    initBackfill();
    // Each pass is a timer, an idle wait (a zero timer here) and some awaits.
    for (let i = 0; i < 20; i++) {
      mock.timers.tick(10_000);
      for (let j = 0; j < 10; j++) await Promise.resolve();
    }
    assert.equal(decoded.length, covers.length);
  } finally {
    mock.timers.reset();
    Object.assign(globalThis, saved);
  }
});
