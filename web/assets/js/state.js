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

import { emitter, uid } from './util.js';

export const bus = emitter();

export const DEFAULT_SETTINGS = {
  grid: true,
  axes: true,
  snap: false,
  hud: true,
  gridStyle: 'dots',   // dots | lines | graph
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
    meta: partial.meta || {},
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

export function removeItems(ids, label = 'Delete') {
  const set = new Set(ids);
  // Keep the original index so undo restores z-order position, not just the item.
  const removed = board.items
    .map((item, index) => ({ item, index }))
    .filter(r => set.has(r.item.id));
  if (!removed.length) return;
  commit(label,
    () => { board.items = board.items.filter(i => !set.has(i.id));
            set.forEach(id => selection.delete(id));
            bus.emit('items'); bus.emit('selection'); },
    () => { for (const r of removed) board.items.splice(r.index, 0, r.item);
            bus.emit('items'); });
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

export function setItemText(id, text) {
  const it = byId(id);
  if (!it || it.meta.text === text) return;
  const prev = it.meta.text;
  commit('Edit note',
    () => { byId(id).meta.text = text; bus.emit('item', id); },
    () => { byId(id).meta.text = prev; bus.emit('item', id); });
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
}

/** The serialisable board, exactly as it lands in board.json. */
export function serializeBoard() {
  return {
    title: board.title,
    view: { pan: { ...board.view.pan }, zoom: board.view.zoom },
    settings: board.settings,
    arrangement: board.arrangement,
    items: board.items.map(i => ({
      id: i.id, type: i.type,
      x: round(i.x), y: round(i.y), w: round(i.w), h: round(i.h),
      rot: round(i.rot), z: i.z,
      name: i.name, asset: i.asset, meta: i.meta,
    })),
  };
}

const round = n => Math.round(n * 100) / 100;
