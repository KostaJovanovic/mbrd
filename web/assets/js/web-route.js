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
//
// ---------------------------------------------------------------------------
// Three shapes, one axis
// ---------------------------------------------------------------------------
//
// A route answers the whimsy slider, through `opts.shape`:
//
//   'square'  right angles on the obstacle lattice - what this file always
//             drew, and still what a caller that says nothing gets
//   'grid'    right angles, with the obstacle lines quantized *outward* to
//             `opts.step`, so every turn taken round a card lands on the
//             board's own lattice. Harsh, where the cards are snapped to that
//             same lattice - a snapped board whose connectors turn fourteen
//             units off the grid is the axis half-applied
//   'taut'    the same corridor with the string pulled: straight when nothing
//             is in the way, and otherwise the fewest bends the corridor
//             allows, at whatever angle the detour actually needs
//
// Softish is 'taut' with `opts.clearance` raised, and that is not a shortcut.
// The curve is drawn by rounding the corners of the taut path in pathData(); a
// fillet cuts *inside* the corner it rounds, and a corner is exactly the place
// the route is hugging a card at the clearance. So the room a curve needs is
// bought before the search rather than taken out of the card afterwards.
// canvas/web.js owns that arithmetic, because it owns the corner radius.
//
// The shape is a parameter rather than a read, which is the whole point: this
// file imports geometry.js and nothing else - tests/layers.test.js holds the
// list - so canvas/web.js is what turns a data-whimsy attribute and a board's
// grid step into the three lines above.

import { rotatedExtents, segmentMeetsRect } from './geometry.js';

/** Degrees to radians, for the one place here that needs the card's own frame. */
const RAD = Math.PI / 180;

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
 * The shapes a route may be asked for - see the header, and canvas/web.js for
 * which level of the whimsy axis asks for which.
 *
 * A set rather than a check at each use, and validated rather than trusted, for
 * the reason every reader in this codebase gives: an unknown shape is a caller
 * with a typo, and the honest answer to one is the default rather than a route
 * that quietly stops being drawn.
 */
const SHAPES = new Set(['square', 'grid', 'taut']);

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
 * dense patch can clip a card rather than failing.
 *
 * Raised from 24, which was not a measurement of anything - it was what the
 * search's open set could afford while it was a linear scan for the smallest f,
 * whose cost is quadratic in the open set, so every card added cost more than
 * the last. The open set is a heap now (see search), and a clipped card is the
 * one outcome this module is *for* avoiding, so the cap goes where the lattice
 * rather than the queue puts it.
 */
export const MAX_OBSTACLES = 40;

/**
 * Guards the search itself, in case a caller ignores the cap above.
 *
 * Not a give-up any more: routeConnection() drops its furthest obstacles until
 * the lattice fits rather than abandoning the route, so this is the size of
 * search it is willing to run, not the size past which it stops trying.
 *
 * Which is why it has to sit *below* what MAX_OBSTACLES can build, and it did
 * not. Two coordinates per card, plus the two ends and the four anchor values,
 * is 88 to a side at the cap - so the largest lattice that can ever exist is
 * 7744 nodes, and a ceiling above that is a branch no board can reach: the
 * shedding loop was unreachable code and the paragraph above it was a promise
 * about something that could not happen. 4000 is a little over half of what the
 * cap can build, which is where shedding bites on the dense boards it is for and
 * never on the ordinary ones.
 */
const MAX_NODES = 4000;

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
 * Where a line drawn from this card's *middle* towards `target` leaves it.
 *
 * anchorFor's opposite number, and the difference is the whole of why both
 * exist. An orthogonal route runs perpendicular out of a face, so the middle of
 * the face is exactly where it should start - a right-angled line leaving from
 * anywhere else would immediately have to bend to get square. A taut line has
 * no such obligation: it is a ruled line between two cards, and a ruled line
 * between two cards is aimed at their *centres*. Started at the middle of a
 * face instead, it points a few degrees off, arrives a few degrees off, and
 * reads as a line that happens to touch two cards rather than one that joins
 * them - most visibly on a tall card beside a wide one, where the two face
 * midpoints are nowhere near the line between the middles.
 *
 * So this clips the centre-to-target ray at the card itself - the *leaning*
 * rectangle, not the box around it, and that distinction is the whole
 * correctness of it. Everything else in this file works from `blockOf`, the
 * axis-aligned box that contains the card, because everything else here is
 * asking what a route must keep clear of and a box that is too big is the safe
 * mistake. An endpoint is the one question where too big is not safe: a card
 * leaning three degrees pokes out past its own box near the corners and falls
 * short of it everywhere else, so a line clipped at the box stops either
 * visibly outside the card or hidden inside it, depending on where along the
 * edge it arrives. Clipped at the rectangle it stops on the drawn edge, at any
 * lean and anywhere along it.
 *
 * `rot` therefore has to be the rotation the card is *drawn* with, lean
 * included and signed - see centres() in canvas/web.js, which is where that is
 * put together.
 */
export function exitTowards(it, target) {
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

/**
 * The path a connection takes, as a list of points to draw straight lines
 * between. Always at least two, and always something: a pair with no route at
 * all still gets a line.
 *
 * `from` and `to` are item-shaped boxes - `{ x, y, w, h, rot }` - in whatever
 * coordinate system the caller draws in. `obstacles` are the other cards, in
 * the same shape and the same system, and must not include the two ends.
 *
 * `opts` is how the look reaches the algorithm - `{ shape, step, clearance }`,
 * see the header. Everything about it is optional and the default is the
 * right-angled route this always drew, which is what keeps every caller and
 * every test that predates the whimsy axis saying exactly what it said.
 *
 * There is no failure flag on the result, and there used to be. It marked the
 * straight line this drew when it could not find a way round, and canvas/web.js
 * drew those dimmed and dashed so a give-up was visible. Both are gone: the last
 * resort is an orthogonal elbow now, which is a line that goes *behind* the cards
 * in its way rather than across them, and the web is drawn under the items - so
 * it looks like a connector passing under a photograph, because that is what it
 * is. A state worth marking as a failure has to look like one.
 */
export function routeConnection(from, to, obstacles = [], opts = {}) {
  const shape = SHAPES.has(opts.shape) ? opts.shape : 'square';
  const taut = shape === 'taut';
  const clearance = opts.clearance > 0 ? opts.clearance : CLEARANCE;
  // Only 'grid' quantizes, and only when it was given a lattice to quantize to.
  // A board with no grid step is not a board whose connectors can answer one.
  const step = shape === 'grid' && opts.step > 0 ? opts.step : 0;

  const a = anchorFor(from, to);
  const b = anchorFor(to, from);

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
  const ends = [blockOf(from), blockOf(to)];

  // Sorted nearest-first once, so every attempt drops the same furthest cards
  // first when it has to trim.
  const ordered = [...near].sort((p, q) => dist2(p, from, to) - dist2(q, from, to));

  /** The obstacle blocks at a given margin, on the lattice or off it. */
  const blocksAt = (pad, snap) => ordered.map(it => {
    const k = blockOf(it, pad);
    return snap && step ? snapOut(k, step) : k;
  });

  /**
   * The taut passes, or nothing, depending on the shape asked for. `obstacles`
   * is the other cards alone; the two ends are added where they belong.
   *
   * Pull first and aim second, in that order and not the other way round: which
   * way the first leg points is not known until the turns it was going to make
   * have been dropped, and aiming a leg that is about to be removed is work
   * thrown away.
   */
  const done = (points, obstacles) => {
    if (!taut) return { points };
    return { points: aim(pull(points, [...obstacles, ...ends]), obstacles) };
  };

  /**
   * Move the two ends from the middle of a face to where the leg leaving them
   * actually crosses the card - see exitTowards.
   *
   * Checked rather than assumed. The leg the pull left behind was verified from
   * the old anchor, and the new one is a different segment: it starts elsewhere
   * on the same card and can therefore pass on the other side of something the
   * old one cleared. When it does, the face midpoint is kept - a line that
   * leaves squarely is worse-looking than one that aims at the middle, and
   * better than one that cuts a corner off a photograph.
   */
  const aim = (points, obstacles) => {
    if (points.length < 2) return points;
    const last = points.length - 1;
    const head = exitTowards(from, points[1]);
    if (!crosses(head, points[1], obstacles)) points[0] = head;
    const tail = exitTowards(to, points[last - 1]);
    if (!crosses(tail, points[last - 1], obstacles)) points[last] = tail;
    return points;
  };

  // The straight line, tried before anything else and only at 'taut'. A route
  // that has nothing between its two ends is a ruled line from one card to the
  // other, and at that shape it should not be paying for a stub or a bend to
  // say so - which is the difference somebody moving the slider to the middle
  // is looking for. The end cards are tested along with everything else: two
  // overlapping cards joined by a line is a real board.
  if (taut) {
    const straight = [exitTowards(from, to), exitTowards(to, from)];
    // The other cards, and deliberately not these two. A point on a leaning
    // card's own outline is *inside* the axis-aligned box around it, so a test
    // that included the ends would reject every straight line between two cards
    // that were not perfectly square - which is most of them at the soft end.
    //
    // Nothing is given up by leaving them out, and the reason is worth writing
    // down rather than trusting: this segment runs along the ray from one
    // centre to the other, and a rectangle is convex, so it leaves each card at
    // the point it was clipped to and can never come back.
    if (!crosses(straight[0], straight[1], blocksAt(clearance, false))) {
      return { points: straight };
    }
  }

  // The two-bend path, tried first and taken whenever it is clear. It is the
  // answer on most boards, the search would only rediscover it, and it is one
  // loop over a handful of segments against the cost of building a lattice.
  const easyBlocks = blocksAt(clearance, true);
  const easy = simple(a, b, [...easyBlocks, ...ends]);
  if (easy) return done(easy.points, easyBlocks);

  // -------------------------------------------------------------------------
  // Otherwise: keep trying, and give up room before giving up the route.
  //
  // This used to be one search at full clearance and a straight line if it
  // failed - and a straight line is not a failed route, it is the thing this
  // whole module exists to stop drawing. It scores through every card between
  // the two ends, which is the one outcome worse than a long way round.
  //
  // So the attempts are ordered by *what they concede*, cheapest concession
  // first, and every one of them still goes round the cards:
  //
  //   1. full clearance          the route everyone wants
  //   2. a third of it           passes closer than is pretty, still passes
  //   3. none at all             hugs the edges; only real overlap blocks now
  //   4. and (3) again, ignoring cards that lie *on top of* an end
  //
  // Four is the case the first three cannot answer, and it is not a corner: a
  // card stacked over one of the two ends encloses it, and no amount of margin
  // gets a line out of a box that is sealed. Nothing can be routed *around* a
  // card that is on top of the thing being routed to, so those stop counting -
  // which is also the honest reading, since a covered card is not something the
  // route is passing, it is something the route is arriving under.
  //
  // And if all four find nothing, the answer is still not a diagonal. It is the
  // plain two-bend elbow, drawn through whatever is left in the way - see
  // elbow() for why that is a real answer rather than a shrug, and why the flag
  // that used to mark these as failures is gone with it.
  // -------------------------------------------------------------------------
  const overlapsEnd = k => ends.some(e =>
    k.x0 < e.x1 - EPS && k.x1 > e.x0 + EPS && k.y0 < e.y1 - EPS && k.y1 > e.y0 + EPS);

  const attempt = pool => {
    // The end cards' own edges are lines in the lattice as well as the
    // obstacles', which is what lets a route get out from under a card it
    // overlaps. Skipping that was a bug: with no other cards in the way and the
    // simple path blocked by one of the two ends, this used to give up and draw
    // the straight line without ever having looked for a way round.
    let all = [...pool, ...ends];
    let xs = lattice([a.edge.x, a.stub.x, b.edge.x, b.stub.x, ...all.flatMap(k => [k.x0, k.x1])]);
    let ys = lattice([a.edge.y, a.stub.y, b.edge.y, b.stub.y, ...all.flatMap(k => [k.y0, k.y1])]);
    // Too big to search is a reason to search over fewer cards, not a reason to
    // stop. The furthest go first, for the same reason the cap above drops
    // them: they are the least likely to be in the way, and a route that goes
    // round nineteen cards and clips the twentieth is still a route.
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

    const path = search(xs, ys, all, xi, yi, xj, yj);
    if (!path) return null;
    // The stubs bracket the search's own answer, and the edge points bracket
    // those. Duplicates are shed on the way out: when a stub lands exactly on a
    // lattice node the search already begins there.
    return { points: trim([a.edge, a.stub, ...path, b.stub, b.edge]) };
  };

  // The rungs, and the one the lattice adds. Quantizing grows every block by up
  // to a step, which can close a corridor that was open - so the snapped
  // attempt is a rung of its own *above* the ladder, and the first thing given
  // up is the lattice rather than the clearance. Below that the shape has
  // already lost its argument, and what is left is the concession ladder this
  // file has always had.
  const rungs = step
    ? [[clearance, true], [clearance, false], [clearance / 3, false], [0, false]]
    : [[clearance, false], [clearance / 3, false], [0, false]];

  for (const [pad, snap] of rungs) {
    const pool = blocksAt(pad, snap);
    const got = attempt(pool);
    if (got) return done(got.points, pool);
  }
  const uncovered = blocksAt(0, false).filter(k => !overlapsEnd(k));
  if (uncovered.length !== ordered.length) {
    const got = attempt(uncovered);
    if (got) return done(got.points, uncovered);
  }
  // Even the elbow is offered to the taut pass. Nothing routed, which at this
  // point means the search could not find a way round rather than that there is
  // none - and if a straight run between two of the elbow's own corners is in
  // fact clear, that is a better picture than a line through a card.
  return done(elbow(a, b), blocksAt(clearance, false));
}

/**
 * A block grown outward to the board's own lattice.
 *
 * Outward on all four sides, never inward. The margin this is applied over is
 * the clearance, and rounding a side towards the card would spend it - so a
 * card sitting a hair past a grid line claims the whole cell rather than
 * giving up the room that keeps a route off its edge.
 *
 * What it buys is that every lattice line this block contributes is a multiple
 * of the step, so a turn taken round the card lands where the cards themselves
 * are standing. The two ends are deliberately not snapped: a route has to leave
 * the card it starts from, and a stub eighteen units out of a face would be
 * swallowed by a block grown sixty-four.
 */
function snapOut(k, step) {
  return {
    x0: Math.floor(k.x0 / step) * step,
    y0: Math.floor(k.y0 / step) * step,
    x1: Math.ceil(k.x1 / step) * step,
    y1: Math.ceil(k.y1 / step) * step,
  };
}

/**
 * Whether a segment at any angle passes through the inside of any block.
 *
 * The taut pass's version of segmentBlocked(), and the difference between them
 * is the point. That one is axis-aligned and lets a segment run *along* an
 * edge, because the lattice is built out of those edges. A pulled string is not
 * on a lattice line any more, so it is tested against the interior instead: it
 * may graze a corner or lie along a side - which is exactly what the clearance
 * margin was added for - and may not cut through.
 *
 * The inset is what makes "graze" mean grazing. Every point of a routed path
 * sits on the boundary of some padded block by construction, so a test that
 * counted touching would refuse every segment it was ever handed.
 */
function crosses(p, q, blocks) {
  for (const k of blocks) {
    if (k.x1 - k.x0 <= EPS * 2 || k.y1 - k.y0 <= EPS * 2) continue;
    if (segmentMeetsRect(p, q, {
      x0: k.x0 + EPS, y0: k.y0 + EPS, x1: k.x1 - EPS, y1: k.y1 - EPS,
    })) return true;
  }
  return false;
}

/**
 * Pull the string: drop every turn the path can do without.
 *
 * The corridor the search returns is optimal among *orthogonal* paths, which is
 * a staircase whenever the way round is diagonal. Walk it and drop point i
 * whenever i-1 can see i+1 through the same blocks the route was found against;
 * repeat until a pass drops nothing. What is left has the fewest bends the
 * corridor allows, and every segment of it has been checked.
 *
 * Only the two edge points are pinned, and the stubs are not - which is worth
 * saying, because the stub is deliberate everywhere else in this file. It is
 * there so an orthogonal route does not set off by sliding along the face of
 * the card it just left, the first lattice line available being that card's own
 * edge. A pulled segment leaving at an angle is not sliding along anything, it
 * is leaving; and the straight line above already leaves both cards that way, so
 * pinning the stubs here would make a route with one bend in it exit squarely
 * and a route with none exit diagonally. One shape, one exit.
 *
 * Not Theta*, and not a visibility graph over the obstacle corners. Both give
 * shorter paths and neither is worth its cost at the two or three bends a
 * card-to-card connector actually has: the graph is quadratic in the corners,
 * the line-of-sight checks multiply the search itself, and this runs inside a
 * frame budget on boards with hundreds of cards. The corridor is already paid
 * for. Pull it and stop.
 */
function pull(points, blocks) {
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

/**
 * The two-bend path between two anchors, with nothing consulted about what is
 * in the way. The shape simple() checks, and the shape the router falls back to
 * when every search has come up empty.
 *
 * It is the *last resort*, and what matters about it is what it is not: a
 * diagonal. A line drawn corner to corner is the one thing this module exists to
 * stop - it scores across every card between the two ends at an angle nothing
 * else on the board is drawn at, and it reads as damage. An elbow that passes
 * behind a card reads as a connector, because the web is drawn under the items
 * (#web is z-index -2): the line simply goes under the card and comes out the
 * other side, which is what a wire behind a photograph does.
 *
 * So there is no such thing as a route that failed any more. There are routes
 * that go round, and routes that go behind.
 */
function elbow(a, b) {
  const mid = a.stub.x === a.edge.x
    ? [{ x: a.stub.x, y: b.stub.y }]           // left vertically
    : [{ x: b.stub.x, y: a.stub.y }];          // left sideways
  return trim([a.edge, a.stub, ...mid, b.stub, b.edge]);
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
 * The open set is a binary heap - see the note on it below, which is also the
 * story of why MAX_OBSTACLES could be raised. It was a linear scan for the
 * smallest `f`, on the argument that the lattice was a couple of thousand
 * states at the very worst and a heap was a data structure carried for the rest
 * of the file's life to save a fraction of a millisecond on a board nobody has.
 * That argument died when routeConnection() began running up to four of these
 * before it would draw a straight line.
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

  // A binary heap, where this was a linear scan for the smallest f on every
  // pop. That was affordable while a route was one search over a lattice bounded
  // at a couple of thousand nodes; it is not now that routeConnection() will run
  // up to four of them before it will draw a straight line, and it is what was
  // really bounding MAX_OBSTACLES - the cost of the scan is quadratic in the
  // open set, so every card added to the search cost more than the last.
  //
  // f is carried beside the state rather than recomputed, because with a heap it
  // is read on every sift comparison rather than once per pop.
  const fs = [];
  const push = (s, f) => {
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
    const lastS = open.pop(), lastF = fs.pop();
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
    const step = (nx, ny, nd, passable) => {
      if (!passable) return;
      const next = at(nx, ny) * 4 + nd;
      if (done[next]) return;
      const cost = Math.abs(xs[nx] - xs[x]) + Math.abs(ys[ny] - ys[y]) +
                   (nd === dir ? 0 : TURN_COST);
      if (g[s] + cost >= g[next]) return;
      g[next] = g[s] + cost;
      from[next] = s;
      push(next, g[next] + h(nx, ny));
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
