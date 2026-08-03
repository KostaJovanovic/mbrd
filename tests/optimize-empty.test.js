// Files with no bytes in them, and what the optimiser does about them.
//
// The one thing that feature does which is a removal rather than a re-encode,
// so it is the one that has to be checked hardest. An empty file cannot be made
// smaller and can never draw anything: what it leaves on a board is a card
// claiming to be a photograph with a permanent hole where the picture goes.
//
// Two properties matter and both are asserted here. The card survives - its
// name, its place, its size are all things a person chose and none of them are
// the file - and the whole run is still one undo, which is the promise the
// optimiser makes about everything else it does.

import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

import {
  board, byId, loadBoard, undo, setBoardMode, swapAssets,
} from '../web/assets/js/state.js';
import { putAsset, clearAssets } from '../web/assets/js/storage/assets.js';
import { planOptimize } from '../web/assets/js/optimize/optimize.js';
import { hash } from './helpers.js';
import { photo } from './state-fixtures.js';

const EMPTY = hash('empty');
const REAL = hash('real');
const COVER = hash('cover');

beforeEach(() => {
  setBoardMode('desktop');
  clearAssets();
  // Zero bytes, which is the whole point, against something with weight.
  putAsset(EMPTY, new Blob([], { type: 'image/png' }), { name: 'broken.png', ext: 'png', mime: 'image/png' });
  putAsset(REAL, new Blob([new Uint8Array(4096)], { type: 'image/png' }), { name: 'real.png', ext: 'png', mime: 'image/png' });
  putAsset(COVER, new Blob([], { type: 'image/jpeg' }), { name: 'art.jpg', ext: 'jpg', mime: 'image/jpeg' });
  loadBoard({ title: 'T', items: [] });
});

// ---------------------------------------------------------------------------
// Seeing them
// ---------------------------------------------------------------------------

test('an empty file is planned as a removal, not as something to shrink', () => {
  loadBoard({
    title: 'T',
    items: [photo({ id: 'a', name: 'broken', asset: { hash: EMPTY, embedded: true } })],
  });
  const plan = planOptimize();
  assert.equal(plan.empty.length, 1);
  assert.equal(plan.empty[0].id, 'a');
  assert.equal(plan.empty[0].asset, true);
  // And it is nowhere near the encoders. An encoder handed nothing would fail,
  // and a dialog promising to shrink a zero-byte file promises the impossible.
  assert.equal(plan.pictures.length, 0);
  assert.equal(plan.sounds.length, 0);
  assert.equal(plan.total, 0, 'it contributes no weight to shrink');
});

test('every empty file is found, not just the first', () => {
  // The reason this is bucketed per item rather than per hash, unlike
  // everything else in the plan: every empty file in existence has the same
  // digest, so a board with four of them has one hash on four cards. Dedup by
  // hash would clean exactly one and silently leave the rest.
  loadBoard({
    title: 'T',
    items: ['a', 'b', 'c', 'd'].map(id =>
      photo({ id, asset: { hash: EMPTY, embedded: true } })),
  });
  assert.equal(planOptimize().empty.length, 4);
});

test('an empty cover is found on a card whose own file is fine', () => {
  loadBoard({
    title: 'T',
    items: [photo({ id: 'a', asset: { hash: REAL, embedded: true }, meta: { cover: COVER } })],
  });
  const plan = planOptimize();
  assert.equal(plan.empty.length, 1);
  assert.equal(plan.empty[0].cover, true);
  assert.equal(plan.empty[0].asset, false, 'its own file has bytes and is left to the encoders');
});

test('a board of real files plans no removals', () => {
  loadBoard({
    title: 'T',
    items: [photo({ id: 'a', asset: { hash: REAL, embedded: true } })],
  });
  assert.deepEqual(planOptimize().empty, []);
});

// ---------------------------------------------------------------------------
// Taking them away
// ---------------------------------------------------------------------------

test('the card keeps everything a person chose, and stops claiming to hold a file', () => {
  loadBoard({
    title: 'T',
    items: [photo({
      id: 'a', name: 'A good name', x: 40, y: -60, w: 300, h: 200,
      asset: { hash: EMPTY, embedded: true },
    })],
  });
  // The optimiser's own door - null is the third thing a swap can say.
  swapAssets([{ id: 'a', asset: null }]);

  const it = byId('a');
  assert.equal(it.asset, null, 'the reference is gone');
  assert.equal(it.name, 'A good name', 'the name is not the file');
  assert.equal(it.x, 40);
  assert.equal(it.w, 300, 'nor is the size somebody dragged it to');
  assert.equal(it.meta.was, EMPTY,
    'and the bytes stay pinned for as long as undo can reach them');
});

test('an empty cover is dropped without touching the card its own file', () => {
  loadBoard({
    title: 'T',
    items: [photo({ id: 'a', asset: { hash: REAL, embedded: true }, meta: { cover: COVER } })],
  });
  swapAssets([{ id: 'a', cover: null }]);
  const it = byId('a');
  assert.equal('cover' in it.meta, false, 'the key is gone, not left as undefined');
  assert.equal(it.asset.hash, REAL, 'the file it actually holds is untouched');
  assert.equal(it.meta.wasCover, COVER);
});

test('removing empty files is one undo, like everything else the optimiser does', () => {
  loadBoard({
    title: 'T',
    items: [
      photo({ id: 'a', asset: { hash: EMPTY, embedded: true } }),
      photo({ id: 'b', asset: { hash: EMPTY, embedded: true } }),
      photo({ id: 'c', asset: { hash: REAL, embedded: true }, meta: { cover: COVER } }),
    ],
  });
  swapAssets([
    { id: 'a', asset: null }, { id: 'b', asset: null }, { id: 'c', cover: null },
  ]);
  assert.equal(byId('a').asset, null);
  assert.equal(byId('b').asset, null);
  assert.equal('cover' in byId('c').meta, false);

  undo();
  assert.equal(byId('a').asset.hash, EMPTY, 'one Ctrl+Z gives the whole run back');
  assert.equal(byId('b').asset.hash, EMPTY);
  assert.equal(byId('c').meta.cover, COVER);
});

test('a board with nothing but empties to clear is still a run worth making', () => {
  // The case the old `if (asset || cover || …)` guard silently dropped: null is
  // falsy, so every card being emptied failed the test that decides whether it
  // reaches swapAssets() at all.
  loadBoard({
    title: 'T',
    items: [photo({ id: 'a', asset: { hash: EMPTY, embedded: true } })],
  });
  const touched = swapAssets([{ id: 'a', asset: null }]);
  assert.equal(touched, 1, 'the run happened');
  assert.equal(board.items[0].asset, null);
});
