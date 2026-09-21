// The undo/redo engine: what a command retains, and what the bin gives back.
// state.ts is a module singleton, so every case starts by loading an empty
// board, exercising the reset too. One of six files split from
// tests/state.test.js to mirror state.ts's own split; see tests/layers.test.js.

import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

import {
  board, addItems, removeItems, restoreItems, emptyTrash, undo, redo, byId,
  setBoardMode, setSetting, recheckBoardGeometry, lastCommand, takeBack,
  snapshotGeom, commitGeom, bus,
} from '../web/assets/js/state.ts';
import { TRASH_LIMIT } from '../web/assets/js/board-model.ts';
import { fresh, photo } from './state-fixtures.js';

beforeEach(() => {
  setBoardMode('desktop');
  fresh();
});
// ---------------------------------------------------------------------------
// Items and history
// ---------------------------------------------------------------------------

test('adding items puts them on the board and can be undone', () => {
  const [a] = addItems([photo({ x: 0, y: 0 })]);
  assert.equal(board.items.length, 1);
  assert.ok(undo());
  assert.equal(board.items.length, 0);
  assert.ok(redo());
  assert.equal(byId(a.id).id, a.id);
});

test('undo with nothing to undo is a no-op, not an error', () => {
  assert.equal(undo(), false);
  assert.equal(redo(), false);
});

test('a new action clears the redo branch', () => {
  addItems([photo()]);
  undo();
  addItems([photo()]);
  assert.equal(redo(), false, 'redo should have been discarded');
});

test('deleting sends items to the bin and undo takes them back out', () => {
  const [a] = addItems([photo()]);
  removeItems([a.id]);
  assert.equal(board.items.length, 0);
  assert.equal(board.trash.length, 1);
  undo();
  assert.equal(board.items.length, 1);
  assert.equal(board.trash.length, 0, 'undoing a delete must empty the bin entry too');
});

test('undo restores an item to its old place in the stack', () => {
  const [a, b, c] = addItems([photo({ x: 0 }), photo({ x: 1 }), photo({ x: 2 })]);
  removeItems([b.id]);
  undo();
  assert.deepEqual(board.items.map(i => i.id), [a.id, b.id, c.id]);
});

test('restoring from the bin puts the item on top', () => {
  const [a] = addItems([photo()]);
  const [b] = addItems([photo()]);
  removeItems([a.id]);
  const [back] = restoreItems([a.id]);
  assert.ok(back.z > byId(b.id).z, 'a restored item must not come back underneath');
});

test('restoring to a point moves it there', () => {
  const [a] = addItems([photo({ x: 0, y: 0 })]);
  removeItems([a.id]);
  const [back] = restoreItems([a.id], { x: 500, y: -300 });
  assert.equal(back.x, 500);
  assert.equal(back.y, -300);
});

test('emptying the bin is undoable', () => {
  const [a] = addItems([photo()]);
  removeItems([a.id]);
  emptyTrash();
  assert.equal(board.trash.length, 0);
  undo();
  assert.equal(board.trash.length, 1, 'emptying the bin by accident is a bad afternoon');
});

test('the bin has a ceiling', () => {
  const many = addItems(Array.from({ length: TRASH_LIMIT + 10 }, (_, i) => photo({ x: i })));
  removeItems(many.map(i => i.id));
  assert.ok(board.trash.length <= TRASH_LIMIT, `bin grew to ${board.trash.length}`);
});

test('undo puts back what the bin dropped to make room', () => {
  // A command must reverse everything it did, including the eviction a
  // delete causes on a full bin. Undo used to remove only the items it had
  // just binned, so the evicted entry was gone for good.
  const first = addItems(Array.from({ length: TRASH_LIMIT }, (_, i) => photo({ x: i, name: `old${i}.png` })));
  removeItems(first.map(i => i.id));
  const oldest = board.trash[board.trash.length - 1].item.name;
  assert.equal(board.trash.length, TRASH_LIMIT);

  const [extra] = addItems([photo({ name: 'new.png' })]);
  removeItems([extra.id]);
  assert.equal(board.trash.length, TRASH_LIMIT, 'the bin should still be at its ceiling');
  assert.ok(!board.trash.some(t => t.item.name === oldest), 'the oldest should have been pushed out');

  undo();
  assert.equal(board.trash.length, TRASH_LIMIT, 'undo should leave the bin as it found it');
  assert.equal(board.trash[board.trash.length - 1].item.name, oldest, 'the evicted entry did not come back');
});

test('redo evicts again rather than growing the bin', () => {
  const first = addItems(Array.from({ length: TRASH_LIMIT }, (_, i) => photo({ x: i })));
  removeItems(first.map(i => i.id));
  const [extra] = addItems([photo({ name: 'new.png' })]);
  removeItems([extra.id]);
  undo();
  redo();
  assert.equal(board.trash.length, TRASH_LIMIT);
  assert.equal(board.trash[0].item.name, 'new.png');
});

test('the delete that fills the bin warns before anything is dropped', () => {
  const heard = [];
  const full = () => heard.push('full');
  const evicted = n => heard.push(`evicted ${n}`);
  bus.on('trash:full', full);
  bus.on('trash:evicted', evicted);
  try {
    const first = addItems(Array.from({ length: TRASH_LIMIT - 1 }, (_, i) => photo({ x: i })));
    removeItems(first.map(i => i.id));
    assert.deepEqual(heard, [], 'a bin with room left says nothing');
    const [last] = addItems([photo()]);
    removeItems([last.id]);
    assert.deepEqual(heard, ['full'], 'the delete that fills it is the warning');
    const [over] = addItems([photo()]);
    removeItems([over.id]);
    assert.deepEqual(heard, ['full', 'evicted 1'], 'the next one drops, and says so instead');
    undo();
    redo();
    assert.deepEqual(heard, ['full', 'evicted 1'], 'undo and redo announce nothing');
  } finally {
    bus.off('trash:full', full);
    bus.off('trash:evicted', evicted);
  }
});

// ---------------------------------------------------------------------------
// Taking back your own command
// ---------------------------------------------------------------------------
//
// Not undo - a caller (composeNote()) withdrawing something it made itself,
// only if that command is still the newest thing in history.

test('a command taken back is undone and leaves no trace on either stack', () => {
  const [a] = addItems([photo({ x: 0, y: 0 })]);
  const cmd = lastCommand();
  assert.equal(board.items.length, 1);

  assert.equal(takeBack(cmd), true);
  assert.equal(board.items.length, 0);
  assert.equal(byId(a.id), undefined);
  // Neither history stack knows it happened.
  assert.equal(redo(), false, 'a withdrawn command must not be redoable');
  assert.equal(undo(), false, 'and must not have left an entry to undo');
});

test('a command is not taken back once something else has happened', () => {
  const [a] = addItems([photo({ x: 0, y: 0 })]);
  const cmd = lastCommand();
  const [b] = addItems([photo({ x: 40, y: 0 })]);

  assert.equal(takeBack(cmd), false, 'it is no longer the last thing that happened');
  assert.equal(board.items.length, 2, 'and nothing was undone in its place');
  assert.ok(byId(a.id) && byId(b.id));
});

test('taking back nothing is false rather than an error', () => {
  // What a caller passes when it committed nothing - otherwise this would
  // take back somebody else's command.
  assert.equal(takeBack(null), false);
  assert.equal(takeBack(undefined), false);
});

test('the last command is the one just committed, and null on a fresh board', () => {
  assert.equal(lastCommand(), null);
  addItems([photo()]);
  const first = lastCommand();
  assert.ok(first);
  addItems([photo({ x: 40 })]);
  assert.notEqual(lastCommand(), first, 'each command is its own token');
});

// ---------------------------------------------------------------------------
// History is bounded by what it retains, not only by how many entries it has
// ---------------------------------------------------------------------------
//
// The count cap ignores cost: nudging two cards and nudging ten thousand both
// count as one, though the second retains two whole-board snapshots. So a
// command may declare its weight, and the stack evicts on total as well as count.

test('an unweighted command counts as one, whatever it does', async () => {
  const { commit, clearHistory, historyWeight } =
    await import('../web/assets/js/history.ts');
  clearHistory();
  for (let i = 0; i < 5; i++) commit('edit', () => {}, () => {});
  assert.equal(historyWeight(), 5);
  clearHistory();
});

test('a weighted command carries its weight, and undo gives it back', async () => {
  const { commit, undo, redo, clearHistory, historyWeight } =
    await import('../web/assets/js/history.ts');
  clearHistory();
  commit('move the board', () => {}, () => {}, 1000);
  assert.equal(historyWeight(), 1000);
  // Undo moves the entry to the redo stack.
  undo();
  assert.equal(historyWeight(), 0, 'an undone command is not held by the undo stack');
  redo();
  assert.equal(historyWeight(), 1000, 'and redoing takes it back');
  clearHistory();
});

test('the weight limit evicts the oldest, and never the last', async () => {
  const { commit, undo, clearHistory, historyWeight, historyState } =
    await import('../web/assets/js/history.ts');
  clearHistory();
  // Four at 20000 apiece is 80000, past the 50000 ceiling.
  for (const label of ['first', 'second', 'third', 'fourth']) {
    commit(label, () => {}, () => {}, 20000);
  }
  assert.ok(historyWeight() <= 50000, `expected eviction, held ${historyWeight()}`);
  assert.equal(historyState().undo, 'fourth', 'the newest survives');
  // The oldest went; walking back must not reach it.
  const seen = [];
  for (let i = 0; i < 4; i++) { if (historyState().undo) seen.push(historyState().undo); undo(); }
  // An empty walk also satisfies `!seen.includes('first')` - guard against
  // an eviction that took the whole stack, the worse failure mode.
  assert.ok(seen.length > 0, 'the eviction emptied the stack rather than trimming it');
  assert.ok(!seen.includes('first'), 'the oldest was evicted');
  clearHistory();
});

test('a single command heavier than the whole budget is still undoable', async () => {
  // Evicting down to nothing would make the heaviest operation - the one
  // most likely wanted back - the only un-undoable one.
  const { commit, clearHistory, historyState } = await import('../web/assets/js/history.ts');
  clearHistory();
  commit('import everything', () => {}, () => {}, 500000);
  assert.equal(historyState().undo, 'import everything');
  clearHistory();
});


// ---------------------------------------------------------------------------
// Snapping: the flag and the geometry are one command
// ---------------------------------------------------------------------------

test('undoing snap-to-grid takes back the setting as well as the geometry', () => {
  // A-01: the flag used to be written outside the geometry's command, so one
  // Ctrl+Z left the panel claiming a snapped board with nothing snapped on it.
  fresh([photo({ id: 'card', x: 13, y: 27, w: 201, h: 137 })]);
  const before = { x: byId('card').x, y: byId('card').y, w: byId('card').w, h: byId('card').h };

  setSetting('snap', true);
  assert.equal(board.settings.snap, true);
  assert.notDeepEqual(
    { x: byId('card').x, y: byId('card').y, w: byId('card').w, h: byId('card').h },
    before, 'snapping should have moved the card');

  assert.ok(undo());
  assert.equal(board.settings.snap, false, 'the setting must come back with the geometry');
  assert.deepEqual(
    { x: byId('card').x, y: byId('card').y, w: byId('card').w, h: byId('card').h }, before);

  assert.ok(redo());
  assert.equal(board.settings.snap, true, 'and go forward with it again');
  assert.notDeepEqual(
    { x: byId('card').x, y: byId('card').y, w: byId('card').w, h: byId('card').h }, before);
});

test('undoing "leave the grid" puts the board back on it with the box ticked', () => {
  fresh([photo({ id: 'card', x: 13, y: 27, w: 201, h: 137 })]);
  setSetting('snap', true);
  const snapped = { x: byId('card').x, y: byId('card').y, w: byId('card').w, h: byId('card').h };

  setSetting('snap', false);
  assert.equal(board.settings.snap, false);

  assert.ok(undo());
  assert.equal(board.settings.snap, true, 'the mirror case is the same case');
  assert.deepEqual(
    { x: byId('card').x, y: byId('card').y, w: byId('card').w, h: byId('card').h }, snapped);
});

test('the layout profile mirror of the snap flag tracks undo and redo', () => {
  // settings.snap and layoutSettings[mode].snap are one value in two places -
  // a mirror left behind lies at the next layout switch.
  fresh([photo({ id: 'card', x: 13, y: 27, w: 201, h: 137 })]);
  setSetting('snap', true);
  assert.equal(board.layoutSettings.desktop.snap, true);
  undo();
  assert.equal(board.layoutSettings.desktop.snap, false);
  redo();
  assert.equal(board.layoutSettings.desktop.snap, true);
});

test('an empty board can still be snapped and unsnapped', () => {
  // Nothing moved is not nothing happened: with no geometry to take back, the
  // flag is written outside history like any other setting.
  fresh();
  setSetting('snap', true);
  assert.equal(board.settings.snap, true);
  assert.equal(board.layoutSettings.desktop.snap, true);
  setSetting('snap', false);
  assert.equal(board.settings.snap, false);
});

test('re-asserting the grid on load never touches the setting', () => {
  fresh([photo({ id: 'card', x: 13, y: 27, w: 201, h: 137 })]);
  setSetting('snap', true);
  // A reload is not an edit: the board is already flush, so this must not
  // move anything or push a command that could flip the flag back.
  recheckBoardGeometry();
  assert.equal(board.settings.snap, true);
  undo();
  assert.equal(board.settings.snap, false, 'only the original toggle was in history');
});

test('a card deleted mid-gesture leaves the pair describing one set of cards', () => {
  // snapshotGeom() drops an id whose item is gone, so `after` is a subset of
  // `before`, and commitGeom() paired the two arrays by index - deleting a
  // card mid-gesture shifted every later `after[i]` against the wrong
  // `before[i]`. `b` is the middle card, so this checks `c`'s new position
  // is not compared against `b`'s old one.
  fresh([
    photo({ id: 'a', x: 0, y: 0 }),
    photo({ id: 'b', x: 100, y: 0 }),
    photo({ id: 'c', x: 200, y: 0 }),
  ]);
  const before = snapshotGeom(['a', 'b', 'c']);
  for (const id of ['a', 'b', 'c']) byId(id).x += 40;
  // removeItems() drops the id from the index, so snapshotGeom() below
  // answers two entries where `before` has three.
  removeItems(['b']);
  commitGeom('Move', before, ['a', 'b', 'c']);

  assert.equal(byId('a').x, 40);
  assert.equal(byId('c').x, 240);
  // Weighs what it actually holds - two cards, not three.
  assert.equal(lastCommand().weight, 4,
    'the committed pair still carries the card that left the board');
});
