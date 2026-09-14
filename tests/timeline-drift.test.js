// A change that is not a Timeline step must survive a trip through the
// Timeline. A replay starts from a stored board, and every write the ledger
// did not record used to vanish on the way back: rename the board, step back,
// step forward, and the old name returned (research/old/done-2026-09-15.md,
// R5). The last test walks every board field the ledger keeps, so a field
// added later fails here until it rides a trip too.

import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

import {
  board, addItems, setTitle, setSetting, setTour, setAudioOrder, setItemThumb,
  setNoteContent, setBoardMode, undo, redo, byId, loadBoard, serializeBoard,
} from '../web/assets/js/state.ts';
import {
  REST_FIELDS, goTo, timelineSteps, timelineAt, serializeTimeline, adoptTimeline,
} from '../web/assets/js/timeline.ts';
import { fresh, photo, note } from './state-fixtures.js';

const HASH = 'a'.repeat(64);

beforeEach(() => {
  setBoardMode('desktop');
  fresh();
});

/** Back to the start of the history, then forward to its end. */
function trip() {
  const end = timelineSteps().length;
  goTo(0);
  goTo(end);
}

test('a rename survives a step back and a step forward', () => {
  addItems([photo({ x: 0, y: 0 })]);
  setTitle('Renamed');
  addItems([photo({ x: 300, y: 0 })]);
  goTo(1);
  assert.equal(board.title, 'Renamed', 'a step back lost the rename');
  goTo(2);
  assert.equal(board.title, 'Renamed', 'a step forward brought the old name back');
  goTo(0);
  assert.equal(board.title, 'Renamed', 'the start of the history lost the rename');
});

test('a rename after the last step survives a trip', () => {
  addItems([photo({ x: 0, y: 0 })]);
  addItems([photo({ x: 300, y: 0 })]);
  setTitle('Late');
  trip();
  assert.equal(board.title, 'Late');
});

test('a setting, the tour and the playlist order survive a trip', () => {
  const [a] = addItems([photo({ x: 0, y: 0 })]);
  setSetting('grid', !board.settings.grid);
  const grid = board.settings.grid;
  setTour([{ cards: [a.id], caption: 'first' }]);
  setAudioOrder([a.id]);
  addItems([photo({ x: 300, y: 0 })]);
  trip();
  assert.equal(board.settings.grid, grid);
  assert.deepEqual(board.tour, [{ cards: [a.id], caption: 'first' }]);
  assert.deepEqual(board.audioOrder, [a.id]);
});

test('a quiet card write survives a trip back past the card', () => {
  const [a] = addItems([photo({ x: 0, y: 0 })]);
  addItems([photo({ x: 300, y: 0 })]);
  setItemThumb(a.id, HASH);
  trip();
  assert.equal(byId(a.id)?.meta?.thumb, HASH, 'the card came back without its thumbnail');
});

test('a quiet write carries into the past without dragging later edits along', () => {
  const [n] = addItems([note({ x: 0, y: 0, meta: { text: 'first' } })]);
  setNoteContent(n.id, null, 'second');
  setItemThumb(n.id, HASH);
  goTo(1);
  assert.equal(byId(n.id)?.meta?.text, 'first', 'the thumbnail dragged the later text into the past');
  assert.equal(byId(n.id)?.meta?.thumb, HASH);
  goTo(2);
  assert.equal(byId(n.id)?.meta?.text, 'second');
});

test('an undo is not mistaken for drift', () => {
  const [a] = addItems([photo({ x: 0, y: 0 })]);
  setTitle('Kept');
  addItems([photo({ x: 300, y: 0 })]);
  undo();
  assert.equal(timelineAt(), 1);
  // Back to the start and forward to where the undo left the marker.
  goTo(0);
  goTo(1);
  assert.equal(board.items.length, 1, 'the undone card came back on a trip');
  assert.ok(byId(a.id));
  assert.equal(board.title, 'Kept');
  redo();
  assert.equal(board.items.length, 2);
});

test('a reopened board keeps the drift in its stored history', () => {
  addItems([photo({ x: 0, y: 0 })]);
  setTitle('Saved name');
  addItems([photo({ x: 300, y: 0 })]);
  const doc = serializeBoard();
  const history = JSON.parse(JSON.stringify(serializeTimeline()));
  loadBoard(doc);
  adoptTimeline(history);
  trip();
  assert.equal(board.title, 'Saved name');
});

/** A value of the same shape as `current`, and different from it. */
function drifted(field, current) {
  const id = board.items[0].id;
  switch (field) {
    case 'title': return 'Drifted title';
    case 'view': return { pan: { x: 11, y: 22 }, zoom: 1.5 };
    case 'arrangement': return current === 'grid' ? 'masonry' : 'grid';
    case 'arrangements': return { ...current, desktop: current.desktop === 'grid' ? 'masonry' : 'grid' };
    case 'mobileHeader': return { ...current, drifted: true };
    case 'titleHidden': return !current;
    case 'mediaFit': return current === 'cover' ? 'contain' : 'cover';
    case 'paletteSources': return (Number(current) || 0) + 3;
    case 'connections': return [[id, board.items[1].id]];
    case 'audioOrder': return [id];
    case 'tour': return [{ cards: [id], caption: 'drift' }];
    default:
      return current && typeof current === 'object' && !Array.isArray(current)
        ? { ...current, drifted: true }
        : undefined;
  }
}

test('every field the ledger keeps survives a trip when written outside a step', () => {
  addItems([photo({ x: 0, y: 0 })]);
  addItems([photo({ x: 300, y: 0 })]);
  // Switching the layout clears the history, so it has no trip to take.
  for (const field of REST_FIELDS.filter(f => f !== 'layoutMode')) {
    const value = drifted(field, board[field]);
    assert.notEqual(value, undefined, `no drift value for board.${field} - add one to drifted()`);
    board[field] = structuredClone(value);
    trip();
    assert.deepEqual(board[field], value, `board.${field} lost a write made outside a step`);
  }
});
