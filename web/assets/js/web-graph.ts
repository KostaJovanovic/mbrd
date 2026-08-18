// The web's graph: which cards would get a thread, and the governor that
// decides how many is affordable.
//
// **This is a generator now, not the thing that draws the board.** It used to
// be run by canvas/web.js on every change, and what it produced *was* the web -
// an effect nobody could steer, over a board that had not asked for one. Lines
// between cards are drawn by hand now and stored (board.connections), and this
// survives as the answer to "join these for me": run it over a selection and it
// offers a set of real, stored, editable connections that then route like any
// other. See cmds.connectSelection.
//
// Which is the right relationship between an algorithm and somebody's board.
// The no-crossing guarantee below stops being a law the app imposes and becomes
// what the generator happens to produce - and several hundred lines of tested,
// proven geometry go on earning their keep instead of being deleted.
//
// Pure - no DOM, no viewport, no state - which is why it sits at the top level
// beside geometry.js and mesh.js rather than under canvas/. canvas/web.js is
// the half that draws: SVG, culling, the fade state machine. This is the half
// that decides, and the two were one 889-line file in which the algorithm was
// the part nobody could test without a browser.
//
// The rule the whole thing exists to hold: **no two threads may cross.** A
// Euclidean minimum spanning tree first, which guarantees one connected piece
// and provably contains no crossing; then every other candidate that still
// fits, shortest first, each tested against what is already there.
//
// The second half used to be a governor: arithmetic over measured times that
// learned what a tree and a pass cost on this machine and picked the largest
// board it would still attempt inside a frame, so a slow laptop drew fewer
// threads rather than dropping frames. It went with the automatic web that
// needed it - see DENSE_LIMIT, which is the flat number it had become. What it
// leaves behind is the caution its wall-clock dependence earned, which still
// applies to every test in this file: assert the arithmetic, never a duration.
//
// geometry.js is the only thing this imports. corners and pointInItem are used
// by CardGrid below; distSq is the squared point-to-point distance the spanning
// tree compares, which lived here under the name dist2 until web-route.js was
// found to have a *different* function under the same name - see the polylines
// section of geometry.js. They were being called without being imported at all,
// which
// threw a ReferenceError out of threads() on any board with enough sized items
// to reach the extra-thread pass - so the web stopped drawing past the spanning
// tree and said nothing about it. Found by `npm run typecheck`, which is the
// first thing that ever looked; tests/web.test.js now covers the path.

import { corners, pointInItem, distSq } from './geometry.ts';
import { clamp } from './util.ts';

/**
 * What this file works over: a card's centre, and its box where it has one.
 *
 * Sizeless points are a real case rather than a test convenience - the tests
 * hand in bare centres and CardGrid then contributes nothing, which is exactly
 * how the pass behaved before card avoidance existed.
 */
type WebPoint = { x: number, y: number, w?: number, h?: number, rot?: number };

/** A thread, as a pair of indices into the point list it was worked out over. */
type Edge = [number, number];

/**
 * Every thread that fits: the spanning tree, then everything else that can be
 * added without crossing anything already there, shortest first.
 *
 * Candidates are limited to each point's nearest neighbours rather than all
 * n(n-1)/2 pairs. A long thread almost never survives the crossing test on a
 * board dense enough for the limit to matter - by the time it is considered,
 * the ground between its ends is already covered by shorter ones - so this
 * costs a handful of edges around the outside and turns a cubic pass into a
 * quadratic one. The whole web is rebuilt on every drag frame; it has to stay
 * inside a frame's budget on a board with hundreds of things on it.
 */
const NEIGHBOURS = 14;

/**
 * The most cards one press of "Join these" will run the second pass over.
 *
 * Past it the spanning tree alone is drawn, which is still a connected web -
 * just a sparser one - so a selection of the whole of a very large board comes
 * back with something rather than with a locked tab.
 *
 * **This was an adaptive governor, and the thing it adapted to is gone.** It
 * timed the tree on every call, fitted a cost per n^2 and a cost per n, and
 * solved a*n^2 + b*n = 8ms for the largest board this machine could rebuild
 * inside half a frame - with a deadband on top so the limit could not oscillate
 * and change the web's shape while you dragged. Every clause of that sentence
 * was about a web rebuilt on every frame of a drag, which is what this module
 * used to be run for and has not been since the connections became somebody's.
 *
 * Run once, on a button press, it could not work and did not: the warmup ate
 * the first four calls, the 0.85/0.15 smoothing needs dozens more, and a call
 * happens when somebody presses a button - so measured over a hundred presses
 * the limit wandered between 580 and 700 on noise and never converged on
 * anything. Multiplied by the eight-frame allowance the button press was given,
 * the number that actually bounded the pass was this one all along.
 *
 * So it is written down instead of measured. There is no frame to stay inside
 * any more, nobody is dragging, and a pause after a deliberate press is not a
 * dropped frame - which is the whole reason the measuring was worth its
 * complexity and now is not.
 */
const DENSE_LIMIT = 5600;

/**
 * Every thread that fits, as index pairs into `pts`.
 *
 * There was a `generous` option, which relaxed the governor for a call that was
 * not inside a frame. Every call is that call now - see DENSE_LIMIT.
 */
export function threads(pts: WebPoint[]): Edge[] {
  const n = pts.length;
  // Nothing joins nothing. `n = 0` slipped past the DENSE_LIMIT guard below,
  // made `k = Math.min(14, -1)` and threw a RangeError out of
  // `new Float64Array(-1)` - a throw for the emptiest possible input, on a
  // function whose whole job is a list of pairs.
  if (!n) return [];
  const edges = spanningTree(pts);
  if (n > DENSE_LIMIT) return edges;

  const taken = new Set(edges.map(([a, b]) => pair(a, b, n)));
  const k = Math.min(NEIGHBOURS, n - 1);
  const candidates: [number, number, number][] = [];
  const seen = new Set();

  // The k nearest, kept by insertion into a fixed pair of buffers rather than
  // by sorting all n-1 distances and reading the front off.
  //
  // The sort was not the expensive part. The array it sorted was: one array of
  // n two-element arrays per point, so a 500-item board minted a quarter of a
  // million short-lived arrays on every drag frame and handed the whole lot to
  // the collector. These two buffers are allocated once for the whole pass.
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
      // Already holding k closer ones: nothing to do, and this is the branch
      // taken for almost every pair on a board of any size.
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

  // Accepted threads go into a grid as they are accepted, so a candidate only
  // has to be tested against the ones whose boxes could touch its own. Without
  // it every candidate walks the whole accepted set, which is the quadratic
  // that made a drag on a large board stutter.
  const grid = new EdgeGrid(pts);
  for (const [a, b] of edges) grid.add(a, b);

  // Cards are obstacles too, not only their centres nodes. The spanning tree is
  // left to run through them where it must - dropping a tree edge could split
  // the web into islands, and one connected piece is the tree's whole job - but
  // an *extra* thread is a luxury, so it is refused if it passes through any
  // card that is not one of its own two endpoints. Built once: the cards do not
  // move while the pass runs.
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

/**
 * Accepted threads, bucketed by the cells their bounding box covers.
 *
 * Conservative by construction: a thread is registered in *every* cell its box
 * touches, so any candidate whose box overlaps it shares at least one of them
 * and the pair is always tested. Missing a pair here would put a visible
 * crossing in the web, so there is no clever early exit anywhere in this class.
 *
 * The escape hatch is `wide`. A spanning tree on a sparse board can hold one
 * very long edge reaching across the whole thing, and listing that in every
 * cell it passes over would cost more than testing it against everything. Past
 * a cap it goes in a list that every candidate checks.
 */
const MAX_CELLS_PER_EDGE = 32;

class EdgeGrid {
  // Declared rather than initialised here: every one is assigned in the
  // constructor below, and `declare` is the spelling that erases to nothing -
  // see tsconfig.json on erasableSyntaxOnly. A field with an initialiser would
  // be a second write on every construction of a class built once per pass.
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
    // An index is what makes the visited stamp below cheap - marking the edge
    // itself would mean hanging a property on an array and dropping it out of
    // the fast representation.
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

    // One cell per point, near enough, which puts a handful of threads in each.
    // Finer wastes time registering; coarser puts everything back in one bucket.
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
    // A thread listed in two of the candidate's cells would otherwise be tested
    // twice. Harmless, but `crosses` is the hot call in this file, so the
    // repeat is skipped with a stamp rather than a Set.
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

/**
 * The cards, bucketed by the cells their bounding box covers - the same trick
 * EdgeGrid plays for threads, so a candidate thread is tested against the
 * handful of cards near it rather than all of them.
 *
 * A card is a rectangle, possibly turned, so the test is not the segment-segment
 * one threads use: a thread crosses a card if either of its ends lands inside
 * the card (two cards overlapping) or it cuts one of the card's four edges. A
 * thread always runs from one card centre to another, so its own two endpoint
 * cards are skipped - it starts and ends inside them by construction.
 *
 * Points with no size (the tests hand in bare centres) contribute no card, so
 * this whole structure is empty and `blocks` falls straight through - the pass
 * behaves exactly as it did before card avoidance existed.
 */
class CardGrid {
  // Declared for the reason EdgeGrid's are; the comments stay on the
  // assignments, where they describe what goes in rather than what it is.
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
      // The `?? 0` changes no answer - `undefined > 0` and `0 > 0` are both
      // false - and is what lets a sizeless point be compared at all.
      if (!((p.w ?? 0) > 0) || !((p.h ?? 0) > 0)) continue;
      // Non-null twice: the line above skipped every point without a positive
      // width and height, which is a test tsc cannot read as a narrowing.
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

/**
 * Do segments AB and CD cross?
 *
 * Sharing an endpoint is not crossing - that is just two threads meeting at an
 * item, which is the entire point of a web. Collinear overlap *is* rejected,
 * because two threads lying along each other draw as one and the longer would
 * pass straight through the item in the middle.
 *
 * Bounding boxes are checked first. It rejects most pairs in four comparisons,
 * and this runs tens of thousands of times per redraw.
 */
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
  // A tolerance, not an exact zero: these are floats off a drag, and two
  // threads that are collinear to within a thousandth of a pixel draw as one.
  return v > 1e-9 ? 1 : v < -1e-9 ? -1 : 0;
}

/**
 * Prim's algorithm on the complete graph of the points: start anywhere, and
 * repeatedly attach whichever loose point is nearest to the tree so far.
 *
 * Dense O(n^2) rather than a Delaunay triangulation plus Kruskal. It is the
 * simpler code by a wide margin, it needs no geometric predicates to get
 * right, and it runs on the item counts a moodboard actually holds - a
 * few hundred points is a few tens of thousands of distance tests, well inside
 * one frame.
 *
 * Distances are compared squared; the square root is monotonic, so it would
 * only cost time without changing a single choice.
 */
function spanningTree(pts: WebPoint[]): Edge[] {
  const n = pts.length;
  const inTree = new Array(n).fill(false);
  // For each loose point: its distance to the tree, and which tree point that
  // distance is to. Kept up to date as points join, which is what makes this
  // one pass per point instead of a full rescan each time.
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
