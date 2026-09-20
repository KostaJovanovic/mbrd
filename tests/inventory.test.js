// Tests boardInventory(), the arithmetic over the item list and asset store
// behind the inventory sheet (DOM, untested here). Two rules must hold: sizes
// come from stored blob size, never a re-decode that would stall a heavy
// board; and the reference union (live items + drawer + Timeline) matches
// packBoard()'s, or an orphan report starts calling live assets rubbish.
//
// The sheet also splits that union three ways, and the arithmetic only reads
// as an explanation while the three holders and the orphans add up to every
// stored file - hence the sum check below.

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
  // Twice, unchanged, in the same order - identical-size assets could
  // otherwise swap places on Map iteration order, and a report that shuffles
  // between opens of an unchanged board is one nobody trusts.
  asset('d'.repeat(64), 1200, 'tie-one.png');
  asset('e'.repeat(64), 1200, 'tie-two.png');
  const first = boardInventory().largest.map(a => a.hash);
  // Confirm the tied assets are actually in the report - otherwise two empty
  // arrays would agree and the comparison below proves nothing.
  assert.ok(first.includes('d'.repeat(64)) && first.includes('e'.repeat(64)),
    'the two tied assets are not in the report at all');
  assert.deepEqual(boardInventory().largest.map(a => a.hash), first);
});

test('a binned card still owns its bytes', () => {
  // The point of the bin is that the card can come back, so its asset is
  // referenced, not orphaned - getting this wrong reports a deleted card's
  // picture as rubbish.
  asset('a'.repeat(64), 500);
  const [p] = addItems([photo({ asset: { hash: 'a'.repeat(64) } })]);
  removeItems([p.id]);
  assert.equal(board.trash.length, 1);
  const inv = boardInventory();
  assert.equal(inv.orphans.count, 0, 'a binned card is not an orphan');
  assert.equal(inv.binned, 1);
});

test('every file is counted under the one holder keeping it alive', () => {
  // What the sheet's "70 on the field, 26 held by the Timeline" line is built
  // on. A file claimed twice - on the field and inside a Timeline step - must
  // be counted once, under the stronger claim, or the split adds up to more
  // files than the board has.
  asset('a'.repeat(64), 500, 'field.png');
  asset('b'.repeat(64), 400, 'drawer.png');
  asset('z'.repeat(64), 300, 'stray.png');
  const [, binned] = addItems([
    photo({ asset: { hash: 'a'.repeat(64) } }),
    photo({ asset: { hash: 'b'.repeat(64) } }),
  ]);
  removeItems([binned.id]);
  const inv = boardInventory();
  assert.equal(inv.held.field, 1);
  assert.equal(inv.held.drawer, 1, 'a binned card holds its file in the drawer, not the Timeline');
  assert.equal(inv.orphans.count, 1);
  assert.equal(
    inv.held.field + inv.held.drawer + inv.held.timeline + inv.orphans.count,
    inv.assets,
    'the three holders and the orphans must add up to every stored file',
  );
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
  // Not just asset.hash - cover, poster, thumb and preview are all ids an
  // item owns. itemHashes() is the one place that list lives; reproducing it
  // by hand here is how one gets missed.
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

test('a file names the live cards using it, and an orphan names none', () => {
  // What the sheet's jump-to-card is built on. Live cards only: a binned
  // card is off the orphan list but there's nowhere to fly to for it, so a
  // row pointing at a binned card would be a dead control that looks live.
  asset('a'.repeat(64), 500, 'shared.png');
  asset('z'.repeat(64), 400, 'stray.png');
  const [one, two] = addItems([
    photo({ asset: { hash: 'a'.repeat(64) } }),
    photo({ asset: { hash: 'a'.repeat(64) } }),
  ]);
  const by = Object.fromEntries(boardInventory().largest.map(a => [a.name, a.cards]));
  assert.deepEqual(by['shared.png'], [one.id, two.id]);
  assert.deepEqual(by['stray.png'], []);
  removeItems([two.id]);
  assert.deepEqual(boardInventory().largest.find(a => a.name === 'shared.png').cards, [one.id]);
});

test('sizes are written the way the rest of the app writes them', () => {
  // util.ts's formatBytes, not a second one of this sheet's own - it was
  // nearly duplicated with decimal units to match a file manager's "12 MB",
  // but the trash panel and optimiser already say binary, so this does too.
  assert.equal(formatBytes(1024), '1.0 KB');
  assert.equal(formatBytes(1024 * 1024 * 12), '12 MB');
});
