// Z-order: what is in front of what, and what moves as one when it changes.
//
// Two rules, and the second is the interesting one.
//
// Plain z decides the order. But a sticky note is not ordered against the board
// - it is ordered against the thing it is stuck to, and it travels with it. So
// "raise this" cannot mean "give this the top z": raising a photograph with
// three notes on it has to carry the notes, and raising one of those notes has
// to move it within the pile rather than out of it. stackGroups() is that
// second rule made explicit - items are gathered under their stack root, groups
// are ordered against each other by their roots, and members are ordered inside
// their group by raw z.
//
// Fifth concern out of state.js, and it could only follow layout.js: everything
// here reads geometry and none of it could reach that while the geometry lived
// in the file being split.
//
// The known cost, recorded rather than fixed: stackOrder() calls byId twice per
// comparison, so it is O(n log n) comparisons over an O(1) lookup - fine now
// that byId is indexed, and it was the audit's worst case when byId was a scan.
// selectionHasStackOverlap() is still an O(n^2) pairwise polygon test exposed as
// a live context-menu command; see the audit's 1.6.

import { overlapFraction } from './geometry.js';
import { bus, selection } from './board-store.js';
import { board, byId, topZ } from './board-model.js';
import { stuckTo } from './sticky.js';
import { fenceOf } from './fences.js';
import { snapshotGeom, commitGeom } from './layout.js';

export function bottomZ() {
  return board.items.reduce((m, i) => Math.min(m, i.z || 0), 0);
}

export function raiseSelection() {
  const layer = stackLayerIds(selection);
  const before = snapshotGeom(layer);
  if (!before.length) return;
  let z = topZ();
  // Walk in current stacking order so a multi-selection and every sticky layer
  // keep their internal arrangement instead of being reshuffled by Set
  // iteration order.
  for (const id of stackOrder(layer)) byId(id).z = ++z;
  bus.emit('geom', layer);
  commitGeom('Bring to front', before);
}

export function lowerSelection() {
  const layer = stackLayerIds(selection);
  const before = snapshotGeom(layer);
  if (!before.length) return;
  let z = bottomZ();
  for (const id of stackOrder(layer).reverse()) byId(id).z = --z;
  bus.emit('geom', layer);
  commitGeom('Send to back', before);
}

/** The given ids, sorted bottom-to-top by their current z. */
export function stackOrder(ids) {
  return [...ids].sort((a, b) => (byId(a)?.z || 0) - (byId(b)?.z || 0));
}

/**
 * The visual stack, bottom-to-top, with each sticky chain kept as one layer and
 * every note lifted above everything that is not a note.
 *
 * A sticky note is a mark laid *on* the board's contents - a caption, a flag, a
 * scrap - so it is never buried by the picture it annotates or by anything else;
 * only another note may sit over it. The two bands are presentation alone. Raw z
 * still records the host-below-note order that lets a board rediscover sticky
 * relations after loading (see measureStick), so the band is not written back
 * into z and nothing about stickiness changes. And because Bring-to-front /
 * Send-to-back move an item by its raw z, splitting the visible stack into these
 * bands is exactly what makes those actions reorder a note among notes and a
 * non-note among non-notes without either ever crossing into the other's band.
 *
 * Within each band the group order is kept, so a note still sits above the very
 * host it is stuck to, and a pile of notes keeps the order it was laid down in.
 */
export function visualStackOrder() {
  const order = stackGroups().flatMap(group => group.items);
  const notes = [], rest = [];
  for (const item of order) (item.type === 'note' ? notes : rest).push(item.id);
  return [...rest, ...notes];
}

/**
 * Expand ids to every member of their sticky layers, in visual stack order.
 *
 * This goes both directions. Selecting a host includes all its notes; selecting
 * one of those notes also includes the host and its sibling notes for a z-order
 * change, even though an ordinary spatial move may still peel that note away.
 */
export function stackLayerIds(ids) {
  const wanted = new Set([...ids].map(id => byId(id)).filter(Boolean).map(stackRoot).map(item => item.id));
  if (!wanted.size) return [];
  return stackGroups()
    .filter(group => wanted.has(group.root.id))
    .flatMap(group => group.items.map(item => item.id));
}

/**
 * Whether a z-order action could change what the current layer covers.
 *
 * Overlap within a sticky layer does not count: the note and host deliberately
 * cover one another and already move through the external stack as one object.
 */
export function selectionHasStackOverlap(ids = selection) {
  const selected = new Set(stackLayerIds(ids));
  if (!selected.size) return false;
  const inside = board.items.filter(item => selected.has(item.id));
  const outside = board.items.filter(item => !selected.has(item.id));
  return inside.some(a => outside.some(b => overlapFraction(a, b) > 0));
}

/**
 * The bottom-most ancestor that owns an item's external layer.
 *
 * Two relations, walked as one chain: a note goes up to what it is stuck to, and
 * anything goes up to the fence around it. So a note on a photo inside a fence
 * roots at the fence, and the three change z together.
 *
 * This is the one place fences and sticky notes meet, and they have to. A fence
 * is drawn *behind* its members, so "bring this fence to front" that did not
 * carry them would put the fence over its own contents - the one arrangement the
 * feature cannot survive. Carrying the whole layer is what keeps the fence at the
 * bottom of it, since raiseSelection() walks the layer in raw z order and the
 * fence is the lowest thing in it.
 *
 * The `seen` guard is belt and braces: sticking requires a lower z and
 * containment requires a strictly larger area, so neither relation can cycle and
 * the pair cannot either. It costs one Set on a walk that is two steps deep.
 */
export function stackRoot(item) {
  let root = item;
  const seen = new Set();
  while (root && !seen.has(root.id)) {
    seen.add(root.id);
    const up = (root.type === 'note' ? stuckTo(root) : null) || fenceOf(root);
    if (!up) break;
    root = up;
  }
  return root;
}

/** Sticky layers ordered externally by their root, internally by raw z. */
export function stackGroups() {
  const boardOrder = new Map(board.items.map((item, index) => [item.id, index]));
  const groups = new Map();
  for (const item of board.items) {
    const root = stackRoot(item);
    let group = groups.get(root.id);
    if (!group) {
      group = { root, items: [] };
      groups.set(root.id, group);
    }
    group.items.push(item);
  }
  const compare = (a, b) =>
    (a.z || 0) - (b.z || 0) || boardOrder.get(a.id) - boardOrder.get(b.id);
  for (const group of groups.values()) group.items.sort(compare);
  return [...groups.values()].sort((a, b) => compare(a.root, b.root));
}

/**
 * The live items behind a set of ids, bottom-to-top.
 *
 * Sorted, because a copy of several things has to be laid down in the order
 * they were stacked in: addItems() gives each new item the next z as it goes,
 * so handing it the group in board order rather than stacking order would
 * reshuffle a carefully arranged pile every time it was duplicated.
 */
