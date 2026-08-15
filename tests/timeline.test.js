// The step ledger: what gets written down, what collapses, and the one check
// that matters.
//
// That check is the last test in this file, and it is the whole safety net for
// the phase that follows. Phase 1 of research/timeline-2026-08-14.md leaves the
// closure-based undo engine running beside the new record-based one *and asserts
// they agree*, because there is no browser-driven suite here and "replay and
// undo produce the same board" is the strongest thing that can be said about
// this feature without somebody watching a screen. Phase 2 deletes one of the
// two engines, and it is only safe to do that while this test is green.
//
// Everything above it is the small print: what makes two changes one step, what
// makes them two, and what happens to a step nobody wanted.

import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

import {
  board, addItems, removeItems, restoreItems, renameItem, undo, redo, byId,
  setBoardMode, snapshotGeom, commitGeom, lastCommand, takeBack, loadBoard,
  historyDepth, historyState,
  serializeBoard,
} from '../web/assets/js/state.ts';
import {
  timelineSteps, timelineAt, timelineStale, timelineHashes, replayTo,
  serializeTimeline, fingerprint, registerOp, declareOp, editStep, stepEditable,
  trimmable, trimTimeline,
} from '../web/assets/js/timeline.ts';
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
  const pair = step.delta.items.changed[a.id];
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
  // One for the add, one for all three moves. Twelve taps of an arrow key are
  // twelve commits and one intention; the strip shows the intention.
  assert.deepEqual(labels(), ['Add', 'Move']);
});

test('the collapsed step keeps the first position and the last', () => {
  const [a] = addItems([photo({ x: 0, y: 0 })]);
  move(a.id, 10, 0);
  move(a.id, 10, 0);
  const [step] = timelineSteps().slice(-1);
  const pair = step.delta.items.changed[a.id];
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
  // Same card, different fields. Two intentions, and a strip that folded them
  // together would be hiding one of them behind the other.
  assert.equal(timelineSteps().length, 3);
});

test('a run that ends where it started leaves no step at all', () => {
  const [a] = addItems([photo({ x: 0, y: 0 })]);
  move(a.id, 40, 0);
  move(a.id, -40, 0);
  // Not a step with nothing in it - no step. A dot on the strip for an action
  // with no effect is worse than no dot.
  assert.deepEqual(labels(), ['Add']);
});

test('a run closes when something else happens in between', () => {
  const [a, b] = addItems([photo({ x: 0, y: 0 }), photo({ x: 500, y: 0 })]);
  move(a.id, 10, 0);
  move(b.id, 10, 0);
  move(a.id, 10, 0);
  // The middle move is the something else. Three steps, not two: a run only
  // ever merges with the step immediately before it.
  assert.deepEqual(labels(), ['Add', 'Move', 'Move', 'Move']);
});

test('an add is never folded into the move that follows it', () => {
  const [a] = addItems([photo({ x: 0, y: 0 })]);
  move(a.id, 10, 0);
  // A card arriving has nothing on the before side of its pair, and collapsing
  // "added" into "moved" would lose the add.
  assert.deepEqual(labels(), ['Add', 'Move']);
});

test('repeated renames of the same card collapse', () => {
  const [a] = addItems([photo({ x: 0, y: 0 })]);
  renameItem(a.id, 'One');
  renameItem(a.id, 'Two');
  renameItem(a.id, 'Three');
  // The same shape as a colour slider dragged across its range: one field of
  // one card written over and over, and one thing the person meant.
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

test('doing something new with the marker rolled back drops what was ahead', () => {
  addItems([photo({ x: 0, y: 0 })]);
  addItems([note({ x: 300, y: 0 })]);
  undo();
  addItems([photo({ x: 600, y: 0 })]);
  // Truncation, the way undo behaves everywhere. Fusion inserts instead; that
  // is a deliberate divergence and the design says why.
  assert.equal(timelineSteps().length, 2);
  assert.equal(timelineAt(), 2);
});

test('taking back a command takes back its step', () => {
  addItems([photo({ x: 0, y: 0 })]);
  const cmd = lastCommand();
  addItems([note({ x: 300, y: 0 })]);
  const withdrawn = lastCommand();
  assert.equal(takeBack(withdrawn), true);
  assert.equal(timelineSteps().length, 1);
  // The withdrawn one is gone from both engines, so the earlier command is the
  // top of the stack again and can itself be taken back.
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

test('a timeline that does not describe its board is marked stale', () => {
  const [a] = addItems([photo({ x: 0, y: 0 })]);
  move(a.id, 40, 0);
  const doc = serializeBoard();
  // What an older build does: drop the timeline, keep the board, let it be
  // edited, and hand it back here. The steps no longer add up to the board
  // beside them, and a history that quietly describes the wrong board is worse
  // than no history at all.
  doc.items[0].x = 999;
  loadBoard(doc);
  assert.equal(timelineStale(), true);
});

test('an asset only a step names is still referenced', () => {
  const hash = 'a'.repeat(64);
  const [a] = addItems([photo({ x: 0, y: 0, asset: { hash } })]);
  removeItems([a.id]);
  // The card is in the bin, which already counted. Empty the bin and the only
  // thing left naming those bytes is the step that put it there - and stepping
  // back through that step has to put the picture on the board again.
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
  // The reload. loadBoard() clears the closure stacks - that is the whole
  // reason undo has never survived a refresh - and then adopts the record.
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
  // One step on the strip, two commits in this session. Undo is the finer of
  // the two engines while it still can be, so the first press takes back ten
  // pixels rather than twenty.
  assert.equal(timelineSteps().length, 2);
  assert.equal(undo(), true);
  assert.equal(byId(a.id).x, 10);
});

// ---------------------------------------------------------------------------
// Editing a step in the past - phase 4
// ---------------------------------------------------------------------------

// A stand-in for align or arrange: a rule with a parameter, which re-runs to a
// different answer when the parameter changes. The real ones are registered in
// commands.ts and need a viewport; what is being tested here is the machinery
// they hang on, not the arithmetic of a layout.
registerOp('shift-to', params => shiftTo(String(params.id), Number(params.to)));

function shiftTo(id, to) {
  const item = byId(id);
  if (!item) throw new Error('no such card');
  const before = snapshotGeom([id]);
  declareOp('shift-to', { id, to });
  item.x = to;
  commitGeom('Shift', before, [id]);
}

test('a step that carries a rule says so', () => {
  const [a] = addItems([photo({ x: 0, y: 0 })]);
  shiftTo(a.id, 100);
  const [step] = timelineSteps().slice(-1);
  assert.equal(step.op.name, 'shift-to');
  assert.equal(stepEditable(step), true);
  // And an ordinary one does not, which is the distinction the strip draws as a
  // lock.
  assert.equal(stepEditable(timelineSteps()[0]), false);
});

test('editing a step in the past changes what came after it', () => {
  const [a] = addItems([photo({ x: 0, y: 0 })]);
  shiftTo(a.id, 100);
  renameItem(a.id, 'Named later');
  assert.equal(byId(a.id).x, 100);

  // Reach back into step 1 and tell it to do something else. Everything after it
  // replays on top of the new answer.
  assert.equal(editStep(1, { to: 250 }), true);
  assert.equal(byId(a.id).x, 250);
  // The later step is still there and still applied - which is the whole claim.
  // A rebuild that dropped it would look like it worked.
  assert.equal(byId(a.id).name, 'Named later');
});

test('a rebuild leaves no trace on either engine', () => {
  const [a] = addItems([photo({ x: 0, y: 0 })]);
  shiftTo(a.id, 100);
  renameItem(a.id, 'X');
  const steps = timelineSteps().length;
  const depth = historyDepth().undo;
  editStep(1, { to: 250 });
  // The rule was run again by calling the command that made it, and that command
  // commits. Without the pass-through in commit() this would be three steps and
  // three undo entries longer, all of them describing a replay.
  assert.equal(timelineSteps().length, steps);
  assert.equal(historyDepth().undo, depth);
});

test('a rule that cannot run is marked and skipped, and the rest still replay', () => {
  const [a] = addItems([photo({ x: 0, y: 0 })]);
  const [b] = addItems([photo({ x: 400, y: 0 })]);
  shiftTo(a.id, 100);
  renameItem(b.id, 'Survivor');
  // Point the rule at a card that does not exist. The runner throws, which is
  // what an editable step naming a card an earlier edit removed would do.
  assert.equal(editStep(2, { id: 'gone' }), true);
  const step = timelineSteps()[2];
  assert.equal(step.broken, true);
  // Broken, not fatal: the board still builds and the step after it still ran.
  assert.equal(byId(b.id).name, 'Survivor');
  assert.equal(timelineSteps().length, 4);
});

test('a sealed step cannot be edited', () => {
  const [a] = addItems([photo({ x: 0, y: 0 })]);
  move(a.id, 40, 0);
  assert.equal(editStep(1, { anything: 1 }), false);
});

test('two rules in a row stay two steps', () => {
  const [a] = addItems([photo({ x: 0, y: 0 })]);
  shiftTo(a.id, 100);
  shiftTo(a.id, 200);
  // They touch the same card in the same field, which is what a run is - but a
  // step carrying a rule never merges, because one merged step's parameters
  // would describe the second while its difference described both.
  assert.equal(timelineSteps().length, 3);
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
  // Age the first two. Written rather than waited for, which is the only way to
  // test a thirty-day rule.
  const steps = timelineSteps();
  steps[0].at = Date.now() - 60 * DAY;
  steps[1].at = Date.now() - 45 * DAY;

  assert.equal(trimmable(), 2);
  const before = fingerprint();
  assert.equal(trimTimeline(), 2);
  // The whole promise: the record gets shorter, the board is untouched. A trim
  // that moved the board would be the app editing somebody's work to save space.
  assert.equal(fingerprint(), before);
  assert.equal(timelineSteps().length, 1);
  assert.equal(timelineAt(), 1);
  // And the folded work is still there, because it went into the starting state
  // rather than being thrown away.
  assert.equal(byId(a.id).x, 40);
});

test('a trim never crosses a step somebody named', () => {
  const [a] = addItems([photo({ x: 0, y: 0 })]);
  move(a.id, 40, 0);
  renameItem(a.id, 'Third');
  const steps = timelineSteps();
  for (const step of steps) step.at = Date.now() - 60 * DAY;
  // A saved version sits on the second step. Everything is old enough to go and
  // the count still stops short of it, because folding a named point away would
  // destroy something somebody deliberately marked.
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
  // The marker is at the beginning, so there is nothing behind it to fold. A
  // starting state that described a board the marker had not reached would be a
  // starting state describing a future.
  assert.equal(timelineAt(), 0);
  assert.equal(trimmable(), 0);
});

// ---------------------------------------------------------------------------
// The one that matters
// ---------------------------------------------------------------------------

test('replaying to a point produces the board undoing to it produces', () => {
  // Marks are keyed by where the *marker* stood, not by how many operations had
  // run, and that is deliberate. One user-level action is not reliably one step:
  // a run collapses several into one, and one action can commit twice. Keying on
  // the marker asks the question that actually matters - is the board at step
  // five the same board however you arrived at it - without the test having to
  // predict the ledger's arithmetic. It was written the other way first, and
  // what that version measured was my guess about which operations commit.
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

  // All the way back through the closures, and all the way forward again. The
  // two ends are the strong claim: undo that does not land exactly where it
  // started is a bug this suite could not otherwise see.
  while (undo());
  assert.equal(timelineAt(), 0);
  assert.equal(fingerprint(), start, 'undone to the beginning');
  while (redo());
  assert.equal(fingerprint(), top, 'redone to the end');

  // And now the same journey through the records rather than the closures, in
  // an order that goes both ways and crosses the marks more than once. This is
  // the assertion phase 2 is allowed to lean on.
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
// The test above walks the closures to *both ends* and the records across every
// mark, and it was green through a bug that permanently deleted cards. What it
// could not see is the middle of a run: undo is finer than the strip on purpose,
// so several entries in the stack collapse to one step, and the marker moved
// once per entry rather than once per step. Three nudges undone walked it back
// three steps, and it came to rest two steps behind the board. Everything after
// that rebuilt an older board - and a card added and then left alone is the one
// that never comes back, because no later step mentions it.
//
// The reason the end-to-end walk missed it: `at` is clamped at zero, so undoing
// all the way hides any amount of over-counting. These check where it cannot.

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
  // Added first and never mentioned again - the shape of a card somebody puts
  // at the top of a board and leaves there.
  const [keep] = addItems([note({ x: 0, y: 0 })]);
  const [a] = addItems([photo({ x: 400, y: 0 })]);
  move(a.id, 10, 0);
  move(a.id, 10, 0);
  move(a.id, 10, 0);
  undo();
  undo();

  // Not the fingerprint: mid-run the board is deliberately finer than the step,
  // so the two differ by two nudges and that is the design. Membership is not
  // allowed to differ by anything, because a run never adds or removes a card.
  const seen = idsOnBoard();
  replayTo(timelineAt());
  assert.equal(idsOnBoard(), seen, 'the replay lost a card the board still had');
  assert.ok(byId(keep.id), 'the untouched card is gone');
});

test('a run merged into a checkpointed step still replays', () => {
  // CHECKPOINT_EVERY is 50 and private to the module; this lands exactly on it,
  // because the bug is a picture filed under a mark whose step then changed.
  const [a] = addItems([photo({ x: 0, y: 0 })]);
  while (timelineSteps().length < 49) addItems([photo({ x: 0, y: 0 })]);
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
