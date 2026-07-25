// The web: a thread from item to item, drawn behind everything.
//
// The brief was "connect every element, straight lines between centres, and
// never let two of them cross". That last clause is the whole design, because
// it rules out almost every obvious answer: connect-everything crosses
// immediately, a chain crosses as soon as it doubles back, nearest-neighbour
// links cross whenever two pairs sit at an angle to each other.
//
// The structure that satisfies it is the Euclidean minimum spanning tree - the
// cheapest set of straight edges that still joins every item into one piece.
// Its edges provably never cross, and the proof is short enough to keep here:
// if AB and CD crossed at some point P, then |AB| + |CD| = (|AP|+|PB|) +
// (|CP|+|PD|), and regrouping those four pieces by the triangle inequality
// gives |AC| + |BD| <= that sum, with equality only if all four are collinear.
// So swapping to AC and BD is never worse, which means a *minimum* tree never
// contains a crossing pair in the first place.
//
// It is also the right structure by eye, not just by construction: minimising
// total length means every item joins the board at its nearest neighbour, so
// the threads read as "these two things are near each other" rather than as an
// arbitrary graph laid over the top.
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

  const edges = spanningTree(pts);

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
