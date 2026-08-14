// The inventory report: what is in this board, and what it weighs.
//
// The sheet itself is DOM and is not tested here. What is tested is
// boardInventory(), which is arithmetic over the item list and the asset store
// - and the two rules it must not break, both of which are about what it does
// *not* do.
//
// The first is that sizes come from the stored blobs. Nothing here re-reads an
// original and nothing decodes an image, because the boards this gets opened on
// are the heavy ones and a panel that measured by decoding would stall the tab
// at exactly the moment the question was asked.
//
// The second is the reference union, which is the one place this can be wrong
// in a way that matters. An asset is unreferenced if no live item and nothing
// in the bin points at it - the same union packBoard() writes with - and a bug
// there would report somebody's picture as rubbish.

import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

import { addItems, board, removeItems, setBoardMode } from '../web/assets/js/state.ts';
import { putAsset, clearAssets } from '../web/assets/js/storage/assets.ts';
import { boardInventory } from '../web/assets/js/ui/inventory.ts';
import { formatBytes } from '../web/assets/js/util.ts';
import { fresh, note, photo, clip } from './state-fixtures.js';

/** A blob of a given length, without allocating one. */
const blobOf = size => ({ size, type: 'image/png' });

/** Register an asset under a hash, with a name and a weight. */
function asset(hash, size, name = 'p.png') {
  putAsset(hash, blobOf(size), { mime: 'image/png', ext: 'png', name });
}

beforeEach(() => {
  setBoardMode('desktop');
  fresh();
  clearAssets();
});

test('an empty board weighs nothing and says so', () => {
  const inv = boardInventory();
  assert.equal(inv.bytes, 0);
  assert.equal(inv.assets, 0);
  assert.deepEqual(inv.largest, []);
  assert.equal(inv.orphans.count, 0);
});

test('cards are counted by kind, commonest first', () => {
  addItems([photo(), photo(), photo(), note(), clip()]);
  const inv = boardInventory();
  assert.deepEqual(inv.kinds.map(k => `${k.type}:${k.count}`), ['image:3', 'note:1', 'video:1']);
  assert.equal(inv.items, 5);
});

test('the heaviest come first, and the order is stable', () => {
  asset('a'.repeat(64), 300, 'small.png');
  asset('b'.repeat(64), 9000, 'big.png');
  asset('c'.repeat(64), 1200, 'middle.png');
  addItems([
    photo({ asset: { hash: 'a'.repeat(64) } }),
    photo({ asset: { hash: 'b'.repeat(64) } }),
    photo({ asset: { hash: 'c'.repeat(64) } }),
  ]);
  const inv = boardInventory();
  assert.deepEqual(inv.largest.map(a => a.name), ['big.png', 'middle.png', 'small.png']);
  assert.equal(inv.bytes, 10500);
  // Twice, unchanged, in the same order - two assets of identical size would
  // otherwise swap places on the whim of Map iteration order, and a report that
  // shuffles between two opens of an unchanged board is one nobody trusts.
  asset('d'.repeat(64), 1200, 'tie-one.png');
  asset('e'.repeat(64), 1200, 'tie-two.png');
  const first = boardInventory().largest.map(a => a.hash);
  assert.deepEqual(boardInventory().largest.map(a => a.hash), first);
});

test('a binned card still owns its bytes', () => {
  // The whole point of the bin is that the card can come back, so its asset is
  // referenced, not orphaned. This is the same union packBoard() writes with,
  // and getting it wrong would report somebody's picture as rubbish the moment
  // they deleted the card.
  asset('a'.repeat(64), 500);
  const [p] = addItems([photo({ asset: { hash: 'a'.repeat(64) } })]);
  removeItems([p.id]);
  assert.equal(board.trash.length, 1);
  const inv = boardInventory();
  assert.equal(inv.orphans.count, 0, 'a binned card is not an orphan');
  assert.equal(inv.binned, 1);
});

test('an asset no card claims is reported as unused', () => {
  asset('a'.repeat(64), 500, 'used.png');
  asset('z'.repeat(64), 4000, 'stray.png');
  addItems([photo({ asset: { hash: 'a'.repeat(64) } })]);
  const inv = boardInventory();
  assert.equal(inv.orphans.count, 1);
  assert.equal(inv.orphans.bytes, 4000);
  assert.equal(inv.largest.find(a => a.name === 'stray.png').orphan, true);
  assert.equal(inv.largest.find(a => a.name === 'used.png').orphan, false);
});

test('every id an item can carry counts as a reference', () => {
  // Not just asset.hash. A cover, a poster still, a thumbnail and a decodable
  // preview are all ids an item owns, and itemHashes() is the one place that
  // list lives - reproducing it here by hand is how one gets missed and a live
  // thumbnail gets reported as rubbish.
  asset('a'.repeat(64), 10);
  asset('b'.repeat(64), 20);
  asset('c'.repeat(64), 30);
  asset('d'.repeat(64), 40);
  addItems([photo({
    asset: { hash: 'a'.repeat(64) },
    meta: { cover: 'b'.repeat(64), thumb: 'c'.repeat(64), preview: 'd'.repeat(64) },
  })]);
  assert.equal(boardInventory().orphans.count, 0);
});

test('sizes are written the way the rest of the app writes them', () => {
  // util.ts's formatBytes, not a second one of this sheet's own. It was very
  // nearly written twice - the second decimal, on the argument that a file
  // manager says 12 MB for 12,000,000 bytes - and one app saying two different
  // things about how big the same picture is would be a worse fault than
  // whichever convention is chosen. The trash panel and the optimiser already
  // say binary, so this does.
  assert.equal(formatBytes(1024), '1.0 KB');
  assert.equal(formatBytes(1024 * 1024 * 12), '12 MB');
});
