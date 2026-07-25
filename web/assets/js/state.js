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

/** The axis-aligned box around a set of items, or null for none. */
function boundsOf(items) {
  if (!items.length) return null;
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const i of items) {
    x0 = Math.min(x0, i.x - i.w / 2); x1 = Math.max(x1, i.x + i.w / 2);
    y0 = Math.min(y0, i.y - i.h / 2); y1 = Math.max(y1, i.y + i.h / 2);
  }
  return { x0, y0, x1, y1 };
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
export const clipboardBounds = () => boundsOf(clipboard.items);

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
  const src = itemsIn(ids);
  if (!src.length) return '';
  clipboard.items = src.map(i => cloneItem(i));
  clipboard.pastes = 0;
  clipboard.text = summarise(src);
  return clipboard.text;
}

/**
 * Copy, then delete: one undo entry, because removeItems() is the only half
 * that touched the board. Cut items go to the bin like any other delete, so a
 * cut you never paste is still recoverable.
 */
export function cutItems(ids) {
  const doomed = itemsIn(ids).map(i => i.id);
  const text = copyItems(doomed);
  if (!text) return '';
  removeItems(doomed, doomed.length > 1 ? `Cut ${doomed.length} items` : 'Cut');
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
    const b = boundsOf(clipboard.items);
    dx = at.x - (b.x0 + b.x1) / 2 + n * PASTE_STEP.x;
    dy = at.y - (b.y0 + b.y1) / 2 + n * PASTE_STEP.y;
  } else {
    dx = (n + 1) * PASTE_STEP.x;
    dy = (n + 1) * PASTE_STEP.y;
  }
  const copies = clipboard.items.map(i => cloneItem(i, dx, dy));
  return addItems(copies, copies.length > 1 ? `Paste ${copies.length} items` : 'Paste');
}

// ---------------------------------------------------------------------------
// Sticky notes that stick
//
// A note is stuck to whatever it is lying on, and a stuck note travels with its
// host. Nothing about that is stored. Stuckness is a fact about where two
// things are, and an edge recorded on the item would have to be invalidated by
// every move, resize, undo and redo at either end - all of which can happen
// without the pair ever being touched together. So it is measured from live
// geometry, once per gesture, and a board file never mentions it.
// ---------------------------------------------------------------------------

/**
 * Whether a world point lies inside an item's box.
 *
 * Tested in the item's *own* frame: the point is brought back through the
 * item's rotation and compared against the unrotated extents. That is the same
 * box the resize grips work in and the same one fit() frames, and it is the one
 * on screen. Testing the axis-aligned bounding box instead would be visibly
 * wrong for a rotated item - a card turned 45 degrees draws a diamond, and its
 * bounding box reaches half its diagonal past that into empty space, so a note
 * parked in one of those corners would claim to be stuck to nothing.
 *
 * `rot` is the only rotation accounted for. Items also rest at a small
 * presentational tilt (--item-tilt, dealt in items.js) which is deliberately
 * not part of the geometry model. It is a couple of degrees, so leaving it out
 * can only disagree with the eye a hair's breadth from an edge, which is
 * exactly where "is it over it or not" had no obvious answer anyway.
 */
function pointInItem(px, py, it) {
  const dx = px - it.x, dy = py - it.y;
  // Cheap reject first, and it takes almost every pair: no rotation of the box
  // reaches outside the circle that circumscribes it, and this costs no trig.
  if (dx * dx + dy * dy > (it.w * it.w + it.h * it.h) / 4) return false;
  if (!it.rot) return Math.abs(dx) <= it.w / 2 && Math.abs(dy) <= it.h / 2;
  // rot is anticlockwise-positive in world space, so undoing it is a rotation
  // by -rot: the usual matrix with the signs on the sines swapped.
  const rad = it.rot * Math.PI / 180;
  const c = Math.cos(rad), s = Math.sin(rad);
  return Math.abs(c * dx + s * dy) <= it.w / 2 &&
         Math.abs(c * dy - s * dx) <= it.h / 2;
}

/** The two ends of an item's top edge, in world coordinates (+y is up). */
function topEdge(it) {
  const rad = (it.rot || 0) * Math.PI / 180;
  const c = Math.cos(rad), s = Math.sin(rad);
  const hw = it.w / 2, hh = it.h / 2;
  return [
    { x: it.x - c * hw - s * hh, y: it.y - s * hw + c * hh },
    { x: it.x + c * hw - s * hh, y: it.y + s * hw + c * hh },
  ];
}

/**
 * The item a sticky note is stuck to, or null.
 *
 * Two ways to be stuck, either sufficient: the note's centre is over the item,
 * or its whole top edge is - the strip a real sticky is pressed down by, which
 * is why a note hanging off the bottom of a photo still counts and one hanging
 * off the top does not. The top-edge test only checks the two ends of that
 * edge, and that is exact rather than an approximation: an item's box is
 * convex, so a segment with both ends inside it lies inside it entirely.
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
  const [a, b] = topEdge(note);
  let best = null;
  for (const it of board.items) {
    if (it.id === note.id || (it.z || 0) >= (note.z || 0)) continue;
    if (best && (it.z || 0) < (best.z || 0)) continue;
    if (pointInItem(note.x, note.y, it) ||
        (pointInItem(a.x, a.y, it) && pointInItem(b.x, b.y, it))) best = it;
  }
  return best;
}

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
      // Carried through explicitly, and this is the line whose absence lost it.
      // Rebuilding this object key by key overrides the spread above, so an
      // axis position written out with the rest of settings was dropped by
      // every load path there is - a reopened session, an opened .mbrd,
      // somebody else's board. It only ever looked like it worked because
      // ui/appearance.js keeps its own copy in localStorage, which masks the
      // loss until the two disagree.
      //
      // Spread conditionally rather than written as a plain key: an explicit
      // `whimsy: undefined` still puts the property there, and hasLook() tests
      // `whimsy != null`, so a board that genuinely brought no look would start
      // claiming it had one and would override the user's own saved axis with a
      // default. Left unclamped, because ui/appearance.js clamps whatever it is
      // handed - which is the right place for it, this value also arriving from
      // files this app did not write.
      ...(data.settings?.appearance?.whimsy != null
        ? { whimsy: data.settings.appearance.whimsy }
        : {}),
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
