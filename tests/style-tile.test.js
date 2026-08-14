// The style tile: the summary, rather than a photograph of the board.
//
// The drawing is canvas and is not tested here - there is no document in a
// runner. What is tested is the part that decides *what goes on it*, which is
// where the three taste decisions this feature had to take actually live:
//
//   whose colours    the board's own current palette, read off the live tokens
//   which pictures   the selection when there is one, else the largest by area
//   the whimsy dial  followed (a drawing decision, so not asserted here)
//
// The second is the one with a rule worth pinning. "The selection if there is
// one" has to mean *pictures in the selection* - a selection of three notes is
// not a curation of pictures, and falling through to the largest is the right
// answer rather than exporting a tile with no images on it.

import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

import { addItems, setBoardMode } from '../web/assets/js/state.ts';
import { styleTileContents } from '../web/assets/js/ui/snapshot.ts';
import { fresh, note, photo } from './state-fixtures.js';

const HASH = c => c.repeat(64);
/**
 * A picture of a given size.
 *
 * Every size here is above MIN_SIZE (48). Below it the board clamps, which
 * makes four differently-written cards the same size and the ordering below
 * comes out on the tie-break instead - which is correct behaviour and a
 * useless test.
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

test('it takes at most four', () => {
  addItems([pic('a', 60, 60), pic('b', 80, 80), pic('c', 100, 100),
    pic('d', 120, 120), pic('e', 140, 140), pic('f', 160, 160)]);
  assert.equal(styleTileContents(null).pictures.length, 4);
  assert.deepEqual(styleTileContents(null).pictures.map(p => p.id), ['f', 'e', 'd', 'c']);
});

test('a selection is the curation, and beats size', () => {
  addItems([pic('a', 60, 60), pic('b', 900, 900), pic('c', 90, 90)]);
  const picked = styleTileContents(new Set(['a', 'c'])).pictures.map(p => p.id);
  assert.deepEqual(picked, ['c', 'a'], 'only the selected two, largest first');
});

test('a selection with no pictures in it falls through to the board', () => {
  // The rule worth pinning. Three notes selected is not a curation of pictures,
  // and honouring it literally would export a tile with no images on it - which
  // looks like the feature is broken rather than like the selection was wrong.
  const [n] = addItems([note({ id: 'n1' })]);
  addItems([pic('a', 100, 100)]);
  const picked = styleTileContents(new Set([n.id])).pictures.map(p => p.id);
  assert.deepEqual(picked, ['a']);
});

test('cards with no bytes are not offered as pictures', () => {
  // pixelHash() is what a picture is here: an image card whose asset never
  // arrived would be an empty box on the tile.
  addItems([photo({ id: 'empty', w: 900, h: 900 }), pic('a', 10, 10)]);
  assert.deepEqual(styleTileContents(null).pictures.map(p => p.id), ['a']);
});

test('the tile is the same twice for an unchanged board', () => {
  // Identically sized cards would otherwise come out in whatever order the item
  // list happened to hold, and an export that shuffles between two presses is
  // one nobody can check against the last one they sent.
  addItems([pic('a', 100, 100), pic('b', 100, 100), pic('c', 100, 100)]);
  const first = styleTileContents(null).pictures.map(p => p.id);
  assert.deepEqual(styleTileContents(null).pictures.map(p => p.id), first);
  assert.deepEqual(first, ['a', 'b', 'c'], 'ties break by id, which is stable');
});

test('an empty board offers nothing rather than throwing', () => {
  assert.deepEqual(styleTileContents(null).pictures, []);
});
