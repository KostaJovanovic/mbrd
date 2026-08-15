// The undo/redo engine: what a command retains, and what the bin gives back.
//
// state.js is a module singleton, which is right for an app with one board and
// awkward for tests, so every case starts by loading an empty board. That is
// the same door opening a .mbrd goes through, so it also exercises the reset.
//
// One of six files that were tests/state.test.js, split to mirror the modules
// state.js itself was split onto - see tests/layers.test.js for that list.

import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

import {
  board, addItems, removeItems, restoreItems, emptyTrash, undo, redo, byId,
  setBoardMode, setSetting, recheckBoardGeometry, lastCommand, takeBack,
  snapshotGeom, commitGeom,
} from '../web/assets/js/state.ts';
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
  const many = addItems(Array.from({ length: 70 }, (_, i) => photo({ x: i })));
  removeItems(many.map(i => i.id));
  assert.ok(board.trash.length <= 60, `bin grew to ${board.trash.length}`);
});

test('undo puts back what the bin dropped to make room', () => {
  // A command has to reverse everything it did, and pushing the oldest entry
  // out of a full bin is something a delete does. Undo used to remove only the
  // items it had just binned, so on a full bin the entry that fell out the
  // bottom - the one nearest to being unrecoverable already - was gone for good.
  const first = addItems(Array.from({ length: 60 }, (_, i) => photo({ x: i, name: `old${i}.png` })));
  removeItems(first.map(i => i.id));
  const oldest = board.trash[board.trash.length - 1].item.name;
  assert.equal(board.trash.length, 60);

  const [extra] = addItems([photo({ name: 'new.png' })]);
  removeItems([extra.id]);
  assert.equal(board.trash.length, 60, 'the bin should still be at its ceiling');
  assert.ok(!board.trash.some(t => t.item.name === oldest), 'the oldest should have been pushed out');

  undo();
  assert.equal(board.trash.length, 60, 'undo should leave the bin as it found it');
  assert.equal(board.trash[board.trash.length - 1].item.name, oldest, 'the evicted entry did not come back');
});

test('redo evicts again rather than growing the bin', () => {
  const first = addItems(Array.from({ length: 60 }, (_, i) => photo({ x: i })));
  removeItems(first.map(i => i.id));
  const [extra] = addItems([photo({ name: 'new.png' })]);
  removeItems([extra.id]);
  undo();
  redo();
  assert.equal(board.trash.length, 60);
  assert.equal(board.trash[0].item.name, 'new.png');
});

// ---------------------------------------------------------------------------
// Taking back your own command
// ---------------------------------------------------------------------------
//
// Not undo. Undo is a step the user takes through their own history; this is a
// caller withdrawing something it did itself - composeNote(), which makes a real
// note before there is anything written on it and has to be able to un-make it.
// The whole value of it is the check: the caller holds the command it made and
// asks whether that is still the newest thing, rather than assuming it.

test('a command taken back is undone and leaves no trace on either stack', () => {
  const [a] = addItems([photo({ x: 0, y: 0 })]);
  const cmd = lastCommand();
  assert.equal(board.items.length, 1);

  assert.equal(takeBack(cmd), true);
  assert.equal(board.items.length, 0);
  assert.equal(byId(a.id), undefined);
  // Neither half of the history knows it happened: nothing to redo, and the
  // undo before it is untouched.
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
  // What a caller passes when whatever it did committed nothing at all - the
  // case that would otherwise take back somebody else's command.
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
// The count cap says nothing about cost: a nudge of two cards and a nudge of
// ten thousand both count as one, while the second retains two snapshots of the
// whole board. Two hundred of those is a board's geometry held twenty times
// over, and it is the boards big enough for that to matter that can least
// afford it. So a command may declare its weight, and the stack evicts on the
// total as well as on the count.

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
  // Undo moves the entry to the redo stack, so the undo stack no longer holds it.
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
  // Four commands at 20000 apiece is 80000, past the 50000 ceiling.
  for (const label of ['first', 'second', 'third', 'fourth']) {
    commit(label, () => {}, () => {}, 20000);
  }
  assert.ok(historyWeight() <= 50000, `expected eviction, held ${historyWeight()}`);
  assert.equal(historyState().undo, 'fourth', 'the newest survives');
  // The oldest went; walking back must not reach it.
  const seen = [];
  for (let i = 0; i < 4; i++) { if (historyState().undo) seen.push(historyState().undo); undo(); }
  // An empty walk contains nothing, 'first' included, so `!seen.includes(...)`
  // was satisfied by an eviction that took the whole stack - which is the other
  // way this can go wrong and the worse one.
  assert.ok(seen.length > 0, 'the eviction emptied the stack rather than trimming it');
  assert.ok(!seen.includes('first'), 'the oldest was evicted');
  clearHistory();
});

test('a single command heavier than the whole budget is still undoable', async () => {
  // The one thing the user most likely wants back must not be the one thing
  // that cannot be: evicting down to nothing would make the heaviest operation
  // the only un-undoable one.
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
  // The whole of A-01: the flag used to be written outside the command the
  // geometry pushed, so one Ctrl+Z left the panel claiming a snapped board with
  // nothing on it snapped - a state nobody could have produced by hand.
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
  // settings.snap and layoutSettings[mode].snap are one value in two places, and
  // a mirror left behind puts the lie back at the next layout switch.
  fresh([photo({ id: 'card', x: 13, y: 27, w: 201, h: 137 })]);
  setSetting('snap', true);
  assert.equal(board.layoutSettings.desktop.snap, true);
  undo();
  assert.equal(board.layoutSettings.desktop.snap, false);
  redo();
  assert.equal(board.layoutSettings.desktop.snap, true);
});

test('an empty board can still be snapped and unsnapped', () => {
  // Nothing moved is not nothing happened: there is no geometry to take back, so
  // the flag is written outside history the way every other setting is.
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
  // A reload is not an edit by itself: the board is already flush, so this must
  // neither move anything nor push a command that could flip the flag back.
  recheckBoardGeometry();
  assert.equal(board.settings.snap, true);
  undo();
  assert.equal(board.settings.snap, false, 'only the original toggle was in history');
});

test('a card deleted mid-gesture leaves the pair describing one set of cards', () => {
  // snapshotGeom() drops an id whose item is gone, so `after` is a subset of
  // `before` - and commitGeom() paired the two arrays by index. Marquee-drag
  // five cards, delete one mid-gesture, release: from the deleted card onwards
  // each `after[i]` was compared against a different item's `before[i]`, so the
  // change test, the presnap invalidation and the fence-resize detection all
  // read unrelated items.
  //
  // What is checkable from here is the committed pair. `b` is the middle card,
  // so an index pairing puts `c`'s new position against `b`'s old one - and the
  // undo half then carries three entries for two cards.
  fresh([
    photo({ id: 'a', x: 0, y: 0 }),
    photo({ id: 'b', x: 100, y: 0 }),
    photo({ id: 'c', x: 200, y: 0 }),
  ]);
  const before = snapshotGeom(['a', 'b', 'c']);
  for (const id of ['a', 'b', 'c']) byId(id).x += 40;
  // Through the mutation door, so the id index goes with it - which is what
  // makes snapshotGeom() answer two entries where `before` has three.
  removeItems(['b']);
  commitGeom('Move', before, ['a', 'b', 'c']);

  assert.equal(byId('a').x, 40);
  assert.equal(byId('c').x, 240);
  // The entry weighs what it actually holds - two cards, not three.
  assert.equal(lastCommand().weight, 4,
    'the committed pair still carries the card that left the board');
});
