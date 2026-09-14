// Step ledger: every board change as a reversible JSON diff. Sealed (replay
// exactly) unless a step carries an `op`. Below state.ts — may never import it.

import { board, dropIdIndex } from './board-model.ts';
import { bus, selection, markDirty } from './board-store.ts';
import { itemHashes, isRecord, uid } from './util.ts';

// ---------------------------------------------------------------------------
// The shape of a snapshot, and of the difference between two
// ---------------------------------------------------------------------------

/** Items as id → JSON string. Keyed so a nudge diff is one item, not the whole array. */
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

/** Per-id `[before, after]` pairs (null = absent). Reversible by reading the other side. */
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
  /** Merge key: same cards + same fields = one step. Empty never merges. */
  run: string,
  /** User-given landmark name (replaces saved-version copies). */
  name?: string,
  /** Marked when replay threw — skipped, not deleted, so the strip shows it. */
  broken?: boolean,
  /** The rule (name + params) for editable steps. Sealed steps have only `delta`;
   *  an op step also carries *why*, so changing a param re-runs the computation. */
  op?: { name: string, params: Record<string, unknown> },
  delta: Delta,
};

/** Step as serialized: five core fields + optional `name`. `op`/`broken` are session-only. */
type SerializedStep = Pick<Step, 'id' | 'at' | 'label' | 'run' | 'delta'> & { name?: string };

/** Board fields beyond the four keyed lists. `versions` excluded — a full copy would dwarf every step.
 *  Exported for tests/timeline-drift.test.js, which holds every one of them to a trip. */
export const REST_FIELDS = [
  'title', 'view', 'sharedAppearance', 'layoutSettings', 'settings',
  'arrangement', 'arrangements', 'layoutMode', 'mobileHeader', 'titleHidden',
  'mediaFit', 'paletteSources', 'connections', 'audioOrder', 'tour',
] as const;

/** Type-checked cast — every REST_FIELDS name is a board key. */
type RestField = typeof REST_FIELDS[number];
type RestBag = Record<RestField, unknown>;

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
  // Keyed by the item's id, not the entry's - a TrashEntry has no id of its own.
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
  // Right after the assignment: board-model.ts's id index normally drops on
  // an 'items' announcement, but a replay announces nothing until it's
  // done - without this, byId() during a rebuild would answer out of the
  // pre-replay board, and an op runner would write to an object no longer on it.
  dropIdIndex();
  board.layouts.desktop = Object.keys(snap.desktop).map(id => JSON.parse(snap.desktop[id]));
  board.layouts.mobile = Object.keys(snap.mobile).map(id => JSON.parse(snap.mobile[id]));
  board.trash = snap.trashOrder.map(id => JSON.parse(snap.trash[id]));
  for (const field of REST_FIELDS) {
    if (snap.rest[field] == null) continue;
    // RestBag lets one loop cover all field types without per-field casts.
    const live: RestBag = board;
    live[field] = JSON.parse(snap.rest[field]);
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

/** Merge only the fields that differ between `from` and `to` into `held`. Top-level keys only. */
function mergeChanged(
  held: unknown, from: Record<string, unknown>, to: Record<string, unknown>,
): Record<string, unknown> {
  // SAFETY: spreading a non-object contributes no keys → empty `next` for absent items.
  const next = { ...(held as Record<string, unknown>) };
  for (const key of new Set([...Object.keys(from), ...Object.keys(to)])) {
    if (JSON.stringify(from[key]) === JSON.stringify(to[key])) continue;
    if (key in to) next[key] = to[key];
    else delete next[key];
  }
  return next;
}

// Unconstrained in T: trash carries its id on `item`, not itself.
function applyKeyed<T>(
  current: T[], delta: KeyedDelta, forward: boolean, idOf: (v: T) => string,
): T[] {
  // Map preserves object identity for untouched items (id index, gestures hold refs).
  const map = new Map<string, T>();
  for (const entry of current) map.set(idOf(entry), entry);
  for (const id of Object.keys(delta.changed)) {
    const pair = delta.changed[id];
    const want = side(pair, forward);
    const leaving = side(pair, !forward);
    const held = map.get(id);
    if (want == null) { map.delete(id); continue; }
    // Only changed fields — writing the whole object would let the next sealed
    // step quietly restore old values (e.g. position) alongside its own change.
    if (leaving == null || !held) { map.set(id, JSON.parse(want)); continue; }
    // SAFETY: values came from JSON.parse of serialize() output; mergeChanged replaces, never invents.
    map.set(id, mergeChanged(held, JSON.parse(leaving), JSON.parse(want)) as T);
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
  // Items the recorded order omits still belong on the board (malformed step guard).
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
    const live: RestBag = board;
    // Walked over REST_FIELDS so `field` stays typed as RestField.
    for (const field of REST_FIELDS) {
      const pair = delta.rest[field];
      if (!pair) continue;
      const to = JSON.parse(side(pair, forward));
      const from = JSON.parse(side(pair, !forward));
      // Merge only changed keys — writing the whole settings object resets other settings.
      const plain = isRecord(to) && isRecord(from) && isRecord(live[field]);
      // SAFETY: `plain` guards isRecord() on all three.
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
      // Earliest before, latest after — the whole of collapsing a run.
      const from = changed[id] ? changed[id][0] : b.changed[id][0];
      changed[id] = [from, b.changed[id][1]];
    }
    // A card moved out and back is not a change.
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
/** Full snapshots at intervals for bounded backward travel. In-memory only (too large to store). */
const CHECKPOINT_EVERY = 50;
let checkpoints = new Map<number, Snap>();

/** Whether the steps still describe the board they claim to. See fingerprint(). */
let stale = false;

// ---------------------------------------------------------------------------
// Drift: what the board did outside the ledger
// ---------------------------------------------------------------------------

/**
 * The board the ledger stands on at `at`, as text.
 *
 * Not every write is a step. A rename, a setting, the look, the fonts, the
 * tour, the playlist order, the camera and a card's thumbnail all change the
 * board with no step. A replay starts from `base` or a checkpoint, which know
 * nothing of those writes, so a trip back and forward used to lose every one
 * of them: rename the board, step back, step forward, and the old name was
 * back (research/rapid-fixes-2026-09-14.md, R5).
 *
 * So before anything records or replays, absorbDrift() compares the board with
 * this and writes the difference into every stored board: `base`, the
 * checkpoints, and each step that writes a card whole. Every point in the
 * history then carries it.
 */
let synced: Snap = base;

/** A value as JSON.parse() hands it back. */
type JsonValue = string | number | boolean | null | JsonValue[] | { [key: string]: JsonValue };

const isJsonObject = (v: JsonValue | undefined): v is { [key: string]: JsonValue } =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

/**
 * `held` with the leaves that differ between `from` and `to` written in. Deep,
 * unlike mergeChanged(): a thumbnail written into `meta` must not carry a later
 * `meta.text` back into the past with it.
 */
function mergeDeep(held: JsonValue | undefined, from: JsonValue, to: JsonValue): JsonValue {
  if (!isJsonObject(held) || !isJsonObject(from) || !isJsonObject(to)) return to;
  const next = { ...held };
  for (const key of new Set([...Object.keys(from), ...Object.keys(to)])) {
    if (JSON.stringify(from[key]) === JSON.stringify(to[key])) continue;
    if (key in to) next[key] = mergeDeep(held[key], from[key] ?? null, to[key]);
    else delete next[key];
  }
  return next;
}

/** mergeDeep() over stored text. */
function mergeText(held: string, from: string, to: string): string {
  try {
    return JSON.stringify(mergeDeep(JSON.parse(held), JSON.parse(from), JSON.parse(to)));
  } catch {
    return to;
  }
}

const KEYED_SECTIONS = ['items', 'desktop', 'mobile', 'trash'] as const;

/** Write what the board did outside the ledger into every stored board. */
function absorbDrift(live: Snap = snapshot()) {
  const drift = diff(synced, live);
  synced = live;
  if (!drift) return;
  const stored = [base, ...checkpoints.values()];
  for (const section of KEYED_SECTIONS) {
    const part = drift[section];
    if (!part) continue;
    for (const id of Object.keys(part.changed)) {
      const [from, to] = part.changed[id];
      // A change to a card that exists on both sides. An add or a removal
      // outside the ledger has no place in the past.
      if (from == null || to == null) continue;
      for (const snap of stored) {
        const held = snap[section][id];
        if (held != null) snap[section][id] = mergeText(held, from, to);
      }
      // A step that brings the card into being, or back, writes it whole.
      for (const step of steps) {
        const changed = step.delta[section]?.changed;
        const pair = changed?.[id];
        if (!changed || !pair || (pair[0] != null && pair[1] != null)) continue;
        changed[id] = [
          pair[0] == null ? null : mergeText(pair[0], from, to),
          pair[1] == null ? null : mergeText(pair[1], from, to),
        ];
      }
    }
  }
  for (const [field, [from, to]] of Object.entries(drift.rest || {})) {
    for (const snap of stored) {
      const held = snap.rest[field];
      snap.rest[field] = held == null ? to : mergeText(held, from, to);
    }
  }
  forgetBytes();
}

/** For history.ts, before an undo or redo runs: write the drift down while
 *  the board still stands where the ledger says it does. */
export function settleDrift() {
  if (!replaying) absorbDrift();
}

/** For history.ts, after an undo or redo ran: the closure moved the board
 *  along the ledger, so the board now is what the ledger describes. */
export function ledgerMoved() {
  if (!replaying) synced = snapshot();
}

// ---------------------------------------------------------------------------
// Ops: the steps that carry a rule
// ---------------------------------------------------------------------------

/** How to re-run a rule. Injected (not imported) — this module is below the commands.
 *  A runner writes to the board but does NOT commit (the rebuild already measures). */
type OpRunner = (params: Record<string, unknown>) => void;
const OPS = new Map<string, OpRunner>();

export function registerOp(name: string, run: OpRunner) {
  OPS.set(name, run);
}

/** Whether a step can be edited, which is to say whether its rule is runnable. */
export const stepEditable = (step: Step) => !!step.op && OPS.has(step.op.name);

/** Op for the next commit. Narrow window: cleared on every recordStep(), committed or not. */
let pendingOp: { name: string, params: Record<string, unknown> } | null = null;

export function declareOp(name: string, params: Record<string, unknown>) {
  pendingOp = { name, params };
}

/** True during rebuild — suppresses recording steps about replaying steps. */
let replaying = false;

/** For history.ts — suppresses undo entries during rebuild. */
export const isReplaying = () => replaying;

/** Drop undo/redo stacks. Injected by history.ts (layering: this module cannot import it). */
let dropStacks: (() => void) | null = null;
export function setStackDropper(fn: (() => void) | null) { dropStacks = fn; }

/** How many steps a file may carry, before trimming is offered. */
const TIMELINE_STEP_CAP = 20000;

export const timelineSteps = () => steps;
export const timelineAt = () => at;
export const timelineStale = () => stale;

/** Start over with the board as it stands. Called wherever undo stacks are cleared. */
export function resetTimeline() {
  steps = [];
  at = 0;
  base = snapshot();
  synced = base;
  checkpoints = new Map();
  stale = false;
  forgetBytes();
}

/** Record a step from `before` to now. Same cards + same fields = merged into one step. */
export function recordStep(label: string, before: Snap): Step | null {
  // Cleared regardless — a declaration must not outlive its mutation.
  const op = pendingOp;
  pendingOp = null;
  // During rebuild — a step about replaying a step would be spurious.
  if (replaying) return null;
  // First the drift since the last step, or this step's `before` carries it
  // and the past does not.
  absorbDrift(before);
  const after = snapshot();
  // Whatever happens below, the ledger ends up describing this board.
  synced = after;
  const delta = diff(before, after);
  if (!delta) return null;
  // New action with marker rolled back — drop everything ahead (like undo).
  if (at < steps.length) {
    steps.length = at;
    for (const key of [...checkpoints.keys()]) if (key > at) checkpoints.delete(key);
  }
  // Collapse on rule + subject. See runKey() and opRunKey().
  const subject = runKey(delta);
  const run = subject && op ? opRunKey(op.name, subject) : subject;
  const prev = steps[steps.length - 1];
  if (run && prev && prev.run === run) {
    prev.delta = mergeDelta(prev.delta, delta);
    prev.at = Date.now();
    prev.label = label;
    // The *latest* rule over the merged difference: the difference now runs
    // from before the first press to after the last, and these are the
    // params that produced that last one, so rebuilding re-runs the
    // arrangement actually settled on. Both steps share a rule name here
    // (it's in the key), so nothing is dropped or invented.
    if (op) prev.op = op;
    // A run that folded back to nothing is not a step - stops "moved it and
    // moved it back" leaving a dot behind.
    if (!Object.keys(prev.delta).length) {
      steps.pop();
      checkpoints.delete(at);
      at = steps.length;
      return null;
    }
    // **A checkpoint on this mark now describes a board that never existed**:
    // this branch changed what the last step in the run does without
    // Refresh the checkpoint — a merged step changed the board without changing the count.
    if (checkpoints.has(at)) checkpoints.set(at, after);
    return prev;
  }
  const step: Step = { id: uid('s'), at: Date.now(), label, run, delta };
  if (op) step.op = op;
  steps.push(step);
  at = steps.length;
  if (at % CHECKPOINT_EVERY === 0) checkpoints.set(at, after);
  if (steps.length > TIMELINE_STEP_CAP) foldOldest(steps.length - TIMELINE_STEP_CAP);
  return step;
}

/** Run key for an op step: name in front so different rules over the same cards stay separate. */
const opRunKey = (name: string, subject: string) => `op:${name}|${subject}`;

/** Merge key: same ids + same fields = one run. Different fields = separate steps. */
function runKey(delta: Delta): string {
  const parts: string[] = [];
  const ids = new Set<string>();
  const fields = new Set<string>();
  const sections = ['items', 'desktop', 'mobile', 'trash'] as const;
  for (const section of sections) {
    const keyedPart = delta[section];
    if (!keyedPart) continue;
    // An arriving/departing card is never part of a run — would hide the add.
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

/** Note that undo/redo moved the board — they tell this module which way, not the reverse. */
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

/** Measured byte size of the history (not estimated — wrong estimates skip or mis-trigger trim). */
let bytesFor = -1;
let bytesWas = 0;

export function timelineBytes(): number {
  // Memoised by step count — called every `history` bus event (e.g. dragged slider).
  if (bytesFor === steps.length) return bytesWas;
  const doc = serializeTimeline();
  bytesWas = doc ? JSON.stringify(doc).length : 0;
  bytesFor = steps.length;
  return bytesWas;
}

/** Forget the memo above - any wholesale change to the ledger calls this. */
const forgetBytes = () => { bytesFor = -1; };

/** Past this, the app offers to trim. It never trims without being asked. */
export const TRIM_BYTES = 2_000_000;
/** And it offers to fold away steps older than this. */
export const TRIM_DAYS = 30;

/** Whether there is enough history, old enough, to be worth offering to fold. */
export function trimmable(now = Date.now()): number {
  return foldableCount(now - TRIM_DAYS * 86_400_000);
}

/** Oldest foldable steps. Stops at a named step (saved version) and never past the marker. */
function foldableCount(before: number): number {
  let count = 0;
  // `at > 0` guards: adoptTimeline coerces missing timestamps to 0, so a step with no date is unfoldable.
  while (count < at && steps[count].at > 0 && steps[count].at < before && !steps[count].name) count += 1;
  return count;
}

/** Fold oldest steps (> TRIM_DAYS) into base. Only called from a user-pressed control. */
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
  forgetBytes();
}

/** Apply steps to a snapshot without touching the board. Used by foldOldest. */
function restoreInto(snap: Snap, run: Step[]) {
  // Early return: applying a run round-trips the live board through JSON, breaking object identity.
  if (!run.length) return;
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
 * Put the board at a point in the history. Forward from the nearest
 * checkpoint at or behind the target, which bounds the work to at most
 * CHECKPOINT_EVERY steps regardless of history length.
 */
export function replayTo(target: number) {
  absorbDrift();
  const want = Math.max(0, Math.min(target, steps.length));
  let from = 0;
  let snap = base;
  for (const [mark, saved] of checkpoints) {
    if (mark <= want && mark > from) { from = mark; snap = saved; }
  }
  restore(snap);
  for (let i = from; i < want; i += 1) {
    // Marked and skipped, never fatal - one bad step must not cost every
    // step after it, nor leave the board silently stuck halfway.
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
  at = want;
  synced = snapshot();
}

/** Announce a wholesale board change. Selection pruned first — stale ids cause wrong toolbar state. */
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

/** Step back via replay (undo after refresh, when the session stack is empty). */
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

/** Jump to a step and announce. Returns false at the current position. */
export function goTo(target: number): boolean {
  const want = Math.max(0, Math.min(target, steps.length));
  if (want === at) return false;
  replayTo(want);
  // Undo stack described the previous board — drop it.
  dropStacks?.();
  announce();
  markDirty();
  bus.emit('history');
  return true;
}

/** Change a step's op params and rebuild everything after it. False if step has no rule. */
export function editStep(index: number, params: Record<string, unknown>): boolean {
  const step = steps[index];
  if (!step || !stepEditable(step)) return false;
  step.op = { name: step.op!.name, params: { ...step.op!.params, ...params } };
  rebuildFrom(index);
  return true;
}

/** Rebuild forward — re-runs op rules (unlike replayTo which trusts recorded deltas).
 *  Broken steps are skipped, not dropped. */
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
        // Re-record so scrubbing back uses the new answer.
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
    // Finally: leaving `replaying` latched silently stops all future recording.
    replaying = false;
  }
  at = steps.length;
  synced = snapshot();
  // All checkpoints behind the rebuild are stale — drop them.
  checkpoints = new Map();
  // Undo stack closures captured old positions — drop them too.
  dropStacks?.();
  announce();
  markDirty();
  bus.emit('history');
}

/** Name the current step (a landmark on the strip). False at position 0. */
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

/** What a step touched: derived from the delta (not stored — would go stale on rebuild). */
export function describeStep(step: Step): StepSubject {
  // Cards → bin → geometry profiles, roughly the order a person recognises.
  for (const section of [step.delta.items, step.delta.trash,
                         step.delta.desktop, step.delta.mobile]) {
    const pairs = Object.values(section?.changed || {});
    if (!pairs.length) continue;
    return { count: pairs.length, name: nameOfPair(pairs[0]) };
  }
  return { count: 0, name: '' };
}

/** Extract a name from a stored pair. Tolerant — unparseable values yield '', not an error. */
function nameOfPair([before, after]: [string | null, string | null]): string {
  for (const raw of [after, before]) {
    if (!raw) continue;
    let value: unknown;
    try { value = JSON.parse(raw); } catch { continue; }
    // Bin entry is { at, item }; card is itself. One unwrap covers both.
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

/** FNV-1a hash — synchronous, unlike crypto.subtle. */
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

/** Hash of the live board for tests. Not the file fingerprint — see docFingerprint(). */
export function fingerprint(snap: Snap = snapshot()): string {
  const parts: string[] = [];
  for (const id of snap.itemOrder) parts.push(snap.items[id]);
  for (const id of snap.trashOrder) parts.push(snap.trash[id]);
  for (const id of Object.keys(snap.desktop)) parts.push(snap.desktop[id]);
  for (const id of Object.keys(snap.mobile)) parts.push(snap.mobile[id]);
  for (const field of REST_FIELDS) parts.push(snap.rest[field] || '');
  return hashText(...parts);
}

/** Hash of the *stored* document (items + trash), not the live board.
 *  A save/load round-trip changes the live object, so hashing it would always disagree. */
export function docFingerprint(doc: unknown): string {
  if (!isRecord(doc)) return '';
  return hashText(JSON.stringify(doc.items ?? []), JSON.stringify(doc.trash ?? []));
}

// ---------------------------------------------------------------------------
// The file
// ---------------------------------------------------------------------------

/** Serialize for storage. Fingerprint handed in — this module never sees the document. */
export function serializeTimeline(fingerprintOf = '') {
  if (!steps.length) return null;
  // The stored `base` must carry the drift too, or a reopened board loses it.
  absorbDrift();
  return {
    base,
    at,
    fingerprint: fingerprintOf,
    steps: steps.map(step => {
      // Absent key ≠ undefined — tests compare structurally.
      const out: SerializedStep = {
        id: step.id, at: step.at, label: step.label, run: step.run, delta: step.delta,
      };
      if (step.name) out.name = step.name;
      return out;
    }),
  };
}

/** A map of id to serialised text, as a file claims one, or null. */
function readKeyed(raw: unknown): Keyed | null {
  if (!isRecord(raw)) return null;
  const out: Keyed = {};
  for (const [id, text] of Object.entries(raw)) {
    // restore() feeds every value to JSON.parse — a non-string would throw mid-replay.
    if (typeof text !== 'string') return null;
    out[id] = text;
  }
  return out;
}

/** A list of ids, ditto. SAFETY: `every` below checks each element is a string. */
const readOrder = (raw: unknown): string[] | null =>
  Array.isArray(raw) && raw.every(id => typeof id === 'string') ? raw as string[] : null;

/** Parse a stored `base` into a Snap. All-or-nothing — a half-populated base replays wrong. */
function readSnap(raw: unknown): Snap | null {
  if (!isRecord(raw)) return null;
  const items = readKeyed(raw.items);
  const desktop = readKeyed(raw.desktop);
  const mobile = readKeyed(raw.mobile);
  const trash = readKeyed(raw.trash);
  const rest = readKeyed(raw.rest);
  const itemOrder = readOrder(raw.itemOrder);
  const trashOrder = readOrder(raw.trashOrder);
  if (!items || !desktop || !mobile || !trash || !rest || !itemOrder || !trashOrder) return null;
  return { items, itemOrder, desktop, mobile, trash, trashOrder, rest };
}

/** Load a stored timeline. Marks it stale if the steps disagree with the board. */
export function adoptTimeline(raw: unknown, doc?: unknown) {
  resetTimeline();
  if (!isRecord(raw) || !Array.isArray(raw.steps)) return;
  const readBase = readSnap(raw.base);
  if (!readBase) return;
  const parsed: Step[] = [];
  for (const entry of raw.steps) {
    if (!isRecord(entry) || !isRecord(entry.delta)) continue;
    // SAFETY: entry.delta checked by isRecord() above; readers narrow per section.
    const step: Step = {
      id: typeof entry.id === 'string' && entry.id ? entry.id.slice(0, 64) : uid('s'),
      at: Number.isFinite(entry.at) ? Number(entry.at) : 0,
      label: typeof entry.label === 'string' ? entry.label.slice(0, 120) : 'Change',
      run: typeof entry.run === 'string' ? entry.run.slice(0, 400) : '',
      delta: entry.delta as Delta,
    };
    // Absent, not undefined — same distinction as serializeTimeline().
    if (typeof entry.name === 'string' && entry.name) step.name = entry.name.slice(0, 120);
    parsed.push(step);
    if (parsed.length >= TIMELINE_STEP_CAP) break;
  }
  if (!parsed.length) return;
  // Cap keeps oldest (base depends on them). Dropping newest makes `stale` true.
  const truncated = Array.isArray(raw.steps) && raw.steps.length > parsed.length;
  base = readBase;
  steps = parsed;
  forgetBytes();
  at = Number.isFinite(raw.at)
    ? Math.max(0, Math.min(Number(raw.at), steps.length))
    : steps.length;
  // Against the document, not the live board. No fingerprint = pre-check file, trusted.
  const claimed = typeof raw.fingerprint === 'string' ? raw.fingerprint : '';
  stale = truncated || (!!claimed && doc !== undefined && claimed !== docFingerprint(doc));
  synced = snapshot();
}

/** Rewrite recorded items in place (base + both sides of every step). Only caller: bin-empty.
 *  Without this, scrubbing back would resurrect bytes that were deleted. Checkpoints are dropped. */
export function rewriteRecorded(
  rewrite: (item: Record<string, unknown>) => Record<string, unknown> | null,
): number {
  absorbDrift();
  let count = 0;
  const redo = (text: string | null): string | null => {
    if (text == null) return text;
    let parsed: unknown;
    // Tolerant — unparseable values left as-is rather than throwing.
    try { parsed = JSON.parse(text); } catch { return text; }
    if (!isRecord(parsed)) return text;
    // Bin entry = { at, item }; card = itself. One unwrap covers both.
    const inner = isRecord(parsed.item) ? parsed.item : null;
    const next = rewrite(inner ?? parsed);
    if (!next) return text;
    count += 1;
    return JSON.stringify(inner ? { ...parsed, item: next } : next);
  };
  const sections = ['items', 'trash'] as const;
  for (const section of sections) {
    const keyedBase = base[section];
    for (const id of Object.keys(keyedBase)) {
      const next = redo(keyedBase[id]);
      if (next != null) keyedBase[id] = next;
    }
  }
  for (const step of steps) {
    for (const section of sections) {
      const part = step.delta[section];
      if (!part) continue;
      for (const id of Object.keys(part.changed)) {
        const [before, after] = part.changed[id];
        part.changed[id] = [redo(before), redo(after)];
      }
    }
  }
  if (count) {
    checkpoints = new Map();
    forgetBytes();
  }
  synced = snapshot();
  return count;
}

/** All asset hashes the steps reference (both sides — stepping back restores the before). */
export function timelineHashes(raw: unknown = serializeTimeline()): Set<string> {
  const out = new Set<string>();
  if (!isRecord(raw)) return out;
  const eat = (text: unknown) => {
    if (typeof text !== 'string') return;
    let parsed: unknown;
    try { parsed = JSON.parse(text); } catch { return; }
    // Bin entry = wrapper; item = itself. Both reach itemHashes().
    const item = isRecord(parsed) && isRecord(parsed.item) ? parsed.item : parsed;
    if (!isRecord(item)) return;
    for (const hash of itemHashes(item)) out.add(hash);
    // Optimiser's memo — stepping back through an optimise restores original bytes.
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
