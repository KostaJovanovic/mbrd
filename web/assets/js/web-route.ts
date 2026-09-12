// Orthogonal routing: A* on a lattice built from obstacle edges, with a turn
// penalty to prefer clean bends over staircases. Three shapes via opts.shape:
// 'square' (right angles), 'grid' (snapped to board lattice), 'taut' (string-
// pulled). Pure: no DOM, no state. canvas/web.ts hands in obstacles and draws.

import { rotatedExtents, segmentMeetsRect, distSqToMidpoint } from './geometry.ts';
// Types from geometry.ts so both halves of the connector agree on shapes.
import type { Point, Box, Bounds } from './geometry.ts';

/** Point on a card face + one stub out from it. */
export type Anchor = { edge: Point, stub: Point };

/** Which of the lines meeting a face this is, and how many total. */
export type Slot = { index: number, count: number };

/** The one slot a caller that has not thought about it gets: the middle. */
const MIDDLE: Slot = { index: 0, count: 1 };

/** How the look reaches the algorithm - see the header, and routeConnection(). */
export type RouteOpts = {
  shape?: string,
  step?: number,
  clearance?: number,
  fromSlot?: Slot,
  toSlot?: Slot,
  avoid?: Point[][],
};

/** Degrees to radians, for the one place here that needs the card's own frame. */
const RAD = Math.PI / 180;

/** Route clearance from card edges. Must be < 32 (half a grid step) or adjacent
 *  cards lose the corridor between them. */
export const CLEARANCE = 22;

/** Tighter margin for string-pull — search finds the corridor generously,
 *  pull tests tightly. Split because one number would make clearance and
 *  tautness pull opposite ways. */
export const PULL_CLEARANCE = CLEARANCE / 2;

/** Straight run out of a card before a turn is allowed. Must be < CLEARANCE. */
export const STUB = 20;

/** Softish curve handle as a fraction of the endpoint separation — the flowing
 *  bow the mockup settled on. Shared so a settled direct line and the straight
 *  drag preview (straightSeg in canvas/web.ts) draw the same curve. */
export const DRAG_HANDLE = 0.4;

/** Fraction of face the fan of arriving lines may spread across. */
const SPREAD = 0.66;

/** Valid shape values. Unknown → default ('square'). 'curve' routes as 'square'
 *  and is drawn as a spline — see pathData()'s curve flag and look() in canvas/web.ts. */
const SHAPES = new Set(['square', 'grid', 'taut', 'curve']);

/** Cost of one bend in world units. A route will detour up to 60 units to avoid a corner. */
export const TURN_COST = 60;

/** Running along an existing line costs this multiple of distance. Crossings are free. */
export const OVERLAP_COST = 4;

/** Max full A* searches during face escalation (cheap L is tried on all 16 pairs). */
const MAX_FACE_SEARCHES = 6;

/** Max obstacles per route. Past this, nearest are kept and the rest dropped. */
export const MAX_OBSTACLES = 40;

/** Max lattice nodes. Below what MAX_OBSTACLES can build, so shedding actually triggers. */
const MAX_NODES = 4000;

// Tolerance for float lattice comparisons.
const EPS = 1e-3;

/** The axis-aligned box around an item, rotation included, grown by `pad`. */
export function blockOf(it: Box, pad = 0): Bounds {
  const { hw, hh } = rotatedExtents(it);
  return {
    x0: it.x - hw - pad, y0: it.y - hh - pad,
    x1: it.x + hw + pad, y1: it.y + hh + pad,
  };
}

/** Does an axis-aligned segment pass through a block's interior?
 *  Unlike segmentMeetsRect, running *along* an edge is allowed (lattice uses those). */
function segmentBlocked(ax: number, ay: number, bx: number, by: number, b: Bounds) {
  if (ay === by) {
    if (ay <= b.y0 + EPS || ay >= b.y1 - EPS) return false;
    return Math.min(ax, bx) < b.x1 - EPS && Math.max(ax, bx) > b.x0 + EPS;
  }
  if (ax <= b.x0 + EPS || ax >= b.x1 - EPS) return false;
  return Math.min(ay, by) < b.y1 - EPS && Math.max(ay, by) > b.y0 + EPS;
}

/** Sorted, with values closer together than EPS collapsed into one line. */
function lattice(values: number[]) {
  const sorted = [...values].sort((p, q) => p - q);
  const out: number[] = [];
  for (const v of sorted) {
    if (!out.length || v - out[out.length - 1] > EPS) out.push(v);
  }
  return out;
}

/** Face of a card. Axis+direction, not compass — works in both y-down and y-up. */
type Side = 'x+' | 'x-' | 'y+' | 'y-';

const OPPOSITE: Record<Side, Side> = { 'x+': 'x-', 'x-': 'x+', 'y+': 'y-', 'y-': 'y+' };

/** Anchor on a named face, spread by slot so multiple lines fan out. */
function faceAnchor(from: Box, side: Side, slot: Slot = MIDDLE): Anchor {
  const box = blockOf(from);
  // 0 for single-line case → identical to pre-slot behaviour.
  const t = (slot.index + 1) / (slot.count + 1) - 0.5;
  if (side === 'x+' || side === 'x-') {
    const x = side === 'x+' ? box.x1 : box.x0;
    const y = from.y + t * (box.y1 - box.y0) * SPREAD;
    return { edge: { x, y }, stub: { x: side === 'x+' ? x + STUB : x - STUB, y } };
  }
  const y = side === 'y+' ? box.y1 : box.y0;
  const x = from.x + t * (box.x1 - box.x0) * SPREAD;
  return { edge: { x, y }, stub: { x, y: side === 'y+' ? y + STUB : y - STUB } };
}

/** Four ways out of `from` towards `to`, dominant-axis face first.
 *  All four tried so a card blocking the preferred face does not seal the route. */
export function anchorsFor(from: Box, to: Point, slot?: Slot): Anchor[] {
  const dx = to.x - from.x;
  const dy = to.y - from.y;
  const sideways: Side = dx >= 0 ? 'x+' : 'x-';
  const upright: Side = dy >= 0 ? 'y+' : 'y-';
  const near: Side[] = Math.abs(dx) >= Math.abs(dy)
    ? [sideways, upright]
    : [upright, sideways];
  const sides = [...near, ...near.map(s => OPPOSITE[s])];
  return sides.map(s => faceAnchor(from, s, slot));
}

/** Dominant-axis anchor only (anchorsFor()[0]). */
export const anchorFor = (from: Box, to: Point): Anchor => anchorsFor(from, to)[0];

/** Best face pair for a straight, unrouted line — any side to any side. Scores
 *  every face pairing by distance plus a turn charge for a face that does not
 *  point the way the line runs (the same rule the curve router uses, minus the
 *  obstacle search), so a drag line leaves the faces that face each other, not a
 *  locked left/right or top/bottom pair. Returns the two edge points and their
 *  outward face normals. */
export function bestFaces(from: Box, to: Box): { a: Point, b: Point, na: Point, nb: Point } {
  const as = anchorsFor(from, to);
  const bs = anchorsFor(to, from);
  let best: { a: Anchor, b: Anchor, na: Point, nb: Point, cost: number } | null = null;
  for (const ai of as) {
    const dirA = unit(ai.stub.x - ai.edge.x, ai.stub.y - ai.edge.y);
    for (const bj of bs) {
      const dirB = unit(bj.stub.x - bj.edge.x, bj.stub.y - bj.edge.y);
      const dx = bj.edge.x - ai.edge.x, dy = bj.edge.y - ai.edge.y;
      const dist = Math.hypot(dx, dy) || 1;
      const u = unit(dx, dy);
      const cost = dist + TURN_COST *
        ((1 - dirA.x * u.x - dirA.y * u.y) + (1 + dirB.x * u.x + dirB.y * u.y));
      if (!best || cost < best.cost) best = { a: ai, b: bj, na: dirA, nb: dirB, cost };
    }
  }
  return { a: best!.a.edge, b: best!.b.edge, na: best!.na, nb: best!.nb };
}

/** Unit outward normal of the face `from` shows `to` — the axis the dominant
 *  separation picks, the same one anchorsFor() leaves by. The Softish spline
 *  exits along it, so a line leaves its card square to the face. */
export function portDir(from: Box, to: Box): Point {
  const dx = to.x - from.x, dy = to.y - from.y;
  return Math.abs(dx) >= Math.abs(dy)
    ? { x: Math.sign(dx || 1), y: 0 }
    : { x: 0, y: Math.sign(dy || 1) };
}

/** Where the centre→target ray exits the card's *rotated* rectangle (not the AABB).
 *  Used for taut lines so endpoints land on the drawn edge, not the bounding box. */
export function exitTowards(it: Box, target: Point): Point {
  const dx = target.x - it.x;
  const dy = target.y - it.y;
  if (!dx && !dy) return { x: it.x, y: it.y };
  // The ray in the card's own frame, where the walls are the two half-extents.
  // Only its direction matters: a rotation preserves length, so the scale that
  // lands on a wall in there is the scale that lands on it out here.
  const rad = (it.rot || 0) * RAD;
  const c = Math.cos(rad);
  const s = Math.sin(rad);
  const lx = dx * c + dy * s;
  const ly = dy * c - dx * s;
  const tx = Math.abs(lx) > EPS ? (it.w / 2) / Math.abs(lx) : Infinity;
  const ty = Math.abs(ly) > EPS ? (it.h / 2) / Math.abs(ly) : Infinity;
  const t = Math.min(tx, ty);
  return { x: it.x + dx * t, y: it.y + dy * t };
}

/** A card endpoint. `bare` = no card drawn (logo/cutout), changes endpoint placement. */
export type End = Box & { bare?: boolean };

/** Endpoint: outline for a card, centre for a bare item (line hides under subject). */
export const endOf = (card: End, target: Point): Point =>
  card.bare ? { x: card.x, y: card.y } : exitTowards(card, target);

/** Extend a routed path to the centre of bare ends (the face point stays — dropping
 *  it would create an unchecked diagonal). */
export function intoMiddles(points: Point[], a: End, b: End): Point[] {
  if (!a.bare && !b.bare) return points;
  const out = points.slice();
  if (a.bare) out.unshift({ x: a.x, y: a.y });
  if (b.bare) out.push({ x: b.x, y: b.y });
  return out;
}

/** A finished route. `ends`, when present, are the outward face normals at the two
 *  endpoints — the Softish spline leaves and enters along them. */
export type Route = { points: Point[], ends?: [Point, Point] };

/** Route a connection around obstacles. Tries clearance rungs, face escalation,
 *  and falls back to an orthogonal elbow (goes behind cards, never a diagonal). */
export function routeConnection(
  from: Box, to: Box, obstacles: Box[] = [], opts: RouteOpts = {},
): Route {
  // Absent opts → default at every field.
  const shape = opts.shape && SHAPES.has(opts.shape) ? opts.shape : 'square';
  // 'curve' takes a direct node-editor cubic when the run is clear (the short-
  // circuit below) and the orthogonal route otherwise, so every line leaves and
  // enters its card on a perpendicular stub — never aimed diagonally like taut.
  // canvas/web.ts draws that orthogonal path as a spline with capped handles.
  const taut = shape === 'taut';
  const clearance = opts.clearance && opts.clearance > 0 ? opts.clearance : CLEARANCE;
  // Only 'grid' quantizes, and only with a positive step.
  const step = shape === 'grid' && opts.step && opts.step > 0 ? opts.step : 0;

  // Four ways out of each end; other 15 pairs are escalation at the bottom.
  const as = anchorsFor(from, to, opts.fromSlot);
  const bs = anchorsFor(to, from, opts.toSlot);
  const a = as[0];
  const b = bs[0];

  // Other lines already drawn (empty = no overlap avoidance).
  const avoid = segmentsOf(opts.avoid);

  // Nearest first — cap drops the least relevant cards.
  const near = obstacles.length <= MAX_OBSTACLES ? obstacles : [...obstacles]
    .sort((p, q) => distSqToMidpoint(p, from, to) - distSqToMidpoint(q, from, to))
    .slice(0, MAX_OBSTACLES);

  // End cards are obstacles with no margin (or stubs would be inside their blocks).
  const ends = [blockOf(from), blockOf(to)];

  // Nearest-first once (skip if cap already sorted).
  const ordered = obstacles.length <= MAX_OBSTACLES
    ? [...near].sort((p, q) => distSqToMidpoint(p, from, to) - distSqToMidpoint(q, from, to))
    : near;

  /** A card list's blocks at a given margin, on the lattice or off it. */
  const blocksOf = (cards: Box[], pad: number, snap: boolean) => cards.map(it => {
    const k = blockOf(it, pad);
    return snap && step ? snapOut(k, step) : k;
  });

  /** The same, over every card this route is considering. */
  const blocksAt = (pad: number, snap: boolean) => blocksOf(ordered, pad, snap);

  /** Pull then aim for taut shape; no-op otherwise. Uses PULL_CLEARANCE, not search margin. */
  const done = (points: Point[], cards: Box[], pad: number, snap: boolean) => {
    if (!taut) return { points };
    const soft = blocksOf(cards, Math.min(pad, PULL_CLEARANCE), snap);
    return { points: aim(pull(points, [...soft, ...ends]), soft) };
  };

  /** Re-aim endpoints at exitTowards if the new segment is still clear. */
  const aim = (points: Point[], obstacles: Bounds[]) => {
    if (points.length < 2) return points;
    const last = points.length - 1;
    const head = exitTowards(from, points[1]);
    if (!crosses(head, points[1], obstacles)) points[0] = head;
    const tail = exitTowards(to, points[last - 1]);
    if (!crosses(tail, points[last - 1], obstacles)) points[last] = tail;
    return points;
  };

  // Curve: leave and enter each card square to its face (edge → stub), and when
  // the straight run between the two faces is clear, join them directly — the
  // spline pathData() draws through these four points is the flowing S the
  // Softish tier wants. Anything in the way falls through to the orthogonal
  // search below, whose right-angle path the same spline rounds into an arch.
  if (shape === 'curve') {
    // Any side of one card may meet any side of the other. Try all sixteen face
    // pairs, draw the node-editor cubic each would make, keep the ones that clear
    // every card, and take the cheapest — short, and leaving each face square to
    // it. This is what lets a diagonal pair leave one card's side and enter the
    // other's top, instead of forcing both ends onto one shared axis.
    const avoid = [...blocksAt(clearance, false), ...ends];
    // The two end cards, grown by a small margin: the curve's middle keeps off
    // them, so a face that wraps the curve around its own card's corner loses.
    // Small on purpose — the full clearance rejects the natural short curve
    // between two cards that sit close, sending it the long way round.
    const ownEnds = [blockOf(from, 12), blockOf(to, 12)];
    // Fast path: the natural facing pair — the exact faces the drag preview shows
    // (bestFaces: distance and turn, no obstacle bias, no handle term). If its
    // cubic clears every card, take it, so a settled line matches the one drawn in
    // motion. Only a card genuinely in the way pushes to the sixteen-pair search
    // below, whose handle-cost tiebreak would otherwise favour a backward face that
    // happens to need a smaller handle over the clean pair the eye expects.
    // Judged at the base clearance, not the Softish surplus: forgiving the extra
    // curve room (never letting a line hug) keeps a near-miss on the natural line
    // instead of throwing it into a backward arch to save a few pixels.
    const nearMiss = [...blocksAt(Math.min(clearance, CLEARANCE), false), ...ends];
    const nat = bestFaces(from, to);
    const natDist = Math.hypot(nat.b.x - nat.a.x, nat.b.y - nat.a.y) || 1;
    // Largest handle first — the full, flowing curve the drag preview draws
    // (DRAG_HANDLE·dist), stepping down only if that bow would clip a card. The
    // 16-pair search below wants the *smallest* clearing handle instead, so a
    // forced dodge stays tight; here the eye wants the generous one.
    for (const s of [DRAG_HANDLE, 0.3, 0.2, 0.12, 0.08]) {
      const h = s * natDist;
      if (cubicClear(nat.a, nat.na, h, nat.b, nat.nb, h, nearMiss, ownEnds)) {
        return { points: [nat.a, nat.b],
          ends: [{ x: nat.na.x * h, y: nat.na.y * h }, { x: nat.nb.x * h, y: nat.nb.y * h }] };
      }
    }
    // Always the middle of each side, never a fanned-out slot: every line leaves
    // and enters at a face centre.
    const mas = anchorsFor(from, to);
    const mbs = anchorsFor(to, from);
    // `ends` is a handle *vector* per endpoint (direction and length), so the
    // drawn curve is fixed by the router — see curveData().
    let best: { pts: [Point, Point], ends: [Point, Point], cost: number } | null = null;
    for (const ai of mas) {
      const dirA = unit(ai.stub.x - ai.edge.x, ai.stub.y - ai.edge.y);
      for (const bj of mbs) {
        const dirB = unit(bj.stub.x - bj.edge.x, bj.stub.y - bj.edge.y);
        const dx = bj.edge.x - ai.edge.x, dy = bj.edge.y - ai.edge.y;
        const dist = Math.hypot(dx, dy) || 1;
        // The smallest handle that clears: a nearly-straight line arches barely,
        // never with a fixed fraction that loops a whole board for a 30px dodge.
        let h = 0;
        for (const s of [0.08, 0.14, 0.22, 0.32, 0.45]) {
          if (cubicClear(ai.edge, dirA, s * dist, bj.edge, dirB, s * dist, avoid, ownEnds)) {
            h = s * dist;
            break;
          }
        }
        if (!h) continue;
        const u = unit(dx, dy);
        // Distance, a charge for the arch it needed, and a turn charge for a face
        // that does not point the way the line runs. The straight-facing pair wins
        // unless a card is in its way, and the tidiest dodge wins among the rest.
        const cost = dist + h + TURN_COST *
          ((1 - dirA.x * u.x - dirA.y * u.y) + (1 + dirB.x * u.x + dirB.y * u.y));
        if (!best || cost < best.cost) {
          best = { pts: [ai.edge, bj.edge], ends: [{ x: dirA.x * h, y: dirA.y * h },
            { x: dirB.x * h, y: dirB.y * h }], cost };
        }
      }
    }
    if (best) return { points: best.pts, ends: best.ends };
    // No face pair draws a clear cubic: route orthogonally (it escalates faces on
    // its own), pull it straight, and take the exit normals from the route's ends.
    // Middle anchors here too, so the fallback also leaves from a face centre.
    const orth = routeConnection(from, to, obstacles,
      { ...opts, shape: 'square', fromSlot: undefined, toSlot: undefined }).points;
    // Pull at the full clearance, not the tighter PULL_CLEARANCE: straightening
    // the path must not drag it back in to hug a card it was meant to keep off.
    const pulled = orth.length <= 2 ? orth
      : pull(orth, [...blocksOf(ordered, clearance, false), ...ends]);
    const m = pulled.length;
    const dd = Math.hypot(to.x - from.x, to.y - from.y) || 1;
    const hh = 0.2 * dd;
    const nA = unit(pulled[1].x - pulled[0].x, pulled[1].y - pulled[0].y);
    const nB = unit(pulled[m - 2].x - pulled[m - 1].x, pulled[m - 2].y - pulled[m - 1].y);
    return { points: pulled, ends: [{ x: nA.x * hh, y: nA.y * hh }, { x: nB.x * hh, y: nB.y * hh }] };
  }

  // Orthogonal best-face selection (Middle and Harsh): any side may meet any side.
  // Try every face pair's elbow, keep the ones that clear every card, and take the
  // shortest. Only when none is clear does it fall through to the ladder and A*.
  if (shape === 'square' || shape === 'grid') {
    const withEnds = [...blocksAt(clearance, false), ...ends];
    let pick: { points: Point[], cost: number } | null = null;
    for (const ai of as) {
      for (const bj of bs) {
        const l = simple(ai, bj, withEnds);
        if (!l || laidOn(l.points, avoid)) continue;
        let len = 0;
        for (let i = 1; i < l.points.length; i++) {
          len += Math.abs(l.points[i].x - l.points[i - 1].x)
            + Math.abs(l.points[i].y - l.points[i - 1].y);
        }
        const cost = len + Math.max(0, l.points.length - 2) * TURN_COST;
        if (!pick || cost < pick.cost) pick = { points: l.points, cost };
      }
    }
    if (pick) return done(pick.points, ordered, clearance, true);
  }

  // Taut: try a straight line first (no stubs, no bends).
  if (taut) {
    const straight = [exitTowards(from, to), exitTowards(to, from)];
    // Exclude the two ends — a point on a leaning card's outline is inside its AABB,
    // and a convex rectangle guarantees the ray cannot re-enter.
    if (!crosses(straight[0], straight[1], blocksAt(clearance, false))) {
      return { points: straight };
    }
  }

  // Two-bend L path — the answer on most boards, before building a lattice.
  const easyBlocks = blocksAt(clearance, true);
  const easy = simple(a, b, [...easyBlocks, ...ends]);
  // Reject if it overlaps an existing line — hand to the search which can price it.
  if (easy && !laidOn(easy.points, avoid)) return done(easy.points, ordered, clearance, true);

  // Concession ladder — give up room before giving up the route:
  //   1. full clearance  2. a third  3. zero  4. zero minus overlapping cards
  //   5. all 16 face pairs (cheap L, then lattice up to MAX_FACE_SEARCHES).
  const overlapsEnd = (k: Bounds) => ends.some(e =>
    k.x0 < e.x1 - EPS && k.x1 > e.x0 + EPS && k.y0 < e.y1 - EPS && k.y1 > e.y0 + EPS);

  const attempt = (pool: Bounds[], a: Anchor, b: Anchor) => {
    // End cards' edges in the lattice too — lets routes escape under overlapping cards.
    let all = [...pool, ...ends];
    let xs = lattice([a.edge.x, a.stub.x, b.edge.x, b.stub.x, ...all.flatMap(k => [k.x0, k.x1])]);
    let ys = lattice([a.edge.y, a.stub.y, b.edge.y, b.stub.y, ...all.flatMap(k => [k.y0, k.y1])]);
    // Too big → shed furthest cards rather than give up.
    while (xs.length * ys.length > MAX_NODES && pool.length) {
      pool = pool.slice(0, pool.length - 1);
      all = [...pool, ...ends];
      xs = lattice([a.edge.x, a.stub.x, b.edge.x, b.stub.x, ...all.flatMap(k => [k.x0, k.x1])]);
      ys = lattice([a.edge.y, a.stub.y, b.edge.y, b.stub.y, ...all.flatMap(k => [k.y0, k.y1])]);
    }
    if (xs.length * ys.length > MAX_NODES) return null;

    const xi = xs.indexOf(nearestIn(xs, a.stub.x));
    const yi = ys.indexOf(nearestIn(ys, a.stub.y));
    const xj = xs.indexOf(nearestIn(xs, b.stub.x));
    const yj = ys.indexOf(nearestIn(ys, b.stub.y));

    const path = search(xs, ys, all, xi, yi, xj, yj, avoid);
    if (!path) return null;
    // Stubs bracket the search's answer, edges bracket the stubs; trim()
    // sheds the duplicate when a stub lands exactly on a lattice node.
    return { points: trim([a.edge, a.stub, ...path, b.stub, b.edge]) };
  };

  // Snapped attempt is its own rung above the ladder (quantizing can close corridors).
  const rungs: [number, boolean][] = step
    ? [[clearance, true], [clearance, false], [clearance / 3, false], [0, false]]
    : [[clearance, false], [clearance / 3, false], [0, false]];

  for (const [pad, snap] of rungs) {
    const pool = blocksAt(pad, snap);
    const got = attempt(pool, a, b);
    if (got) return done(got.points, ordered, pad, snap);
  }
  // Filter cards, not blocks — done() rebuilds blocks at its own margin.
  const uncovered = ordered.filter(it => !overlapsEnd(blockOf(it)));
  if (uncovered.length !== ordered.length) {
    const got = attempt(blocksOf(uncovered, 0, false), a, b);
    if (got) return done(got.points, uncovered, 0, false);
  }

  // Rung five: the other fifteen ways out, ordered by `i + j` so giving up
  // one end's preferred face is tried before giving up both.
  const pairs: [number, number][] = [];
  for (let sum = 1; sum <= 6; sum++) {
    for (let i = 0; i < 4; i++) {
      const j = sum - i;
      if (j >= 0 && j < 4) pairs.push([i, j]);
    }
  }
  let searches = 0;
  // No snapping - quantizing was given up long before this rung.
  const faceRungs: [number, boolean][] = [[clearance, false], [0, false]];
  for (const [pad, snap] of faceRungs) {
    const pool = blocksOf(ordered, pad, snap);
    const withEnds = [...pool, ...ends];
    // Cheap L on every pair before building a lattice.
    for (const [i, j] of pairs) {
      const got = simple(as[i], bs[j], withEnds);
      if (got && !laidOn(got.points, avoid)) return done(got.points, ordered, pad, snap);
    }
    for (const [i, j] of pairs) {
      if (searches >= MAX_FACE_SEARCHES) break;
      searches++;
      const got = attempt(pool, as[i], bs[j]);
      if (got) return done(got.points, ordered, pad, snap);
    }
  }

  // Even the elbow gets the taut pass — a straight run between its corners may be clear.
  return done(elbow(a, b), ordered, clearance, false);
}

/** Grow block outward to grid step — never inward, or the clearance margin is spent. */
function snapOut(k: Bounds, step: number): Bounds {
  return {
    x0: Math.floor(k.x0 / step) * step,
    y0: Math.floor(k.y0 / step) * step,
    x1: Math.ceil(k.x1 / step) * step,
    y1: Math.ceil(k.y1 / step) * step,
  };
}

/** Does a segment (any angle) pass through any block's interior?
 *  Taut version of segmentBlocked — inset by EPS so grazing a corner is allowed. */
function crosses(p: Point, q: Point, blocks: Bounds[]) {
  for (const k of blocks) {
    if (k.x1 - k.x0 <= EPS * 2 || k.y1 - k.y0 <= EPS * 2) continue;
    if (segmentMeetsRect(p, q, {
      x0: k.x0 + EPS, y0: k.y0 + EPS, x1: k.x1 - EPS, y1: k.y1 - EPS,
    })) return true;
  }
  return false;
}

/** String-pull: drop every bend the corridor can do without (repeat until stable).
 *  Edge points pinned, stubs not — a taut line leaving at an angle is not sliding along the card. */
function pull(points: Point[], blocks: Bounds[]) {
  if (points.length < 3) return points;
  const out = [...points];
  for (let changed = true; changed && out.length > 2;) {
    changed = false;
    for (let i = 1; i <= out.length - 2; i++) {
      if (crosses(out[i - 1], out[i + 1], blocks)) continue;
      out.splice(i, 1);
      changed = true;
      i--;
    }
  }
  return trim(out);
}

/** One axis-aligned segment of an existing line, for overlap testing. */
type Run = { flat: boolean, at: number, lo: number, hi: number };

/** Flatten other routes into axis-aligned runs (diagonals dropped — measure-zero coincidence). */
function segmentsOf(routes?: Point[][]): Run[] {
  if (!routes?.length) return [];
  const out: Run[] = [];
  for (const points of routes) {
    for (let i = 1; i < points.length; i++) {
      const p = points[i - 1], q = points[i];
      if (Math.abs(p.y - q.y) < EPS && Math.abs(p.x - q.x) > EPS) {
        out.push({ flat: true, at: p.y, lo: Math.min(p.x, q.x), hi: Math.max(p.x, q.x) });
      } else if (Math.abs(p.x - q.x) < EPS && Math.abs(p.y - q.y) > EPS) {
        out.push({ flat: false, at: p.x, lo: Math.min(p.y, q.y), hi: Math.max(p.y, q.y) });
      }
    }
  }
  return out;
}

/** Length of overlap between a segment and existing runs. Zero for crossings (only parallel counts). */
function overlapLen(flat: boolean, at: number, lo: number, hi: number, runs: Run[]) {
  let total = 0;
  for (const r of runs) {
    if (r.flat !== flat || Math.abs(r.at - at) > EPS) continue;
    const span = Math.min(hi, r.hi) - Math.max(lo, r.lo);
    if (span > EPS) total += span;
  }
  return total;
}

/** True if the path overlaps existing lines by more than STUB (threshold, not any overlap). */
function laidOn(points: Point[], runs: Run[]) {
  if (!runs.length) return false;
  for (let i = 1; i < points.length; i++) {
    const p = points[i - 1], q = points[i];
    const flat = Math.abs(p.y - q.y) < EPS;
    const at = flat ? p.y : p.x;
    const lo = flat ? Math.min(p.x, q.x) : Math.min(p.y, q.y);
    const hi = flat ? Math.max(p.x, q.x) : Math.max(p.y, q.y);
    if (hi - lo < EPS) continue;
    if (overlapLen(flat, at, lo, hi, runs) > STUB) return true;
  }
  return false;
}

const nearestIn = (values: number[], v: number) =>
  values.reduce((best, x) => (Math.abs(x - v) < Math.abs(best - v) ? x : best), values[0]);

/** Two-bend L path — the fast check before building a lattice. Null if anything blocks it. */
function simple(a: Anchor, b: Anchor, blocks: Bounds[]) {
  const points = elbow(a, b);
  for (let i = 1; i < points.length; i++) {
    for (const k of blocks) {
      if (segmentBlocked(points[i - 1].x, points[i - 1].y, points[i].x, points[i].y, k)) {
        return null;
      }
    }
  }
  return { points };
}

/** Two-bend path ignoring obstacles — goes behind cards, never diagonally through them. */
function elbow(a: Anchor, b: Anchor) {
  const mid = a.stub.x === a.edge.x
    ? [{ x: a.stub.x, y: b.stub.y }]           // left vertically
    : [{ x: b.stub.x, y: a.stub.y }];          // left sideways
  return trim([a.edge, a.stub, ...mid, b.stub, b.edge]);
}

/** Drop repeated points and points that sit in the middle of a straight run. */
export function trim(points: Point[]) {
  const out: Point[] = [];
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

/** A* over the lattice with turn penalty. State is (node, heading) — four states per node,
 *  because leaving cost depends on arrival heading. Manhattan heuristic, binary heap. */
function search(
  xs: number[], ys: number[], blocks: Bounds[],
  xi: number, yi: number, xj: number, yj: number,
  avoid: Run[] = [],
) {
  const W = xs.length, H = ys.length;
  const N = W * H;
  if (xi < 0 || yi < 0 || xj < 0 || yj < 0) return null;

  // Precompute passability per lattice edge (relaxed from both ends).
  const okRight = new Uint8Array(N);   // node -> the edge to (x+1, y) is clear
  const okDown = new Uint8Array(N);    // node -> the edge to (x, y+1) is clear
  // Overlap cost for lying along already-drawn lines (skipped when nothing to avoid).
  const soft = avoid.length > 0;
  const overRight = soft ? new Float64Array(N) : null;
  const overDown = soft ? new Float64Array(N) : null;
  const at = (x: number, y: number) => y * W + x;
  const clear = (ax: number, ay: number, bx: number, by: number) => {
    for (const k of blocks) if (segmentBlocked(ax, ay, bx, by, k)) return false;
    return true;
  };
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      if (x + 1 < W) {
        const ok = clear(xs[x], ys[y], xs[x + 1], ys[y]);
        okRight[at(x, y)] = ok ? 1 : 0;
        if (ok && overRight) {
          overRight[at(x, y)] = overlapLen(true, ys[y], xs[x], xs[x + 1], avoid) * OVERLAP_COST;
        }
      }
      if (y + 1 < H) {
        const ok = clear(xs[x], ys[y], xs[x], ys[y + 1]);
        okDown[at(x, y)] = ok ? 1 : 0;
        if (ok && overDown) {
          overDown[at(x, y)] = overlapLen(false, xs[x], ys[y], ys[y + 1], avoid) * OVERLAP_COST;
        }
      }
    }
  }

  // 0=right, 1=left, 2=down, 3=up. Start seeded in all four (no "not yet moving" state).
  const STATES = N * 4;
  const g = new Float64Array(STATES).fill(Infinity);
  const from = new Int32Array(STATES).fill(-1);
  const done = new Uint8Array(STATES);
  const open: number[] = [];

  const h = (x: number, y: number) => Math.abs(xs[x] - xs[xj]) + Math.abs(ys[y] - ys[yj]);

  // Binary heap; `f` carried beside state for cheap sift comparisons.
  const fs: number[] = [];
  const push = (s: number, f: number) => {
    let i = open.length;
    open.push(s); fs.push(f);
    while (i > 0) {
      const parent = (i - 1) >> 1;
      if (fs[parent] <= fs[i]) break;
      [open[parent], open[i]] = [open[i], open[parent]];
      [fs[parent], fs[i]] = [fs[i], fs[parent]];
      i = parent;
    }
  };
  const pop = () => {
    const top = open[0];
    // Non-null: heap is non-empty; open/fs pushed and popped together.
    const lastS = open.pop()!, lastF = fs.pop()!;
    if (open.length) {
      open[0] = lastS; fs[0] = lastF;
      let i = 0;
      for (;;) {
        const l = i * 2 + 1, r = l + 1;
        let small = i;
        if (l < open.length && fs[l] < fs[small]) small = l;
        if (r < open.length && fs[r] < fs[small]) small = r;
        if (small === i) break;
        [open[small], open[i]] = [open[i], open[small]];
        [fs[small], fs[i]] = [fs[i], fs[small]];
        i = small;
      }
    }
    return top;
  };

  for (let d = 0; d < 4; d++) {
    const s = at(xi, yi) * 4 + d;
    g[s] = 0;
    push(s, h(xi, yi));
  }

  const goal = at(xj, yj);
  while (open.length) {
    const s = pop();
    if (done[s]) continue;
    done[s] = 1;

    const node = s >> 2;
    const dir = s & 3;
    if (node === goal) return walkBack(xs, ys, W, from, s);

    const x = node % W;
    const y = (node / W) | 0;
    const step = (
      nx: number, ny: number, nd: number, passable: boolean | number, extra: number,
    ) => {
      if (!passable) return;
      const next = at(nx, ny) * 4 + nd;
      if (done[next]) return;
      const cost = Math.abs(xs[nx] - xs[x]) + Math.abs(ys[ny] - ys[y]) +
                   (nd === dir ? 0 : TURN_COST) + extra;
      if (g[s] + cost >= g[next]) return;
      g[next] = g[s] + cost;
      from[next] = s;
      push(next, g[next] + h(nx, ny));
    };
    // Overlap charge stored per edge (lower-indexed end), not per direction.
    step(x + 1, y, 0, x + 1 < W && okRight[at(x, y)], overRight?.[at(x, y)] || 0);
    step(x - 1, y, 1, x - 1 >= 0 && okRight[at(x - 1, y)], x > 0 ? overRight?.[at(x - 1, y)] || 0 : 0);
    step(x, y + 1, 2, y + 1 < H && okDown[at(x, y)], overDown?.[at(x, y)] || 0);
    step(x, y - 1, 3, y - 1 >= 0 && okDown[at(x, y - 1)], y > 0 ? overDown?.[at(x, y - 1)] || 0 : 0);
  }
  return null;
}

function walkBack(xs: number[], ys: number[], W: number, from: Int32Array, end: number) {
  const points: Point[] = [];
  for (let s = end; s >= 0; s = from[s]) {
    const node = s >> 2;
    points.push({ x: xs[node % W], y: ys[(node / W) | 0] });
  }
  return points.reverse();
}

/** SVG `d` for a routed path. Radius clamped to half the shorter run at each corner. */
export function pathData(
  points: Point[], radius = 0, dx = 0, dy = 0, curve = false, ends?: [Point, Point],
) {
  if (!points.length) return '';
  const at = (p: Point) => `${(p.x - dx).toFixed(2)} ${(p.y - dy).toFixed(2)}`;
  if (curve && points.length >= 2) return curveData(points, at, ends);
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

/** Unit vector, or a stable fallback for a zero-length one. */
function unit(x: number, y: number): Point {
  const l = Math.hypot(x, y) || 1;
  return { x: x / l, y: y / l };
}

/** A point on the cubic P0-C1-C2-P1 at parameter t. */
function bezier(p0: Point, c1: Point, c2: Point, p1: Point, t: number): Point {
  const m = 1 - t;
  const a = m * m * m, b = 3 * m * m * t, c = 3 * m * t * t, d = t * t * t;
  return {
    x: a * p0.x + b * c1.x + c * c2.x + d * p1.x,
    y: a * p0.y + b * c1.y + c * c2.y + d * p1.y,
  };
}

/** Does the node-editor cubic from p0 (leaving along dirA) to p1 (leaving along
 *  dirB) miss every block? Sampled — the same cubic curveData() draws, so a curve
 *  that tests clear is drawn clear. `ownEnds`, when given, are the two endpoint
 *  cards grown by the clearance: the curve's middle must keep off them, so a face
 *  that would wrap the curve around its own card's corner is rejected. The ends
 *  themselves are exempt — the curve has to reach the face it starts on. */
function cubicClear(
  p0: Point, dirA: Point, hA: number, p1: Point, dirB: Point, hB: number,
  blocks: Bounds[], ownEnds?: Bounds[],
): boolean {
  const c1 = { x: p0.x + dirA.x * hA, y: p0.y + dirA.y * hA };
  const c2 = { x: p1.x + dirB.x * hB, y: p1.y + dirB.y * hB };
  const STEPS = 16;
  let prev = p0;
  for (let i = 1; i <= STEPS; i++) {
    const t = i / STEPS;
    const pt = bezier(p0, c1, c2, p1, t);
    if (crosses(prev, pt, blocks)) return false;
    if (ownEnds && t > 0.22 && t < 0.78 && crosses(prev, pt, ownEnds)) return false;
    prev = pt;
  }
  return true;
}

/** Handle along a card's face normal, or — with no normal given — along the
 *  dominant axis between the two points. Keeps the fallback (draft, tests) sane. */
function axisHandle(from: Point, toward: Point, h: number): Point {
  const dx = toward.x - from.x, dy = toward.y - from.y;
  return Math.abs(dx) >= Math.abs(dy)
    ? { x: from.x + Math.sign(dx || 1) * h, y: from.y }
    : { x: from.x, y: from.y + Math.sign(dy || 1) * h };
}

/** One cubic leg of the Softish spline: two controls and the point it ends on. */
type Leg = { c1: Point, c2: Point, p: Point };

/** The Softish line as cubic legs, so the drawing (curveData) and the hit test
 *  (curvePoints) are the same curve. `ends` carries each card's outward face
 *  normal (see portDir), so the exit is perpendicular to the face the router
 *  chose, not guessed from the offset. Two points make one node-editor S — level
 *  ends collapse to a straight line, offset ends bow smoothly. A routed detour
 *  (three points or more) is a Catmull-Rom spline, its interior handles capped at
 *  a third of each leg so a bend rounds without bulging back through a card, its
 *  two ends held to the normals. */
function curveLegs(points: Point[], ends?: [Point, Point]): { start: Point, legs: Leg[] } {
  const n = points.length;
  const start = points[0];
  if (n < 2) return { start, legs: [] };
  // `t0`/`tN` are handle *vectors* (direction and length), the router's choice.
  const t0 = ends?.[0], tN = ends?.[1];
  if (n === 2) {
    const p0 = points[0], p1 = points[1];
    if (t0 && tN) {
      return { start, legs: [{
        c1: { x: p0.x + t0.x, y: p0.y + t0.y },
        c2: { x: p1.x + tN.x, y: p1.y + tN.y },
        p: p1,
      }] };
    }
    const h = (Math.hypot(p1.x - p0.x, p1.y - p0.y) || 1) * 0.4;
    return { start, legs: [{ c1: axisHandle(p0, p1, h), c2: axisHandle(p1, p0, h), p: p1 }] };
  }
  const legs: Leg[] = [];
  for (let i = 0; i < n - 1; i++) {
    const p0 = points[i - 1] ?? points[i];
    const p1 = points[i];
    const p2 = points[i + 1];
    const p3 = points[i + 2] ?? p2;
    const cap = (Math.hypot(p2.x - p1.x, p2.y - p1.y) || 1) / 3;
    // A routed end uses its handle vector, capped to a third of the first leg so
    // it does not overshoot; the interior is plain Catmull-Rom.
    const c1 = i === 0 && t0 ? clampHandle(p1, t0, cap) : catmull(p1, p0, p2, cap);
    const c2 = i === n - 2 && tN ? clampHandle(p2, tN, cap) : catmull(p2, p3, p1, cap);
    legs.push({ c1, c2, p: p2 });
  }
  return { start, legs };
}

/** SVG `d` for the Softish spline. */
function curveData(points: Point[], at: (p: Point) => string, ends?: [Point, Point]) {
  if (points.length < 2) return 'M' + at(points[0]);
  const { start, legs } = curveLegs(points, ends);
  let d = 'M' + at(start);
  for (const l of legs) d += 'C' + at(l.c1) + ' ' + at(l.c2) + ' ' + at(l.p);
  return d;
}

/** The Softish spline sampled into a polyline — the geometry the hit test walks,
 *  so the hitbox follows the drawn curve, not the chord under it. */
export function curvePoints(points: Point[], ends?: [Point, Point], steps = 12): Point[] {
  if (points.length < 2) return points.slice();
  const { start, legs } = curveLegs(points, ends);
  const out: Point[] = [start];
  let prev = start;
  for (const l of legs) {
    for (let i = 1; i <= steps; i++) out.push(bezier(prev, l.c1, l.c2, l.p, i / steps));
    prev = l.p;
  }
  return out;
}

/** A handle at `p` along vector `v`, its length capped at `cap`. */
function clampHandle(p: Point, v: Point, cap: number): Point {
  const l = Math.hypot(v.x, v.y) || 1;
  const s = Math.min(1, cap / l);
  return { x: p.x + v.x * s, y: p.y + v.y * s };
}

/** One Catmull-Rom control point: `h` from `here` toward `next`, along the line
 *  through its two neighbours, capped so a sharp bend cannot overshoot. */
function catmull(here: Point, prev: Point, next: Point, cap: number): Point {
  const vx = next.x - prev.x, vy = next.y - prev.y;
  const l = Math.hypot(vx, vy) || 1;
  const h = Math.min(l / 6, cap) / l;
  return { x: here.x + vx * h, y: here.y + vy * h };
}

/** `r` world units from `p` towards `q`. */
function along(p: Point, q: Point, r: number): Point {
  const len = Math.hypot(q.x - p.x, q.y - p.y) || 1;
  return { x: p.x + (q.x - p.x) * r / len, y: p.y + (q.y - p.y) * r / len };
}
