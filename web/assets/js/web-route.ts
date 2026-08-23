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
// - **Connections still do not avoid each other, but they no longer lie on top
//   of each other.** This paragraph used to refuse both, on one argument: two
//   lines crossing is what every diagram in existence does, and making routes
//   avoid routes multiplies the cost of each by the number of them. The first
//   half of that is right and stands - a crossing costs nothing here and never
//   will. The second half was answering the wrong complaint. What reads as
//   damage is not a crossing, it is a *coincidence*: two lines running the same
//   corridor do not read as two lines, they read as one that is somehow
//   heavier, and the second one is invisible work.
//
//   So only cards are obstacles, and a lattice edge that lies along a line
//   already drawn simply costs more to travel (OVERLAP_COST, charged by the
//   length of the overlap). Nothing is refused, so no route is ever lost to
//   this; a route with no better answer pays the charge and draws where it was
//   going to. The lines to avoid are handed in through `opts.avoid` by
//   canvas/web.js, which is the half that knows there is more than one line -
//   this file still sees exactly one route at a time.
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

import { rotatedExtents, segmentMeetsRect, distSqToMidpoint } from './geometry.ts';
// Point, Box and Bounds are geometry.ts's own and are what this file has always
// meant by a point, a card and a block - `Bounds` is the {x0,y0,x1,y1} every
// obstacle here is reduced to. Named from there rather than restated, so the two
// halves of the connector cannot drift apart over what a rectangle is.
import type { Point, Box, Bounds } from './geometry.ts';

/**
 * Which side of a card a route leaves by: the point on the face, and the point
 * one stub out from it. See anchorsFor().
 */
export type Anchor = { edge: Point, stub: Point };

/**
 * Which of the lines meeting one card's face this route is, and how many there
 * are. See anchorsFor() for where it lands the endpoint, and canvas/web.js for
 * who counts - this module sees one route at a time and is told.
 */
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

/**
 * How far a route stays off a card it is passing.
 *
 * Enough to read as clearance rather than as a line grazing an edge, and small
 * enough that two cards a normal gap apart still have a corridor between them.
 * That last clause is the ceiling and it is arithmetic rather than taste: cards
 * on a default board stand a grid step (64) apart, two margins have to fit
 * inside that gap, so anything at or above 32 closes the corridor between two
 * neighbours and every route between them starts going the long way round.
 *
 * Was 14, which was under half of what the gap allows and read as a line
 * grazing the card rather than passing it.
 */
export const CLEARANCE = 22;

/**
 * The margin pull() tests the string against, which is *not* the margin the
 * search kept clear.
 *
 * One number used to do both jobs and they pull opposite ways. The search wants
 * a generous margin - that is the air between a line and a photograph. The
 * string pull wants a mean one: it drops a turn only when it can see through
 * the blocks it is testing, so fattening them for the search's sake leaves
 * every taut line carrying bends it does not need. Raising the clearance made
 * the picture stiffer, which is the opposite of what raising it was for.
 *
 * Split, the two say what they each mean: find the corridor generously, then
 * pull the string through it tightly. A pulled segment may therefore pass
 * nearer a card than the search would have - by design, and only ever on a
 * straight run that has been checked against the real boxes.
 */
export const PULL_CLEARANCE = CLEARANCE / 2;

/**
 * The straight run every route makes on its way out of a card before it is
 * allowed to turn.
 *
 * Without it the first lattice line available is the card's own edge, and a
 * route would set off by sliding along the side of the card it just left -
 * which reads as the line tracing the card rather than leaving it. Larger than
 * nothing and smaller than CLEARANCE, so the stub of one card never lands
 * inside another card's margin more often than the card itself would.
 *
 * That sentence was here while the number disagreed with it - a stub of 18
 * against a clearance of 14 - which is one of the two having been changed
 * without the other. Both are named here now and the order between them holds.
 */
export const STUB = 20;

/**
 * How much of a face the fan of lines meeting it is allowed to spread across.
 *
 * Two thirds rather than all of it. A slot at the very end of the face puts a
 * line on the card's corner, where the eye reads it as missing the card rather
 * than as arriving at it - and a corner is also where a leaning card's outline
 * is furthest from the box this measures against.
 */
const SPREAD = 0.66;

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
 * What running along another line costs, as a multiple of the distance run.
 *
 * A multiplier rather than a flat charge per lattice edge, and the difference
 * matters: the lattice is built out of whatever card edges happen to be nearby,
 * so a corridor can be one long edge on a sparse board and eight short ones on
 * a dense one. A flat charge would make the same picture cost eight times as
 * much in the second case, which is a penalty on how many cards are in the
 * neighbourhood rather than on the thing being discouraged. Charged by length,
 * a unit run along another line costs five units instead of one, wherever it is.
 *
 * Four says a route will go four times as far to get off another line, and will
 * not go five - which is the right order next to TURN_COST, since a bend is
 * always the cheaper way out of a coincidence than a long detour is.
 *
 * Crossing costs nothing at all, deliberately. See the header.
 */
export const OVERLAP_COST = 4;

/**
 * How many searches the face escalation is allowed, past the ones the rungs
 * already ran.
 *
 * A ceiling on the one path that can multiply a route's cost. Sixteen face
 * pairs exist and the cheap L is tried on every one of them; the lattice search
 * is not, because a board that has got this far is a board where each of those
 * is a full A* over a few thousand states. Six is enough for the near faces at
 * both margins and is a number a dense board can afford once.
 */
const MAX_FACE_SEARCHES = 6;

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
export function blockOf(it: Box, pad = 0): Bounds {
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

/**
 * Which face of a card a route leaves by. Named by axis and direction rather
 * than by compass point, because this module is handed y-down coordinates by
 * canvas/web.js and y-up ones by half its tests, and "north" would have to mean
 * something in both.
 */
type Side = 'x+' | 'x-' | 'y+' | 'y-';

const OPPOSITE: Record<Side, Side> = { 'x+': 'x-', 'x-': 'x+', 'y+': 'y-', 'y-': 'y+' };

/**
 * The point on one named face to leave by, and the point a stub out from it.
 *
 * `slot` is where along the face it lands. The default is the middle, which is
 * where every endpoint in this file used to be unconditionally - a face
 * midpoint is the right place for the *only* line meeting a card, and the wrong
 * one for the fifth, because all five arrive at the same point and the four
 * corridors behind them coincide. Spread across SPREAD of the face, the fan
 * reads as a fan.
 */
function faceAnchor(from: Box, side: Side, slot: Slot = MIDDLE): Anchor {
  const box = blockOf(from);
  // -0.5 to 0.5, and exactly 0 for the single-line case, so an unslotted route
  // is arithmetically identical to the one this drew before slots existed.
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

/**
 * The four ways out of `from` towards `to`, best first.
 *
 * The side is chosen per route and recomputed whenever anything moves, rather
 * than fixed to a compass point on the card. Fixed anchors would be a second
 * thing for somebody to manage, and they are wrong the moment either card is
 * dragged past the other.
 *
 * The dominant axis still decides the *first* one: mostly-sideways goes out of
 * a side, mostly-up or down goes out of the top or the bottom. Ties go
 * sideways, because cards are wider than they are tall more often than not.
 *
 * What is new is the other three, and they exist because the first used to be
 * the only one. A card parked flat against the chosen face seals the route: the
 * search fails at every clearance, the whole concession ladder fails with it,
 * and the line was drawn *behind* the cards in its way - while three open faces
 * sat there and nothing ever looked at them. Ranked near faces before away
 * ones, since leaving by the far side of a card is a real answer and rarely the
 * pretty one.
 */
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

/**
 * The one way out, for every caller and every test that wants the answer this
 * function has always given. anchorsFor()'s first entry is the face the
 * dominant axis picks, which is what this used to compute on its own.
 */
export const anchorFor = (from: Box, to: Point): Anchor => anchorsFor(from, to)[0];

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

/**
 * An end of a line: a card, and whether there is actually a card drawn there.
 *
 * `bare` is optional so every existing caller and test passes a plain Box and
 * gets the behaviour it always got. It is the only non-geometric fact this
 * module knows about a card, and it is here because it changes an answer this
 * module gives - see endOf() below.
 */
export type End = Box & { bare?: boolean };

/**
 * Where a line joining this card actually stops: its outline, or its **middle**
 * if no card is drawn there.
 *
 * A card fills its rectangle, so stopping on the outline is stopping where the
 * picture starts. Running to the middle instead would bury half a card of line
 * under it - invisible until the hover lift raises the card and leaves a stub in
 * the gap, which is the bug drawnTilt() in canvas/web.ts is written about.
 *
 * An item with no card is the case that inverts all of it. `meta.bare` takes the
 * paint away and leaves the box - a logo cut out of its background, a note
 * without its paper, a model on its transparent buffer - so the rectangle is
 * mostly nothing with the thing itself somewhere in the middle of it. Two people
 * cut out of a photograph occupy the centre of a box that is four-fifths empty,
 * and a line clipped at that outline stops in open paper a card's width from
 * anything: it reads as a stray mark rather than as a join.
 *
 * So the same reasoning gives two answers and the flag is which one applies. The
 * overshoot that would be a bug on a card is the whole point without one: the
 * line runs in under the subject and the subject hides it, which is exactly what
 * a card does at its own edge.
 *
 * The middle rather than the thing's real silhouette, and that is not an
 * approximation being settled for. The alpha is in a WebP on the compositor's
 * side: this layer has no access to it, could not afford to trace it per frame
 * if it did, and what a bare item shows sits in the middle of its own box by
 * construction - it is what the box was fitted to.
 */
export const endOf = (card: End, target: Point): Point =>
  card.bare ? { x: card.x, y: card.y } : exitTowards(card, target);

/**
 * A routed path, carried the last stretch into whichever ends have no card.
 *
 * The router works in boxes - it has to, since what it is avoiding is cards - so
 * its first and last points are on the two faces. For a bare end that is the
 * same open paper endOf() exists to avoid, so the middle is added on.
 *
 * Added rather than substituted, and that is the whole of it: the face point is
 * where the route genuinely left the card, and dropping it would send the line
 * across the box on a diagonal the router never chose and never checked for
 * obstacles. What is appended is a stub that lies entirely inside a box, which
 * nothing can collide with.
 */
export function intoMiddles(points: Point[], a: End, b: End): Point[] {
  if (!a.bare && !b.bare) return points;
  const out = points.slice();
  if (a.bare) out.unshift({ x: a.x, y: a.y });
  if (b.bare) out.push({ x: b.x, y: b.y });
  return out;
}

/**
 * A finished route: the points a line is drawn through, ends included.
 *
 * An object rather than the bare array because a route is the sort of answer
 * that grows a second field - a reason it took the long way, a flag for a
 * crossing it could not avoid - and every caller already destructures.
 */
export type Route = { points: Point[] };

/**
 * The path a connection takes, as a list of points to draw straight lines
 * between. Always at least two, and always something: a pair with no route at
 * all still gets a line.
 *
 * `from` and `to` are item-shaped boxes - `{ x, y, w, h, rot }` - in whatever
 * coordinate system the caller draws in. `obstacles` are the other cards, in
 * the same shape and the same system, and must not include the two ends.
 *
 * `opts` is how the look and the caller's wider knowledge reach the algorithm -
 * `{ shape, step, clearance, fromSlot, toSlot, avoid }`, see the header.
 * Everything about it is optional and the default is the right-angled route
 * this always drew, which is what keeps every caller and every test that
 * predates the whimsy axis saying exactly what it said.
 *
 * There is no failure flag on the result, and there used to be. It marked the
 * straight line this drew when it could not find a way round, and canvas/web.js
 * drew those dimmed and dashed so a give-up was visible. Both are gone: the last
 * resort is an orthogonal elbow, which is a line that goes *behind* the cards
 * in its way rather than across them, and the web is drawn under the items - so
 * it looks like a connector passing under a photograph, because that is what it
 * is. A state worth marking as a failure has to look like one.
 *
 * What has changed is how nearly unreachable that last resort now is. It used
 * to be one sealed face away: the dominant axis picked a side, a card parked
 * against that side failed every rung of the ladder, and the elbow drew through
 * the lot. The faces escalate now (see anchorsFor), so a route concedes only
 * when all sixteen ways out are shut - which, at zero clearance, is a card
 * lying on top of one of the two ends. A line arriving under a card really is
 * arriving under a card, and there the elbow is the honest picture rather than
 * a shrug.
 */
export function routeConnection(
  from: Box, to: Box, obstacles: Box[] = [], opts: RouteOpts = {},
): Route {
  // The three reads below each lead with the field's own presence, which is what
  // `SHAPES.has(undefined)` and `undefined > 0` already answered: absent means
  // the default, at every one of them.
  const shape = opts.shape && SHAPES.has(opts.shape) ? opts.shape : 'square';
  const taut = shape === 'taut';
  const clearance = opts.clearance && opts.clearance > 0 ? opts.clearance : CLEARANCE;
  // Only 'grid' quantizes, and only when it was given a lattice to quantize to.
  // A board with no grid step is not a board whose connectors can answer one.
  const step = shape === 'grid' && opts.step && opts.step > 0 ? opts.step : 0;

  // Four ways out of each end, best first, and the pair at the head of them is
  // the one every attempt below runs on. The other fifteen pairs are the
  // escalation at the bottom, and nothing reaches them on an ordinary board.
  const as = anchorsFor(from, to, opts.fromSlot);
  const bs = anchorsFor(to, from, opts.toSlot);
  const a = as[0];
  const b = bs[0];

  // The other lines already drawn near this one, reduced to their segments once
  // rather than per lattice edge. Empty on every caller that has not thought
  // about it, and empty is what makes the search identical to the old one.
  const avoid = segmentsOf(opts.avoid);

  // Nearest first, so a cap that bites drops the cards least likely to be in
  // the way rather than whichever the caller happened to list last.
  const near = obstacles.length <= MAX_OBSTACLES ? obstacles : [...obstacles]
    .sort((p, q) => distSqToMidpoint(p, from, to) - distSqToMidpoint(q, from, to))
    .slice(0, MAX_OBSTACLES);

  // The two ends are obstacles too, and with no margin. Without them a route is
  // free to run straight through the card it started from, which happens
  // constantly when the far card is behind the near one. With a margin, the
  // stub points would be inside their own card's block and there would be
  // nowhere to start.
  const ends = [blockOf(from), blockOf(to)];

  // Sorted nearest-first once, so every attempt drops the same furthest cards
  // first when it has to trim - and sorted *only* when the cap did not already
  // do it. `near` is either the caller's list untouched or a copy this function
  // has just sorted by this same comparator, so re-sorting it was a second pass
  // over the whole array to arrive at the order it was already in.
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

  /**
   * The taut passes, or nothing, depending on the shape asked for. `cards` is
   * the other cards alone; the two ends are added where they belong.
   *
   * Pull first and aim second, in that order and not the other way round: which
   * way the first leg points is not known until the turns it was going to make
   * have been dropped, and aiming a leg that is about to be removed is work
   * thrown away.
   *
   * Both of them work against PULL_CLEARANCE rather than against the margin the
   * corridor was found at, and that is the point of there being two numbers.
   * The search is asked for room; the string is asked for a straight line and
   * given only what a line needs. Capped at the rung's own pad, so a route that
   * already conceded its clearance is not handed some back here.
   */
  const done = (points: Point[], cards: Box[], pad: number, snap: boolean) => {
    if (!taut) return { points };
    const soft = blocksOf(cards, Math.min(pad, PULL_CLEARANCE), snap);
    return { points: aim(pull(points, [...soft, ...ends]), soft) };
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
  const aim = (points: Point[], obstacles: Bounds[]) => {
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
  // Taken unless it lies along a line that is already there. The shortcut is
  // the one path that never reaches the search, so it is also the one place the
  // overlap cost cannot be charged - and left unchecked it would hand back the
  // coincident L in exactly the case the cost exists for. Handing it to the
  // search is not the same as refusing it: the cost prices an overlap rather
  // than banning one, so a board with no better answer gets this L back.
  if (easy && !laidOn(easy.points, avoid)) return done(easy.points, ordered, clearance, true);

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
  //   5. every other way out of the two cards, at full clearance and then none
  //
  // Four is the case the first three cannot answer, and it is not a corner: a
  // card stacked over one of the two ends encloses it, and no amount of margin
  // gets a line out of a box that is sealed. Nothing can be routed *around* a
  // card that is on top of the thing being routed to, so those stop counting -
  // which is also the honest reading, since a covered card is not something the
  // route is passing, it is something the route is arriving under.
  //
  // Five is new and it is the one that made the elbow below almost unreachable.
  // Every rung above it runs on the pair of faces the dominant axis picked, and
  // that choice is made before anything has looked at the board - so a card
  // parked flat against one of those two faces failed the whole ladder while
  // three open sides sat there. The other fifteen pairs are tried here, cheap L
  // first on all of them and the lattice search on as many as MAX_FACE_SEARCHES
  // allows, because a board that has got this far is a board where each search
  // is a real cost.
  //
  // And if even that finds nothing, the answer is still not a diagonal. It is
  // the plain two-bend elbow, drawn through whatever is left in the way - see
  // elbow() for why that is a real answer rather than a shrug, and why the flag
  // that used to mark these as failures is gone with it. What is worth knowing
  // is *when* it is reached now: sixteen ways out, at zero clearance, all shut.
  // That is a card lying over one of the two ends, and nothing else on a board
  // small enough for the lattice to hold.
  // -------------------------------------------------------------------------
  const overlapsEnd = (k: Bounds) => ends.some(e =>
    k.x0 < e.x1 - EPS && k.x1 > e.x0 + EPS && k.y0 < e.y1 - EPS && k.y1 > e.y0 + EPS);

  const attempt = (pool: Bounds[], a: Anchor, b: Anchor) => {
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

    const path = search(xs, ys, all, xi, yi, xj, yj, avoid);
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
  const rungs: [number, boolean][] = step
    ? [[clearance, true], [clearance, false], [clearance / 3, false], [0, false]]
    : [[clearance, false], [clearance / 3, false], [0, false]];

  for (const [pad, snap] of rungs) {
    const pool = blocksAt(pad, snap);
    const got = attempt(pool, a, b);
    if (got) return done(got.points, ordered, pad, snap);
  }
  // The cards that lie over an end drop out here, filtered on the card list
  // rather than on the blocks so that the taut pass can rebuild the same set at
  // its own margin - see done(), which is handed cards and a pad.
  const uncovered = ordered.filter(it => !overlapsEnd(blockOf(it)));
  if (uncovered.length !== ordered.length) {
    const got = attempt(blocksOf(uncovered, 0, false), a, b);
    if (got) return done(got.points, uncovered, 0, false);
  }

  // Rung five: the other fifteen ways out. Ordered by how far each end has had
  // to depart from the face the dominant axis wanted - `i + j` - so a route that
  // has to give up one end's preference is tried before one that gives up both.
  const pairs: [number, number][] = [];
  for (let sum = 1; sum <= 6; sum++) {
    for (let i = 0; i < 4; i++) {
      const j = sum - i;
      if (j >= 0 && j < 4) pairs.push([i, j]);
    }
  }
  let searches = 0;
  // Two margins and no snapping. Quantizing is a rung above the whole ladder and
  // was given up long before this, so there is nothing left here to try it on.
  const faceRungs: [number, boolean][] = [[clearance, false], [0, false]];
  for (const [pad, snap] of faceRungs) {
    const pool = blocksOf(ordered, pad, snap);
    const withEnds = [...pool, ...ends];
    // The cheap L on every pair before any lattice is built. A sealed face is
    // usually sealed by one card, and the open face beside it usually has the
    // plain two-bend path clear - which is the answer, at the cost of a loop
    // over four segments.
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

  // Even the elbow is offered to the taut pass. Nothing routed, which at this
  // point means every way out of both cards is shut at no clearance at all - a
  // card lying on top of an end, or a lattice that had to shed the card doing
  // the blocking. If a straight run between two of the elbow's own corners is
  // in fact clear, that is a better picture than a line through a card.
  return done(elbow(a, b), ordered, clearance, false);
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
function snapOut(k: Bounds, step: number): Bounds {
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
function crosses(p: Point, q: Point, blocks: Bounds[]) {
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

/**
 * One straight run of a line that is already on the board, reduced to the four
 * numbers an overlap test needs: which axis it lies along, where, and between
 * what.
 */
type Run = { flat: boolean, at: number, lo: number, hi: number };

/**
 * The other routes, flattened into the runs this one can lie on top of.
 *
 * Axis-aligned runs only, and the diagonals a taut route carries are dropped
 * rather than handled. Two diagonals coincide only when they share an angle as
 * well as a line, which is a measure-zero accident between two routes that were
 * pulled through different corridors - and the lattice this cost is charged
 * against has no diagonal edges to charge anyway. Every run that matters is one
 * of these.
 */
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

/**
 * How much of an axis-aligned segment lies on top of a run that is already
 * drawn. Zero for a crossing, which is the whole distinction being drawn here:
 * a line that crosses another reads as a diagram, and a line that lies along
 * one reads as a mistake in the drawing.
 *
 * Summed over the runs rather than unioned. Two lines already coincident with
 * each other charge a third twice for joining them, which is right: that place
 * is more crowded, not less.
 */
function overlapLen(flat: boolean, at: number, lo: number, hi: number, runs: Run[]) {
  let total = 0;
  for (const r of runs) {
    if (r.flat !== flat || Math.abs(r.at - at) > EPS) continue;
    const span = Math.min(hi, r.hi) - Math.max(lo, r.lo);
    if (span > EPS) total += span;
  }
  return total;
}

/**
 * Whether a finished path lies along a line that is already drawn, by enough of
 * its own length to be worth refusing a shortcut over.
 *
 * A threshold rather than any overlap at all, because two lines meeting at a
 * card share the last few units by construction - they are arriving at the same
 * place - and a test that counted those would send every second route to the
 * search to discover it could not do better.
 */
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
function search(
  xs: number[], ys: number[], blocks: Bounds[],
  xi: number, yi: number, xj: number, yj: number,
  avoid: Run[] = [],
) {
  const W = xs.length, H = ys.length;
  const N = W * H;
  if (xi < 0 || yi < 0 || xj < 0 || yj < 0) return null;

  // Precompute passability once per lattice edge rather than per visit. Every
  // interior edge is looked at from both of its ends and often several times
  // over, and the blocked test is a loop over every obstacle.
  const okRight = new Uint8Array(N);   // node -> the edge to (x+1, y) is clear
  const okDown = new Uint8Array(N);    // node -> the edge to (x, y+1) is clear
  // What each of those edges costs on top of its own length, for lying along a
  // line that is already drawn. Precomputed in the same pass and for the same
  // reason - an edge is relaxed from both ends and the test is a loop over every
  // run - and skipped entirely when there is nothing to avoid, which is every
  // caller that has not asked for this and every test that predates it.
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

  // 0 right, 1 left, 2 down, 3 up. A fifth heading - "not yet moving" - would
  // be the honest start state; instead the start is seeded in all four at zero
  // cost, which says the same thing and keeps the arrays a flat four deep.
  const STATES = N * 4;
  const g = new Float64Array(STATES).fill(Infinity);
  const from = new Int32Array(STATES).fill(-1);
  const done = new Uint8Array(STATES);
  const open: number[] = [];

  const h = (x: number, y: number) => Math.abs(xs[x] - xs[xj]) + Math.abs(ys[y] - ys[yj]);

  // A binary heap, where this was a linear scan for the smallest f on every
  // pop. That was affordable while a route was one search over a lattice bounded
  // at a couple of thousand nodes; it is not now that routeConnection() will run
  // up to four of them before it will draw a straight line, and it is what was
  // really bounding MAX_OBSTACLES - the cost of the scan is quadratic in the
  // open set, so every card added to the search cost more than the last.
  //
  // f is carried beside the state rather than recomputed, because with a heap it
  // is read on every sift comparison rather than once per pop.
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
    // Non-null on both: this is only ever called with the heap non-empty - the
    // search loop below pops only while `open.length` - and the two arrays are
    // pushed and popped together, so neither can run out before the other.
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
    // The overlap charge is a property of the edge and not of the direction
    // travelled, so the two headings that use one edge read the same number -
    // which is why it is stored against the lower-indexed end of each, exactly
    // as passability already is.
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
export function pathData(points: Point[], radius = 0, dx = 0, dy = 0) {
  if (!points.length) return '';
  const at = (p: Point) => `${(p.x - dx).toFixed(2)} ${(p.y - dy).toFixed(2)}`;
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
function along(p: Point, q: Point, r: number): Point {
  const len = Math.hypot(q.x - p.x, q.y - p.y) || 1;
  return { x: p.x + (q.x - p.x) * r / len, y: p.y + (q.y - p.y) * r / len };
}
