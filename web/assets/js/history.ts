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
import {
  snapshot, recordStep, markerBack, markerForward, dropLastStep, resetTimeline,
  stepBack, stepForward, stepBackLabel, stepForwardLabel, isReplaying,
  setStackDropper,
} from './timeline.ts';

/**
 * One entry: what to call it, the two halves, and what the pair retains. The
 * type is the contract the header describes - a caller that knows how to
 * reverse itself - and `weight` is the only field the engine itself reads.
 *
 * `step` is the ledger's, not this engine's: the id of the step in timeline.js
 * that this command landed in. It is what keeps the two counts honest when they
 * disagree, which they are *designed* to - see undo() below. Null for a command
 * that recorded no step at all.
 */
export type Command = {
  label: string,
  redo: () => void,
  undo: () => void,
  weight: number,
  step?: string | null,
};

const undoStack: Command[] = [];
const redoStack: Command[] = [];

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
    // Non-null: the loop condition it took to get here read undoStack.length.
    heldWeight -= undoStack.shift()!.weight;
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
  // Falling back to the record for the same reason undo() does, and it has to:
  // every control in the app binds to this, so a board reopened with a history
  // and an empty stack would show its undo button greyed while undo would in
  // fact work. The button and the key have to agree about what is possible.
  undo: undoStack.at(-1)?.label || stepBackLabel(),
  redo: redoStack.at(-1)?.label || stepForwardLabel(),
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
export function commit(
  label: string, redo: () => void, undo: () => void, weight = 1,
  rewind?: () => void,
) {
  // The snapshot has to be taken here rather than by the caller, and this is
  // the whole of what makes the timeline cost one change instead of thirty:
  // this function runs the redo half itself, so it is the one place in the app
  // that sees the board on both sides of every mutation. Every commit site
  // records a step without knowing timeline.js exists - including the ones
  // written next year, which is what takes coverage off the list of things
  // somebody has to remember. See the header there for why the diff is cheap.
  //
  // **`rewind` is the exception, and it exists because one caller genuinely
  // cannot fit that shape.** The contract almost everywhere is "hand over a
  // redo that does the work, and commit() runs it" - so the board is still in
  // the before state when this line is reached. A finished drag is not like
  // that: the card has been moving under the pointer for two seconds and is
  // already where it ends up, and commitGeom()'s redo half re-applies values
  // the board already holds. Snapshotting there would compare a state with
  // itself and record nothing, which is exactly what the first run of
  // tests/timeline.test.js found.
  //
  // So a caller that has already mutated hands over a way back, this puts the
  // board where it was, takes the picture, and lets `redo` bring it forward
  // again. That is one extra site to know about rather than thirty, and it is
  // discoverable rather than silent: a commit that mutated first and forgot
  // this records an empty step, which the oracle test catches.
  // A rebuild re-runs a step's rule by calling the command that made it, and
  // commands come through here. During one, this is a pass-through: do the work
  // and leave both engines alone. Without it, editing one step in the past would
  // leave an undo entry for every step after it - entries for the replay of work
  // that is already on the strip.
  if (isReplaying()) {
    if (rewind) rewind();
    redo();
    return { label, redo, undo, weight: 1 };
  }
  if (rewind) rewind();
  const before = snapshot();
  redo();
  // The step this landed in, kept on the entry. recordStep() answers with the
  // *merged* step when this change joined a run, so several consecutive
  // commands can carry the same id - which is exactly the fact undo() needs and
  // cannot work out for itself.
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
export function takeBack(cmd: Command | null) {
  if (!cmd || undoStack.at(-1) !== cmd) return false;
  undoStack.pop();
  cmd.undo();
  // As if it never ran, on the timeline too. A step left behind here would put
  // a dot on the strip for a note the user cancelled before typing into it.
  dropLastStep();
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
  // Nothing left in this session's stack, so fall through to the written
  // record. **This is the whole of what phase 2 buys**: until now, closing the
  // tab was the end of undo, because a closure cannot be saved and these
  // stacks are closures. The steps can be, so undo now reaches back past the
  // refresh - and past every refresh before it, as far as the file goes.
  //
  // The stack is tried first rather than the record, and that ordering is the
  // second decision the design takes: a step on the strip is a whole run of
  // small changes collapsed into one, and unwinding a run keystroke by
  // keystroke is what undo has always felt like. So the finer engine answers
  // while it still can, and the coarser one takes over when it cannot. The cost
  // is that undo is finer today than tomorrow, which is stated in the format
  // document rather than left to be discovered.
  if (!cmd) {
    if (!stepBack()) return false;
    markDirty();
    historyChanged();
    return true;
  }
  cmd.undo();
  // The marker follows rather than drives, for now. Running the closure is
  // faster than replaying, and during phase 1 it is also the thing the replay
  // engine is being checked against - a marker that drove the board would be
  // marking its own homework. Phase 2 turns this round.
  //
  // **But it follows the ledger's count, not this one, and the two differ by
  // design.** A run of small changes to one card is several entries here and a
  // single step there - that is what the strip is for. Moving the marker once
  // per entry walked it back three steps for a three-nudge run, so it came to
  // rest on a step the board had never been at, and every replay from that
  // point - a press on a dot, a reload - rebuilt an older board and dropped
  // whatever the steps in between had added. A card added and then left alone
  // is the one it takes with it, because nothing later mentions that card to
  // put it back.
  //
  // So the marker moves when the run does: only when the entry being taken back
  // is the *first* of its step, which is to say when nothing left on the stack
  // still belongs to it. A command that recorded no step at all moves nothing.
  const below = undoStack[undoStack.length - 1];
  if (cmd.step && below?.step !== cmd.step) markerBack();
  heldWeight -= cmd.weight;
  redoStack.push(cmd);
  markDirty();
  historyChanged();
  return true;
}

export function redo() {
  const cmd = redoStack.pop();
  // The other half of the fall-through above. Redo after a refresh is the same
  // trick and is worth as much: having stepped back through work done last
  // week, there has to be a way forward again.
  if (!cmd) {
    if (!stepForward()) return false;
    markDirty();
    historyChanged();
    return true;
  }
  cmd.redo();
  // The mirror of the rule in undo(), and it has to be the mirror or the two
  // walk out of step over a single run: forward once as the run is *entered*,
  // which is the entry whose step nothing on the stack is already standing in.
  const resuming = undoStack[undoStack.length - 1];
  if (cmd.step && resuming?.step !== cmd.step) markerForward();
  undoStack.push(cmd);
  heldWeight += cmd.weight;
  markDirty();
  historyChanged();
  return true;
}

/**
 * Throw away the closure stacks and leave the ledger alone.
 *
 * The half of clearHistory() that a *replay* wants. Moving the board by replay
 * - goTo() from a click on a timeline dot, rebuildFrom() from a step edit -
 * leaves every entry on these two stacks describing a board that no longer
 * exists: with forty steps recorded, jumping to step ten left thirty undo
 * entries standing, and the next Ctrl+Z ran the step-forty command's undo(),
 * writing step-thirty-nine geometry onto a step-ten board and then moving the
 * marker from ten to nine. The board became a silent mix of two eras and
 * markDirty() made it saveable.
 *
 * Not clearHistory(), which calls resetTimeline() and would throw away the very
 * ledger the replay is navigating.
 */
export function dropStacks() {
  undoStack.length = 0;
  redoStack.length = 0;
  heldWeight = 0;
  historyChanged();
}

// Handed to the timeline at load, because the arrow only goes one way: this
// module imports that one, so that one cannot import this. The alternative -
// wiring it from main.ts, like setOverlays() - would leave it unwired in the
// suite, which is where goTo() is actually exercised.
setStackDropper(dropStacks);

/** Forget everything. A new board has nothing to take back. */
export function clearHistory() {
  undoStack.length = 0;
  redoStack.length = 0;
  heldWeight = 0;
  // The ledger starts over with the board as it stands, which is what keeps
  // phase 1's contract - replay and undo agree - true by construction. It is
  // also where this currently throws away history it ought to keep: setBoardMode
  // clears the stacks, so switching layout wipes the timeline. Rebasing instead
  // of resetting is phase 2 work, and resetTimeline()'s header says so.
  resetTimeline();
  historyChanged();
}

/**
 * What the undo stack is holding on to, for the test that proves the weight
 * limit evicts. Not part of the app's surface.
 */
export const historyWeight = () => heldWeight;

/**
 * How many steps deep each half is.
 *
 * Beside historyWeight() and for the same kind of caller: the Debug fold's
 * history readout, which wants "18 back, 3 forward, holding 412 items". Kept
 * out of historyState() deliberately - that one answers "what would undo do
 * next", which is what every control in the app binds to, and adding two
 * numbers nothing else wants would make the hot answer carry them.
 */
export const historyDepth = () => ({ undo: undoStack.length, redo: redoStack.length });
