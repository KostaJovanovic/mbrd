// Tests boardInventory(), the arithmetic over the item list and asset store
// behind the inventory sheet (DOM, untested here). Two rules must hold: sizes
// come from stored blob size, never a re-decode that would stall a heavy
// board; and the reference union (live items + drawer + Timeline) matches
// packBoard()'s, or an orphan report starts calling live assets rubbish.
//
// The sheet also splits that union three ways, and the arithmetic only reads
// as an explanation while the three holders and the orphans add up to every
// stored file - hence the sum check below.
//
// A row is a group - the file a card arrived as, with the copies made from it
// folded under it - so the third rule is that every stored file lands in
// exactly one group. A file under two cards that grouped under both would
// report a board heavier than it is.

import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

import {
  addItems, board, removeItems, setBoardMode, discardOriginals,
} from '../web/assets/js/state.ts';
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
  assert.deepEqual(inv.largest.map(g => g.head.name), ['big.png', 'middle.png', 'small.png']);
  assert.equal(inv.bytes, 10500);
  // Twice, unchanged, in the same order - identical-size assets could
  // otherwise swap places on Map iteration order, and a report that shuffles
  // between opens of an unchanged board is one nobody trusts.
  asset('d'.repeat(64), 1200, 'tie-one.png');
  asset('e'.repeat(64), 1200, 'tie-two.png');
  addItems([
    photo({ asset: { hash: 'd'.repeat(64) } }),
    photo({ asset: { hash: 'e'.repeat(64) } }),
  ]);
  const first = boardInventory().largest.map(g => g.head.hash);
  // Confirm the tied assets are actually in the report - otherwise two empty
  // arrays would agree and the comparison below proves nothing.
  assert.ok(first.includes('d'.repeat(64)) && first.includes('e'.repeat(64)),
    'the two tied assets are not in the report at all');
  assert.deepEqual(boardInventory().largest.map(g => g.head.hash), first);
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
  assert.equal(inv.held.field.count, 1);
  assert.equal(inv.held.drawer.count, 1,
    'a binned card holds its file in the drawer, not the Timeline');
  assert.equal(inv.orphans.count, 1);
  assert.equal(
    inv.held.field.count + inv.held.drawer.count + inv.held.timeline.count + inv.orphans.count,
    inv.assets,
    'the three holders and the orphans must add up to every stored file',
  );
  assert.equal(
    inv.held.field.bytes + inv.held.drawer.bytes + inv.held.timeline.bytes + inv.orphans.bytes,
    inv.bytes,
    'and their weights to every stored byte - the headline reports one of them alone',
  );
});

test('a binned card keeps its own row, under the drawer rather than the board', () => {
  // The heaviest list is the board: a picture that is only in the drawer must
  // not sit in it, or "what is on the field" stops being answerable.
  asset('a'.repeat(64), 500, 'live.png');
  asset('b'.repeat(64), 900, 'binned.png');
  asset('c'.repeat(64), 60, 'binned-thumb.webp');
  const [, gone] = addItems([
    photo({ asset: { hash: 'a'.repeat(64) } }),
    photo({ asset: { hash: 'b'.repeat(64) }, meta: { thumb: 'c'.repeat(64) } }),
  ]);
  removeItems([gone.id]);
  const inv = boardInventory();
  assert.deepEqual(inv.largest.map(g => g.head.name), ['live.png']);
  assert.equal(inv.files, 1, 'the headline counts the field alone');
  assert.deepEqual(inv.kept.drawer.map(g => g.head.name), ['binned.png']);
  // Grouped like any card's: the drawer holds a picture, not three files.
  assert.deepEqual(inv.kept.drawer[0].files.map(f => f.name), ['binned.png', 'binned-thumb.webp']);
  assert.equal(inv.kept.drawer[0].bytes, 960);
  assert.equal(inv.kept.drawer[0].held, 'drawer');
});

test('an asset no card claims is reported as unused', () => {
  asset('a'.repeat(64), 500, 'used.png');
  asset('z'.repeat(64), 4000, 'stray.png');
  addItems([photo({ asset: { hash: 'a'.repeat(64) } })]);
  const inv = boardInventory();
  assert.equal(inv.orphans.count, 1);
  assert.equal(inv.orphans.bytes, 4000);
  // Counted and weighed, never listed: the prose line says they go at the next
  // save, and a row for one is an offer to do something about it that the
  // sheet deliberately does not make.
  assert.deepEqual(inv.largest.map(g => g.head.name), ['used.png']);
  assert.deepEqual(inv.kept.drawer, []);
  assert.deepEqual(inv.kept.timeline, []);
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
  const by = Object.fromEntries(boardInventory().largest.map(g => [g.head.name, g.head.cards]));
  assert.deepEqual(by['shared.png'], [one.id, two.id]);
  assert.equal(by['stray.png'], undefined, 'an orphan is counted, not listed');
  removeItems([two.id]);
  assert.deepEqual(
    boardInventory().largest.find(g => g.head.name === 'shared.png').head.cards, [one.id]);
});

test('the copies a picture keeps hang off the file it arrived as', () => {
  // The whole point of the grouping: a camera RAW is stored four times over -
  // the original, the picture it was developed into, a display copy, a thumb -
  // and reporting that as four rows is the report a person cannot read.
  asset('a'.repeat(64), 23_000_000, 'shot.dng');
  asset('b'.repeat(64), 2_100_000, 'shot.webp');
  asset('c'.repeat(64), 341_000, 'display.webp');
  asset('d'.repeat(64), 2300, 'thumb.webp');
  addItems([photo({
    asset: { hash: 'b'.repeat(64) },
    meta: {
      source: 'a'.repeat(64), display: 'c'.repeat(64), thumb: 'd'.repeat(64),
    },
  })]);
  const inv = boardInventory();
  assert.equal(inv.assets, 4, 'four files are stored');
  assert.equal(inv.files, 1, 'and they are one file to read about');
  const [group] = inv.largest;
  // Named after the dropped file, not the picture it became - meta.source is
  // the .dng and asset.hash is the WebP the card draws.
  assert.equal(group.head.name, 'shot.dng');
  assert.equal(group.head.role, 'source');
  assert.equal(group.bytes, 25_443_300);
  assert.equal(group.bytes, inv.bytes, 'the one group carries the whole board');
  assert.deepEqual(group.files.map(f => f.role), ['source', 'main', 'display', 'still']);
});

test('a card with no source is named after the picture itself', () => {
  asset('a'.repeat(64), 400_000, 'photo.jpg');
  asset('c'.repeat(64), 40_000, 'display.webp');
  addItems([photo({ asset: { hash: 'a'.repeat(64) }, meta: { display: 'c'.repeat(64) } })]);
  const [group] = boardInventory().largest;
  assert.equal(group.head.name, 'photo.jpg');
  assert.equal(group.head.role, 'main');
});

test('a file two cards share is grouped once, under the first of them', () => {
  // Or the board reports more bytes than it stores: the shared picture would
  // be counted in both groups and the rows would add up past inv.bytes.
  asset('a'.repeat(64), 500, 'shared.png');
  asset('b'.repeat(64), 60, 'thumb-one.webp');
  asset('c'.repeat(64), 70, 'thumb-two.webp');
  const [one] = addItems([
    photo({ asset: { hash: 'a'.repeat(64) }, meta: { thumb: 'b'.repeat(64) } }),
    photo({ asset: { hash: 'a'.repeat(64) }, meta: { thumb: 'c'.repeat(64) } }),
  ]);
  const inv = boardInventory();
  assert.equal(inv.files, 2);
  assert.equal(inv.largest.reduce((sum, g) => sum + g.bytes, 0), inv.bytes);
  const shared = inv.largest.find(g => g.head.name === 'shared.png');
  assert.deepEqual(shared.files.map(f => f.name), ['shared.png', 'thumb-one.webp']);
  assert.deepEqual(shared.head.cards[0], one.id);
  // The second card is left with the one file the first did not claim, so its
  // row is named after the thumb rather than vanishing.
  assert.deepEqual(inv.largest.find(g => g !== shared).files.map(f => f.name), ['thumb-two.webp']);
});

test('the picture an Optimize replaced is held for undo, not called rubbish', () => {
  // meta.was is not in itemHashes() - the packer exports the small copies -
  // but the autosave sweep keeps it (referencedHashes, storage/session.ts).
  // A report that called it an orphan would promise bytes back at the next
  // save that the save then keeps, which is the one lie this sheet must not
  // tell. It is the past's weight, so it is counted with the Timeline's.
  asset('a'.repeat(64), 400, 'small.webp');
  asset('b'.repeat(64), 9000, 'original.jpg');
  addItems([photo({
    asset: { hash: 'a'.repeat(64) },
    meta: { was: 'b'.repeat(64) },
  })]);
  const inv = boardInventory();
  assert.equal(inv.orphans.count, 0, 'the original is held, not rubbish');
  assert.equal(inv.held.timeline.count, 1);
  assert.equal(inv.held.timeline.bytes, 9000);
  assert.equal(inv.held.field.bytes, 400, 'and it is not the board\'s weight either');
  assert.deepEqual(inv.freeable, ['b'.repeat(64)]);
  // Listed under the Timeline's heading, where the Delete button is.
  assert.deepEqual(inv.kept.timeline.map(g => g.head.name), ['original.jpg']);
});

test('forgetting the originals gives back the hashes and leaves the board alone', () => {
  asset('a'.repeat(64), 400, 'small.webp');
  asset('b'.repeat(64), 9000, 'original.jpg');
  const [card] = addItems([photo({
    asset: { hash: 'a'.repeat(64) },
    meta: { was: 'b'.repeat(64), wasCover: 'c'.repeat(64) },
  })]);
  assert.deepEqual(discardOriginals().sort(), ['b'.repeat(64), 'c'.repeat(64)]);
  assert.equal(board.items[0].meta.was, undefined);
  assert.equal(board.items[0].meta.wasCover, undefined);
  assert.equal(board.items[0].asset.hash, 'a'.repeat(64), 'the card still shows its picture');
  assert.equal(card.id, board.items[0].id, 'and it is the same card');
  // Nothing is holding them now, so the sheet offers them as rubbish.
  assert.deepEqual(discardOriginals(), [], 'and a second run has nothing to do');
});

test('the headline weighs the field alone, whatever else is stored', () => {
  // The number the optimiser is judged by. Before the split it read the whole
  // store, so an Optimize that moved 26 MB of originals into the Timeline
  // changed the headline by nothing at all and looked like it had failed.
  asset('a'.repeat(64), 500, 'live.png');
  asset('b'.repeat(64), 9000, 'binned.png');
  asset('z'.repeat(64), 4000, 'stray.png');
  const [, gone] = addItems([
    photo({ asset: { hash: 'a'.repeat(64) } }),
    photo({ asset: { hash: 'b'.repeat(64) } }),
  ]);
  removeItems([gone.id]);
  const inv = boardInventory();
  assert.equal(inv.held.field.bytes, 500, 'the field weighs what is on it');
  assert.equal(inv.bytes, 13_500, 'and the store still reports everything');
  assert.equal(inv.files, 1);
});

test('sizes are written the way the rest of the app writes them', () => {
  // util.ts's formatBytes, not a second one of this sheet's own - it was
  // nearly duplicated with decimal units to match a file manager's "12 MB",
  // but the trash panel and optimiser already say binary, so this does too.
  assert.equal(formatBytes(1024), '1.0 KB');
  assert.equal(formatBytes(1024 * 1024 * 12), '12 MB');
});
