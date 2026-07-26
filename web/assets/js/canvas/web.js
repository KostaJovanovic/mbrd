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

import { board, bus } from '../state.js';
import { rafThrottle } from '../util.js';
import { webZoom } from './viewport.js';
import { segmentMeetsRect } from '../geometry.js';

const SVG_NS = 'http://www.w3.org/2000/svg';

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

/** The last built geometry, reused by every paint until an item moves. */
let builtPts = [];
/** The box `builtPts` describes, kept by build() so paint() need not re-derive it. */
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
  return board.items.map(i => ({ id: i.id, x: i.x, y: -i.y }));
}

/**
 * Which threads exist. Runs only when an item has moved, arrived or gone.
 */
function build() {
  if (!svg) return;
  const pts = builtPts = centres();
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

/**
 * Every thread that fits: the spanning tree, then everything else that can be
 * added without crossing anything already there, shortest first.
 *
 * Candidates are limited to each point's nearest neighbours rather than all
 * n(n-1)/2 pairs. A long thread almost never survives the crossing test on a
 * board dense enough for the limit to matter - by the time it is considered,
 * the ground between its ends is already covered by shorter ones - so this
 * costs a handful of edges around the outside and turns a cubic pass into a
 * quadratic one. The whole web is rebuilt on every drag frame; it has to stay
 * inside a frame's budget on a board with hundreds of things on it.
 */
const NEIGHBOURS = 14;

/**
 * Past so many items the second pass is skipped and the tree alone is drawn -
 * and how many that is, this machine decides for itself.
 *
 * It used to be a flat 700, which is a number picked on one computer. The same
 * board on a phone or an old laptop is the same 700 and several times the work,
 * so the constant was really "700 on hardware like the author's". The whole of
 * the quality-modes question in the roadmap came down to this one lever, and
 * making it measure rather than assume is what closes that item: there is no
 * setting to find, nothing to explain, and a slow machine simply draws a
 * slightly sparser web instead of dropping frames.
 *
 * **The timing has to come from the spanning tree, not from the whole call**,
 * and that is the one thing here worth reading twice. The obvious version -
 * time the whole of `threads()` and solve for n - measures nothing at all the
 * moment it does any work: once the limit drops below the board size the second
 * pass is skipped, so no further sample is ever taken and the limit is frozen
 * wherever it happened to land. A single slow warm-up frame then thins the web
 * for the rest of the session. That version was written, measured, and threw
 * the limit to 119 on a board it rebuilds in 1.65ms.
 *
 * The tree runs on every single rebuild, so timing *it* gives a fresh reading
 * forever, on every board, whether or not the second pass ran.
 *
 * The two passes are then fitted separately, and that is the second thing this
 * got wrong on the way here. Treating the second pass as a fixed multiple of
 * the tree's cost looks reasonable and is not: the tree is O(n^2) and the pass,
 * since it got its grid, is about O(n), so the ratio between them falls as the
 * board grows. Measured at a small board it says the pass is twenty times the
 * tree, and the limit lands at 328 - which would have made a 400-item board
 * that rebuilds comfortably in 5ms drop to a bare tree.
 *
 * So: `a` is ms per n^2 for the tree, `b` is ms per n for the pass, both
 * scale-invariant properties of the machine, and the limit is the n that solves
 * a*n^2 + b*n = budget.
 *
 * Solving for n directly rather than nudging the limit up and down is what
 * keeps this from oscillating - a servo would lower the limit, skip the second
 * pass, measure a fast frame, raise it again, and the web would visibly change
 * shape every few frames while you dragged.
 *
 * It only ever goes *below* the ceiling, and the first thing it found is that
 * the old constant was too high even here: on the machine this was written on
 * it settles around 450, because a 400-point board already spends 7.6ms of an
 * 8ms budget and 700 spends over eight on its own - with items.js still to run
 * in the same frame. So this is not only a concession to slow hardware. The
 * flat 700 was optimistic on the computer that chose it.
 */
const DENSE_CEILING = 700;
/** Below this the web stops being a web, so a slow machine still gets one. */
const DENSE_FLOOR = 60;
/** Half a 60fps frame. The rest of it belongs to items.js and the browser. */
const FRAME_BUDGET_MS = 8;
/**
 * Rebuilds ignored before any of this starts.
 *
 * The first few calls are the JIT's, not the machine's, and they can be an
 * order of magnitude slow. Reacting to them would thin the web at exactly the
 * moment a board is being opened.
 */
const WARMUP = 4;

let denseLimit = DENSE_CEILING;
/**
 * `a` and `b`, both seeded from a real measurement rather than from zero.
 *
 * On the machine this was written on, a 700-point board spends about 2.2ms in
 * the tree and 6.1ms in the second pass, which is where these two numbers come
 * from. Starting at a real board's figures means the first rebuild of a session
 * is budgeted roughly right instead of being handed the whole ceiling and then
 * jerked back off it.
 */
let treeCost = 4.5e-6;   // ms per n^2
let passCost = 0.009;    // ms per n
let warmup = WARMUP;

/** What the limit currently is. Exported for tests; nothing in the app reads it. */
export const denseLimitNow = () => denseLimit;

export function threads(pts) {
  const n = pts.length;
  const t0 = performance.now();
  const edges = spanningTree(pts);
  const tTree = performance.now() - t0;
  learnTree(n, tTree);
  if (n > denseLimit) return edges;

  const taken = new Set(edges.map(([a, b]) => pair(a, b, n)));
  const k = Math.min(NEIGHBOURS, n - 1);
  const candidates = [];
  const seen = new Set();

  // The k nearest, kept by insertion into a fixed pair of buffers rather than
  // by sorting all n-1 distances and reading the front off.
  //
  // The sort was not the expensive part. The array it sorted was: one array of
  // n two-element arrays per point, so a 500-item board minted a quarter of a
  // million short-lived arrays on every drag frame and handed the whole lot to
  // the collector. These two buffers are allocated once for the whole pass.
  const bestD = new Float64Array(k);
  const bestJ = new Int32Array(k);
  for (let i = 0; i < n; i++) {
    const p = pts[i];
    let filled = 0;
    for (let j = 0; j < n; j++) {
      if (j === i) continue;
      const q = pts[j];
      const dx = p.x - q.x, dy = p.y - q.y;
      const d = dx * dx + dy * dy;
      // Already holding k closer ones: nothing to do, and this is the branch
      // taken for almost every pair on a board of any size.
      if (filled === k && d >= bestD[k - 1]) continue;
      let m = filled < k ? filled++ : k - 1;
      while (m > 0 && bestD[m - 1] > d) {
        bestD[m] = bestD[m - 1]; bestJ[m] = bestJ[m - 1]; m--;
      }
      bestD[m] = d; bestJ[m] = j;
    }
    for (let m = 0; m < filled; m++) {
      const j = bestJ[m];
      const id = pair(i, j, n);
      if (taken.has(id) || seen.has(id)) continue;
      seen.add(id);
      candidates.push([bestD[m], Math.min(i, j), Math.max(i, j)]);
    }
  }
  candidates.sort((x, y) => x[0] - y[0]);

  // Accepted threads go into a grid as they are accepted, so a candidate only
  // has to be tested against the ones whose boxes could touch its own. Without
  // it every candidate walks the whole accepted set, which is the quadratic
  // that made a drag on a large board stutter.
  const grid = new EdgeGrid(pts);
  for (const [a, b] of edges) grid.add(a, b);

  for (const [, a, b] of candidates) {
    if (grid.blocks(pts[a], pts[b])) continue;
    edges.push([a, b]);
    grid.add(a, b);
    taken.add(pair(a, b, n));
  }

  learnPass(n, performance.now() - t0 - tTree);
  return edges;
}

/**
 * The tree's timing. Taken on every rebuild, which is the whole point.
 *
 * Smoothed hard, because a single frame is mostly noise - a collection pause or
 * a tab regaining focus lands here as a board twice as expensive as it is, and
 * reacting to that would visibly thin the web for no reason.
 */
function learnTree(n, ms) {
  // Too few points to time anything but the clock's own resolution.
  if (n < 24 || !(ms > 0)) return;
  if (warmup > 0) { warmup--; return; }
  treeCost = treeCost * 0.85 + (ms / (n * n)) * 0.15;
  settle();
}

/** The same for the second pass, on its own scale: ms per point. */
function learnPass(n, ms) {
  if (n < 24 || !(ms > 0) || warmup > 0) return;
  passCost = passCost * 0.85 + (ms / n) * 0.15;
  settle();
}

/**
 * The largest n whose whole rebuild fits the budget: solve a*n^2 + b*n = budget
 * for n, which is the quadratic formula and nothing cleverer.
 *
 * Pure, and exported, because the property that matters here cannot be tested
 * any other way. What this code has to get right is that the limit *converges*
 * - a version that chases its own tail would drop, skip the second pass,
 * measure a fast frame, climb, and change the web's shape every few frames
 * while you dragged. Asserting that by running the real thing forty times and
 * checking the answer stopped moving is asserting that the machine was quiet
 * for the duration, which on a laptop compiling something else it is not: that
 * test failed about one run in three, and every failure was the room and not
 * the code. Split in two - the solve here, the deadband below - both halves are
 * ordinary functions of their arguments and the convergence is provable rather
 * than observed.
 */
export function denseLimitFor(tree, pass) {
  if (!(tree > 0)) return null;
  const root = Math.sqrt(pass * pass + 4 * tree * FRAME_BUDGET_MS);
  return clampi(Math.round((root - pass) / (2 * tree)), DENSE_FLOOR, DENSE_CEILING);
}

/**
 * Where the limit goes next, given where it is and where the maths points.
 *
 * Moved only when the answer differs by a sixth, so the limit sits still
 * instead of trembling around a boundary and taking the web's shape with it.
 * That deadband is also what makes convergence a fact rather than a hope: a
 * steady `want` moves the limit at most once and then never again, because
 * after the move the difference is zero.
 *
 * A non-finite `want` holds. It arrives when a cost estimate has gone to NaN,
 * which is a measurement that failed, not a board that got faster.
 */
export function nextDenseLimit(current, want) {
  if (!Number.isFinite(want)) return current;
  return Math.abs(want - current) > current / 6 ? want : current;
}

function settle() {
  denseLimit = nextDenseLimit(denseLimit, denseLimitFor(treeCost, passCost));
}

const pair = (a, b, n) => (a < b ? a * n + b : b * n + a);

/**
 * Accepted threads, bucketed by the cells their bounding box covers.
 *
 * Conservative by construction: a thread is registered in *every* cell its box
 * touches, so any candidate whose box overlaps it shares at least one of them
 * and the pair is always tested. Missing a pair here would put a visible
 * crossing in the web, so there is no clever early exit anywhere in this class.
 *
 * The escape hatch is `wide`. A spanning tree on a sparse board can hold one
 * very long edge reaching across the whole thing, and listing that in every
 * cell it passes over would cost more than testing it against everything. Past
 * a cap it goes in a list that every candidate checks.
 */
const MAX_CELLS_PER_EDGE = 32;

class EdgeGrid {
  constructor(pts) {
    this.pts = pts;
    // Edges live here as two flat arrays; the buckets hold indices into them.
    // An index is what makes the visited stamp below cheap - marking the edge
    // itself would mean hanging a property on an array and dropping it out of
    // the fast representation.
    this.ea = [];
    this.eb = [];
    this.marks = [];
    this.cells = new Map();
    this.wide = [];

    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (const p of pts) {
      if (p.x < minX) minX = p.x;
      if (p.y < minY) minY = p.y;
      if (p.x > maxX) maxX = p.x;
      if (p.y > maxY) maxY = p.y;
    }
    this.minX = minX;
    this.minY = minY;

    // One cell per point, near enough, which puts a handful of threads in each.
    // Finer wastes time registering; coarser puts everything back in one bucket.
    const side = Math.max(1, Math.round(Math.sqrt(pts.length)));
    this.gw = side;
    this.gh = side;
    this.cw = Math.max((maxX - minX) / side, 1e-6);
    this.ch = Math.max((maxY - minY) / side, 1e-6);
  }

  _col(x) { return clampi(Math.floor((x - this.minX) / this.cw), 0, this.gw - 1); }
  _row(y) { return clampi(Math.floor((y - this.minY) / this.ch), 0, this.gh - 1); }

  add(ai, bi) {
    const i = this.ea.length;
    this.ea.push(ai);
    this.eb.push(bi);
    this.marks.push(0);
    const a = this.pts[ai], b = this.pts[bi];
    const c0 = this._col(Math.min(a.x, b.x)), c1 = this._col(Math.max(a.x, b.x));
    const r0 = this._row(Math.min(a.y, b.y)), r1 = this._row(Math.max(a.y, b.y));
    if ((c1 - c0 + 1) * (r1 - r0 + 1) > MAX_CELLS_PER_EDGE) { this.wide.push(i); return; }
    for (let c = c0; c <= c1; c++) {
      for (let r = r0; r <= r1; r++) {
        const key = c * this.gh + r;
        const bucket = this.cells.get(key);
        if (bucket) bucket.push(i); else this.cells.set(key, [i]);
      }
    }
  }

  /** Does any accepted thread cross AB? */
  blocks(a, b) {
    const { pts, ea, eb, marks } = this;
    for (const i of this.wide) {
      if (crosses(a, b, pts[ea[i]], pts[eb[i]])) return true;
    }
    const c0 = this._col(Math.min(a.x, b.x)), c1 = this._col(Math.max(a.x, b.x));
    const r0 = this._row(Math.min(a.y, b.y)), r1 = this._row(Math.max(a.y, b.y));
    // A thread listed in two of the candidate's cells would otherwise be tested
    // twice. Harmless, but `crosses` is the hot call in this file, so the
    // repeat is skipped with a stamp rather than a Set.
    const stamp = ++mark;
    for (let c = c0; c <= c1; c++) {
      for (let r = r0; r <= r1; r++) {
        const bucket = this.cells.get(c * this.gh + r);
        if (!bucket) continue;
        for (const i of bucket) {
          if (marks[i] === stamp) continue;
          marks[i] = stamp;
          if (crosses(a, b, pts[ea[i]], pts[eb[i]])) return true;
        }
      }
    }
    return false;
  }
}

let mark = 0;
const clampi = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);

/**
 * Do segments AB and CD cross?
 *
 * Sharing an endpoint is not crossing - that is just two threads meeting at an
 * item, which is the entire point of a web. Collinear overlap *is* rejected,
 * because two threads lying along each other draw as one and the longer would
 * pass straight through the item in the middle.
 *
 * Bounding boxes are checked first. It rejects most pairs in four comparisons,
 * and this runs tens of thousands of times per redraw.
 */
function crosses(a, b, c, d) {
  if (a === c || a === d || b === c || b === d) return false;
  if (Math.max(a.x, b.x) < Math.min(c.x, d.x) || Math.max(c.x, d.x) < Math.min(a.x, b.x) ||
      Math.max(a.y, b.y) < Math.min(c.y, d.y) || Math.max(c.y, d.y) < Math.min(a.y, b.y)) return false;

  const o1 = side(a, b, c), o2 = side(a, b, d);
  const o3 = side(c, d, a), o4 = side(c, d, b);
  if (o1 !== o2 && o3 !== o4) return true;
  // All four collinear and their boxes overlap: they lie along each other.
  return o1 === 0 && o2 === 0 && o3 === 0 && o4 === 0;
}

/** Which way you turn going p -> q -> r: 1 left, -1 right, 0 straight on. */
function side(p, q, r) {
  const v = (q.y - p.y) * (r.x - q.x) - (q.x - p.x) * (r.y - q.y);
  // A tolerance, not an exact zero: these are floats off a drag, and two
  // threads that are collinear to within a thousandth of a pixel draw as one.
  return v > 1e-9 ? 1 : v < -1e-9 ? -1 : 0;
}

/**
 * Prim's algorithm on the complete graph of the points: start anywhere, and
 * repeatedly attach whichever loose point is nearest to the tree so far.
 *
 * Dense O(n^2) rather than a Delaunay triangulation plus Kruskal. It is the
 * simpler code by a wide margin, it needs no geometric predicates to get
 * right, and it runs on the item counts a moodboard actually holds - a
 * few hundred points is a few tens of thousands of distance tests, well inside
 * one frame.
 *
 * Distances are compared squared; the square root is monotonic, so it would
 * only cost time without changing a single choice.
 */
function spanningTree(pts) {
  const n = pts.length;
  const inTree = new Array(n).fill(false);
  // For each loose point: its distance to the tree, and which tree point that
  // distance is to. Kept up to date as points join, which is what makes this
  // one pass per point instead of a full rescan each time.
  const best = new Array(n).fill(Infinity);
  const from = new Array(n).fill(0);
  const edges = [];

  inTree[0] = true;
  for (let i = 1; i < n; i++) {
    best[i] = dist2(pts[0], pts[i]);
    from[i] = 0;
  }

  for (let k = 1; k < n; k++) {
    let pick = -1;
    for (let i = 0; i < n; i++) {
      if (inTree[i]) continue;
      if (pick === -1 || best[i] < best[pick]) pick = i;
    }
    if (pick === -1) break;
    inTree[pick] = true;
    edges.push([from[pick], pick]);
    for (let i = 0; i < n; i++) {
      if (inTree[i]) continue;
      const d = dist2(pts[pick], pts[i]);
      if (d < best[i]) { best[i] = d; from[i] = pick; }
    }
  }
  return edges;
}

function dist2(a, b) {
  const dx = a.x - b.x, dy = a.y - b.y;
  return dx * dx + dy * dy;
}
