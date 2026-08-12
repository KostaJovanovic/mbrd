// @ts-nocheck - TypeScript migration debt, not a judgement about this file.
//
// The tree was renamed from .js to .ts mechanically, which moved 104 modules in
// one step and annotated none of them. This module is carried unchecked so that
// npm run typecheck stays green and keeps meaning something, rather than going
// red and being ignored. Converting this module IS deleting this block and
// fixing what tsc then says - tests/ts-debt.test.js holds the count and lets it
// only fall.
// Undo and redo, as commands rather than as diffs.
//
// A mutating operation hands over a pair - do it, and put it back - and this
// keeps the two stacks. That is the whole engine, and it is deliberately not a
// snapshot-and-diff: the board holds Blob-backed assets and derived geometry
// for two layouts, so a diff would either be enormous or would have to know
// what every operation means. A caller that knows how to reverse itself is
// cheaper and, more to the point, correct by construction.
//
// The obligation this puts on callers is the one thing to remember when adding
// an operation: the inverse is yours to write. commit() will not work it out.
//
// Lifted out of state.js as the first of its ten concerns, and the easiest,
// because it touches none of the board's shape - only the bus and the dirty
// flag, both of which now sit below it in board-store.js. See the header there.

import { bus, markDirty } from './board-store.ts';

const undoStack = [];
const redoStack = [];

/**
 * How many operations are remembered, and how much they may retain between
 * them.
 *
 * Two limits because one was not enough. The count alone is what this had, and
 * it says nothing about cost: an entry closes over whatever its undo needs, so
 * a nudge of two cards and a nudge of ten thousand both count as one, while the
 * second retains two ten-thousand-element snapshots. Two hundred of those is a
 * board's geometry held twenty times over, in a history nobody is going to walk
 * back that far - and it is the boards big enough for it to matter that can
 * least afford it.
 *
 * So an entry may also declare its `weight`: how many items it holds on to.
 * Unweighted commands stay at 1, which is what almost all of them are - a
 * rename, a note edit, a setting - and the count limit governs them exactly as
 * before. The weighted ones are the whole-board operations, and they are
 * evicted on the total instead.
 *
 * WEIGHT_LIMIT is deliberately generous: fifty thousand retained items is far
 * more than any real session of undoable edits and still bounded. This is a
 * ceiling that stops a pathological case, not a budget anybody should feel.
 */
const HISTORY_LIMIT = 200;
const WEIGHT_LIMIT = 50000;

/** What the undo stack currently holds on to, kept as a running total. */
let heldWeight = 0;

/** Drop the oldest entries until both limits are satisfied. */
function trim() {
  while (undoStack.length > HISTORY_LIMIT ||
         (heldWeight > WEIGHT_LIMIT && undoStack.length > 1)) {
    // Never down to nothing: a single command heavier than the whole budget is
    // still the one thing the user most likely wants back, and dropping it
    // would make the heaviest operation the only un-undoable one.
    heldWeight -= undoStack.shift().weight;
  }
}

/**
 * What each half of the history would do next, by name, or null for nothing.
 *
 * The labels are the ones commit() was given - "Add 3 items", "Nudge",
 * "Optimize" - so a control built on this can say what it is about to take
 * back rather than only whether it can.
 */
export const historyState = () => ({
  undo: undoStack.at(-1)?.label || null,
  redo: redoStack.at(-1)?.label || null,
});

/**
 * The stacks changed.
 *
 * Its own event rather than something riding on 'board', and it has to be:
 * markDirty() only emits when dirtiness *changes*, so on an already-dirty board
 * - which is every board after the first edit - it goes quiet, and anything
 * watching for history through it would light up once and then never move
 * again.
 */
const historyChanged = () => bus.emit('history');

/**
 * Run `redo` now and remember how to reverse it.
 *
 * `weight` is how many items the pair holds on to - pass it from any command
 * that closes over a whole-board snapshot, leave it alone for the rest. It only
 * decides eviction; nothing else reads it.
 */
export function commit(label, redo, undo, weight = 1) {
  redo();
  const held = Number.isFinite(weight) && weight > 1 ? Math.floor(weight) : 1;
  const cmd = { label, redo, undo, weight: held };
  undoStack.push(cmd);
  heldWeight += held;
  trim();
  clearRedo();
  markDirty();
  historyChanged();
  return cmd;
}

/**
 * The command the history would take back next, as an opaque token.
 *
 * For the caller that is about to do something it may need to un-do, and wants
 * to be able to name *its own* command later rather than assume the stack has
 * not moved. Compare the token from before an operation with the one after to
 * find out whether it committed anything at all. There is nothing to read in
 * the value; it is an identity, and takeBack() is what it is for.
 */
export const lastCommand = () => undoStack.at(-1) || null;

/**
 * Take back a command, if it is still the last thing that happened.
 *
 * Not undo(). Undo is a step the user took through their own history, and it
 * leaves a redo behind; this is a caller withdrawing something it did itself,
 * so the command leaves no trace on either stack - it is as if it never ran.
 * composeNote() is the case it exists for: a note is a real item from the first
 * keystroke, so cancelling has to take back the add, and taking it back must
 * not become a thing the user can accidentally redo.
 *
 * The check is the point of the signature. That call site used to reason "the
 * add is still the newest thing, because nothing between it and here commits" -
 * which was true, and true only as long as three unrelated functions in two
 * other modules went on not committing. Handing the command back and comparing
 * it with the top of the stack asks the question instead of assuming the
 * answer, and returns false when something has happened since so the caller can
 * clean up by ordinary means.
 */
export function takeBack(cmd) {
  if (!cmd || undoStack.at(-1) !== cmd) return false;
  undoStack.pop();
  cmd.undo();
  heldWeight -= cmd.weight;
  markDirty();
  historyChanged();
  return true;
}

/** The redo stack retains snapshots too, and a new command invalidates it. */
function clearRedo() {
  redoStack.length = 0;
}

export function undo() {
  const cmd = undoStack.pop();
  if (!cmd) return false;
  cmd.undo();
  heldWeight -= cmd.weight;
  redoStack.push(cmd);
  markDirty();
  historyChanged();
  return true;
}

export function redo() {
  const cmd = redoStack.pop();
  if (!cmd) return false;
  cmd.redo();
  undoStack.push(cmd);
  heldWeight += cmd.weight;
  markDirty();
  historyChanged();
  return true;
}

/** Forget everything. A new board has nothing to take back. */
export function clearHistory() {
  undoStack.length = 0;
  redoStack.length = 0;
  heldWeight = 0;
  historyChanged();
}

/**
 * What the undo stack is holding on to, for the test that proves the weight
 * limit evicts. Not part of the app's surface.
 */
export const historyWeight = () => heldWeight;
