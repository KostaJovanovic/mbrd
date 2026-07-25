// The web: threads from item to item, drawn behind everything.
//
// One rule - no two threads may cross - and otherwise as many of them as will
// fit. That is a maximal planar set of straight segments over the item
// centres, and it is built in two passes for two different reasons.
//
// The first pass is a Euclidean minimum spanning tree, and it is here to
// guarantee the web is one connected piece rather than islands. Its edges are
// provably non-crossing, and the proof is short enough to keep: if AB and CD
// crossed at a point P then |AB| + |CD| = (|AP|+|PB|) + (|CP|+|PD|), and
// regrouping those four pieces by the triangle inequality gives
// |AC| + |BD| <= that sum, equal only if all four points are collinear. So
// re-pairing is never worse, and a *minimum* tree cannot contain a crossing.
//
// The second pass then adds every other thread that fits, shortest first,
// keeping one only if it crosses nothing accepted so far. Shortest-first is
// what makes the result look like a web rather than a mess: a short thread
// gets to claim its space before a long one can cut across the same gap, so
// the board fills up with small local triangles instead of a few long
// diagonals stretched over everything.
//
// Drawn inside #world, so pan and zoom come for free from the layer transform
// and this only ever redraws when the geometry actually changes. The stroke is
// marked non-scaling so a thread stays a thread at 8x instead of becoming a
// beam.

import { board, bus } from '../state.js';
import { rafThrottle } from '../util.js';

const SVG_NS = 'http://www.w3.org/2000/svg';

let svg = null;
let path = null;

export function initWeb(worldEl) {
  svg = document.createElementNS(SVG_NS, 'svg');
  svg.id = 'web';
  svg.setAttribute('aria-hidden', 'true');

  path = document.createElementNS(SVG_NS, 'path');
  path.setAttribute('fill', 'none');
  svg.append(path);

  // First child of #world, and it never claims a pointer - the web is a
  // backdrop for the items, not a thing you can catch hold of.
  worldEl.prepend(svg);

  const redraw = rafThrottle(draw);
  bus.on('items', redraw);
  bus.on('geom', redraw);
  bus.on('board:load', redraw);
  draw();
}

/**
 * Item centres in #world's coordinates.
 *
 * World y points up and CSS y points down, so a centre that is at world
 * (x, y) is laid out at (x, -y) - the same negation items.js/place() applies,
 * and the only conversion this module needs.
 */
function centres() {
  return board.items.map(i => ({ x: i.x, y: -i.y }));
}

function draw() {
  if (!svg) return;
  const pts = centres();
  // One item has nothing to connect to, and zero items have nothing at all.
  if (pts.length < 2) {
    svg.style.display = 'none';
    return;
  }
  svg.style.display = '';

  const edges = threads(pts);

  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const p of pts) {
    if (p.x < minX) minX = p.x;
    if (p.y < minY) minY = p.y;
    if (p.x > maxX) maxX = p.x;
    if (p.y > maxY) maxY = p.y;
  }
  // A board whose items all sit on one row has a zero-height box, and an SVG
  // with a zero extent renders nothing at all - so the box never closes fully.
  const w = Math.max(maxX - minX, 1);
  const h = Math.max(maxY - minY, 1);

  svg.style.left = minX.toFixed(2) + 'px';
  svg.style.top = minY.toFixed(2) + 'px';
  svg.style.width = w.toFixed(2) + 'px';
  svg.style.height = h.toFixed(2) + 'px';
  svg.setAttribute('viewBox', `0 0 ${w.toFixed(2)} ${h.toFixed(2)}`);

  // One path of many subpaths rather than n-1 <line> elements: the tree is
  // rebuilt wholesale on every move, and swapping a single `d` attribute beats
  // reconciling a few hundred nodes.
  let d = '';
  for (const [a, b] of edges) {
    d += `M${(pts[a].x - minX).toFixed(2)} ${(pts[a].y - minY).toFixed(2)}` +
         `L${(pts[b].x - minX).toFixed(2)} ${(pts[b].y - minY).toFixed(2)}`;
  }
  path.setAttribute('d', d);
}

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
/** Past this, the second pass is skipped and the tree alone is drawn. */
const DENSE_LIMIT = 700;

function threads(pts) {
  const n = pts.length;
  const edges = spanningTree(pts);
  if (n > DENSE_LIMIT) return edges;

  const taken = new Set(edges.map(([a, b]) => pair(a, b, n)));
  const k = Math.min(NEIGHBOURS, n - 1);
  const candidates = [];
  const seen = new Set();
  for (let i = 0; i < n; i++) {
    const near = [];
    for (let j = 0; j < n; j++) if (j !== i) near.push([dist2(pts[i], pts[j]), j]);
    near.sort((x, y) => x[0] - y[0]);
    for (let m = 0; m < k; m++) {
      const j = near[m][1];
      const id = pair(i, j, n);
      if (taken.has(id) || seen.has(id)) continue;
      seen.add(id);
      candidates.push([near[m][0], Math.min(i, j), Math.max(i, j)]);
    }
  }
  candidates.sort((x, y) => x[0] - y[0]);

  for (const [, a, b] of candidates) {
    let blocked = false;
    for (const e of edges) {
      if (crosses(pts[a], pts[b], pts[e[0]], pts[e[1]])) { blocked = true; break; }
    }
    if (blocked) continue;
    edges.push([a, b]);
    taken.add(pair(a, b, n));
  }
  return edges;
}

const pair = (a, b, n) => (a < b ? a * n + b : b * n + a);

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
