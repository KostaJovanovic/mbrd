// The tour's stops: what a file may say, and what the board's doors do
// with it. Two things guarded here, failing differently.
// **The migration.** `tour` was a flat list of ids and is now a list of
// stops, each with a group and maybe a caption. Older files carry the old
// shape, so normalizeTour() reads three shapes and writes one - if the
// flat branch breaks, a board silently opens with no tour.
// **The doors.** addTourStop() and its four neighbours are the only
// writers, each a small piece of ordered-list arithmetic easy to get wrong
// by one - a card added to two stops, a stop dropped one place short.
// state.ts is imported for the doors: touches the bus, not the DOM, the
// same as tests/connections.test.js.

import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

import { normalizeTour, MAX_TOUR_CAPTION } from '../web/assets/js/board-model.ts';
import {
  addItems, addTourStop, board, byId, canTour, joinTourStops, moveTourStop,
  removeTourCards, setBoardMode, setTour, setTourCaption, splitTourStop,
} from '../web/assets/js/state.ts';
import { fresh, note, photo } from './state-fixtures.js';

beforeEach(() => {
  setBoardMode('desktop');
  fresh();
});

/** Three cards on an empty board, by id and in the board's own order. */
const threeCards = () =>
  addItems([photo({ id: 'a' }), photo({ id: 'b' }), photo({ id: 'c' })]).map(i => i.id);

// ── The reader ────────────────────────────────────────────────────────────

test('a flat list of ids reads as one stop per card', () => {
  assert.deepEqual(normalizeTour(['a', 'b']), [{ cards: ['a'] }, { cards: ['b'] }]);
});

test('a list of groups reads as the groups it names', () => {
  assert.deepEqual(normalizeTour([['a'], ['b', 'c']]),
    [{ cards: ['a'] }, { cards: ['b', 'c'] }]);
});

test('the written shape reads as itself, caption and all', () => {
  assert.deepEqual(normalizeTour([{ cards: ['a', 'b'], caption: 'Both' }]),
    [{ cards: ['a', 'b'], caption: 'Both' }]);
});

test('the three shapes may be mixed in one file', () => {
  // A hand-edited file: a group added to a tour written flat. Read stop by
  // stop rather than refused whole.
  assert.deepEqual(normalizeTour(['a', ['b', 'c'], { cards: ['d'] }]),
    [{ cards: ['a'] }, { cards: ['b', 'c'] }, { cards: ['d'] }]);
});

test('a card appears at one stop at most', () => {
  // Across the whole tour, not within a stop: two stops naming the same
  // card makes "how far through am I" unanswerable.
  assert.deepEqual(normalizeTour([['a', 'b'], ['b', 'c']]),
    [{ cards: ['a', 'b'] }, { cards: ['c'] }]);
});

test('a stop left holding nothing is dropped, not carried empty', () => {
  assert.deepEqual(normalizeTour([['a'], [], ['ghost'], ['b']], new Set(['a', 'b'])),
    [{ cards: ['a'] }, { cards: ['b'] }]);
});

test('an empty caption is absent rather than empty', () => {
  const [stop] = normalizeTour([{ cards: ['a'], caption: '   ' }]);
  assert.equal('caption' in stop, false);
});

test('a caption is collapsed, trimmed and cut to the ceiling', () => {
  const [stop] = normalizeTour([{ cards: ['a'], caption: '  two   words  ' }]);
  assert.equal(stop.caption, 'two words');
  const [long] = normalizeTour([{ cards: ['a'], caption: 'x'.repeat(400) }]);
  assert.equal(long.caption.length, MAX_TOUR_CAPTION);
});

test('anything that is not a list is no tour at all', () => {
  for (const raw of [null, undefined, 'a', 42, { cards: ['a'] }]) {
    assert.deepEqual(normalizeTour(raw), []);
  }
});

// ── The doors ─────────────────────────────────────────────────────────────

test('a selection of several cards becomes one stop, not several', () => {
  const [a, b, c] = threeCards();
  const added = addTourStop([a, b, c]);
  assert.equal(added, 3);
  assert.deepEqual(board.tour, [{ cards: [a, b, c] }]);
});

test('a card already on the tour is not added a second time', () => {
  const [a, b] = threeCards();
  addTourStop([a]);
  assert.equal(addTourStop([a, b]), 1, 'only the card that was not already on');
  assert.deepEqual(board.tour, [{ cards: [a] }, { cards: [b] }]);
});

test('a stop is added in the board order, not the selection order', () => {
  const [a, b, c] = threeCards();
  addTourStop([c, a, b]);
  assert.deepEqual(board.tour, [{ cards: [a, b, c] }]);
});

test('one card comes off a stop and leaves the rest of it standing', () => {
  const [a, b, c] = threeCards();
  // One grouped stop and one single - the pair a card's mark must tell
  // apart: pressing the "1" on card `a` must not take `b` with it.
  setTour([{ cards: [a, b] }, { cards: [c] }]);
  removeTourCards([a]);
  assert.deepEqual(board.tour, [{ cards: [b] }, { cards: [c] }]);
  // The last card of a stop takes the stop with it - an empty stop is one
  // the camera has nothing to fly to.
  removeTourCards([b]);
  assert.deepEqual(board.tour, [{ cards: [c] }]);
  // A card not on the tour is a no-op, not a throw: the mark is drawn
  // against a list that can change under it.
  removeTourCards([a]);
  assert.deepEqual(board.tour, [{ cards: [c] }]);
  removeTourCards([]);
  assert.deepEqual(board.tour, [{ cards: [c] }], 'nothing asked for is nothing done');
});

test('a whole stop comes off in one write when its cards go together', () => {
  const [a, b, c] = threeCards();
  setTour([{ cards: [a, b] }, { cards: [c] }]);
  // What the bar's button does with a stop selected: every card at once,
  // one call rather than a loop, so the tour is normalised and announced once.
  removeTourCards([a, b]);
  assert.deepEqual(board.tour, [{ cards: [c] }]);
});

test('a sticker or note lying on a card is not a stop of its own', () => {
  // What stickers and notes are *for*: something small dropped on something
  // big, travelling with it. A stop framed on the small one would just be
  // the same card at a tighter zoom, called a different place in the reading.
  const [pic] = addItems([photo({ x: 0, y: 0, w: 300, h: 300 })]);
  const [n] = addItems([note({ x: 0, y: 0, w: 80, h: 80 })]);
  assert.equal(canTour(byId(n.id)), false, 'stuck, so not a stop');
  assert.equal(canTour(byId(pic.id)), true, 'the card underneath still is');

  // A marquee over both is a marquee drawn round one thing.
  assert.equal(addTourStop([pic.id, n.id]), 1);
  assert.deepEqual(board.tour, [{ cards: [pic.id] }]);
  // On its own it is refused rather than quietly added.
  assert.equal(addTourStop([n.id]), 0);
  assert.deepEqual(board.tour, [{ cards: [pic.id] }]);
});

test('a grouped stop splits into one stop per card, where it stood', () => {
  const [a, b, c] = threeCards();
  setTour([{ cards: [a, b], caption: 'the pair' }, { cards: [c] }]);
  splitTourStop(0);
  // In place, in the group's own order, everything after it moved down.
  assert.deepEqual(board.tour, [
    { cards: [a], caption: 'the pair' }, { cards: [b] }, { cards: [c] },
  ]);
  // The caption went to the first piece only: it described a group that no
  // longer exists, and printing it three stops running would repeat itself.
  splitTourStop(0);
  assert.deepEqual(board.tour, [
    { cards: [a], caption: 'the pair' }, { cards: [b] }, { cards: [c] },
  ], 'a stop of one card is already split');
});

test('two neighbouring stops join into one, keeping the first caption', () => {
  const [a, b, c] = threeCards();
  setTour([{ cards: [a] }, { cards: [b], caption: 'second' }, { cards: [c] }]);
  joinTourStops(0);
  // Cards in order, first stop's then second's; the caption is the first
  // one there is - the join keeps the earlier stop's place, so its caption survives.
  assert.deepEqual(board.tour, [{ cards: [a, b], caption: 'second' }, { cards: [c] }]);
  joinTourStops(1);
  assert.deepEqual(board.tour, [{ cards: [a, b], caption: 'second' }, { cards: [c] }],
    'there is nothing after the last stop to join it to');
  joinTourStops(0);
  assert.deepEqual(board.tour, [{ cards: [a, b, c], caption: 'second' }]);
});

test('a stop moved lands where the list showed it going', () => {
  const [a, b, c] = threeCards();
  setTour([a, b, c]);
  // First to last: the index is into the list *without* the stop being
  // moved - the off-by-one this door exists to get right.
  moveTourStop(0, 2);
  assert.deepEqual(board.tour, [{ cards: [b] }, { cards: [c] }, { cards: [a] }]);
  moveTourStop(2, 0);
  assert.deepEqual(board.tour, [{ cards: [a] }, { cards: [b] }, { cards: [c] }]);
});

test('a caption is written through the same normaliser the file reader uses', () => {
  const [a] = threeCards();
  setTour([a]);
  setTourCaption(0, '  a   line  ');
  assert.equal(board.tour[0].caption, 'a line');
  setTourCaption(0, '');
  assert.equal('caption' in board.tour[0], false, 'cleared is absent, not empty');
});
