// Relations that name a card by id, kept true through the writes that change
// the id or the list (research/bug-hunt-2026-09-23.md): a retype gives the card
// a fresh id (M6), and the undo of a removed tour stop put back a whole tour (L3).

import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

import {
  board, loadBoard, retypeItem, undo, redo, setBoardMode, removeTourStop, addTourStop,
} from '../web/assets/js/state.ts';

beforeEach(() => {
  setBoardMode('desktop');
});

const card = (id, type = 'note', extra = {}) =>
  ({ id, type, x: 0, y: 0, w: 100, h: 100, meta: { text: id }, ...extra });

test('M6: a retype carries the connections, the tour and the playlist to the new id', () => {
  loadBoard({
    title: 'T',
    items: [card('a', 'audio', { asset: { hash: 'h'.repeat(64) } }), card('b'), card('c')],
    connections: [['a', 'b'], ['c', 'a']],
    tour: [{ cards: ['b'] }, { cards: ['c', 'a'] }],
    audioOrder: ['a'],
  });
  assert.equal(board.connections.length, 2, 'fixture: the connections load');
  assert.deepEqual(board.tour.map(s => s.cards), [['b'], ['c', 'a']], 'fixture: the tour loads');
  assert.deepEqual(board.audioOrder, ['a'], 'fixture: the playlist loads');
  const made = retypeItem('a', { type: 'audio', w: 100, h: 100, asset: { hash: 'e'.repeat(64) } });
  const id = made.id;
  assert.notEqual(id, 'a');
  assert.deepEqual(board.connections.map(c => [c[0], c[1]]), [[id, 'b'], ['c', id]]);
  assert.deepEqual(board.tour.map(s => s.cards), [['b'], ['c', id]]);
  assert.deepEqual(board.audioOrder, [id]);
  undo();
  assert.deepEqual(board.connections.map(c => [c[0], c[1]]), [['a', 'b'], ['c', 'a']]);
  assert.deepEqual(board.tour.map(s => s.cards), [['b'], ['c', 'a']]);
  assert.deepEqual(board.audioOrder, ['a']);
  redo();
  assert.deepEqual(board.audioOrder, [id]);
});

test('L3: undo and redo of a removed stop keep the tour edits made since', () => {
  loadBoard({
    title: 'T',
    items: [card('a'), card('b'), card('c'), card('d')],
    tour: [{ cards: ['a'] }, { cards: ['b'], caption: 'B' }, { cards: ['c'] }],
  });
  const cards = () => board.tour.map(s => s.cards);
  assert.equal(removeTourStop(1), true);
  assert.deepEqual(cards(), [['a'], ['c']]);
  // Tour edits are off the undo stack: this one sits under the removal's entry.
  addTourStop(['d']);
  undo();
  assert.deepEqual(cards(), [['a'], ['b'], ['c'], ['d']]);
  assert.equal(board.tour[1].caption, 'B');
  redo();
  assert.deepEqual(cards(), [['a'], ['c'], ['d']]);
});

test('L3: an undone stop does not take a card another stop holds now', () => {
  loadBoard({
    title: 'T',
    items: [card('a'), card('b'), card('c')],
    tour: [{ cards: ['a', 'b'] }, { cards: ['c'] }],
  });
  const cards = () => board.tour.map(s => s.cards);
  removeTourStop(0);
  addTourStop(['b']);
  undo();
  assert.deepEqual(cards(), [['a'], ['c'], ['b']]);
});

test('M6: a retype carries a sticky stuck to the card', () => {
  loadBoard({
    title: 'T',
    items: [card('a'), card('n', 'note', { meta: { text: 'n', stuckTo: 'a' } })],
  });
  const made = retypeItem('a', { type: 'link', w: 100, h: 100, meta: { url: 'https://example.com/' } });
  const note = board.items.find(i => i.id === 'n');
  assert.equal(note.meta.stuckTo, made.id);
  undo();
  assert.equal(board.items.find(i => i.id === 'n').meta.stuckTo, 'a');
});
