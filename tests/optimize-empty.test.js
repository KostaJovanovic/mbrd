// Files with no bytes in them, and what the optimiser does about them.
//
// The one thing that feature does which is a removal rather than a re-encode,
// so it is the one that has to be checked hardest. An empty file cannot be made
// smaller and can never draw anything: what it leaves on a board is a card
// claiming to be a photograph with a permanent hole where the picture goes.
//
// The two halves read differently on purpose, and getting that wrong is what
// this file now pins. A card whose *own* file is empty has nothing on it at all
// - no picture, no sound, no text, and no way for any of those to arrive later
// - so the card goes, to the bin, in one undoable step. A card that merely
// wears an empty *cover* has a real file on it and only its picture is hollow,
// so it loses the picture and keeps everything else.
//
// The first version of this cleared the reference on both and left the cards
// standing, which is the hole without even the explanation for it.

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

test('a card whose own file is empty is thrown away, not left standing', () => {
  // The bug this file was written for. Clearing the reference and leaving the
  // card produced a card that had stopped claiming to be a file and still sat
  // on the board taking up room.
  loadBoard({
    title: 'T',
    items: [
      photo({ id: 'a', name: 'broken', asset: { hash: EMPTY, embedded: true } }),
      photo({ id: 'b', asset: { hash: REAL, embedded: true } }),
    ],
  });
  const doomed = planOptimize().empty.filter(e => e.asset).map(e => e.id);
  removeItems(doomed, 'Remove empty file');

  assert.equal(byId('a'), undefined, 'the card is gone, not merely emptied');
  assert.ok(byId('b'), 'and the card with a real file is untouched');
});

test('a thrown-away empty card goes to the bin and comes back on one undo', () => {
  // The whole reason a delete is allowed here: it is recoverable twice over.
  loadBoard({
    title: 'T',
    items: [photo({ id: 'a', name: 'broken', asset: { hash: EMPTY, embedded: true } })],
  });
  removeItems(['a'], 'Remove empty file');
  assert.equal(board.trash.length, 1, 'it is in the bin');
  assert.equal(board.trash[0].item.id, 'a');

  undo();
  assert.ok(byId('a'), 'and one Ctrl+Z puts it back on the board');
  assert.equal(byId('a').name, 'broken');
  assert.equal(board.trash.length, 0);
});

test('an empty cover is dropped, and the card keeps everything else', () => {
  // The other half, and deliberately not a delete: this card has a real file on
  // it and only its picture is hollow.
  loadBoard({
    title: 'T',
    items: [photo({
      id: 'a', name: 'A good name', x: 40, y: -60, w: 300, h: 200,
      asset: { hash: REAL, embedded: true }, meta: { cover: COVER },
    })],
  });
  swapAssets([{ id: 'a', cover: null }]);

  const it = byId('a');
  assert.equal('cover' in it.meta, false, 'the key is gone, not left as undefined');
  assert.equal(it.asset.hash, REAL, 'the file it actually holds is untouched');
  assert.equal(it.name, 'A good name', 'the name is not the picture');
  assert.equal(it.x, 40);
  assert.equal(it.w, 300, 'nor is the size somebody dragged it to');
  assert.equal(it.meta.wasCover, COVER,
    'and the bytes stay pinned for as long as undo can reach them');
});

test('dropping empty covers is one undo across the whole board', () => {
  loadBoard({
    title: 'T',
    items: [
      photo({ id: 'a', asset: { hash: REAL, embedded: true }, meta: { cover: COVER } }),
      photo({ id: 'b', asset: { hash: REAL, embedded: true }, meta: { cover: COVER } }),
    ],
  });
  swapAssets([{ id: 'a', cover: null }, { id: 'b', cover: null }]);
  assert.equal('cover' in byId('a').meta, false);
  assert.equal('cover' in byId('b').meta, false);

  undo();
  assert.equal(byId('a').meta.cover, COVER, 'one Ctrl+Z gives the whole run back');
  assert.equal(byId('b').meta.cover, COVER);
});

test('a board with nothing but an empty cover to clear is still a run worth making', () => {
  // The case the old `if (asset || cover || …)` guard silently dropped: null is
  // falsy, so every card losing a cover failed the test that decides whether it
  // reaches swapAssets() at all.
  loadBoard({
    title: 'T',
    items: [photo({ id: 'a', asset: { hash: REAL, embedded: true }, meta: { cover: COVER } })],
  });
  assert.equal(swapAssets([{ id: 'a', cover: null }]), 1, 'the run happened');
  assert.equal('cover' in byId('a').meta, false);
});
