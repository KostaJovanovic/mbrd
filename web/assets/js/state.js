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
//   history    - undo/redo availability changed
//   trash      - something was thrown away, restored, or purged

import { emitter, uid } from './util.js';
// The asset registry remembers the filename each item arrived under, which is
// what a cleared name falls back to - see renameItem(). One-way: assets.js
// depends on nothing but util.js, so this cannot close a cycle.
import { getAsset } from './storage/assets.js';

export const bus = emitter();

export const DEFAULT_SETTINGS = {
  grid: true,
  axes: true,
  snap: false,
  hud: true,
  gridStyle: 'dots',   // the only style; kept so old .mbrd files still load
  gridStep: 64,        // world px between minor grid lines, before zoom quantisation
  spacing: 32,         // gap used by the arrangement engine
  appearance: { palette: '', vars: {} },
};

export const board = {
  title: 'Untitled board',
  view: { pan: { x: 0, y: 0 }, zoom: 1 },
  settings: { ...DEFAULT_SETTINGS, appearance: { palette: '', vars: {} } },
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

/** Normalise a partial item into the full persisted shape. */
export function makeItem(partial) {
  let meta = partial.meta || {};
  // The one funnel every item passes through on its way onto the board, which
  // makes it the place to hold a note to its ceiling. The editor enforces the
  // same limit while you type; this catches the other doors - an older .mbrd,
  // and a notes/*.md someone edited by hand outside the app.
  if ((partial.type || 'generic') === 'note' && typeof meta.text === 'string' && meta.text.length > NOTE_MAX) {
    meta = { ...meta, text: meta.text.slice(0, NOTE_MAX) };
  }
  return {
    id: partial.id || uid(),
    type: partial.type || 'generic',
    x: +partial.x || 0,
    y: +partial.y || 0,
    w: +partial.w || 240,
    h: +partial.h || 180,
    rot: +partial.rot || 0,
    z: partial.z != null ? +partial.z : topZ() + 1,
    name: partial.name || '',
    asset: partial.asset || null,
    meta,
  };
}

// ---------------------------------------------------------------------------
// History
// ---------------------------------------------------------------------------

const undoStack = [];
const redoStack = [];
const HISTORY_LIMIT = 200;

export const canUndo = () => undoStack.length > 0;
export const canRedo = () => redoStack.length > 0;

/** Run `redo` now and remember how to reverse it. */
export function commit(label, redo, undo) {
  redo();
  undoStack.push({ label, redo, undo });
  if (undoStack.length > HISTORY_LIMIT) undoStack.shift();
  redoStack.length = 0;
  markDirty();
  bus.emit('history');
}

export function undo() {
  const cmd = undoStack.pop();
  if (!cmd) return false;
  cmd.undo();
  redoStack.push(cmd);
  markDirty();
  bus.emit('history');
  return true;
}

export function redo() {
  const cmd = redoStack.pop();
  if (!cmd) return false;
  cmd.redo();
  undoStack.push(cmd);
  markDirty();
  bus.emit('history');
  return true;
}

export function clearHistory() {
  undoStack.length = 0;
  redoStack.length = 0;
  bus.emit('history');
}

// ---------------------------------------------------------------------------
// Item mutations (all undoable)
// ---------------------------------------------------------------------------

export function addItems(items, label = 'Add') {
  const added = items.map(makeItem);
  commit(label,
    () => { board.items.push(...added.filter(a => !byId(a.id))); bus.emit('items'); },
    () => { const ids = new Set(added.map(a => a.id));
            board.items = board.items.filter(i => !ids.has(i.id));
            ids.forEach(id => selection.delete(id));
            bus.emit('items'); bus.emit('selection'); });
  return added;
}

/**
 * How many things the bin holds before the oldest start falling out the
 * bottom. A bin is a safety net, not an archive - and every entry pins its
 * asset's bytes into the saved file, so an unbounded one would quietly make a
 * board grow forever as you worked on it.
 */
export const TRASH_LIMIT = 60;

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
  commit(label,
    () => { board.items = board.items.filter(i => !set.has(i.id));
            set.forEach(id => selection.delete(id));
            board.trash.unshift(...binned);
            // Anything the limit pushes out is older than this delete and so
            // belongs to no undo entry being replayed here.
            if (board.trash.length > TRASH_LIMIT) board.trash.length = TRASH_LIMIT;
            bus.emit('items'); bus.emit('selection'); bus.emit('trash'); },
    () => { for (const r of removed) board.items.splice(r.index, 0, r.item);
            board.trash = board.trash.filter(t => !set.has(t.item.id));
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
export function commitGeom(label, before) {
  const after = snapshotGeom(before.map(b => b.id));
  const changed = after.some((a, i) => GEOM_KEYS.some(k => a[k] !== before[i][k]));
  if (!changed) return;
  commit(label, () => applyGeom(after), () => applyGeom(before));
}

export function bottomZ() {
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
function stackOrder(ids) {
  return [...ids].sort((a, b) => (byId(a)?.z || 0) - (byId(b)?.z || 0));
}

/**
 * Copy items, offset a little so the copy is visibly on top of the original.
 * The copies reference the same asset hashes, so duplicating a 40 MB video
 * costs nothing on disk - the packer writes each hash once.
 */
export function duplicateItems(ids, offset = { x: 28, y: -28 }) {
  const src = board.items.filter(i => [...ids].includes(i.id));
  if (!src.length) return [];
  const copies = src.map(i => ({
    type: i.type,
    x: i.x + offset.x,
    y: i.y + offset.y,
    w: i.w, h: i.h, rot: i.rot,
    name: i.name,
    asset: i.asset ? { ...i.asset } : null,
    meta: { ...i.meta },
    // id and z left undefined so makeItem() mints a fresh id and stacks it on top.
  }));
  return addItems(copies, copies.length > 1 ? `Duplicate ${copies.length} items` : 'Duplicate');
}

/**
 * How much a sticky note holds. A sticky is a thought you can take in at a
 * glance - past a couple of hundred characters it is a document, and it wants
 * to be a text file on the board instead. Enforced here as well as in the
 * editor, so a paste, an import or an older .mbrd cannot get around it.
 */
export const NOTE_MAX = 255;

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
export function renameItem(id, name) {
  const it = byId(id);
  if (!it) return;
  const next = String(name ?? '').trim() ||
               (it.asset && getAsset(it.asset.hash)?.name) || it.name;
  if (it.name === next) return;
  const prev = it.name;
  commit('Rename',
    () => { byId(id).name = next; bus.emit('item', id); },
    () => { byId(id).name = prev; bus.emit('item', id); });
}

// ---------------------------------------------------------------------------
// Selection
// ---------------------------------------------------------------------------

export function select(ids, additive = false) {
  if (!additive) selection.clear();
  for (const id of ids) selection.add(id);
  bus.emit('selection');
}

export function deselect(ids) {
  for (const id of ids) selection.delete(id);
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

/** Replace the whole board (open / new). Clears selection and history. */
export function loadBoard(data) {
  board.title = data.title || 'Untitled board';
  board.view = {
    pan: { x: +data.view?.pan?.x || 0, y: +data.view?.pan?.y || 0 },
    zoom: +data.view?.zoom || 1,
  };
  board.settings = {
    ...DEFAULT_SETTINGS,
    ...(data.settings || {}),
    appearance: {
      palette: data.settings?.appearance?.palette || '',
      vars: { ...(data.settings?.appearance?.vars || {}) },
    },
  };
  board.arrangement = data.arrangement || 'spiral';
  board.items = (data.items || []).map(makeItem);
  board.trash = (data.trash || [])
    .filter(t => t && t.item)
    .map(t => ({ item: makeItem(t.item), at: +t.at || 0 }));
  selection.clear();
  clearHistory();
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
