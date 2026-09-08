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
// And the caution web-graph.ts earned the hard way, which applies to every test
// in this file: **assert the arithmetic, never a duration.** Its governor's
// test was flaky exactly once, for exactly that reason.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  routeConnection, anchorFor, anchorsFor, blockOf, trim, pathData,
  endOf, intoMiddles, exitTowards,
  CLEARANCE, STUB, TURN_COST, MAX_OBSTACLES, PULL_CLEARANCE, OVERLAP_COST,
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
// and look() in canvas/web.ts, which is what turns a data-whimsy attribute and
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

// ---------------------------------------------------------------------------
// Four ways out, not one
// ---------------------------------------------------------------------------

test('every face is offered, best first', () => {
  const from = card(0, 0);
  const out = anchorsFor(from, card(500, 40));
  assert.equal(out.length, 4, 'four faces, always');
  assert.ok(out[0].edge.x > from.x, 'the dominant axis still picks the first');
  const xs = new Set(out.map(p => p.edge.x));
  const ys = new Set(out.map(p => p.edge.y));
  assert.ok(xs.size > 1 && ys.size > 1, 'the four are four different faces');
  assert.deepEqual(out[0], anchorFor(from, card(500, 40)),
    'the single-answer door is the head of the list');
});

test('a sealed face is not a sealed route', () => {
  // The case the elbow used to be reached by, and the whole reason the faces
  // escalate. The two cards are level, so the dominant axis sends the route out
  // of the right of one and the left of the other - and a tall card parked flat
  // against that face shuts it. Three other ways out were open the whole time.
  const a = card(0, 0), b = card(700, 0);
  const wall = card(90, 0, 20, 900);
  const { points } = routeConnection(a, b, [wall]);
  assertOrthogonal(points, 'sealed');
  assertClears(points, wall, 0, 'sealed');
});

test('a card lying over an end is still the one case that concedes', () => {
  // The face escalation must not turn the honest elbow into an infinite search:
  // a card on top of an end is not something the route passes, it is something
  // the route arrives under, and no way out of a sealed box exists to find.
  const a = card(0, 0), b = card(600, 0);
  const lid = card(0, 0, 400, 400);
  const { points } = routeConnection(a, b, [lid]);
  assertOrthogonal(points, 'covered');
  assert.ok(points.length >= 2, 'a line is still drawn');
});

// ---------------------------------------------------------------------------
// The fan at a shared face
// ---------------------------------------------------------------------------

test('slots spread the endpoints along the face they share', () => {
  const from = card(0, 0), to = card(500, 0);
  const one = anchorsFor(from, to, { index: 0, count: 3 })[0];
  const two = anchorsFor(from, to, { index: 1, count: 3 })[0];
  const three = anchorsFor(from, to, { index: 2, count: 3 })[0];
  assert.equal(one.edge.x, two.edge.x, 'the same face');
  assert.ok(one.edge.y < two.edge.y && two.edge.y < three.edge.y,
    'and three distinct places on it, in slot order');
  const box = blockOf(from);
  for (const p of [one, three]) {
    assert.ok(p.edge.y > box.y0 && p.edge.y < box.y1, 'never off the end of the face');
  }
});

test('the middle slot is the endpoint every unslotted route already had', () => {
  const from = card(0, 0), to = card(500, 0);
  assert.deepEqual(anchorsFor(from, to, { index: 0, count: 1 })[0], anchorFor(from, to),
    'one line meeting a card is still the middle of the face');
});

test('two lines to the same card do not leave from the same point', () => {
  const hub = card(0, 0);
  const up = routeConnection(hub, card(500, -30), [], { fromSlot: { index: 0, count: 2 } });
  const down = routeConnection(hub, card(500, 30), [], { fromSlot: { index: 1, count: 2 } });
  assert.notDeepEqual(up.points[0], down.points[0]);
});

// ---------------------------------------------------------------------------
// Crossing is fine, lying on top of each other is not
// ---------------------------------------------------------------------------

test('a route gets off a line that is already there', () => {
  // Level cards with a straight run between them, and that exact run already
  // occupied. Nothing is refused, so a route still exists; what it must not do
  // is draw itself on top of what is there.
  const a = card(0, 0), b = card(600, 0);
  const drawn = routeConnection(a, b, []);
  const again = routeConnection(a, b, [], { avoid: [drawn.points] });
  assertOrthogonal(again.points, 'avoid');
  // Measured as length rather than as "no leg at all on that line", because the
  // two stubs are on it by construction: both routes arrive at the same two
  // cards, and the last units into a face are where the line is going. What the
  // cost is for is the long run between them.
  let along = 0;
  for (let i = 1; i < again.points.length; i++) {
    const p = again.points[i - 1], q = again.points[i];
    if (Math.abs(p.y) < 1e-3 && Math.abs(q.y) < 1e-3) along += Math.abs(q.x - p.x);
  }
  assert.ok(along <= STUB * 2 + 1,
    `the second route ran ${along} units of the same corridor: ${JSON.stringify(again.points)}`);
});

test('crossing costs nothing', () => {
  // A line straight across the corridor, at right angles to it. The route
  // through is unchanged, because a crossing is what every diagram does.
  const a = card(0, 0), b = card(600, 0);
  const across = [{ x: 300, y: -400 }, { x: 300, y: 400 }];
  assert.deepEqual(
    routeConnection(a, b, [], { avoid: [across] }).points,
    routeConnection(a, b, []).points,
  );
});

test('nothing to avoid is the route this always drew', () => {
  const a = card(0, 0), b = card(600, 300), mid = card(300, 150, 200, 160);
  const plain = routeConnection(a, b, [mid]);
  assert.deepEqual(routeConnection(a, b, [mid], { avoid: [] }).points, plain.points);
  assert.deepEqual(routeConnection(a, b, [mid], { avoid: undefined }).points, plain.points);
});

test('an overlap is priced, never refused', () => {
  // The corridor between two cards is the only way through and it is already
  // occupied. A cost that had become a ban would leave this with no route.
  const a = card(0, 0), b = card(700, 0);
  const top = card(350, -180, 200, 200), bottom = card(350, 180, 200, 200);
  const first = routeConnection(a, b, [top, bottom]);
  const second = routeConnection(a, b, [top, bottom], { avoid: [first.points] });
  assertOrthogonal(second.points, 'priced');
  assertClears(second.points, top, 0, 'priced');
  assertClears(second.points, bottom, 0, 'priced');
});

test('the two margins say what they each mean', () => {
  assert.ok(PULL_CLEARANCE < CLEARANCE,
    'the string is pulled tighter than the corridor was found');
  assert.ok(STUB < CLEARANCE,
    "the stub's own header says so, and the two disagreed for a while");
  assert.ok(OVERLAP_COST > 1,
    'running along another line costs more than running anywhere else');
});

// ---------------------------------------------------------------------------
// The items whose box is not their picture
// ---------------------------------------------------------------------------

// A card fills its rectangle, so a line stopping on the rectangle stops where
// the picture starts. An item with no card - `meta.bare`, which is a cut-out, a
// note without its paper or a model on its transparent buffer - is the case that
// inverts it: the rectangle is mostly nothing with the thing in the middle of
// it, so the same rule leaves the line ending in open paper a box's width from
// anything, which reads as a stray mark rather than as a join. See endOf().

const bare = (x, y, w = 100, h = 80) => ({ ...card(x, y, w, h), bare: true });

test('a line to a card still stops on its outline', () => {
  const a = card(0, 0);
  const target = { x: 500, y: 0 };
  assert.deepEqual(endOf(a, target), exitTowards(a, target),
    'nothing about the case with a card may move');
});

test('a line to an item with no card runs to its middle', () => {
  const a = bare(0, 0);
  assert.deepEqual(endOf(a, { x: 500, y: 0 }), { x: 0, y: 0 });
  // From any direction, since a middle has no sides.
  assert.deepEqual(endOf(a, { x: -500, y: 300 }), { x: 0, y: 0 });
});

test('a bare end is carried past its own outline, not short of it', () => {
  // The property that makes this the right answer rather than a longer wrong
  // one: the endpoint is strictly inside the box, so the last stretch of line is
  // under the picture the way it is under a card at that card's own edge.
  const a = bare(0, 0);
  const end = endOf(a, { x: 500, y: 40 });
  assert.ok(Math.abs(end.x) < a.w / 2 && Math.abs(end.y) < a.h / 2);
});

test('a routed path gains a middle only at the ends that have no card', () => {
  const points = [{ x: 50, y: 0 }, { x: 200, y: 0 }, { x: 200, y: 100 }];
  const framed = card(0, 0);
  const cut = bare(200, 140);

  assert.equal(intoMiddles(points, framed, framed), points,
    'two ends with cards is the route untouched, and the same array');

  const one = intoMiddles(points, framed, cut);
  assert.deepEqual(one[one.length - 1], { x: 200, y: 140 }, 'the bare end reaches its middle');
  assert.deepEqual(one[0], points[0], 'the end with a card is left where the router put it');
  assert.equal(one.length, points.length + 1);

  const both = intoMiddles(points, bare(0, 0), cut);
  assert.deepEqual(both[0], { x: 0, y: 0 });
  assert.deepEqual(both[both.length - 1], { x: 200, y: 140 });
  assert.equal(both.length, points.length + 2);
});

test('the route the router found is kept whole underneath the added stubs', () => {
  // Added rather than substituted. Replacing the face point would send the line
  // across the box on a diagonal the router never chose and never checked for
  // obstacles - which is the one shape this whole module exists to stop drawing.
  const points = [{ x: 50, y: 0 }, { x: 200, y: 0 }, { x: 200, y: 100 }];
  const out = intoMiddles(points, bare(0, 0), bare(200, 140));
  assert.deepEqual(out.slice(1, -1), points, 'every point the router chose survives, in order');
});
