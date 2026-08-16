// Emptying the bin, which is the one action in this app that destroys anything.
//
// Everything else that removes a card leaves its bytes exactly where they are,
// because three separate things can put the card back - undo, the bin, and the
// step ledger - and each of them is a claim on the asset. Emptying the bin is
// the only action that ends all three claims at once, and until it did so the
// file stayed: in the registry, in every .mbrd written afterwards, and in the
// autosave sweep's keep-set, because the step that deleted the card still named
// it. A board somebody had cleaned out went on weighing what it weighed before.
//
// So these are the two halves of the promise. The bytes actually go, and
// nothing anywhere still points at them - which means the *ledger* has to be
// rewritten, since it is the one place that deliberately remembers things the
// board no longer has. What goes in their place is a tombstone: the name, the
// kind of file and the size, on a card the board can still draw.
//
// The failure being guarded is silent in both directions. Purge without the
// rewrite and every step that touched the picture replays a card pointing at a
// dead blob URL. Rewrite without the purge and nothing is deleted at all, which
// is the behaviour this replaced.

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
  // Unwired between cases, so a test that forgets to arrange one gets the
  // no-registry behaviour rather than the previous case's leftovers.
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
  // Undo is the only way to look at what the emptying left behind, which is
  // also the point of it: the entries come back, and what comes back is a
  // record of a file rather than a file.
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
  // Before: the delete carries the picture on its before side, which is exactly
  // what stepping back is for and exactly what keeps the asset alive.
  assert.ok(timelineHashes(serializeTimeline()).has(HASH),
    'the ledger should be holding the picture until the bin is emptied');

  emptyTrash();

  assert.deepEqual([...timelineHashes(serializeTimeline())], [],
    'a step naming bytes that were destroyed is a step that replays a dead card');
});

test('a file a live card is also standing on is not touched', () => {
  // Two cards, one asset - what dropping the same photograph twice makes. The
  // bin holding one of them says nothing about the one still on the board.
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
  // A note is not a file and emptying the bin destroys nothing of it, so
  // marking it deleted would be the app throwing away somebody's words to make
  // a rule look uniform.
  fakeRegistry();
  const [n] = addItems([{ type: 'note', w: 100, h: 100, meta: { text: 'keep me' } }]);
  removeItems([n.id]);
  emptyTrash();
  undo();

  assert.equal(board.trash[0].item.type, 'note');
  assert.equal(board.trash[0].item.meta.text, 'keep me');
});

test('the optimiser memo goes too, since nothing can revert to it', () => {
  // meta.was is the original a card was optimised away from, held alive so the
  // change can be undone. On a card being destroyed it is the largest thing the
  // bin is holding and the one nothing will ever ask for again.
  const { store, asked } = fakeRegistry();
  const [a] = addItems([pic(HASH, { meta: { was: OTHER } })]);
  removeItems([a.id]);
  emptyTrash();

  assert.deepEqual(asked, [[HASH, OTHER].sort()]);
  assert.equal(store.size, 0);
});

test('with no registry wired, the bin empties the way it always did', () => {
  // The seam is injected, and unwired it frees nothing and says so. That is the
  // honest default rather than a convenient one: a caller with no registry in
  // scope gets the old behaviour instead of a board full of cards claiming
  // their pictures were destroyed.
  const [a] = addItems([pic()]);
  removeItems([a.id]);
  emptyTrash();
  undo();

  assert.equal(board.trash[0].item.type, 'image');
  assert.equal(board.trash[0].item.asset.hash, HASH);
});
