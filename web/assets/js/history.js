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

import { bus, markDirty } from './board-store.js';

const undoStack = [];
const redoStack = [];

/**
 * How many operations are remembered.
 *
 * A count, not a size, and that is a known limitation rather than an oversight:
 * an entry closes over whatever its undo needs, so a move of ten thousand items
 * retains two ten-thousand-element arrays and a large paste pins the items it
 * added. Two hundred small commands cost nothing; two hundred large ones are
 * real memory. A byte-aware cap is the fix if this ever becomes the complaint.
 */
const HISTORY_LIMIT = 200;

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

/** Run `redo` now and remember how to reverse it. */
export function commit(label, redo, undo) {
  redo();
  undoStack.push({ label, redo, undo });
  if (undoStack.length > HISTORY_LIMIT) undoStack.shift();
  redoStack.length = 0;
  markDirty();
  historyChanged();
}

export function undo() {
  const cmd = undoStack.pop();
  if (!cmd) return false;
  cmd.undo();
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
  markDirty();
  historyChanged();
  return true;
}

/** Forget everything. A new board has nothing to take back. */
export function clearHistory() {
  undoStack.length = 0;
  redoStack.length = 0;
  historyChanged();
}
