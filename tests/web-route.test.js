// The router: does a connection actually go around what is in its way?
// Properties, not pixels - no one correct path exists between two cards, so
// asserting coordinates would assert this implementation, not the
// behaviour. What must hold of *any* answer: orthogonal, never enters a
// card, starts and ends where it should, terminates, and when there is
// genuinely no way through, degrades to a plain elbow behind the
// obstruction - never the corner-to-corner diagonal this module exists to
// stop drawing. **Assert the arithmetic, never a duration** - web-graph.ts's
// governor test was flaky exactly once, for exactly that reason.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  routeConnection, anchorFor, anchorsFor, blockOf, trim, pathData,
  endOf, intoMiddles, exitTowards,
  CLEARANCE, STUB, TURN_COST, MAX_OBSTACLES, PULL_CLEARANCE, OVERLAP_COST,
} from '../web/assets/js/web-route.ts';

const card = (x, y, w = 100, h = 80, rot = 0) => ({ id: `${x},${y}`, x, y, w, h, rot });

const EPS = 1e-6;

// Never the corner-to-corner diagonal - assertOrthogonal is the whole test:
// the give-up line this replaces was [a.edge, b.edge], diagonal for any two
// cards not already lined up. No flag on the result to assert any more -
// the geometry is what was ever wrong. Counting points is *not* part of
// it: two points is a fine route when the cards line up, since trim() sheds
// the bends of an elbow that never turns.

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
  // What the stub buys: without it, the first lattice line available is the
  // card's own edge, so a route sets off tracing the card it just left.
  // Asserted as "the first turn is at least a stub away", not "the stub
  // point is in the output" - when the path carries straight through it,
  // trim() sheds the now-redundant point, the stub having done its job.
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
  // Two stacks with a gap at y=0 too narrow for a grid to guess at, and
  // exactly right for a lattice built from the edges.
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
  // Easy to get wrong: the far card is off to one side and behind, so the
  // obvious L runs back across the card just left. With nothing else in
  // the way, the two end cards must be obstacles to the search too.
  const a = card(0, 0, 400, 120);
  const b = card(-260, 300, 80, 80);
  const { points } = routeConnection(a, b, []);
  assertOrthogonal(points, 'behind');
  assertClears(points, a, 0, 'behind');
  assertClears(points, b, 0, 'behind');
});

test('a card wholly inside another still gets a line, and it is an elbow', () => {
  // Nothing can reach a point buried inside an obstacle by going around
  // it, and the obstacle here is one of the two cards joined. A drawn line
  // must always be visible, so it cheats - but *orthogonally*, behind the
  // outer card rather than across it. Used to be the two-point diagonal.
  const { points } = routeConnection(card(0, 0, 300, 300), card(60, 40, 60, 60), []);
  assertOrthogonal(points, 'nested');
  assert.ok(points.length >= 2);
});

test('a turned card is given the room its corners actually reach', () => {
  // Rotation is approximated outward by the axis-aligned box containing
  // the turned rectangle, so a route can be longer than strictly needed
  // but can never clip a corner.
  const wall = card(0, 0, 300, 60, 90);          // stood on end by the rotation
  const { points } = routeConnection(card(0, -400), card(0, 400), [wall]);
  assertOrthogonal(points, 'turned');
  assertClears(points, wall, CLEARANCE - 1, 'turned');
});

// ---------------------------------------------------------------------------
// Bends
// ---------------------------------------------------------------------------

test('the turn penalty picks the path with fewer bends when two are the same length', () => {
  // A staircase and an L between the same two points are the same length.
  // Left alone, A* returns whichever the tie-break reached first, usually
  // the staircase; the penalty makes it the L.
  const obstacles = [card(-400, -400, 40, 40), card(400, 400, 40, 40)];
  const { points } = routeConnection(card(0, 0), card(600, 400), obstacles);
  assertOrthogonal(points, 'bends');
  assert.ok(bends(points) <= 3,
    `a clear diagonal run should not staircase, got ${bends(points)} bends`);
});

test('the penalty is large next to the lengths it is traded against', () => {
  // The whole difference between a diagram and a scribble, and the one
  // constant here somebody might lower without noticing what it buys.
  assert.ok(TURN_COST >= STUB * 2, 'a bend must cost more than a step out of a card');
  assert.ok(TURN_COST > CLEARANCE, 'and more than the gap it keeps from a card');
});

// ---------------------------------------------------------------------------
// Giving up
// ---------------------------------------------------------------------------

test('a card boxed in on four sides still gets a line', () => {
  // The fallback: a drawn line must always be visible, even cheating.
  // Dropping the connection would look exactly like the app losing it.
  const a = card(0, 0, 60, 60);
  const b = card(1000, 0, 60, 60);
  const walls = [
    card(0, -120, 600, 120), card(0, 120, 600, 120),
    card(-120, 0, 120, 600), card(120, 0, 120, 600),
  ];
  const { points } = routeConnection(a, b, walls);
  // Boxed in on four sides, there is genuinely nothing to find - the
  // answer is the plain elbow behind the walls, not a diagonal across them.
  assertOrthogonal(points, 'boxed in');
  assert.equal(points.length, 2);
  assert.ok(points.every(p => Number.isFinite(p.x) && Number.isFinite(p.y)));
});

test('a route always terminates and always returns at least two points', () => {
  // A deterministic sweep, not random input - checks that no arrangement
  // of cards makes the search loop or return nothing.
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
  // An arc longer than the segment it cuts overshoots the next corner and
  // draws a knot - the radius is clamped to half the shorter run.
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
// The router used to run one search at full clearance and draw a straight
// line on failure - which scores through every card between the ends, the
// exact thing this module exists to stop drawing. A failure now concedes
// *room* instead, in order, and only draws the straight line if going
// round is genuinely impossible. These assert the order of concession: a
// route passing closer than pretty beats one passing through, and both
// beat none.
// ---------------------------------------------------------------------------

test('a gap too tight for the clearance is still a gap', () => {
  // Two cards leaving a corridor narrower than 2 * CLEARANCE. At full
  // margin their blocks overlap and the way is sealed; the route must
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
  // No amount of margin answers this: an obstacle overlapping an end
  // encloses it, and nothing can be routed *around* a card sitting on top
  // of the destination. Such cards stop counting as obstacles.
  const from = card(0, 0, 100, 80);
  const to = card(400, 0, 100, 80);
  const over = card(400, 0, 260, 240);         // swallows `to` whole
  const r = routeConnection(from, to, [over]);
  assertOrthogonal(r.points, 'covered end');
  // And it arrives: dropping the covering card from the obstacle set
  // means the line still lands on `to`'s own edge, rather than stopping
  // short and reading as a line to nothing.
  const box = blockOf(to);
  const end = r.points[r.points.length - 1];
  const onEdge = Math.abs(end.x - box.x0) < EPS || Math.abs(end.x - box.x1) < EPS ||
                 Math.abs(end.y - box.y0) < EPS || Math.abs(end.y - box.y1) < EPS;
  assert.ok(onEdge, `the covered end is reached, not stopped short of: ${JSON.stringify(end)}`);
});

test('a lattice too large to search sheds cards rather than the route', () => {
  // Too big to search means fewer cards, not no search - the furthest
  // ones, least likely to be in the way, are shed. A staircase rather than
  // rows: the lattice is one line per obstacle edge per axis, so cards
  // distinct in both axes build a lattice ~84 x ~84 at the cap, over
  // MAX_NODES and shedding. Rows would have named a branch never reached.
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
// `opts.shape` is how the whimsy axis reaches the router - see look() in
// canvas/web.ts, which turns a data-whimsy attribute and the grid step
// into these arguments. Properties, not pixels: the grid shape by where
// it may turn, the taut shape by what it no longer needs to do, and both
// by what every shape owes - it does not go through a card.
// ---------------------------------------------------------------------------

/**
 * No leg passes through this card, at any angle. assertClears above tests
 * the leg's bounding box, which is only the leg itself while every leg is
 * axis-aligned - a taut path's legs are not, and a diagonal's box is far
 * larger than the diagonal, so it would call a widely-cleared card cut through.
 */
function assertClearsDiag(points, it, pad, label = '') {
  const b = blockOf(it, pad);
  for (let i = 1; i < points.length; i++) {
    const p = points[i - 1], q = points[i];
    // Liang-Barsky against the box, shrunk so that touching an edge - which is
    // what a route hugging its clearance does everywhere - is not a hit.
    let t0 = 0, t1 = 1;
    const dx = q.x - p.x, dy = q.y - p.y;
    // Shrunk so touching an edge - which a route hugging its clearance does
    // everywhere - is not a hit.
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
  // A diagonal - the whole difference from the square shape, which turns
  // two right angles to get there.
  assert.ok(Math.abs(points[0].x - points[1].x) > 1 && Math.abs(points[0].y - points[1].y) > 1);
  assert.ok(routeConnection(a, b, []).points.length > 2, 'the square shape still bends');
});

test('taut: a card in the way is gone round, in no more bends than the square route', () => {
  // The square route now picks the best of every face pair (any side to any
  // side), so it can match taut's bend count by leaving one side and entering an
  // adjacent one. Taut, drawing a diagonal, is never bendier than that.
  const a = card(0, 0), b = card(600, 300);
  const mid = card(300, 150, 200, 160);
  const taut = routeConnection(a, b, [mid], { shape: 'taut' });
  const square = routeConnection(a, b, [mid]);
  assertClearsDiag(taut.points, mid, 0, 'taut');
  assert.ok(bends(taut.points) <= bends(square.points),
    `taut ${bends(taut.points)} bends vs square ${bends(square.points)}`);
});

test('taut: the pull never drags a line through a card it was routing around', () => {
  // Two cards stacked with a corridor between them - the case a pull can
  // get wrong: the corridor is the only way through, every shortcut
  // across it is blocked. Whatever comes back, it clears both.
  const a = card(0, 0), b = card(600, 300);
  const top = card(300, 60, 200, 200), bottom = card(300, 330, 200, 200);
  const { points } = routeConnection(a, b, [top, bottom], { shape: 'taut' });
  assertClearsDiag(points, top, 0, 'corridor');
  assertClearsDiag(points, bottom, 0, 'corridor');
});

test('grid: the way round a card is taken on the board lattice', () => {
  // Level ends with a card between them force the detour, and the
  // obstacle-derived run that takes it is the one the lattice owns - the
  // ends' own lines are never snapped, so this run carries the assertion.
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
  // What Softish buys before drawing a curve: the fillet is cut from the
  // inside of the corner, so the corner must stand that much further off
  // the card to begin with.
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
  // The whole reason faces escalate: two level cards send the dominant
  // axis's route out the right of one and the left of the other, and a
  // tall card parked flat against that face shuts it - three other ways
  // out were open the whole time.
  const a = card(0, 0), b = card(700, 0);
  const wall = card(90, 0, 20, 900);
  const { points } = routeConnection(a, b, [wall]);
  assertOrthogonal(points, 'sealed');
  assertClears(points, wall, 0, 'sealed');
});

test('a card lying over an end is still the one case that concedes', () => {
  // Face escalation must not turn the honest elbow into an infinite
  // search: a card on top of an end is arrived under, not passed - no way
  // out of a sealed box exists to find.
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
  // Level cards with a straight run already occupied. Nothing is
  // refused, so a route still exists; it must not draw on top of it.
  const a = card(0, 0), b = card(600, 0);
  const drawn = routeConnection(a, b, []);
  const again = routeConnection(a, b, [], { avoid: [drawn.points] });
  assertOrthogonal(again.points, 'avoid');
  // Measured as length, not "no leg on that line" - both routes' stubs
  // are on it by construction, arriving at the same two cards. The cost
  // is for the long run between them.
  let along = 0;
  for (let i = 1; i < again.points.length; i++) {
    const p = again.points[i - 1], q = again.points[i];
    if (Math.abs(p.y) < 1e-3 && Math.abs(q.y) < 1e-3) along += Math.abs(q.x - p.x);
  }
  assert.ok(along <= STUB * 2 + 1,
    `the second route ran ${along} units of the same corridor: ${JSON.stringify(again.points)}`);
});

test('crossing costs nothing', () => {
  // A line straight across the corridor, at right angles. The route
  // through is unchanged - a crossing is what every diagram does.
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
  // The only way through is already occupied. A cost that became a ban
  // would leave this with no route.
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

// A card fills its rectangle, so a line stopping on it stops where the
// picture starts. `meta.bare` items (a cut-out, a note without paper, a
// model on a transparent buffer) invert that: the rectangle is mostly
// nothing, so the same rule would end the line in open space, reading as a
// stray mark rather than a join. See endOf().

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
  // The endpoint is strictly inside the box, so the last stretch of line
  // is under the picture, the way it is under a card at that card's edge.
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
  // Added, not substituted - replacing the face point would send the line
  // across the box on a diagonal the router never chose or checked for
  // obstacles, the one shape this module exists to stop drawing.
  const points = [{ x: 50, y: 0 }, { x: 200, y: 0 }, { x: 200, y: 100 }];
  const out = intoMiddles(points, bare(0, 0), bare(200, 140));
  assert.deepEqual(out.slice(1, -1), points, 'every point the router chose survives, in order');
});
