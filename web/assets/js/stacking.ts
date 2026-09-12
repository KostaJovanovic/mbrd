// Z-order with sticky layers. A note is ordered against its host, not the
// board — raising a photo carries its notes. stackGroups() gathers items under
// their stack root and orders groups against each other by root z.

import { overlapFraction, rotatedExtents } from './geometry.ts';
import { bus, selection } from './board-store.ts';
import { board, byId, topZ } from './board-model.ts';
import type { Item } from './board-model.ts';
import { stuckTo, isSticky } from './sticky.ts';
import { fenceOf, isFence } from './fences.ts';
import { snapshotGeom, commitGeom } from './layout.ts';

function bottomZ() {
  return board.items.reduce((m, i) => Math.min(m, i.z || 0), 0);
}

export function raiseSelection() {
  const layer = stackLayerIds(selection);
  const before = snapshotGeom(layer);
  if (!before.length) return;
  let z = topZ();
  // Walk in stacking order so internal arrangement is preserved.
  for (const id of stackOrder(layer)) byId(id)!.z = ++z;
  bus.emit('geom', layer);
  commitGeom('Bring to front', before);
}

export function lowerSelection() {
  const layer = stackLayerIds(selection);
  const before = snapshotGeom(layer);
  if (!before.length) return;
  let z = bottomZ();
  // Non-null: ids from stackLayerIds() are live board items.
  for (const id of stackOrder(layer).reverse()) byId(id)!.z = --z;
  bus.emit('geom', layer);
  commitGeom('Send to back', before);
}

/** The given ids, sorted bottom-to-top by their current z. */
export function stackOrder(ids: Iterable<string>) {
  return [...ids].sort((a, b) => (byId(a)?.z || 0) - (byId(b)?.z || 0));
}

/**
 * Visual stack: three bands (fences, cards, notes) so fences are always behind
 * cards and notes always in front. Bands are presentation only — raw z is not
 * rewritten. Bring-to-front / Send-to-back reorder within a band.
 */
export function visualStackOrder() {
  const order = stackGroups().flatMap(group => group.items);
  const fences: string[] = [], notes: string[] = [], rest: string[] = [];
  for (const item of order) {
    (isFence(item) ? fences : isSticky(item) ? notes : rest).push(item.id);
  }
  return [...sortFences(fences), ...rest, ...notes];
}

/**
 * Fences sorted largest-first so nested regions are never buried by their parent.
 * Area-based: containment requires strictly greater area, so "smaller = nearer
 * front" matches nesting at any depth. Equal-area fences keep raw z order.
 */
function sortFences(ids: Iterable<string>) {
  const area = (id: string) => {
    const it = byId(id);
    return Math.abs((it?.w || 0) * (it?.h || 0));
  };
  return [...ids].sort((a, b) => area(b) - area(a));
}

/** Expand ids to full sticky layers (both directions: host includes notes, note includes host). */
export function stackLayerIds(ids: Iterable<string>) {
  const wanted = new Set([...ids].map(id => byId(id)).filter((it): it is Item => !!it).map(stackRoot).map(item => item.id));
  if (!wanted.size) return [];
  return stackGroups()
    .filter(group => wanted.has(group.root.id))
    .flatMap(group => group.items.map(item => item.id));
}

/** Whether a z-order action could change coverage. Overlap within a sticky layer does not count. */
export function selectionHasStackOverlap(ids: Iterable<string> = selection) {
  const selected = new Set(stackLayerIds(ids));
  if (!selected.size) return false;

  // X-axis sweep (O(n log n)) instead of pairwise (O(n^2)). Rotated extents
  // used — raw `w` would miss leaning cards.
  type Span = { item: Item; inside: boolean; lo: number; hi: number };
  const spans: Span[] = [];
  let anyIn = false;
  let anyOut = false;
  for (const item of board.items) {
    const { hw } = rotatedExtents(item);
    const inside = selected.has(item.id);
    if (inside) anyIn = true; else anyOut = true;
    spans.push({ item, inside, lo: item.x - hw, hi: item.x + hw });
  }
  // Nothing on one side of the selection line.
  if (!anyIn || !anyOut) return false;
  spans.sort((a, b) => a.lo - b.lo);

  let active: Span[] = [];
  for (const s of spans) {
    // Evict spans whose right edge is behind this left edge.
    if (active.length) active = active.filter(a => a.hi >= s.lo);
    for (const a of active) {
      // Same side or same sticky layer — not a relevant pair.
      if (a.inside === s.inside) continue;
      // Fraction is of the selected item's area.
      const [in_, out] = a.inside ? [a.item, s.item] : [s.item, a.item];
      if (overlapFraction(in_, out) > 0) return true;
    }
    active.push(s);
  }
  return false;
}

/**
 * Walk up stick + fence chains to find the root that owns this item's layer.
 * A note on a photo inside a fence roots at the fence — all three change z
 * together. Visited set guards against cycles (should be impossible).
 */
export function stackRoot(item: Item): Item {
  let root = item;
  const seen = new Set<string>();
  while (root && !seen.has(root.id)) {
    seen.add(root.id);
    const up = stuckTo(root) || fenceOf(root);
    if (!up) break;
    root = up;
  }
  return root;
}

/** Sticky layers ordered externally by their root, internally by raw z. */
function stackGroups() {
  const boardOrder = new Map(board.items.map((item, index) => [item.id, index]));
  const groups = new Map<string, { root: Item, items: Item[] }>();
  for (const item of board.items) {
    const root = stackRoot(item);
    let group = groups.get(root.id);
    if (!group) {
      group = { root, items: [] };
      groups.set(root.id, group);
    }
    group.items.push(item);
  }
  // Non-null: all ids come from board.items, same as boardOrder.
  const compare = (a: Item, b: Item) =>
    (a.z || 0) - (b.z || 0) || boardOrder.get(a.id)! - boardOrder.get(b.id)!;
  for (const group of groups.values()) group.items.sort(compare);
  return [...groups.values()].sort((a, b) => compare(a.root, b.root));
}
