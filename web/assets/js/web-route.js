// Where a connection actually runs: an orthogonal path from one card to
// another that goes around the cards in between rather than through them.
//
// A straight line drawn from card to card is not a relationship, it is a
// scratch across three photographs. This is the module that stops that
// happening, and it is the only genuinely new algorithm the connector feature
// needed.
//
// Pure, and at the top level beside web-graph.js for exactly that reason: no
// DOM, no state, no viewport, no spatial index. The obstacles are *handed in*.
// canvas/web.js is the half that knows which cards are near enough to matter
// (it asks canvas/spatial.js) and the half that draws; this half is arithmetic
// over boxes and can be checked in node.
//
// ---------------------------------------------------------------------------
// Why a lattice and not a grid
// ---------------------------------------------------------------------------
//
// The obvious approach is a uniform grid and a search over its cells, and it is
// wrong here for one reason: world space is infinite and float. Any fixed cell
// size is either too coarse - it misses a real gap between two cards and
// reports no route where there is an obvious one - or fine enough not to, in
// which case a route across a large board is hundreds of thousands of cells.
//
// So the lattice is built from the obstacles themselves. Take the x of every
// nearby card's left and right edge and the y of every top and bottom edge,
// each pushed out by a clearance margin, and add the two endpoints' own lines.
// Every place an orthogonal path could ever usefully turn is an intersection of
// one of those verticals with one of those horizontals, and there are no others
// - a turn anywhere else is either inside a card or parallel to and outside a
// line that is already in the set, which is to say a longer version of a path
// the lattice already holds. That is a few dozen lines rather than a few
// hundred thousand cells, and it is exact.
//
// ---------------------------------------------------------------------------
// Why the turn penalty
// ---------------------------------------------------------------------------
//
// A shortest orthogonal path is not unique - between two points with nothing in
// the way there are as many equally short staircases as you like - and left to
// itself A* returns whichever the tie-break happened to reach first, which is
// usually a staircase. A staircase is the wrong picture: what a connector
// should look like is a line that leaves one card, makes as few deliberate
// bends as it needs to get round what is in the way, and arrives at the other.
// So a turn costs, and the cost is large next to the distances involved. That
// one number is the difference between a diagram and a scribble.
//
// ---------------------------------------------------------------------------
// What is deliberately not here
// ---------------------------------------------------------------------------
//
// - **Connections do not avoid each other.** Only cards are obstacles. Two
//   lines crossing is what every diagram in existence does; making them avoid
//   each other multiplies the cost of every route by the number of routes, for
//   something nobody looks at.
// - **Nothing is cached.** A path is a function of where the cards are now, the
//   same way the web it replaced was derived rather than saved. There is
//   nothing to invalidate and nothing to go stale. The performance rule that
//   makes that affordable lives in canvas/web.js: no routing during a drag, and
//   only the affected connections rerouted on the drop.
// - **Rotation is approximated outward.** A turned card is treated as the
//   axis-aligned box that contains it (rotatedExtents), so a route gives a
//   tilted card slightly more room than it strictly needs. Conservative in the
//   direction that matters - it can make a route longer, never make one cut a
//   corner off a card - and cards rest within a couple of degrees of square.

import { rotatedExtents } from './geometry.js';

/**
 * How far a route stays off a card it is passing.
 *
 * Enough to read as clearance rather than as a line grazing an edge, and small
 * enough that two cards a normal gap apart still have a corridor between them.
 */
export const CLEARANCE = 14;

/**
 * The straight run every route makes on its way out of a card before it is
 * allowed to turn.
 *
 * Without it the first lattice line available is the card's own edge, and a
 * route would set off by sliding along the side of the card it just left -
 * which reads as the line tracing the card rather than leaving it. Larger than
 * nothing and smaller than CLEARANCE would be, so the stub of one card never
 * lands inside another card's margin more often than the card itself would.
 */
export const STUB = 18;

/**
 * What one bend costs, in world units of extra length.
 *
 * Not tuned to a board size, and it should not be: it is the answer to "how
 * much further would you go to avoid a corner?", which is a question about the
 * picture rather than about the scale. Sixty says a route will happily take a
 * sixty-unit detour to lose one bend and will not take a two-hundred-unit one.
 */
export const TURN_COST = 60;

/**
 * The most cards one route will consider going around.
 *
 * The lattice is (2n + 4)² nodes, so this is the number that bounds the search
 * rather than a guess about how crowded a board gets. At 24 that is a little
 * over two and a half thousand nodes for the worst case, which is a few
 * milliseconds - and it is a *worst* case, since the caller only hands over
 * cards whose boxes meet the corridor between the two ends.
 *
 * Past it the nearest are kept and the rest ignored, so a route through a very
 * dense patch can clip a card rather than failing. A clipped card is a much
 * better answer than no line, and it is the same bargain the fallback below
 * makes for the same reason.
 */
export const MAX_OBSTACLES = 24;

/** Guards the search itself, in case a caller ignores the cap above. */
const MAX_NODES = 6000;

// Float lattice coordinates are compared, so nothing here may turn on an exact
// equality. One thousandth of a world unit is far below anything visible and
// far above the error in summing a few coordinates.
const EPS = 1e-3;

/** The axis-aligned box around an item, rotation included, grown by `pad`. */
export function blockOf(it, pad = 0) {
  const { hw, hh } = rotatedExtents(it);
  return {
    x0: it.x - hw - pad, y0: it.y - hh - pad,
    x1: it.x + hw + pad, y1: it.y + hh + pad,
  };
}

/**
 * Whether an axis-aligned segment passes through the interior of a block.
 *
 * Its own test rather than segmentMeetsRect(), and the difference is the whole
 * point: that one answers "does this segment touch this rectangle at all", which
 * is what a culler wants, and here a segment running *along* a block's edge has
 * to be allowed - the lattice is built out of those edges, so if touching
 * counted then every line in it would be blocked by the card that produced it.
 */
function segmentBlocked(ax, ay, bx, by, b) {
  if (ay === by) {
    if (ay <= b.y0 + EPS || ay >= b.y1 - EPS) return false;
    return Math.min(ax, bx) < b.x1 - EPS && Math.max(ax, bx) > b.x0 + EPS;
  }
  if (ax <= b.x0 + EPS || ax >= b.x1 - EPS) return false;
  return Math.min(ay, by) < b.y1 - EPS && Math.max(ay, by) > b.y0 + EPS;
}

/** Sorted, with values closer together than EPS collapsed into one line. */
function lattice(values) {
  const sorted = [...values].sort((p, q) => p - q);
  const out = [];
  for (const v of sorted) {
    if (!out.length || v - out[out.length - 1] > EPS) out.push(v);
  }
  return out;
}

/**
 * Which side of `from` faces `to`, and the point on that side to leave by.
 *
 * The side is chosen per route and recomputed whenever anything moves, rather
 * than fixed to a compass point on the card. Fixed anchors would be a second
 * thing for somebody to manage, and they are wrong the moment either card is
 * dragged past the other.
 *
 * The dominant axis decides it: mostly-sideways goes out of a side, mostly-up
 * or down goes out of the top or the bottom. Ties go sideways, because cards
 * are wider than they are tall more often than not.
 */
export function anchorFor(from, to) {
  const box = blockOf(from);
  const dx = to.x - from.x;
  const dy = to.y - from.y;
  if (Math.abs(dx) >= Math.abs(dy)) {
    const x = dx >= 0 ? box.x1 : box.x0;
    return { edge: { x, y: from.y }, stub: { x: dx >= 0 ? x + STUB : x - STUB, y: from.y } };
  }
  const y = dy >= 0 ? box.y1 : box.y0;
  return { edge: { x: from.x, y }, stub: { x: from.x, y: dy >= 0 ? y + STUB : y - STUB } };
}

/**
 * The path a connection takes, as a list of points to draw straight lines
 * between. Always at least two, and always something: a pair with no route at
 * all still gets a line.
 *
 * `from` and `to` are item-shaped boxes - `{ x, y, w, h, rot }` - in whatever
 * coordinate system the caller draws in. `obstacles` are the other cards, in
 * the same shape and the same system, and must not include the two ends.
 *
 * The result carries `straight` so the caller can tell a real route from the
 * fallback. Nothing draws them differently today; it is there because "the
 * router gave up here" is a thing worth being able to see.
 */
export function routeConnection(from, to, obstacles = []) {
  const a = anchorFor(from, to);
  const b = anchorFor(to, from);
  const fallback = { points: [a.edge, b.edge], straight: true };

  // Nearest first, so a cap that bites drops the cards least likely to be in
  // the way rather than whichever the caller happened to list last.
  const near = obstacles.length <= MAX_OBSTACLES ? obstacles : [...obstacles]
    .sort((p, q) => dist2(p, from, to) - dist2(q, from, to))
    .slice(0, MAX_OBSTACLES);

  // The two ends are obstacles too, and with no margin. Without them a route is
  // free to run straight through the card it started from, which happens
  // constantly when the far card is behind the near one. With a margin, the
  // stub points would be inside their own card's block and there would be
  // nowhere to start.
  const blocks = near.map(it => blockOf(it, CLEARANCE));
  const ends = [blockOf(from), blockOf(to)];
  const all = [...blocks, ...ends];

  // The two-bend path, tried first and taken whenever it is clear. It is the
  // answer on most boards, the search would only rediscover it, and it is one
  // loop over a handful of segments against the cost of building a lattice.
  const easy = simple(a, b, all);
  if (easy) return easy;

  // Otherwise the lattice - and the end cards' own edges are lines in it as
  // well as the obstacles', which is what lets a route get out from under a
  // card it overlaps. Skipping that was a bug: with no other cards in the way
  // and the simple path blocked by one of the two ends, this used to give up
  // and draw the straight line without ever having looked for a way round.
  const xs = lattice([
    a.edge.x, a.stub.x, b.edge.x, b.stub.x,
    ...all.flatMap(k => [k.x0, k.x1]),
  ]);
  const ys = lattice([
    a.edge.y, a.stub.y, b.edge.y, b.stub.y,
    ...all.flatMap(k => [k.y0, k.y1]),
  ]);
  if (xs.length * ys.length > MAX_NODES) return fallback;

  const xi = xs.indexOf(nearestIn(xs, a.stub.x));
  const yi = ys.indexOf(nearestIn(ys, a.stub.y));
  const xj = xs.indexOf(nearestIn(xs, b.stub.x));
  const yj = ys.indexOf(nearestIn(ys, b.stub.y));

  const path = search(xs, ys, all, xi, yi, xj, yj);
  if (!path) return fallback;

  // The stubs bracket the search's own answer, and the edge points bracket
  // those. Duplicates are shed on the way out: when a stub lands exactly on a
  // lattice node the search already begins there.
  return { points: trim([a.edge, a.stub, ...path, b.stub, b.edge]), straight: false };
}

/** How far a card is from the corridor between the two ends, roughly. */
function dist2(it, from, to) {
  const mx = (from.x + to.x) / 2;
  const my = (from.y + to.y) / 2;
  return (it.x - mx) ** 2 + (it.y - my) ** 2;
}

const nearestIn = (values, v) =>
  values.reduce((best, x) => (Math.abs(x - v) < Math.abs(best - v) ? x : best), values[0]);

/**
 * The obvious path: out of one card along its stub, across, and into the other.
 *
 * Which of the two L shapes it is follows the anchors - a route leaving
 * sideways turns at the far card's x, one leaving vertically turns at its y -
 * and it is what the search returns anyway on a board with nothing in the way.
 * Tried first because it costs one loop over four segments against the cost of
 * building a lattice and running A* over it, and on most boards it is right.
 *
 * Null when anything blocks it, including either of the two cards themselves:
 * two overlapping cards joined by a line is a real board, and the L between
 * them routinely runs back through the card it started from.
 */
function simple(a, b, blocks) {
  const mid = a.stub.x === a.edge.x
    ? [{ x: a.stub.x, y: b.stub.y }]           // left vertically
    : [{ x: b.stub.x, y: a.stub.y }];          // left sideways
  const points = trim([a.edge, a.stub, ...mid, b.stub, b.edge]);
  for (let i = 1; i < points.length; i++) {
    for (const k of blocks) {
      if (segmentBlocked(points[i - 1].x, points[i - 1].y, points[i].x, points[i].y, k)) {
        return null;
      }
    }
  }
  return { points, straight: false };
}

/** Drop repeated points and points that sit in the middle of a straight run. */
export function trim(points) {
  const out = [];
  for (const p of points) {
    const last = out[out.length - 1];
    if (last && Math.abs(last.x - p.x) < EPS && Math.abs(last.y - p.y) < EPS) continue;
    out.push(p);
  }
  for (let i = out.length - 2; i > 0; i--) {
    const before = out[i - 1], here = out[i], after = out[i + 1];
    const flat = Math.abs(before.y - here.y) < EPS && Math.abs(here.y - after.y) < EPS;
    const upright = Math.abs(before.x - here.x) < EPS && Math.abs(here.x - after.x) < EPS;
    if (flat || upright) out.splice(i, 1);
  }
  return out;
}

/**
 * A* over the lattice, with a turn penalty.
 *
 * State is (node, heading) rather than node alone, and it has to be: the cost
 * of leaving a node depends on how you arrived at it, so a plain node-keyed
 * search would settle a node by its cheapest arrival and then charge the wrong
 * turn cost on every path through it. Four headings, so four states per node.
 *
 * The heuristic is Manhattan distance, which never overestimates on a lattice
 * where every move is axis-aligned and the turn penalty is non-negative - so
 * the first time the goal is popped, it is optimal.
 *
 * The open set is a plain array scanned for its minimum rather than a heap. The
 * lattice is a couple of thousand states at the very worst, the scan is a tight
 * loop over numbers, and a binary heap here would be a data structure carried
 * for the rest of the file's life to save a fraction of a millisecond on a
 * board nobody has.
 */
function search(xs, ys, blocks, xi, yi, xj, yj) {
  const W = xs.length, H = ys.length;
  const N = W * H;
  if (xi < 0 || yi < 0 || xj < 0 || yj < 0) return null;

  // Precompute passability once per lattice edge rather than per visit. Every
  // interior edge is looked at from both of its ends and often several times
  // over, and the blocked test is a loop over every obstacle.
  const okRight = new Uint8Array(N);   // node -> the edge to (x+1, y) is clear
  const okDown = new Uint8Array(N);    // node -> the edge to (x, y+1) is clear
  const at = (x, y) => y * W + x;
  const clear = (ax, ay, bx, by) => {
    for (const k of blocks) if (segmentBlocked(ax, ay, bx, by, k)) return false;
    return true;
  };
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      if (x + 1 < W) okRight[at(x, y)] = clear(xs[x], ys[y], xs[x + 1], ys[y]) ? 1 : 0;
      if (y + 1 < H) okDown[at(x, y)] = clear(xs[x], ys[y], xs[x], ys[y + 1]) ? 1 : 0;
    }
  }

  // 0 right, 1 left, 2 down, 3 up. A fifth heading - "not yet moving" - would
  // be the honest start state; instead the start is seeded in all four at zero
  // cost, which says the same thing and keeps the arrays a flat four deep.
  const STATES = N * 4;
  const g = new Float64Array(STATES).fill(Infinity);
  const from = new Int32Array(STATES).fill(-1);
  const done = new Uint8Array(STATES);
  const open = [];

  const h = (x, y) => Math.abs(xs[x] - xs[xj]) + Math.abs(ys[y] - ys[yj]);
  for (let d = 0; d < 4; d++) {
    const s = at(xi, yi) * 4 + d;
    g[s] = 0;
    open.push(s);
  }

  const goal = at(xj, yj);
  while (open.length) {
    let bestAt = 0;
    let best = Infinity;
    for (let i = 0; i < open.length; i++) {
      const s = open[i];
      const node = s >> 2;
      const f = g[s] + h(node % W, (node / W) | 0);
      if (f < best) { best = f; bestAt = i; }
    }
    const s = open[bestAt];
    open[bestAt] = open[open.length - 1];
    open.pop();
    if (done[s]) continue;
    done[s] = 1;

    const node = s >> 2;
    const dir = s & 3;
    if (node === goal) return walkBack(xs, ys, W, from, s);

    const x = node % W;
    const y = (node / W) | 0;
    const step = (nx, ny, nd, passable) => {
      if (!passable) return;
      const next = at(nx, ny) * 4 + nd;
      if (done[next]) return;
      const cost = Math.abs(xs[nx] - xs[x]) + Math.abs(ys[ny] - ys[y]) +
                   (nd === dir ? 0 : TURN_COST);
      if (g[s] + cost >= g[next]) return;
      g[next] = g[s] + cost;
      from[next] = s;
      open.push(next);
    };
    step(x + 1, y, 0, x + 1 < W && okRight[at(x, y)]);
    step(x - 1, y, 1, x - 1 >= 0 && okRight[at(x - 1, y)]);
    step(x, y + 1, 2, y + 1 < H && okDown[at(x, y)]);
    step(x, y - 1, 3, y - 1 >= 0 && okDown[at(x, y - 1)]);
  }
  return null;
}

function walkBack(xs, ys, W, from, end) {
  const points = [];
  for (let s = end; s >= 0; s = from[s]) {
    const node = s >> 2;
    points.push({ x: xs[node % W], y: ys[(node / W) | 0] });
  }
  return points.reverse();
}

/**
 * The `d` string for a routed path, with the corners answering the whimsy axis.
 *
 * Square at Harsh, rounded at Softish, and it is one branch rather than two
 * path builders because it is one path with two kinds of corner. This is what
 * keeps a connector from being the one element on the board with an opinion of
 * its own about how the interface looks.
 *
 * The radius is clamped to half of the shorter of the two runs meeting at the
 * corner, so a bend between two short segments rounds as much as it can and
 * never more - an arc longer than the segment it is cutting would overshoot the
 * next corner and draw a knot.
 */
export function pathData(points, radius = 0, dx = 0, dy = 0) {
  if (!points.length) return '';
  const at = p => `${(p.x - dx).toFixed(2)} ${(p.y - dy).toFixed(2)}`;
  if (points.length < 3 || radius <= 0) {
    return 'M' + points.map(at).join('L');
  }
  let d = 'M' + at(points[0]);
  for (let i = 1; i < points.length - 1; i++) {
    const prev = points[i - 1], here = points[i], next = points[i + 1];
    const inLen = Math.hypot(here.x - prev.x, here.y - prev.y);
    const outLen = Math.hypot(next.x - here.x, next.y - here.y);
    const r = Math.min(radius, inLen / 2, outLen / 2);
    if (r < EPS) { d += 'L' + at(here); continue; }
    const start = along(here, prev, r);
    const end = along(here, next, r);
    d += 'L' + at(start) + 'Q' + at(here) + ' ' + at(end);
  }
  return d + 'L' + at(points[points.length - 1]);
}

/** `r` world units from `p` towards `q`. */
function along(p, q, r) {
  const len = Math.hypot(q.x - p.x, q.y - p.y) || 1;
  return { x: p.x + (q.x - p.x) * r / len, y: p.y + (q.y - p.y) * r / len };
}
