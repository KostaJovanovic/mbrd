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
// The governor is the second half and is here for the same reason - it is
// arithmetic over measured times, not a rendering concern. It learns what a
// tree and a pass actually cost on this machine and picks the largest board it
// will still attempt inside a frame, so a slow laptop draws fewer threads
// rather than dropping frames. It is wall-clock dependent, which is what made
// its test flaky once; the tests around it assert the arithmetic, never a
// duration.
//
// geometry.js is the only thing this imports, and both names are used by
// CardGrid below. They were being called without being imported at all, which
// threw a ReferenceError out of threads() on any board with enough sized items
// to reach the extra-thread pass - so the web stopped drawing past the spanning
// tree and said nothing about it. Found by `npm run typecheck`, which is the
// first thing that ever looked; tests/web.test.js now covers the path.

import { corners, pointInItem } from './geometry.js';

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
 * Past so many items the second pass is skipped and the tree alone is drawn -
 * and how many that is, this machine decides for itself.
 *
 * It used to be a flat 700, which is a number picked on one computer. The same
 * board on a phone or an old laptop is the same 700 and several times the work,
 * so the constant was really "700 on hardware like the author's". The whole of
 * the quality-modes question in the roadmap came down to this one lever, and
 * making it measure rather than assume is what closes that item: there is no
 * setting to find, nothing to explain, and a slow machine simply draws a
 * slightly sparser web instead of dropping frames.
 *
 * **The timing has to come from the spanning tree, not from the whole call**,
 * and that is the one thing here worth reading twice. The obvious version -
 * time the whole of `threads()` and solve for n - measures nothing at all the
 * moment it does any work: once the limit drops below the board size the second
 * pass is skipped, so no further sample is ever taken and the limit is frozen
 * wherever it happened to land. A single slow warm-up frame then thins the web
 * for the rest of the session. That version was written, measured, and threw
 * the limit to 119 on a board it rebuilds in 1.65ms.
 *
 * The tree runs on every single rebuild, so timing *it* gives a fresh reading
 * forever, on every board, whether or not the second pass ran.
 *
 * The two passes are then fitted separately, and that is the second thing this
 * got wrong on the way here. Treating the second pass as a fixed multiple of
 * the tree's cost looks reasonable and is not: the tree is O(n^2) and the pass,
 * since it got its grid, is about O(n), so the ratio between them falls as the
 * board grows. Measured at a small board it says the pass is twenty times the
 * tree, and the limit lands at 328 - which would have made a 400-item board
 * that rebuilds comfortably in 5ms drop to a bare tree.
 *
 * So: `a` is ms per n^2 for the tree, `b` is ms per n for the pass, both
 * scale-invariant properties of the machine, and the limit is the n that solves
 * a*n^2 + b*n = budget.
 *
 * Solving for n directly rather than nudging the limit up and down is what
 * keeps this from oscillating - a servo would lower the limit, skip the second
 * pass, measure a fast frame, raise it again, and the web would visibly change
 * shape every few frames while you dragged.
 *
 * It only ever goes *below* the ceiling, and the first thing it found is that
 * the old constant was too high even here: on the machine this was written on
 * it settles around 450, because a 400-point board already spends 7.6ms of an
 * 8ms budget and 700 spends over eight on its own - with items.js still to run
 * in the same frame. So this is not only a concession to slow hardware. The
 * flat 700 was optimistic on the computer that chose it.
 */
const DENSE_CEILING = 700;
/** Below this the web stops being a web, so a slow machine still gets one. */
const DENSE_FLOOR = 60;
/** Half a 60fps frame. The rest of it belongs to items.js and the browser. */
const FRAME_BUDGET_MS = 8;
/**
 * Rebuilds ignored before any of this starts.
 *
 * The first few calls are the JIT's, not the machine's, and they can be an
 * order of magnitude slow. Reacting to them would thin the web at exactly the
 * moment a board is being opened.
 */
const WARMUP = 4;

let denseLimit = DENSE_CEILING;
/**
 * `a` and `b`, both seeded from a real measurement rather than from zero.
 *
 * On the machine this was written on, a 700-point board spends about 2.2ms in
 * the tree and 6.1ms in the second pass, which is where these two numbers come
 * from. Starting at a real board's figures means the first rebuild of a session
 * is budgeted roughly right instead of being handed the whole ceiling and then
 * jerked back off it.
 */
let treeCost = 4.5e-6;   // ms per n^2
let passCost = 0.009;    // ms per n
let warmup = WARMUP;

/** What the limit currently is. Exported for tests; nothing in the app reads it. */
export const denseLimitNow = () => denseLimit;

/**
 * How much of the ceiling one call is allowed, as a multiple of the learned
 * limit. One is the frame budget the governor was written for.
 *
 * The governor learned its limit under a hard constraint that no longer exists.
 * This module used to be run on every frame of a drag - canvas/web.js rebuilt
 * the whole web as a card moved - so "how large a board will this machine
 * finish inside half a frame" was exactly the right question, and thinning the
 * web was the only alternative to dropping frames.
 *
 * It is a generator now. Nothing runs it per frame; it runs when somebody
 * presses "Join these" and waits for the answer, and there is no frame to stay
 * inside. So the limit stays - a selection of nine hundred cards should still
 * not lock the tab - but its urgency drops, and this is that: the same learned
 * number, multiplied. Four frames rather than half of one, which is a pause
 * nobody notices after a button press and still a bound.
 */
const GENEROUS = 8;

/**
 * Every thread that fits, as index pairs into `pts`.
 *
 * `generous` relaxes the governor for a call that is not inside a frame. See
 * GENEROUS; the default is the frame budget this was written for.
 */
export function threads(pts, { generous = false } = {}) {
  const n = pts.length;
  const t0 = performance.now();
  const edges = spanningTree(pts);
  const tTree = performance.now() - t0;
  learnTree(n, tTree);
  if (n > denseLimit * (generous ? GENEROUS : 1)) return edges;

  const taken = new Set(edges.map(([a, b]) => pair(a, b, n)));
  const k = Math.min(NEIGHBOURS, n - 1);
  const candidates = [];
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

  learnPass(n, performance.now() - t0 - tTree);
  return edges;
}

/**
 * The tree's timing. Taken on every rebuild, which is the whole point.
 *
 * Smoothed hard, because a single frame is mostly noise - a collection pause or
 * a tab regaining focus lands here as a board twice as expensive as it is, and
 * reacting to that would visibly thin the web for no reason.
 */
function learnTree(n, ms) {
  // Too few points to time anything but the clock's own resolution.
  if (n < 24 || !(ms > 0)) return;
  if (warmup > 0) { warmup--; return; }
  treeCost = treeCost * 0.85 + (ms / (n * n)) * 0.15;
  settle();
}

/** The same for the second pass, on its own scale: ms per point. */
function learnPass(n, ms) {
  if (n < 24 || !(ms > 0) || warmup > 0) return;
  passCost = passCost * 0.85 + (ms / n) * 0.15;
  settle();
}

/**
 * The largest n whose whole rebuild fits the budget: solve a*n^2 + b*n = budget
 * for n, which is the quadratic formula and nothing cleverer.
 *
 * Pure, and exported, because the property that matters here cannot be tested
 * any other way. What this code has to get right is that the limit *converges*
 * - a version that chases its own tail would drop, skip the second pass,
 * measure a fast frame, climb, and change the web's shape every few frames
 * while you dragged. Asserting that by running the real thing forty times and
 * checking the answer stopped moving is asserting that the machine was quiet
 * for the duration, which on a laptop compiling something else it is not: that
 * test failed about one run in three, and every failure was the room and not
 * the code. Split in two - the solve here, the deadband below - both halves are
 * ordinary functions of their arguments and the convergence is provable rather
 * than observed.
 */
export function denseLimitFor(tree, pass) {
  if (!(tree > 0)) return null;
  const root = Math.sqrt(pass * pass + 4 * tree * FRAME_BUDGET_MS);
  return clampi(Math.round((root - pass) / (2 * tree)), DENSE_FLOOR, DENSE_CEILING);
}

/**
 * Where the limit goes next, given where it is and where the maths points.
 *
 * Moved only when the answer differs by a sixth, so the limit sits still
 * instead of trembling around a boundary and taking the web's shape with it.
 * That deadband is also what makes convergence a fact rather than a hope: a
 * steady `want` moves the limit at most once and then never again, because
 * after the move the difference is zero.
 *
 * A non-finite `want` holds. It arrives when a cost estimate has gone to NaN,
 * which is a measurement that failed, not a board that got faster.
 */
export function nextDenseLimit(current, want) {
  if (!Number.isFinite(want)) return current;
  return Math.abs(want - current) > current / 6 ? want : current;
}

function settle() {
  denseLimit = nextDenseLimit(denseLimit, denseLimitFor(treeCost, passCost));
}

export const pair = (a, b, n) => (a < b ? a * n + b : b * n + a);

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
  constructor(pts) {
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

  _col(x) { return clampi(Math.floor((x - this.minX) / this.cw), 0, this.gw - 1); }
  _row(y) { return clampi(Math.floor((y - this.minY) / this.ch), 0, this.gh - 1); }

  add(ai, bi) {
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
  blocks(a, b) {
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
  constructor(pts) {
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
      if (!(p.w > 0) || !(p.h > 0)) continue;
      const item = { x: p.x, y: p.y, w: p.w, h: p.h, rot: p.rot || 0 };
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

  _col(x) { return clampi(Math.floor((x - this.minX) / this.cw), 0, this.gw - 1); }
  _row(y) { return clampi(Math.floor((y - this.minY) / this.ch), 0, this.gh - 1); }

  _register(c) {
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
  blocks(a, b, ea, eb) {
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

  _cross1(a, b, ea, eb, c) {
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
const clampi = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);

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
function crosses(a, b, c, d) {
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
function side(p, q, r) {
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
function spanningTree(pts) {
  const n = pts.length;
  const inTree = new Array(n).fill(false);
  // For each loose point: its distance to the tree, and which tree point that
  // distance is to. Kept up to date as points join, which is what makes this
  // one pass per point instead of a full rescan each time.
  const best = new Array(n).fill(Infinity);
  const from = new Array(n).fill(0);
  const edges = [];

  inTree[0] = true;
  for (let i = 1; i < n; i++) {
    best[i] = dist2(pts[0], pts[i]);
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
      const d = dist2(pts[pick], pts[i]);
      if (d < best[i]) { best[i] = d; from[i] = pick; }
    }
  }
  return edges;
}

function dist2(a, b) {
  const dx = a.x - b.x, dy = a.y - b.y;
  return dx * dx + dy * dy;
}
