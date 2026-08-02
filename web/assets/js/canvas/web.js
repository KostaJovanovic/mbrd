// The web: threads from item to item, drawn behind everything.
//
// One rule - no two threads may cross - and otherwise as many of them as will
// fit. That is a maximal planar set of straight segments over the item
// centres, and it is built in two passes for two different reasons.
//
// The first pass is a Euclidean minimum spanning tree, and it is here to
// guarantee the web is one connected piece rather than islands. Its edges are
// provably non-crossing, and the proof is short enough to keep: if AB and CD
// crossed at a point P then |AB| + |CD| = (|AP|+|PB|) + (|CP|+|PD|), and
// regrouping those four pieces by the triangle inequality gives
// |AC| + |BD| <= that sum, equal only if all four points are collinear. So
// re-pairing is never worse, and a *minimum* tree cannot contain a crossing.
//
// The second pass then adds every other thread that fits, shortest first,
// keeping one only if it crosses nothing accepted so far. Shortest-first is
// what makes the result look like a web rather than a mess: a short thread
// gets to claim its space before a long one can cut across the same gap, so
// the board fills up with small local triangles instead of a few long
// diagonals stretched over everything.
//
// Drawn inside #world, so pan and zoom come for free from the layer transform.
// The stroke is marked non-scaling so a thread stays a thread at 8x instead of
// becoming a beam.
//
// Two jobs, and they are deliberately separated: `build` decides which threads
// exist, `paint` decides which of them go into the `d` string. Only build reads
// the board, and only paint reads the viewport, so panning across a board never
// recomputes a spanning tree and moving an item never waits on one.

import { board, bus, isRider } from '../state.js';
import { rafThrottle } from '../util.js';
import { quality } from '../quality.js';
import { webZoom } from './viewport.js';
import { segmentMeetsRect } from '../geometry.js';
// The graph and its governor - see web-graph.js. Pure, and deliberately not
// in this file: the algorithm is the part that can be tested without a browser.
import { threads } from '../web-graph.js';

const SVG_NS = 'http://www.w3.org/2000/svg';

/**
 * A relationship web belongs to the spatial Desktop arrangement only, and only
 * when the board asks for one. `settings.web` is layout-local (Desktop's own
 * checkbox) and defaults to off, so a board only has threads because somebody
 * asked for them; the `!== false` here is for settings that never reached
 * normalizeSettings(), which is the one path that can leave the key missing.
 *
 * The quality dial can also take it away, and that is a different kind of no
 * from the checkbox's: the checkbox says this board does not want threads, the
 * dial says this device cannot afford to work them out. Both are honoured here,
 * because everything downstream - the spanning tree, the crossing test, the
 * per-view repaint - hangs off this one answer.
 */
export const webVisible = (mode = board.layoutMode) =>
  mode !== 'mobile' && board.settings.web !== false && quality.threads;

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
 * own <line> would undo the reason this was one path to begin with - the web is
 * rebuilt on every drag frame, and a few hundred elements to reconcile is a
 * different order of cost from one `d` string. So threads only get an element
 * while they are actually fading, and are handed back to the bulk path the
 * moment they land. In the steady state, including the whole of a drag that
 * does not change which threads exist, this draws exactly what it drew before:
 * one path, one attribute write.
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
let fadeLayer = null;    // <g> holding only the threads currently fading
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
/** Last known endpoints per key, so a thread whose item has gone can still fade
 *  out from where it was rather than vanishing the instant it loses a centre. */
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
/** The eye moved, which on its own may well leave the drawing untouched. */
const viewMoved = () => frame();

function tick() {
  if (wantBuild) { wantBuild = false; build(); }
  const forced = wantPaint;
  wantPaint = false;
  paint(forced);
}

export function initWeb(worldEl, viewport) {
  svg = document.createElementNS(SVG_NS, 'svg');
  svg.id = 'web';
  svg.setAttribute('aria-hidden', 'true');

  path = document.createElementNS(SVG_NS, 'path');
  path.setAttribute('fill', 'none');
  fadeLayer = document.createElementNS(SVG_NS, 'g');
  svg.append(path, fadeLayer);

  // First child of #world, and it never claims a pointer - the web is a
  // backdrop for the items, not a thing you can catch hold of.
  worldEl.prepend(svg);

  vp = viewport || null;
  frame = rafThrottle(tick);
  bus.on('items', requestBuild);
  bus.on('geom', requestBuild);
  bus.on('board:load', requestBuild);
  bus.on('layout', requestBuild);
  // Only the web toggle changes the geometry; other settings (spacing, units)
  // fire the same event and must not drag a spanning tree in with them.
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
  const el = document.createElementNS(SVG_NS, 'line');
  el.setAttribute('class', 'thread');
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
  // A stuck note is part of the thing it is pinned to, not a node of its own: it
  // sits on top of its host, so a thread run out to it would double back on the
  // host's own and read as a tether on the sticky. Riders are left out; the host
  // carries the web for the pair.
  // Size and rotation ride along so the second pass can treat each card as an
  // obstacle, not just its centre a node. World y points up and this layer lays
  // y down, so a card turned by `rot` in the world is turned by `-rot` here -
  // the reflection that takes (x, y) to (x, -y) flips the sense of the angle.
  // Ghost cards are not nodes. The web is a picture of how the things on a
  // board relate to each other, and a hint relates to nothing - it is talking
  // to the person, not to the board. Threading them would also draw a web on
  // an empty board and then tear it down at the first import.
  return board.items
    .filter(i => !isRider(i) && i.type !== 'ghost')
    .map(i => ({ id: i.id, x: i.x, y: -i.y, w: i.w, h: i.h, rot: -(i.rot || 0) }));
}

/**
 * Which threads exist. Runs only when an item has moved, arrived or gone.
 */
function build() {
  if (!svg) return;
  // Mobile is a reading-order feed, not a spatial map. Do not merely hide its
  // web: release the settled/fading geometry so a large board spends no time
  // rebuilding connections that this layout never shows.
  if (!webVisible()) {
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
    path.setAttribute('d', '');
    svg.style.display = 'none';
    return;
  }
  const pts = centres();
  // The box these points describe, worked out here rather than in paint().
  //
  // It is a property of where the items are, and the items do not move when the
  // view does - so re-deriving it from every centre on the board was a loop
  // over the whole board on every frame of every pan, to arrive at the number
  // it arrived at last frame. Panning is the case that matters: build() runs
  // when something is dragged, added or deleted, and paint() runs whenever the
  // eye moves.
  settledBox = { minX: Infinity, minY: Infinity, maxX: -Infinity, maxY: -Infinity };
  for (const p of pts) {
    if (p.x < settledBox.minX) settledBox.minX = p.x;
    if (p.y < settledBox.minY) settledBox.minY = p.y;
    if (p.x > settledBox.maxX) settledBox.maxX = p.x;
    if (p.y > settledBox.maxY) settledBox.maxY = p.y;
  }
  // One item has nothing to connect to, and zero items have nothing at all -
  // but the threads that were there a moment ago still have a fade to finish,
  // so this is an empty edge set rather than an early return.
  const edges = pts.length < 2 ? [] : threads(pts);

  const wanted = new Map();
  for (const [a, b] of edges) {
    wanted.set(keyOf(pts[a].id, pts[b].id), { a: pts[a], b: pts[b] });
  }

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
      if (onScreen(seg)) begin(key, seg, 'in');
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
  for (const entry of animating.values()) { stretch(entry.seg.a); stretch(entry.seg.b); }
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

  // One path of many subpaths rather than one element per thread: swapping a
  // single `d` attribute beats reconciling a few hundred nodes. Only the
  // settled threads are here; the fading ones are drawn as their own <line>
  // just below, and drawing a thread in both places at once would leave a
  // fading one with a solid twin under it.
  let d = '';
  for (const key of settled) {
    const seg = lastSeg.get(key);
    if (!seg) continue;
    if (vis && !segmentMeetsRect(seg.a, seg.b, vis)) continue;
    d += `M${(seg.a.x - minX).toFixed(2)} ${(seg.a.y - minY).toFixed(2)}` +
         `L${(seg.b.x - minX).toFixed(2)} ${(seg.b.y - minY).toFixed(2)}`;
  }
  path.setAttribute('d', d);

  // The box's origin moves whenever the outermost item does, so every fading
  // thread is repositioned each frame as well - they are relative to a corner
  // that is itself in motion. There are only ever a handful, so they are not
  // worth culling.
  for (const { el, seg } of animating.values()) {
    el.setAttribute('x1', (seg.a.x - minX).toFixed(2));
    el.setAttribute('y1', (seg.a.y - minY).toFixed(2));
    el.setAttribute('x2', (seg.b.x - minX).toFixed(2));
    el.setAttribute('y2', (seg.b.y - minY).toFixed(2));
  }
}
