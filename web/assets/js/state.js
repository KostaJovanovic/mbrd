// Central board state + selection + command-based undo/redo.
//
// Everything that mutates the board goes through here and emits an event, so
// the renderer, HUD and sidebar stay in sync without knowing about each other.
//
// Events:
//   items      - the item list itself changed (add/remove/reorder)
//   geom       - existing items moved/resized (payload: array of ids)
//   item       - one item's content/name changed (payload: id)
//   selection  - the selection set changed
//   settings   - a setting changed (payload: key)
//   board      - a whole new board was loaded, or the title/dirty flag changed
//   trash      - something was thrown away, restored, or purged

import { emitter, uid, isFamily, isHash, itemHashes, toast } from './util.js';
// The asset registry remembers the filename each item arrived under, which is
// what a cleared name falls back to - see renameItem(). One-way: assets.js
// depends on nothing but util.js, so this cannot close a cycle.
import { getAsset } from './storage/assets.js';
// Pure geometry, shared with the canvas and the input layer so that "where is
// this item and what does it cover" has exactly one answer in this app. Kept
// at the top level rather than under canvas/ because it depends on nothing and
// belongs to no one layer - see geometry.js.
import { itemBounds, overlapFraction, latticeBox, MIN_SIZE, MAX_SIZE } from './geometry.js';
// The board's link to real-world sizes. Pure arithmetic with no state of its
// own, at the same level as geometry.js and imported here for the same reason:
// the default belongs with the rest of the defaults, and the clamp has to run
// on every board that arrives from a file.
import { DEFAULT_SCALE, clampScale, PAPERS } from './measure.js';

export const bus = emitter();

export const DEFAULT_SETTINGS = {
  grid: true,
  axes: true,
  snap: false,
  // Off to begin with. It is a working instrument - where the pointer is, how
  // big the selected thing is - and a board you have just opened is a thing you
  // are looking at rather than working on. The scale bar covers the question a
  // first glance actually has, and this is one checkbox away in View.
  hud: false,
  gridStyle: 'dots',   // the only style; kept so old .mbrd files still load
  gridStep: 64,        // world px between minor grid lines, before zoom quantisation
  // Gap used by the arrangement engine. 12 rather than the 32 it was: a
  // moodboard is a board of things read against each other, and a third of a
  // card's width of empty paper between every pair is the layout arguing that
  // they are separate. Close enough to compare, far enough that the edges still
  // read as edges - and the slider is right there for anyone who disagrees.
  spacing: 12,
  // What the board's coordinates mean in the world: world units per millimetre,
  // and which family of unit names to say it in. Geometry never reads either -
  // they are a lens over numbers that were always unitless. See measure.js.
  scale: DEFAULT_SCALE,
  units: 'metric',     // or 'imperial'
  // A sheet of standard paper outlined around the origin, sized through the
  // scale above - see canvas/paper.js. An id out of PAPERS, or '' for none.
  // Two flat keys rather than one { size, landscape } object, because
  // setSetting() compares with === and no two objects are ever equal: an object
  // here would emit on every write and never on the one that mattered.
  paper: '',
  paperLandscape: false,
  // Whether the sheet carries the four grips that resize it. Off, because
  // resizing it is not resizing it: the sheet is always exactly A4, and what
  // the drag moves is the board's scale - every measurement on the board at
  // once. That is a deliberate act, not something to leave armed on the corners
  // of a rectangle somebody put up to check a layout against.
  paperResize: false,
  appearance: { palette: '', vars: {} },
  fonts: [],           // faces dropped onto this board - see ui/fonts.js
};

export const board = {
  title: 'Untitled board',
  view: { pan: { x: 0, y: 0 }, zoom: 1 },
  // Both containers rebuilt rather than spread through: DEFAULT_SETTINGS holds
  // them by reference, and a board mutating one in place would be editing the
  // defaults every later board is built from.
  settings: { ...DEFAULT_SETTINGS, appearance: { palette: '', vars: {} }, fonts: [] },
  arrangement: 'spiral',
  items: [],
  // Thrown away but not gone. Entries are { item, at }, newest first.
  trash: [],
};

export const selection = new Set();

let dirty = false;
export const isDirty = () => dirty;
export function markDirty(v = true) {
  if (dirty === v) return;
  dirty = v;
  bus.emit('board');
}

export function byId(id) { return board.items.find(i => i.id === id); }

export function topZ() {
  return board.items.reduce((m, i) => Math.max(m, i.z || 0), 0);
}

/**
 * Normalise a partial item into the full persisted shape.
 *
 * Total, deliberately: it is handed objects straight out of somebody else's
 * board.json, and it must not be able to throw part-way through rebuilding a
 * board - see loadBoard. Every field is coerced rather than trusted, and a
 * value that cannot be coerced falls back to the default for its slot.
 */
export function makeItem(partial) {
  let meta = partial.meta && typeof partial.meta === 'object' ? partial.meta : {};
  // The one funnel every item passes through on its way onto the board, which
  // makes it the place to hold a note to its ceiling. The editor enforces the
  // same limit while you type; this catches the other doors - an older .mbrd,
  // and a notes/*.md someone edited by hand outside the app.
  if ((partial.type || 'generic') === 'note' && typeof meta.text === 'string' && meta.text.length > NOTE_MAX) {
    meta = { ...meta, text: meta.text.slice(0, NOTE_MAX) };
  }
  return {
    id: typeof partial.id === 'string' && partial.id ? partial.id.slice(0, 64) : uid(),
    type: typeof partial.type === 'string' && partial.type ? partial.type : 'generic',
    x: +partial.x || 0,
    y: +partial.y || 0,
    w: +partial.w || 240,
    h: +partial.h || 180,
    rot: +partial.rot || 0,
    z: partial.z != null && Number.isFinite(+partial.z) ? +partial.z : topZ() + 1,
    name: typeof partial.name === 'string' ? partial.name.slice(0, 260) : '',
    asset: normalizeAsset(partial.asset),
    meta: normalizeMeta(meta),
  };
}

/**
 * `meta` is the open field - anything a renderer wants to remember about an
 * item lives in it and nothing here reads most of it. The content ids are the
 * exception, because they are *second* names for bytes: they get spelled into
 * an archive path by storage/mbrd.js and they decide what the autosave sweep is
 * allowed to delete. So each goes through the same gate item.asset.hash does,
 * and one that is not a digest is dropped rather than carried.
 *
 * The list is the same one itemHashes() in util.js reports, less the item's own
 * asset. Anything added there wants adding here too.
 */
const META_HASHES = ['cover', 'shot', 'thumb'];

function normalizeMeta(meta) {
  let out = meta;
  for (const key of META_HASHES) {
    if (!(key in out) || isHash(out[key])) continue;
    const { [key]: _drop, ...rest } = out;
    out = rest;
  }
  return out;
}

/**
 * An item's link to its bytes, or null.
 *
 * The hash is checked for shape here rather than only where it is used, because
 * of what it becomes downstream: storage/mbrd.js spells it into an archive path
 * and the asset store treats it as an identity. An id that is not a digest can
 * never resolve to bytes anyway - dropping it leaves a card that shows as a
 * plain one, which is honest, where keeping it leaves a board that also cannot
 * be exported. `external` is the reserved link-instead-of-embed form and has no
 * hash to check; it is carried through untouched.
 */
function normalizeAsset(asset) {
  if (!asset || typeof asset !== 'object') return null;
  if (isHash(asset.hash)) return asset;
  return asset.external ? { external: asset.external } : null;
}

// ---------------------------------------------------------------------------
// History
// ---------------------------------------------------------------------------

const undoStack = [];
const redoStack = [];
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

function clearHistory() {
  undoStack.length = 0;
  redoStack.length = 0;
  historyChanged();
}

// ---------------------------------------------------------------------------
// Item mutations (all undoable)
// ---------------------------------------------------------------------------

export function addItems(items, label = 'Add') {
  // The stack is dealt here rather than left to makeItem().
  //
  // makeItem() defaults `z` to topZ() + 1, which reads the *live* board - and
  // the batch is not on it yet. So a group added in one call every one of them
  // read the same number and landed on a single layer. One flat layer is a
  // stacking order nobody chose, and two things went wrong on top of it:
  // duplicating a pile came back flat, defeating the sort in itemsIn() that
  // exists for exactly that reason, and stuckTo() - which needs a *strictly*
  // lower z - stopped recognising the pair. Copy a photo with a note on it and
  // the copied note was not stuck to the copied photo; it silently attached
  // itself to whatever else happened to be underneath.
  //
  // An explicit z is still honoured, because loadBoard() and the bin restore
  // items that already have one and must come back exactly where they were.
  let z = topZ();
  const added = items.map(partial =>
    onLattice(makeItem(partial.z != null ? partial : { ...partial, z: ++z })));
  commit(label,
    () => { board.items.push(...added.filter(a => !byId(a.id))); bus.emit('items'); },
    () => { const ids = new Set(added.map(a => a.id));
            board.items = board.items.filter(i => !ids.has(i.id));
            ids.forEach(id => selection.delete(id));
            bus.emit('items'); bus.emit('selection'); });
  return added;
}

/**
 * Whatever the lattice is measured in, with the fallback in one place.
 *
 * The *base* step, never the on-screen one. gridStep() in canvas/grid.js picks
 * a spacing from the zoom so the dots never become a fill, which is right for
 * something drawn and wrong for something stored - see snapAll() below.
 *
 * Exported because main.js's Rearrange lays the whole board out at once and has
 * to size the slots on the same lattice snapAll() would - and a second copy of
 * `gridStep > 0 ? gridStep : 64` in another file is how the two would come to
 * disagree about a board whose step is missing.
 */
export function baseStep() {
  return board.settings.gridStep > 0 ? board.settings.gridStep : 64;
}

/**
 * A new item laid on the lattice, if the board is snapped.
 *
 * Without this, snapping only governed items that were already on the board
 * when it was switched on, plus anything dragged afterwards - so a snapped
 * board grew a photograph at 320x240 sitting a few pixels off every line it was
 * meant to sit on, and the only way to line it up was to switch snapping off
 * and on again. Arriving is a placement like any other.
 *
 * Sizes as well as positions, because a box on the lattice that is not a whole
 * number of cells is only snapped along two of its four edges, and it is the
 * ragged right and bottom that a person actually sees.
 *
 * The presnap memo is what makes this reversible: unsnapAll() puts every item
 * carrying one back to the geometry it had before the lattice, and an imported
 * item that never had a life before the lattice would otherwise be stranded at
 * its snapped size when snapping is turned off. An existing memo is left alone
 * - a duplicated or pasted item brings its own, and it is a memo of life before
 * the *first* snap, not of the copy's.
 */
function onLattice(it) {
  if (!board.settings.snap) return it;
  const box = latticeBox(it, baseStep());
  if (box.x === it.x && box.y === it.y && box.w === it.w && box.h === it.h) return it;
  return {
    ...it,
    x: box.x, y: box.y, w: box.w, h: box.h,
    meta: it.meta?.presnap
      ? it.meta
      : { ...it.meta, presnap: { x: it.x, y: it.y, w: it.w, h: it.h } },
  };
}

/**
 * How many things the bin holds before the oldest start falling out the
 * bottom. A bin is a safety net, not an archive - and every entry pins its
 * asset's bytes into the saved file, so an unbounded one would quietly make a
 * board grow forever as you worked on it.
 */
const TRASH_LIMIT = 60;

export function removeItems(ids, label = 'Delete') {
  const set = new Set(ids);
  // Keep the original index so undo restores z-order position, not just the item.
  const removed = board.items
    .map((item, index) => ({ item, index }))
    .filter(r => set.has(r.item.id));
  if (!removed.length) return;
  // Built once, outside the closures, so redoing a delete puts the *same*
  // entries back in the bin rather than minting new ones with a later date.
  const binned = removed.map(r => ({ item: r.item, at: Date.now() }));
  // What this delete pushed out the bottom of the bin, so undo can put it back.
  //
  // Truncating used to be a one-liner on the grounds that the entries falling
  // out are older than the delete and so belong to no undo entry being replayed
  // - which is true and beside the point. They were still in the bin before
  // this command ran and gone after it, which makes them part of what it did.
  // On a full bin, deleting one item and immediately undoing it left the bin
  // one entry short for good, and the entry that vanished was the oldest thing
  // in there: the one furthest past the point of being able to get it back any
  // other way.
  let evicted = [];
  commit(label,
    () => { board.items = board.items.filter(i => !set.has(i.id));
            set.forEach(id => selection.delete(id));
            board.trash.unshift(...binned);
            evicted = board.trash.splice(TRASH_LIMIT);   // [] while under the limit
            bus.emit('items'); bus.emit('selection'); bus.emit('trash'); },
    () => { for (const r of removed) board.items.splice(r.index, 0, r.item);
            board.trash = board.trash.filter(t => !set.has(t.item.id));
            // Back on the end, which is where they were: the entries this
            // command added went on the front, and undo has just taken them off.
            board.trash.push(...evicted);
            evicted = [];
            bus.emit('items'); bus.emit('trash'); });
}

/**
 * Take things back out of the bin.
 *
 * `at` is where the item should land - the point it was dropped on when it was
 * dragged out of the bin panel. Without one it goes back exactly where it was
 * deleted from, which is what the bin's own Restore does.
 *
 * Restored items are stacked on top rather than returned to their old z: they
 * were absent while everything else moved on, and coming back underneath a
 * pile is the same as not coming back.
 */
export function restoreItems(ids, at = null, label = 'Restore') {
  const set = new Set(ids);
  const entries = board.trash.filter(t => set.has(t.item.id));
  if (!entries.length) return [];
  let z = topZ();
  const items = entries.map(e => ({
    ...e.item,
    ...(at ? { x: at.x, y: at.y } : null),
    z: ++z,
  }));
  const back = new Set(items.map(i => i.id));
  commit(label,
    () => { board.items.push(...items.filter(i => !byId(i.id)));
            board.trash = board.trash.filter(t => !set.has(t.item.id));
            bus.emit('items'); bus.emit('trash'); },
    () => { board.items = board.items.filter(i => !back.has(i.id));
            back.forEach(id => selection.delete(id));
            board.trash.unshift(...entries);
            bus.emit('items'); bus.emit('selection'); bus.emit('trash'); });
  return items;
}

/** Throw the bin out. Undoable - emptying it by accident is a bad afternoon. */
export function emptyTrash() {
  if (!board.trash.length) return;
  const held = board.trash;
  commit('Empty trash',
    () => { board.trash = []; bus.emit('trash'); },
    () => { board.trash = held; bus.emit('trash'); });
}

const GEOM_KEYS = ['x', 'y', 'w', 'h', 'rot', 'z'];

/** Geometry snapshot for a set of ids - the before/after pair of a drag. */
export function snapshotGeom(ids) {
  return [...ids].map(id => {
    const it = byId(id);
    if (!it) return null;
    const g = { id };
    for (const k of GEOM_KEYS) g[k] = it[k];
    return g;
  }).filter(Boolean);
}

/** Write a geometry snapshot back onto the items (live, not undoable). */
export function applyGeom(snap) {
  const ids = [];
  for (const g of snap) {
    const it = byId(g.id);
    if (!it) continue;
    for (const k of GEOM_KEYS) it[k] = g[k];
    ids.push(g.id);
  }
  bus.emit('geom', ids);
}

/**
 * Close a live drag/resize into one undo entry. `before` is the snapshot taken
 * when the gesture started; the current geometry becomes the redo state.
 */
export function commitGeom(label, before, driven) {
  const after = snapshotGeom(before.map(b => b.id));
  const changed = after.some((a, i) => GEOM_KEYS.some(k => a[k] !== before[i][k]));
  if (!changed) return;
  // What the gesture actually had hold of, as opposed to what came along for
  // the ride. Only these ask again where they are stuck; see restick(). Left
  // out entirely by callers that move things without anybody touching them -
  // Bring to front, the embed's fit - which change no note's position relative
  // to anything and so change no answer.
  if (driven) restick(driven);
  // Placed by hand while snapping was on: this *is* where the item belongs
  // now, so it gives up its memory of where it sat before the board was laid
  // on the lattice. Turning snapping off later leaves it exactly here.
  if (board.settings.snap) {
    for (let i = 0; i < after.length; i++) {
      if (GEOM_KEYS.some(k => after[i][k] !== before[i][k])) forgetPresnap(byId(after[i].id));
    }
  }
  commit(label, () => applyGeom(after), () => applyGeom(before));
}

// ---------------------------------------------------------------------------
// Snapping the whole board
// ---------------------------------------------------------------------------

/**
 * Turning snapping on lays every item on the lattice at once, rather than only
 * governing the next thing you drag - so the board *looks* snapped the moment
 * the setting is on, which is the only way a grid reads as a grid.
 *
 * Turning it off puts everything back. That needs the old geometry kept
 * somewhere, and it goes in `meta.presnap` on the item: per item, so an item
 * touched during a snapped session can drop its own memo without affecting the
 * rest, and serialised with the board, so the promise survives a save and a
 * reload rather than lasting only as long as the tab.
 *
 * Two consequences worth being explicit about:
 *
 * - **The step is the base step, not the one on screen.** `gridStep()` picks a
 *   spacing from the current zoom so the lattice never becomes a fill, which is
 *   right for something drawn and wrong for something stored: snapping at 20%
 *   zoom would otherwise commit a board to a coarser geometry than snapping at
 *   100%, and the same click would do two different things depending on how far
 *   out you happened to be.
 * - **Edges land on lines, not centres**, and the arithmetic is latticeBox() in
 *   geometry.js, shared with the gestures in canvas/input.js so that laying the
 *   board out and then dragging one item across it agree about where things go.
 *   What makes a snapped board look snapped is items sitting flush in cells; an
 *   item whose size is an odd number of cells therefore ends up with its centre
 *   on a half-step, which is correct and is not a rounding error.
 */
function snapAll() {
  const step = baseStep();
  const before = [], after = [];
  for (const it of board.items) {
    const pre = it.meta?.presnap || null;
    before.push({ id: it.id, x: it.x, y: it.y, w: it.w, h: it.h, pre });

    const box = latticeBox(it, step);
    after.push({
      id: it.id,
      x: box.x,
      y: box.y,
      w: box.w,
      h: box.h,
      // A board snapped, unsnapped and snapped again remembers the first
      // position, not the second - the memo is of life before the lattice.
      pre: pre || { x: it.x, y: it.y, w: it.w, h: it.h },
    });
  }
  applySnapState(before, after, 'Snap to grid');
}

/** Put back what snapAll() remembered, for everything still carrying a memo. */
function unsnapAll() {
  const before = [], after = [];
  for (const it of board.items) {
    // Checked rather than trusted: a memo arrives from a .mbrd like everything
    // else, and a hand-edited one holding a string would write it straight onto
    // the item's geometry. A memo that does not describe a box is no memo.
    const pre = usableMemo(it.meta?.presnap);
    if (!pre) { forgetPresnap(it); continue; }
    before.push({ id: it.id, x: it.x, y: it.y, w: it.w, h: it.h, pre });
    after.push({ id: it.id, x: pre.x, y: pre.y, w: pre.w, h: pre.h, pre: null });
  }
  applySnapState(before, after, 'Leave the grid');
}

const SNAP_KEYS = ['x', 'y', 'w', 'h'];

function applySnapState(before, after, label) {
  const moved = after.some((a, i) =>
    SNAP_KEYS.some(k => a[k] !== before[i][k]) || !!a.pre !== !!before[i].pre);
  if (!moved) return;
  writeSnapState(after);
  commit(label, () => writeSnapState(after), () => writeSnapState(before));
}

function writeSnapState(list) {
  const ids = [];
  for (const g of list) {
    const it = byId(g.id);
    if (!it) continue;
    for (const k of SNAP_KEYS) it[k] = g[k];
    if (g.pre) it.meta = { ...it.meta, presnap: g.pre };
    else forgetPresnap(it);
    ids.push(g.id);
  }
  if (ids.length) bus.emit('geom', ids);
}

function forgetPresnap(it) {
  if (!it?.meta || !('presnap' in it.meta)) return;
  const { presnap, ...rest } = it.meta;
  it.meta = rest;
}

/** A memo is four finite numbers with a size that is actually a size. */
function usableMemo(pre) {
  if (!pre || typeof pre !== 'object') return null;
  const ok = SNAP_KEYS.every(k => Number.isFinite(pre[k]));
  if (!ok || pre.w < MIN_SIZE || pre.h < MIN_SIZE || pre.w > MAX_SIZE || pre.h > MAX_SIZE) return null;
  return { x: pre.x, y: pre.y, w: pre.w, h: pre.h };
}

function bottomZ() {
  return board.items.reduce((m, i) => Math.min(m, i.z || 0), 0);
}

export function raiseSelection() {
  const before = snapshotGeom(selection);
  if (!before.length) return;
  let z = topZ();
  // Walk in current stacking order so a multi-selection keeps its internal
  // arrangement instead of being reshuffled by Set iteration order.
  for (const id of stackOrder(selection)) byId(id).z = ++z;
  bus.emit('geom', [...selection]);
  commitGeom('Bring to front', before);
}

export function lowerSelection() {
  const before = snapshotGeom(selection);
  if (!before.length) return;
  let z = bottomZ();
  for (const id of stackOrder(selection).reverse()) byId(id).z = --z;
  bus.emit('geom', [...selection]);
  commitGeom('Send to back', before);
}

/** The given ids, sorted bottom-to-top by their current z. */
export function stackOrder(ids) {
  return [...ids].sort((a, b) => (byId(a)?.z || 0) - (byId(b)?.z || 0));
}

/**
 * The live items behind a set of ids, bottom-to-top.
 *
 * Sorted, because a copy of several things has to be laid down in the order
 * they were stacked in: addItems() gives each new item the next z as it goes,
 * so handing it the group in board order rather than stacking order would
 * reshuffle a carefully arranged pile every time it was duplicated.
 */
function itemsIn(ids) {
  const set = ids instanceof Set ? ids : new Set(ids);
  return board.items.filter(i => set.has(i.id)).sort((a, b) => (a.z || 0) - (b.z || 0));
}

/**
 * The copy that Duplicate and Paste both make: everything about an item except
 * its identity and its place in the stack.
 *
 * `id` and `z` are left off so makeItem() mints a fresh id and puts the copy on
 * top. The asset is copied by *reference*, never by bytes: assets are keyed by
 * content hash and the packer writes each hash once, so duplicating a 40 MB
 * video costs nothing on disk. meta is shallow-copied because every field in it
 * is a scalar - text, tint, mime, size and the rest.
 */
function cloneItem(i, dx = 0, dy = 0) {
  return {
    type: i.type,
    x: i.x + dx,
    y: i.y + dy,
    w: i.w, h: i.h, rot: i.rot,
    name: i.name,
    asset: i.asset ? { ...i.asset } : null,
    meta: { ...i.meta },
  };
}

/** Copy items, offset a little so the copy is visibly on top of the original. */
export function duplicateItems(ids, offset = { x: 28, y: -28 }) {
  const src = itemsIn(ids);
  if (!src.length) return [];
  const copies = src.map(i => cloneItem(i, offset.x, offset.y));
  return addItems(copies, copies.length > 1 ? `Duplicate ${copies.length} items` : 'Duplicate');
}

// ---------------------------------------------------------------------------
// The internal clipboard
//
// Items are held here rather than pushed onto the system clipboard, because an
// item is not text. It can reference an embedded asset of any size, which has
// no honest text/plain form and which round-tripping through the system
// clipboard would make us re-encode and re-hash on every paste - where a copy
// held in memory shares the original's asset hash for free, exactly as
// Duplicate does. What does go out to the system clipboard is a readable
// summary, so that copying a sticky note and pasting it into a text editor
// gives you its words.
// ---------------------------------------------------------------------------

const clipboard = { items: [], text: '', pastes: 0 };

export const clipboardSize = () => clipboard.items.length;

/** The box the clipboard's contents were copied from, or null when it is empty. */
export const clipboardBounds = () => itemBounds(clipboard.items);

/**
 * Whether the text the system clipboard is offering is the text *we* put there.
 *
 * This is the one question that decides a paste, and the browser gives no way
 * to ask it directly: two clipboards exist - ours and the machine's - and
 * nothing reports which of them was filled more recently. So a copy leaves a
 * receipt. The exact string handed to the system clipboard is remembered here,
 * and a paste that arrives carrying it is a paste of our own copy: nothing has
 * been copied anywhere else since. A paste carrying anything else means the
 * user has been somewhere else and copied something there, and that newer thing
 * is what they mean by Ctrl+V.
 *
 * The receipt is the summary text itself rather than a hidden token, so that
 * what lands in a text editor is clean. The cost is a collision no wider than
 * copying a note, going away, copying that same text back verbatim from
 * somewhere else, and returning - which yields a copy of the note instead of a
 * new note of the same words, and is not a bad answer to a question nobody can
 * answer correctly.
 */
export function clipboardHasOurs(systemText) {
  return !!clipboard.items.length && !!clipboard.text && systemText === clipboard.text;
}

/**
 * Take a copy of some items. Not a board mutation, so nothing to undo.
 *
 * Returns the text the caller should hand to the system clipboard, or '' when
 * there was nothing to copy. That half is the caller's, because only a real
 * `copy`/`cut` event may write to the system clipboard synchronously.
 */
export function copyItems(ids) {
  const text = take(ids);
  if (text) toast(`Copied ${count(clipboard.items.length)}`);
  return text;
}

/**
 * The copy itself, without the receipt.
 *
 * Cut takes exactly this copy but has something else to say about it, and two
 * toasts in the same turn are not two messages - the second replaces the first
 * inside a frame, so all the user sees is the last one and all the first one
 * did was reset the fade.
 */
function take(ids) {
  const src = itemsIn(ids);
  if (!src.length) return '';
  clipboard.items = src.map(i => cloneItem(i));
  clipboard.pastes = 0;
  clipboard.text = summarise(src);
  return clipboard.text;
}

/** "1 item" / "3 items", for the three clipboard receipts. */
const count = n => `${n} item${n === 1 ? '' : 's'}`;

/**
 * Copy, then delete: one undo entry, because removeItems() is the only half
 * that touched the board. Cut items go to the bin like any other delete, so a
 * cut you never paste is still recoverable.
 *
 * The one of the three that genuinely needed saying out loud: copy and paste
 * both leave something on screen to look at, where cut makes things disappear
 * and looks identical to having pressed delete by mistake. Naming the bin is
 * the useful half of the message - it is the difference between "gone" and
 * "over there".
 */
export function cutItems(ids) {
  const doomed = itemsIn(ids).map(i => i.id);
  const text = take(doomed);
  if (!text) return '';
  removeItems(doomed, doomed.length > 1 ? `Cut ${doomed.length} items` : 'Cut');
  toast(`Cut ${count(doomed.length)} to the bin`);
  return text;
}

/**
 * What a copied selection says on the system clipboard. A note gives up its
 * text, a link its address, and everything else its name - in each case the
 * only part of that item which means anything outside this app. A link's name
 * would be the wrong half here: it is a label, editable and often nothing like
 * the URL, and a link copied out of the board is copied in order to be pasted
 * somewhere that wants the address. The bracketed count is the fallback for a
 * selection with nothing to say - an unnamed photo - because the receipt above
 * only works while the string is never empty.
 */
function summarise(src) {
  const lines = src.map(i => (i.type === 'note' ? i.meta.text
                            : i.type === 'link' ? i.meta.url
                            : i.name) || '').filter(Boolean);
  if (lines.length) return lines.join('\n\n');
  return `[mbrd: ${src.length} item${src.length === 1 ? '' : 's'}]`;
}

/**
 * How far each paste steps off the one before it. The same offset Duplicate
 * uses - up and to the right, where a copy lands on a physical desk.
 */
const PASTE_STEP = { x: 28, y: -28 };

/**
 * Put the internal clipboard on the board.
 *
 * `at` is an optional world point to centre the pasted group on. The caller
 * passes one only when the place the copy was taken from is off screen;
 * otherwise it passes nothing and the copy lands beside its original. Pasting
 * in place is what makes copy/paste usable as "another one of these": the pair
 * appears side by side where you can compare them. It is only when the original
 * is somewhere you are not looking that the middle of the screen beats it,
 * because a paste that lands off screen is indistinguishable from one that did
 * nothing at all.
 *
 * Either way the step accumulates across pastes of the same clipboard, so the
 * second Ctrl+V clears the first instead of hiding underneath it.
 */
export function pasteItems(at = null) {
  if (!clipboard.items.length) return [];
  const n = clipboard.pastes++;
  let dx, dy;
  if (at) {
    // n rather than n + 1, so the first paste at a given point lands *on* it
    // and only the ones after it fan out.
    const b = itemBounds(clipboard.items);
    dx = at.x - (b.x0 + b.x1) / 2 + n * PASTE_STEP.x;
    dy = at.y - (b.y0 + b.y1) / 2 + n * PASTE_STEP.y;
  } else {
    dx = (n + 1) * PASTE_STEP.x;
    dy = (n + 1) * PASTE_STEP.y;
  }
  const copies = clipboard.items.map(i => cloneItem(i, dx, dy));
  const added = addItems(copies, copies.length > 1 ? `Paste ${copies.length} items` : 'Paste');
  // Worth saying even though the copies are visible: a paste that lands under
  // the pointer looks like a paste, but one that fanned out from an original
  // off the edge of the screen can put every copy somewhere you are not
  // looking, and then a working paste and a dead key are the same event.
  toast(`Pasted ${count(added.length)}`);
  return added;
}

// ---------------------------------------------------------------------------
// Sticky notes that stick
//
// A note is stuck to whatever it is lying on, and a stuck note travels with its
// host. Nothing about that is stored *in the board file*: stuckness is a fact
// about where two things are, and a file that also recorded it could disagree
// with its own geometry - a hazard with no upside, since the geometry is right
// there and the answer falls out of it.
//
// It is not recomputed on demand either, and that is the part worth naming. The
// relation is worked out from live geometry the first time anything asks, and
// then *remembered* until the note itself is handled. Which means moving a
// photo, resizing it, or dropping something else on top of it cannot quietly
// re-parent the notes lying on it - the pile you built stays the pile you
// built. Only picking up the note itself asks the question again.
//
// The memo is a runtime Map, not a field. A board that has just loaded has an
// empty one and answers every question by measuring, which is exactly what the
// old always-measure version did, so a .mbrd needs no new key and one written
// by an older version is not missing anything.
// ---------------------------------------------------------------------------

/**
 * How much of a note has to be over an item before it counts as stuck.
 *
 * A twentieth of the note. Low on purpose: a sticky pressed onto the corner of
 * a photograph is stuck to that photograph, and anybody who put it there thinks
 * so. The floor exists to rule out the note that merely *touches* while it is
 * being dragged past, which at zero would grab a host for one frame and let go
 * again.
 */
export const STICK_MIN = 0.05;

/**
 * noteId -> hostId or null. Null is a real answer, "measured, and it is stuck to
 * nothing", and it has to survive as one: falling through to a fresh
 * measurement every time would make a loose note the one case that *does* get
 * re-parented by things moving underneath it.
 */
const sticks = new Map();

/**
 * The item a sticky note is stuck to, or null.
 *
 * Measured by area: more than STICK_MIN of the note's own surface lying over
 * the item. Area rather than the note's centre or its top corners, because
 * those are questions about three particular points and this is a question
 * about a sheet of paper lying on something - a note overlapping a photo's
 * corner by a third of itself is obviously stuck to it, and no test of the
 * centre will ever say so.
 *
 * Only notes stick, and only to something below them in the stack. A note
 * hidden behind the thing it claims to be stuck to would be a relationship
 * nobody could see, and being seen is the whole of the point. It costs nothing
 * to arrange, either: startMove() lifts whatever you drag to the top, so a note
 * dropped onto a photo is already above it. Where several candidates qualify -
 * a note on a note on a photo - the nearest one underneath wins, so a pile
 * hangs together in the order it was laid down.
 */
export function stuckTo(note) {
  if (!note || note.type !== 'note') return null;
  if (sticks.has(note.id)) {
    const id = sticks.get(note.id);
    if (id === null) return null;
    const host = byId(id);
    // A remembered host that is no longer on the board - deleted, or undone
    // back out of existence. Measuring again is the lesser evil: the note did
    // not move, so the rule says leave it, but leaving it means a note that can
    // never stick to anything again until somebody happens to drag it.
    if (host) return host;
    sticks.delete(note.id);
  }
  const host = measureStick(note);
  sticks.set(note.id, host ? host.id : null);
  return host;
}

function measureStick(note) {
  let best = null;
  for (const it of board.items) {
    if (it.id === note.id || (it.z || 0) >= (note.z || 0)) continue;
    if (best && (it.z || 0) < (best.z || 0)) continue;
    if (overlapFraction(note, it) > STICK_MIN) best = it;
  }
  return best;
}

/**
 * Forget what these notes were stuck to, so the next question measures again.
 *
 * Called with the ids a gesture *drove* - what the pointer or the arrow keys
 * actually had hold of - and never with the followers those ids dragged along.
 * That distinction is the feature: a note carried across the board by the photo
 * underneath it has not been moved relative to anything and must not be
 * re-parented, while a note you picked up and put down has been, and must.
 */
export function restick(ids) {
  for (const id of ids) sticks.delete(id);
}

/** Nothing on the old board is a fact about the new one. */
export const forgetSticks = () => sticks.clear();

/**
 * The ids of the notes that have to come along when `ids` are moved.
 *
 * Transitive, so a note stuck to a note stuck to a photo travels with the
 * photo: a pile of stickies on a picture reads as one object, and having to
 * move it in two goes would be the surprise. The walk cannot loop - being stuck
 * requires a lower z, which makes the relation a strict order - but each note
 * leaves the pool as it joins, so termination is a property here rather than an
 * assumption about z.
 *
 * Anything already moving is left out, which is what keeps this from fighting a
 * multi-select drag: a note selected alongside its host is moved once, by the
 * selection, instead of once by the selection and again as a follower.
 */
export function stuckFollowers(ids) {
  const moving = new Set(ids);
  const pool = board.items.filter(i => i.type === 'note' && !moving.has(i.id));
  const out = [];
  // Passes rather than one sweep: a note can only join once whatever it is
  // stuck to has joined, and the pool is in no particular order.
  for (let grew = true; grew;) {
    grew = false;
    for (let n = pool.length - 1; n >= 0; n--) {
      const host = stuckTo(pool[n]);
      if (!host || !moving.has(host.id)) continue;
      moving.add(pool[n].id);
      out.push(pool[n].id);
      pool.splice(n, 1);
      grew = true;
    }
  }
  return out;
}

/**
 * How much a sticky note holds. A sticky is a thought you can take in at a
 * glance - past a couple of hundred characters it is a document, and it wants
 * to be a text file on the board instead. Enforced here as well as in the
 * editor, so a paste, an import or an older .mbrd cannot get around it.
 */
export const NOTE_MAX = 512;

export function setItemText(id, text) {
  const it = byId(id);
  if (it?.type === 'note') text = text.slice(0, NOTE_MAX);
  if (!it || it.meta.text === text) return;
  const prev = it.meta.text;
  commit('Edit note',
    () => { byId(id).meta.text = text; bus.emit('item', id); },
    () => { byId(id).meta.text = prev; bus.emit('item', id); });
}

/**
 * Turn one item into an item of another kind, as a single undoable step.
 *
 * The item is replaced rather than edited, and the replacement is minted with
 * a fresh id. That is not bookkeeping. canvas/items.js caches one node per id
 * and writes the type onto that node when it is *built*, and the stylesheet
 * keys off it - so an item that changed type under a node that stayed would go
 * on wearing the old type's clothes until something unrelated forced a
 * rebuild. Retiring the id retires the node with it, which is the only way to
 * get an honest one back without reaching into the renderer from here.
 *
 * Position, rotation and stacking carry over unless `next` overrules them:
 * this is the same thing seen differently, and it should not move or change
 * places in the pile. The selection follows the swap in both directions, so
 * whichever of the pair is on the board is the one that is selected, and an
 * undo hands the original back ready to be dragged rather than anonymous.
 *
 * The slot to write into is found by identity when the command runs, not by an
 * index captured while it is being built. Undo may be pressed three edits
 * later, by which time a position recorded now is pointing at somebody else.
 */
export function retypeItem(id, next, label = 'Change item') {
  const old = byId(id);
  if (!old) return null;
  const item = makeItem({ x: old.x, y: old.y, rot: old.rot, z: old.z, ...next });
  const swap = (out, into) => {
    const at = board.items.indexOf(out);
    if (at < 0) return;
    board.items.splice(at, 1, into);
    if (selection.delete(out.id)) selection.add(into.id);
    bus.emit('items');
    bus.emit('selection');
  };
  commit(label, () => swap(old, item), () => swap(item, old));
  return item;
}

/**
 * Call an item something else.
 *
 * An empty name never sticks. A picture wears its name on the caption plate
 * that build() only draws `if (item.name)`, so clearing it would take away the
 * very handle you renamed it by and leave the item anonymous with no way back -
 * a one-way door, on the one edit people make by accident most. Blank therefore
 * means "put it back", and what goes back is the name the file arrived under:
 * the asset registry has held it since the import and a .mbrd carries it, so it
 * is still there a month later. An item with no asset behind it keeps the name
 * it had, and only one that never had a name can come out of this without one -
 * which costs it nothing, because it had no plate to lose.
 */
/**
 * Rename an item, or clear the name to get the original filename back.
 *
 * The fallback order is the point. `meta.origName` is written at import and
 * travels in board.json, so it survives a save and reopen; the asset registry's
 * copy is the older path and only holds for assets registered this session,
 * because the archive carries bytes and hashes but no filenames. Consulting
 * only the registry meant that after a round trip, clearing the name of a
 * renamed item handed back the *renamed* value - the original had nowhere to
 * have been kept.
 */
export function renameItem(id, name) {
  const it = byId(id);
  if (!it) return;
  const next = String(name ?? '').trim() ||
               it.meta?.origName ||
               (it.asset && getAsset(it.asset.hash)?.name) || it.name;
  if (it.name === next) return;
  const prev = it.name;
  commit('Rename',
    () => { byId(id).name = next; bus.emit('item', id); },
    () => { byId(id).name = prev; bus.emit('item', id); });
}

/**
 * Give an item a picture of its own, or take it away with a null.
 *
 * A card that is not itself a picture - a sound file, a text file, a named
 * card for something the browser cannot draw - has nothing to look at on a
 * board, and a board is looked at from a distance where a name is not legible.
 * So any of them can carry one: an album cover, a diagram, a frame grabbed by
 * hand. The picture is an ordinary asset, hashed and deduped like every other,
 * which is what makes "the same cover on nine tracks" cost one file.
 *
 * Only the *reference* is undoable. The bytes stay in the registry either way,
 * because undo has to be able to put the picture back and the autosave sweep
 * is what eventually collects anything no item points at.
 */
export function setItemCover(id, hash) {
  const it = byId(id);
  if (!it) return;
  const next = isHash(hash) ? hash : null;
  const prev = isHash(it.meta?.cover) ? it.meta.cover : null;
  if (next === prev) return;
  const write = value => {
    const item = byId(id);
    if (!item) return;
    if (value) item.meta = { ...item.meta, cover: value };
    else { const { cover, ...rest } = item.meta || {}; item.meta = rest; }
    bus.emit('item', id);
  };
  commit(next ? 'Set picture' : 'Remove picture', () => write(next), () => write(prev));
}

/**
 * Attach the hundred-pixel copy the board draws when it is zoomed out.
 *
 * Not undoable, and unlike setItemCover() that is not an oversight. A cover is
 * a choice somebody made about what a card looks like; a thumbnail is a derived
 * copy of the picture the item already holds, and there is no state of the
 * board in which having one is a change worth being able to take back. Made at
 * import (import/drop.js) and repaired by the optimiser (optimize/optimize.js);
 * absent simply means the card draws full size at every zoom.
 *
 * Marks the board dirty, because the id has to be saved - the bytes are pinned
 * by itemHashes() and would otherwise be swept the next time the autosave
 * collected whatever nothing points at.
 */
export function setItemThumb(id, hash) {
  const it = byId(id);
  if (!it || !isHash(hash) || it.meta?.thumb === hash) return;
  it.meta = { ...it.meta, thumb: hash };
  bus.emit('item', id);
  markDirty();
}

/**
 * Point a run of items at smaller copies of their own files, reversibly.
 *
 * One commit for the whole board rather than one per card, because that is what
 * the gesture was: you asked to optimise a board, and one Ctrl+Z has to undo a
 * board. Two hundred separate entries would also be two hundred of the history
 * limit, which is to say the rest of the session's undo thrown away to record a
 * single button press.
 *
 * Each swap is `{ id, asset, cover }` - either field may be absent, and an
 * absent one is left exactly as it was. Items that were *considered* and left
 * alone belong in the list too, with neither field: they still get marked, and
 * marking them is the whole point of listing them.
 *
 * The id that was there goes into `meta.was` / `meta.wasCover`, and that is not
 * bookkeeping for undo's sake: undo closes over the old ids already. It is for
 * the *autosave sweep*, which deletes any bytes no item claims and would
 * otherwise collect the originals the moment the board saved itself - leaving an
 * undo entry that could only put back a hash with nothing behind it. See
 * referencedHashes() in storage/storage.js, and packBoard() in storage/mbrd.js,
 * which drops both fields on the way into a .mbrd so an export carries the small
 * files alone.
 *
 * `meta.opt` is the other half: the ids this item held when the optimiser last
 * looked at it. A second run compares against it and skips what it finds, which
 * is what keeps a re-encode from happening twice - once for the wasted minute,
 * and once because a lossy format encoded from its own output is a second
 * generation of loss for no gain. It is written *inside the commit*, so undoing
 * an optimisation takes the mark back with it and the restored originals are
 * offered again. Hashes rather than a flag, so replacing an item's picture by
 * hand also un-marks it, without anything having to remember to.
 */
export function swapAssets(swaps, label = 'Optimize board') {
  const list = (swaps || []).filter(s => s && byId(s.id));
  if (!list.length) return 0;

  const before = list.map(({ id }) => {
    const it = byId(id);
    return { id, asset: it.asset ? { ...it.asset } : null, meta: { ...it.meta } };
  });

  // A run that found nothing worth rewriting still learned something, and the
  // marks are how it remembers - but they are bookkeeping about work done, not
  // a change to the board, so they go on outside the undo stack. Committing
  // them would put an entry on the history that looks like nothing happened,
  // because nothing did, and spend one of the steps the user has left.
  const swapping = list.some(({ id, asset, cover }) => {
    const it = byId(id);
    return (isHash(asset) && it.asset?.hash && asset !== it.asset.hash) ||
           (isHash(cover) && isHash(it.meta?.cover) && cover !== it.meta.cover);
  });
  if (!swapping) {
    for (const { id } of list) {
      const it = byId(id);
      // No event: nothing about the item is drawn differently for having been
      // looked at, and a rebuild per card would be a flicker for nothing.
      if (it) it.meta = { ...it.meta, opt: [...itemHashes(it)] };
    }
    markDirty();
    return 0;
  }

  const forward = () => {
    for (const { id, asset, cover } of list) {
      const it = byId(id);
      if (!it) continue;
      const meta = { ...it.meta };
      if (isHash(asset) && it.asset?.hash && asset !== it.asset.hash) {
        // Only the first swap records an original. Optimising twice must not
        // leave `was` pointing at the *previous* optimisation, or undoing once
        // would restore a file that is itself already re-encoded.
        if (!isHash(meta.was)) meta.was = it.asset.hash;
        it.asset = { ...it.asset, hash: asset };
      }
      if (isHash(cover) && isHash(meta.cover) && cover !== meta.cover) {
        if (!isHash(meta.wasCover)) meta.wasCover = meta.cover;
        meta.cover = cover;
      }
      it.meta = meta;
      // Marked last, so what is recorded is what the item ended up holding.
      meta.opt = [...itemHashes(it)];
      bus.emit('item', id);
    }
  };

  const back = () => {
    for (const snap of before) {
      const it = byId(snap.id);
      if (!it) continue;
      it.asset = snap.asset ? { ...snap.asset } : null;
      it.meta = { ...snap.meta };
      bus.emit('item', snap.id);
    }
  };

  commit(label, forward, back);
  return list.length;
}

/**
 * Let go of the files the optimiser replaced.
 *
 * Undoable in the sense that matters - the *board* is unchanged either way, so
 * this is not on the history at all. What it changes is what the next autosave
 * sweep is allowed to collect: with `was` gone, nothing claims the originals and
 * the browser gets the space back. It is a one-way door and the caller says so
 * before opening it.
 */
export function discardOriginals() {
  let n = 0;
  for (const it of board.items) {
    if (!isHash(it.meta?.was) && !isHash(it.meta?.wasCover)) continue;
    const { was, wasCover, ...rest } = it.meta;
    it.meta = rest;
    n++;
  }
  if (n) markDirty();
  return n;
}

/** How many items are still holding a pre-optimisation original. */
export const originalsHeld = () =>
  board.items.filter(it => isHash(it.meta?.was) || isHash(it.meta?.wasCover)).length;

/**
 * Which way up a model file is read.
 *
 * 'z' or 'y'. Anything else clears the override and hands the decision back to
 * the format's own default, which is what a board that has never been told
 * carries - see defaultUpAxis() in import/mesh.js.
 *
 * Its own setter rather than a general "write anything into meta", for the same
 * reason setItemCover has one: `meta` is the open field precisely because
 * nothing polices it, and the two things in there that this app itself reads
 * are better off with a door each than with a hole.
 *
 * Undoable, because it is a visible change to an item and every other visible
 * change to an item is.
 */
export function setItemUpAxis(id, axis) {
  const it = byId(id);
  if (!it) return;
  const next = axis === 'z' || axis === 'y' ? axis : null;
  const prev = it.meta?.upAxis === 'z' || it.meta?.upAxis === 'y' ? it.meta.upAxis : null;
  if (next === prev) return;
  const write = value => {
    const item = byId(id);
    if (!item) return;
    if (value) item.meta = { ...item.meta, upAxis: value };
    else { const { upAxis, ...rest } = item.meta || {}; item.meta = rest; }
    bus.emit('item', id);
  };
  commit('Turn model upright', () => write(next), () => write(prev));
}

/**
 * The still a model card shows instead of running WebGL, and the angle it was
 * taken from.
 *
 * Deliberately *not* undoable, which is the one decision here worth arguing.
 * Everything else that writes to `meta` is a thing somebody did; this is the
 * app putting the kettle on. Taking a fresh photograph of a model you just
 * turned is not an edit to step back through, and if it were, Ctrl+Z would walk
 * you backwards through a stack of pictures of the same object rather than
 * through the work you were doing.
 *
 * It still marks the board dirty, because the bytes it points at have to be
 * saved or the next open has a card pointing at nothing.
 */
export function setModelShot(id, { hash, ink, view } = {}) {
  const it = byId(id);
  if (!it || it.type !== 'model') return;
  const meta = { ...it.meta };
  if (isHash(hash)) meta.shot = hash; else delete meta.shot;
  // What the model was shaded in when the picture was taken. A model with no
  // colours of its own is drawn in the board's ink, so a change of palette
  // leaves every still a shade out of date - and this is what lets the card
  // notice. Absent means the model brought its own colours and never goes stale.
  if (typeof ink === 'string' && ink) meta.shotInk = ink; else delete meta.shotInk;
  if (view && typeof view === 'object') {
    meta.view = { yaw: +view.yaw || 0, pitch: +view.pitch || 0, zoom: +view.zoom || 1 };
  }
  it.meta = meta;
  markDirty();
  bus.emit('item', id);
}

// ---------------------------------------------------------------------------
// Selection
// ---------------------------------------------------------------------------

export function select(ids, additive = false) {
  if (!additive) selection.clear();
  for (const id of ids) selection.add(id);
  bus.emit('selection');
}

export function clearSelection() {
  if (!selection.size) return;
  selection.clear();
  bus.emit('selection');
}

export function selectAll() {
  select(board.items.map(i => i.id));
}

// ---------------------------------------------------------------------------
// Settings + whole-board replacement
// ---------------------------------------------------------------------------

export function setSetting(key, value) {
  if (board.settings[key] === value) return;
  board.settings[key] = value;
  // Snapping is not only a rule for the next drag - it moves the board. Done
  // here rather than at the checkbox because the whimsy axis flips this setting
  // too (Harsh means snapped), and both routes have to behave the same.
  if (key === 'snap') value ? snapAll() : unsnapAll();
  markDirty();
  bus.emit('settings', key);
}

export function setArrangement(name) {
  if (board.arrangement === name) return;
  board.arrangement = name;
  markDirty();
  bus.emit('settings', 'arrangement');
}

export function setTitle(title) {
  board.title = title || 'Untitled board';
  bus.emit('board');
}

/**
 * Replace the whole board (open / new). Clears selection and history.
 *
 * Two steps, and the split is the whole of it: normalise() builds a complete
 * replacement board out of the incoming data and cannot throw, then the
 * assignments below swap it in with nothing left that can fail between them.
 *
 * It used to assign field by field straight from `data`, which was fine right
 * up until one of those fields was not the shape it looked like. `board.json`
 * arrives parsed but unvalidated - it is JSON from a file this app did not
 * necessarily write - and `(data.items || []).map(...)` throws on anything that
 * is not an array. By then the title, the view, the settings and the
 * arrangement had already been replaced, so a board that failed to open left
 * the user looking at their own items under someone else's title, with no way
 * back: there is no undo across a load, by design. Half a board is the one
 * outcome an open must not have.
 */
export function loadBoard(data) {
  const next = normalizeBoard(data);
  board.title = next.title;
  board.view = next.view;
  board.settings = next.settings;
  board.arrangement = next.arrangement;
  board.items = next.items;
  board.trash = next.trash;
  selection.clear();
  clearHistory();
  // Stuckness is remembered rather than recomputed, so it has to be dropped
  // here or a note on the new board would inherit an answer measured on the old
  // one - and ids from two different files can be the same string.
  forgetSticks();
  // The clipboard cannot cross a board. Opening one calls clearAssets(), so a
  // copy taken from the old board would paste an item whose asset hash no
  // longer resolves to any bytes - a card with a hole in it, which is worse
  // than a Ctrl+V that politely does nothing.
  clipboard.items = [];
  clipboard.text = '';
  clipboard.pastes = 0;
  dirty = false;
  // 'board:load' is the "everything was replaced" signal - distinct from
  // 'board', which also fires for a title change or a dirty-flag flip and so
  // must never be treated as a reason to reset the view.
  bus.emit('board:load');
  bus.emit('board');
  bus.emit('items');
  bus.emit('selection');
  bus.emit('trash');
}

/**
 * A whole board, built from whatever arrived, with no way to fail.
 *
 * Every container is checked for the shape it is about to be used as rather
 * than assumed, so a hand-written or truncated board.json degrades to defaults
 * one field at a time instead of throwing half-way through a load.
 */
function normalizeBoard(data) {
  const src = data && typeof data === 'object' ? data : {};
  const settings = src.settings && typeof src.settings === 'object' ? src.settings : {};
  const appearance = settings.appearance && typeof settings.appearance === 'object'
    ? settings.appearance : {};
  const items = Array.isArray(src.items) ? src.items : [];
  const trash = Array.isArray(src.trash) ? src.trash : [];

  return {
    title: typeof src.title === 'string' && src.title ? src.title : 'Untitled board',
    view: {
      pan: { x: +src.view?.pan?.x || 0, y: +src.view?.pan?.y || 0 },
      zoom: +src.view?.zoom || 1,
    },
    settings: {
      ...DEFAULT_SETTINGS,
      ...settings,
      appearance: {
        // Carried through explicitly, and this is the line whose absence lost
        // it. Rebuilding this object key by key overrides the spread above, so
        // an axis position written out with the rest of settings was dropped by
        // every load path there is - a reopened session, an opened .mbrd,
        // somebody else's board. It only ever looked like it worked because
        // ui/appearance.js keeps its own copy in localStorage, which masks the
        // loss until the two disagree.
        //
        // Spread conditionally rather than written as a plain key: an explicit
        // `whimsy: undefined` still puts the property there, and hasLook()
        // tests `whimsy != null`, so a board that genuinely brought no look
        // would start claiming it had one and would override the user's own
        // saved axis with a default. Left unclamped, because ui/appearance.js
        // clamps whatever it is handed - which is the right place for it, this
        // value also arriving from files this app did not write. Same for
        // `vars`: ui/appearance.js is what decides which tokens a board is
        // allowed to set, and it applies that rule to every look it is given.
        ...(appearance.whimsy != null ? { whimsy: appearance.whimsy } : {}),
        palette: typeof appearance.palette === 'string' ? appearance.palette : '',
        vars: appearance.vars && typeof appearance.vars === 'object'
          ? { ...appearance.vars } : {},
      },
      // Held to shape here rather than where it is read, for the same reason
      // `vars` is filtered rather than trusted: both name bytes and both end up
      // inside a CSS declaration, and both arrive inside a file somebody else
      // wrote. See normalizeFonts().
      fonts: normalizeFonts(settings.fonts),
      // A scale of zero, a negative one or a NaN would turn every measurement
      // on the board into Infinity or a blank, in a readout that is meant to be
      // the trustworthy part. Clamped rather than rejected: a board carrying a
      // silly scale is still a board, and the geometry it holds is untouched by
      // this number either way.
      scale: clampScale(settings.scale),
      units: settings.units === 'imperial' ? 'imperial' : 'metric',
      // Checked against the list rather than taken on trust, so a board naming
      // a size this version does not have - a newer one, or a typo - draws no
      // sheet instead of drawing nothing while the menu insists something is
      // selected. Falls back to '', which is a state the whole feature already
      // handles because it is the default.
      paper: PAPERS.some(p => p.id === settings.paper) ? settings.paper : '',
      paperLandscape: !!settings.paperLandscape,
      paperResize: !!settings.paperResize,
    },
    arrangement: typeof src.arrangement === 'string' && src.arrangement
      ? src.arrangement : 'spiral',
    items: items.filter(it => it && typeof it === 'object').map(makeItem),
    trash: trash
      .filter(t => t && t.item && typeof t.item === 'object')
      .map(t => ({ item: makeItem(t.item), at: +t.at || 0 })),
  };
}

/**
 * The faces a board carries, reduced to the ones it may.
 *
 * `{ hash, family }` and nothing else - the hash names bytes in the asset store
 * and the family becomes a CSS family name, so a bad one of either is a bad
 * declaration or a dangling reference. Filtered entry by entry rather than
 * rejected wholesale, which is how everything else in this function behaves: a
 * board carrying four faces and one broken record should open with four.
 *
 * Capped, because this list is walked by the packer and registered against the
 * document, and neither wants a thousand entries out of a hand-written file.
 */
function normalizeFonts(raw) {
  if (!Array.isArray(raw)) return [];
  const out = [];
  const seen = new Set();
  for (const f of raw) {
    if (!f || typeof f !== 'object') continue;
    if (!isHash(f.hash) || seen.has(f.hash) || !isFamily(f.family)) continue;
    seen.add(f.hash);
    out.push({ hash: f.hash, family: f.family });
    if (out.length >= MAX_FONTS) break;
  }
  return out;
}

/** Matches MAX_FONTS in ui/fonts.js - the two are one limit in two layers. */
const MAX_FONTS = 8;

/** The serialisable board, exactly as it lands in board.json. */
export function serializeBoard() {
  return {
    title: board.title,
    view: { pan: { ...board.view.pan }, zoom: board.view.zoom },
    settings: board.settings,
    arrangement: board.arrangement,
    items: board.items.map(serializeItem),
    // The bin travels with the board. Saving is the moment a board becomes a
    // file you might not open again for a month, and a bin that emptied itself
    // at exactly that moment would be a trapdoor rather than a safety net.
    trash: board.trash.map(t => ({ at: t.at, item: serializeItem(t.item) })),
  };
}

const serializeItem = i => ({
  id: i.id, type: i.type,
  x: round(i.x), y: round(i.y), w: round(i.w), h: round(i.h),
  rot: round(i.rot), z: i.z,
  name: i.name, asset: i.asset, meta: i.meta,
});

const round = n => Math.round(n * 100) / 100;
