// The style tile: the summary, rather than a photograph of the board. The
// drawing is a card now (canvas/renderers.ts) and untested here (no document
// in a runner); what is tested is *what goes on it* - the board's live
// palette, and which pictures: the selection if it contains pictures, else
// the largest by area. Imported from style-tile.ts, not ui/snapshot.ts,
// because canvas/ may not import from ui/.

import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

import { addItems, setBoardMode } from '../web/assets/js/state.ts';
import { styleTileContents, TILE_IMAGES } from '../web/assets/js/style-tile.ts';
import { fresh, note, photo } from './state-fixtures.js';

const HASH = c => c.repeat(64);
/**
 * A picture of a given size. Every size here is above MIN_SIZE (48) -
 * below it the board clamps all cards to the same size, and the ordering
 * would come out on the tie-break instead of the thing under test.
 */
const pic = (id, w, h) => photo({ id, w, h, asset: { hash: HASH(id[0]) } });

beforeEach(() => {
  setBoardMode('desktop');
  fresh();
});

test('with nothing selected it takes the largest pictures', () => {
  addItems([pic('a', 100, 100), pic('b', 400, 400), pic('c', 200, 200)]);
  assert.deepEqual(styleTileContents(null).pictures.map(p => p.id), ['b', 'c', 'a']);
});

test('it takes at most TILE_IMAGES, largest first', () => {
  // Against the constant, not a literal: the number changed once already,
  // and the point of the test is the cap, not the value.
  addItems([pic('a', 60, 60), pic('b', 80, 80), pic('c', 100, 100),
    pic('d', 120, 120), pic('e', 140, 140), pic('f', 160, 160)]);
  assert.equal(styleTileContents(null).pictures.length, TILE_IMAGES);
  assert.deepEqual(styleTileContents(null).pictures.map(p => p.id),
    ['f', 'e', 'd', 'c'].slice(0, TILE_IMAGES));
});

test('a selection is the curation, and beats size', () => {
  addItems([pic('a', 60, 60), pic('b', 900, 900), pic('c', 90, 90)]);
  const picked = styleTileContents(new Set(['a', 'c'])).pictures.map(p => p.id);
  assert.deepEqual(picked, ['c', 'a'], 'only the selected two, largest first');
});

test('a selection with no pictures in it falls through to the board', () => {
  // Three notes selected is not a curation of pictures; honouring it
  // literally would export a tile with no images, which looks broken.
  const [n] = addItems([note({ id: 'n1' })]);
  addItems([pic('a', 100, 100)]);
  const picked = styleTileContents(new Set([n.id])).pictures.map(p => p.id);
  assert.deepEqual(picked, ['a']);
});

test('cards with no bytes are not offered as pictures', () => {
  // An image card whose asset never arrived would be an empty box on the tile.
  addItems([photo({ id: 'empty', w: 900, h: 900 }), pic('a', 10, 10)]);
  assert.deepEqual(styleTileContents(null).pictures.map(p => p.id), ['a']);
});

test('the tile is the same twice for an unchanged board', () => {
  // Identically sized cards would otherwise come out in item-list order, and
  // an export that shuffles between two presses can't be checked against
  // the last one sent.
  addItems([pic('a', 100, 100), pic('b', 100, 100), pic('c', 100, 100)]);
  const first = styleTileContents(null).pictures.map(p => p.id);
  assert.deepEqual(styleTileContents(null).pictures.map(p => p.id), first);
  assert.deepEqual(first, ['a', 'b', 'c'], 'ties break by id, which is stable');
});

test('an empty board offers nothing rather than throwing', () => {
  assert.deepEqual(styleTileContents(null).pictures, []);
});
