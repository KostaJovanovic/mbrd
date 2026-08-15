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
//
// selectionHasStackOverlap() used to be the other half of that note, as an
// O(n^2) pairwise polygon test on the path that opens a context menu. It is a
// sweep along x now - see the comment on it - so the pairs that cannot touch are
// never formed rather than formed and rejected.

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
  // Walk in current stacking order so a multi-selection and every sticky layer
  // keep their internal arrangement instead of being reshuffled by Set
  // iteration order.
  // Non-null: every id in the layer came out of stackLayerIds(), which built it
  // from items it had already looked up on this board.
  for (const id of stackOrder(layer)) byId(id)!.z = ++z;
  bus.emit('geom', layer);
  commitGeom('Bring to front', before);
}

export function lowerSelection() {
  const layer = stackLayerIds(selection);
  const before = snapshotGeom(layer);
  if (!before.length) return;
  let z = bottomZ();
  // Non-null for the reason given in raiseSelection().
  for (const id of stackOrder(layer).reverse()) byId(id)!.z = --z;
  bus.emit('geom', layer);
  commitGeom('Send to back', before);
}

/** The given ids, sorted bottom-to-top by their current z. */
export function stackOrder(ids: Iterable<string>) {
  return [...ids].sort((a, b) => (byId(a)?.z || 0) - (byId(b)?.z || 0));
}

/**
 * The visual stack, bottom-to-top, with each sticky chain kept as one layer and
 * three bands laid over the result.
 *
 * A sticky note is a mark laid *on* the board's contents - a caption, a flag, a
 * scrap - so it is never buried by the picture it annotates or by anything else;
 * only another note may sit over it. A fence is the mirror image: a region drawn
 * on the board *under* its contents, so it is never in front of anything, and
 * only another fence may sit over it. So the stack is fences, then everything
 * else, then notes.
 *
 * The fence band is what makes "a fence is behind its cards" true rather than
 * merely arranged. It used to be arranged: a new fence took a z below every card
 * it enclosed, which is correct at the moment it is drawn and false the moment
 * anything changes - resize a fence out over a card that was already lower than
 * it and the card is picked up and then hidden behind the thing that picked it
 * up. Every fix for that at the z level is a mutation somebody's undo has to
 * carry. A band costs nothing and cannot drift, because there is nothing stored
 * to drift.
 *
 * The bands are presentation alone. Raw z still records the host-below-note order
 * that lets a board rediscover sticky relations after loading (see measureStick),
 * so a band is not written back into z and nothing about either relation changes.
 * And because Bring-to-front / Send-to-back move an item by its raw z, splitting
 * the visible stack this way is exactly what makes those actions reorder a note
 * among notes, a fence among fences, and a card among cards, with none of the
 * three ever crossing into another's band.
 *
 * Within each band the group order is kept, so a note still sits above the very
 * host it is stuck to, and a pile of notes keeps the order it was laid down in.
 * The fence band is the one exception, and nesting is why - see below.
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
 * The fence band, largest first, so a nested region is never buried by the one
 * around it.
 *
 * Sorted by area rather than left in z order because z cannot express this. A
 * fence is drawn below its contents, and the contents of a fence inside a fence
 * include that fence - so a nested region needs a z below its cards and above its
 * parent, and on a board where both the cards and the parent are whole numbers a
 * step apart there is no such number. Every fence drawn inside another therefore
 * came out on the same z as it, and which of the two names you could read was
 * whichever the sort happened to put last.
 *
 * Area answers it exactly and stores nothing, which is the band's whole argument
 * repeated one level down: containment already requires strictly greater area
 * (see measure() in fences.js), so "smaller is nearer the front" *is* "a region
 * is in front of the region that holds it", for any depth of nesting and with no
 * z to keep in step. Stable, so two fences of the same area - which by that rule
 * cannot contain one another - keep the raw z order they came in with, and Bring
 * to front still separates them.
 */
function sortFences(ids: Iterable<string>) {
  const area = (id: string) => {
    const it = byId(id);
    return Math.abs((it?.w || 0) * (it?.h || 0));
  };
  return [...ids].sort((a, b) => area(b) - area(a));
}

/**
 * Expand ids to every member of their sticky layers, in visual stack order.
 *
 * This goes both directions. Selecting a host includes all its notes; selecting
 * one of those notes also includes the host and its sibling notes for a z-order
 * change, even though an ordinary spatial move may still peel that note away.
 */
export function stackLayerIds(ids: Iterable<string>) {
  const wanted = new Set([...ids].map(id => byId(id)).filter((it): it is Item => !!it).map(stackRoot).map(item => item.id));
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
export function selectionHasStackOverlap(ids: Iterable<string> = selection) {
  const selected = new Set(stackLayerIds(ids));
  if (!selected.size) return false;

  // A sweep along x, rather than every selected item against every other one.
  //
  // This runs while somebody is waiting for a context menu to appear, and it
  // used to be a pairwise walk: 200 selected against 1,800 others is 360,000
  // calls into a polygon clipper, to answer a question whose only use is
  // deciding whether to show two rows. overlapFraction() rejects most pairs on a
  // circle test before it clips anything, so the per-pair cost was never the
  // problem - the number of pairs was.
  //
  // Sorting by left edge and keeping an active list makes the enumeration
  // O(n log n) plus one visit per pair that genuinely overlaps *on the x axis*,
  // which on a real board is a small multiple of n. Two boxes that do not share
  // an x span cannot intersect, so those pairs are never formed rather than
  // formed and rejected.
  //
  // Extents are the rotated ones. A leaning card's bounding box is wider than
  // its own width, and a sweep that used `w` would drop the pair before the
  // clipper ever saw it - the one way this could report *less* overlap than the
  // pairwise version did, which would be a wrong answer rather than a slower one.
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
  // Nothing to compare against: an empty board on one side of the line.
  if (!anyIn || !anyOut) return false;
  spans.sort((a, b) => a.lo - b.lo);

  let active: Span[] = [];
  for (const s of spans) {
    // Everything whose right edge is behind this left edge can never meet
    // anything further along the sweep, so it leaves the active list for good.
    if (active.length) active = active.filter(a => a.hi >= s.lo);
    for (const a of active) {
      // Same side of the selection: the pair was never a question. Overlap
      // *within* a sticky layer does not count either, and stackLayerIds() has
      // already folded a note in with its host, so both land here as `inside`.
      if (a.inside === s.inside) continue;
      // Argument order preserved from the pairwise version: the fraction is of
      // the first box's own area, and the selected item is the one that was
      // always asked about.
      const [in_, out] = a.inside ? [a.item, s.item] : [s.item, a.item];
      if (overlapFraction(in_, out) > 0) return true;
    }
    active.push(s);
  }
  return false;
}

/**
 * The bottom-most ancestor that owns an item's external layer.
 *
 * Two relations, walked as one chain: a note goes up to what it is stuck to, and
 * anything goes up to the fence around it. So a note on a photo inside a fence
 * roots at the fence, and the three change z together.
 *
 * This is the one place fences and sticky notes meet, and they have to. "Bring
 * this fence to front" means bring the region and what is in it, the same way it
 * means a photograph and the notes on it: a region that came forward and left its
 * cards behind other people's would have been taken apart by its own raise.
 *
 * It no longer has to keep the fence *under* its members - visualStackOrder()
 * puts every fence in a band below every card, so that is now true by
 * construction rather than by arrangement. It stays under them within the layer
 * as well, since raiseSelection() walks in raw z order and the fence is the
 * lowest thing in it, which is what keeps two nested fences in their own order.
 *
 * The `seen` guard is belt and braces: sticking requires a lower z and
 * containment requires a strictly larger area, so neither relation can cycle and
 * the pair cannot either. It costs one Set on a walk that is two steps deep.
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
  // Non-null: boardOrder was built from board.items and every item compared
  // here came out of the same list.
  const compare = (a: Item, b: Item) =>
    (a.z || 0) - (b.z || 0) || boardOrder.get(a.id)! - boardOrder.get(b.id)!;
  for (const group of groups.values()) group.items.sort(compare);
  return [...groups.values()].sort((a, b) => compare(a.root, b.root));
}
