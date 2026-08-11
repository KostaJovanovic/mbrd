// The web: the lines between cards, drawn behind everything.
//
// **These are drawn, not derived.** This file used to compute a maximal planar
// set of segments over the item centres on every change - a Euclidean minimum
// spanning tree for connectedness, then every other thread that fit, shortest
// first, kept only if it crossed nothing already accepted. It was a good effect
// and it was nobody's: the board decided what related to what, and there was no
// way to say otherwise. So the same picture is now a list of pairs somebody
// drew (`board.connections`), and the spanning tree survives as a generator
// that offers to draw a set of them for you - see web-graph.js, which is
// unchanged, and cmds.connectSelection.
//
// The module kept its name, and the setting kept its key. `settings.web` is
// what an older build reads to decide whether to draw anything at all between
// cards, and renaming either would have cost the SHELL list, the layers test,
// three passages of docs/architecture.md and a silent change to every board
// that had the web switched on, for nothing.
//
// Drawn inside #world, so pan and zoom come for free from the layer transform.
// The stroke is marked non-scaling so a line stays a line at 8x instead of
// becoming a beam.
//
// Two jobs, and they are deliberately separated: `build` decides which lines
// exist and where their ends are, `paint` decides which of them go into the `d`
// string. Only build reads the board, and only paint reads the viewport, so
// panning across a board never rebuilds the geometry and moving an item never
// waits on the view.

import { board, bus, isRider } from '../state.js';
import { rafThrottle } from '../util.js';
import { webZoom } from './viewport.js';
import { segmentMeetsRect } from '../geometry.js';
// Where a line runs when there are cards in the way - see web-route.js. Pure,
// and deliberately not in this file for the same reason web-graph.js is not:
// the algorithm is the half that can be tested without a browser.
import { routeConnection, pathData, blockOf, CLEARANCE } from '../web-route.js';
// Which cards are near enough to be in the way. The index is kept current by
// canvas/items.js on every add, remove and move.
import { queryRect } from './spatial.js';

const SVG_NS = 'http://www.w3.org/2000/svg';

/**
 * Connections belong to the spatial Desktop arrangement only, and only when the
 * board asks to see them. `settings.web` is layout-local (Desktop's own
 * checkbox) and now defaults to **on**: a line somebody drew and cannot see is
 * a bug, where the automatic web this replaced defaulted to off because an
 * effect nobody asked for is an imposition. The `!== false` is what makes that
 * default reach a board whose settings never went through normalizeSettings().
 *
 * The quality dial used to be able to take this away as well, through a
 * `threads` flag, and it no longer can. That flag existed because working out a
 * planar graph over every card on every drag frame is genuinely more than a
 * tired phone should be asked for; drawing a stored list of pairs is not, so
 * what the flag had become was a switch that silently hid work the user had
 * done. It is gone from quality.js entirely rather than left inert.
 */
export const webVisible = (mode = board.layoutMode) =>
  mode !== 'mobile' && board.settings.web !== false;

/**
 * How far outside the viewport a thread is still drawn, in *screen* px.
 *
 * The same margin items.js mounts cards with, in the same unit and for the same
 * two reasons: the pan that brings a thread on screen is the frame that would
 * otherwise have to draw it, so a margin means the work happened a frame or two
 * earlier - and a margin measured on the board rather than on the screen stops
 * meaning anything as soon as you zoom, since the visible slice of board halves
 * with every doubling while the margin does not.
 */
const CULL_MARGIN_PX = 300;
/** Capped in world units at the flat margin this used to be - see items.js. */
const CULL_MARGIN_MAX = 400;

/**
 * A thread appears and disappears by fading, which needs two things this file
 * did not have: a way to tell one thread from another between redraws, and an
 * element per thread to carry the opacity.
 *
 * Identity is the pair of item ids, never the pair of indices. Indices shift
 * the moment anything is added or removed, so a thread that held its place in
 * the array while its endpoints changed underneath it would quietly become a
 * different thread and never fade at all.
 *
 * The element is the part worth being careful about. Giving all of them their
 * own <line> would undo the reason this was one path to begin with - build()
 * runs on every frame of a drag, because the ends move with the card even
 * though the list does not change, and a few hundred elements to reconcile is a
 * different order of cost from one `d` string. So a line only gets an element
 * while it is actually fading, and is handed back to the bulk path the moment
 * it lands. In the steady state, including the whole of a drag - where every
 * line moves and none of them arrives or leaves - this is one path and one
 * attribute write.
 */
const FADE_IN_MS = 400;
const FADE_OUT_MS = 300;

/**
 * How far out the web is worth drawing at all.
 *
 * The stroke is non-scaling, so a thread stays the same hairline however far
 * out you go while the board it is drawn over shrinks. Zoomed right out, a few
 * hundred hairlines over a board the size of a postage stamp stop reading as
 * connections between things and become a grey scribble laid across the one
 * view whose whole purpose is to show the shape of the board.
 *
 * So it goes, and it goes in a band rather than at a line: full strength a
 * band's width above the rung, thinning to nothing at the rung itself, and
 * below that not drawn at all - which is the half that also gives the work
 * back, since the furthest-out view is the one with every thread inside it and
 * nothing culled.
 *
 * The floor is the board's own detail rung, imported rather than written again
 * here, so the threads leave at the same moment the labels and the grips do
 * rather than at a number of this file's own choosing four hundredths away.
 *
 * Which is why this is a width and not a second threshold. The rung is higher
 * under a finger than under a mouse, and a fixed ceiling written here would
 * have been *below* the floor on a phone - a band of negative width, which
 * divides by zero on the way to an opacity. Expressed as the distance above the
 * rung, the fade is the same fifteen hundredths of travel wherever the rung
 * happens to be.
 */
const WEB_FADE_BAND = 0.15;

let svg = null;
let path = null;         // every settled thread, as subpaths of one `d`
let failPath = null;     // the give-up (straight fallback) threads, drawn dimmed and dashed
let fadeLayer = null;    // <g> holding only the threads currently fading
// The styled connections - the ones somebody gave a direction, a dash or a
// label - each drawn as its own element. Kept out of the bulk path on purpose:
// a dash and an arrowhead are per-line, where the bulk path is one shared
// stroke, and they are rare enough (a handful a board, against hundreds of plain
// lines) that a full rebuild of this layer on each paint costs nothing.
let decoLayer = null;
let vp = null;           // for the visible rect; absent in tests, which then draw everything

/** The box the built geometry describes, kept by build() so paint() need not re-derive it. */
let settledBox = { minX: Infinity, minY: Infinity, maxX: -Infinity, maxY: -Infinity };
/** The box last written to the <svg>, so an unchanged one is not rewritten. */
let lastBox = '';
/** The padded rectangle the drawing on screen was culled against - see paint(). */
let paintedRect = null;

/** key -> { el, dir, timer, seg } for the threads mid-fade. */
const animating = new Map();
/** Keys currently drawn in the bulk path. */
const settled = new Set();
/**
 * key -> `{ a, b, points, sig }` - the last known geometry of each line, so one
 * whose item has gone can still fade out from where it was rather than
 * vanishing the instant it loses a centre.
 *
 * `points` is the whole path, two entries for a straight line and more for a
 * routed one. `sig` is the two end boxes as a string: build() reuses a route
 * whose ends have not moved and throws one away the moment they have, which is
 * the mechanism behind "straight while dragging, routed on the drop" - see
 * scheduleRoute().
 */
const lastSeg = new Map();

// A separator that cannot occur in an id, so two ids can share one string key.
//
// Escaped, not typed. A literal NUL in the source makes every tool that
// sniffs for one - ripgrep, git diff, half the editors in existence - decide
// this file is binary and stop showing it. Same byte, same behaviour, and the
// file stays readable.
//
// uid() cannot produce one. An id read out of somebody else's board.json
// could, which is why state.js/makeItem holds ids to a string and a length -
// worth knowing that the guarantee lives there rather than here.
const keyOf = (a, b) => (a < b ? a + '\0' + b : b + '\0' + a);

/**
 * Both jobs share one frame.
 *
 * A rebuild always repaints, but a repaint must never silently drop a rebuild
 * that was asked for in the same frame - hence the flag rather than two
 * throttles. Two would race: the paint throttle could fire first and draw the
 * old edges, and the build throttle would then have to schedule a third frame.
 */
let wantBuild = false;
/** A repaint that has to happen whatever the view is doing - see paint(). */
let wantPaint = false;
let frame = () => {};
const requestBuild = () => { wantBuild = true; wantPaint = true; frame(); };
const requestPaint = () => { wantPaint = true; frame(); };
/**
 * The eye moved, which on its own may well leave the drawing untouched.
 *
 * It does restart the route pass, though, and for the same reason a drag does:
 * a pan is a thing in motion, and a line coming on screen during one should
 * arrive resolved rather than resolve under the hand. routePass() is cheap when
 * nothing is owed, which is the steady state.
 */
const viewMoved = () => { frame(); scheduleRoute(); };

function tick() {
  if (wantBuild) { wantBuild = false; build(); }
  const forced = wantPaint;
  wantPaint = false;
  paint(forced);
}

// ---------------------------------------------------------------------------
// The performance rule
//
// The web this replaced could afford to rebuild everything on every frame of a
// drag, because a spanning-tree edge is two points and a comparison. Routing is
// not, and this is the one place the whole feature can go wrong.
//
// So: **nothing is routed while anything is moving.** build() reuses a stored
// route whose two ends have not moved and drops one whose ends have, which
// leaves a card being dragged trailing straight lines for the length of the
// gesture - the same bargain items.css already strikes about what the board
// stops paying for while it is being moved. A pass over the routes is scheduled
// on every build and every view change and restarted each time, so it runs once
// the hand comes off rather than sixty times on the way there.
//
// The delay is a settling time, not a debounce for its own sake. Long enough
// that a drag never reaches it, short enough that a drop feels like it resolved
// rather than like it thought about it.
// ---------------------------------------------------------------------------
const ROUTE_SETTLE_MS = 110;

/**
 * How many lines will be routed in one pass before the rest are left straight.
 *
 * A ceiling rather than a target: a board with more connections on screen than
 * this has other problems, and the honest failure is some of them staying
 * straight rather than the pass taking a visible pause. The on-screen ones go
 * first, so what is left straight is what nobody is looking at.
 */
const ROUTE_BUDGET = 200;

let routeTimer = 0;
const scheduleRoute = () => {
  clearTimeout(routeTimer);
  routeTimer = setTimeout(routePass, ROUTE_SETTLE_MS);
};

export function initWeb(worldEl, viewport) {
  svg = document.createElementNS(SVG_NS, 'svg');
  svg.id = 'web';
  svg.setAttribute('aria-hidden', 'true');

  path = document.createElementNS(SVG_NS, 'path');
  path.setAttribute('fill', 'none');
  // A second bulk path for the routes the router gave up on (web-route.js marks
  // them straight:true). Drawn dimmed and dashed by its class so "no way found
  // here" is legible rather than looking like an ordinary direct line.
  failPath = document.createElementNS(SVG_NS, 'path');
  failPath.setAttribute('fill', 'none');
  failPath.setAttribute('class', 'web-fallback');
  fadeLayer = document.createElementNS(SVG_NS, 'g');

  // One arrowhead marker, reused at both ends. orient="auto-start-reverse" is
  // what lets it serve as marker-start too: at the end it points the way the
  // line travels, and at the start the same marker is flipped to point back at
  // the first card. Built element by element rather than through innerHTML,
  // because an <svg> written as an HTML string is parsed into the HTML namespace,
  // where it is markup that looks right and draws nothing (see assets/icons.svg).
  const defs = document.createElementNS(SVG_NS, 'defs');
  const marker = document.createElementNS(SVG_NS, 'marker');
  marker.id = 'web-arrow';
  marker.setAttribute('viewBox', '0 0 10 10');
  marker.setAttribute('refX', '9');
  marker.setAttribute('refY', '5');
  marker.setAttribute('markerWidth', '7');
  marker.setAttribute('markerHeight', '7');
  marker.setAttribute('orient', 'auto-start-reverse');
  const head = document.createElementNS(SVG_NS, 'path');
  head.setAttribute('d', 'M0 0L10 5L0 10z');
  head.setAttribute('class', 'web-arrowhead');
  marker.append(head);
  defs.append(marker);

  decoLayer = document.createElementNS(SVG_NS, 'g');
  svg.append(defs, path, failPath, fadeLayer, decoLayer);

  // First child of #world, and it never claims a pointer - the web is a
  // backdrop for the items, not a thing you can catch hold of.
  worldEl.prepend(svg);

  vp = viewport || null;
  frame = rafThrottle(tick);
  bus.on('items', requestBuild);
  bus.on('geom', requestBuild);
  bus.on('board:load', requestBuild);
  bus.on('layout', requestBuild);
  // A line drawn or removed. Its own event rather than 'items', which fires for
  // a drag, a delete and an undo as well - see the note beside it in state.js.
  bus.on('connections', requestBuild);
  // Only the web toggle changes what is drawn; other settings (spacing, units)
  // fire the same event and must not drag a rebuild in with them.
  bus.on('settings', key => { if (key === 'web') requestBuild(); });
  // Panning and zooming change which threads are worth drawing and nothing
  // else, so they ask for a paint and never for a build.
  if (vp) vp.onChange(viewMoved);

  build();
  paint(true);
}

/**
 * Send a thread towards visible or towards gone.
 *
 * Used both to start a fade and to reverse one in flight. Reversing rather than
 * restarting is deliberate: a thread that flickers out and back - which happens
 * constantly while dragging an item past its neighbours - picks up from
 * whatever opacity it had reached instead of snapping to an end state first.
 */
function fadeTo(key, entry, dir) {
  clearTimeout(entry.timer);
  entry.dir = dir;
  const ms = dir === 'in' ? FADE_IN_MS : FADE_OUT_MS;
  entry.el.style.transitionDuration = ms + 'ms';
  entry.el.style.opacity = dir === 'in' ? '1' : '0';
  // A shade past the transition, so the element is only reclaimed once the
  // paint has certainly finished rather than on the same tick as its last frame.
  entry.timer = setTimeout(() => land(key), ms + 40);
}

function begin(key, seg, dir) {
  if (!seg) return;
  // A <path>, not a <line>. A routed connection bends, so the fading copy has
  // to be able to draw the same shape the bulk path draws - and the two share
  // one rule in canvas.css, which is what keeps a line landing out of a fade
  // from changing appearance as it does.
  const el = document.createElementNS(SVG_NS, 'path');
  el.setAttribute('class', 'thread');
  el.setAttribute('fill', 'none');
  el.style.opacity = dir === 'in' ? '0' : '1';
  fadeLayer.append(el);
  const entry = { el, dir, seg, timer: 0 };
  animating.set(key, entry);
  // The element has to sit in the document at its starting opacity for one
  // frame before the target is written. Set both in the same tick and there is
  // no previous value to interpolate from, so the change simply applies and
  // the thread appears at full strength - which is the bug this exists to fix.
  requestAnimationFrame(() => {
    if (animating.get(key) === entry) fadeTo(key, entry, entry.dir);
  });
}

/** A fade has finished: give the thread back to the path, or forget it. */
function land(key) {
  const entry = animating.get(key);
  if (!entry) return;
  animating.delete(key);
  entry.el.remove();
  if (entry.dir === 'in') settled.add(key);
  else lastSeg.delete(key);
  // The thread moved between the two layers; which threads exist did not
  // change, so this needs the `d` rewritten and nothing more.
  requestPaint();
}

/**
 * Item centres in #world's coordinates.
 *
 * World y points up and CSS y points down, so a centre that is at world
 * (x, y) is laid out at (x, -y) - the same negation items.js/place() applies,
 * and the only conversion this module needs.
 */
function centres() {
  // A stuck note is part of the thing it is pinned to, not an end of its own: it
  // sits on top of its host, so a line run out to it would double back on the
  // host's own and read as a tether on the sticky. Riders are left out; the host
  // carries the connection for the pair. A note stuck to a card it is joined to
  // therefore stops showing that line while it is stuck, and starts again when
  // it is pulled off - which is the same thing the web did and is the honest
  // reading either way.
  // Size and rotation ride along, unused here and read by the router in step 5:
  // a card is an obstacle to route around, not only a point to reach. World y
  // points up and this layer lays y down, so a card turned by `rot` in the world
  // is turned by `-rot` here - the reflection that takes (x, y) to (x, -y) flips
  // the sense of the angle.
  // Ghost cards are not ends either. A hint relates to nothing - it is talking
  // to the person, not to the board - and serializeBoard() strips them, so a
  // connection to one could not survive a save even if one could be drawn.
  return board.items
    .filter(i => !isRider(i) && i.type !== 'ghost')
    .map(i => ({ id: i.id, x: i.x, y: -i.y, w: i.w, h: i.h, rot: -(i.rot || 0) }));
}

/**
 * Let go of every line: the fading elements, the settled set, the stored routes
 * and the box they described.
 *
 * Two callers with the same need. build() runs it when the layout or the
 * checkbox says there is nothing to draw - releasing rather than merely hiding,
 * so a large board spends no time holding geometry this layout never shows -
 * and resetWeb() runs it to make the next build start from nothing.
 */
function release() {
  for (const entry of animating.values()) {
    clearTimeout(entry.timer);
    entry.el.remove();
  }
  animating.clear();
  settled.clear();
  lastSeg.clear();
  settledBox = { minX: Infinity, minY: Infinity, maxX: -Infinity, maxY: -Infinity };
  paintedRect = null;
  lastBox = '';
  if (path) path.setAttribute('d', '');
  if (failPath) failPath.setAttribute('d', '');
  if (decoLayer) while (decoLayer.firstChild) decoLayer.removeChild(decoLayer.firstChild);
}

/**
 * Draw the lines again from nothing - the web's half of "Reload board".
 *
 * The other reset* calls in ui/board-actions.js exist because a live board can
 * drift from what its data says, and this one is here for a reason the others
 * are not: a route is *cached*. build() keeps a stored path for exactly as long
 * as its two ends have not moved, which is what lets a drag trail straight lines
 * and resolve on the drop - and it also means a route that came out wrong stays
 * wrong through the one command whose whole purpose is to put things right.
 *
 * Dropping the stored routes is therefore the substance of this, not a side
 * effect of clearing the drawing. Everything is rerouted on the settle after the
 * rebuild, against wherever the cards are now.
 */
export function resetWeb() {
  if (!svg) return;
  release();
  requestBuild();
}

/**
 * The two end boxes, as a string. Two lines with the same signature have the
 * same route, and a signature that changed is a route that has to be worked out
 * again. Rounded to a tenth of a world unit: a route does not change because a
 * card moved a thousandth of a pixel, and a signature that turned on the last
 * float bit would never match twice.
 */
const sigOf = (a, b) =>
  [a.x, a.y, a.w, a.h, a.rot, b.x, b.y, b.w, b.h, b.rot]
    .map(n => Math.round(n * 10) / 10).join(',');

/** Grow settledBox to hold a point. */
function stretchBox(p) {
  if (p.x < settledBox.minX) settledBox.minX = p.x;
  if (p.y < settledBox.minY) settledBox.minY = p.y;
  if (p.x > settledBox.maxX) settledBox.maxX = p.x;
  if (p.y > settledBox.maxY) settledBox.maxY = p.y;
}

/**
 * Which lines exist and where their ends are. Runs when an item has moved,
 * arrived or gone, and when a connection is drawn or removed.
 */
function build() {
  if (!svg) return;
  // Mobile is a reading-order feed, not a spatial map. Do not merely hide the
  // lines: release the settled/fading geometry so a large board spends no time
  // holding on to connections that this layout never shows.
  if (!webVisible()) {
    release();
    svg.style.display = 'none';
    return;
  }
  // id -> where that card is, for the ends of every stored pair. Cards this
  // layer does not node - a rider, a hint - are simply absent from the map, and
  // a pair naming one is skipped below along with a pair naming a card that has
  // been deleted. That is the whole of the dangling story on this side: not
  // drawn, no bookkeeping, and it comes back when the item does.
  const where = new Map(centres().map(p => [p.id, p]));

  const wanted = new Map();
  // The box the geometry describes, worked out here rather than in paint().
  //
  // It is a property of where the connected cards are, and they do not move
  // when the view does - so re-deriving it was a loop over the board on every
  // frame of every pan, to arrive at the number it arrived at last frame.
  //
  // Over the ends actually used, not over every card. A board of four hundred
  // items with two of them joined describes a box the size of the two, and
  // sizing the <svg> to the whole board would be an element the size of the
  // board holding one short line.
  settledBox = { minX: Infinity, minY: Infinity, maxX: -Infinity, maxY: -Infinity };
  for (const conn of board.connections) {
    const [a, b] = conn;
    const pa = where.get(a);
    const pb = where.get(b);
    if (!pa || !pb) continue;
    const key = keyOf(a, b);
    // A stored route is kept exactly as long as both of its ends are where they
    // were. The moment either moves, the route is thrown away and the line
    // falls back to a straight one until the pass scheduled below runs - which
    // is the whole of "no routing while anything is moving".
    const sig = sigOf(pa, pb);
    const held = lastSeg.get(key);
    const seg = held && held.sig === sig
      ? held
      : { a: pa, b: pb, sig, points: [{ x: pa.x, y: pa.y }, { x: pb.x, y: pb.y }] };
    // The display settings ride on the seg, refreshed every build even when the
    // route is reused - an edit changes the look without moving an end, so the
    // sig is unchanged and the seg is the held one, which must still pick up the
    // new meta. Its direction is read against a and b in their stored order.
    seg.meta = conn[2] || null;
    seg.ends = { a, b };
    wanted.set(key, seg);
    // Over the path, not only over the two ends: a route that bends out around
    // a card reaches past both of them, and an <svg> clips at its own edge.
    for (const p of seg.points) stretchBox(p);
  }
  scheduleRoute();

  // A fade costs an element, a transition and a timer, and none of that is
  // worth spending on a thread nobody can see. Opening a 400-item board used
  // to mint eleven hundred <line> elements at once and animate every one of
  // them, almost all outside the viewport; off screen, a thread now simply is
  // or is not, and only the ones on screen get the courtesy of fading.
  const vis = visibleBox(cullMargin());
  const onScreen = seg => !vis || !seg ||
    !(Math.max(seg.a.x, seg.b.x) < vis.x0 || Math.min(seg.a.x, seg.b.x) > vis.x1 ||
      Math.max(seg.a.y, seg.b.y) < vis.y0 || Math.min(seg.a.y, seg.b.y) > vis.y1);

  // Threads that should be visible: settled ones just move, the rest start or
  // reverse a fade towards visible.
  for (const [key, seg] of wanted) {
    lastSeg.set(key, seg);
    if (settled.has(key)) continue;
    const live = animating.get(key);
    if (!live) {
      // A styled line skips the fade and settles straight in: it is drawn by its
      // own element in decoLayer, not by the bulk path a fade hands back to, so
      // there is no shared stroke for it to fade against.
      if (onScreen(seg) && !seg.meta) begin(key, seg, 'in');
      else settled.add(key);
      continue;
    }
    live.seg = seg;
    if (live.dir === 'out') fadeTo(key, live, 'in');
  }
  // Threads that should not: settled ones need an element to fade with, and
  // ones already fading in turn around from wherever they had got to.
  for (const key of [...settled]) {
    if (wanted.has(key)) continue;
    settled.delete(key);
    const seg = lastSeg.get(key);
    if (onScreen(seg)) begin(key, seg, 'out');
    else lastSeg.delete(key);
  }
  for (const [key, live] of animating) {
    if (!wanted.has(key) && live.dir === 'in') fadeTo(key, live, 'out');
  }
}

/**
 * Work out where every line actually runs, once things have stopped moving.
 *
 * On-screen first and then the rest, so a budget that bites leaves straight
 * lines where nobody is looking. A line whose ends have not moved since it was
 * last routed keeps the path it has - build() is what decides that, by holding
 * or dropping the stored route - so the common case here is a handful of lines
 * around one card that was just dragged, not the whole board.
 *
 * The obstacles come from the spatial index rather than from a scan of the
 * board: the query rectangle is the two ends' bounding box grown by the
 * clearance, so a line between neighbours never considers the other four
 * hundred cards. The index answers with a *superset* - it is a grid of cells
 * and a cell shared with the query is enough - which is exactly right here,
 * since the router does its own precise work against the boxes it is handed.
 */
function routePass() {
  if (!svg || !webVisible()) return;
  const where = new Map(centres().map(p => [p.id, p]));
  const vis = visibleBox(cullMargin());
  const near = seg => !vis ||
    !(Math.max(seg.a.x, seg.b.x) < vis.x0 || Math.min(seg.a.x, seg.b.x) > vis.x1 ||
      Math.max(seg.a.y, seg.b.y) < vis.y0 || Math.min(seg.a.y, seg.b.y) > vis.y1);

  const owed = [...lastSeg.entries()].filter(([, seg]) => !seg.routed);
  // On screen first. A stable partition rather than a sort: the order within
  // each half does not matter and a comparator would only make it look like it
  // did.
  const order = [...owed.filter(([, s]) => near(s)), ...owed.filter(([, s]) => !near(s))];

  let spent = 0;
  for (const [, seg] of order) {
    if (spent++ >= ROUTE_BUDGET) break;
    // seg.a and seg.b already carry the id and the box - centres() puts both on
    // every point - so there is nothing to look up here.
    const { a, b } = seg;
    const routed = routeConnection(a, b, obstaclesBetween(a, b, where));
    seg.points = routed.points;
    seg.straight = routed.straight;
    seg.routed = true;
    for (const p of seg.points) stretchBox(p);
  }
  // Forced: the geometry changed without the *set* of lines changing, which is
  // the one case paint()'s own "has the view left the rectangle it culled
  // against" shortcut would otherwise talk it out of.
  requestPaint();
}

/**
 * The cards a line between these two might have to go around.
 *
 * In world coordinates on the way in and this layer's on the way out. The index
 * is built from item geometry, where y points up; everything here lays y down,
 * so the query rectangle flips and the ids that come back are looked up in the
 * already-flipped map rather than converted a second time.
 */
function obstaclesBetween(a, b, where) {
  const pad = CLEARANCE * 2;
  const box = {
    x0: Math.min(a.x, b.x) - pad, x1: Math.max(a.x, b.x) + pad,
    y0: Math.min(a.y, b.y) - pad, y1: Math.max(a.y, b.y) + pad,
  };
  // The two ends themselves have to be inside the query or a route out of a
  // card that is entirely past the other would have no room to start.
  for (const end of [blockOf(a, pad), blockOf(b, pad)]) {
    box.x0 = Math.min(box.x0, end.x0); box.x1 = Math.max(box.x1, end.x1);
    box.y0 = Math.min(box.y0, end.y0); box.y1 = Math.max(box.y1, end.y1);
  }
  const world = { x0: box.x0, x1: box.x1, y0: -box.y1, y1: -box.y0 };
  const out = [];
  for (const id of queryRect(world)) {
    if (id === a.id || id === b.id) continue;
    const p = where.get(id);
    if (!p) continue;                       // a rider or a hint: not an obstacle
    const k = blockOf(p, 0);
    // The index is a superset by design, so this is the precise re-test it owes
    // - a plain box overlap, which is all an axis-aligned router can use.
    if (k.x1 < box.x0 || k.x0 > box.x1 || k.y1 < box.y0 || k.y0 > box.y1) continue;
    out.push(p);
  }
  return out;
}

/**
 * The visible rect in the web's own coordinates, widened by `margin` world px.
 *
 * World y points up and this layer is laid out with y down, so the rect flips:
 * the top edge of the box is the *largest* world y.
 */
function visibleBox(margin = 0) {
  if (!vp) return null;
  const r = vp.visibleRect(margin);
  return { x0: r.x0, x1: r.x1, y0: -r.y1, y1: -r.y0 };
}

/** The cull margin in world units at the current zoom. */
const cullMargin = () => Math.min(CULL_MARGIN_PX / (vp ? vp.zoom : 1), CULL_MARGIN_MAX);

/** Is `inner` wholly within `outer`? */
const within = (inner, outer) =>
  inner.x0 >= outer.x0 && inner.x1 <= outer.x1 &&
  inner.y0 >= outer.y0 && inner.y1 <= outer.y1;

/**
 * Which threads are drawn. Runs on a build and on every view change.
 *
 * A thread is kept if the thread itself meets the visible rect, not if its
 * bounding box does. The two differ on exactly the case a web is full of: the
 * long diagonal. Its bounding box is most of the board, so a box test passes it
 * from almost anywhere and it is emitted into `d` on every frame of every pan,
 * having never come near the screen. On a dense board that is the majority of
 * the path string - work done to draw nothing, and paid for again each frame
 * because the string is rebuilt.
 *
 * Still conservative in the direction that matters: the test is exact about the
 * segment and the rect is already widened by CULL_MARGIN, so a thread arrives a
 * few hundred world units before it is needed rather than popping in at the
 * edge.
 */
function paint(forced = false) {
  if (!svg) return;
  if (!webVisible()) {
    svg.style.display = 'none';
    paintedRect = null;
    return;
  }
  // Nothing to draw, or too far out for it to mean anything. Both answers are
  // the same answer, and taking it here means the whole `d` string below is
  // never built at the zoom where it would be longest.
  const z = vp ? vp.zoom : 1;
  if ((!settled.size && !animating.size) || z < webZoom()) {
    svg.style.display = 'none';
    // Nothing was drawn, so nothing below is true of what is on screen.
    paintedRect = null;
    return;
  }
  svg.style.display = '';
  // Linear across the band. Not eased: this tracks a continuous gesture rather
  // than playing on its own, so what it has to be is proportional to the pinch,
  // and any curve on it reads as the web lagging the fingers.
  const floor = webZoom();
  svg.style.opacity = z >= floor + WEB_FADE_BAND
    ? ''
    : ((z - floor) / WEB_FADE_BAND).toFixed(3);

  // Everything from here down is a function of where the *threads* are, not of
  // where the eye is - the only thing the view decides is which of them are
  // worth putting in the string. So while the screen stays inside the padded
  // rectangle the last pass culled against, the string it would build is the
  // string that is already there, and a pan can return without touching it.
  //
  // Which is the whole of the saving. The `d` below is one long line of
  // coordinates for every thread on screen, rebuilt from scratch and handed to
  // the browser to re-parse; on a board with a few hundred threads that was
  // several milliseconds, spent on every frame of every pan, to arrive at what
  // it arrived at last frame. A thread does not move when you look somewhere
  // else.
  //
  // A fade starting or landing, or the threads themselves changing, comes
  // through as `forced` - those genuinely do change the string.
  const tight = visibleBox(0);
  if (!forced && paintedRect && tight && within(tight, paintedRect)) return;
  paintedRect = tight ? visibleBox(cullMargin()) : null;

  // The box has to hold the fading threads too. One of them may be anchored to
  // an item that has just been deleted, sitting outside the box the surviving
  // centres describe - and an SVG clips at its own edge, so it would be cut in
  // half on its way out.
  //
  // It is the *whole* board's box, not the visible one. Sizing it to the view
  // would move its origin on every pan, which means re-emitting every
  // coordinate in `d` for threads that had not moved at all - the opposite of
  // what the culling is for.
  // The settled half is build()'s answer and does not move with the view; only
  // the fading threads are added here, and there are rarely any.
  let { minX, minY, maxX, maxY } = settledBox;
  const stretch = p => {
    if (p.x < minX) minX = p.x;
    if (p.y < minY) minY = p.y;
    if (p.x > maxX) maxX = p.x;
    if (p.y > maxY) maxY = p.y;
  };
  for (const entry of animating.values()) for (const p of entry.seg.points) stretch(p);
  // A board whose items all sit on one row has a zero-height box, and an SVG
  // with a zero extent renders nothing at all - so the box never closes fully.
  const w = Math.max(maxX - minX, 1);
  const h = Math.max(maxY - minY, 1);

  const box = `${minX.toFixed(2)} ${minY.toFixed(2)} ${w.toFixed(2)} ${h.toFixed(2)}`;
  if (box !== lastBox) {
    lastBox = box;
    svg.style.left = minX.toFixed(2) + 'px';
    svg.style.top = minY.toFixed(2) + 'px';
    svg.style.width = w.toFixed(2) + 'px';
    svg.style.height = h.toFixed(2) + 'px';
    svg.setAttribute('viewBox', `0 0 ${w.toFixed(2)} ${h.toFixed(2)}`);
  }

  const vis = paintedRect;

  // One path of many subpaths rather than one element per line: swapping a
  // single `d` attribute beats reconciling a few hundred nodes. Only the
  // settled ones are here; the fading ones are drawn as their own <path> just
  // below, and drawing a line in both places at once would leave a fading one
  // with a solid twin under it.
  const r = cornerRadius();
  let d = '';
  let dFail = '';
  for (const key of settled) {
    const seg = lastSeg.get(key);
    if (!seg) continue;
    // Styled lines are drawn in decoLayer, never the bulk stroke - a dash or an
    // arrow is per-line and this path is one shared `d`.
    if (seg.meta) continue;
    if (vis && !meetsRect(seg.points, vis)) continue;
    // A give-up route rides its own bulk path so it can be dimmed and dashed; a
    // real route rides the normal one. Two `d` swaps, still not per-line nodes.
    if (seg.straight) dFail += pathData(seg.points, r, minX, minY);
    else d += pathData(seg.points, r, minX, minY);
  }
  path.setAttribute('d', d);
  failPath.setAttribute('d', dFail);

  // The box's origin moves whenever the outermost end does, so every fading
  // line is repositioned each frame as well - they are relative to a corner
  // that is itself in motion. There are only ever a handful, so they are not
  // worth culling.
  for (const { el, seg } of animating.values()) {
    // A line styled while it was mid-fade is drawn by decoLayer instead, so its
    // fading element is left blank rather than showing a solid twin under the
    // styled one. The fade timer still removes the empty element on its own.
    el.setAttribute('d', seg.meta ? '' : pathData(seg.points, r, minX, minY));
  }

  drawDecorations(minX, minY, r, vis);
}

/**
 * Redraw the styled connections - the ones with a direction, a dash or a label.
 *
 * Rebuilt from nothing each paint rather than reconciled, which is the opposite
 * of the rule the bulk path follows and right for the same reason it is wrong
 * there: these are a handful, not hundreds, so clearing and re-appending a few
 * elements costs less than tracking which changed. Everything they need is on
 * the seg - its routed points, and the meta that says how to draw them.
 */
function drawDecorations(minX, minY, r, vis) {
  while (decoLayer.firstChild) decoLayer.removeChild(decoLayer.firstChild);
  const segs = [];
  for (const key of settled) { const s = lastSeg.get(key); if (s?.meta) segs.push(s); }
  for (const [key, live] of animating) {
    if (!settled.has(key) && live.seg?.meta) segs.push(live.seg);
  }
  for (const seg of segs) {
    if (vis && !meetsRect(seg.points, vis)) continue;
    const line = document.createElementNS(SVG_NS, 'path');
    line.setAttribute('class', 'web-styled');
    line.setAttribute('d', pathData(seg.points, r, minX, minY));
    const style = seg.meta.style;
    if (style === 'dashed') line.setAttribute('stroke-dasharray', '7 5');
    else if (style === 'dotted') line.setAttribute('stroke-dasharray', '0.5 5');
    const dir = seg.meta.dir;
    if (dir === 'fwd' || dir === 'both') line.setAttribute('marker-end', 'url(#web-arrow)');
    if (dir === 'back' || dir === 'both') line.setAttribute('marker-start', 'url(#web-arrow)');
    decoLayer.append(line);

    if (seg.meta.label) {
      const mid = polyMidpoint(seg.points);
      const text = document.createElementNS(SVG_NS, 'text');
      text.setAttribute('class', 'web-label');
      text.setAttribute('x', (mid.x - minX).toFixed(2));
      text.setAttribute('y', (mid.y - minY).toFixed(2));
      text.setAttribute('text-anchor', 'middle');
      text.textContent = seg.meta.label;
      decoLayer.append(text);
    }
  }
}

/** The point half way along a polyline by arc length - where a label sits. */
function polyMidpoint(points) {
  if (!points || points.length < 2) return points?.[0] || { x: 0, y: 0 };
  const legs = [];
  let total = 0;
  for (let i = 1; i < points.length; i++) {
    const len = Math.hypot(points[i].x - points[i - 1].x, points[i].y - points[i - 1].y);
    legs.push(len);
    total += len;
  }
  let half = total / 2;
  for (let i = 1; i < points.length; i++) {
    const len = legs[i - 1];
    if (half <= len) {
      const t = len ? half / len : 0;
      return {
        x: points[i - 1].x + (points[i].x - points[i - 1].x) * t,
        y: points[i - 1].y + (points[i].y - points[i - 1].y) * t,
      };
    }
    half -= len;
  }
  return points[points.length - 1];
}

/**
 * Whether any leg of a path meets the visible rect.
 *
 * Leg by leg rather than by the path's bounding box, and the reason is the case
 * a board of connections is full of: the long line. Its bounding box is most of
 * the board, so a box test passes it from almost anywhere and it is emitted
 * into `d` on every frame of every pan having never come near the screen.
 */
function meetsRect(points, rect) {
  for (let i = 1; i < points.length; i++) {
    if (segmentMeetsRect(points[i - 1], points[i], rect)) return true;
  }
  return false;
}

/** Distance from point (px, py) to the segment a-b, in the layer's own space. */
function distToSeg(px, py, a, b) {
  const dx = b.x - a.x, dy = b.y - a.y;
  const len2 = dx * dx + dy * dy;
  const t = len2 ? Math.max(0, Math.min(1, ((px - a.x) * dx + (py - a.y) * dy) / len2)) : 0;
  const cx = a.x + t * dx, cy = a.y + t * dy;
  return Math.hypot(px - cx, py - cy);
}

/**
 * The connection whose drawn line runs nearest a world point, or null.
 *
 * The one concession to connections being clickable, kept as small as the note
 * in state.js/toggleConnection asked for: no selection model, no per-line
 * element to hit-test against - just the routed points build() already holds,
 * walked once against the point the right-click landed on. `tolPx` is a reach in
 * *screen* pixels, so a hairline stays as easy to hit zoomed out as zoomed in.
 *
 * World y points up and this layer lays y down (see centres()), so the point is
 * flipped before it is measured against the stored geometry.
 */
export function connectionAt(wx, wy, tolPx = 10) {
  if (!svg || !webVisible()) return null;
  const py = -wy;
  const tol = tolPx / (vp ? vp.zoom : 1);
  let best = null;
  let bestD = tol;
  for (const seg of lastSeg.values()) {
    if (!seg.ends) continue;
    const pts = seg.points;
    for (let i = 1; i < pts.length; i++) {
      const d = distToSeg(wx, py, pts[i - 1], pts[i]);
      if (d < bestD) { bestD = d; best = seg; }
    }
  }
  return best ? { a: best.ends.a, b: best.ends.b } : null;
}

/**
 * How round a corner is, off the whimsy axis.
 *
 * Square at Harsh, rounded at Softish, read from the attribute ui/appearance.js
 * writes on the root element - the same source the stylesheets take every other
 * tier decision from. A connector with a corner style of its own would be the
 * one element on the board with an opinion about how the interface looks.
 */
function cornerRadius() {
  const level = document.documentElement.dataset.whimsy;
  if (level === '2') return 0;      // Harsh: the board is a lattice, so are these
  if (level === '0') return 14;     // Softish
  return 9;                         // Middle, and the fallback before the dial is read
}
