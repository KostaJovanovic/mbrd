// Emptying the bin, the one action here that destroys anything. Undo, the
// bin and the step ledger each hold a claim on a removed card's asset;
// emptying the bin ends all three at once, or the file stays in the
// registry and the autosave keep-set even after cleanup. The bytes must
// actually go, and the *ledger* must be rewritten to stop naming them - in
// their place, a tombstone: name, kind and size, on a card the board can
// still draw. Purge without rewrite replays a dead blob URL; rewrite
// without purge deletes nothing, the behaviour this replaced.

import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

import {
  board, addItems, removeItems, emptyTrash, setAssetPurge, undo,
} from '../web/assets/js/state.ts';
import { serializeTimeline, timelineHashes } from '../web/assets/js/timeline.ts';
import { fresh } from './state-fixtures.js';

const HASH = 'a'.repeat(64);
const OTHER = 'b'.repeat(64);
const SIZE = 2048;

/** A stand-in registry: it knows two files and forgets whatever it is given. */
function fakeRegistry() {
  const store = new Map([[HASH, SIZE], [OTHER, SIZE * 2]]);
  const asked = [];
  setAssetPurge(hashes => {
    asked.push([...hashes].sort());
    const freed = new Map();
    for (const hash of hashes) {
      if (!store.has(hash)) continue;
      freed.set(hash, store.get(hash));
      store.delete(hash);
    }
    return freed;
  });
  return { store, asked };
}

const pic = (hash = HASH, props = {}) => ({
  type: 'image', w: 200, h: 200, name: 'kitchen.jpg', asset: { hash }, ...props,
});

beforeEach(() => {
  fresh();
  // Unwired between cases: a test that forgets to arrange one gets the
  // no-registry behaviour, not the previous case's leftovers.
  setAssetPurge(null);
});

test('emptying the bin deletes the files it was holding', () => {
  const { store } = fakeRegistry();
  const [a] = addItems([pic()]);
  removeItems([a.id]);
  emptyTrash();

  assert.equal(board.trash.length, 0);
  assert.equal(store.has(HASH), false, 'the bytes should be gone from the registry');
});

test('what is left is a tombstone carrying the name, the kind and the size', () => {
  fakeRegistry();
  const [a] = addItems([pic()]);
  removeItems([a.id]);
  emptyTrash();
  // Undo is the only way to look at what emptying left behind, which is
  // also the point: the entries come back as a record of a file, not a file.
  undo();

  assert.equal(board.trash.length, 1, 'emptying the bin by accident is a bad afternoon');
  const stone = board.trash[0].item;
  assert.equal(stone.type, 'gone');
  assert.equal(stone.id, a.id, 'the same card, so undoing the delete under it still lands');
  assert.equal(stone.name, 'kitchen.jpg');
  assert.equal(stone.asset, null, 'a tombstone that still named an asset would name nothing');
  assert.deepEqual(stone.meta, { gone: { type: 'image', ext: 'jpg', bytes: SIZE } });
  assert.deepEqual(
    { w: stone.w, h: stone.h }, { w: a.w, h: a.h },
    'drawn where and as large as the thing it replaces');
});

test('the step ledger stops naming the bytes, on both sides of every step', () => {
  fakeRegistry();
  const [a] = addItems([pic()]);
  removeItems([a.id]);
  // Before: the delete carries the picture on its before side - exactly
  // what stepping back is for, and what keeps the asset alive.
  assert.ok(timelineHashes(serializeTimeline()).has(HASH),
    'the ledger should be holding the picture until the bin is emptied');

  emptyTrash();

  assert.deepEqual([...timelineHashes(serializeTimeline())], [],
    'a step naming bytes that were destroyed is a step that replays a dead card');
});

test('a file a live card is also standing on is not touched', () => {
  // Two cards, one asset - what dropping the same photograph twice makes.
  // The bin holding one says nothing about the one still on the board.
  const { store } = fakeRegistry();
  const [a, b] = addItems([pic(), pic()]);
  removeItems([a.id]);
  emptyTrash();

  assert.equal(store.has(HASH), true, 'the live card is still standing on those bytes');
  assert.equal(board.items.length, 1);
  assert.equal(board.items[0].id, b.id);
  assert.equal(board.items[0].type, 'image', 'the live card must not be tombstoned');
});

test('what was never a file comes back whole', () => {
  // A note is not a file, so emptying the bin destroys nothing of it -
  // marking it deleted would throw away somebody's words for uniformity.
  fakeRegistry();
  const [n] = addItems([{ type: 'note', w: 100, h: 100, meta: { text: 'keep me' } }]);
  removeItems([n.id]);
  emptyTrash();
  undo();

  assert.equal(board.trash[0].item.type, 'note');
  assert.equal(board.trash[0].item.meta.text, 'keep me');
});

test('the optimiser memo goes too, since nothing can revert to it', () => {
  // meta.was is the original a card was optimised away from, held alive so
  // the change can be undone - the largest thing the bin holds for a
  // destroyed card, and the one nothing will ask for again.
  const { store, asked } = fakeRegistry();
  const [a] = addItems([pic(HASH, { meta: { was: OTHER } })]);
  removeItems([a.id]);
  emptyTrash();

  assert.deepEqual(asked, [[HASH, OTHER].sort()]);
  assert.equal(store.size, 0);
});

test('with no registry wired, the bin empties the way it always did', () => {
  // Unwired, the seam frees nothing and says so - the honest default: a
  // caller with no registry gets the old behaviour, not cards claiming
  // pictures were destroyed.
  const [a] = addItems([pic()]);
  removeItems([a.id]);
  emptyTrash();
  undo();

  assert.equal(board.trash[0].item.type, 'image');
  assert.equal(board.trash[0].item.asset.hash, HASH);
});
