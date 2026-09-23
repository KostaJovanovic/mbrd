// Undo/redo as command pairs (do, undo), not snapshot diffs — the board holds
// Blobs and dual-layout geometry that would make diffs enormous. Callers write
// their own inverse. Lifted from state.ts; touches only bus + dirty flag.

import { bus, markDirty } from './board-store.ts';
import { cue } from './cuelume/engine.ts';
import {
  snapshot, recordStep, markerBack, markerForward, dropLastStep, resetTimeline,
  stepBack, stepForward, stepBackLabel, stepForwardLabel, isReplaying,
  setStackDropper, settleDrift, ledgerMoved, timelinePlaying,
} from './timeline.ts';

/** One undo entry. `step` links to the timeline ledger; `weight` drives eviction. */
export type Command = {
  label: string,
  redo: () => void,
  undo: () => void,
  weight: number,
  step?: string | null,
};

const undoStack: Command[] = [];
const redoStack: Command[] = [];

// Two limits: count (200) and weight (50k items retained). Weight matters for
// whole-board operations that close over large snapshots.
const HISTORY_LIMIT = 200;
const WEIGHT_LIMIT = 50000;

/** What the undo stack currently holds on to, kept as a running total. */
let heldWeight = 0;

/** Drop the oldest entries until both limits are satisfied. */
function trim() {
  while (undoStack.length > HISTORY_LIMIT ||
         (heldWeight > WEIGHT_LIMIT && undoStack.length > 1)) {
    // Never down to zero — one heavy entry is still worth keeping.
    heldWeight -= undoStack.shift()!.weight;
  }
}

/** Labels for the next undo/redo, or null. Falls back to the timeline ledger. */
export const historyState = () => ({
  // Falls back to the timeline record — a board reopened with history but an
  // empty stack must still show undo as available.
  undo: top(undoStack)?.label || stepBackLabel(),
  redo: top(redoStack)?.label || stepForwardLabel(),
});

/** Stack top. arr.at(-1) would be cleaner but needs Safari 15.4+. */
const top = <T>(stack: T[]): T | undefined => stack[stack.length - 1];

// Own event — markDirty() only emits on change, so it goes quiet after the first edit.
const historyChanged = () => bus.emit('history');

/** Run `redo` now, push the inverse onto the undo stack. `weight` drives eviction. */
export function commit(
  label: string, redo: () => void, undo: () => void, weight = 1,
  rewind?: () => void,
) {
  // Snapshot is taken here — commit() sees both sides of every mutation.
  // `rewind` is for callers that already mutated (e.g. drag end) — it puts the
  // board back so the snapshot captures the before-state.
  // During a replay, pass through without touching either stack.
  if (isReplaying()) {
    if (rewind) rewind();
    redo();
    return { label, redo, undo, weight: 1 };
  }
  // While the Timeline plays the board is read-only: nothing runs and nothing
  // is recorded, and a caller that already mutated gets its board put back.
  // The last net under the gates in the canvas and the chrome.
  if (timelinePlaying()) {
    if (rewind) rewind();
    bus.emit('readonly');
    return { label, redo, undo, weight: 1 };
  }
  if (rewind) rewind();
  const before = snapshot();
  redo();
  // Step id kept on the entry; recordStep() merges runs, so consecutive
  // commands share an id — which is what undo() needs to move the marker.
  const step = recordStep(label, before);
  const held = Number.isFinite(weight) && weight > 1 ? Math.floor(weight) : 1;
  const cmd = { label, redo, undo, weight: held, step: step ? step.id : null };
  undoStack.push(cmd);
  heldWeight += held;
  trim();
  clearRedo();
  markDirty();
  historyChanged();
  return cmd;
}

/**
 * commit(), folded into `prev` when `prev` is the entry just below and the
 * timeline merged the two into one step: the entry keeps `prev`'s undo and
 * takes the new redo, so one Ctrl+Z goes back past both. The text editor's
 * saves use it - every save in one opening of a document is one step.
 */
export function commitFolded(
  prev: Command | null, label: string, redo: () => void, undo: () => void,
): Command {
  const cmd: Command = commit(label, redo, undo);
  const at = undoStack.length - 1;
  if (prev && undoStack[at] === cmd && undoStack[at - 1] === prev && prev.step && prev.step === cmd.step) {
    undoStack.splice(at - 1, 1);
    heldWeight -= prev.weight;
    cmd.undo = prev.undo;
  }
  return cmd;
}

/** Opaque token for the current stack top. Compare before/after to detect whether a commit happened; takeBack() is its consumer. */
export const lastCommand = () => top(undoStack) || null;

/**
 * Silently withdraw `cmd` if it is still the stack top. Unlike undo(), leaves
 * no redo — the command is erased as if it never ran. Returns false when
 * something else has been committed since, so the caller can clean up normally.
 */
export function takeBack(cmd: Command | null) {
  if (!cmd || top(undoStack) !== cmd) return false;
  undoStack.pop();
  settleDrift();
  cmd.undo();
  // Erase from the timeline too, or a cancelled note leaves a dot on the strip.
  dropLastStep(cmd.step ?? null);
  ledgerMoved();
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
  // Stack empty — fall through to the persistent timeline record. Stack is
  // tried first because its entries are finer-grained than timeline steps
  // (one step = a whole run of small changes).
  if (!cmd) {
    if (!stepBack()) return false;
    markDirty();
    historyChanged();
    cue('fall');
    return true;
  }
  // Drift is written down before the closure runs and the ledger is resynced
  // after it, so what the closure undoes is never mistaken for drift.
  settleDrift();
  cmd.undo();
  // Marker follows the ledger's count, not the stack's. A run of small changes
  // is several entries here but one step there. Move the marker only when this
  // entry is the last of its step — otherwise a three-nudge undo walks the
  // marker three steps back and replays rebuild the wrong board.
  const below = undoStack[undoStack.length - 1];
  if (cmd.step && below?.step !== cmd.step) markerBack();
  ledgerMoved();
  heldWeight -= cmd.weight;
  redoStack.push(cmd);
  markDirty();
  historyChanged();
  // Stutter when held down is intentional — repeat guard in cuelume/engine.ts.
  cue('fall');
  return true;
}

export function redo() {
  const cmd = redoStack.pop();
  // Mirror of undo()'s fall-through: redo past a refresh uses the timeline too.
  if (!cmd) {
    if (!stepForward()) return false;
    markDirty();
    historyChanged();
    cue('rise');
    return true;
  }
  settleDrift();
  cmd.redo();
  // Mirror of undo()'s marker rule — move forward once as a run is entered.
  const resuming = undoStack[undoStack.length - 1];
  if (cmd.step && resuming?.step !== cmd.step) markerForward();
  ledgerMoved();
  undoStack.push(cmd);
  heldWeight += cmd.weight;
  markDirty();
  historyChanged();
  // `rise` is `fall` inverted — redo sounds like undo played backwards.
  cue('rise');
  return true;
}

/**
 * Drop the closure stacks, keep the ledger. After a replay (goTo, rebuildFrom)
 * every stack entry describes a board that no longer exists — running their
 * closures would mix eras. Not clearHistory(), which also resets the ledger.
 */
export function dropStacks() {
  undoStack.length = 0;
  redoStack.length = 0;
  heldWeight = 0;
  historyChanged();
}

// Injected because timeline.ts cannot import this module (cyclic). Wired here
// rather than from main.ts so the test suite has it too.
setStackDropper(dropStacks);

/** Forget everything. A new board has nothing to take back. */
export function clearHistory() {
  undoStack.length = 0;
  redoStack.length = 0;
  heldWeight = 0;
  // Ledger restarts from the current board. A layout switch does not come
  // here: it drops the stacks alone (setBoardMode calls dropStacks).
  resetTimeline();
  historyChanged();
}

/** Current held weight — exposed for the eviction test, not app surface. */
export const historyWeight = () => heldWeight;

/** Stack depths. Separate from historyState() so the hot path stays label-only. */
export const historyDepth = () => ({ undo: undoStack.length, redo: redoStack.length });
