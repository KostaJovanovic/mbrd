// Connection lines between cards, drawn behind everything in #world. Stored as
// pairs in board.connections (not derived). Two jobs: build() resolves geometry,
// paint() culls to the viewport and writes the SVG `d` string. Non-scaling
// stroke. Do not rename the module or `settings.web` — older builds read that key.

import {
  board, bus, byId, isRider, isJoinEnd, baseStep, selection, pairKey, stuckFollowers,
  itemBare,
} from '../state.ts';
import type { ConnMeta, Item } from '../board-model.ts';
import { rafThrottle, readToken } from '../util.ts';
import { polyMidpoint, polyMeetsRect, distToSegment } from '../geometry.ts';
import type { Point, Box, Bounds } from '../geometry.ts';
import {
  routeConnection, pathData, curvePoints, blockOf, endOf, intoMiddles, portDir, bestFaces,
  CLEARANCE, DRAG_HANDLE, HANDLE_MAX,
} from '../web-route.ts';
import { queryRect } from './spatial.ts';
import {
  itemIdFromEvent, setConnectAim, setBoardLift, tiltOf, onHoverItem,
} from './items.ts';
import type { Viewport } from './viewport.ts';
import { cullMargin } from './viewport.ts';

const SVG_NS = 'http://www.w3.org/2000/svg';

/** Box in this layer's y-down coords, with lean folded in. `bare` = no card outline. */
type Card = Box & { id: string, rot: number, bare: boolean };

/** One drawn line. `sig` = end-box fingerprint; `routed` = true after the route pass. */
type Ends = { a: string, b: string };
type Seg = {
  a: Card,
  b: Card,
  sig: string,
  points: Point[],
  routed?: boolean,
  meta?: ConnMeta | null,
  ends?: Ends,
  // Outward face normals at the two endpoints — the router's chosen sides. The
  // Softish spline leaves and enters along these, so any side can meet any side.
  norms?: [Point, Point],
  // Per-point corner rounding room (world units) for a routed detour, so a
  // go-around sweeps in the open and stays tight in a corridor. See cornerCaps.
  caps?: number[],
  // The two cards cannot be joined without crossing a third (router verdict). No
  // line is drawn; the pair is listed on the "cannot join" badge instead.
  blocked?: boolean,
  // Why it was blocked, for the mbrd.joins() diagnostic: 'router' (no path found)
  // or 'cross:<id>' (the drawn curve ran through that card's body).
  blockReason?: string,
};

/** A seg with a look of its own: what decoLayer draws, and the bulk path never. */
type StyledSeg = Seg & { meta: ConnMeta };
const isStyled = (s: Seg | undefined): s is StyledSeg => !!s?.meta;

/** Which way a fade is going. */
type FadeDir = 'in' | 'out';

/** A thread mid-fade: its own element, its direction, and the timer that lands it. */
type Fade = { el: SVGPathElement, dir: FadeDir, seg: Seg, timer: number };

/** SVG sizing box (min/max), distinct from geometry.ts's Bounds (x0/x1). */
type Extent = { minX: number, minY: number, maxX: number, maxY: number };

/** What the whimsy axis asks of a connection - see look(). */
type RouteLook = { shape: string, step?: number, clearance: number, radius: number, curve?: boolean };

/** Desktop only, default on. `!== false` carries the default for un-normalised boards. */
export const webVisible = (mode = board.layoutMode) =>
  mode !== 'mobile' && board.settings.web !== false;

/** Fade durations. Lines get their own element only while fading, then return to bulk path. */
const FADE_IN_MS = 400;
const FADE_OUT_MS = 300;

// All elements below are null until initWeb(), non-null for the page lifetime.
let svg: SVGSVGElement | null = null;
let path: SVGPathElement | null = null;
let fadeLayer: SVGGElement | null = null;
// Styled connections (direction/dash/label) — own elements, outside bulk path.
let decoLayer: SVGGElement | null = null;
let hoverPath: SVGPathElement | null = null;
let hoveredKey: string | null = null;
let activePath: SVGPathElement | null = null;
let activeKey: string | null = null;
let focusPath: SVGPathElement | null = null;
// Straight red dashed line for a pair that cannot be routed cleanly — drawn in
// place of the old "?" badge, one subpath per blocked pair.
let blockedPath: SVGPathElement | null = null;
let focusIds: Set<string> | null = null;
let hoverIds: Set<string> | null = null;
// Focus held past deselect to cover the CSS transition — prevents a flash where
// the focused lines briefly become the dimmest on screen.
let heldFocus: Set<string> | null = null;
let lastFocus: Set<string> | null = null;
let holdTimer = 0;
let draftPath: SVGPathElement | null = null;
let draftFrom: string | null = null;
let draftBox: Card | null = null;
let draftPoints: Point[] | null = null;
let draftEnds: [Point, Point] | null = null;
let draftTimer = 0;
let viewportEl: HTMLElement | null = null;
let originX = 0, originY = 0;
let vp: Viewport | null = null;

/** The box the built geometry describes, kept by build() so paint() need not re-derive it. */
let settledBox: Extent = { minX: Infinity, minY: Infinity, maxX: -Infinity, maxY: -Infinity };
/** The box last written to the <svg>, so an unchanged one is not rewritten. */
let lastBox = '';
/** The padded rectangle the drawing on screen was culled against - see paint(). */
let paintedRect: Bounds | null = null;

/** key -> { el, dir, timer, seg } for the threads mid-fade. */
const animating = new Map<string, Fade>();
/** Keys currently drawn in the bulk path. */
const settled = new Set<string>();
/** Last known geometry per line. Kept so removed lines can fade out from where they were. */
const lastSeg = new Map<string, Seg>();

/** A pair the router could not join without crossing a third card — see Seg.blocked. */
export type BlockedJoin = { a: string, b: string };
/** The current set of blocked pairs, recomputed after each route pass. paint()
 *  draws each as a straight red dashed line between the two cards. */
let blocked: BlockedJoin[] = [];

/** Recompute the blocked set from every seg's router verdict. */
function refreshBlocked(): void {
  const pairs: BlockedJoin[] = [];
  for (const seg of lastSeg.values()) {
    if (seg.blocked && seg.routed && seg.ends) pairs.push({ a: seg.ends.a, b: seg.ends.b });
  }
  blocked = pairs;
}

/** Console diagnostic — `mbrd.joins()`. Every connection's routing verdict, so a
 *  "why is this line missing" is answered with the card the code blamed. Returns
 *  the rows too, so a remote inspector can read them without the console table. */
export function joinDump(): Record<string, unknown>[] {
  const rows = board.connections.map(conn => {
    const [a, b] = conn;
    const key = pairKey(a, b);
    const seg = lastSeg.get(key);
    const name = (id: string) => byId(id)?.name || id;
    // Translate a 'cross:<id>' reason to the card's name for a readable table.
    const reason = seg?.blockReason?.startsWith('cross:')
      ? 'crosses ' + name(seg.blockReason.slice(6))
      : seg?.blockReason || '';
    const drawn = !!seg && !seg.blocked && (settled.has(key) || animating.has(key));
    // Every card this drawn line's curve actually passes through (bodies), named —
    // so a line visibly cutting a card shows up here.
    let through = '';
    if (drawn && seg) {
      const pts = curveOn() ? curvePoints(seg.points, seg.norms, seg.caps) : seg.points;
      const hit: string[] = [];
      for (const c of centres()) {
        if (c.id === a || c.id === b) continue;
        if (polyMeetsRect(pts, blockOf(c, 0))) hit.push(name(c.id));
      }
      through = hit.join(', ');
    }
    return {
      from: name(a), to: name(b),
      routed: !!seg?.routed,
      drawn,
      blocked: !!seg?.blocked,
      reason,
      points: seg?.points.length ?? 0,
      through,
    };
  });
  console.table(rows);
  return rows;
}

/** Pull a thread out of the drawn/fading sets — a line that has become blocked
 *  stops being drawn at once, rather than lingering until its fade lands. */
function evict(key: string): void {
  const live = animating.get(key);
  if (live) { clearTimeout(live.timer); live.el.remove(); animating.delete(key); }
  settled.delete(key);
}

/** Build and paint share one rAF. Flag prevents a paint from swallowing a pending build. */
let wantBuild = false;
/** A repaint that has to happen whatever the view is doing - see paint(). */
let wantPaint = false;
let frame: () => void = () => {};
const requestBuild = () => { wantBuild = true; wantPaint = true; frame(); };
const requestPaint = () => { wantPaint = true; frame(); };
/** View moved — may need repaint, and restarts route pass for newly visible lines. */
const viewMoved = () => { frame(); scheduleRoute(); };

function tick() {
  if (wantBuild) { wantBuild = false; build(); }
  const forced = wantPaint;
  wantPaint = false;
  paint(forced);
}

// Nothing is routed while anything is moving — straight lines during drag,
// routed on settle. ROUTE_SETTLE_MS is a settling time, not a debounce.
const ROUTE_SETTLE_MS = 110;

/** Max lines per route pass. On-screen first; excess stays straight. */
const ROUTE_BUDGET = 200;

/** Search radius past endpoints for nearby lines to avoid overlapping. */
const AVOID_MARGIN = 240;

/** Max nearby lines one route considers. Caps the per-edge search cost. */
const AVOID_LIMIT = 8;

let routeTimer = 0;
const scheduleRoute = () => {
  clearTimeout(routeTimer);
  routeTimer = setTimeout(routePass, ROUTE_SETTLE_MS);
};

export function initWeb(worldEl: HTMLElement, viewport?: Viewport | null) {
  svg = document.createElementNS(SVG_NS, 'svg');
  svg.id = 'web';
  svg.setAttribute('aria-hidden', 'true');

  path = document.createElementNS(SVG_NS, 'path');
  path.setAttribute('fill', 'none');
  path.setAttribute('class', 'web-bulk');
  fadeLayer = document.createElementNS(SVG_NS, 'g');

  // Arrowhead marker, reused at both ends via orient="auto-start-reverse".
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

  hoverPath = document.createElementNS(SVG_NS, 'path');
  hoverPath.setAttribute('class', 'web-hover');
  hoverPath.setAttribute('fill', 'none');

  focusPath = document.createElementNS(SVG_NS, 'path');
  focusPath.setAttribute('class', 'web-focus');
  focusPath.setAttribute('fill', 'none');

  activePath = document.createElementNS(SVG_NS, 'path');
  activePath.setAttribute('class', 'web-active');
  activePath.setAttribute('fill', 'none');

  draftPath = document.createElementNS(SVG_NS, 'path');
  draftPath.setAttribute('class', 'web-draft');
  draftPath.setAttribute('fill', 'none');

  blockedPath = document.createElementNS(SVG_NS, 'path');
  blockedPath.setAttribute('class', 'web-blocked');
  blockedPath.setAttribute('fill', 'none');

  decoLayer = document.createElementNS(SVG_NS, 'g');
  svg.append(defs, activePath, hoverPath, path, blockedPath, focusPath, fadeLayer, decoLayer, draftPath);

  worldEl.prepend(svg);

  vp = viewport || null;

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
  bus.on('connections', requestBuild);
  bus.on('selection', () => { focusIds = null; requestPaint(); });
  // Card hover — dropped while panning/moving to avoid re-dimming every frame.
  onHoverItem(ids => {
    const busy = !!viewportEl && (viewportEl.classList.contains('is-panning') ||
      viewportEl.classList.contains('is-moving'));
    const next = busy || !ids?.size ? null : new Set(ids);
    if (!next && !hoverIds) return;
    hoverIds = next;
    if (!selection.size) requestPaint();
  });
  bus.on('settings', key => {
    if (key === 'web') requestBuild();
    else if (key === 'appearance') reshape();
  });
  if (vp) vp.onChange(viewMoved);

  build();
  paint(true);
}

/** Fade a thread in or out, reversing in-flight if needed. */
function fadeTo(key: string, entry: Fade, dir: FadeDir) {
  clearTimeout(entry.timer);
  entry.dir = dir;
  const ms = dir === 'in' ? FADE_IN_MS : FADE_OUT_MS;
  entry.el.style.transitionDuration = ms + 'ms';
  entry.el.style.opacity = dir === 'in' ? '1' : '0';
  entry.timer = setTimeout(() => land(key), ms + 40);
}

function begin(key: string, seg: Seg | undefined, dir: FadeDir) {
  if (!seg) return;
  const el = document.createElementNS(SVG_NS, 'path');
  el.setAttribute('class', 'thread');
  el.setAttribute('fill', 'none');
  el.style.opacity = dir === 'in' ? '0' : '1';
  fadeLayer!.append(el);
  const entry: Fade = { el, dir, seg, timer: 0 };
  animating.set(key, entry);
  // Must sit at starting opacity for one frame before transition target is set.
  requestAnimationFrame(() => {
    if (animating.get(key) === entry) fadeTo(key, entry, entry.dir);
  });
}

/** A fade has finished: give the thread back to the path, or forget it. */
function land(key: string) {
  const entry = animating.get(key);
  if (!entry) return;
  animating.delete(key);
  entry.el.remove();
  if (entry.dir === 'in') settled.add(key);
  else lastSeg.delete(key);
  requestPaint();
}

/** Item → Card in y-down coords, with CSS lean folded into rotation. */
function cardOf(it: Item, maxLean: number): Card {
  const lean = it.type === 'fence' ? 0 : tiltOf(it.id) * maxLean;
  return {
    id: it.id, x: it.x, y: -it.y, w: it.w, h: it.h, rot: -(it.rot || 0) + lean,
    bare: itemBare(it),
  };
}


/** All join-eligible items as Cards (y-down). Excludes riders, ghosts, stickers,
 *  and fences — a fence is a region, not a card, so it is neither an endpoint nor
 *  an obstacle. Left in, its box encloses the cards inside it and every route
 *  between them reads as blocked. Matches the export in ui/snapshot.ts. */
function centres(): Card[] {
  const maxLean = drawnTilt();
  return board.items
    .filter(i => !isRider(i) && isJoinEnd(i) && i.type !== 'fence')
    .map(i => cardOf(i, maxLean));
}

/** The straight, middle-anchored line shown before a route settles — and while a
 *  card is moving. Endpoints sit at the face centres, with a gentle curve handle
 *  each way, so a line in motion leaves the middle of a side like a settled one,
 *  never aimed diagonally at the far card. */
function straightSeg(pa: Card, pb: Card, sig: string): Seg {
  // Any side to any side, the same face search the settled curve uses — never a
  // locked facing pair. Bare ends draw from their centre (the line hides under
  // the subject), so they take no face.
  const f = bestFaces(pa, pb);
  const ea = pa.bare ? { x: pa.x, y: pa.y } : f.a;
  const eb = pb.bare ? { x: pb.x, y: pb.y } : f.b;
  const h = Math.min(DRAG_HANDLE * (Math.hypot(eb.x - ea.x, eb.y - ea.y) || 1), HANDLE_MAX);
  const da = pa.bare ? portDir(pa, pb) : f.na;
  const db = pb.bare ? portDir(pb, pa) : f.nb;
  return {
    a: pa, b: pb, sig,
    points: [ea, eb],
    norms: [{ x: da.x * h, y: da.y * h }, { x: db.x * h, y: db.y * h }],
  };
}

/** Max lean in degrees. Routes clip against the tilted box so lines end exactly
 * on the drawn edge. Zeroed at Harsh and when snap is on (CSS zeroes rotation). */
let leanDeg: number | null = null;
function drawnTilt() {
  if (leanDeg === null) {
    leanDeg = Math.abs(parseFloat(readToken('--tilt-max'))) || 0;
  }
  if (document.documentElement.dataset.whimsy === '2' || board.settings.snap) return 0;
  return leanDeg;
}

/** Release all lines — fades, geometry, routes. Called on layout change or resetWeb(). */
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
  activeMoved?.();
  hoveredKey = null;
  if (hoverPath) hoverPath.setAttribute('d', '');
  viewportEl?.classList.remove('over-connection');
  leanDeg = null;
  focusIds = null;
  hoverIds = null;
  if (holdTimer) { clearTimeout(holdTimer); holdTimer = 0; }
  heldFocus = null;
  lastFocus = null;
  setBoardLift(null);
  if (focusPath) focusPath.setAttribute('d', '');
  if (svg) svg.classList.remove('is-focused');
  document.documentElement.classList.remove('web-lifted');
  if (activePath) activePath.setAttribute('d', '');
  if (draftPath) draftPath.setAttribute('d', '');
  if (path) path.setAttribute('d', '');
  if (decoLayer) while (decoLayer.firstChild) decoLayer.removeChild(decoLayer.firstChild);
}

/** Whimsy axis moved — invalidate routes without releasing lines. */
function reshape() {
  leanDeg = null;
  for (const seg of lastSeg.values()) seg.routed = false;
  requestPaint();
  scheduleRoute();
}

/** Full reset — drop cached routes, rebuild from scratch. "Reload board" calls this. */
export function resetWeb() {
  if (!svg) return;
  release();
  requestBuild();
}

/** End-box fingerprint, rounded to 0.1 world units. Same sig = same route. */
const sigOf = (a: Card, b: Card) =>
  [a.x, a.y, a.w, a.h, a.rot, b.x, b.y, b.w, b.h, b.rot]
    .map(n => Math.round(n * 10) / 10).join(',')
  + `,${a.bare ? 1 : 0}${b.bare ? 1 : 0}`;

/** Rolling 32-bit hash of all card boxes — detects when any obstacle has moved. */
function fieldSig(where: Map<string, Card>): number {
  let h = where.size | 0;
  for (const c of where.values()) {
    for (const n of [c.x, c.y, c.w, c.h, c.rot]) {
      h = (Math.imul(h, 31) + Math.round(n * 10)) | 0;
    }
  }
  return h;
}

/** The field the stored routes were computed against - see build(). */
let lastField = 0;

/** Grow settledBox to hold a point. */
function stretchBox(p: Point) {
  if (p.x < settledBox.minX) settledBox.minX = p.x;
  if (p.y < settledBox.minY) settledBox.minY = p.y;
  if (p.x > settledBox.maxX) settledBox.maxX = p.x;
  if (p.y > settledBox.maxY) settledBox.maxY = p.y;
}

/** Rebuild the connection set — runs on item move/add/remove or connection change. */
function build() {
  if (!svg) return;
  if (!webVisible()) {
    release();
    svg.style.display = 'none';
    return;
  }
  const where = new Map<string, Card>(centres().map(p => [p.id, p]));
  // Any card moving invalidates all routes (every card is a potential obstacle).
  const field = fieldSig(where);
  if (field !== lastField) {
    lastField = field;
    for (const seg of lastSeg.values()) seg.routed = false;
    scheduleRoute();
  }
  if (draftFrom) draftBox = where.get(draftFrom) || null;

  const wanted = new Map<string, Seg>();
  settledBox = { minX: Infinity, minY: Infinity, maxX: -Infinity, maxY: -Infinity };
  for (const conn of board.connections) {
    const [a, b] = conn;
    const pa = where.get(a);
    const pb = where.get(b);
    if (!pa || !pb) continue;
    const key = pairKey(a, b);
    const sig = sigOf(pa, pb);
    const held = lastSeg.get(key);
    const seg: Seg = held && held.sig === sig ? held : straightSeg(pa, pb, sig);
    // Meta refreshed every build — an edit changes the look without moving an end.
    seg.meta = (conn.length === 3 ? conn[2] : null) || null;
    seg.ends = { a, b };
    wanted.set(key, seg);
    for (const p of seg.points) stretchBox(p);
  }
  scheduleRoute();

  // Off-screen threads skip the fade — just appear/disappear.
  const vis = visibleBox(cullMargin(vp));
  const onScreen = (seg: Seg | undefined) => !vis || !seg ||
    !(Math.max(seg.a.x, seg.b.x) < vis.x0 || Math.min(seg.a.x, seg.b.x) > vis.x1 ||
      Math.max(seg.a.y, seg.b.y) < vis.y0 || Math.min(seg.a.y, seg.b.y) > vis.y1);

  for (const [key, seg] of wanted) {
    lastSeg.set(key, seg);
    // A known-blocked pair draws nothing and never enters a fade or the bulk path.
    if (seg.blocked) { evict(key); continue; }
    if (settled.has(key)) continue;
    const live = animating.get(key);
    if (!live) {
      // Styled lines skip the fade (drawn by own element in decoLayer).
      if (onScreen(seg) && !seg.meta) begin(key, seg, 'in');
      else settled.add(key);
      continue;
    }
    live.seg = seg;
    if (live.dir === 'out') fadeTo(key, live, 'in');
  }
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
  // Blocked pairs sit in neither settled nor animating, so a deleted one is not
  // pruned by the two loops above — drop any lastSeg entry nothing holds. Deleting
  // the current key during Map iteration is safe.
  for (const key of lastSeg.keys()) {
    if (!wanted.has(key) && !settled.has(key) && !animating.has(key)) lastSeg.delete(key);
  }
}

/** Nearby already-routed lines — the router avoids lying along them. */
function linesNear(self: string, seg: Seg): Point[][] {
  const x0 = Math.min(seg.a.x, seg.b.x) - AVOID_MARGIN;
  const x1 = Math.max(seg.a.x, seg.b.x) + AVOID_MARGIN;
  const y0 = Math.min(seg.a.y, seg.b.y) - AVOID_MARGIN;
  const y1 = Math.max(seg.a.y, seg.b.y) + AVOID_MARGIN;
  const out: Point[][] = [];
  for (const [key, other] of lastSeg) {
    if (key === self || !other.routed || other.points.length < 2) continue;
    let lo = Infinity, hi = -Infinity, top = Infinity, bottom = -Infinity;
    for (const p of other.points) {
      if (p.x < lo) lo = p.x;
      if (p.x > hi) hi = p.x;
      if (p.y < top) top = p.y;
      if (p.y > bottom) bottom = p.y;
    }
    if (hi < x0 || lo > x1 || bottom < y0 || top > y1) continue;
    out.push(other.points);
    if (out.length >= AVOID_LIMIT) break;
  }
  return out;
}

/** Route all owed lines, on-screen first. Runs once things stop moving. */
function routePass() {
  if (!svg || !webVisible()) return;
  const where = new Map<string, Card>(centres().map(p => [p.id, p]));
  const vis = visibleBox(cullMargin(vp));
  const near = (seg: Seg) => !vis ||
    !(Math.max(seg.a.x, seg.b.x) < vis.x0 || Math.min(seg.a.x, seg.b.x) > vis.x1 ||
      Math.max(seg.a.y, seg.b.y) < vis.y0 || Math.min(seg.a.y, seg.b.y) > vis.y1);

  const owed = [...lastSeg.entries()].filter(([, seg]) => !seg.routed);
  const order = [...owed.filter(([, s]) => near(s)), ...owed.filter(([, s]) => !near(s))];

  const opts = look();
  let spent = 0;
  for (const [key, seg] of order) {
    if (spent++ >= ROUTE_BUDGET) break;
    const { a, b } = seg;
    // No fan slots: every line leaves and enters at the middle of a side.
    const routed = routeConnection(a, b, obstaclesBetween(a, b, where), {
      ...opts,
      avoid: linesNear(key, seg),
    });
    seg.points = intoMiddles(routed.points, a, b);
    seg.norms = routed.ends;
    // Caps align one-to-one with routed.points; a bare end would shift them, so
    // keep them only when the counts still match (always, for card-to-card).
    seg.caps = routed.caps && routed.caps.length === seg.points.length ? routed.caps : undefined;
    seg.routed = true;
    // The router only knew the cards in its search box; a final check against every
    // card the drawn curve actually reaches catches a bow that swung past that box.
    const crossId = routed.blocked ? null : curveCrossesCard(seg, where);
    seg.blocked = routed.blocked || !!crossId || undefined;
    seg.blockReason = routed.blocked ? 'router' : crossId ? 'cross:' + crossId : undefined;
    // A pair that cannot be joined draws nothing — take it off screen at once and
    // let the badge speak for it (ui/join-badge.ts).
    if (seg.blocked) evict(key);
    for (const p of seg.points) stretchBox(p);
  }
  refreshBlocked();
  requestPaint();
}

/** Does the seg's drawn curve pass through any card body that is not one of its
 *  own ends? The router validated against the cards in its search box; this walks
 *  the sampled curve — the very geometry that gets drawn — against every card near
 *  the curve's own bounds, so a bow that swung past the box is still caught. */
function curveCrossesCard(seg: Seg, where: Map<string, Card>): string | null {
  const pts = curveOn() ? curvePoints(seg.points, seg.norms, seg.caps) : seg.points;
  if (pts.length < 2) return null;
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const p of pts) {
    if (p.x < x0) x0 = p.x;
    if (p.y < y0) y0 = p.y;
    if (p.x > x1) x1 = p.x;
    if (p.y > y1) y1 = p.y;
  }
  // queryRect wants world (y-up) coords; the curve is y-down.
  for (const id of queryRect({ x0, x1, y0: -y1, y1: -y0 })) {
    if (id === seg.a.id || id === seg.b.id) continue;
    const p = where.get(id);
    if (!p) continue;
    if (polyMeetsRect(pts, blockOf(p, 0))) return id;
  }
  return null;
}

/** Every other join-eligible card, as obstacles. A between-the-endpoints box is
 *  wrong for the Softish tier: a route that goes AROUND a cluster passes cards far
 *  outside that box, which the router then never avoids and the curve cuts through.
 *  The router caps at MAX_OBSTACLES (nearest to the midpoint), so handing it all is
 *  bounded — and matches how routes are verified off-line. */
function obstaclesBetween(a: Card, b: Card, where: Map<string, Card>): Card[] {
  const out: Card[] = [];
  for (const [id, p] of where) if (id !== a.id && id !== b.id) out.push(p);
  return out;
}

/** Visible rect in y-down coords, widened by `margin`. */
function visibleBox(margin = 0): Bounds | null {
  if (!vp) return null;
  const r = vp.visibleRect(margin);
  return { x0: r.x0, x1: r.x1, y0: -r.y1, y1: -r.y0 };
}

/** Is `inner` wholly within `outer`? */
const within = (inner: Bounds, outer: Bounds) =>
  inner.x0 >= outer.x0 && inner.x1 <= outer.x1 &&
  inner.y0 >= outer.y0 && inner.y1 <= outer.y1;

/** Cull threads to the visible rect and write the SVG `d` string. Per-segment
 * test (not bounding box) so long diagonals skip correctly. */
function paint(forced = false) {
  if (!svg) return;
  // Non-null on both: initWeb() makes the bulk path and the focus copy in the same
  // breath as the <svg> tested above, and nothing puts either back to null.
  const bulk = path!;
  const focus = focusPath!;
  if (!webVisible()) {
    svg.style.display = 'none';
    paintedRect = null;
    return;
  }
  // Nothing to draw. The only remaining reason to skip the whole `d` string
  // below - zoom is not one of them any more, see the note by the fade
  // constants that used to be here. A draft counts as something to draw: on a
  // board with no connections at all, it is the only line there is.
  if (!settled.size && !animating.size && !draftPoints && !blocked.length) {
    svg.style.display = 'none';
    // Nothing was drawn, so nothing below is true of what is on screen.
    paintedRect = null;
    // The mark and the hover go with the lines. Both are reconciled at the foot of
    // this function, so on the frame the *last* line left the board the chip
    // stayed pinned over empty board until the next syncConnChip().
    if (hoveredKey) { hoveredKey = null; drawHover(); }
    if (activeKey) { activeKey = null; drawActive(); activeMoved?.(); }
    return;
  }
  svg.style.display = '';

  // Everything below is a function of where the *threads* are, not where the eye
  // is - the view only decides which go into the string. So while the screen stays
  // inside the padded rectangle the last pass culled against, the string it would
  // build is the one already there, and a pan returns without touching it.
  //
  // That is the whole of the saving: `d` is one long line of coordinates for every
  // thread on screen, rebuilt from scratch and re-parsed by the browser - several
  // milliseconds on every pan frame, on a board with a few hundred threads, to
  // arrive at last frame's answer. A thread does not move when you look elsewhere.
  //
  // A fade starting or landing, or the threads changing, comes through as `forced`.
  const tight = visibleBox(0);
  if (!forced && paintedRect && tight && within(tight, paintedRect)) return;
  paintedRect = tight ? visibleBox(cullMargin(vp)) : null;

  // The box has to hold the fading threads too. One may be anchored to an item
  // just deleted, sitting outside the box the surviving centres describe, and an
  // SVG clips at its own edge.
  //
  // It is the *whole* board's box, not the visible one: sizing it to the view
  // would move its origin on every pan, re-emitting every coordinate in `d` for
  // threads that had not moved. The settled half is build()'s answer; only the
  // fading threads are added here, and there are rarely any.
  let { minX, minY, maxX, maxY } = settledBox;
  const stretch = (p: Point) => {
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
  // A blocked pair draws a straight line card-to-card; its ends sit on the card
  // faces and may reach outside the settled box, which an <svg> would clip.
  const blockedLines: [Point, Point][] = [];
  if (blocked.length) {
    const cards = new Map(centres().map(c => [c.id, c]));
    for (const p of blocked) {
      const ca = cards.get(p.a), cb = cards.get(p.b);
      if (!ca || !cb) continue;
      const f = bestFaces(ca, cb);
      blockedLines.push([f.a, f.b]);
      stretch(f.a); stretch(f.b);
    }
  }
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
  const curved = curveOn();
  const lit = focusSet();
  // What is drawn into the lifted copy: the live focus, or the one that has just
  // ended (see heldFocus). Whether the *board* dims is `lit` alone, further down -
  // the hold is the copy outliving the dimming by a transition, so a hold that
  // held the class would hold the whole lift. Called before `shown` is read: a
  // hold opened afterwards would be one frame too late, and that frame was the
  // flash.
  holdFocus(lit);
  const shown = lit || heldFocus;
  let d = '';
  let focusD = '';
  // Whether the selection lit *anything* on screen, styled lines included, counted
  // separately from the string below. A styled line is drawn in decoLayer and
  // never enters `d`, so a card whose connections all carry a colour or an arrow
  // lit an empty string and the board did not dim at all.
  let litAny = false;
  const byPointer = !selection.size;
  let joined: Set<string> | null = null;
  for (const key of settled) {
    const seg = lastSeg.get(key);
    if (!seg) continue;
    if (vis && !polyMeetsRect(seg.points, vis)) continue;
    const isLit = !!(shown && seg.ends && (shown.has(seg.ends.a) || shown.has(seg.ends.b)));
    if (isLit && lit) {
      litAny = true;
      if (byPointer && seg.ends) {
        joined ||= new Set();
        if (lit.has(seg.ends.a)) joined.add(seg.ends.b);
        if (lit.has(seg.ends.b)) joined.add(seg.ends.a);
      }
    }
    // Styled lines are drawn in decoLayer, never the bulk stroke - a dash or an
    // arrow is per-line and this path is one shared `d`. drawDecorations marks
    // the lit ones with .web-lit, which is how they stay at full strength.
    if (seg.meta) continue;
    const sub = pathData(seg.points, r, minX, minY, curved, curved ? seg.norms : undefined, curved ? seg.caps : undefined);
    d += sub;
    // The same subpath twice, in the one case where that is cheaper than the
    // alternative: the focused threads are drawn again over the dimmed bulk
    // path rather than held out of it, which would mean two strings that have
    // to agree about which lines exist instead of one string and a copy.
    if (isLit) focusD += sub;
  }
  // A blocked pair draws no line, but the hovered card's intended partner is still
  // related — it must not dim as if it were a stranger. Add it to the un-dimmed set
  // the same way a drawn partner is added above.
  if (byPointer && lit) {
    for (const p of blocked) {
      if (lit.has(p.a)) { joined ||= new Set(); joined.add(p.b); }
      if (lit.has(p.b)) { joined ||= new Set(); joined.add(p.a); }
    }
  }
  bulk.setAttribute('d', d);
  focus.setAttribute('d', focusD);
  // The blocked pairs, each a straight subpath between the two card faces. Culled
  // to the visible rect like the bulk lines; the CSS makes it red and dashed.
  let blockedD = '';
  for (const [p1, p2] of blockedLines) {
    if (vis && !polyMeetsRect([p1, p2], vis)) continue;
    blockedD += `M${(p1.x - minX).toFixed(2)} ${(p1.y - minY).toFixed(2)}`
      + `L${(p2.x - minX).toFixed(2)} ${(p2.y - minY).toFixed(2)}`;
  }
  blockedPath!.setAttribute('d', blockedD);
  // Only when something was actually lit. A selected card with no lines of its
  // own, or none on screen, would otherwise dim the whole board to say nothing.
  svg.classList.toggle('is-focused', litAny);
  // And the same word on the root, for the one thing dimmed with the other lines
  // that is not one of them: the world axes. They are a canvas in screen space
  // (canvas/grid.ts), outside this `<svg>` and outside #world, so no selector from
  // here reaches them - the flag goes on the root and the stylesheets take it from
  // there, as data-snap and .is-connecting already do.
  //
  // The axes are two full-length ruled lines, and while a card's threads are
  // lifted out of a board dropped to 0.18 they would be the only other lines at
  // full strength - two rules through the picture that are nobody's.
  document.documentElement.classList.toggle('web-lifted', litAny);
  // And the board behind them steps back: the card under the pointer, the cards
  // its lines reach, and whatever is stuck to any of them. A sticker is a remark
  // about the card it sits on, so dimming one over a card that stayed lit would
  // take the pile apart - stuckFollowers() is the walk a drag uses.
  //
  // Guarded on there being a far end at all: a card with no lines has nothing to
  // step back *from*, and dimming forty cards to say so would read as an
  // announcement.
  setBoardLift(joined?.size && lit ? withRiders(lit, joined) : null);

  // The box's origin moves whenever the outermost end does, so every fading
  // line is repositioned each frame as well - they are relative to a corner
  // that is itself in motion. There are only ever a handful, so they are not
  // worth culling.
  for (const { el, seg } of animating.values()) {
    // A line styled while it was mid-fade is drawn by decoLayer instead, so its
    // fading element is left blank rather than showing a solid twin under the
    // styled one. The fade timer still removes the empty element on its own.
    el.setAttribute('d', seg.meta ? ''
      : pathData(seg.points, r, minX, minY, curved, curved ? seg.norms : undefined, curved ? seg.caps : undefined));
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
 * Rebuilt from nothing each paint rather than reconciled - the opposite of the
 * bulk path's rule, and right for the same reason it is wrong there: these are a
 * handful, not hundreds. Everything they need is on the seg.
 */
function drawDecorations(
  minX: number, minY: number, r: number, vis: Bounds | null, lit: Set<string> | null,
) {
  // Non-null: the only caller is paint(), past its guard on `svg` - and this
  // layer is one of the elements initWeb() makes with it.
  const layer = decoLayer!;
  const curved = curveOn();
  while (layer.firstChild) layer.removeChild(layer.firstChild);
  // Only the styled ones, which is what isStyled() says in a form that carries
  // the `meta` through: everything below reads it, and a plain line never
  // reaches this list at all.
  const segs: StyledSeg[] = [];
  for (const key of settled) { const s = lastSeg.get(key); if (isStyled(s)) segs.push(s); }
  for (const [key, live] of animating) {
    if (!settled.has(key) && isStyled(live.seg)) segs.push(live.seg);
  }
  for (const seg of segs) {
    if (vis && !polyMeetsRect(seg.points, vis)) continue;
    const line = document.createElementNS(SVG_NS, 'path');
    // Colour and weight are class names, never values written into a style -
    // see connMeta() in board-model.ts for why that distinction is the whole
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
    line.setAttribute('d', pathData(seg.points, r, minX, minY, curved, curved ? seg.norms : undefined, curved ? seg.caps : undefined));
    const style = seg.meta.style;
    if (style === 'dashed') line.setAttribute('stroke-dasharray', '7 5');
    else if (style === 'dotted') line.setAttribute('stroke-dasharray', '0.5 5');
    const dir = seg.meta.dir;
    if (dir === 'fwd' || dir === 'both') line.setAttribute('marker-end', 'url(#web-arrow)');
    if (dir === 'back' || dir === 'both') line.setAttribute('marker-start', 'url(#web-arrow)');
    layer.append(line);

    if (seg.meta.label) {
      const mid = polyMidpoint(curved ? curvePoints(seg.points, seg.norms, seg.caps) : seg.points);
      const text = document.createElementNS(SVG_NS, 'text');
      text.setAttribute('class', 'web-label');
      text.setAttribute('x', (mid.x - minX).toFixed(2));
      text.setAttribute('y', (mid.y - minY).toFixed(2));
      text.setAttribute('text-anchor', 'middle');
      text.textContent = seg.meta.label;
      layer.append(text);
    }
  }
}

/** Nearest line to a world point, within `tolPx` screen px. Flips y. */
function nearestSeg(wx: number, wy: number, tolPx: number) {
  if (!svg || !webVisible()) return null;
  const py = -wy;
  const tol = tolPx / (vp ? vp.zoom : 1);
  let best: Seg | null = null, bestKey: string | null = null, bestD = tol;
  for (const [key, seg] of lastSeg) {
    if (!seg.ends) continue;
    // Exclude fading-out lines — hitting one would re-create the deleted connection.
    if (!settled.has(key)) continue;
    // Walk the drawn curve, not the chord under it, so the hitbox follows the line.
    const pts = curveOn() ? curvePoints(seg.points, seg.norms, seg.caps) : seg.points;
    for (let i = 1; i < pts.length; i++) {
      const d = distToSegment(wx, py, pts[i - 1], pts[i]);
      if (d < bestD) { bestD = d; best = seg; bestKey = key; }
    }
  }
  return best ? { key: bestKey!, seg: best } : null;
}

export function connectionAt(wx: number, wy: number, tolPx = 10): Ends | null {
  const ends = nearestSeg(wx, wy, tolPx)?.seg.ends;
  return ends ? { a: ends.a, b: ends.b } : null;
}

// === Active connection (pressed line) — not part of item selection ===

/** The connection currently pointed at, as its two ends, or null. */
export function activeConnection(): Ends | null {
  const seg = activeKey ? lastSeg.get(activeKey) : null;
  return seg?.ends ? { a: seg.ends.a, b: seg.ends.b } : null;
}

/** Point at a connection, or at none - both ends null puts the mark away. */
export function setActiveConnection(a: string | null, b: string | null) {
  const key = a && b ? pairKey(a, b) : null;
  if (key === activeKey) return;
  activeKey = key;
  drawActive();
}

export function clearActiveConnection() { setActiveConnection(null, null); }

/** World-space midpoint of the active line (arc-length midpoint, y flipped). */
export function activeConnectionAnchor(): Point | null {
  const seg = activeKey ? lastSeg.get(activeKey) : null;
  if (!seg?.points?.length) return null;
  const mid = polyMidpoint(curveOn() ? curvePoints(seg.points, seg.norms, seg.caps) : seg.points);
  return { x: mid.x, y: -mid.y };
}

/** Single callback when active line redraws — for conn-chip.ts to follow. */
let activeMoved: (() => void) | null = null;
export function onActiveConnectionMove(fn: () => void) { activeMoved = fn; }

/** Cards whose threads are lifted. Selection wins over hover. */
function focusSet(): Set<string> | null {
  if (selection.size) {
    if (!focusIds) focusIds = new Set(selection);
    return focusIds;
  }
  return hoverIds;
}

/** Join two id sets with all stuck followers. Memoised per paint. */
let riderMemo: { key: string, out: Set<string> } | null = null;
bus.on('items', () => { riderMemo = null; });
bus.on('board:load', () => { riderMemo = null; });

function withRiders(a: Set<string>, b: Set<string>): Set<string> {
  const ids = [...a, ...b];
  const key = ids.sort().join(',');
  if (riderMemo?.key === key) return riderMemo.out;
  const out = new Set(ids);
  for (const id of stuckFollowers(out)) out.add(id);
  riderMemo = { key, out };
  return out;
}

/** Manage the held focus that bridges the transition after deselect. */
function holdFocus(lit: Set<string> | null): void {
  if (lit) {
    if (holdTimer) { clearTimeout(holdTimer); holdTimer = 0; }
    heldFocus = null;
    lastFocus = lit;
    return;
  }
  if (!lastFocus || holdTimer) return;
  heldFocus = lastFocus;
  lastFocus = null;
  holdTimer = setTimeout(() => {
    holdTimer = 0;
    heldFocus = null;
    requestPaint();
  }, liftMs());
}

/** Read --dur-fast for the hold duration. Varies with whimsy/reduced-motion. */
function liftMs(): number {
  const raw = readToken('--dur-fast');
  const n = parseFloat(raw) || 0;
  return raw.endsWith('ms') ? n : n * 1000;
}

/** Redraw the mark over the active line, or clear it. */
function drawActive() {
  if (!activePath) return;
  const seg = activeKey ? lastSeg.get(activeKey) : null;
  activePath.setAttribute('d', seg
    ? pathData(seg.points, cornerRadius(), originX, originY, curveOn(), curveOn() ? seg.norms : undefined, curveOn() ? seg.caps : undefined)
    : '');
  // After the draw, not before: whatever follows this line is placed against where
  // it has just been put, and the mark going away is as much a move as it moving.
  activeMoved?.();
}

/** Redraw the hover highlight over the currently hovered line, or clear it. */
function drawHover() {
  if (!hoverPath) return;
  const seg = hoveredKey ? lastSeg.get(hoveredKey) : null;
  hoverPath.setAttribute('d', seg
    ? pathData(seg.points, cornerRadius(), originX, originY, curveOn(), curveOn() ? seg.norms : undefined, curveOn() ? seg.caps : undefined)
    : '');
}

/** Update hover to the line under (wx, wy). Returns true if one was found. */
function hoverConnectionAt(wx: number, wy: number, tolPx = 12) {
  const hit = nearestSeg(wx, wy, tolPx);
  const key = hit ? hit.key : null;
  if (key !== hoveredKey) { hoveredKey = key; drawHover(); }
  return !!key;
}

// === Draft line (connector tool in flight) ===

/** Set or clear the draft origin. null puts the draft away. */
export function setDraftFrom(id: string | null) {
  draftFrom = id || null;
  draftBox = draftFrom ? boxOf(draftFrom) : null;
  draftPoints = null;
  draftEnds = null;
  clearTimeout(draftTimer);
  setConnectAim(null);
  if (!draftFrom) requestPaint();
}

/** One item's box in this layer's coordinates - centres() for a single id. */
function boxOf(id: string): Card | null {
  const it = byId(id);
  if (!it || isRider(it) || !isJoinEnd(it) || it.type === 'fence') return null;
  return cardOf(it, drawnTilt());
}

/** Move the draft line to follow the pointer. Marks the target card. */
function aimDraft(e: PointerEvent) {
  if (!draftFrom || !vp || !webVisible()) return;
  if (!draftBox) draftBox = boxOf(draftFrom);
  if (!draftBox) return;
  const w = vp.toWorld(e.clientX, e.clientY);
  const overId = itemIdFromEvent(e.target);
  const overBox = overId && overId !== draftFrom ? boxOf(overId) : null;
  const aim = overBox ? overId : null;
  setConnectAim(aim);
  const to = overBox || { id: '', x: w.x, y: -w.y, w: 1, h: 1, rot: 0, bare: false };
  draftEnds = [portDir(draftBox, to), portDir(to, draftBox)];
  draftPoints = [endOf(draftBox, to), aim ? endOf(to, draftBox) : { x: to.x, y: to.y }];
  requestPaint();
  clearTimeout(draftTimer);
  draftTimer = setTimeout(() => {
    if (!draftFrom || !draftBox) return;
    const where = new Map<string, Card>(centres().map(p => [p.id, p]));
    const opts = look();
    const routed = routeConnection(
      draftBox, to, obstaclesBetween(draftBox, to, where), opts);
    draftPoints = intoMiddles(routed.points, draftBox, to);
    draftEnds = routed.ends ?? draftEnds;
    requestPaint();
  }, ROUTE_SETTLE_MS);
}

/** Draw the draft where paint() has just laid the box out, or clear it. */
function drawDraft(minX: number, minY: number, r: number) {
  if (!draftPath) return;
  draftPath.setAttribute('d', draftPoints
    ? pathData(draftPoints, r, minX, minY, curveOn(), curveOn() && draftEnds ? draftEnds : undefined)
    : '');
}

/** Drop any hover highlight - the pointer left the board, or a gesture began. */
function clearHover() {
  if (hoveredKey !== null) { hoveredKey = null; drawHover(); }
}

function endHover() {
  clearHover();
  if (viewportEl) viewportEl.classList.remove('over-connection');
}

/** Hover or draft-aim on pointer move. Only on bare board, not during pan/drag. */
function onHoverMove(e: PointerEvent) {
  if (draftFrom) { aimDraft(e); return; }
  const view = viewportEl!;
  const root = document.documentElement;
  const busy = view.classList.contains('is-panning') ||
    view.classList.contains('is-moving') || root.classList.contains('is-sizing-paper');
  if (busy || e.target !== view || !webVisible() || !vp) { endHover(); return; }
  const w = vp.toWorld(e.clientX, e.clientY);
  const on = hoverConnectionAt(w.x, w.y);
  view.classList.toggle('over-connection', on);
}

/** A little extra room for the Softish curve to bow into as it passes a card,
 * so the spline does not clip one it routed around. Small: the curve hugs close. */
const CURVE_ROOM = 8;

/** Rounded-corner radius for the Middle tier's orthogonal wires. */
const MIDDLE_RADIUS = 16;

/** Route options from the whimsy tier: Harsh=grid right angles, Middle=orthogonal
 *  rounded corners, Softish=a taut route drawn as a flowing spline. */
function look(): RouteLook {
  const level = document.documentElement.dataset.whimsy;
  if (level === '2') {
    return { shape: 'grid', step: baseStep(), clearance: CLEARANCE, radius: 0 };
  }
  if (level === '0') {
    return { shape: 'curve', clearance: CLEARANCE + CURVE_ROOM, radius: 0, curve: true };
  }
  // Middle, and the fallback before the dial has been read.
  return { shape: 'square', clearance: CLEARANCE, radius: MIDDLE_RADIUS };
}

/** How round a corner is - the half of look() that paint() and the hover want. */
function cornerRadius() {
  return look().radius;
}

/** Whether the current tier draws its lines as flowing curves (Softish). */
function curveOn() {
  return !!look().curve;
}

