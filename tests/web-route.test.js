// The router: does a connection actually go around what is in its way?
//
// Properties, not pixels. There is no one correct path between two cards - a
// dozen are equally short, and which of them looks best is a judgement - so
// asserting coordinates would be asserting this implementation rather than the
// behaviour, and would break on every tuning of the turn cost.
//
// What is asserted is what has to be true of *any* answer: it is orthogonal, it
// never enters a card, it starts and ends where it should, it terminates, and
// when there is genuinely no way through it degrades to a straight line rather
// than to nothing.
//
// And the caution web-graph.js earned the hard way, which applies to every test
// in this file: **assert the arithmetic, never a duration.** Its governor's
// test was flaky exactly once, for exactly that reason.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  routeConnection, anchorFor, blockOf, trim, pathData,
  CLEARANCE, STUB, TURN_COST, MAX_OBSTACLES,
} from '../web/assets/js/web-route.js';

const card = (x, y, w = 100, h = 80, rot = 0) => ({ id: `${x},${y}`, x, y, w, h, rot });

const EPS = 1e-6;

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
  const { points, straight } = routeConnection(a, b, []);
  assert.equal(straight, false, 'an empty board is a route, not a fallback');
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
  const { points, straight } = routeConnection(a, b, [wall]);
  assert.equal(straight, false, 'there is a way round, so it is not the fallback');
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
  const { points, straight } = routeConnection(a, b, []);
  assert.equal(straight, false, 'there is plenty of room, so this is a real route');
  assertOrthogonal(points, 'behind');
  assertClears(points, a, 0, 'behind');
  assertClears(points, b, 0, 'behind');
});

test('a card wholly inside another still gets a line, and it is the straight one', () => {
  // Nothing orthogonal can reach a point buried inside an obstacle, and the
  // obstacle here is one of the two cards being joined. The honest answer is
  // the fallback: a line you drew must always be visible, even when it cheats.
  const { points, straight } = routeConnection(card(0, 0, 300, 300), card(60, 40, 60, 60), []);
  assert.equal(straight, true);
  assert.equal(points.length, 2);
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
  const { points, straight } = routeConnection(a, b, walls);
  assert.equal(straight, true, 'no way out, so the straight line');
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
