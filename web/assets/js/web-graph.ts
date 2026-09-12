// Generates non-crossing threads between cards: Euclidean MST first (one
// connected piece, no crossings), then shortest remaining candidates that
// still fit. A generator, not the drawing — canvas/web.ts renders.
// Pure: no DOM, no state. Rule: **no two threads may cross.**

import { corners, pointInItem, distSq } from './geometry.ts';
import { clamp } from './util.ts';

/** A card centre, optionally with box. Tests hand in bare centres (no w/h). */
type WebPoint = { x: number, y: number, w?: number, h?: number, rot?: number };

/** A thread, as a pair of indices into the point list it was worked out over. */
type Edge = [number, number];

/** k-nearest candidates per point. Limits the cubic pass to quadratic. */
const NEIGHBOURS = 14;

/** Past this, only the spanning tree runs (still connected, just sparser). */
const DENSE_LIMIT = 5600;

/** Every non-crossing thread, as index pairs into `pts`. */
export function threads(pts: WebPoint[]): Edge[] {
  const n = pts.length;
  // n=0 would make k=-1 → RangeError in Float64Array.
  if (!n) return [];
  const edges = spanningTree(pts);
  if (n > DENSE_LIMIT) return edges;

  const taken = new Set(edges.map(([a, b]) => pair(a, b, n)));
  const k = Math.min(NEIGHBOURS, n - 1);
  const candidates: [number, number, number][] = [];
  const seen = new Set();

  // k-nearest via insertion sort into fixed buffers — avoids n*(n-1) temp arrays.
  const bestD = new Float64Array(k);
  const bestJ = new Int32Array(k);
  for (let i = 0; i < n; i++) {
    const p = pts[i];
    let filled = 0;
    for (let j = 0; j < n; j++) {
      if (j === i) continue;
      const q = pts[j];
      const dx = p.x - q.x, dy = p.y - q.y;
      const d = dx * dx + dy * dy;
      // Already have k closer neighbours.
      if (filled === k && d >= bestD[k - 1]) continue;
      let m = filled < k ? filled++ : k - 1;
      while (m > 0 && bestD[m - 1] > d) {
        bestD[m] = bestD[m - 1]; bestJ[m] = bestJ[m - 1]; m--;
      }
      bestD[m] = d; bestJ[m] = j;
    }
    for (let m = 0; m < filled; m++) {
      const j = bestJ[m];
      const id = pair(i, j, n);
      if (taken.has(id) || seen.has(id)) continue;
      seen.add(id);
      candidates.push([bestD[m], Math.min(i, j), Math.max(i, j)]);
    }
  }
  candidates.sort((x, y) => x[0] - y[0]);

  // Grid so each candidate tests only nearby accepted threads.
  const grid = new EdgeGrid(pts);
  for (const [a, b] of edges) grid.add(a, b);

  // Extra threads (not tree edges) are refused if they cross any card body.
  const cards = new CardGrid(pts);

  for (const [, a, b] of candidates) {
    if (grid.blocks(pts[a], pts[b])) continue;
    if (cards.blocks(pts[a], pts[b], a, b)) continue;
    edges.push([a, b]);
    grid.add(a, b);
    taken.add(pair(a, b, n));
  }

  return edges;
}

export const pair = (a: number, b: number, n: number) => (a < b ? a * n + b : b * n + a);

/** Max cells an edge registers in. Past this, the edge goes into `wide` (checked by all). */
const MAX_CELLS_PER_EDGE = 32;

class EdgeGrid {
  // `declare` — assigned in constructor; avoids a second write from initialisers.
  declare pts: WebPoint[];
  declare ea: number[];
  declare eb: number[];
  declare marks: number[];
  declare cells: Map<number, number[]>;
  declare wide: number[];
  declare minX: number;
  declare minY: number;
  declare gw: number;
  declare gh: number;
  declare cw: number;
  declare ch: number;

  constructor(pts: WebPoint[]) {
    this.pts = pts;
    // Edges live here as two flat arrays; the buckets hold indices into them.
    // An index makes the visited stamp below cheap - marking the edge itself
    // would hang a property on an array and drop it out of the fast
    // representation.
    this.ea = [];
    this.eb = [];
    this.marks = [];
    this.cells = new Map();
    this.wide = [];

    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (const p of pts) {
      if (p.x < minX) minX = p.x;
      if (p.y < minY) minY = p.y;
      if (p.x > maxX) maxX = p.x;
      if (p.y > maxY) maxY = p.y;
    }
    this.minX = minX;
    this.minY = minY;

    // ~1 cell per point: fewer → everything in one bucket, finer → registration cost.
    const side = Math.max(1, Math.round(Math.sqrt(pts.length)));
    this.gw = side;
    this.gh = side;
    this.cw = Math.max((maxX - minX) / side, 1e-6);
    this.ch = Math.max((maxY - minY) / side, 1e-6);
  }

  _col(x: number) { return clamp(Math.floor((x - this.minX) / this.cw), 0, this.gw - 1); }
  _row(y: number) { return clamp(Math.floor((y - this.minY) / this.ch), 0, this.gh - 1); }

  add(ai: number, bi: number) {
    const i = this.ea.length;
    this.ea.push(ai);
    this.eb.push(bi);
    this.marks.push(0);
    const a = this.pts[ai], b = this.pts[bi];
    const c0 = this._col(Math.min(a.x, b.x)), c1 = this._col(Math.max(a.x, b.x));
    const r0 = this._row(Math.min(a.y, b.y)), r1 = this._row(Math.max(a.y, b.y));
    if ((c1 - c0 + 1) * (r1 - r0 + 1) > MAX_CELLS_PER_EDGE) { this.wide.push(i); return; }
    for (let c = c0; c <= c1; c++) {
      for (let r = r0; r <= r1; r++) {
        const key = c * this.gh + r;
        const bucket = this.cells.get(key);
        if (bucket) bucket.push(i); else this.cells.set(key, [i]);
      }
    }
  }

  /** Does any accepted thread cross AB? */
  blocks(a: WebPoint, b: WebPoint) {
    const { pts, ea, eb, marks } = this;
    for (const i of this.wide) {
      if (crosses(a, b, pts[ea[i]], pts[eb[i]])) return true;
    }
    const c0 = this._col(Math.min(a.x, b.x)), c1 = this._col(Math.max(a.x, b.x));
    const r0 = this._row(Math.min(a.y, b.y)), r1 = this._row(Math.max(a.y, b.y));
    // Stamp to skip threads listed in multiple cells (cheaper than a Set).
    const stamp = ++mark;
    for (let c = c0; c <= c1; c++) {
      for (let r = r0; r <= r1; r++) {
        const bucket = this.cells.get(c * this.gh + r);
        if (!bucket) continue;
        for (const i of bucket) {
          if (marks[i] === stamp) continue;
          marks[i] = stamp;
          if (crosses(a, b, pts[ea[i]], pts[eb[i]])) return true;
        }
      }
    }
    return false;
  }
}

/** Cards bucketed like EdgeGrid. A thread crossing a card body (not its own endpoints) is refused. */
class CardGrid {
  // `declare` — assigned in constructor.
  declare idx: number[];
  declare quads: { x: number, y: number }[][];
  declare items: { x: number, y: number, w: number, h: number, rot: number }[];
  declare bx0: number[];
  declare by0: number[];
  declare bx1: number[];
  declare by1: number[];
  declare marks: number[];
  declare cells: Map<number, number[]>;
  declare wide: number[];
  declare n: number;
  declare minX: number;
  declare minY: number;
  declare gw: number;
  declare gh: number;
  declare cw: number;
  declare ch: number;

  constructor(pts: WebPoint[]) {
    this.idx = [];       // pts index of each card, to skip a thread's own two
    this.quads = [];     // four corners each, in web space
    this.items = [];     // {x,y,w,h,rot} for the point-inside test
    this.bx0 = []; this.by0 = []; this.bx1 = []; this.by1 = [];  // card boxes
    this.marks = [];
    this.cells = new Map();
    this.wide = [];

    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (let i = 0; i < pts.length; i++) {
      const p = pts[i];
      // `?? 0` lets sizeless points pass without changing the comparison result.
      if (!((p.w ?? 0) > 0) || !((p.h ?? 0) > 0)) continue;
      // Non-null: positive w/h guard above; tsc can't narrow it.
      const item = { x: p.x, y: p.y, w: p.w!, h: p.h!, rot: p.rot || 0 };
      const cs = corners(item);
      let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
      for (const c of cs) {
        if (c.x < x0) x0 = c.x; if (c.y < y0) y0 = c.y;
        if (c.x > x1) x1 = c.x; if (c.y > y1) y1 = c.y;
      }
      this.idx.push(i); this.quads.push(cs); this.items.push(item);
      this.bx0.push(x0); this.by0.push(y0); this.bx1.push(x1); this.by1.push(y1);
      this.marks.push(0);
      if (x0 < minX) minX = x0; if (y0 < minY) minY = y0;
      if (x1 > maxX) maxX = x1; if (y1 > maxY) maxY = y1;
    }
    this.n = this.idx.length;
    this.minX = minX; this.minY = minY;
    const side = Math.max(1, Math.round(Math.sqrt(this.n || 1)));
    this.gw = side; this.gh = side;
    this.cw = Math.max((maxX - minX) / side, 1e-6);
    this.ch = Math.max((maxY - minY) / side, 1e-6);
    for (let c = 0; c < this.n; c++) this._register(c);
  }

  _col(x: number) { return clamp(Math.floor((x - this.minX) / this.cw), 0, this.gw - 1); }
  _row(y: number) { return clamp(Math.floor((y - this.minY) / this.ch), 0, this.gh - 1); }

  _register(c: number) {
    const c0 = this._col(this.bx0[c]), c1 = this._col(this.bx1[c]);
    const r0 = this._row(this.by0[c]), r1 = this._row(this.by1[c]);
    if ((c1 - c0 + 1) * (r1 - r0 + 1) > MAX_CELLS_PER_EDGE) { this.wide.push(c); return; }
    for (let col = c0; col <= c1; col++) {
      for (let r = r0; r <= r1; r++) {
        const key = col * this.gh + r;
        const bucket = this.cells.get(key);
        if (bucket) bucket.push(c); else this.cells.set(key, [c]);
      }
    }
  }

  /** Does any card but the two at ea/eb lie across the thread a-b? */
  blocks(a: WebPoint, b: WebPoint, ea: number, eb: number) {
    if (!this.n) return false;
    for (const c of this.wide) if (this._cross1(a, b, ea, eb, c)) return true;
    const c0 = this._col(Math.min(a.x, b.x)), c1 = this._col(Math.max(a.x, b.x));
    const r0 = this._row(Math.min(a.y, b.y)), r1 = this._row(Math.max(a.y, b.y));
    const stamp = ++mark;
    for (let col = c0; col <= c1; col++) {
      for (let r = r0; r <= r1; r++) {
        const bucket = this.cells.get(col * this.gh + r);
        if (!bucket) continue;
        for (const c of bucket) {
          if (this.marks[c] === stamp) continue;
          this.marks[c] = stamp;
          if (this._cross1(a, b, ea, eb, c)) return true;
        }
      }
    }
    return false;
  }

  _cross1(a: WebPoint, b: WebPoint, ea: number, eb: number, c: number) {
    const i = this.idx[c];
    if (i === ea || i === eb) return false;
    if (Math.max(a.x, b.x) < this.bx0[c] || Math.min(a.x, b.x) > this.bx1[c] ||
        Math.max(a.y, b.y) < this.by0[c] || Math.min(a.y, b.y) > this.by1[c]) return false;
    const item = this.items[c];
    if (pointInItem(a.x, a.y, item) || pointInItem(b.x, b.y, item)) return true;
    const q = this.quads[c];
    for (let k = 0; k < 4; k++) if (crosses(a, b, q[k], q[(k + 1) & 3])) return true;
    return false;
  }
}

let mark = 0;

/** Do AB and CD cross? Shared endpoint = no. Collinear overlap = yes. AABB early-out. */
function crosses(a: WebPoint, b: WebPoint, c: WebPoint, d: WebPoint) {
  if (a === c || a === d || b === c || b === d) return false;
  if (Math.max(a.x, b.x) < Math.min(c.x, d.x) || Math.max(c.x, d.x) < Math.min(a.x, b.x) ||
      Math.max(a.y, b.y) < Math.min(c.y, d.y) || Math.max(c.y, d.y) < Math.min(a.y, b.y)) return false;

  const o1 = side(a, b, c), o2 = side(a, b, d);
  const o3 = side(c, d, a), o4 = side(c, d, b);
  if (o1 !== o2 && o3 !== o4) return true;
  // All four collinear and their boxes overlap: they lie along each other.
  return o1 === 0 && o2 === 0 && o3 === 0 && o4 === 0;
}

/** Which way you turn going p -> q -> r: 1 left, -1 right, 0 straight on. */
function side(p: WebPoint, q: WebPoint, r: WebPoint) {
  const v = (q.y - p.y) * (r.x - q.x) - (q.x - p.x) * (r.y - q.y);
  // Tolerance — drag floats collinear to 1e-9 px draw as one line.
  return v > 1e-9 ? 1 : v < -1e-9 ? -1 : 0;
}

/** Prim's MST, dense O(n^2). Squared distances — sqrt is monotonic, so skipped. */
function spanningTree(pts: WebPoint[]): Edge[] {
  const n = pts.length;
  const inTree = new Array(n).fill(false);
  // Per loose point: nearest tree distance and which tree point.
  const best = new Array(n).fill(Infinity);
  const from = new Array(n).fill(0);
  const edges: Edge[] = [];

  inTree[0] = true;
  for (let i = 1; i < n; i++) {
    best[i] = distSq(pts[0], pts[i]);
    from[i] = 0;
  }

  for (let k = 1; k < n; k++) {
    let pick = -1;
    for (let i = 0; i < n; i++) {
      if (inTree[i]) continue;
      if (pick === -1 || best[i] < best[pick]) pick = i;
    }
    if (pick === -1) break;
    inTree[pick] = true;
    edges.push([from[pick], pick]);
    for (let i = 0; i < n; i++) {
      if (inTree[i]) continue;
      const d = distSq(pts[pick], pts[i]);
      if (d < best[i]) { best[i] = d; from[i] = pick; }
    }
  }
  return edges;
}
