// Relations that name a card by id, kept true through the writes that change
// the id or the list (research/bug-hunt-2026-09-23.md): a retype gives the card
// a fresh id (M6), and the undo of a removed tour stop put back a whole tour (L3).

import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

import {
  board, loadBoard, retypeItem, undo, redo, setBoardMode, removeTourStop, setTour,
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
