// The step ledger: what gets written down, what collapses, and the one
// check that matters - the last test in this file, the safety net for the
// phase that follows. Phase 1 of research/old/timeline-2026-08-14.md runs the old
// closure-based undo beside the new record-based one *and asserts they
// agree*, since "replay and undo produce the same board" is the strongest
// claim possible without a browser-driven suite. Phase 2 deletes one
// engine, safe only while this test is green. Everything else here is the
// small print: what makes changes collapse into one step, and what doesn't.

import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

import {
  board, addItems, removeItems, restoreItems, renameItem, undo, redo, byId,
  setBoardMode, snapshotGeom, commitGeom, lastCommand, takeBack, loadBoard,
  historyDepth, historyState, renameBoard, commitHeader, setSetting, commitAppearance,
  serializeBoard,
} from '../web/assets/js/state.ts';
import {
  timelineSteps, timelineAt, timelineStale, timelineHashes, replayTo, goTo,
  serializeTimeline, fingerprint, registerOp, declareOp, editStep, stepEditable,
  trimmable, trimTimeline, adoptTimeline, deleteStep, deleteAhead,
} from '../web/assets/js/timeline.ts';
import { packBoard, unpackBoard } from '../web/assets/js/storage/mbrd.ts';
import { fresh, photo, note } from './state-fixtures.js';

beforeEach(() => {
  setBoardMode('desktop');
  fresh();
});

/** Move a card the way a finished drag does: mutate, then close the gesture. */
function move(id, dx, dy) {
  const before = snapshotGeom([id]);
  const item = byId(id);
  item.x += dx;
  item.y += dy;
  commitGeom('Move', before, [id]);
}

const labels = () => timelineSteps().map(s => s.label);

// ---------------------------------------------------------------------------
// What gets written down
// ---------------------------------------------------------------------------

test('a change lands one step on the ledger', () => {
  assert.equal(timelineSteps().length, 0);
  addItems([photo({ x: 0, y: 0 })]);
  assert.equal(timelineSteps().length, 1);
  assert.equal(timelineAt(), 1);
});

test('a fresh board starts the ledger over', () => {
  addItems([photo({ x: 0, y: 0 })]);
  fresh();
  assert.equal(timelineSteps().length, 0);
  assert.equal(timelineAt(), 0);
});

test('the step records both sides, so it can be walked either way', () => {
  const [a] = addItems([photo({ x: 0, y: 0 })]);
  move(a.id, 40, 0);
  const [step] = timelineSteps().slice(-1);
  const pair = step.delta.desktop.changed[a.id];
  assert.equal(JSON.parse(pair[0]).x, 0);
  assert.equal(JSON.parse(pair[1]).x, 40);
});

// ---------------------------------------------------------------------------
// Runs: what makes two changes one step
// ---------------------------------------------------------------------------

test('moving the same card twice with nothing in between is one step', () => {
  const [a] = addItems([photo({ x: 0, y: 0 })]);
  move(a.id, 10, 0);
  move(a.id, 10, 0);
  move(a.id, 10, 0);
  // One for the add, one for all three moves - twelve arrow-key taps are
  // twelve commits and one intention; the strip shows the intention.
  assert.deepEqual(labels(), ['Add', 'Move']);
});

test('the collapsed step keeps the first position and the last', () => {
  const [a] = addItems([photo({ x: 0, y: 0 })]);
  move(a.id, 10, 0);
  move(a.id, 10, 0);
  const [step] = timelineSteps().slice(-1);
  const pair = step.delta.desktop.changed[a.id];
  assert.equal(JSON.parse(pair[0]).x, 0);
  assert.equal(JSON.parse(pair[1]).x, 20);
});

test('moving one card and then another is two steps', () => {
  const [a, b] = addItems([photo({ x: 0, y: 0 }), photo({ x: 500, y: 0 })]);
  move(a.id, 10, 0);
  move(b.id, 10, 0);
  assert.deepEqual(labels(), ['Add', 'Move', 'Move']);
});

test('moving a card and then renaming it is two steps', () => {
  const [a] = addItems([photo({ x: 0, y: 0 })]);
  move(a.id, 10, 0);
  renameItem(a.id, 'Renamed');
  // Same card, different fields, two intentions - folding them together
  // would hide one behind the other.
  assert.equal(timelineSteps().length, 3);
});

test('a run that ends where it started leaves no step at all', () => {
  const [a] = addItems([photo({ x: 0, y: 0 })]);
  move(a.id, 40, 0);
  move(a.id, -40, 0);
  // Not a step with nothing in it - no step. A dot for an action with no
  // effect is worse than no dot.
  assert.deepEqual(labels(), ['Add']);
});

test('a run closes when something else happens in between', () => {
  const [a, b] = addItems([photo({ x: 0, y: 0 }), photo({ x: 500, y: 0 })]);
  move(a.id, 10, 0);
  move(b.id, 10, 0);
  move(a.id, 10, 0);
  // The middle move is the something else. A run only ever merges with the
  // step immediately before it.
  assert.deepEqual(labels(), ['Add', 'Move', 'Move', 'Move']);
});

test('an add is never folded into the move that follows it', () => {
  const [a] = addItems([photo({ x: 0, y: 0 })]);
  move(a.id, 10, 0);
  // A card arriving has nothing on the before side of its pair - collapsing
  // "added" into "moved" would lose the add.
  assert.deepEqual(labels(), ['Add', 'Move']);
});

test('repeated renames of the same card collapse', () => {
  const [a] = addItems([photo({ x: 0, y: 0 })]);
  renameItem(a.id, 'One');
  renameItem(a.id, 'Two');
  renameItem(a.id, 'Three');
  // Same shape as a colour slider dragged across its range: one field
  // written over and over, one thing the person meant.
  assert.deepEqual(labels(), ['Add', 'Rename']);
});

// ---------------------------------------------------------------------------
// The marker
// ---------------------------------------------------------------------------

test('undo and redo move the marker without adding steps', () => {
  addItems([photo({ x: 0, y: 0 })]);
  addItems([note({ x: 300, y: 0 })]);
  assert.equal(timelineAt(), 2);
  undo();
  assert.equal(timelineAt(), 1);
  assert.equal(timelineSteps().length, 2);
  redo();
  assert.equal(timelineAt(), 2);
  assert.equal(timelineSteps().length, 2);
});

test('doing something new after an undo drops what the undo took', () => {
  addItems([photo({ x: 0, y: 0 })]);
  addItems([note({ x: 300, y: 0 })]);
  undo();
  addItems([photo({ x: 600, y: 0 })]);
  // Truncation, the way undo behaves everywhere. A trip on the Timeline
  // inserts instead - the tests below.
  assert.equal(timelineSteps().length, 2);
  assert.equal(timelineAt(), 2);
});

test('an edit from a point on the Timeline keeps the steps ahead', () => {
  const [a] = addItems([photo({ x: 0, y: 0 })]);
  move(a.id, 40, 0);
  const [b] = addItems([note({ x: 300, y: 0 })]);
  goTo(1);
  const [c] = addItems([photo({ x: 600, y: 0 })]);
  // In at the marker, the way a CAD history inserts a feature, with the
  // later two still ahead of it. Dropping them lost every step after the
  // point somebody went back to.
  assert.deepEqual(labels(), ['Add', 'Add', 'Move', 'Add']);
  assert.equal(timelineAt(), 2);
  assert.equal(byId(a.id).x, 0, 'the board stays where the edit was made');
  goTo(timelineSteps().length);
  assert.equal(byId(a.id).x, 40);
  assert.ok(byId(b.id));
  assert.ok(byId(c.id), 'the card added in the past reaches the present');
});

test('a later step keeps what it changed, and only that', () => {
  const [a] = addItems([photo({ x: 0, y: 0 })]);
  move(a.id, 40, 0);
  goTo(1);
  renameItem(a.id, 'Early');
  move(a.id, 0, 99);
  goTo(timelineSteps().length);
  // The later move wrote x and nothing else, so the name and the y from the
  // past both survive it.
  assert.equal(byId(a.id).x, 40);
  assert.equal(byId(a.id).y, 99);
  assert.equal(byId(a.id).name, 'Early');
});

test('a card deleted in the past stays deleted, whatever came after', () => {
  const [a] = addItems([photo({ x: 0, y: 0 })]);
  const [b] = addItems([photo({ x: 300, y: 0 })]);
  move(a.id, 40, 0);
  goTo(2);
  removeItems([a.id]);
  goTo(timelineSteps().length);
  // apply() alone would have written the moved card back whole.
  assert.ok(!byId(a.id), 'the later move brought the card back');
  assert.ok(byId(b.id));
});

test('an edit after a trip back starts its own step', () => {
  const [a] = addItems([photo({ x: 0, y: 0 })]);
  move(a.id, 40, 0);
  addItems([note({ x: 300, y: 0 })]);
  goTo(2);
  move(a.id, 40, 0);
  // Same card and field as step two, but folding into it would lose the
  // board step two was, with the card at 40.
  assert.deepEqual(labels(), ['Add', 'Move', 'Move', 'Add']);
  goTo(2);
  assert.equal(byId(a.id).x, 40);
});

test('undo after an edit in the past takes only that edit with the next one', () => {
  const [a] = addItems([photo({ x: 0, y: 0 })]);
  move(a.id, 40, 0);
  goTo(1);
  addItems([note({ x: 300, y: 0 })]);
  undo();
  renameItem(a.id, 'Instead');
  // The undone add goes, as after any undo. The move the Timeline went back
  // past stays.
  assert.deepEqual(labels(), ['Add', 'Rename', 'Move']);
  assert.equal(timelineAt(), 2);
});

test('taking back an edit made in the past keeps the steps ahead', () => {
  const [a] = addItems([photo({ x: 0, y: 0 })]);
  move(a.id, 40, 0);
  goTo(1);
  addItems([note({ x: 300, y: 0 })]);
  assert.equal(takeBack(lastCommand()), true);
  assert.deepEqual(labels(), ['Add', 'Move']);
  assert.equal(timelineAt(), 1);
  goTo(2);
  assert.equal(byId(a.id).x, 40);
});

test('a replay after an edit in the past starts from a checkpoint that has it', () => {
  const [a] = addItems([photo({ x: 0, y: 0 })]);
  const [b] = addItems([photo({ x: 300, y: 0 })]);
  // Past CHECKPOINT_EVERY (50), so the trip forward starts from a mark.
  for (let i = 0; i < 30; i += 1) { move(a.id, 10, 0); move(b.id, 10, 0); }
  assert.ok(timelineSteps().length > 50, 'the fixture needs a checkpoint ahead');
  goTo(2);
  renameItem(b.id, 'Early');
  goTo(timelineSteps().length);
  // A mark recorded before the edit would replay a board without the name.
  assert.equal(byId(b.id).name, 'Early');
  assert.equal(byId(a.id).x, 300);
  assert.equal(byId(b.id).x, 600);
});

// ---------------------------------------------------------------------------
// The two layouts
// ---------------------------------------------------------------------------

test('switching between the Canvas and the Feed keeps the history', () => {
  const [a] = addItems([photo({ x: 0, y: 0 })]);
  move(a.id, 40, 0);
  const top = timelineSteps().length;
  setBoardMode('mobile');
  // It used to be wiped here, on every trip to the Feed or the Playlist.
  assert.equal(timelineSteps().length, top);
  assert.equal(timelineAt(), top);
  // The closures hold the Canvas's places, so they go, and undo walks the ledger.
  assert.equal(historyDepth().undo, 0);
  setBoardMode('desktop');
  assert.equal(byId(a.id).x, 40);
  goTo(1);
  assert.equal(byId(a.id).x, 0);
  goTo(top);
  assert.equal(byId(a.id).x, 40);
});

test('a move is a place in one layout, and a trip in the other leaves it alone', () => {
  const [a] = addItems([photo({ x: 0, y: 0 })]);
  move(a.id, 40, 0);
  setBoardMode('mobile');
  const tile = () => ({ x: byId(a.id).x, y: byId(a.id).y });
  const feed = tile();
  renameItem(a.id, 'Named on the Feed');
  goTo(1);
  // The Canvas move is not the Feed's to replay.
  assert.deepEqual(tile(), feed);
  assert.notEqual(byId(a.id).name, 'Named on the Feed');
  goTo(timelineSteps().length);
  assert.equal(byId(a.id).name, 'Named on the Feed');
  setBoardMode('desktop');
  assert.equal(byId(a.id).x, 40);
  assert.equal(byId(a.id).name, 'Named on the Feed');
});

test('undo after a switch takes back a whole step from the ledger', () => {
  const [a] = addItems([photo({ x: 0, y: 0 })]);
  renameItem(a.id, 'Before the switch');
  setBoardMode('mobile');
  assert.equal(undo(), true);
  assert.equal(timelineAt(), 1);
  assert.notEqual(byId(a.id).name, 'Before the switch');
});

test('a history written before the layouts were kept apart is not read', () => {
  const [a] = addItems([photo({ x: 0, y: 0 })]);
  move(a.id, 40, 0);
  const old = serializeTimeline();
  assert.equal(old.version, 2);
  delete old.version;
  // Each place on its card: read as this version, every card would land wrong.
  adoptTimeline(old);
  assert.equal(timelineSteps().length, 0);
});

// ---------------------------------------------------------------------------
// The header
// ---------------------------------------------------------------------------

test('renaming the board is a step, and a run of renames is one', () => {
  addItems([photo({ x: 0, y: 0 })]);
  const first = board.title;
  renameBoard('One');
  renameBoard('Two');
  assert.deepEqual(labels(), ['Add', 'Rename board']);
  // Undo is finer than the strip, as it is for moves.
  assert.equal(undo(), true);
  assert.equal(board.title, 'One');
  redo();
  goTo(1);
  assert.equal(board.title, first);
  goTo(2);
  assert.equal(board.title, 'Two');
});

test('a header slider drag is one step, from where it started', () => {
  addItems([photo({ x: 0, y: 0 })]);
  const start = board.mobileHeader;
  // What the panel does: every tick written live, one commit on release.
  setSetting('mobileHeader', { ...start, stretch: 110 });
  setSetting('mobileHeader', { ...start, stretch: 120 });
  commitHeader(board.mobileHeader, start);
  commitHeader({ ...board.mobileHeader, stretch: 130 });
  assert.deepEqual(labels(), ['Add', 'Edit header']);
  assert.equal(board.mobileHeader.stretch, 130);
  goTo(1);
  assert.equal(board.mobileHeader.stretch, start.stretch);
  goTo(2);
  assert.equal(board.mobileHeader.stretch, 130);
});

test('a whimsy change is a step, and a run of them keeps the last', () => {
  addItems([photo({ x: 0, y: 0 })]);
  const first = board.settings.appearance.whimsy;
  commitAppearance({ ...board.settings.appearance, whimsy: 2 });
  commitAppearance({ ...board.settings.appearance, whimsy: 0 });
  assert.deepEqual(labels(), ['Add', 'Whimsy']);
  assert.equal(board.settings.appearance.whimsy, 0);
  goTo(1);
  assert.equal(board.settings.appearance.whimsy, first);
  goTo(2);
  assert.equal(board.settings.appearance.whimsy, 0);
});

test('taking back a command takes back its step', () => {
  addItems([photo({ x: 0, y: 0 })]);
  const cmd = lastCommand();
  addItems([note({ x: 300, y: 0 })]);
  const withdrawn = lastCommand();
  assert.equal(takeBack(withdrawn), true);
  assert.equal(timelineSteps().length, 1);
  // Gone from both engines, so the earlier command is the top of the stack
  // again and can itself be taken back.
  assert.equal(takeBack(cmd), true);
  assert.equal(timelineSteps().length, 0);
});

// ---------------------------------------------------------------------------
// The file
// ---------------------------------------------------------------------------

test('a board with no history writes no timeline key', () => {
  assert.equal(serializeTimeline(), null);
  assert.equal('timeline' in serializeBoard(), false);
});

test('a board with a history writes one, and it round-trips', () => {
  const [a] = addItems([photo({ x: 0, y: 0 })]);
  move(a.id, 40, 0);
  const doc = serializeBoard();
  assert.equal(doc.timeline.steps.length, 2);
  loadBoard(doc);
  assert.equal(timelineSteps().length, 2);
  assert.equal(timelineStale(), false);
});

test('a history survives a .mbrd, in its own files, and a torn one is stale', async () => {
  // R21: the packer splits the ledger out of board.json and the reader puts it
  // back, so the round trip through a file must end where the one above does.
  const [a] = addItems([photo({ x: 0, y: 0 })]);
  move(a.id, 40, 0);
  const { blob } = await packBoard(serializeBoard());
  loadBoard((await unpackBoard(blob)).board);
  assert.equal(timelineSteps().length, 2);
  assert.equal(timelineAt(), 2);
  assert.equal(timelineStale(), false, 'the fingerprint still matches the board beside it');

  // The last step's line lost: the head still says two.
  const { readZip, writeZip } = await import('../web/assets/js/storage/zip.ts');
  const files = await readZip(blob);
  const body = new TextDecoder().decode(files.get('timeline/steps.jsonl'));
  files.set('timeline/steps.jsonl', new TextEncoder().encode(body.split('\n')[0] + '\n'));
  const torn = await writeZip([...files].map(([name, data]) => ({ name, data, compress: false })));
  loadBoard((await unpackBoard(torn)).board);
  assert.equal(timelineStale(), true);
});

test('a timeline that does not describe its board is marked stale', () => {
  const [a] = addItems([photo({ x: 0, y: 0 })]);
  move(a.id, 40, 0);
  const doc = serializeBoard();
  // What an older build does: drop the timeline, edit the board, hand it
  // back. The steps no longer add up to the board beside them, and a
  // history quietly describing the wrong board is worse than no history.
  doc.items[0].x = 999;
  loadBoard(doc);
  assert.equal(timelineStale(), true);
});

// A stored `base` that is not a snapshot. `raw.base as Snap` behind an
// isRecord() was the whole check, and restore() reads every Snap field
// without looking - so a file whose base was `{}`, or whose `items` held a
// number where a card belongs, adopted cleanly and threw several frames
// later, far from the file that caused it. Refusing the ledger, not
// repairing it, is the answer: a half-broken base replays to a board
// nobody had.
for (const [what, base] of [
  ['an empty object', {}],
  ['no itemOrder', { items: {}, desktop: {}, mobile: {}, trash: {}, rest: {}, trashOrder: [] }],
  ['an itemOrder of numbers', { items: {}, itemOrder: [1, 2], desktop: {}, mobile: {}, trash: {}, trashOrder: [], rest: {} }],
  ['a serialised card that is not text', { items: { i1: 7 }, itemOrder: ['i1'], desktop: {}, mobile: {}, trash: {}, trashOrder: [], rest: {} }],
  ['a base that is a list', []],
  ['no base at all', undefined],
]) {
  test(`a stored timeline with ${what} is not adopted`, () => {
    const [a] = addItems([photo({ x: 0, y: 0 })]);
    move(a.id, 40, 0);
    const doc = serializeBoard();
    assert.ok(doc.timeline.steps.length >= 2, 'the fixture needs a ledger to break');
    doc.timeline.base = base;
    loadBoard(doc);
    assert.equal(timelineSteps().length, 0,
      'a base that is not a snapshot was taken as one - a replay will throw');
  });
}

test('an asset only a step names is still referenced', () => {
  const hash = 'a'.repeat(64);
  const [a] = addItems([photo({ x: 0, y: 0, asset: { hash } })]);
  removeItems([a.id]);
  // The card is in the bin, which already counted. Emptying the bin leaves
  // only the step that put it there naming those bytes - stepping back
  // through it must put the picture on the board again.
  board.trash.length = 0;
  assert.equal(timelineHashes().has(hash), true);
});

test('the hashes come out of a stored document as well as a live ledger', () => {
  const hash = 'b'.repeat(64);
  addItems([photo({ x: 0, y: 0, asset: { hash } })]);
  const doc = serializeBoard();
  assert.equal(timelineHashes(doc.timeline).has(hash), true);
});

// ---------------------------------------------------------------------------
// Undo across a reload - phase 2
// ---------------------------------------------------------------------------

test('undo works on a board reopened with a history and no stack', () => {
  const [a] = addItems([photo({ x: 0, y: 0 })]);
  move(a.id, 40, 0);
  const doc = serializeBoard();
  // The reload: loadBoard() clears the closure stacks - the whole reason
  // undo never survived a refresh - then adopts the record.
  loadBoard(doc);
  assert.equal(historyDepth().undo, 0);
  assert.equal(historyState().undo, 'Move');
  assert.equal(undo(), true);
  assert.equal(timelineAt(), 1);
  assert.equal(byId(a.id).x, 0);
  assert.equal(redo(), true);
  assert.equal(byId(a.id).x, 40);
});

test('undo on a reopened board stops at the beginning rather than lying', () => {
  addItems([photo({ x: 0, y: 0 })]);
  loadBoard(serializeBoard());
  assert.equal(undo(), true);
  assert.equal(timelineAt(), 0);
  assert.equal(undo(), false);
  assert.equal(historyState().undo, null);
});

test('the session stack answers before the record does', () => {
  const [a] = addItems([photo({ x: 0, y: 0 })]);
  move(a.id, 10, 0);
  move(a.id, 10, 0);
  // One step on the strip, two commits this session. Undo is the finer
  // engine while it can be, so the first press takes back ten pixels, not twenty.
  assert.equal(timelineSteps().length, 2);
  assert.equal(undo(), true);
  assert.equal(byId(a.id).x, 10);
});

// ---------------------------------------------------------------------------
// Editing a step in the past - phase 4
// ---------------------------------------------------------------------------

// A stand-in for align or arrange: a rule with a parameter that re-runs to
// a different answer when the parameter changes. The real ones need a
// viewport; this tests the machinery they hang on, not layout arithmetic.
registerOp('shift-to', params => shiftTo(String(params.id), Number(params.to)));

function shiftTo(id, to) {
  const item = byId(id);
  if (!item) throw new Error('no such card');
  const before = snapshotGeom([id]);
  declareOp('shift-to', { id, to });
  item.x = to;
  commitGeom('Shift', before, [id]);
}

// A second rule doing the same thing under another name - the only way to
// test that a rule's name keeps two runs apart, as align and arrange do.
registerOp('nudge-to', params => nudgeTo(String(params.id), Number(params.to)));

function nudgeTo(id, to) {
  const item = byId(id);
  if (!item) throw new Error('no such card');
  const before = snapshotGeom([id]);
  declareOp('nudge-to', { id, to });
  item.x = to;
  commitGeom('Nudge', before, [id]);
}

test('a step that carries a rule says so', () => {
  const [a] = addItems([photo({ x: 0, y: 0 })]);
  shiftTo(a.id, 100);
  const [step] = timelineSteps().slice(-1);
  assert.equal(step.op.name, 'shift-to');
  assert.equal(stepEditable(step), true);
  // An ordinary step does not - the distinction the strip draws as a lock.
  assert.equal(stepEditable(timelineSteps()[0]), false);
});

test('editing a step in the past changes what came after it', () => {
  const [a] = addItems([photo({ x: 0, y: 0 })]);
  shiftTo(a.id, 100);
  renameItem(a.id, 'Named later');
  assert.equal(byId(a.id).x, 100);

  // Reach back into step 1 and tell it something else. Everything after it
  // replays on top of the new answer.
  assert.equal(editStep(1, { to: 250 }), true);
  assert.equal(byId(a.id).x, 250);
  // The later step is still there and still applied - a rebuild that
  // dropped it would look like it worked.
  assert.equal(byId(a.id).name, 'Named later');
});

test('a jump to a step in the past takes the session stack with it', () => {
  // goTo() (a click on a strip dot) moved the board by replay but left the
  // closure stack standing: three steps recorded, jump to step one, and two
  // stale undo entries remained. The next Ctrl+Z wrote one era's geometry
  // onto another's board and moved the marker too - a silent mix markDirty()
  // then made saveable.
  const [a] = addItems([photo({ x: 0, y: 0 })]);
  move(a.id, 40, 0);
  move(a.id, 40, 0);
  assert.ok(historyDepth().undo > 0, 'the fixture needs a session stack to lose');
  const top = timelineSteps().length;

  assert.equal(goTo(1), true);
  assert.equal(timelineAt(), 1);
  assert.equal(historyDepth().undo, 0, 'the closures from the discarded era are still there');
  // The ledger is untouched - a move through history, not an edit of it -
  // so stepping forward again is still available.
  assert.equal(timelineSteps().length, top);
  assert.equal(goTo(top), true);
  assert.equal(byId(a.id).x, 80);
});

test('a rebuild adds nothing to the ledger and leaves no stale closures', () => {
  const [a] = addItems([photo({ x: 0, y: 0 })]);
  shiftTo(a.id, 100);
  renameItem(a.id, 'X');
  const steps = timelineSteps().length;
  editStep(1, { to: 250 });
  // The rule reruns via the command that made it, and that command commits.
  // Without commit()'s pass-through, this would be three steps longer, all
  // describing a replay.
  assert.equal(timelineSteps().length, steps);
  // The session's closure stack is gone, the half this used to assert the
  // opposite of. It read `historyDepth().undo === depth` on the assumption
  // a rebuild should leave both engines alone - but a rebuild recomputes
  // every later step, so those closures point at a discarded board.
  // Ctrl+Z would restore coordinates nobody had. Undo is not lost, it is
  // *rebased*: with the stack empty it falls through to the ledger.
  assert.equal(historyDepth().undo, 0);
  assert.equal(historyState().undo, 'Rename');
});

test('a rule that cannot run is marked and skipped, and the rest still replay', () => {
  const [a] = addItems([photo({ x: 0, y: 0 })]);
  const [b] = addItems([photo({ x: 400, y: 0 })]);
  shiftTo(a.id, 100);
  renameItem(b.id, 'Survivor');
  // Points the rule at a nonexistent card - what an editable step naming a
  // card an earlier edit removed would do.
  assert.equal(editStep(2, { id: 'gone' }), true);
  const step = timelineSteps()[2];
  assert.equal(step.broken, true);
  // Broken, not fatal: the board still builds and the following step still ran.
  assert.equal(byId(b.id).name, 'Survivor');
  assert.equal(timelineSteps().length, 4);
});

test('a sealed step cannot be edited', () => {
  const [a] = addItems([photo({ x: 0, y: 0 })]);
  move(a.id, 40, 0);
  assert.equal(editStep(1, { anything: 1 }), false);
});

test('two rules in a row are one step carrying the later rule', () => {
  const [a] = addItems([photo({ x: 0, y: 0 })]);
  shiftTo(a.id, 100);
  shiftTo(a.id, 200);
  // Same card, same field - what a run is, and a rule is not exempt. Used
  // to assert three: cycling an arrangement to see what looked right left
  // a mark per press.
  assert.equal(timelineSteps().length, 2);
  const [step] = timelineSteps().slice(-1);
  // Parameters of the last press over the difference of the whole run: what
  // makes the fold sound - editing re-runs the rule settled on, and the
  // difference it replaces already spans both presses.
  assert.equal(step.op.params.to, 200);
  assert.equal(editStep(1, { to: 250 }), true);
  assert.equal(byId(a.id).x, 250);
});

test('two rules of different names over the same cards stay two steps', () => {
  const [a] = addItems([photo({ x: 0, y: 0 })]);
  shiftTo(a.id, 100);
  nudgeTo(a.id, 200);
  // Same card, same field - only the rule's name keeps them apart. Merged,
  // the step would claim to be a nudge whose difference is half a shift.
  assert.equal(timelineSteps().length, 3);
});

test('a rule does not merge with an ordinary step that moved the same card', () => {
  const [a] = addItems([photo({ x: 0, y: 0 })]);
  shiftTo(a.id, 100);
  move(a.id, 40, 0);
  shiftTo(a.id, 300);
  // The empty key used to keep a rule away from a sealed step for free; the
  // prefix does it now, and a sealed step in the middle closes the run too.
  assert.equal(timelineSteps().length, 4);
});

// ---------------------------------------------------------------------------
// Trimming - phase 5
// ---------------------------------------------------------------------------

const DAY = 86_400_000;

test('nothing is foldable while the history is recent', () => {
  const [a] = addItems([photo({ x: 0, y: 0 })]);
  move(a.id, 10, 0);
  assert.equal(trimmable(), 0);
  assert.equal(trimTimeline(), 0);
});

test('old steps fold into the starting state and the board does not move', () => {
  const [a] = addItems([photo({ x: 0, y: 0 })]);
  move(a.id, 40, 0);
  renameItem(a.id, 'Kept');
  // Age the first two. Written rather than waited for - the only way to
  // test a thirty-day rule.
  const steps = timelineSteps();
  steps[0].at = Date.now() - 60 * DAY;
  steps[1].at = Date.now() - 45 * DAY;

  assert.equal(trimmable(), 2);
  const before = fingerprint();
  assert.equal(trimTimeline(), 2);
  // The whole promise: the record gets shorter, the board is untouched. A
  // trim that moved the board would be editing somebody's work to save space.
  assert.equal(fingerprint(), before);
  assert.equal(timelineSteps().length, 1);
  assert.equal(timelineAt(), 1);
  // The folded work is still there, since it went into the starting state
  // rather than being thrown away.
  assert.equal(byId(a.id).x, 40);
});

test('a trim never crosses a step somebody named', () => {
  const [a] = addItems([photo({ x: 0, y: 0 })]);
  move(a.id, 40, 0);
  renameItem(a.id, 'Third');
  const steps = timelineSteps();
  for (const step of steps) step.at = Date.now() - 60 * DAY;
  // A saved version sits on the second step. Everything is old enough to go,
  // but the count stops short of it - folding a named point away would
  // destroy something deliberately marked.
  steps[1].name = 'Before the redesign';
  assert.equal(trimmable(), 1);
  trimTimeline();
  assert.equal(timelineSteps()[0].name, 'Before the redesign');
});

test('a trim never folds past where the board is standing', () => {
  const [a] = addItems([photo({ x: 0, y: 0 })]);
  move(a.id, 40, 0);
  for (const step of timelineSteps()) step.at = Date.now() - 60 * DAY;
  undo();
  undo();
  // The marker is at the beginning, so nothing behind it can fold - a
  // starting state describing a board the marker had not reached would be
  // describing a future.
  assert.equal(timelineAt(), 0);
  assert.equal(trimmable(), 0);
});

// ---------------------------------------------------------------------------
// The one that matters
// ---------------------------------------------------------------------------

test('replaying to a point produces the board undoing to it produces', () => {
  // Marks are keyed by where the *marker* stood, not operation count - one
  // user action is not reliably one step, since a run collapses several
  // into one and an action can commit twice. Keying on the marker asks what
  // actually matters - is the board at step five the same however you got
  // there - without predicting the ledger's arithmetic.
  const start = fingerprint();
  assert.equal(timelineAt(), 0);

  let a;
  let b;
  const ops = [
    () => { [a] = addItems([photo({ x: 0, y: 0 })]); },
    () => move(a.id, 40, 0),
    () => renameItem(a.id, 'One'),
    () => { [b] = addItems([note({ x: 400, y: 0 })]); },
    () => move(b.id, 0, 30),
    () => renameItem(a.id, 'Two'),
    () => removeItems([a.id]),
    () => restoreItems([a.id]),
    () => move(b.id, 20, 0),
  ];
  const marks = new Map([[0, start]]);
  for (const op of ops) { op(); marks.set(timelineAt(), fingerprint()); }
  const top = fingerprint();
  assert.ok(timelineSteps().length >= ops.length - 1);

  // All the way back through the closures and all the way forward again -
  // the strong claim: undo not landing exactly where it started is a bug
  // this suite could not otherwise see.
  while (undo());
  assert.equal(timelineAt(), 0);
  assert.equal(fingerprint(), start, 'undone to the beginning');
  while (redo());
  assert.equal(fingerprint(), top, 'redone to the end');

  // The same journey through the records rather than the closures, crossing
  // the marks more than once. This is the assertion phase 2 leans on.
  const points = [...marks.keys()];
  for (const target of [...points, ...points.slice().reverse(), 0, points.at(-1)]) {
    replayTo(target);
    assert.equal(fingerprint(), marks.get(target), `replay to ${target}`);
  }
});

// ---------------------------------------------------------------------------
// Where the two engines are allowed to disagree, and where they are not
// ---------------------------------------------------------------------------
//
// The test above walks both ends and every mark, and was green through a
// bug that permanently deleted cards. It could not see the middle of a run:
// undo is finer than the strip on purpose, several stack entries collapse
// to one step, and the marker moved once per entry, not once per step.
// Three nudges undone walked back three steps but landed two steps behind
// the board, rebuilding an older one where an untouched card never returns.
// `at` clamped at zero hides this on a full undo; these check where it can't.

const idsOnBoard = () => board.items.map(i => i.id).sort().join(',');

test('undo inside a run leaves the marker on the run it is inside', () => {
  const [a] = addItems([photo({ x: 0, y: 0 })]);
  move(a.id, 10, 0);
  move(a.id, 10, 0);
  move(a.id, 10, 0);
  assert.equal(timelineSteps().length, 2, 'the three nudges are one step');
  assert.equal(timelineAt(), 2);

  undo();
  assert.equal(timelineAt(), 2, 'one nudge back is still inside the step');
  undo();
  assert.equal(timelineAt(), 2, 'and so is the second');
  undo();
  assert.equal(timelineAt(), 1, 'the whole run off takes the marker with it');
  redo();
  assert.equal(timelineAt(), 2, 'and entering it again brings it back');
});

test('a card no step touched survives a replay after a partial undo', () => {
  // Added first and never mentioned again - a card put at the top of a
  // board and left there.
  const [keep] = addItems([note({ x: 0, y: 0 })]);
  const [a] = addItems([photo({ x: 400, y: 0 })]);
  move(a.id, 10, 0);
  move(a.id, 10, 0);
  move(a.id, 10, 0);
  undo();
  undo();

  // Not the fingerprint: mid-run the board is deliberately finer than the
  // step, differing by two nudges by design. Membership must not differ at
  // all, since a run never adds or removes a card.
  const seen = idsOnBoard();
  replayTo(timelineAt());
  assert.equal(idsOnBoard(), seen, 'the replay lost a card the board still had');
  assert.ok(byId(keep.id), 'the untouched card is gone');
});

test('a run merged into a checkpointed step still replays', () => {
  // CHECKPOINT_EVERY is 50 and private to the module; this lands exactly on
  // it, since the bug is a mark filed under a step that then changed.
  const [a] = addItems([photo({ x: 0, y: 0 })]);
  // Bounded: `while (timelineSteps().length < 49)` alone would hang rather
  // than fail if recordStep() stopped recording, taking the whole suite with it.
  for (let guard = 0; timelineSteps().length < 49; guard++) {
    assert.ok(guard < 200, `${timelineSteps().length} steps after ${guard} adds - the ledger is not growing`);
    addItems([photo({ x: 0, y: 0 })]);
  }
  move(a.id, 10, 0);
  assert.equal(timelineSteps().length, 50, 'the run should land on the mark');
  move(a.id, 10, 0);
  move(a.id, 10, 0);
  assert.equal(timelineSteps().length, 50, 'and should still be one step');

  const top = fingerprint();
  replayTo(0);
  replayTo(50);
  assert.equal(fingerprint(), top, 'the checkpoint at 50 was a step and a half old');
});

// ---------------------------------------------------------------------------
// Deleting steps
// ---------------------------------------------------------------------------

test('deleting a step behind the marker takes its change off the board and keeps the rest', () => {
  const [a] = addItems([photo({ x: 0, y: 0 })]);
  move(a.id, 40, 0);
  renameItem(a.id, 'Renamed');
  assert.equal(deleteStep(1), true);
  assert.deepEqual(labels(), ['Add', 'Rename']);
  assert.equal(timelineAt(), 2);
  assert.equal(byId(a.id).x, 0, 'the deleted move is still on the board');
  assert.equal(byId(a.id).name, 'Renamed', 'the step after it was lost');
  // Undo would run closures written against the old history.
  assert.deepEqual(historyDepth(), { undo: 0, redo: 0 });
});

test('deleting an add takes the later changes to that card with it', () => {
  const [a] = addItems([photo({ x: 0, y: 0 })]);
  const [b] = addItems([photo({ x: 500, y: 0 })]);
  move(a.id, 40, 0);
  move(b.id, 40, 0);
  deleteStep(0);
  assert.equal(byId(a.id), undefined);
  assert.equal(byId(b.id).x, 540);
  // The move of `a` had nothing left to do, so it left no mark.
  assert.deepEqual(labels(), ['Add', 'Move']);
  assert.equal(timelineAt(), 2);
});

test('deleting a step ahead of the marker leaves the board alone', () => {
  const [a] = addItems([photo({ x: 0, y: 0 })]);
  move(a.id, 40, 0);
  renameItem(a.id, 'Renamed');
  goTo(1);
  const here = fingerprint();
  deleteStep(2);
  assert.equal(fingerprint(), here);
  assert.equal(timelineAt(), 1);
  assert.deepEqual(labels(), ['Add', 'Move']);
  goTo(2);
  assert.equal(byId(a.id).x, 40);
  assert.notEqual(byId(a.id).name, 'Renamed', 'the deleted rename came back');
});

test('deleting the steps ahead keeps the board and the past', () => {
  const [a] = addItems([photo({ x: 0, y: 0 })]);
  move(a.id, 40, 0);
  renameItem(a.id, 'Renamed');
  goTo(1);
  const here = fingerprint();
  assert.equal(deleteAhead(), 2);
  assert.equal(fingerprint(), here);
  assert.deepEqual(labels(), ['Add']);
  assert.equal(timelineAt(), 1);
  assert.equal(deleteAhead(), 0, 'nothing is ahead now');
  // A new edit lands after the kept step, with nothing laid back after it.
  move(a.id, 10, 0);
  assert.deepEqual(labels(), ['Add', 'Move']);
});

test('deleting refuses a position with no step', () => {
  addItems([photo({ x: 0, y: 0 })]);
  assert.equal(deleteStep(-1), false);
  assert.equal(deleteStep(1), false);
  assert.equal(timelineSteps().length, 1);
});
