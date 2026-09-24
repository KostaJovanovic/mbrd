// Coarse uniform grid over world space for spatial queries. Turns "which items
// are near the screen" from O(board) into O(nearby) by bucketing ids into square
// cells. Returns a superset — the caller re-tests against the true rectangle.
// No imports from state or DOM; vocabulary is a box {id, x, y, w, h} and a rect.

/** Cell edge in world units. ~512 puts a viewport across a few cells and a
 * typical card inside 1–4. Not delicate — anything of this order behaves the same. */
const DEFAULT_CELL = 512;

/** A box in the index: item id and its centre-and-full-size footprint. */
export type SpatialBox = { id: string; x: number; y: number; w: number; h: number };

/** A world rectangle to query with, as two opposite corners. */
export type SpatialRect = { x0: number; y0: number; x1: number; y1: number };

let cell = DEFAULT_CELL;
/** cellKey -> Set<id>. A cell with no members is deleted, not left empty. */
const cells = new Map<string, Set<string>>();
/** id -> the cell keys it currently occupies, so update/remove are cheap. */
const placed = new Map<string, string[]>();

const keyOf = (cx: number, cy: number) => cx + ',' + cy;
const cellIndex = (v: number) => Math.floor(v / cell);

/** Max cells per item. A corrupt .mbrd with huge dimensions would loop ~10^13
 * times without this. Past the cap, the item goes in `huge` instead. */
const MAX_CELLS = 1024;

/** Ids too big (or too broken) to file by cell. Every query returns them: a
 * corner cell alone made the middle of a legal 12000-unit card unfindable. */
const huge = new Set<string>();

/** The cell keys a centre-and-size box overlaps, one per cell it touches, or
 * null when the box belongs in `huge`. */
function cellsFor(box: SpatialBox): string[] | null {
  const cx0 = cellIndex(box.x - box.w / 2);
  const cx1 = cellIndex(box.x + box.w / 2);
  const cy0 = cellIndex(box.y - box.h / 2);
  const cy1 = cellIndex(box.y + box.h / 2);
  // Negated so a NaN count lands here too rather than in an empty loop.
  if (!((cx1 - cx0 + 1) * (cy1 - cy0 + 1) <= MAX_CELLS)) return null;
  const keys = [];
  for (let cx = cx0; cx <= cx1; cx++)
    for (let cy = cy0; cy <= cy1; cy++) keys.push(keyOf(cx, cy));
  return keys;
}

/** Drop an id from every cell it was in. Safe to call for an unknown id. */
export function remove(id: string): void {
  huge.delete(id);
  const keys = placed.get(id);
  if (!keys) return;
  for (const k of keys) {
    const set = cells.get(k);
    if (!set) continue;
    set.delete(id);
    if (!set.size) cells.delete(k);
  }
  placed.delete(id);
}

/** Register or re-register a box. Idempotent (remove + re-add). Null box = remove. */
export function update(id: string, box: SpatialBox | null | undefined): void {
  remove(id);
  if (!box) return;
  const keys = cellsFor(box);
  if (!keys) { huge.add(id); return; }
  for (const k of keys) {
    let set = cells.get(k);
    if (!set) cells.set(k, set = new Set<string>());
    set.add(id);
  }
  placed.set(id, keys);
}

/** Throw the whole index away and rebuild it from a fresh list of boxes. */
export function rebuild(boxes: Iterable<SpatialBox>, cellSize = DEFAULT_CELL): void {
  cell = cellSize;
  cells.clear();
  placed.clear();
  huge.clear();
  for (const box of boxes) update(box.id, box);
}

/** Ids whose cells overlap a world rectangle. A superset — caller must re-test
 * precisely. Deduped: multi-cell items come back once. */
export function queryRect(rect: SpatialRect): Set<string> {
  const out = new Set<string>(huge);
  const cx0 = cellIndex(rect.x0);
  const cx1 = cellIndex(rect.x1);
  const cy0 = cellIndex(rect.y0);
  const cy1 = cellIndex(rect.y1);
  for (let cx = cx0; cx <= cx1; cx++)
    for (let cy = cy0; cy <= cy1; cy++) {
      const set = cells.get(keyOf(cx, cy));
      if (set) for (const id of set) out.add(id);
    }
  return out;
}

/** Ids near a centre-and-size box at any rotation: the query is the square
 * around the box's circumscribed circle. A superset, as queryRect() is. */
export function queryAround(box: { x: number; y: number; w: number; h: number }): Set<string> {
  const r = Math.hypot(box.w, box.h) / 2;
  return queryRect({ x0: box.x - r, y0: box.y - r, x1: box.x + r, y1: box.y + r });
}
