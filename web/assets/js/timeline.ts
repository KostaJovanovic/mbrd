// The step ledger: every change to the board written down, rather than closed
// over.
//
// history.js keeps a pair of functions per change - do it, and put it back -
// and its header explains at length why that is the right engine. It is, for
// undo. It is not enough for a history that survives the tab closing, because
// a closure cannot be written to a file, and it is not enough for a history you
// can go back into and *edit*, because a closure cannot be read either.
//
// So this keeps the same changes as data. A step is a small reversible record
// of what the board looked like on either side of one action, and the board at
// any point is the starting snapshot plus the steps up to the marker.
//
// **Why the diff this module is built on is affordable, when history.js's own
// header says it would not be.** That note says a diff "would either be
// enormous or would have to know what every operation means", and it was right
// about the app it was written for. What makes it wrong now is that assets
// never lived in the board: they are content-addressed, `item.asset` is a hash
// and the bytes are in storage/assets.js. Every field of Board is JSON, and the
// geometry for the layout you are *not* looking at is in board.layouts, which
// is one of those fields. So the difference between two boards is a handful of
// small objects, and only for the items that actually changed - a nudge is a
// couple of hundred bytes.
//
// That is the whole reason phase 1 of research/timeline-2026-08-14.md converts
// none of the thirty commit sites: commit() runs its own redo half, so it can
// snapshot on either side of that call and keep the difference. Every site
// records a step without knowing this module exists, including every site
// written after today - which takes coverage off the list of things somebody
// has to remember.
//
// The cost of the generic diff is that a step so recorded is **sealed**: it
// replays exactly and cannot be edited, because it carries what changed rather
// than the rule that changed it. Converting a command to an editable
// instruction is later work, done one command at a time, and the strip shows
// the difference as a lock. Sealing is not a stopgap - Fusion 360 has the same
// escape hatch under the name "base feature", for the same reason.
//
// Below state.js, and it may never import it: this is the floor a step stands
// on, and history.js - which is also below state.js - is what calls in here.
// board-model.js holds the board itself and is lower still.

import { board, dropIdIndex } from './board-model.ts';
import { bus, selection, markDirty } from './board-store.ts';
import { itemHashes, isRecord, uid } from './util.ts';

// ---------------------------------------------------------------------------
// The shape of a snapshot, and of the difference between two
// ---------------------------------------------------------------------------

/**
 * A list of things with ids, as id -> JSON.
 *
 * Keyed rather than a single JSON string for the whole array, and that is the
 * decision that makes a step small: an array of two hundred items serialised
 * whole is sixty kilobytes on both sides of every nudge, while the same nudge
 * keyed by id is the one item that moved.
 */
type Keyed = Record<string, string>;

/** The board reduced to comparable text. Nothing derived, nothing live. */
type Snap = {
  items: Keyed,
  itemOrder: string[],
  desktop: Keyed,
  mobile: Keyed,
  trash: Keyed,
  trashOrder: string[],
  /** Everything else, whole-field, because all of it is small. */
  rest: Record<string, string>,
};

/**
 * What changed in one keyed list: `[before, after]` per id, null for absent.
 *
 * Reversible by construction - going back reads the left of each pair, going
 * forward the right - which is the property the whole module turns on.
 */
type KeyedDelta = {
  changed: Record<string, [string | null, string | null]>,
  /** Recorded only when the order itself moved. */
  order?: [string[], string[]],
};

/** The difference between two snapshots. Absent sections did not change. */
export type Delta = {
  items?: KeyedDelta,
  desktop?: KeyedDelta,
  mobile?: KeyedDelta,
  trash?: KeyedDelta,
  rest?: Record<string, [string, string]>,
};

/** One thing that was done, as data. */
export type Step = {
  id: string,
  at: number,
  label: string,
  /**
   * What makes two consecutive steps one step. Empty never merges.
   *
   * See recordStep(): it is the cards that changed and the fields of them that
   * changed, so moving the same card twice with nothing in between is one step
   * and moving it then recolouring it is two.
   */
  run: string,
  /**
   * A name somebody gave this point.
   *
   * This is what a saved version became. Boards used to carry a ring of whole
   * copies of themselves, named or automatic; a named step is the same landmark
   * for the cost of a string, because the ledger already holds the way back.
   */
  name?: string,
  /**
   * Set when replaying this step threw.
   *
   * Marked and skipped rather than deleted: the board still builds without it,
   * and a step that cannot run is the one thing on the strip somebody would
   * want to go and look at. Nothing produces one today - a sealed step is a
   * write of stored objects and has nothing to fail on - but an editable step
   * naming a card an earlier edit removed is exactly this, and the state is
   * here so that the first one has somewhere to land rather than becoming an
   * exception out of a replay.
   */
  broken?: boolean,
  /**
   * The rule this step followed, for the steps that have one.
   *
   * **This is the difference between a sealed step and an editable one**, and
   * the whole of what phase 4 adds. A sealed step carries what changed; a step
   * with an `op` also carries *why*, as the name of a computation and the
   * arguments it was given - `align`, `{ edge: 'left', ids: [...] }`. Change an
   * argument and the step can be run again to a different answer, and every step
   * after it replayed on top of that. Change an argument of a sealed step and
   * there is nothing to change: "this card was at 40 and is now at 80" has no
   * parameter in it.
   *
   * The `delta` is still recorded and still authoritative for ordinary
   * scrubbing - running a computation is slower than writing down its answer,
   * and the answer does not change unless somebody edits the step. It is
   * re-recorded whenever the op is re-run. See rebuildFrom().
   */
  op?: { name: string, params: Record<string, unknown> },
  delta: Delta,
};

/**
 * The fields of the board a step carries, beyond the four keyed lists above.
 *
 * `items`, `layouts` and `trash` are absent because they are the keyed
 * sections, handled per id.
 *
 * `versions` was absent for a different reason - a stored version held a whole
 * copy of the board, so a step recording one would have been the largest step
 * in the file by three orders of magnitude - and the answer taken was to remove
 * versions rather than to record them. See board-model.ts.
 */
const REST_FIELDS = [
  'title', 'view', 'sharedAppearance', 'layoutSettings', 'settings',
  'arrangement', 'arrangements', 'layoutMode', 'mobileHeader', 'titleHidden',
  'mediaFit', 'paletteSources', 'connections', 'audioOrder', 'tour',
] as const;

// ---------------------------------------------------------------------------
// Snapshot, restore, diff, apply
// ---------------------------------------------------------------------------

const keyed = (list: { id: string }[]): [Keyed, string[]] => {
  const out: Keyed = {};
  const order: string[] = [];
  for (const entry of list) {
    out[entry.id] = JSON.stringify(entry);
    order.push(entry.id);
  }
  return [out, order];
};

/** The board as it stands, as text. */
export function snapshot(): Snap {
  const [items, itemOrder] = keyed(board.items);
  const [desktop] = keyed(board.layouts.desktop);
  const [mobile] = keyed(board.layouts.mobile);
  // The bin is keyed by the id of the item inside it, since that is what is
  // unique - a TrashEntry is a wrapper with a timestamp and has no id of its
  // own.
  const trash: Keyed = {};
  const trashOrder: string[] = [];
  for (const entry of board.trash) {
    trash[entry.item.id] = JSON.stringify(entry);
    trashOrder.push(entry.item.id);
  }
  const rest: Record<string, string> = {};
  for (const field of REST_FIELDS) rest[field] = JSON.stringify(board[field]);
  return { items, itemOrder, desktop, mobile, trash, trashOrder, rest };
}

/** Put a snapshot back on the board, wholesale. What a checkpoint is for. */
export function restore(snap: Snap) {
  board.items = snap.itemOrder.map(id => JSON.parse(snap.items[id]));
  // In the same breath as the assignment, which is the contract dropIdIndex()
  // states and the reason it exists. board-model.js drops its id index when
  // 'items' is announced, and a replay announces nothing until it has finished -
  // so without this, every byId() during a rebuild is answered out of the board
  // as it was before the replay started. That is not a stale read that resolves
  // itself: the op runners re-run commands, and a command handed the *previous*
  // board's card object writes to an object no longer on the board. It looks
  // exactly like the rule silently not running.
  dropIdIndex();
  board.layouts.desktop = Object.keys(snap.desktop).map(id => JSON.parse(snap.desktop[id]));
  board.layouts.mobile = Object.keys(snap.mobile).map(id => JSON.parse(snap.mobile[id]));
  board.trash = snap.trashOrder.map(id => JSON.parse(snap.trash[id]));
  for (const field of REST_FIELDS) {
    if (snap.rest[field] == null) continue;
    // The assignment is untypeable as written - one loop over fields of a dozen
    // different types - and spelling out fifteen separate lines to please the
    // checker would make the list drift from REST_FIELDS the first time
    // somebody added one. The cast is confined to this line.
    (board as unknown as Record<string, unknown>)[field] = JSON.parse(snap.rest[field]);
  }
}

function keyedDelta(before: Keyed, after: Keyed,
                    beforeOrder?: string[], afterOrder?: string[]): KeyedDelta | undefined {
  const changed: Record<string, [string | null, string | null]> = {};
  let any = false;
  for (const id of new Set([...Object.keys(before), ...Object.keys(after)])) {
    const a = before[id] ?? null;
    const b = after[id] ?? null;
    if (a === b) continue;
    changed[id] = [a, b];
    any = true;
  }
  const moved = beforeOrder && afterOrder &&
    (beforeOrder.length !== afterOrder.length ||
     beforeOrder.some((id, at) => id !== afterOrder[at]));
  if (!any && !moved) return undefined;
  const out: KeyedDelta = { changed };
  if (moved) out.order = [beforeOrder!, afterOrder!];
  return out;
}

/** What it would take to get from one snapshot to another, or null for nothing. */
export function diff(before: Snap, after: Snap): Delta | null {
  const out: Delta = {};
  const items = keyedDelta(before.items, after.items, before.itemOrder, after.itemOrder);
  if (items) out.items = items;
  const desktop = keyedDelta(before.desktop, after.desktop);
  if (desktop) out.desktop = desktop;
  const mobile = keyedDelta(before.mobile, after.mobile);
  if (mobile) out.mobile = mobile;
  const trash = keyedDelta(before.trash, after.trash, before.trashOrder, after.trashOrder);
  if (trash) out.trash = trash;
  const rest: Record<string, [string, string]> = {};
  let anyRest = false;
  for (const field of REST_FIELDS) {
    if (before.rest[field] === after.rest[field]) continue;
    rest[field] = [before.rest[field], after.rest[field]];
    anyRest = true;
  }
  if (anyRest) out.rest = rest;
  return Object.keys(out).length ? out : null;
}

const side = <T>(pair: [T, T], forward: boolean) => (forward ? pair[1] : pair[0]);

/**
 * `held`, with the fields that differ between `from` and `to` set to `to`'s.
 *
 * The one operation that makes a difference behave like a difference rather
 * than like a photograph. Top-level keys only: `meta` is compared and written
 * whole, which is the right grain here - a step that edited a note's text and a
 * step that changed its pad colour both write the whole meta bag, and going
 * finer would mean this module knowing what is in it.
 */
function mergeChanged(
  held: unknown, from: Record<string, unknown>, to: Record<string, unknown>,
): never {
  const next = { ...(held as Record<string, unknown>) };
  for (const key of new Set([...Object.keys(from), ...Object.keys(to)])) {
    if (JSON.stringify(from[key]) === JSON.stringify(to[key])) continue;
    if (key in to) next[key] = to[key];
    else delete next[key];
  }
  // The cast is the generic caller: applyKeyed() is unconstrained in T because
  // three of its four lists carry their id on themselves and the fourth carries
  // it on the item inside, and there is no type that says "the same shape as
  // what came in" through a JSON round trip.
  return next as never;
}

// Unconstrained in T, and it has to be: three of the four lists this runs over
// carry their id on themselves and the fourth - the bin - carries it on the item
// inside. `idOf` is what reconciles them, so requiring `{ id: string }` here
// would exclude the one caller that needs the indirection.
function applyKeyed<T>(
  current: T[], delta: KeyedDelta, forward: boolean, idOf: (v: T) => string,
): T[] {
  // Rebuilt through a map rather than by index so that an item nothing touched
  // keeps its object identity. Other modules hold references - the id index in
  // board-model.js, a gesture in canvas/input.js - and replacing every object
  // on every step would invalidate all of them for the sake of one that moved.
  const map = new Map<string, T>();
  for (const entry of current) map.set(idOf(entry), entry);
  for (const id of Object.keys(delta.changed)) {
    const pair = delta.changed[id];
    const want = side(pair, forward);
    const leaving = side(pair, !forward);
    const held = map.get(id);
    if (want == null) { map.delete(id); continue; }
    // **Only the fields this step actually changed.**
    //
    // The obvious thing is to write the whole recorded object, and it is wrong
    // in the one case the feature exists for. A step records both sides of the
    // item, whole; write it whole and the step asserts *everything* about that
    // card, including the fields it never touched. So editing a step in the
    // past and rebuilding puts the new answer on the board and then the next
    // sealed step - a rename, say - quietly puts the old position back with it,
    // because the position was in the picture it took.
    //
    // Found by a test that edited a step and watched the edit vanish one step
    // later. Applying the difference rather than the picture is what makes a
    // sealed step compose with an edit upstream of it, which is the whole of
    // what "recompute everything after it" has to mean.
    if (leaving == null || !held) { map.set(id, JSON.parse(want)); continue; }
    map.set(id, mergeChanged(held, JSON.parse(leaving), JSON.parse(want)));
  }
  const order = delta.order
    ? side(delta.order, forward)
    : current.map(idOf).filter(id => map.has(id));
  const out: T[] = [];
  const placed = new Set<string>();
  for (const id of order) {
    const entry = map.get(id);
    if (!entry || placed.has(id)) continue;
    out.push(entry);
    placed.add(id);
  }
  // Anything the recorded order does not mention still belongs on the board.
  // Only reachable from a malformed step, and dropping items on the floor is
  // the one failure this module must not have.
  for (const [id, entry] of map) if (!placed.has(id)) out.push(entry);
  return out;
}

/** Move the board one step, in either direction. */
export function apply(delta: Delta, forward: boolean) {
  if (delta.items) {
    board.items = applyKeyed(board.items, delta.items, forward, i => i.id);
    dropIdIndex();
  }
  if (delta.desktop) {
    board.layouts.desktop = applyKeyed(board.layouts.desktop, delta.desktop, forward, g => g.id);
  }
  if (delta.mobile) {
    board.layouts.mobile = applyKeyed(board.layouts.mobile, delta.mobile, forward, g => g.id);
  }
  if (delta.trash) {
    board.trash = applyKeyed(board.trash, delta.trash, forward, t => t.item.id);
  }
  if (delta.rest) {
    const live = board as unknown as Record<string, unknown>;
    for (const field of Object.keys(delta.rest)) {
      const pair = delta.rest[field];
      const to = JSON.parse(side(pair, forward));
      const from = JSON.parse(side(pair, !forward));
      // The same rule as the keyed lists above, for the same reason: a step that
      // changed one setting recorded the whole settings object on both sides,
      // and writing it whole would put every *other* setting back to what it was
      // when this step ran. `settings` and `layoutSettings` are the ones that
      // bite; a scalar like `title` has no keys to preserve and falls through to
      // a plain write.
      const plain = isRecord(to) && isRecord(from) && isRecord(live[field]);
      live[field] = plain
        ? mergeChanged(live[field], from as Record<string, unknown>, to as Record<string, unknown>)
        : to;
    }
  }
}

/** One step folded into the one before it. See Step.run. */
function mergeDelta(first: Delta, second: Delta): Delta {
  const out: Delta = {};
  const sections = ['items', 'desktop', 'mobile', 'trash'] as const;
  for (const section of sections) {
    const a = first[section];
    const b = second[section];
    if (!a && !b) continue;
    if (!a) { out[section] = b; continue; }
    if (!b) { out[section] = a; continue; }
    const changed: Record<string, [string | null, string | null]> = { ...a.changed };
    for (const id of Object.keys(b.changed)) {
      // The earliest before and the latest after: that is the whole of what
      // collapsing a run means.
      const from = changed[id] ? changed[id][0] : b.changed[id][0];
      changed[id] = [from, b.changed[id][1]];
    }
    // A card moved out and back is not a change, and leaving the pair in would
    // put an entry on the strip for an action with no effect.
    for (const id of Object.keys(changed)) {
      if (changed[id][0] === changed[id][1]) delete changed[id];
    }
    const merged: KeyedDelta = { changed };
    if (a.order || b.order) {
      merged.order = [(a.order || b.order!)[0], (b.order || a.order!)[1]];
    }
    if (Object.keys(changed).length || merged.order) out[section] = merged;
  }
  if (first.rest || second.rest) {
    const rest: Record<string, [string, string]> = { ...(first.rest || {}) };
    for (const field of Object.keys(second.rest || {})) {
      const pair = second.rest![field];
      rest[field] = [rest[field] ? rest[field][0] : pair[0], pair[1]];
    }
    for (const field of Object.keys(rest)) {
      if (rest[field][0] === rest[field][1]) delete rest[field];
    }
    if (Object.keys(rest).length) out.rest = rest;
  }
  return out;
}

// ---------------------------------------------------------------------------
// The ledger
// ---------------------------------------------------------------------------

let steps: Step[] = [];
/** How many steps are on the board. steps[0 .. marker-1] have been applied. */
let at = 0;
/** The board before step 0. Every replay starts here. */
let base: Snap = snapshot();
/**
 * Full snapshots at intervals, so going backwards is bounded.
 *
 * Not written to the file and never will be. A step is on the order of eighty
 * bytes and a full board is on the order of a hundred kilobytes, so storing one
 * every fifty steps would make the checkpoints roughly thirty times the size of
 * the history they exist to speed up. Rebuilding them is a few milliseconds,
 * and it does not delay opening a board because the board you open is stored as
 * itself - this is only needed to scrub. Fusion 360 answers the same question
 * the same way, from a far more lopsided version of the ratio.
 */
const CHECKPOINT_EVERY = 50;
let checkpoints = new Map<number, Snap>();

/** Whether the steps still describe the board they claim to. See fingerprint(). */
let stale = false;

// ---------------------------------------------------------------------------
// Ops: the steps that carry a rule
// ---------------------------------------------------------------------------

/**
 * How to run a rule again. Keyed by op name.
 *
 * A registry rather than a switch, and it has to be one: what *arrange* means
 * lives two layers above this file, in the command that reads the selection and
 * calls the arrangement catalogue, and this module may not import upwards. So
 * the command registers a way to re-run itself, and this module calls it back
 * without ever knowing what it does.
 *
 * A runner writes to the board and **does not commit**. It is called from
 * inside a rebuild, which is already measuring the board on either side of it -
 * a runner that committed would push an undo entry and a second step for work
 * that is the *replay* of a step already on the strip.
 */
type OpRunner = (params: Record<string, unknown>) => void;
const OPS = new Map<string, OpRunner>();

export function registerOp(name: string, run: OpRunner) {
  OPS.set(name, run);
}

/** Whether a step can be edited, which is to say whether its rule is runnable. */
export const stepEditable = (step: Step) => !!step.op && OPS.has(step.op.name);

/**
 * What the next commit is a case of, declared by the command about to make it.
 *
 * Set immediately before the mutation and consumed by the very next
 * recordStep(), which is a narrow window on purpose: a command that declares an
 * op and then does not commit would otherwise leave the label lying in wait for
 * whatever committed next, and that step would claim to be an align it was
 * nothing to do with. Cleared on every recordStep(), committed or not.
 */
let pendingOp: { name: string, params: Record<string, unknown> } | null = null;

export function declareOp(name: string, params: Record<string, unknown>) {
  pendingOp = { name, params };
}

/**
 * True while a rebuild is running the board forward through the steps.
 *
 * Every write the replay makes goes through the ordinary board, and some of
 * those writes go through commands that commit. Without this the replay would
 * record steps for itself - each one recording the replay of the one before -
 * and the ledger would grow every time somebody scrubbed.
 */
let replaying = false;

/**
 * Whether a rebuild is in progress, for history.js.
 *
 * A rule is re-run by calling the command that made it, and commands commit -
 * so without this every rebuilt step would push an undo entry for the *replay*
 * of a step, and one edit to a step in the past would leave forty entries on
 * the undo stack for work nobody did.
 */
export const isReplaying = () => replaying;

/** How many steps a file may carry, before trimming is offered. */
const TIMELINE_STEP_CAP = 20000;

export const timelineSteps = () => steps;
export const timelineAt = () => at;
export const timelineStale = () => stale;

/**
 * Start over with the board as it stands.
 *
 * Called wherever the undo stacks are cleared, which keeps phase 1's contract -
 * replay and undo agree - true by construction. It is also the one place this
 * design currently loses history it should keep: switching layout mode clears
 * the stacks, so it clears the timeline, where a persistent history ought to
 * record the switch and carry on. Fixing that means rebasing rather than
 * resetting, and it belongs with phase 2, where the marker becomes the only
 * history there is.
 */
export function resetTimeline() {
  steps = [];
  at = 0;
  base = snapshot();
  checkpoints = new Map();
  stale = false;
}

/**
 * Write down what happened between `before` and now.
 *
 * The run key is computed here rather than passed in, because the caller -
 * commit(), which knows only a label and two closures - genuinely does not know
 * what changed, and the delta does. Two consecutive steps merge when they touch
 * the same cards in the same fields: move a card twice with nothing in between
 * and it is one step, move it and then recolour it and it is two. Anything else
 * you do lands a step with a different key, which is what closes a run.
 */
export function recordStep(label: string, before: Snap): Step | null {
  // Taken and cleared whatever happens below, so a declaration cannot outlive
  // the mutation it was made for. See pendingOp.
  const op = pendingOp;
  pendingOp = null;
  // A rebuild moves the board by running the steps; a step recorded for that
  // would be a step about the replaying of a step. See `replaying`.
  if (replaying) return null;
  const after = snapshot();
  const delta = diff(before, after);
  if (!delta) return null;
  // Doing something new with the marker rolled back drops what was ahead of it,
  // the way undo does everywhere. Fusion inserts instead; see the design note.
  if (at < steps.length) {
    steps.length = at;
    for (const key of [...checkpoints.keys()]) if (key > at) checkpoints.delete(key);
  }
  // A step with a rule never merges into the one before it. Two aligns in a row
  // are two decisions, and folding them would leave one step whose recorded
  // parameters describe the second while its difference describes both.
  const run = op ? '' : runKey(delta);
  const prev = steps[steps.length - 1];
  if (run && prev && prev.run === run) {
    prev.delta = mergeDelta(prev.delta, delta);
    prev.at = Date.now();
    prev.label = label;
    // A run that folded back to nothing is not a step. Dropping it here is what
    // stops "moved it and moved it back" leaving a dot behind.
    if (!Object.keys(prev.delta).length) {
      steps.pop();
      checkpoints.delete(at);
      at = steps.length;
      return null;
    }
    // **A checkpoint on this mark now describes a board that never existed.**
    //
    // The mark a checkpoint is filed under means *the board after this many
    // steps*, and this branch has just changed what the last of those steps
    // does without changing how many there are. The picture taken when the step
    // first landed shows the board after the first nudge of a run, and replayTo
    // trusts it over the base: so every jump to this mark or past it rebuilt
    // from a board a step and a half old, and every field the rest of the run
    // touched stayed at its first value for the rest of the session.
    //
    // Refreshed rather than dropped, because `after` is exactly the picture the
    // mark is supposed to hold - the board as it stands, which is where this
    // run has got to. Dropping it would be correct too and would cost the next
    // jump a walk from the last checkpoint.
    //
    // Only this mark can be wrong. Nothing is filed beyond `at` - the marker is
    // at the end of the list on this path, and the truncation above has already
    // cleared anything a rolled-back marker left ahead of it.
    if (checkpoints.has(at)) checkpoints.set(at, after);
    return prev;
  }
  const step: Step = {
    id: uid('s'), at: Date.now(), label, run, delta, ...(op ? { op } : {}),
  };
  steps.push(step);
  at = steps.length;
  if (at % CHECKPOINT_EVERY === 0) checkpoints.set(at, after);
  if (steps.length > TIMELINE_STEP_CAP) foldOldest(steps.length - TIMELINE_STEP_CAP);
  return step;
}

/**
 * What makes two steps one: the ids that changed, and which of their fields.
 *
 * Field-level rather than id-level on purpose. Same cards and same fields is a
 * run - twelve taps of an arrow key, a colour slider dragged across its range.
 * Same card and different fields is two intentions and reads as two steps.
 */
function runKey(delta: Delta): string {
  const parts: string[] = [];
  const ids = new Set<string>();
  const fields = new Set<string>();
  const sections = ['items', 'desktop', 'mobile', 'trash'] as const;
  for (const section of sections) {
    const keyedPart = delta[section];
    if (!keyedPart) continue;
    // An arriving or departing card is never part of a run: the two sides of
    // its pair are an object and nothing, and collapsing "added" into "moved"
    // would hide the add.
    if (keyedPart.order) return '';
    for (const id of Object.keys(keyedPart.changed)) {
      const pair = keyedPart.changed[id];
      if (pair[0] == null || pair[1] == null) return '';
      ids.add(section + ':' + id);
      for (const field of changedFields(pair[0], pair[1])) fields.add(field);
    }
  }
  for (const field of Object.keys(delta.rest || {})) fields.add('rest.' + field);
  if (!ids.size && !fields.size) return '';
  parts.push([...ids].sort().join(','));
  parts.push([...fields].sort().join(','));
  return parts.join('|');
}

/** Which top-level keys differ between two serialised records. */
function changedFields(before: string, after: string): string[] {
  let a: unknown;
  let b: unknown;
  try {
    a = JSON.parse(before);
    b = JSON.parse(after);
  } catch { return ['?']; }
  if (!isRecord(a) || !isRecord(b)) return ['?'];
  const out: string[] = [];
  for (const key of new Set([...Object.keys(a), ...Object.keys(b)])) {
    if (JSON.stringify(a[key]) !== JSON.stringify(b[key])) out.push(key);
  }
  return out;
}

/**
 * Note that the board moved without a step being recorded.
 *
 * undo() and redo() move the board by running the closures they already hold,
 * which is faster than replaying and - during phase 1, while both engines run -
 * is also the thing the timeline is being checked *against*. So they tell this
 * module which way the marker went rather than driving it.
 */
export function markerBack() {
  if (at > 0) at -= 1;}

export function markerForward() {
  if (at < steps.length) at += 1;}

/** Drop the newest step, for a caller withdrawing something it did itself. */
export function dropLastStep() {
  if (at !== steps.length || !steps.length) return;
  steps.pop();
  checkpoints.delete(at);
  at = steps.length;}

/**
 * How large the history would be in a file, in bytes.
 *
 * Measured rather than estimated, because the whole point of the number is to
 * decide whether to offer somebody a trim, and an estimate that was wrong in the
 * generous direction would never offer while an estimate wrong the other way
 * would offer on a board that did not need it.
 */
export function timelineBytes(): number {
  const doc = serializeTimeline();
  return doc ? JSON.stringify(doc).length : 0;
}

/** Past this, the app offers to trim. It never trims without being asked. */
export const TRIM_BYTES = 2_000_000;
/** And it offers to fold away steps older than this. */
export const TRIM_DAYS = 30;

/** Whether there is enough history, old enough, to be worth offering to fold. */
export function trimmable(now = Date.now()): number {
  return foldableCount(now - TRIM_DAYS * 86_400_000);
}

/**
 * How many of the oldest steps could be folded into the starting state.
 *
 * **Never past a named step**, which is the rule that makes this safe to offer.
 * A named step is a saved version, and folding one away would destroy a point
 * somebody deliberately marked - so the count stops at the oldest name whatever
 * the dates say. If that name is four years old, nothing is foldable, and the
 * offer says so rather than quietly doing less than it promised.
 *
 * And never past the marker: folding a step the board has not reached would
 * make the starting state describe a future.
 */
function foldableCount(before: number): number {
  let count = 0;
  while (count < at && steps[count].at < before && !steps[count].name) count += 1;
  return count;
}

/**
 * Fold the oldest steps older than TRIM_DAYS into the starting state.
 *
 * An offer, never a policy - this is only ever called from a control somebody
 * pressed. The app quietly throwing away last month is precisely the failure the
 * whole feature exists to prevent, and a history is somebody's record of their
 * own work rather than a cache the app is entitled to evict from.
 *
 * Returns how many steps went.
 */
export function trimTimeline(now = Date.now()): number {
  const count = trimmable(now);
  if (count <= 0) return 0;
  foldOldest(count);
  bus.emit('history');
  return count;
}

/** Fold the oldest `count` steps into the starting snapshot. */
function foldOldest(count: number) {
  const take = Math.min(count, at);
  if (take <= 0) return;
  const snap = base;
  restoreInto(snap, steps.slice(0, take));
  base = snap;
  steps = steps.slice(take);
  at -= take;
  checkpoints = new Map();
}

/** Apply steps to a snapshot without touching the board. Used by foldOldest. */
function restoreInto(snap: Snap, run: Step[]) {
  const keep = snapshot();
  restore(snap);
  for (const step of run) apply(step.delta, true);
  const folded = snapshot();
  restore(keep);
  Object.assign(snap, folded);
}

// ---------------------------------------------------------------------------
// Replay
// ---------------------------------------------------------------------------

/**
 * Put the board at a point in the history.
 *
 * Forward from the nearest checkpoint at or behind the target, which is what
 * bounds it: never more than CHECKPOINT_EVERY steps of work, whichever way you
 * came from and however long the history is.
 */
export function replayTo(target: number) {
  const want = Math.max(0, Math.min(target, steps.length));
  let from = 0;
  let snap = base;
  for (const [mark, saved] of checkpoints) {
    if (mark <= want && mark > from) { from = mark; snap = saved; }
  }
  restore(snap);
  for (let i = from; i < want; i += 1) {
    // Marked and skipped, never fatal. One step that cannot run must not cost
    // the reader every step after it, and a replay that threw would leave the
    // board halfway between two points with nothing saying so.
    try {
      apply(steps[i].delta, true);
      steps[i].broken = false;
    } catch {
      steps[i].broken = true;
    }
    const next = i + 1;
    if (next % CHECKPOINT_EVERY === 0 && !checkpoints.has(next)) {
      checkpoints.set(next, snapshot());
    }
  }
  at = want;}

/**
 * Say that the board changed wholesale.
 *
 * A replay is not a change to three cards, it is the board becoming a different
 * board - so this is the same announcement loadBoard() makes, minus the two that
 * mean "a whole new document arrived". A payloadless `items` is the agreed
 * signal for *membership changed, extent unknown, rescan*, which every
 * delta-aware listener already falls back to; `geom` carries every id because
 * after a replay every card may have moved.
 *
 * The selection is pruned first. A replay can take away the very card that was
 * selected, and a selection holding an id no longer on the board is how a later
 * command comes to act on nothing while the toolbar says it has something.
 */
function announce() {
  const live = new Set(board.items.map(i => i.id));
  let dropped = false;
  for (const id of selection) if (!live.has(id)) { selection.delete(id); dropped = true; }
  bus.emit('items');
  bus.emit('geom', [...live]);
  if (dropped) bus.emit('selection');
  bus.emit('connections');
  bus.emit('trash');
  bus.emit('board');
}

/**
 * Move the board one step back, off the record rather than off a closure.
 *
 * This is what undo becomes once the session's own stack is empty - which is to
 * say, this is undo *after a refresh*, the thing it has never been able to do.
 * Returns false when there is nothing behind the marker, so the caller can
 * answer the same way it always did.
 */
export function stepBack(): boolean {
  if (at <= 0) return false;
  replayTo(at - 1);
  announce();
  return true;
}

export function stepForward(): boolean {
  if (at >= steps.length) return false;
  replayTo(at + 1);
  announce();
  return true;
}

/**
 * Put the board at a point, and say so. What the strip's dots call.
 *
 * The one door in this module that both moves the board *and* announces it, so
 * that a caller above the board layer needs nothing else. Returns false for a
 * jump to where the board already is, which is what stops a click on the
 * current step from marking a clean board dirty.
 */
export function goTo(target: number): boolean {
  const want = Math.max(0, Math.min(target, steps.length));
  if (want === at) return false;
  replayTo(want);
  announce();
  markDirty();
  bus.emit('history');
  return true;
}

/**
 * Change what a step in the past was told to do, and rebuild on top of it.
 *
 * **The thing the whole feature is for.** Everything before this point is a
 * history you can look at; this is a history you can reach into. Merge the new
 * arguments into the step's rule, put the board back to just before it, and run
 * every step from there forward again.
 *
 * False for a step that has no rule - a sealed step carries a difference and
 * there is nothing in a difference to change.
 */
export function editStep(index: number, params: Record<string, unknown>): boolean {
  const step = steps[index];
  if (!step || !stepEditable(step)) return false;
  step.op = { name: step.op!.name, params: { ...step.op!.params, ...params } };
  rebuildFrom(index);
  return true;
}

/**
 * Run the board forward from a point, re-running every rule it passes.
 *
 * The difference from replayTo() is the whole reason both exist. Scrubbing uses
 * the recorded differences, because writing down an answer is faster than
 * working it out again and the answer cannot have changed. A rebuild works them
 * out again, because something upstream *has* changed - that is why it is being
 * called - and a recorded answer is exactly what must not be trusted now.
 *
 * A step whose rule throws is marked broken, skipped, and left in place: the
 * board still builds, the rest still replay, and the strip shows the one that
 * could not run rather than the app quietly dropping somebody's step. A sealed
 * step in the middle of a rebuild replays its difference as it always does,
 * which is what lets a converted command sit among unconverted ones.
 */
export function rebuildFrom(index: number) {
  const from = Math.max(0, Math.min(index, steps.length));
  replayTo(from);
  replaying = true;
  try {
    for (let i = from; i < steps.length; i += 1) {
      const step = steps[i];
      const before = snapshot();
      if (stepEditable(step)) {
        try {
          OPS.get(step.op!.name)!(step.op!.params);
          step.broken = false;
        } catch {
          step.broken = true;
        }
        // Re-recorded, so that scrubbing back through this step afterwards uses
        // the answer it has now rather than the one it had before the edit.
        step.delta = diff(before, snapshot()) || {};
      } else {
        try {
          apply(step.delta, true);
          step.broken = false;
        } catch {
          step.broken = true;
        }
      }
    }
  } finally {
    // In a finally, because a throw that left this latched would silently stop
    // the app recording anything at all for the rest of the session - a failure
    // that looks like nothing rather than like an error.
    replaying = false;
  }
  at = steps.length;  // Every checkpoint behind the rebuilt run described boards that no longer
  // exist. Cheaper to drop them than to work out which survived.
  checkpoints = new Map();
  announce();
  markDirty();
  bus.emit('history');
}

/**
 * Give the step the board is standing on a name.
 *
 * What makes a point on the strip a landmark rather than one of four hundred
 * identical dots, and what a saved version writes as well as its copy. False
 * when the board is at the very beginning, which has no step to name - the
 * starting state is not something that was *done*.
 */
export function nameStep(name: unknown): boolean {
  if (at <= 0 || typeof name !== 'string') return false;
  const trimmed = name.trim().slice(0, 120);
  if (trimmed) steps[at - 1].name = trimmed;
  else delete steps[at - 1].name;
  bus.emit('history');
  return true;
}

/** What stepping either way would be, by name, or null for nothing there. */
export const stepBackLabel = () => (at > 0 ? steps[at - 1].label : null);
export const stepForwardLabel = () => (at < steps.length ? steps[at].label : null);

/** What a step touched: how many cards, and what to call the first of them. */
export type StepSubject = { count: number, name: string };

/**
 * What a step was done *to*, read back out of its own delta.
 *
 * `Move` is not a sentence. `Moved Sunset.jpg` is, and the difference is the
 * whole of whether a long history can be skimmed - which is the one thing a
 * strip of four hundred marks is for. The verb is already on the step as its
 * label; this is the object of it.
 *
 * **Derived rather than stored, and that is deliberate.** The delta already
 * holds both sides of every card the step touched, so a second copy on the step
 * would be one more thing to write into the file and one more thing to go stale
 * the moment a step is rebuilt against edited parameters - which is exactly when
 * the subject is most likely to have changed.
 *
 * Read from the *after* side where there is one and the *before* side otherwise,
 * so a delete names what was deleted rather than naming nothing. Falls back
 * through the same ladder the rest of the app uses for an unnamed card: its own
 * name, then the first words of a note, then the kind of thing it is.
 */
export function describeStep(step: Step): StepSubject {
  // Cards first, then the bin, then the two geometry profiles. The order is the
  // order of how much a person would recognise: a card is a thing they put
  // there, a layout entry is a consequence.
  for (const section of [step.delta.items, step.delta.trash,
                         step.delta.desktop, step.delta.mobile]) {
    const pairs = Object.values(section?.changed || {});
    if (!pairs.length) continue;
    return { count: pairs.length, name: nameOfPair(pairs[0]) };
  }
  return { count: 0, name: '' };
}

/**
 * The one thing that reads inside a stored value, and the only place in this
 * module that does.
 *
 * Everything else here treats a keyed value as opaque text - that is what makes
 * the diff a string comparison and the whole module cheap. This has to look, so
 * it does it in one function, tolerantly: a value that will not parse, or parses
 * to something that is not an object, yields no name rather than an exception.
 * A history that cannot be *described* must still be one you can walk.
 */
function nameOfPair([before, after]: [string | null, string | null]): string {
  for (const raw of [after, before]) {
    if (!raw) continue;
    let value: unknown;
    try { value = JSON.parse(raw); } catch { continue; }
    // A bin entry is { at, item }; a card is the card. One unwrap covers both.
    const rec = isRecord(value) && isRecord(value.item) ? value.item : value;
    if (!isRecord(rec)) continue;
    if (typeof rec.name === 'string' && rec.name.trim()) return rec.name.trim();
    const meta = isRecord(rec.meta) ? rec.meta : null;
    const text = typeof meta?.text === 'string' ? meta.text : '';
    const first = text.split('\n')[0].trim();
    if (first) return first.length > 28 ? `${first.slice(0, 27)}...` : first;
    if (typeof rec.type === 'string' && rec.type) return rec.type;
  }
  return '';
}

/**
 * FNV-1a. Not a cryptographic digest and not trying to be - see the two callers
 * below for what is actually being asked. crypto.subtle would be a better hash
 * and is asynchronous, which would make every caller of this asynchronous for
 * no gain.
 */
function hashText(...parts: string[]): string {
  let hash = 0x811c9dc5;
  for (const text of parts) {
    for (let i = 0; i < text.length; i += 1) {
      hash ^= text.charCodeAt(i);
      hash = Math.imul(hash, 0x01000193) >>> 0;
    }
    hash ^= 0;
  }
  return hash.toString(16);
}

/**
 * A hash of the live board. For the tests, which compare a board reached one
 * way against the same board reached another - see the oracle in
 * tests/timeline.test.js.
 *
 * **Not what the file's fingerprint is taken over.** See docFingerprint().
 */
export function fingerprint(snap: Snap = snapshot()): string {
  const parts: string[] = [];
  for (const id of snap.itemOrder) parts.push(snap.items[id]);
  for (const id of snap.trashOrder) parts.push(snap.trash[id]);
  for (const id of Object.keys(snap.desktop)) parts.push(snap.desktop[id]);
  for (const id of Object.keys(snap.mobile)) parts.push(snap.mobile[id]);
  for (const field of REST_FIELDS) parts.push(snap.rest[field] || '');
  return hashText(...parts);
}

/**
 * A hash of the board *as a file carries it*, so a stale timeline cannot lie.
 *
 * Taken over the stored document rather than over the live board, and the
 * distinction is the whole of why this function exists separately. A board
 * written to a file and read back is not the same object it was: coordinates
 * are rounded to two places, absent keys take their defaults, the two layouts
 * are recomputed on the way in. A fingerprint of the live board would therefore
 * disagree with itself across an ordinary save and load, and every reopened
 * board would be declared stale - which is worse than not checking, because a
 * warning that is always wrong is a warning nobody reads.
 *
 * `items` and `trash` alone, because those are what a step describes. The
 * failure being guarded is specific: an older build opens the file, does not
 * understand `timeline`, drops it, and writes the board back - possibly edited.
 * Bring that file here and the steps no longer describe the board beside them.
 * Hashing the item list catches exactly that, and does not fire on a view that
 * panned or a setting that moved, neither of which any step's correctness
 * depends on.
 */
export function docFingerprint(doc: unknown): string {
  if (!isRecord(doc)) return '';
  return hashText(JSON.stringify(doc.items ?? []), JSON.stringify(doc.trash ?? []));
}

// ---------------------------------------------------------------------------
// The file
// ---------------------------------------------------------------------------

/**
 * The timeline as board.json carries it, or null when there is nothing to say.
 *
 * The fingerprint is handed in rather than taken here, because it is a hash of
 * the *document* and this module never sees one - board-schema.js builds it and
 * is therefore the only place that can. See docFingerprint().
 */
export function serializeTimeline(fingerprintOf = '') {
  if (!steps.length) return null;
  return {
    base,
    at,
    fingerprint: fingerprintOf,
    steps: steps.map(step => ({
      id: step.id, at: step.at, label: step.label, run: step.run,
      ...(step.name ? { name: step.name } : {}),
      delta: step.delta,
    })),
  };
}

/**
 * Take a stored timeline as this session's history.
 *
 * Called after the board itself is on screen, and it checks rather than trusts:
 * if the steps do not add up to the board they arrived with, the timeline is
 * marked stale and the app shows it as unusable. A history that quietly
 * describes the wrong board is worse than no history, which is the whole reason
 * the fingerprint is written in the first place.
 */
export function adoptTimeline(raw: unknown, doc?: unknown) {
  resetTimeline();
  if (!isRecord(raw) || !Array.isArray(raw.steps) || !isRecord(raw.base)) return;
  const parsed: Step[] = [];
  for (const entry of raw.steps) {
    if (!isRecord(entry) || !isRecord(entry.delta)) continue;
    parsed.push({
      id: typeof entry.id === 'string' && entry.id ? entry.id.slice(0, 64) : uid('s'),
      at: Number.isFinite(entry.at) ? Number(entry.at) : 0,
      label: typeof entry.label === 'string' ? entry.label.slice(0, 120) : 'Change',
      run: typeof entry.run === 'string' ? entry.run.slice(0, 400) : '',
      ...(typeof entry.name === 'string' && entry.name
        ? { name: entry.name.slice(0, 120) } : {}),
      delta: entry.delta as Delta,
    });
    if (parsed.length >= TIMELINE_STEP_CAP) break;
  }
  if (!parsed.length) return;
  base = raw.base as Snap;
  steps = parsed;
  at = Number.isFinite(raw.at)
    ? Math.max(0, Math.min(Number(raw.at), steps.length))
    : steps.length;  // Against the document that arrived, not against the board that was built
  // from it - see docFingerprint(). A timeline with no fingerprint at all is
  // taken at its word: that is what a file written before this check existed
  // looks like, and refusing those would be treating an old friend as a forgery.
  const claimed = typeof raw.fingerprint === 'string' ? raw.fingerprint : '';
  stale = !!claimed && doc !== undefined && claimed !== docFingerprint(doc);
}

/**
 * Every asset hash the steps point at.
 *
 * **The third member of the reference union, and the reason this function had
 * to land in the same commit as the first recorded step.** packBoard() writes
 * only hashes something references and the autosave sweep deletes whatever
 * nothing claims. A step that added a picture and was then rolled back names
 * that picture and nothing else does - so if this is missing, the sweep deletes
 * the bytes and the step comes back as a hole. The other two are the live board
 * and the bin; a fourth, the stored versions, went in v0.198.
 *
 * Both sides of every pair, not the after alone: the *before* is what going
 * backwards restores, and a picture that a step deleted is exactly the picture
 * stepping back has to put on the board again.
 */
export function timelineHashes(raw: unknown = serializeTimeline()): Set<string> {
  const out = new Set<string>();
  if (!isRecord(raw)) return out;
  const eat = (text: unknown) => {
    if (typeof text !== 'string') return;
    let parsed: unknown;
    try { parsed = JSON.parse(text); } catch { return; }
    // A bin entry is a wrapper; an item is itself. Both reach itemHashes().
    const item = isRecord(parsed) && isRecord(parsed.item) ? parsed.item : parsed;
    if (!isRecord(item)) return;
    for (const hash of itemHashes(item)) out.add(hash);
    // The optimiser's memo of what it replaced. Held for the same reason the
    // session sweep holds it: stepping back through an optimise has to be able
    // to put the original bytes back.
    const meta = isRecord(item.meta) ? item.meta : null;
    for (const key of ['was', 'wasCover']) {
      const value = meta?.[key];
      if (typeof value === 'string' && value) out.add(value);
    }
  };
  const eatKeyed = (section: unknown) => {
    if (!isRecord(section) || !isRecord(section.changed)) return;
    for (const pair of Object.values(section.changed)) {
      if (!Array.isArray(pair)) continue;
      for (const half of pair) eat(half);
    }
  };
  const snapBase = raw.base;
  if (isRecord(snapBase)) {
    for (const section of ['items', 'trash']) {
      const list = snapBase[section];
      if (isRecord(list)) for (const text of Object.values(list)) eat(text);
    }
  }
  if (!Array.isArray(raw.steps)) return out;
  for (const step of raw.steps) {
    if (!isRecord(step) || !isRecord(step.delta)) continue;
    for (const section of ['items', 'trash']) eatKeyed(step.delta[section]);
  }
  return out;
}
