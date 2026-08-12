// A coarse uniform grid over world space, so "which items are near the screen"
// stops being a walk over the whole board.
//
// Culling has to answer that question every frame the view moves, and it used to
// answer it the only way it could without an index: by testing every item in
// board.items against the viewport rectangle. That is fine at a hundred items
// and a real cost at two thousand - the scan is O(board), redone whenever the
// visible rectangle leaves what the last scan covered, which on a zoom is every
// frame. This turns it into O(items near the viewport) by bucketing item ids
// into square cells and visiting only the cells the padded viewport overlaps.
//
// It is deliberately the bottom of the layering: it imports neither state nor the
// DOM and knows nothing about what an item *is*. Its whole vocabulary is a box -
// `{ id, x, y, w, h }`, centre and full size, the same sense item geometry uses -
// and a query rectangle. The caller decides what a box means (canvas/items.js
// hands it a circumscribed square so a rotated card is registered by the corner
// it actually reaches, not its unrotated footprint) and re-tests the handful the
// query returns against the true rectangle. The grid only narrows the field; it
// never claims to be exact, and a cell shared with the viewport is enough to be
// returned. That is why the query dedupes - a box spanning four cells is listed
// in all four - and why a false positive here costs one precise test there, not
// a missing card.

/**
 * Cell edge in world units.
 *
 * The one number to tune. Too small and a large item is registered in a great
 * many cells and every rebuild walks them all; too large and the query drags in
 * most of the board and buys nothing. A few hundred world units puts a typical
 * viewport across a handful of cells and a typical card inside one or four,
 * which is the balance this is after. It is not delicate - anything of this
 * order behaves the same - and rebuild() can override it per board if a future
 * caller wants to scale it to the item size in play.
 */
const DEFAULT_CELL = 512;

/**
 * A box in the index: an item id and its centre-and-full-size footprint. The
 * whole vocabulary of this module - see the header on what the caller owes.
 */
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

/** The cell keys a centre-and-size box overlaps, one per cell it touches. */
function cellsFor(box: SpatialBox): string[] {
  const cx0 = cellIndex(box.x - box.w / 2);
  const cx1 = cellIndex(box.x + box.w / 2);
  const cy0 = cellIndex(box.y - box.h / 2);
  const cy1 = cellIndex(box.y + box.h / 2);
  const keys = [];
  for (let cx = cx0; cx <= cx1; cx++)
    for (let cy = cy0; cy <= cy1; cy++) keys.push(keyOf(cx, cy));
  return keys;
}

/** Drop an id from every cell it was in. Safe to call for an unknown id. */
export function remove(id: string): void {
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

/**
 * Register (or re-register) one box under its id.
 *
 * Idempotent by way of remove() first, so the geom path can call it per moved id
 * without tracking whether the item was indexed before. A null box just removes.
 */
export function update(id: string, box: SpatialBox | null | undefined): void {
  remove(id);
  if (!box) return;
  const keys = cellsFor(box);
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
  for (const box of boxes) update(box.id, box);
}

/**
 * The ids whose cells overlap a world rectangle `{ x0, y0, x1, y1 }`.
 *
 * A superset of what actually intersects the rectangle - every returned id is
 * near it, but the caller still owes a precise test, because a cell is wider than
 * the rectangle's edge. Deduped: an id listed in several of the visited cells
 * comes back once.
 */
export function queryRect(rect: SpatialRect): Set<string> {
  const out = new Set<string>();
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
