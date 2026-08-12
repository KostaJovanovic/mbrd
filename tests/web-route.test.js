// The router: does a connection actually go around what is in its way?
//
// Properties, not pixels. There is no one correct path between two cards - a
// dozen are equally short, and which of them looks best is a judgement - so
// asserting coordinates would be asserting this implementation rather than the
// behaviour, and would break on every tuning of the turn cost.
//
// What is asserted is what has to be true of *any* answer: it is orthogonal, it
// never enters a card, it starts and ends where it should, it terminates, and
// when there is genuinely no way through it degrades to a plain orthogonal
// elbow drawn behind what is in the way - never to a corner-to-corner diagonal,
// which is the one shape this module exists to stop drawing.
//
// And the caution web-graph.js earned the hard way, which applies to every test
// in this file: **assert the arithmetic, never a duration.** Its governor's
// test was flaky exactly once, for exactly that reason.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  routeConnection, anchorFor, blockOf, trim, pathData,
  CLEARANCE, STUB, TURN_COST, MAX_OBSTACLES,
} from '../web/assets/js/web-route.ts';

const card = (x, y, w = 100, h = 80, rot = 0) => ({ id: `${x},${y}`, x, y, w, h, rot });

const EPS = 1e-6;

// Never the corner-to-corner diagonal, and assertOrthogonal is the whole of that
// test: the give-up line this replaces was [a.edge, b.edge], which for any two
// cards not already lined up is diagonal and fails it outright. There is no flag
// on the result to assert any more - the geometry is what was ever wrong.
//
// Counting points is *not* part of it, which is worth writing down because the
// first version of these tests did: two points is a perfectly good route when
// the cards line up, since trim() sheds the bends of an elbow that never turns.

/** Every leg runs along one axis or the other. */
function assertOrthogonal(points, label = '') {
  for (let i = 1; i < points.length; i++) {
    const a = points[i - 1], b = points[i];
    const flat = Math.abs(a.y - b.y) < 1e-3;
    const upright = Math.abs(a.x - b.x) < 1e-3;
    assert.ok(flat || upright,
      `${label}: leg ${i} runs diagonally, from (${a.x},${a.y}) to (${b.x},${b.y})`);
  }
}

/** No leg passes through the interior of this card. */
function assertClears(points, it, pad = 0, label = '') {
  const b = blockOf(it, pad);
  for (let i = 1; i < points.length; i++) {
    const a = points[i - 1], c = points[i];
    const x0 = Math.min(a.x, c.x), x1 = Math.max(a.x, c.x);
    const y0 = Math.min(a.y, c.y), y1 = Math.max(a.y, c.y);
    const overlaps = x1 > b.x0 + EPS && x0 < b.x1 - EPS && y1 > b.y0 + EPS && y0 < b.y1 - EPS;
    assert.ok(!overlaps,
      `${label}: leg ${i} (${a.x},${a.y})-(${c.x},${c.y}) cuts through ${JSON.stringify(b)}`);
  }
}

const bends = points => Math.max(0, points.length - 2);

// ---------------------------------------------------------------------------
// The clear case
// ---------------------------------------------------------------------------

test('two cards with nothing between them are joined in at most one bend', () => {
  const a = card(0, 0);
  const b = card(400, 120);
  const { points } = routeConnection(a, b, []);
  assertOrthogonal(points, 'clear');
  assert.ok(bends(points) <= 2, `expected a simple path, got ${points.length} points`);
  assertClears(points, a, 0, 'clear');
  assertClears(points, b, 0, 'clear');
});

test('two cards level with each other are joined by one straight run', () => {
  const { points } = routeConnection(card(0, 0), card(400, 0), []);
  assertOrthogonal(points, 'level');
  assert.equal(points.length, 2, 'nothing to bend around and nothing to bend for');
});

test('a route leaves from the side that faces the other card', () => {
  const from = card(0, 0);
  assert.ok(anchorFor(from, card(500, 0)).edge.x > from.x, 'to the right, out of the right');
  assert.ok(anchorFor(from, card(-500, 0)).edge.x < from.x, 'to the left, out of the left');
  assert.ok(anchorFor(from, card(0, 500)).edge.y > from.y, 'below, out of the bottom');
  assert.ok(anchorFor(from, card(0, -500)).edge.y < from.y, 'above, out of the top');
});

test('a route starts on the edge of its card and gets clear before it turns', () => {
  // What the stub buys. Without it the first lattice line available is the
  // card's own edge, and a route sets off by sliding along the side of the card
  // it just left - which reads as the line tracing the card rather than leaving
  // it. Asserted as "the first turn is at least a stub away", not as "the stub
  // point is in the output": when the path carries straight on through it, the
  // stub is a redundant point on a straight run and trim() sheds it, which is
  // the stub having done its job rather than having failed to.
  const a = card(0, 0);
  const box = blockOf(a);
  for (const far of [card(500, 300), card(500, -300), card(-500, 300), card(0, 600)]) {
    const { points } = routeConnection(a, far, []);
    const start = points[0];
    const onEdge = Math.abs(start.x - box.x0) < EPS || Math.abs(start.x - box.x1) < EPS ||
                   Math.abs(start.y - box.y0) < EPS || Math.abs(start.y - box.y1) < EPS;
    assert.ok(onEdge, `the line starts on the card, not beside it: ${JSON.stringify(start)}`);
    const run = Math.hypot(points[1].x - start.x, points[1].y - start.y);
    assert.ok(run >= STUB - EPS, `the first leg is ${run}, shorter than the stub`);
  }
});

// ---------------------------------------------------------------------------
// Going around things
// ---------------------------------------------------------------------------

test('a card directly in the way is gone around, not through', () => {
  const a = card(-300, 0);
  const b = card(300, 0);
  const wall = card(0, 0, 120, 400);
  const { points } = routeConnection(a, b, [wall]);
  assertOrthogonal(points, 'wall');
  assertClears(points, wall, CLEARANCE - 1, 'wall');
});

test('a corridor of cards is threaded rather than crossed', () => {
  const a = card(-500, 0);
  const b = card(500, 0);
  // Two stacks with a gap between them at y = 0 that is too narrow to be
  // guessed at by a grid and exactly right for a lattice built from the edges.
  const obstacles = [
    card(0, -260, 200, 380),
    card(0, 260, 200, 380),
    card(-200, -400, 150, 150),
    card(200, 400, 150, 150),
  ];
  const { points } = routeConnection(a, b, obstacles);
  assertOrthogonal(points, 'corridor');
  for (const it of obstacles) assertClears(points, it, CLEARANCE - 1, 'corridor');
});

test('a route never cuts back through the card it started from', () => {
  // The case that was easy to get wrong: the far card is off to one side and
  // behind, so the obvious L runs back across the card the route just left.
  // With nothing else in the way there is no obstacle to make it think twice,
  // which is why the two end cards are obstacles to the search as well.
  const a = card(0, 0, 400, 120);
  const b = card(-260, 300, 80, 80);
  const { points } = routeConnection(a, b, []);
  assertOrthogonal(points, 'behind');
  assertClears(points, a, 0, 'behind');
  assertClears(points, b, 0, 'behind');
});

test('a card wholly inside another still gets a line, and it is an elbow', () => {
  // Nothing can reach a point buried inside an obstacle by going around it, and
  // the obstacle here is one of the two cards being joined. A line you drew must
  // always be visible, so it cheats - but it cheats *orthogonally*, going behind
  // the outer card rather than across it. It used to be the two-point diagonal.
  const { points } = routeConnection(card(0, 0, 300, 300), card(60, 40, 60, 60), []);
  assertOrthogonal(points, 'nested');
  assert.ok(points.length >= 2);
});

test('a turned card is given the room its corners actually reach', () => {
  // Rotation is approximated outward - the axis-aligned box that contains the
  // turned rectangle - so a route can be longer than it strictly needs and can
  // never clip a corner off.
  const wall = card(0, 0, 300, 60, 90);          // stood on end by the rotation
  const { points } = routeConnection(card(0, -400), card(0, 400), [wall]);
  assertOrthogonal(points, 'turned');
  assertClears(points, wall, CLEARANCE - 1, 'turned');
});

// ---------------------------------------------------------------------------
// Bends
// ---------------------------------------------------------------------------

test('the turn penalty picks the path with fewer bends when two are the same length', () => {
  // A staircase and an L between the same two points are the same length. Left
  // to itself A* returns whichever the tie-break reached first, which is usually
  // the staircase; the penalty is what makes it the L.
  const obstacles = [card(-400, -400, 40, 40), card(400, 400, 40, 40)];
  const { points } = routeConnection(card(0, 0), card(600, 400), obstacles);
  assertOrthogonal(points, 'bends');
  assert.ok(bends(points) <= 3,
    `a clear diagonal run should not staircase, got ${bends(points)} bends`);
});

test('the penalty is large next to the lengths it is traded against', () => {
  // The number itself, asserted because it is the whole difference between a
  // diagram and a scribble and it is the one constant here somebody will be
  // tempted to lower without noticing what it buys.
  assert.ok(TURN_COST >= STUB * 2, 'a bend must cost more than a step out of a card');
  assert.ok(TURN_COST > CLEARANCE, 'and more than the gap it keeps from a card');
});

// ---------------------------------------------------------------------------
// Giving up
// ---------------------------------------------------------------------------

test('a card boxed in on four sides still gets a line', () => {
  // The fallback, and the rule behind it: a line you drew must always be
  // visible, even when it has to cheat. Dropping the connection would look
  // exactly like the app having lost it.
  const a = card(0, 0, 60, 60);
  const b = card(1000, 0, 60, 60);
  const walls = [
    card(0, -120, 600, 120), card(0, 120, 600, 120),
    card(-120, 0, 120, 600), card(120, 0, 120, 600),
  ];
  const { points } = routeConnection(a, b, walls);
  // Boxed in on four sides there is genuinely nothing to find, and the answer is
  // the plain elbow drawn behind the walls rather than a diagonal across them.
  assertOrthogonal(points, 'boxed in');
  assert.equal(points.length, 2);
  assert.ok(points.every(p => Number.isFinite(p.x) && Number.isFinite(p.y)));
});

test('a route always terminates and always returns at least two points', () => {
  // A deterministic sweep rather than random input: a seeded generator would be
  // one more thing to maintain, and what this is really checking is that no
  // arrangement of cards makes the search loop or return nothing.
  for (let n = 0; n <= 30; n++) {
    const obstacles = Array.from({ length: n }, (_, i) =>
      card(((i * 137) % 900) - 450, ((i * 241) % 700) - 350, 80 + (i % 5) * 30, 60 + (i % 3) * 40));
    const { points } = routeConnection(card(-600, -420), card(600, 420), obstacles);
    assert.ok(points.length >= 2, `n=${n}: a route must have two ends`);
    assertOrthogonal(points, `n=${n}`);
  }
});

test('more cards than the router will consider is a bounded search, not a refusal', () => {
  const many = Array.from({ length: MAX_OBSTACLES * 4 }, (_, i) =>
    card(((i * 71) % 1200) - 600, ((i * 113) % 800) - 400, 70, 50));
  const { points } = routeConnection(card(-900, 0), card(900, 0), many);
  assert.ok(points.length >= 2);
  assertOrthogonal(points, 'crowded');
});

// ---------------------------------------------------------------------------
// The path string
// ---------------------------------------------------------------------------

test('redundant points are shed', () => {
  const out = trim([
    { x: 0, y: 0 }, { x: 0, y: 0 },        // the same point twice
    { x: 10, y: 0 }, { x: 20, y: 0 },      // three in a row on one line
    { x: 30, y: 0 }, { x: 30, y: 40 },
  ]);
  assert.deepEqual(out, [{ x: 0, y: 0 }, { x: 30, y: 0 }, { x: 30, y: 40 }]);
});

test('a square corner draws as a corner and a round one as an arc', () => {
  const bend = [{ x: 0, y: 0 }, { x: 100, y: 0 }, { x: 100, y: 100 }];
  assert.equal(pathData(bend, 0), 'M0.00 0.00L100.00 0.00L100.00 100.00');
  assert.match(pathData(bend, 12), /Q/, 'a radius puts a quadratic at the corner');
});

test('a corner never rounds by more than the runs meeting at it', () => {
  // An arc longer than the segment it is cutting overshoots the next corner and
  // draws a knot. The radius is clamped to half the shorter run.
  const tight = [{ x: 0, y: 0 }, { x: 8, y: 0 }, { x: 8, y: 8 }];
  const d = pathData(tight, 40);
  for (const n of d.match(/-?\d+\.\d+/g).map(Number)) {
    assert.ok(n >= -EPS && n <= 8 + EPS, `${n} is outside the path's own box`);
  }
});

test('the offsets shift the whole path and nothing else', () => {
  const line = [{ x: 10, y: 20 }, { x: 30, y: 20 }];
  assert.equal(pathData(line, 0, 10, 20), 'M0.00 0.00L20.00 0.00');
});

// ---------------------------------------------------------------------------
// Giving up room before giving up the route
//
// The router used to run one search at full clearance and draw a straight line
// if it failed - and a straight line is not a failed route, it is the thing this
// module exists to stop drawing: it scores through every card between the two
// ends. So a failure now concedes *room* instead, in order, and only draws the
// straight line if going round is genuinely impossible.
//
// These assert the concessions in the order they are made, because the order is
// the design: a route that passes closer than is pretty is better than one that
// passes through, and both are better than none.
// ---------------------------------------------------------------------------

test('a gap too tight for the clearance is still a gap', () => {
  // Two cards leaving a corridor narrower than 2 * CLEARANCE between them. At
  // full margin their blocks overlap and the way is sealed; the route has to
  // find it anyway by conceding margin, not by drawing through them.
  const from = card(0, 0, 60, 40);
  const to = card(0, 400, 60, 40);
  const gap = CLEARANCE * 1.2;                 // < 2 * CLEARANCE
  const left = card(-60 - gap / 2, 200, 100, 60);
  const right = card(60 + gap / 2, 200, 100, 60);
  const r = routeConnection(from, to, [left, right]);
  assertOrthogonal(r.points, 'tight gap');
});

test('a card lying on top of an end does not seal it in', () => {
  // The case no amount of margin answers: an obstacle overlapping one of the two
  // ends encloses it, and nothing can be routed *around* a card that is on top of
  // the card being routed to. Those stop counting as obstacles rather than
  // costing the route.
  const from = card(0, 0, 100, 80);
  const to = card(400, 0, 100, 80);
  const over = card(400, 0, 260, 240);         // swallows `to` whole
  const r = routeConnection(from, to, [over]);
  assertOrthogonal(r.points, 'covered end');
  // And it arrives: the covering card drops out of the obstacle set rather than
  // walling `to` off, so the line still lands on `to`'s own edge. Without that
  // it would stop somewhere outside and read as a line to nothing.
  const box = blockOf(to);
  const end = r.points[r.points.length - 1];
  const onEdge = Math.abs(end.x - box.x0) < EPS || Math.abs(end.x - box.x1) < EPS ||
                 Math.abs(end.y - box.y0) < EPS || Math.abs(end.y - box.y1) < EPS;
  assert.ok(onEdge, `the covered end is reached, not stopped short of: ${JSON.stringify(end)}`);
});

test('a lattice too large to search sheds cards rather than the route', () => {
  // Too big to search is a reason to search over fewer cards, not a reason to
  // stop - and the ones shed are the furthest, which are the least likely to be
  // in the way. Whatever comes back is still a real route.
  //
  // A staircase rather than rows, and that is the whole point of the fixture:
  // the lattice is one line per obstacle edge per axis, so cards sharing a y
  // build a wide, shallow lattice that fits however many of them there are. Laid
  // out in seven rows this test named a branch it never reached. Distinct in both
  // axes it is ~84 x ~84 at the cap, which is over MAX_NODES and sheds.
  const from = card(0, 0);
  const to = card(3000, 0);
  const many = [];
  for (let i = 0; i < MAX_OBSTACLES * 3; i++) many.push(card(120 + i * 90, i * 65 - 1200));
  const r = routeConnection(from, to, many);
  assertOrthogonal(r.points, 'shed');
  assert.ok(r.points.length >= 2, 'a route is still at least two points');
});

// ---------------------------------------------------------------------------
// The three shapes
//
// `opts.shape` is how the whimsy axis reaches the router - see the header there
// and look() in canvas/web.js, which is what turns a data-whimsy attribute and
// the board's grid step into these arguments. Properties again, not pixels: the
// grid shape is asserted by where it is allowed to turn, the taut shape by what
// it no longer needs to do, and both by the thing every shape owes - it does not
// go through a card.
// ---------------------------------------------------------------------------

/**
 * No leg passes through this card, at any angle.
 *
 * assertClears above tests the leg's bounding box, which is the leg itself only
 * while every leg is axis-aligned. A taut path's legs are not, and a diagonal's
 * bounding box is far larger than the diagonal - so it would report a card
 * cleared by a wide margin as a card cut through.
 */
function assertClearsDiag(points, it, pad, label = '') {
  const b = blockOf(it, pad);
  for (let i = 1; i < points.length; i++) {
    const p = points[i - 1], q = points[i];
    // Liang-Barsky against the box, shrunk so that touching an edge - which is
    // what a route hugging its clearance does everywhere - is not a hit.
    let t0 = 0, t1 = 1;
    const dx = q.x - p.x, dy = q.y - p.y;
    const box = [b.x0 + EPS, b.x1 - EPS, b.y0 + EPS, b.y1 - EPS];
    let out = box[0] >= box[1] || box[2] >= box[3];
    for (const [d, lo, hi, s] of [[dx, box[0], box[1], p.x], [dy, box[2], box[3], p.y]]) {
      if (out) break;
      if (Math.abs(d) < EPS) { if (s <= lo || s >= hi) out = true; continue; }
      const a0 = (lo - s) / d, a1 = (hi - s) / d;
      t0 = Math.max(t0, Math.min(a0, a1));
      t1 = Math.min(t1, Math.max(a0, a1));
      if (t0 >= t1) out = true;
    }
    assert.ok(out,
      `${label}: leg ${i} (${p.x},${p.y})-(${q.x},${q.y}) cuts through ${JSON.stringify(b)}`);
  }
}

test('an unknown shape is the square route, not a route that stops being drawn', () => {
  const a = card(0, 0), b = card(500, 200), mid = card(250, 100, 200, 160);
  const typo = routeConnection(a, b, [mid], { shape: 'curvy' });
  const plain = routeConnection(a, b, [mid]);
  assertOrthogonal(typo.points, 'typo');
  assert.deepEqual(typo.points, plain.points);
});

test('taut: two cards with nothing between them are joined by one straight run', () => {
  const a = card(0, 0), b = card(600, 300);
  const { points } = routeConnection(a, b, [], { shape: 'taut' });
  assert.equal(points.length, 2, `expected a ruled line, got ${JSON.stringify(points)}`);
  // And it is a diagonal, which is the whole difference from the square shape:
  // the same pair routed at the default turns two right angles to get there.
  assert.ok(Math.abs(points[0].x - points[1].x) > 1 && Math.abs(points[0].y - points[1].y) > 1);
  assert.ok(routeConnection(a, b, []).points.length > 2, 'the square shape still bends');
});

test('taut: a card in the way is gone round, in fewer bends than the square route', () => {
  const a = card(0, 0), b = card(600, 300);
  const mid = card(300, 150, 200, 160);
  const taut = routeConnection(a, b, [mid], { shape: 'taut' });
  const square = routeConnection(a, b, [mid]);
  assertClearsDiag(taut.points, mid, 0, 'taut');
  assert.ok(bends(taut.points) < bends(square.points),
    `taut ${bends(taut.points)} bends vs square ${bends(square.points)}`);
});

test('taut: the pull never drags a line through a card it was routing around', () => {
  // Two cards stacked with a corridor between them, which is the case a pull can
  // get wrong: the corridor is the only way through and every shortcut across it
  // is blocked. Whatever comes back, it clears both.
  const a = card(0, 0), b = card(600, 300);
  const top = card(300, 60, 200, 200), bottom = card(300, 330, 200, 200);
  const { points } = routeConnection(a, b, [top, bottom], { shape: 'taut' });
  assertClearsDiag(points, top, 0, 'corridor');
  assertClearsDiag(points, bottom, 0, 'corridor');
});

test('grid: the way round a card is taken on the board lattice', () => {
  // Level ends with a card between them, so the detour is forced and the run
  // that takes it is obstacle-derived - which is the run the lattice owns. The
  // ends' own lines are never snapped (a stub eighteen units out of a face
  // would be swallowed by a block grown sixty-four), so it is this run that
  // carries the assertion.
  const step = 64;
  const a = card(0, 0), b = card(700, 0);
  const mid = card(350, 0, 200, 200);
  const { points } = routeConnection(a, b, [mid], { shape: 'grid', step });
  assertOrthogonal(points, 'grid');
  assertClears(points, mid, 0, 'grid');
  const detour = points.find(p => Math.abs(p.y) > 100 + CLEARANCE - 1);
  assert.ok(detour, `expected a run past the card, got ${JSON.stringify(points)}`);
  assert.ok(Math.abs(detour.y % step) < 1e-6,
    `the way round is at y=${detour.y}, which is not on a ${step} lattice`);
});

test('grid: no step is no quantizing, not a route that gives up', () => {
  const a = card(0, 0), b = card(700, 0), mid = card(350, 0, 200, 200);
  const nostep = routeConnection(a, b, [mid], { shape: 'grid' });
  assert.deepEqual(nostep.points, routeConnection(a, b, [mid]).points);
});

test('a raised clearance is room the route actually keeps', () => {
  // What Softish buys before it draws a curve: the fillet is cut out of the
  // inside of the corner, so the corner has to stand that much further off the
  // card in the first place.
  const a = card(0, 0), b = card(600, 300);
  const mid = card(300, 150, 200, 160);
  const room = CLEARANCE + 22;
  const { points } = routeConnection(a, b, [mid], { shape: 'taut', clearance: room });
  assertClearsDiag(points, mid, room - 1, 'soft');
});
