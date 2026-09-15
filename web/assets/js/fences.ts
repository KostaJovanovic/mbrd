// Fence containment: which card is inside which fence, measured by centre.
// Parallel to sticky.ts but differs in predicate (centre vs area), layout
// (always Desktop geometry — Mobile dissolves containment), and resize
// (dragging a fence edge re-measures). The two meet only in stackRoot()
// and travelling(). Not merged because all four axes differ.

import { pointInItem } from './geometry.ts';
import { isRecord } from './util.ts';
import { board, byId, isFurniture, TITLE_ID } from './board-model.ts';
import type { Geometry, Item } from './board-model.ts';

/** A rectangle in world space, centred on x,y - an item's box or a fence's. */
type Box = { x: number, y: number, w: number, h: number, rot?: number };
/** The other spelling of a rectangle: two corners, as itemBounds() returns. */
type Bounds = { x0: number, y0: number, x1: number, y1: number };

/** An id and a box — what containment needs of an item. */
type Boxed = Box & { id: string };

/** A fence is an item like any other; this is the one thing that says so. */
// Generic so it narrows the type without widening to `never` in the false branch.
// isRecord() inside because callers pass items, drafts, and private box types.
export const isFence = <T>(it: T | null | undefined): it is T & { type: 'fence' } =>
  isRecord(it) && it.type === 'fence';

/** itemId -> fenceId or null. Null is a real answer — prevents re-measurement on every query. */
const fences = new Map<string, unknown>();

/**
 * The item's Desktop box for containment. Mobile renders membership but never
 * computes it — measuring there would dissolve every fence on layout switch.
 * Returns null when Mobile is live and no Desktop record exists yet.
 */
function desktopBox(it: Boxed | null | undefined): Box | null {
  if (!it) return null;
  if (board.layoutMode !== 'mobile') return it;
  const record = desktopIndex().get(it.id);
  return record ? { ...it, x: record.x, y: record.y, w: record.w, h: record.h, rot: record.rot || 0 } : null;
}

/** Desktop index cache. `from` is compared by identity for staleness, never read. */
type DesktopIndex = { from: Geometry[] | null, map: Map<string, Geometry> };

let desktopCache: DesktopIndex = { from: null, map: new Map() };

/**
 * Desktop layout as a Map, rebuilt when the backing array changes identity.
 * Indexed because measure() x stackRoot() would be O(n^3) with linear find().
 */
function desktopIndex() {
  const list = board.layouts?.desktop || [];
  if (desktopCache.from !== list) {
    desktopCache = { from: list, map: new Map(list.map(g => [g.id, g])) };
  }
  return desktopCache.map;
}

const areaOf = (box: Box | null | undefined) => Math.abs((box?.w || 0) * (box?.h || 0));

/**
 * The fence this item is inside, or null. Memoised — re-measuring on every query
 * would hoover up cards as a fence is dragged past them. Furniture is excluded.
 */
export function fenceOf(it: Boxed | null | undefined): Item | null {
  if (!it || isFurniture(it)) return null;
  if (fences.has(it.id)) {
    const id = fences.get(it.id);
    if (id === null) return null;
    // A seeded record from a file need not be a string.
    const fence = typeof id === 'string' ? byId(id) : undefined;
    // Fence deleted or undone — re-measure.
    if (fence && isFence(fence)) return fence;
    fences.delete(it.id);
  }
  const fence = measure(it);
  // Unmeasurable (no Desktop record) — leave memo alone.
  if (fence === undefined) return null;
  fences.set(it.id, fence ? fence.id : null);
  return fence;
}

/** Smallest containing fence, null for none, undefined for unmeasurable.
 *  Containment requires strictly greater area, so the chain is a strict order. */
function measure(it: Boxed): Item | null | undefined {
  // Early exit — most boards have no fences, and stackRoot() asks for every item.
  if (!board.items.some(isFence)) return null;
  const box = desktopBox(it);
  if (!box) return undefined;
  const nested = isFence(it);
  let best: Item | null = null;
  let bestArea = Infinity;
  for (const other of board.items) {
    if (!isFence(other) || other.id === it.id) continue;
    const rect = desktopBox(other);
    if (!rect) continue;
    const area = areaOf(rect);
    if (area >= bestArea) continue;
    if (nested && area <= areaOf(box)) continue;
    if (!pointInItem(box.x, box.y, rect)) continue;
    best = other;
    bestArea = area;
  }
  return best;
}

/**
 * Smallest fence at a world point, or null, among those `keep` accepts. Not
 * memoised — only called on menu open. Desktop only.
 */
export function fenceAt(x: number, y: number, keep?: (fence: Item) => boolean): Item | null {
  let best: Item | null = null;
  let bestArea = Infinity;
  for (const it of board.items) {
    if (!isFence(it) || (keep && !keep(it))) continue;
    const rect = desktopBox(it);
    if (!rect) continue;
    const area = areaOf(rect);
    if (area >= bestArea || !pointInItem(x, y, rect)) continue;
    best = it;
    bestArea = area;
  }
  return best;
}

/**
 * Clear memos for driven ids so the next query re-measures. Only for items the
 * gesture drove directly — followers carried by their fence must not re-parent.
 */
export function refence(ids: Iterable<string>) {
  for (const id of ids) fences.delete(id);
}


/**
 * Re-measure around any fence in the arriving items. Removal heals itself
 * (fenceOf re-measures on missing id), but arrival does not — cards hold a
 * remembered null that would survive. Desktop only.
 */
export function refenceArrivals(items: Item[] | null | undefined) {
  if (board.layoutMode === 'mobile') return;
  refenceAround((items || []).filter(isFence)
    .map(f => ({ x: f.x, y: f.y, w: f.w, h: f.h, rot: f.rot || 0 })));
}

/**
 * Clear memos for items inside any of the given boxes (old or new fence rects).
 * The union of both rectangles is exactly the set whose answer can have changed.
 */
export function refenceAround(boxes: (Box | null | undefined)[]) {
  const rects = boxes.filter((b): b is Box => !!b);
  if (!rects.length) return;
  for (const it of board.items) {
    if (isFurniture(it)) continue;
    const box = desktopBox(it);
    if (!box) continue;
    if (rects.some(rect => pointInItem(box.x, box.y, rect))) fences.delete(it.id);
  }
}

/**
 * Seed from meta.fence in the loaded board. A board opened on Mobile has no
 * Desktop geometry to measure, so the seed is the only membership source.
 */
export function seedFences() {
  fences.clear();
  // meta.fence from a file is untyped — check for furniture without assuming string.
  const furniture = new Set<unknown>([TITLE_ID]);
  for (const it of board.items) if (isFurniture(it)) furniture.add(it.id);
  for (const it of board.items) {
    if (isFurniture(it) || !it.meta || !('fence' in it.meta)) continue;
    const id = it.meta.fence ?? null;
    fences.set(it.id, id && !furniture.has(id) ? id : null);
  }
}

/** The items directly inside a fence, in board order. Not its nested contents. */
export function fenceMembers(fenceId: string) {
  return board.items.filter(it => fenceOf(it)?.id === fenceId);
}

/** Is this a fence rolled up to its name bar (meta.rolled)? */
export const isRolled = (it: Item | null | undefined) => isFence(it) && it.meta?.rolled === true;

/** The ids of every rolled-up fence. One walk, handed to rolledAway() per card. */
export function rolledFences(): Set<string> {
  return new Set(board.items.filter(isRolled).map(f => f.id));
}

/**
 * Is this item out of sight inside a rolled-up fence? The whole chain counts: a
 * card in a fence inside a rolled one is folded away with it. The rolled fence
 * itself is not, since its bar is what is left to press. Desktop geometry, as
 * every containment answer here is.
 */
export function rolledAway(it: Boxed | null | undefined, rolled: Set<string> = rolledFences()): boolean {
  if (!it || !rolled.size) return false;
  let fence = fenceOf(it);
  // Bounded: containment is a strict order by area, so the chain cannot loop.
  for (let depth = 0; fence && depth < 64; depth++) {
    if (rolled.has(fence.id)) return true;
    fence = fenceOf(fence);
  }
  return false;
}

/**
 * Mobile column as ordered runs: `{ band, items }[]`, for the Mobile layout and
 * the Feed alike. A fence's run ranks where its earliest member does, so fence
 * runs and runs of loose cards interleave in the arrangement's order: loose
 * cards, a fence, more loose cards, another fence. No fence goes first and no
 * loose card goes last (research/todo-2026-09-14.md). Nesting flattens into
 * subsections. Membership is read via byId() against Desktop geometry, not the
 * fitted copies the caller passes.
 */
export function mobileRuns(items: Item[]): { band: Item | null, items: Item[] }[] {
  const rank = new Map(items.map((it, index) => [it.id, index]));
  const kids = new Map<string, Item[]>(items.filter(isFence).map(f => [f.id, []]));
  const roots: Item[] = [];
  for (const it of items) {
    const parent = fenceOf(byId(it.id) || it);
    // Non-null: guarded by has() on the same line, and nothing deletes from it.
    (parent && kids.has(parent.id) ? kids.get(parent.id)! : roots).push(it);
  }
  // Memoised — the walk is called once per comparison and would re-walk subtrees.
  const ranks = new Map<string, number>();
  const rankOf = (it: Item): number => {
    if (ranks.has(it.id)) return ranks.get(it.id)!; // Non-null: guarded by has()
    let best = rank.get(it.id) ?? 0;
    ranks.set(it.id, best);  // breaks cycles before recursion
    for (const kid of kids.get(it.id) || []) best = Math.min(best, rankOf(kid));
    ranks.set(it.id, best);
    return best;
  };
  const runs: { band: Item | null, items: Item[] }[] = [];
  const emit = (fence: Item) => {
    const members = kids.get(fence.id) || [];
    runs.push({ band: fence, items: members.filter(m => !isFence(m)) });
    for (const it of members.filter(isFence).sort((a, b) => rankOf(a) - rankOf(b))) emit(it);
  };
  // Stable sort: loose cards keep the order handed in among themselves.
  let loose: Item[] = [];
  for (const it of [...roots].sort((a, b) => rankOf(a) - rankOf(b))) {
    if (!isFence(it)) { loose.push(it); continue; }
    if (loose.length) runs.push({ band: null, items: loose });
    loose = [];
    emit(it);
  }
  if (loose.length || !runs.length) runs.push({ band: null, items: loose });
  return runs;
}

/** The stem every unnamed fence is given, numbered. */
const FENCE_NAME = 'Untitled fence';

/** Next default fence name. One past the highest in use — filling gaps would reuse old names. */
export function nextFenceName() {
  const numbered = new RegExp(`^${FENCE_NAME} (\\d+)$`, 'i');
  let top = 0;
  for (const it of board.items) {
    if (!isFence(it)) continue;
    const found = numbered.exec((it.name || '').trim());
    if (found) top = Math.max(top, +found[1]);
  }
  return `${FENCE_NAME} ${top + 1}`;
}

/**
 * Rectangle for a new fence from a drawn rect, item bounds, or both.
 * Union of both boxes (items get padding) so the fence starts containing its contents
 * even when the marquee caught items poking past its edges.
 */
export function fenceBox(rect: Bounds | null | undefined, bounds: Bounds | null | undefined, pad: number) {
  const boxes: Bounds[] = [];
  if (rect) boxes.push(rect);
  if (bounds) {
    boxes.push({
      x0: bounds.x0 - pad, y0: bounds.y0 - pad,
      x1: bounds.x1 + pad, y1: bounds.y1 + pad,
    });
  }
  if (!boxes.length) return null;
  const x0 = Math.min(...boxes.map(b => b.x0));
  const y0 = Math.min(...boxes.map(b => b.y0));
  const x1 = Math.max(...boxes.map(b => b.x1));
  const y1 = Math.max(...boxes.map(b => b.y1));
  return { x: (x0 + x1) / 2, y: (y0 + y1) / 2, w: x1 - x0, h: y1 - y0 };
}

/**
 * Transitive followers: items inside any fence being moved. One-way — dragging
 * a card does not tow its fence. Items already in `ids` are excluded to avoid
 * fighting a marquee that caught both a fence and its contents.
 */
export function fenceFollowers(ids: Iterable<string>) {
  const moving = new Set(ids);
  const pool = board.items.filter(it => !moving.has(it.id) && !isFurniture(it));
  const out: string[] = [];
  // Iterative passes — a card joins only after its containing fence has joined.
  for (let grew = true; grew;) {
    grew = false;
    for (let n = pool.length - 1; n >= 0; n--) {
      const fence = fenceOf(pool[n]);
      if (!fence || !moving.has(fence.id)) continue;
      moving.add(pool[n].id);
      out.push(pool[n].id);
      pool.splice(n, 1);
      grew = true;
    }
  }
  return out;
}
