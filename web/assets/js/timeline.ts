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

import { board } from './board-model.ts';
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
  /** A name somebody gave this point. Phase 3 turns saved versions into these. */
  name?: string,
  delta: Delta,
};

/**
 * The fields of the board a step carries, beyond the four keyed lists above.
 *
 * `versions` is deliberately absent. A stored version holds a whole copy of the
 * board, so a step recording one would be the largest step in the file by three
 * orders of magnitude - and the plan is for versions to *become* named steps
 * rather than be recorded as changes to a list. Until then, saving a version is
 * a change the timeline does not describe. That is a known and stated gap, not
 * an oversight.
 *
 * `items`, `layouts` and `trash` are absent for the opposite reason: they are
 * the keyed sections, handled per id.
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

function applyKeyed<T extends { id: string }>(
  current: T[], delta: KeyedDelta, forward: boolean, idOf: (v: T) => string,
): T[] {
  // Rebuilt through a map rather than by index so that an item nothing touched
  // keeps its object identity. Other modules hold references - the id index in
  // board-model.js, a gesture in canvas/input.js - and replacing every object
  // on every step would invalidate all of them for the sake of one that moved.
  const map = new Map<string, T>();
  for (const entry of current) map.set(idOf(entry), entry);
  for (const id of Object.keys(delta.changed)) {
    const want = side(delta.changed[id], forward);
    if (want == null) map.delete(id);
    else map.set(id, JSON.parse(want));
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
    for (const field of Object.keys(delta.rest)) {
      (board as unknown as Record<string, unknown>)[field] =
        JSON.parse(side(delta.rest[field], forward));
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
/** The snapshot the next step will be diffed against. Kept, not retaken. */
let head: Snap = base;
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

/** How many steps a file may carry, before trimming is offered. */
export const TIMELINE_STEP_CAP = 20000;

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
  head = base;
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
  const after = snapshot();
  const delta = diff(before, after);
  head = after;
  if (!delta) return null;
  // Doing something new with the marker rolled back drops what was ahead of it,
  // the way undo does everywhere. Fusion inserts instead; see the design note.
  if (at < steps.length) {
    steps.length = at;
    for (const key of [...checkpoints.keys()]) if (key > at) checkpoints.delete(key);
  }
  const run = runKey(delta);
  const prev = steps[steps.length - 1];
  if (run && prev && prev.run === run) {
    prev.delta = mergeDelta(prev.delta, delta);
    prev.at = Date.now();
    prev.label = label;
    // A run that folded back to nothing is not a step. Dropping it here is what
    // stops "moved it and moved it back" leaving a dot behind.
    if (!Object.keys(prev.delta).length) {
      steps.pop();
      at = steps.length;
      return null;
    }
    return prev;
  }
  const step: Step = { id: uid('s'), at: Date.now(), label, run, delta };
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

/** The snapshot the next step is measured against. commit() takes this. */
export const timelineHead = () => head;

/**
 * Note that the board moved without a step being recorded.
 *
 * undo() and redo() move the board by running the closures they already hold,
 * which is faster than replaying and - during phase 1, while both engines run -
 * is also the thing the timeline is being checked *against*. So they tell this
 * module which way the marker went rather than driving it.
 */
export function markerBack() {
  if (at > 0) at -= 1;
  head = snapshot();
}

export function markerForward() {
  if (at < steps.length) at += 1;
  head = snapshot();
}

/** Drop the newest step, for a caller withdrawing something it did itself. */
export function dropLastStep() {
  if (at !== steps.length || !steps.length) return;
  steps.pop();
  checkpoints.delete(at);
  at = steps.length;
  head = snapshot();
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
    apply(steps[i].delta, true);
    const next = i + 1;
    if (next % CHECKPOINT_EVERY === 0 && !checkpoints.has(next)) {
      checkpoints.set(next, snapshot());
    }
  }
  at = want;
  head = snapshot();
}

/**
 * A cheap hash of the board, so a stale timeline cannot quietly lie.
 *
 * FNV-1a over the snapshot's text. Not a cryptographic digest and not trying to
 * be: the question is whether a file's steps still describe the board beside
 * them, and the failure being guarded is an older build dropping the timeline,
 * writing the board back and it being opened here again. crypto.subtle would be
 * a better hash and is asynchronous, which would make every caller of this
 * asynchronous for no gain.
 */
export function fingerprint(snap: Snap = snapshot()): string {
  let hash = 0x811c9dc5;
  const feed = (text: string) => {
    for (let i = 0; i < text.length; i += 1) {
      hash ^= text.charCodeAt(i);
      hash = Math.imul(hash, 0x01000193) >>> 0;
    }
  };
  for (const id of snap.itemOrder) feed(snap.items[id]);
  for (const id of snap.trashOrder) feed(snap.trash[id]);
  for (const id of Object.keys(snap.desktop)) feed(snap.desktop[id]);
  for (const id of Object.keys(snap.mobile)) feed(snap.mobile[id]);
  for (const field of REST_FIELDS) feed(snap.rest[field] || '');
  return hash.toString(16);
}

// ---------------------------------------------------------------------------
// The file
// ---------------------------------------------------------------------------

/** The timeline as board.json carries it, or null when there is nothing to say. */
export function serializeTimeline() {
  if (!steps.length) return null;
  return {
    base,
    at,
    fingerprint: fingerprint(head),
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
export function adoptTimeline(raw: unknown) {
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
    : steps.length;
  head = snapshot();
  const claimed = typeof raw.fingerprint === 'string' ? raw.fingerprint : '';
  stale = !!claimed && claimed !== fingerprint(head);
}

/**
 * Every asset hash the steps point at.
 *
 * **The fourth reader of the reference union, and the reason this function has
 * to land in the same commit as the first recorded step.** packBoard() writes
 * only hashes something references and the autosave sweep deletes whatever
 * nothing claims. A step that added a picture and was then rolled back names
 * that picture and nothing else does - so if this is missing, the sweep deletes
 * the bytes and the step comes back as a hole. See versionHashes() in
 * board-schema.js, which is the same problem one class earlier.
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
