// Pure geometry: point-in-item, bounding boxes, rotation-aware hit testing.
// Convention: centre (x,y), size (w,h), rotation `rot` in degrees (CCW, +y up).
// Structural types (Box, Point, Bounds) — no board-model import, stays at
// graph bottom. Consolidated from four inconsistent copies across the codebase.

/** A point in whatever space the caller is working in. */
export type Point = { x: number, y: number };

/** A size, and the rotation it is drawn at. Absent `rot` is none. */
export type Size = { w: number, h: number, rot?: number };

/** A box about its centre: the convention above, entire. */
export type Box = Point & Size;

/** A rectangle as two corners, low and high on each axis. */
export type Bounds = { x0: number, y0: number, x1: number, y1: number };

/** Where one item is being asked to move to - what applyGeom() merges. */
export type Target = { id: string, x: number, y: number };

/** A viewport transform, in the sense viewport.ts's toScreen() uses it. */
export type View = { pan: Point, zoom: number };

const RAD = Math.PI / 180;

// 48: resize grips overlap below this. 20000: ~100 default cards wide.
export const MIN_SIZE = 48;
export const MAX_SIZE = 20000;

// A card's floor on the grid: three cells across, two down. Held as cell
// counts, not pixels, so the floor tracks the board's step rather than a
// fixed size. Applied at resize in canvas/input.ts; the text- and mark-shaped
// items (notes, text, titles, swatches, stickers) are exempt there.
export const CARD_FLOOR_CELLS = { w: 3, h: 2 } as const;

/** Inset per side so snapped items have a visible seam. 4% of step, on all four sides. */
export const CELL_GAP = 0.04;

/** The seam itself, in world units, for a given cell size. */
export const cellInset = (step: number) => step * CELL_GAP;

/** A low edge on the lattice: nearest grid line + seam inset. */
export const latticeLow = (v: number, step: number) => {
  const inset = cellInset(step);
  return Math.round((v - inset) / step) * step + inset;
};

/** A side snapped to whole cells minus seam insets. Clamped to [MIN_SIZE, MAX_SIZE]. */
export const latticeSide = (v: number, step: number) => {
  const gap = 2 * cellInset(step);
  const cells = Math.max(Math.round((v + gap) / step), 1);
  return Math.min(Math.max(cells * step - gap, MIN_SIZE), MAX_SIZE);
};

/** A box snapped to the lattice (position and size). */
export function latticeBox(box: Box, step: number) {
  const w = latticeSide(box.w, step), h = latticeSide(box.h, step);
  return {
    x: latticeLow(box.x - box.w / 2, step) + w / 2,
    y: latticeLow(box.y - box.h / 2, step) + h / 2,
    w, h,
  };
}

/** Half-extents of the AABB around a rotated item. At rot=0, just (w/2, h/2). */
export function rotatedExtents(it: Size) {
  const rot = it.rot || 0;
  if (!rot) return { hw: it.w / 2, hh: it.h / 2 };
  const rad = rot * RAD;
  const c = Math.abs(Math.cos(rad));
  const s = Math.abs(Math.sin(rad));
  return {
    hw: (it.w * c + it.h * s) / 2,
    hh: (it.w * s + it.h * c) / 2,
  };
}

/** Rotation-aware AABB around a set of items, or null for empty. */
export function itemBounds(items: Iterable<Box>): Bounds | null {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  let any = false;
  for (const it of items) {
    const { hw, hh } = rotatedExtents(it);
    if (it.x - hw < x0) x0 = it.x - hw;
    if (it.x + hw > x1) x1 = it.x + hw;
    if (it.y - hh < y0) y0 = it.y - hh;
    if (it.y + hh > y1) y1 = it.y + hh;
    any = true;
  }
  return any ? { x0, y0, x1, y1 } : null;
}

/** Does an item's AABB overlap a world-space rect? Forgiving (same approx as Fit). */
export function itemInRect(it: Box, x0: number, y0: number, x1: number, y1: number) {
  const { hw, hh } = rotatedExtents(it);
  return it.x + hw >= x0 && it.x - hw <= x1 &&
         it.y + hh >= y0 && it.y - hh <= y1;
}

/** Is the item's AABB fully inside the rect? For fences — overlap would always catch them. */
export function itemWithinRect(it: Box, x0: number, y0: number, x1: number, y1: number) {
  const { hw, hh } = rotatedExtents(it);
  return it.x - hw >= x0 && it.x + hw <= x1 &&
         it.y - hh >= y0 && it.y + hh <= y1;
}

// Cohen-Sutherland outcodes for segment-rect clipping.
const OUT_LEFT = 1, OUT_RIGHT = 2, OUT_BELOW = 4, OUT_ABOVE = 8;

const outcode = (x: number, y: number, r: Bounds) =>
  (x < r.x0 ? OUT_LEFT : x > r.x1 ? OUT_RIGHT : 0) |
  (y < r.y0 ? OUT_BELOW : y > r.y1 ? OUT_ABOVE : 0);

/** Exact segment-rect intersection (Cohen-Sutherland clip, stopped early). */
export function segmentMeetsRect(a: Point, b: Point, r: Bounds) {
  let x0 = a.x, y0 = a.y, x1 = b.x, y1 = b.y;
  let c0 = outcode(x0, y0, r), c1 = outcode(x1, y1, r);
  for (;;) {
    if (!(c0 | c1)) return true;
    if (c0 & c1) return false;
    const out = c0 || c1;
    let x, y;
    if (out & OUT_ABOVE)      { x = x0 + (x1 - x0) * (r.y1 - y0) / (y1 - y0); y = r.y1; }
    else if (out & OUT_BELOW) { x = x0 + (x1 - x0) * (r.y0 - y0) / (y1 - y0); y = r.y0; }
    else if (out & OUT_RIGHT) { y = y0 + (y1 - y0) * (r.x1 - x0) / (x1 - x0); x = r.x1; }
    else                      { y = y0 + (y1 - y0) * (r.x0 - x0) / (x1 - x0); x = r.x0; }
    if (out === c0) { x0 = x; y0 = y; c0 = outcode(x0, y0, r); }
    else            { x1 = x; y1 = y; c1 = outcode(x1, y1, r); }
  }
}

// === Polylines ===

/** The point half way along a polyline by arc length - where a label sits. */
export function polyMidpoint(points: Point[] | null | undefined): Point {
  if (!points || points.length < 2) return points?.[0] || { x: 0, y: 0 };
  const legs: number[] = [];
  let total = 0;
  for (let i = 1; i < points.length; i++) {
    const len = Math.hypot(points[i].x - points[i - 1].x, points[i].y - points[i - 1].y);
    legs.push(len);
    total += len;
  }
  let half = total / 2;
  for (let i = 1; i < points.length; i++) {
    const len = legs[i - 1];
    if (half <= len) {
      const t = len ? half / len : 0;
      return {
        x: points[i - 1].x + (points[i].x - points[i - 1].x) * t,
        y: points[i - 1].y + (points[i].y - points[i - 1].y) * t,
      };
    }
    half -= len;
  }
  return points[points.length - 1];
}

/** Does any leg of a polyline meet the rect? Per-leg, not bounding-box (long lines would always pass). */
export function polyMeetsRect(points: Point[], rect: Bounds) {
  for (let i = 1; i < points.length; i++) {
    if (segmentMeetsRect(points[i - 1], points[i], rect)) return true;
  }
  return false;
}

/** Distance from point (px, py) to the segment a-b, in whatever space they share. */
export function distToSegment(px: number, py: number, a: Point, b: Point) {
  const dx = b.x - a.x, dy = b.y - a.y;
  const len2 = dx * dx + dy * dy;
  const t = len2 ? Math.max(0, Math.min(1, ((px - a.x) * dx + (py - a.y) * dy) / len2)) : 0;
  const cx = a.x + t * dx, cy = a.y + t * dy;
  return Math.hypot(px - cx, py - cy);
}

/** Squared distance between two points. Squared on purpose — callers only compare, never need sqrt. */
export function distSq(a: Point, b: Point) {
  const dx = a.x - b.x, dy = a.y - b.y;
  return dx * dx + dy * dy;
}

/** Squared distance from a point to the midpoint of a segment. Used to sort obstacles for the router. */
export function distSqToMidpoint(p: Point, from: Point, to: Point) {
  const mx = (from.x + to.x) / 2;
  const my = (from.y + to.y) / 2;
  return (p.x - mx) ** 2 + (p.y - my) ** 2;
}

/** Half-diagonal — circumscribed circle radius. No trig, used by the culler every frame. */
export function itemRadius(it: Size) {
  return Math.sqrt(it.w * it.w + it.h * it.h) / 2;
}

/** Point-in-item test, rotation-aware (tested in the item's own frame). */
export function pointInItem(px: number, py: number, it: Box) {
  const dx = px - it.x, dy = py - it.y;
  // Cheap reject — circumscribed circle test, no trig.
  if (dx * dx + dy * dy > (it.w * it.w + it.h * it.h) / 4) return false;
  if (!it.rot) return Math.abs(dx) <= it.w / 2 && Math.abs(dy) <= it.h / 2;
  // Undo rotation: matrix with swapped sine signs.
  const rad = it.rot * RAD;
  const c = Math.cos(rad), s = Math.sin(rad);
  return Math.abs(c * dx + s * dy) <= it.w / 2 &&
         Math.abs(c * dy - s * dx) <= it.h / 2;
}

/** An item's four corners, in world coordinates, anticlockwise. */
export function corners(it: Box): Point[] {
  const rad = (it.rot || 0) * RAD;
  const c = Math.cos(rad), s = Math.sin(rad);
  const hw = it.w / 2, hh = it.h / 2;
  const at = (u: number, v: number) => ({ x: it.x + c * u - s * v, y: it.y + s * u + c * v });
  return [at(-hw, -hh), at(hw, -hh), at(hw, hh), at(-hw, hh)];
}

/** Twice the signed area of a polygon. Positive when it winds anticlockwise. */
function shoelace2(poly: Point[]) {
  let sum = 0;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    sum += poly[j].x * poly[i].y - poly[i].x * poly[j].y;
  }
  return sum;
}

/** Fraction of `a` overlapping `b` ([0,1]). Exact Sutherland-Hodgman clip, rotation-aware. */
export function overlapFraction(a: Box, b: Box) {
  const areaA = a.w * a.h;
  if (!(areaA > 0) || !(b.w * b.h > 0)) return 0;
  // Cheap reject — circumscribed circles miss.
  const dx = a.x - b.x, dy = a.y - b.y;
  const reach = itemRadius(a) + itemRadius(b);
  if (dx * dx + dy * dy > reach * reach) return 0;

  let poly = corners(a);
  const bs = corners(b);
  for (let i = 0, j = bs.length - 1; i < bs.length; j = i++) {
    if (!poly.length) return 0;
    // Left of directed edge j->i (corners() winds CCW).
    const ex = bs[i].x - bs[j].x, ey = bs[i].y - bs[j].y;
    const side = (p: Point) => ex * (p.y - bs[j].y) - ey * (p.x - bs[j].x);
    const next: Point[] = [];
    for (let k = 0, m = poly.length - 1; k < poly.length; m = k++) {
      const cur = poly[k], prev = poly[m];
      const dCur = side(cur), dPrev = side(prev);
      if (dCur >= 0) {
        // Crossing in: add the intersection first, then the point itself.
        if (dPrev < 0) {
          const t = dPrev / (dPrev - dCur);
          next.push({ x: prev.x + (cur.x - prev.x) * t, y: prev.y + (cur.y - prev.y) * t });
        }
        next.push(cur);
      } else if (dPrev >= 0) {
        const t = dPrev / (dPrev - dCur);
        next.push({ x: prev.x + (cur.x - prev.x) * t, y: prev.y + (cur.y - prev.y) * t });
      }
    }
    poly = next;
  }
  if (poly.length < 3) return 0;
  const frac = Math.abs(shoelace2(poly)) / 2 / areaA;
  // Clamp — floating point can produce slightly >1.
  return frac > 1 ? 1 : frac;
}

/**
 * Max screen-pixel displacement between two views over `rect`. Exact — the
 * mapping is affine, so corners bound the whole frame. Used by the grid to
 * skip repaints when a view change moved nothing by even one device pixel.
 */
export function viewShift(prev: View, next: View, rect: Bounds) {
  let worst = 0;
  for (const wx of [rect.x0, rect.x1]) {
    for (const wy of [rect.y0, rect.y1]) {
      const dx = (wx - next.pan.x) * next.zoom - (wx - prev.pan.x) * prev.zoom;
      const dy = (next.pan.y - wy) * next.zoom - (prev.pan.y - wy) * prev.zoom;
      worst = Math.max(worst, Math.abs(dx), Math.abs(dy));
    }
  }
  return worst;
}

/** The two ends of an item's top edge, in world coordinates (+y is up). */
export function topEdge(it: Box): Point[] {
  const rad = (it.rot || 0) * RAD;
  const c = Math.cos(rad), s = Math.sin(rad);
  const hw = it.w / 2, hh = it.h / 2;
  return [
    { x: it.x - c * hw - s * hh, y: it.y - s * hw + c * hh },
    { x: it.x + c * hw - s * hh, y: it.y + s * hw + c * hh },
  ];
}

/** Align items to a shared edge or centre. Rotation-aware. Returns targets for applyGeom. */
export function alignTargets(items: (Box & { id: string })[], edge: string): Target[] {
  const b = itemBounds(items);
  if (!b) return [];
  return items.map(it => {
    const { hw, hh } = rotatedExtents(it);
    let { x, y } = it;
    switch (edge) {
      case 'left':    x = b.x0 + hw; break;
      case 'right':   x = b.x1 - hw; break;
      case 'hcenter': x = (b.x0 + b.x1) / 2; break;
      case 'top':     y = b.y1 - hh; break;
      case 'bottom':  y = b.y0 + hh; break;
      case 'vcenter': y = (b.y0 + b.y1) / 2; break;
    }
    return { id: it.id, x, y };
  });
}

/** Distribute items evenly along an axis (equal visible gaps). Rotation-aware. */
export function distributeTargets(items: (Box & { id: string })[], axis: string): Target[] {
  if (items.length < 3) return [];
  const half = (it: Box) => (axis === 'x' ? rotatedExtents(it).hw : rotatedExtents(it).hh);
  const pos = (it: Box) => (axis === 'x' ? it.x : it.y);
  const sorted = [...items].sort((a, b) => pos(a) - pos(b));
  const first = sorted[0], last = sorted[sorted.length - 1];
  const lead = pos(first) + half(first);          // trailing edge of the first
  const tail = pos(last) - half(last);            // leading edge of the last
  let span = tail - lead;
  for (let i = 1; i < sorted.length - 1; i++) span -= 2 * half(sorted[i]);
  const gap = span / (sorted.length - 1);
  const out: Target[] = [];
  let cursor = lead;
  for (let i = 1; i < sorted.length - 1; i++) {
    const it = sorted[i];
    const h = half(it);
    const centre = cursor + gap + h;
    cursor = centre + h;
    out.push(axis === 'x'
      ? { id: it.id, x: centre, y: it.y }
      : { id: it.id, x: it.x, y: centre });
  }
  return out;
}

/**
 * Push overlapping items apart along `axis`, preserving order and group centre.
 * Used after alignment to prevent collisions on the cross axis.
 */
export function separateOverlaps(targets: Target[], items: (Box & { id: string })[], axis: string, gap = 0): Target[] {
  if (targets.length < 2) return targets;
  const byId = new Map(items.map(it => [it.id, it]));
  const rows = targets.map(t => {
    const it = byId.get(t.id) || { w: 0, h: 0 };
    const { hw, hh } = rotatedExtents(it);
    return { t, half: axis === 'x' ? hw : hh, pos: axis === 'x' ? t.x : t.y };
  });
  const origLo = Math.min(...rows.map(r => r.pos - r.half));
  const origHi = Math.max(...rows.map(r => r.pos + r.half));
  const order = [...rows].sort((a, b) => a.pos - b.pos);
  let prevEdge = -Infinity;
  for (const r of order) {
    const min = prevEdge + gap + r.half;
    if (r.pos < min) r.pos = min;
    prevEdge = r.pos + r.half;
  }
  const newLo = order[0].pos - order[0].half;
  const newHi = order[order.length - 1].pos + order[order.length - 1].half;
  const shift = (origLo + origHi) / 2 - (newLo + newHi) / 2;
  return rows.map(r => ({
    ...r.t,
    ...(axis === 'x' ? { x: r.pos + shift } : { y: r.pos + shift }),
  }));
}
