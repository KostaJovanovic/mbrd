// Undo/redo as command pairs (do, undo), not snapshot diffs — the board holds
// Blobs and dual-layout geometry that would make diffs enormous. Callers write
// their own inverse. Lifted from state.ts; touches only bus + dirty flag.

import { bus, markDirty } from './board-store.ts';
import { cue } from './cuelume/engine.ts';
import {
  snapshot, recordStep, markerBack, markerForward, dropLastStep, resetTimeline,
  stepBack, stepForward, stepBackLabel, stepForwardLabel, isReplaying,
  setStackDropper, settleDrift, ledgerMoved, timelinePlaying, stepBehind, stepAhead, runMoved,
  dropOp,
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

/** An undo or redo ran - said beside the buttons, since the change it made may
 *  be off screen. Its own event: 'history' also fires on every commit. */
const moved = (undo: boolean, label: string | null) => {
  if (label) bus.emit('history:moved', { undo, label });
};

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
    // Both branches record nothing, so a declared rule dies with the change.
    dropOp();
    if (rewind) rewind();
    redo();
    return { label, redo, undo, weight: 1 };
  }
  // While the Timeline plays the board is read-only: nothing runs and nothing
  // is recorded, and a caller that already mutated gets its board put back.
  // The last net under the gates in the canvas and the chrome.
  if (timelinePlaying()) {
    dropOp();
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
 * saves use it - every save in one opening of a document is one step - and so
 * does a held arrow key, through commitGeom(), so a run of nudges is one undo.
 * `weight` and `rewind` are commit()'s own.
 */
export function commitFolded(
  prev: Command | null, label: string, redo: () => void, undo: () => void,
  weight = 1, rewind?: () => void,
): Command {
  const cmd: Command = commit(label, redo, undo, weight, rewind);
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

/**
 * Run one side of `cmd` and keep the ledger on the board it leaves. `known`
 * says the ledger still holds the entry's step where this move meets it.
 *
 * The marker follows the ledger's count, not the stack's: a run of small
 * changes is several entries here and one step there. Beside another entry of
 * its step (`next`), the step is rewritten to end where the board now is; only
 * the last entry of a run moves the marker, or a three-nudge undo walks it
 * three steps back. An entry whose step is gone (its run folded back to
 * nothing, or the step was folded into the base) is a change the ledger has
 * not seen, so it is recorded as one.
 */
function moveAlong(
  cmd: Command, run: () => void, known: boolean,
  next: Command | undefined, marker: () => void,
) {
  if (known) {
    run();
    if (next?.step === cmd.step) runMoved();
    else marker();
  } else {
    const before = snapshot();
    run();
    cmd.step = recordStep(cmd.label, before)?.id ?? null;
  }
  ledgerMoved();
}

export function undo() {
  const cmd = undoStack.pop();
  // Stack empty — fall through to the persistent timeline record. Stack is
  // tried first because its entries are finer-grained than timeline steps
  // (one step = a whole run of small changes).
  if (!cmd) {
    const label = stepBackLabel();
    if (!stepBack()) return false;
    markDirty();
    historyChanged();
    moved(true, label);
    cue('fall');
    return true;
  }
  // Drift is written down before the closure runs and the ledger is resynced
  // after it, so what the closure undoes is never mistaken for drift.
  settleDrift();
  moveAlong(cmd, cmd.undo, stepBehind(cmd.step), top(undoStack), markerBack);
  heldWeight -= cmd.weight;
  redoStack.push(cmd);
  markDirty();
  historyChanged();
  moved(true, cmd.label);
  // Stutter when held down is intentional — repeat guard in cuelume/engine.ts.
  cue('fall');
  return true;
}

export function redo() {
  const cmd = redoStack.pop();
  // Mirror of undo()'s fall-through: redo past a refresh uses the timeline too.
  if (!cmd) {
    const label = stepForwardLabel();
    if (!stepForward()) return false;
    markDirty();
    historyChanged();
    moved(false, label);
    cue('rise');
    return true;
  }
  settleDrift();
  const resuming = top(undoStack);
  // Inside a run the step is behind the marker; entering one, it is ahead.
  const inRun = !!cmd.step && resuming?.step === cmd.step;
  moveAlong(cmd, cmd.redo, inRun ? stepBehind(cmd.step) : stepAhead(cmd.step), resuming, markerForward);
  undoStack.push(cmd);
  heldWeight += cmd.weight;
  markDirty();
  historyChanged();
  moved(false, cmd.label);
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
