// @ts-nocheck - TypeScript migration debt, not a judgement about this file.
//
// The tree was renamed from .js to .ts mechanically, which moved 104 modules in
// one step and annotated none of them. This module is carried unchecked so that
// npm run typecheck stays green and keeps meaning something, rather than going
// red and being ignored. Converting this module IS deleting this block and
// fixing what tsc then says - tests/ts-debt.test.js holds the count and lets it
// only fall.
// The web: the lines between cards, drawn behind everything.
//
// **These are drawn, not derived.** This file used to compute a maximal planar
// set of segments over the item centres on every change - a Euclidean minimum
// spanning tree for connectedness, then every other thread that fit, shortest
// first, kept only if it crossed nothing already accepted. It was a good effect
// and it was nobody's: the board decided what related to what, and there was no
// way to say otherwise. So the same picture is now a list of pairs somebody
// drew (`board.connections`), and the spanning tree survives as a generator
// that offers to draw a set of them for you - see web-graph.js and
// cmds.connectSelection. Its adaptive governor went at the same time: it sized
// a board to a frame, and there is no frame to size to once the thing runs on a
// button press instead of on every frame of a drag.
//
// The module kept its name, and the setting kept its key. `settings.web` is
// what an older build reads to decide whether to draw anything at all between
// cards, and renaming either would have cost the SHELL list, the layers test,
// three passages of research/docs/architecture.md and a silent change to every board
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

// baseStep is the board's own lattice, and it is here for one reason: at Harsh
// the cards are snapped to it (see axisMoved in ui/appearance.js), so a route
// that turns anywhere else is the axis half-applied. Read here and handed to
// the router, which may not read anything - see look().
import { board, bus, isRider, isJoinEnd, baseStep, selection, pairKey } from '../state.ts';
import { rafThrottle, readToken } from '../util.ts';
import { polyMidpoint, polyMeetsRect, distToSegment } from '../geometry.ts';
// Where a line runs when there are cards in the way - see web-route.js. Pure,
// and deliberately not in this file for the same reason web-graph.js is not:
// the algorithm is the half that can be tested without a browser.
import { routeConnection, pathData, blockOf, exitTowards, CLEARANCE } from '../web-route.ts';
// Which cards are near enough to be in the way. The index is kept current by
// canvas/items.js on every add, remove and move.
import { queryRect } from './spatial.ts';
// The card under the pointer, and the mark that says the draft is aimed at it.
// Both live in items.js because that module owns the card's DOM - a mark
// written from here would be undone by the next rebuild of that node.
import { itemIdFromEvent, setConnectAim, tiltOf, onHoverItem } from './items.ts';

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

// ---------------------------------------------------------------------------
// Why the web has no zoom floor
//
// It had one. The threads used to leave on the way out - full strength a band
// above the board's detail rung, thinning to nothing at the rung itself, gone
// below it - on the argument that the stroke is non-scaling, so a few hundred
// hairlines over a board the size of a postage stamp stop reading as
// connections and become a grey scribble across the one view whose purpose is
// to show the shape of the board.
//
// That argument was about the *derived* web, and it did not survive the
// connections becoming somebody's. Zoomed out is exactly where a drawn line is
// worth the most: the far view is the only one that shows the whole graph at
// once, and the moment it is worth reading is the moment it used to disappear.
// A line you drew and cannot see is a bug, which is the same sentence that
// turned settings.web on by default - so the same answer applies here, and the
// checkbox in View is still the way to say otherwise.
//
// What that costs is real and worth naming: the furthest-out view is the one
// with every thread inside the visible rect, so nothing is culled and the `d`
// string is at its longest exactly where it used to be skipped. It is one
// string swap on a view that is not moving, and paint() already returns without
// touching it while the screen stays inside the rect the last pass culled
// against - but a board of many hundreds of connections pays for that string on
// the frame it lands there.
// ---------------------------------------------------------------------------

let svg = null;
let path = null;         // every settled thread, as subpaths of one `d`
let fadeLayer = null;    // <g> holding only the threads currently fading
// The styled connections - the ones somebody gave a direction, a dash or a
// label - each drawn as its own element. Kept out of the bulk path on purpose:
// a dash and an arrowhead are per-line, where the bulk path is one shared
// stroke, and they are rare enough (a handful a board, against hundreds of plain
// lines) that a full rebuild of this layer on each paint costs nothing.
let decoLayer = null;
// The line under the pointer, brightened so a connection reads as a thing you
// can click. One highlight path, redrawn as the pointer moves over the board -
// see onHoverMove and hoverConnectionAt.
let hoverPath = null;
let hoveredKey = null;
// The line a press landed on, kept lit until something else is pressed. See the
// note over activeConnection() for why it is a key here rather than a member of
// the selection.
let activePath = null;
let activeKey = null;
// The threads of the selected cards, lifted out of everything else - see
// setFocus(). One more path and one class on the <svg>; nothing is stored.
let focusPath = null;
let focusIds = null;
/** The cards the pointer is resting on, which focus when nothing is selected. */
let hoverIds = null;
// The line in flight: the connector tool has one end and the pointer has the
// other. See setDraftFrom - it is the whole of the tool's feedback, and until
// it existed the only thing a picked card said was that it had been picked.
let draftPath = null;
let draftFrom = null;    // the picked item's id, or null when nothing is armed
let draftBox = null;     // that item's box in this layer's coordinates
let draftPoints = null;  // what is drawn: straight while moving, routed on the settle
let draftTimer = 0;
let viewportEl = null;
// The box origin paint() last drew against, so the hover highlight can be laid
// in the same coordinates between paints without recomputing the whole box.
let originX = 0, originY = 0;
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
  // Named so the focus rule can dim this path without dimming the highlights
  // drawn over it - `#web path` matches every one of them.
  path.setAttribute('class', 'web-bulk');
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

  // The hover, under the bulk lines beside the active mark: both are haloes
  // rather than overpaints, so the line under the pointer keeps its own dash and
  // colour while it is being pointed at. See the rules in canvas.css.
  hoverPath = document.createElementNS(SVG_NS, 'path');
  hoverPath.setAttribute('class', 'web-hover');
  hoverPath.setAttribute('fill', 'none');

  // The focused card's own threads, drawn over the dimmed bulk path at full
  // strength. Below the hover and the active mark, which are about the pointer
  // rather than about the board.
  focusPath = document.createElementNS(SVG_NS, 'path');
  focusPath.setAttribute('class', 'web-focus');
  focusPath.setAttribute('fill', 'none');

  // The active line, above the hover: the two are the same shape and the
  // difference between them is that one of them survives the pointer moving on.
  activePath = document.createElementNS(SVG_NS, 'path');
  activePath.setAttribute('class', 'web-active');
  activePath.setAttribute('fill', 'none');

  // The draft, above everything: it is the only line on the board that is not
  // there yet, and the one the eye is following.
  draftPath = document.createElementNS(SVG_NS, 'path');
  draftPath.setAttribute('class', 'web-draft');
  draftPath.setAttribute('fill', 'none');

  decoLayer = document.createElementNS(SVG_NS, 'g');
  // The active mark goes *under* everything, which is the one ordering decision
  // in this list that is not about layering but about legibility - see the rule
  // in canvas.css. Everything else stacks the way it is read: the bulk lines,
  // the focused copy of some of them, the hover, the fading ones, the styled
  // ones with their arrows and labels, and the draft over the lot.
  svg.append(defs, activePath, hoverPath, path, focusPath, fadeLayer, decoLayer, draftPath);

  // First child of #world, and it never claims a pointer - the web is a
  // backdrop for the items, not a thing you can catch hold of.
  worldEl.prepend(svg);

  vp = viewport || null;

  // Hover lives on #viewport rather than in the input pipeline: it is a read,
  // not a gesture, and keeping it here keeps the one-active-gesture rule in
  // input.js intact. Only over bare board (e.target is the viewport itself, not
  // a card) and only when no drag or pan is in flight, so it never fights the
  // cursor those set. See onHoverMove.
  viewportEl = typeof document !== 'undefined' ? document.getElementById('viewport') : null;
  if (viewportEl) {
    viewportEl.addEventListener('pointermove', onHoverMove);
    viewportEl.addEventListener('pointerleave', endHover);
  }
  frame = rafThrottle(tick);
  bus.on('items', requestBuild);
  bus.on('geom', requestBuild);
  bus.on('board:load', requestBuild);
  bus.on('layout', requestBuild);
  // A line drawn or removed. Its own event rather than 'items', which fires for
  // a drag, a delete and an undo as well - see the note beside it in state.js.
  bus.on('connections', requestBuild);
  // Which cards are selected decides which threads are lifted. A repaint, never
  // a rebuild: nothing about the geometry changes when the selection does.
  bus.on('selection', () => { focusIds = null; requestPaint(); });
  // And the pointer resting on a card, which says the same thing more quietly -
  // see focusSet(). Dropped outright while a gesture is running: a pan drags
  // every card on the board under the cursor, and each one arriving would
  // re-dim every line on screen.
  onHoverItem(ids => {
    const busy = !!viewportEl && (viewportEl.classList.contains('is-panning') ||
      viewportEl.classList.contains('is-moving'));
    const next = busy || !ids?.size ? null : new Set(ids);
    if (!next && !hoverIds) return;
    hoverIds = next;
    // Only when it can be seen. With something selected the hover has nothing
    // to say, and a repaint per card crossed would be the cost of saying it.
    if (!selection.size) requestPaint();
  });
  // Only the web toggle changes what is drawn; other settings (spacing, units)
  // fire the same event and must not drag a rebuild in with them. The whimsy
  // axis is the exception, and it arrives on this event as 'appearance' - see
  // reshape() for why it cannot be ignored and cannot be a rebuild either.
  bus.on('settings', key => {
    if (key === 'web') requestBuild();
    else if (key === 'appearance') reshape();
  });
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
  // Ghost cards are not ends either, and neither are stickers - see isJoinEnd()
  // in board-model.js, where the two reasons are. A rider is left out here
  // rather than there because being stuck is not a fact about the item.
  // How far a card may lean at this look, once for the whole pass - see
  // drawnTilt(), and the bug the lean is read for at all.
  const maxLean = drawnTilt();
  return board.items
    .filter(i => !isRider(i) && isJoinEnd(i))
    .map(i => {
      // The lean this card is actually drawn with, sign and all - not the
      // tier's maximum. The sign is the whole reason it is read per card: an
      // axis-aligned box does not care which way a card leans, and the point on
      // a card's *edge* that a line should stop at cares about nothing else.
      //
      // No negation on the lean, where item.rot gets one: rot is world
      // geometry, where y points up, and this layer lays y down. The lean is a
      // CSS rotation, which is already in the layer's own sense.
      const lean = i.type === 'fence' ? 0 : tiltOf(i.id) * maxLean;
      return {
        id: i.id, x: i.x, y: -i.y, w: i.w, h: i.h,
        rot: -(i.rot || 0) + lean,
      };
    });
}

/**
 * The most a card leans at this look, in degrees. Multiplied by each card's own
 * dealt fraction (items.js/tiltOf) to get the lean it is actually drawn with.
 *
 * The bug this exists for: hovering a card revealed the end of a line that had
 * been hidden underneath it. Cards away from the hard end of the axis rest
 * crooked - `--item-tilt` times `--tilt-max`, up to three degrees - and that
 * lean is presentational, so it is deliberately not in `item.rot` and this
 * module never knew about it. A route therefore ended on the *untilted* box,
 * which a tilted card's own corners stick out past, so the last units of the
 * line sat under the picture: invisible, since #web is below the items, until
 * the hover lift moved the card off it and left a stub floating in the gap.
 *
 * The answer is not to pad the box outward, which was the first attempt and
 * traded a stub that appeared on hover for a gap that was there all the time.
 * A card's drawn outline is exactly knowable, so the line stops exactly on it -
 * see exitTowards() in web-route.js, which clips against the leaning rectangle
 * rather than against the box around it.
 *
 * The tier is read rather than the token alone, because the token is not the
 * whole answer: Harsh zeroes `rotate` on `.item` in quality.css rather than
 * zeroing `--tilt-max`, and a snapped board does the same in items.css - both
 * would otherwise pay for a lean nothing is drawn with. The token itself is
 * cached and dropped by reshape(), which is exactly the event that can change
 * it.
 */
let leanDeg = null;
function drawnTilt() {
  if (leanDeg === null) {
    leanDeg = Math.abs(parseFloat(readToken('--tilt-max'))) || 0;
  }
  if (document.documentElement.dataset.whimsy === '2' || board.settings.snap) return 0;
  return leanDeg;
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
  draftPoints = null;
  clearTimeout(draftTimer);
  activeKey = null;
  focusIds = null;
  hoverIds = null;
  if (focusPath) focusPath.setAttribute('d', '');
  if (svg) svg.classList.remove('is-focused');
  if (activePath) activePath.setAttribute('d', '');
  if (draftPath) draftPath.setAttribute('d', '');
  if (path) path.setAttribute('d', '');
  if (decoLayer) while (decoLayer.firstChild) decoLayer.removeChild(decoLayer.firstChild);
}

/**
 * The look moved: every route is owed again, and no line has changed.
 *
 * A route is cached on `sigOf()` - the two end boxes - and a slider move does
 * not move a card, so every signature still matches and build() would hand back
 * the shape each line had at the *old* level. The whole board would re-skin
 * around a set of connectors that did not. Dropping the `routed` flag is the
 * narrow version of what resetWeb() does: it says the geometry is owed again
 * without saying the lines are.
 *
 * Not resetWeb(), and not a rebuild. resetWeb() releases the settled set and
 * the fading elements as well, so every line on the board would blink out and
 * back on a slider move - which is the loudest possible reading of a change to
 * how corners are drawn. The paint is asked for straight away because the
 * corner radius is read there and applies immediately; the shapes follow when
 * the pass lands, on the same settle a drop uses.
 */
function reshape() {
  leanDeg = null;
  for (const seg of lastSeg.values()) seg.routed = false;
  requestPaint();
  scheduleRoute();
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
  // The picked end can move under a draft that is already up - an undo, a
  // rearrange, a card arriving from a paste - and the draft is drawn from a
  // cached box because the pointer asks for it sixty times a second.
  if (draftFrom) draftBox = where.get(draftFrom) || null;

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
    const key = pairKey(a, b);
    // A stored route is kept exactly as long as both of its ends are where they
    // were. The moment either moves, the route is thrown away and the line
    // falls back to a straight one until the pass scheduled below runs - which
    // is the whole of "no routing while anything is moving".
    const sig = sigOf(pa, pb);
    const held = lastSeg.get(key);
    const seg = held && held.sig === sig
      ? held
      // Edge to edge, not centre to centre. The straight line a drag trails is
      // the one every card on the board is dragged over, and a line drawn from
      // a middle runs half a card deep under each end - invisible while the
      // card is flat, and revealed as a stub the moment the hover lift raises
      // it off the board. It also aims at the two middles, which is what the
      // routed line it is standing in for will do when the pass lands.
      : {
        a: pa, b: pb, sig,
        points: [exitTowards(pa, pb), exitTowards(pb, pa)],
      };
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

  // One read of the axis for the whole pass. Every route in it is being worked
  // out against the same look, and a slider moved half way through a pass would
  // otherwise leave a board carrying two shapes at once.
  const opts = look();
  let spent = 0;
  for (const [, seg] of order) {
    if (spent++ >= ROUTE_BUDGET) break;
    // seg.a and seg.b already carry the id and the box - centres() puts both on
    // every point - so there is nothing to look up here.
    const { a, b } = seg;
    const routed = routeConnection(a, b, obstaclesBetween(a, b, where, opts.clearance), opts);
    seg.points = routed.points;
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
function obstaclesBetween(a, b, where, clearance = CLEARANCE) {
  // Twice whatever room the route is keeping, not twice the constant: at
  // Softish the clearance is raised so a curve has somewhere to be drawn, and a
  // query still sized to the plain figure would hand the router a card list
  // that stopped just short of the cards it now has to go round.
  const pad = clearance * 2;
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
  // Nothing to draw. The only remaining reason to skip the whole `d` string
  // below - zoom is not one of them any more, see the note by the fade
  // constants that used to be here. A draft counts as something to draw: on a
  // board with no connections at all, it is the only line there is.
  if (!settled.size && !animating.size && !draftPoints) {
    svg.style.display = 'none';
    // Nothing was drawn, so nothing below is true of what is on screen.
    paintedRect = null;
    return;
  }
  svg.style.display = '';

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
  // And the draft, which is the one line here that regularly reaches outside
  // everything else: it runs to wherever the pointer is, and an <svg> clips at
  // its own edge.
  if (draftPoints) for (const p of draftPoints) stretch(p);
  // A board whose items all sit on one row has a zero-height box, and an SVG
  // with a zero extent renders nothing at all - so the box never closes fully.
  const w = Math.max(maxX - minX, 1);
  const h = Math.max(maxY - minY, 1);
  // The origin the hover highlight lays itself against, kept so a pointer move
  // between paints can redraw the highlight without re-deriving the box.
  originX = minX;
  originY = minY;

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
  const lit = focusSet();
  let d = '';
  let focusD = '';
  // Whether the selection lit *anything* on screen, styled lines included.
  // Counted separately from the string below, and that separation is the bug
  // this had: a styled line is drawn as its own element in decoLayer and never
  // enters `d`, so a card whose connections all carry a colour or an arrow lit
  // an empty string, which read as nothing to focus - and the board did not dim
  // at all for exactly the cards somebody had bothered to mark up.
  let litAny = false;
  for (const key of settled) {
    const seg = lastSeg.get(key);
    if (!seg) continue;
    if (vis && !polyMeetsRect(seg.points, vis)) continue;
    const isLit = !!(lit && seg.ends && (lit.has(seg.ends.a) || lit.has(seg.ends.b)));
    if (isLit) litAny = true;
    // Styled lines are drawn in decoLayer, never the bulk stroke - a dash or an
    // arrow is per-line and this path is one shared `d`. drawDecorations marks
    // the lit ones with .web-lit, which is how they stay at full strength.
    if (seg.meta) continue;
    const sub = pathData(seg.points, r, minX, minY);
    d += sub;
    // The same subpath twice, in the one case where that is cheaper than the
    // alternative: the focused threads are drawn again over the dimmed bulk
    // path rather than held out of it, which would mean two strings that have
    // to agree about which lines exist instead of one string and a copy.
    if (isLit) focusD += sub;
  }
  path.setAttribute('d', d);
  focusPath.setAttribute('d', focusD);
  // Only when something was actually lit. A selected card with no lines of its
  // own, or none on screen, would otherwise dim the whole board to say nothing.
  svg.classList.toggle('is-focused', litAny);

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

  drawDecorations(minX, minY, r, vis, lit);
  drawDraft(minX, minY, r);
  // The hovered and the active line may each have just moved, been rerouted, or
  // gone; realign or clear them against the box we just drew.
  if (hoveredKey && !lastSeg.has(hoveredKey)) hoveredKey = null;
  if (activeKey && !lastSeg.has(activeKey)) activeKey = null;
  drawHover();
  drawActive();
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
function drawDecorations(minX, minY, r, vis, lit) {
  while (decoLayer.firstChild) decoLayer.removeChild(decoLayer.firstChild);
  const segs = [];
  for (const key of settled) { const s = lastSeg.get(key); if (s?.meta) segs.push(s); }
  for (const [key, live] of animating) {
    if (!settled.has(key) && live.seg?.meta) segs.push(live.seg);
  }
  for (const seg of segs) {
    if (vis && !polyMeetsRect(seg.points, vis)) continue;
    const line = document.createElementNS(SVG_NS, 'path');
    // Colour and weight are class names, never values written into a style -
    // see connMeta() in board-model.js for why that distinction is the whole
    // safety of the feature. Both are validated to a closed list before they
    // are stored, so the worst a hostile file can do here is name a class that
    // no rule matches.
    const colour = seg.meta.color ? ` web-c-${seg.meta.color}` : '';
    const weight = seg.meta.weight ? ` web-w-${seg.meta.weight}` : '';
    // A styled line is its own element, so it is lifted by keeping its strength
    // rather than by being drawn twice - the dim rule in canvas.css is what
    // this class is read by.
    const focus = lit && seg.ends && (lit.has(seg.ends.a) || lit.has(seg.ends.b))
      ? ' web-lit' : '';
    line.setAttribute('class', 'web-styled' + colour + weight + focus);
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
function nearestSeg(wx, wy, tolPx) {
  if (!svg || !webVisible()) return null;
  const py = -wy;
  const tol = tolPx / (vp ? vp.zoom : 1);
  let best = null, bestKey = null, bestD = tol;
  for (const [key, seg] of lastSeg) {
    if (!seg.ends) continue;
    const pts = seg.points;
    for (let i = 1; i < pts.length; i++) {
      const d = distToSegment(wx, py, pts[i - 1], pts[i]);
      if (d < bestD) { bestD = d; best = seg; bestKey = key; }
    }
  }
  return best ? { key: bestKey, seg: best } : null;
}

export function connectionAt(wx, wy, tolPx = 10) {
  const hit = nearestSeg(wx, wy, tolPx);
  return hit ? { a: hit.seg.ends.a, b: hit.seg.ends.b } : null;
}

// ---------------------------------------------------------------------------
// The line the board is pointing at
//
// A connection could be edited exactly one way: right-click it. The editor
// behind that click is complete - direction, style, label, remove - and it was
// reachable by the button most people never press on the one element on the
// board with no other affordance at all. Meanwhile the line lit up under the
// pointer, which is a promise that pressing it does something.
//
// So a press on a line makes it *active*: it stays lit, Delete removes it, and
// a double click asks for its label. That is the whole feature.
//
// It is deliberately not part of the selection. `selection` in state.js is a
// set of item ids and every consumer of it assumes so - band-select, group
// drag, arrange, align, delete, the trash, the sidebar's count - so widening it
// to hold a second kind of thing would put an "is this an item" clause in all
// of them to make one line clickable. One key, held here beside the hover it is
// the deliberate half of, costs nothing anywhere else.
// ---------------------------------------------------------------------------

/** The connection currently pointed at, as its two ends, or null. */
export function activeConnection() {
  const seg = activeKey && lastSeg.get(activeKey);
  return seg?.ends ? { a: seg.ends.a, b: seg.ends.b } : null;
}

/** Point at a connection, or at none - both ends null puts the mark away. */
export function setActiveConnection(a, b) {
  const key = a && b ? pairKey(a, b) : null;
  if (key === activeKey) return;
  activeKey = key;
  drawActive();
}

export function clearActiveConnection() { setActiveConnection(null, null); }

/**
 * Where the marked line's middle is, in *world* coordinates, or null.
 *
 * For ui/conn-chip.js, which pins a small editor over the line. The midpoint by
 * arc length rather than the average of the two ends - polyMidpoint, the same
 * one a label sits at - so on a route that bends round three cards the chip is
 * on the line rather than beside it.
 *
 * This layer lays y down and the world points up (see centres()), so the
 * answer is flipped back on the way out: everything above the canvas thinks in
 * world coordinates and this is the only place that has to know.
 */
export function activeConnectionAnchor() {
  const seg = activeKey && lastSeg.get(activeKey);
  if (!seg?.points?.length) return null;
  const mid = polyMidpoint(seg.points);
  return { x: mid.x, y: -mid.y };
}

/**
 * Be told when the marked line has been redrawn, so something pinned to it can
 * follow.
 *
 * One subscriber, deliberately - this is a callback and not a bus event because
 * it fires on paints, and an event on the board's bus is a thing every module
 * can hear and one of them will eventually answer with a rebuild. The chip is
 * the only thing that has any business following a line.
 */
let activeMoved = null;
export function onActiveConnectionMove(fn) { activeMoved = fn; }

/**
 * The cards whose threads are lifted, or null for "no focus at all".
 *
 * A board with a few hundred lines on it draws them all at the same weight, and
 * the far view - the one whose whole purpose is to show the shape of the board,
 * and the reason the web has no zoom floor any more - is exactly where that is
 * least readable. Selecting a card lifts its own threads and drops everything
 * else back, so one card's relationships can be read out of the tangle.
 *
 * Two triggers, and the order between them is the whole of the rule: a
 * selection wins, and the pointer only speaks when there is no selection to
 * drown out.
 *
 * Selection is the deliberate one - quiet, survives the pointer moving away,
 * composes with everything else the selection already does, and is the state
 * somebody is in when they are actually asking what a card is connected to.
 * Hover is the one nobody has to be taught, and it is why it is second rather
 * than absent: pointing at a card is what a person does when they want to know
 * about that card, and answering only a click made the feature something you
 * had to already know was there.
 *
 * What hover costs is real, which is why it is fenced twice. It is ignored
 * outright while a gesture runs - a pan drags the whole board under the cursor,
 * and every card arriving would re-dim every line on screen - and it is ignored
 * whenever anything is selected, so it can never argue with a lift somebody
 * asked for. The opacity transition in canvas.css does the rest: a pointer
 * crossing three cards on its way somewhere reads as the board breathing rather
 * than flashing.
 *
 * Nothing is stored either way, and the selected set is derived rather than
 * kept beside the selection - a second copy is a second thing to keep true. The
 * memo is dropped whenever the selection changes and rebuilt on the next paint,
 * which is once per change rather than once per frame of a pan.
 */
function focusSet() {
  if (selection.size) {
    if (!focusIds) focusIds = new Set(selection);
    return focusIds;
  }
  return hoverIds;
}

/** Redraw the mark over the active line, or clear it. */
function drawActive() {
  if (!activePath) return;
  const seg = activeKey && lastSeg.get(activeKey);
  activePath.setAttribute('d', seg ? pathData(seg.points, cornerRadius(), originX, originY) : '');
  // After the draw, not before: whatever follows this line is placed against
  // where it has just been put, and the mark going away is as much a move as
  // the mark moving.
  activeMoved?.();
}

/** Redraw the hover highlight over the currently hovered line, or clear it. */
function drawHover() {
  if (!hoverPath) return;
  const seg = hoveredKey && lastSeg.get(hoveredKey);
  hoverPath.setAttribute('d', seg ? pathData(seg.points, cornerRadius(), originX, originY) : '');
}

/**
 * Point the hover at whatever line is under a world point, and say whether one
 * is. Repaints the highlight only when the hovered line actually changes, so a
 * pointer sliding along one line is not a stream of identical redraws.
 */
export function hoverConnectionAt(wx, wy, tolPx = 12) {
  const hit = nearestSeg(wx, wy, tolPx);
  const key = hit ? hit.key : null;
  if (key !== hoveredKey) { hoveredKey = key; drawHover(); }
  return !!key;
}

// ---------------------------------------------------------------------------
// The line in flight
//
// The connector tool used to draw nothing at all. Arming it and pressing a card
// put a ring round that card, and from there until the second press the board
// said no more than "this one is picked" - not where the line would run, not
// which card the pointer was over, not what the thing being made would look
// like. The one gesture in the app that makes a *drawing* was the one gesture
// with no drawing in it.
//
// So: one more path in the SVG this module already owns, from the picked card
// to wherever the pointer is. It costs nothing structurally - same layer, same
// transform, same non-scaling stroke - and it follows the same rule everything
// else here follows about when it is allowed to be routed. Straight while the
// pointer is moving, worked out properly once it stops. A draft is a drag by
// another name, and the reason routing waits for a drag to end is the reason it
// waits here.
//
// ui/toolbar.js owns the pick and calls setDraftFrom; this module owns the
// pointer, because it already listens for one (see onHoverMove) and because
// canvas/input.js holds exactly one active gesture and a draft is not one.
// ---------------------------------------------------------------------------

/**
 * Aim the draft at a card, or put it away.
 *
 * Called by ui/toolbar.js whenever the pick changes - including the null that
 * arrives when the tool is disarmed, a pair is completed, or Escape is pressed,
 * which is what makes those three put the line away without knowing they have.
 */
export function setDraftFrom(id) {
  draftFrom = id || null;
  draftBox = draftFrom ? boxOf(draftFrom) : null;
  draftPoints = null;
  clearTimeout(draftTimer);
  setConnectAim(null);
  if (!draftFrom) requestPaint();
}

/** One item's box in this layer's coordinates - centres() for a single id. */
function boxOf(id) {
  const it = board.items.find(i => i.id === id);
  if (!it || isRider(it) || !isJoinEnd(it)) return null;
  return { id: it.id, x: it.x, y: -it.y, w: it.w, h: it.h, rot: -(it.rot || 0) };
}

/**
 * Follow the pointer with the draft line.
 *
 * The far end is the card under the pointer when there is one and the pointer
 * itself when there is not, so the draft is the line that would actually be
 * drawn rather than an arrow at a cursor - and the card it would join is marked
 * while it is under there, because a line arriving at a card and a line passing
 * over one look the same until it lands.
 */
function aimDraft(e) {
  if (!draftFrom || !vp || !webVisible()) return;
  if (!draftBox) draftBox = boxOf(draftFrom);
  if (!draftBox) return;
  const w = vp.toWorld(e.clientX, e.clientY);
  const overId = itemIdFromEvent(e.target);
  // Not the card it started from: pressing that is how somebody changes their
  // mind, and marking it as a target would say the opposite.
  const aim = overId && overId !== draftFrom ? overId : null;
  setConnectAim(aim);
  const to = (aim && boxOf(aim)) || { id: '', x: w.x, y: -w.y, w: 1, h: 1, rot: 0 };
  // From the edge of the picked card towards wherever the far end is, and to
  // the far card's edge when there is one - the same clip the drawn lines take,
  // so the draft is the line that would be drawn rather than an approximation
  // of it that jumps when it lands.
  draftPoints = [exitTowards(draftBox, to), aim ? exitTowards(to, draftBox) : { x: to.x, y: to.y }];
  requestPaint();
  // Routed on the settle, exactly as a dropped card is. The straight line in
  // the meantime is not a placeholder for the route - it is what a line looks
  // like while it is still being aimed.
  clearTimeout(draftTimer);
  draftTimer = setTimeout(() => {
    if (!draftFrom || !draftBox) return;
    const where = new Map(centres().map(p => [p.id, p]));
    const opts = look();
    draftPoints = routeConnection(
      draftBox, to, obstaclesBetween(draftBox, to, where, opts.clearance), opts).points;
    requestPaint();
  }, ROUTE_SETTLE_MS);
}

/** Draw the draft where paint() has just laid the box out, or clear it. */
function drawDraft(minX, minY, r) {
  if (!draftPath) return;
  draftPath.setAttribute('d', draftPoints ? pathData(draftPoints, r, minX, minY) : '');
}

/** Drop any hover highlight - the pointer left the board, or a gesture began. */
export function clearHover() {
  if (hoveredKey !== null) { hoveredKey = null; drawHover(); }
}

function endHover() {
  clearHover();
  if (viewportEl) viewportEl.classList.remove('over-connection');
}

/**
 * Track the line under the pointer as it moves over bare board.
 *
 * Gated hard: only when the pointer is on the viewport itself rather than a card
 * (a line passing behind a card is not what the pointer is on), and only when no
 * pan or drag is running, so the pointer, the cursor and the highlight never
 * fight what a gesture is already doing.
 */
function onHoverMove(e) {
  // The connector has an end picked: the pointer is drawing, not reading. The
  // draft takes the move whether it is over bare board or over a card, which is
  // the one case the gate below deliberately refuses.
  if (draftFrom) { aimDraft(e); return; }
  const root = document.documentElement;
  const busy = viewportEl.classList.contains('is-panning') ||
    viewportEl.classList.contains('is-moving') || root.classList.contains('is-sizing-paper');
  if (busy || e.target !== viewportEl || !webVisible() || !vp) { endHover(); return; }
  const w = vp.toWorld(e.clientX, e.clientY);
  const on = hoverConnectionAt(w.x, w.y);
  viewportEl.classList.toggle('over-connection', on);
}

/**
 * How far a Softish route stands off the cards it passes, over and above the
 * clearance every route keeps.
 *
 * It is the corner radius, and it is the same number twice on purpose. A fillet
 * cuts *inside* the corner it rounds; a corner in a route is precisely where
 * the path is hugging a card at the clearance, because that is what put the
 * corner there. Smooth a path routed at plain clearance and the curve is drawn
 * through the card. So the room the curve is about to take is bought before the
 * search rather than out of the card afterwards, and the two figures have to
 * match or one of them is guesswork.
 */
const SOFT_RADIUS = 22;

/**
 * What the whimsy axis asks of a connection: its shape, the room it needs, and
 * how round its corners are - one read of the attribute ui/appearance.js writes
 * on the root element, which is the source the stylesheets take every other
 * tier decision from.
 *
 * A connector with a look of its own would be the one element on the board with
 * an opinion about how the interface looks. This used to say that about the
 * corner alone, which was the smallest possible reading of it: Harsh squares
 * every edge on the board and snaps the cards to the lattice, Softish rounds
 * and softens everything it touches, and the connectors ran between them as the
 * same right-angled staircase at three radii. The *shape* is the tier decision;
 * the corner is a detail of it.
 *
 *   Harsh    orthogonal, turning on the board's own grid, square corners
 *   Middle   taut - straight where it can be, and no obligation to 90 degrees
 *   Softish  the same taut path, given room to curve round what it passes
 *
 * The router is pure and reads none of this; see its header. This is the half
 * that may read the DOM and the board, which is why the translation is here.
 */
function look() {
  const level = document.documentElement.dataset.whimsy;
  if (level === '2') {
    return { shape: 'grid', step: baseStep(), clearance: CLEARANCE, radius: 0 };
  }
  if (level === '0') {
    return { shape: 'taut', clearance: CLEARANCE + SOFT_RADIUS, radius: SOFT_RADIUS };
  }
  // Middle, and the fallback before the dial has been read.
  return { shape: 'taut', clearance: CLEARANCE, radius: 9 };
}

/** How round a corner is - the half of look() that paint() and the hover want. */
function cornerRadius() {
  return look().radius;
}
