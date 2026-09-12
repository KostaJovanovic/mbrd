// Background grid. Painted in screen space on #viewport so marks stay crisp
// at any zoom. Spacing quantises in powers of two to avoid crowding.
// Softish/Middle: CSS radial gradients (cheap restyle). Harsh: <canvas> crosses.

import { board } from '../state.ts';
import { deviceRatio, onTouch, mobilePerfFlags } from './viewport.ts';
import type { Viewport } from './viewport.ts';
import { MM_PER_INCH, PX_PER_INCH } from '../measure.ts';
import { viewShift } from '../geometry.ts';
import { wrap } from '../util.ts';

/** The screen-space box the lattice is drawn in - see inkBox(). */
type InkBox = {
  x: number;
  y: number;
  w: number;
  h: number;
  topRadius: string;
  bottomRadius: string;
};

/** Canvas with its backing-store device ratio attached. */
type InkCanvas = HTMLCanvasElement & { _dpr: number };

// Screen-space band a minor step must stay within. Ratio of 4 = MAJOR.
export const MIN_PX = 40;
export const MAX_PX = 160;
export const MAJOR = 4;

export const MAJOR_WEIGHT = 1.5;

// Touch: stated in mm so the floor scales with actual device DPI
const TOUCH_MIN_MM = 14.1;
export const MIN_PX_TOUCH = Math.ceil(TOUCH_MIN_MM * PX_PER_INCH / MM_PER_INCH);
export const MAX_PX_TOUCH = MIN_PX_TOUCH * MAJOR;
// Clips marks centred on the board boundary (covers max dot/cross radius)
export const MOBILE_GRID_EDGE_CLEARANCE = 7;


export const axesVisible = (settings = board.settings, mode = board.layoutMode) =>
  !!settings.axes && mode !== 'mobile';

/** World-space step that keeps on-screen spacing inside [MIN_PX, MAX_PX]. */
export function gridStep(base: number, zoom: number, touch = onTouch()): number {
  const min = touch ? MIN_PX_TOUCH : MIN_PX;
  const max = touch ? MAX_PX_TOUCH : MAX_PX;
  let step = base > 0 ? base : 64;
  let guard = 0;
  while (step * zoom < min && guard++ < 64) step *= 2;
  while (step * zoom > max && guard++ < 64) step /= 2;
  return step;
}

/** Grid step for this viewport. Mobile keeps the step fixed (width is measured in grid spaces). */
export function boardGridStep(
  base: number,
  viewport: Pick<Viewport, 'zoom' | 'isMobile'> | null | undefined,
  touch = onTouch(),
): number {
  const step = base > 0 ? base : 64;
  const zoom = viewport?.zoom;
  return viewport?.isMobile
    ? step
    : gridStep(step, zoom != null && zoom > 0 ? zoom : 1, touch);
}

/** Screen-space box the lattice draws in. Desktop = viewport; Mobile = board intersection with viewport. */
export function inkBox(
  vp: Pick<Viewport, 'width' | 'height' | 'isMobile' | 'mobileScreenRect'>,
): InkBox {
  const full = {
    x: 0, y: 0, w: vp.width, h: vp.height,
    topRadius: '0px', bottomRadius: '0px',
  };
  if (!vp.isMobile || !vp.mobileScreenRect) return full;
  const r = vp.mobileScreenRect();
  const inset = MOBILE_GRID_EDGE_CLEARANCE;
  const left = r.left + inset;
  const top = r.top + inset;
  const right = r.left + r.width - inset;
  const bottom = r.bottom - inset;
  const x = Math.max(0, left);
  const y = Math.max(0, top);
  return {
    x,
    y,
    w: Math.max(0, Math.min(vp.width, right) - x),
    h: Math.max(0, Math.min(vp.height, bottom) - y),
    // Only round a physical board edge. When that edge has scrolled outside
    // the viewport, the canvas is clipped to the glass and must stay square
    // there instead of inventing a second pair of corners.
    topRadius: r.top >= 0 ? 'var(--radius)' : '0px',
    bottomRadius: r.bottom <= vp.height ? 'var(--radius)' : '0px',
  };
}

/** What was last written to the ink layer's box, so a still board writes none. */
let lastBox = '';

/** Stand the lattice layer on the box it is allowed to draw in. */
function placeInk(canvas: HTMLCanvasElement, box: InkBox) {
  const next = `${box.x},${box.y},${box.w},${box.h},${box.topRadius},${box.bottomRadius}`;
  if (next === lastBox) return;
  lastBox = next;
  canvas.style.left = `${box.x}px`;
  canvas.style.top = `${box.y}px`;
  canvas.style.width = `${box.w}px`;
  canvas.style.height = `${box.h}px`;
  canvas.style.borderRadius =
    `${box.topRadius} ${box.topRadius} ${box.bottomRadius} ${box.bottomRadius}`;
  // The CSS pins the layer with inset:0, and left+right+width over-constrains a
  // box - the browser drops one of them, and which one it drops is not a thing
  // to leave to the writing direction.
  canvas.style.right = 'auto';
  canvas.style.bottom = 'auto';
}

/**
 * The view the grid was last painted for - see paintGridOnView().
 *
 * A copy of seven of the viewport's fields rather than a reference to it: the
 * live object is mutated in place on every frame, so holding one would be
 * holding the present and comparing it against itself. Named off the class so
 * the copy cannot describe a shape the original does not have.
 */
let lastView:
  | Pick<Viewport, 'pan' | 'zoom' | 'cx' | 'cy' | 'left' | 'top' | 'moving'>
  | null = null;

/**
 * Paint the grid for a view change, unless the view did not move far enough to
 * change a pixel of it.
 *
 * Separate from paintGrid() rather than a flag inside it, because the guard is
 * only ever right for this one caller. Everything else that repaints - a
 * setting moving, the palette changing, a board loading, the tier fade's own
 * frame - changes what the grid should look like *without* moving the view, and
 * a shared guard would swallow exactly those.
 *
 * The test is the largest distance any painted point travels. Screen position
 * is affine in the world point, `(p - pan) * zoom`, so the extremes over the
 * visible rectangle are at its corners and four evaluations bound the whole
 * frame. Under a device pixel at both corners means every mark on screen lands
 * in the same physical row and column it was already in, and the repaint would
 * write the same picture over itself.
 *
 * What this is for is not a still board - a still board emits no view change at
 * all - but the two cases that emit a stream of them and move nothing: the tail
 * of an inertial pan as it settles below a pixel per frame, and a trackpad or
 * precision wheel delivering a zoom in fractions too small to show.
 */
export function paintGridOnView(vp: Viewport) {
  if (viewSettledForGrid(vp)) return;
  paintGrid(vp);
}

function viewSettledForGrid(vp: Viewport): boolean {
  const p = lastView;
  if (!p) return false;
  // The viewport itself moved or resized: the box the grid is drawn in has
  // changed even if the board under it has not.
  if (p.cx !== vp.cx || p.cy !== vp.cy || p.left !== vp.left || p.top !== vp.top) return false;
  // Not every input to this paint is the view's position. The origin hole is
  // dropped for the length of a gesture and put back when it ends (punchHole),
  // and the frame that puts it back is the settling one - the frame where the
  // board has, by definition, not moved since the last. Compared, not special-
  // cased, so the arriving edge is caught as well as the leaving one.
  if (p.moving !== vp.moving) return false;
  // A device pixel, not a CSS one: a CSS pixel is two or three rows of a phone's
  // screen, and half of one is a move the eye can see.
  return viewShift(p, vp, vp.visibleRect(0)) < 1 / deviceRatio();
}

export function paintGrid(vp: Viewport) {
  const el = vp.el;
  const s = board.settings;
  lastView = { pan: { x: vp.pan.x, y: vp.pan.y }, zoom: vp.zoom,
               cx: vp.cx, cy: vp.cy, left: vp.left, top: vp.top, moving: vp.moving };

  el.classList.toggle('no-axes', !axesVisible());

  paintAxes(vp);

  const canvas = ensureCanvas(el);
  const box = inkBox(vp);
  placeInk(canvas, box);

  if (!s.grid || !(box.w > 0 && box.h > 0)) {
    clearTiles(canvas);
    clearCanvas(canvas);
    return;
  }

  const { coarse, alpha } = tierFade(boardGridStep(s.gridStep, vp), vp);
  const minor = coarse * vp.zoom;
  const major = minor * MAJOR;
  const screenOrigin = vp.axisOrigin ? vp.axisOrigin() : vp.toScreen(0, 0);
  // Translate into ink layer coordinates
  const o = { x: screenOrigin.x - box.x, y: screenOrigin.y - box.y };
  // Attribute read, not getComputedStyle — this runs every frame
  const harsh = harshGrid();

  if (harsh) {
    clearTiles(canvas); // gradients and canvas are exclusive painters
    drawCrosses(canvas, box, o, minor, major, alpha);
    return;
  }

  clearCanvas(canvas);

  const images: string[] = [], sizes: string[] = [], positions: string[] = [];
  // Offsets wrapped into tile size — large background-position values lose precision
  const push = (layers: string[], size: number, px: number, py: number) => {
    const x = wrap(px, size), y = wrap(py, size);
    for (const img of layers) {
      images.push(img);
      sizes.push(`${size}px ${size}px`);
      positions.push(`${x.toFixed(1)}px ${y.toFixed(1)}px`);
    }
  };

  // The three marks between existing coarse marks. Three separate layers, not
  // a half-tile lattice, because translucent marks overlap and double up.
  const between = (layers: string[], size: number, ox: number, oy: number) => {
    const h = size / 2;
    for (const [dx, dy] of [[h, 0], [0, h], [h, h]]) push(layers, size, ox + dx, oy + dy);
  };

  // Marks not lines — lines moire at fractional zoom. Majors listed first (paint on top).
  push(dot('var(--grid-major)', 1.5), major, o.x - major / 2, o.y - major / 2);
  if (alpha > 0.002) {
    between(dot(faded('var(--grid-major)', alpha), 1.5), major, o.x - major / 2, o.y - major / 2);
  }
  push(dot('var(--grid-minor)', 1), minor, o.x - minor / 2, o.y - minor / 2);
  if (alpha > 0.002) {
    between(dot(faded('var(--grid-minor)', alpha), 1), minor, o.x - minor / 2, o.y - minor / 2);
  }

  // Drawn on #grid-ink not #viewport — a mask cuts the origin hole, and a mask
  // on #viewport would clip its children (axes, items). #grid-ink is childless.
  // Image/size strings are compared to skip redundant writes on the hot path.
  const image = images.join(', ');
  const size = sizes.join(', ');
  if (image !== lastImage) { canvas.style.backgroundImage = image; lastImage = image; }
  if (size !== lastSize) { canvas.style.backgroundSize = size; lastSize = size; }
  // Only uncacheable write — position must track the board. mobilePerfFlags can disable it for profiling.
  if (mobilePerfFlags.gridPos) canvas.style.backgroundPosition = positions.join(', ');
  punchHole(canvas, o, vp, box);
}

// Cache of last written values — clearTiles must keep these in sync or the grid never reappears
let lastImage = '', lastSize = '', lastMask = '';


function clearTiles(canvas: HTMLCanvasElement) {
  canvas.style.backgroundImage = 'none';
  canvas.style.maskImage = '';
  canvas.style.webkitMaskImage = '';
  lastImage = 'none';
  lastSize = '';
  lastMask = '';
}

// Cut the origin out of the tiled lattice. Hole size comes from --grid-dot in CSS.
// Dropped when off screen (no compositor work) or while moving (mask rewrite per
// frame kills pinch perf on phones — the dot under the origin ring is invisible anyway).
function punchHole(canvas: HTMLCanvasElement, o: { x: number; y: number }, vp: Viewport, box: InkBox) {
  const near = originHole() && !vp.moving
    && o.x > -20 && o.y > -20 && o.x < box.w + 20 && o.y < box.h + 20;
  const mask = near
    ? `radial-gradient(circle at ${o.x.toFixed(1)}px ${o.y.toFixed(1)}px,`
      + ' transparent 0 calc(var(--grid-dot) * 1.5 + 1px),'
      + ' #000 calc(var(--grid-dot) * 1.5 + 2px))'
    : '';
  // Skipped when it has not moved, which is nearly always: the origin is one
  // point on an infinite board, so on the overwhelming majority of frames this
  // is writing the same empty string over the same empty string - and a mask is
  // one of the more expensive properties to hand a browser, because changing it
  // invalidates the layer it applies to.
  if (mask === lastMask) return;
  lastMask = mask;
  canvas.style.maskImage = mask;
  canvas.style.webkitMaskImage = mask;
}

// ---------------------------------------------------------------------------
// The world axes
// ---------------------------------------------------------------------------

/**
 * How thick a world axis is, in CSS pixels.
 *
 * Stated in CSS pixels rather than device ones so the rule is the same weight on
 * every screen: two device pixels is a bold line on a laptop and an invisible
 * one on a phone at 3x.
 *
 * It does not have to be a whole number, and that is worth saying because it is
 * exactly what a <div> could not do. A canvas fill of 1.2 rows paints one row
 * solid and a fifth of the next, every frame, because that is what was asked for
 * - there is no layout rounding between the number and the pixels, so a
 * fractional weight is stable rather than something that comes and goes as the
 * board moves. On a display at 100% this reads as a hairline with a shade of
 * weight under it; at 2x and 3x it is 2.4 and 3.6 rows, which is the same line.
 */
const AXIS_PX = 1.2;

/**
 * Where the two axis lines were last drawn, how thick, and on a bitmap of what
 * size. Null on either coordinate means that axis was off screen.
 */
type AxisMemo = { x: number | null; y: number | null; t?: number; w: number; h: number };

/**
 * Where the two rules were last drawn, in device pixels, so the next frame can
 * wipe those two bands and no more.
 *
 * A full clear of a phone-sized canvas is a few million pixels memset on every
 * frame of every pan, to erase two lines. The thickness is remembered with the
 * positions because a window dragged to a screen of another density changes it,
 * and a band cleared at the wrong width leaves a stripe behind. The width and
 * height come along so that a canvas which has just been resized - and therefore
 * blanked - is not asked to clear rows out of a bitmap that no longer has them.
 */
let axisWas: AxisMemo = { x: null, y: null, t: 0, w: 0, h: 0 };

// Axes drawn on canvas, not <div>s — sub-pixel layout makes a 1-device-px div
// blink out at fractional DPR. Separate canvas from the grid because the grid's
// origin-hole mask would notch the axes where they cross.
function paintAxes(vp: Viewport) {
  const canvas = ensureAxisCanvas(vp.el);
  const ctx = sizeCanvas(canvas, { w: vp.width, h: vp.height });
  if (!ctx) return;
  const W = canvas.width, H = canvas.height;

  // Resize blanks the bitmap; null = "not drawn" (negative rows are valid positions)
  if (axisWas.w !== W || axisWas.h !== H) axisWas = { x: null, y: null, t: 0, w: W, h: H };
  // Clear to whole pixel — fractional clearRect leaves ghost stripes
  if (axisWas.y !== null) ctx.clearRect(0, Math.floor(axisWas.y), W, Math.ceil(Number(axisWas.t)) + 1);
  if (axisWas.x !== null) ctx.clearRect(Math.floor(axisWas.x), 0, Math.ceil(Number(axisWas.t)) + 1, H);
  axisWas.x = axisWas.y = null;

  if (!axesVisible()) return;

  const o = vp.axisOrigin ? vp.axisOrigin() : vp.toScreen(0, 0);
  const d = canvas._dpr;
  // Band laid symmetrically about the pixel centre — rounding the start
  // would push the rule off-centre relative to the origin mark
  const t = Math.max(1, AXIS_PX * d);
  const y = o.y * d - t / 2;
  const x = o.x * d - t / 2;
  axisWas.t = t;

  ctx.fillStyle = gridInk().axis;
  if (y + t > 0 && y < H) { ctx.fillRect(0, y, W, t); axisWas.y = y; }
  if (x + t > 0 && x < W) { ctx.fillRect(x, 0, t, H); axisWas.x = x; }
}

function makeInkCanvas(id: string): InkCanvas {
  const canvas = document.createElement('canvas') as InkCanvas;
  canvas.id = id;
  canvas.setAttribute('aria-hidden', 'true');
  return canvas;
}

function ensureAxisCanvas(el: HTMLElement): InkCanvas {
  let canvas = el.querySelector<InkCanvas>(':scope > #axis-ink');
  if (!canvas) {
    canvas = makeInkCanvas('axis-ink');
    // Insert before #world so axes sit under items
    const world = el.querySelector(':scope > #world');
    if (world) el.insertBefore(canvas, world); else el.append(canvas);
    axisWas = { x: -1, y: -1, w: 0, h: 0 };
  }
  return canvas;
}

/** A grid colour at a fraction of itself. Takes a var() as happily as a hex. */
const faded = (color: string, a: number) =>
  `color-mix(in srgb, ${color} ${(a * 100).toFixed(1)}%, transparent)`;

// ---------------------------------------------------------------------------
// Re-tiering
// ---------------------------------------------------------------------------

/** How long a lattice takes to arrive or leave. */
const TIER_MS = 100;

/**
 * Where a re-tier has got to.
 *
 *   step    the step gridStep() last asked for
 *   from    the step before it, or 0 for "nothing to come from"
 *   at      when the change happened
 */
let tier = { step: 0, from: 0, at: 0 };
let tierRaf = 0;

// Cross-fade between adjacent tiers. Returns the coarse lattice and a 0-1 alpha
// for the marks between it. Skipped during live zoom (double-paint too expensive)
// and on multi-tier jumps (no meaningful pair to fade between).
function tierFade(step: number, vp: Viewport) {
  const now = performance.now();
  if (step !== tier.step) {
    const adjacent = tier.step > 0 && (step === tier.step * 2 || step === tier.step / 2);
    tier = { step, from: adjacent && !still() && !vp.moving ? tier.step : 0, at: now };
  }
  if (!tier.from) return { coarse: step, alpha: 0 };

  const t = Math.min(1, (now - tier.at) / TIER_MS);
  const coarse = Math.max(step, tier.from);
  // Fine is always coarse/2 - the marks between - so one number says which way
  // this is going: finer than we were means they are arriving.
  const alpha = step < tier.from ? t : 1 - t;

  if (t >= 1) {
    tier = { step, from: 0, at: now };
    return { coarse: step, alpha: 0 };
  }
  // A pan repaints on its own, but a fade that outlives the gesture that
  // started it - and every fade does, since a wheel notch is over in a frame -
  // has nothing else asking for frames. One loop, dropped as soon as it lands.
  if (!tierRaf && typeof requestAnimationFrame === 'function') {
    tierRaf = requestAnimationFrame(() => { tierRaf = 0; paintGrid(vp); });
  }
  return { coarse, alpha };
}

/** The reader asked for less motion, so a lattice arrives rather than fades. */
const still = () => !!globalThis.matchMedia?.('(prefers-reduced-motion: reduce)').matches;

/**
 * The whimsy level that draws crosses. Compared as a string because that is
 * what a data attribute holds, and `data-whimsy` is always written - see the
 * note on `apply()` in ui/appearance.ts - so an absent attribute here means
 * the page has not booted yet, not "the middle".
 *
 * Exported because ui/snapshot.ts asks the same question of the same attribute
 * to decide whether the export draws crosses or dots, and was asking it with a
 * bare '2'. Three spellings of one tier - a number in ui/appearance.ts, this
 * string here, a literal there - is two too many for a value that decides what
 * a mark looks like.
 */
export const HARSH = '2';

/** Whether the board is at the tier that draws registration crosses. */
export const harshGrid = () => document.documentElement.dataset.whimsy === HARSH;

/** Both marks are sized from --grid-dot, the user's grid-weight slider. */
const scaled = (scale: number) => `calc(var(--grid-dot) * ${scale})`;

const dot = (color: string, scale: number) => {
  const r = scaled(scale);
  return [`radial-gradient(circle at center, ${color} 0, ${color} ${r}, transparent calc(${r} + 0.7px))`];
};

// Cross mark: half arm-length capped, half thickness follows the slider.
// Length is capped because past a certain size a bigger cross floods the
// board — "grid weight" means press harder, not draw a bigger cross.
const ARM_LONG = 2.1;
const ARM_LONG_MAX = 4.2;   // CSS px, before the lattice's own scale factor
const ARM_THICK = 0.5;

// ---------------------------------------------------------------------------
// The Harsh lattice
// ---------------------------------------------------------------------------

// Canvas, not CSS tiled images. CSS gradients cannot draw a bounded rectangle
// (ellipses taper), and tiled SVGs blink at fractional DPR because the rasteriser
// drops sub-pixel arms. Canvas snaps every mark to whole device pixels.
function drawCrosses(canvas: InkCanvas, box: InkBox, o: { x: number; y: number },
                     minor: number, major: number, alpha: number) {
  const ctx = sizeCanvas(canvas, box);
  if (!ctx) return;
  const dpr = canvas._dpr;
  const ink = gridInk();

  ctx.clearRect(0, 0, canvas.width, canvas.height);
  // Minor first, major over it. Fading uses globalAlpha, not weaker colours
  // (these are already low-alpha mixes — re-mixing would double-multiply).
  lattice(ctx, minor, o, dpr, canvas, ink.minor, ink.dot, 1);
  lattice(ctx, major, o, dpr, canvas, ink.major, ink.dot, 1.5);
  if (alpha > 0.002) {
    ctx.globalAlpha = alpha;
    lattice(ctx, minor, o, dpr, canvas, ink.minor, ink.dot, 1, true);
    lattice(ctx, major, o, dpr, canvas, ink.major, ink.dot, 1.5, true);
    ctx.globalAlpha = 1;
  }
}

/**
 * Whether the lattice leaves its middle mark out.
 *
 * It does whenever the origin mark is on screen, because that spot already has
 * something on it: a ring, a pip and four ticks, all of them saying "this is
 * 0,0" - and a registration cross underneath is a second, fainter mark trying
 * to say the same thing inside the first one. The mark is the statement; the
 * grid should get out of its way.
 *
 * Conditional rather than always, because "Show axes" takes the origin mark
 * with it - and with nothing there, a missing mark is just a hole in the grid.
 */
const originHole = () => axesVisible();

/**
 * One lattice of crosses, as a single filled path.
 *
 * One path and one fill() rather than a fill per mark, for two reasons. It is
 * the fast shape - a couple of thousand rectangles composited once instead of a
 * couple of thousand times - and it is the *correct* one: the grid colours are
 * a low-alpha mix of the ink, and two overlapping translucent rectangles
 * composite to twice the strength where they meet. Filling the union once is
 * what stops every crossing point reading as a bright dot with whiskers, which
 * is exactly how the two-gradient version failed.
 */
function lattice(ctx: CanvasRenderingContext2D, tileCss: number, o: { x: number; y: number },
                 dpr: number, canvas: HTMLCanvasElement, color: string, dotPx: number,
                 scale: number, between = false) {
  // `between` halves the tile and skips every mark the full-strength pass has
  // already drawn, which is the pair of even indices. Same reason the gradient
  // painter lists three offset layers instead of one denser lattice: these
  // colours are translucent and a mark drawn twice is twice as dark.
  const tile = tileCss * dpr / (between ? 2 : 1);
  if (!(tile > 3)) return;         // gridStep() should never allow this

  // Snapped to whole device pixels, and never thinner than one. An arm under a
  // device pixel is not a fainter cross, it is a cross the rasteriser is
  // entitled to drop - which is the blinking this rewrite exists to end. The
  // strength slider is the control for "fainter".
  const arm = Math.max(1, Math.round(Math.min(dotPx * ARM_LONG * scale, ARM_LONG_MAX * scale) * dpr));
  const thick = Math.max(1, Math.round(dotPx * ARM_THICK * 2 * scale * dpr));
  const half = Math.floor(thick / 2);
  // Odd-width bar centres half a pixel past cx — without this bias the
  // lattice sits half a device pixel down-right of the axes.
  const bias = half - thick / 2;
  // Arms take the bar's parity so the two strokes actually intersect at centre.
  const span = arm * 2 + (thick % 2);

  const W = canvas.width, H = canvas.height;
  const path = new Path2D();

  // Index from origin, not accumulated — carries the parity `between` needs
  // and avoids the rounding drift a repeated += tile compounds at the far edge.
  const ox = o.x * dpr, oy = o.y * dpr;
  const i0 = Math.ceil((-arm - ox) / tile), i1 = Math.floor((W + arm - ox) / tile);
  const j0 = Math.ceil((-arm - oy) / tile), j1 = Math.floor((H + arm - oy) / tile);

  const hole = originHole();

  // Column x positions precomputed — a mark's x is row-independent, so the
  // inner loop was re-rounding the same values thousands of times per frame.
  const cols = new Int32Array(Math.max(0, i1 - i0 + 1));
  for (let i = i0; i <= i1; i++) cols[i - i0] = Math.round(ox + i * tile + bias);

  for (let j = j0; j <= j1; j++) {
    const cy = Math.round(oy + j * tile + bias);
    const rowEven = !(j & 1);
    for (let i = i0; i <= i1; i++) {
      if (between && rowEven && !(i & 1)) continue;
      // Indexed from the origin, so the middle of the board is simply 0,0.
      if (hole && i === 0 && j === 0) continue;
      const cx = cols[i - i0];
      path.rect(cx - arm, cy - half, span, thick);
      path.rect(cx - half, cy - arm, thick, span);
    }
  }

  ctx.fillStyle = color;
  ctx.fill(path);
}

/** Get or create the grid canvas. Fallback for tests that mount #viewport without the full page. */
function ensureCanvas(el: HTMLElement): InkCanvas {
  let canvas = el.querySelector<InkCanvas>(':scope > #grid-ink');
  if (!canvas) {
    canvas = makeInkCanvas('grid-ink');
    el.prepend(canvas);
    // Fresh canvas has none of the cached state — invalidate so the first
    // paint does not skip its writes.
    lastImage = lastSize = lastMask = lastBox = '';
  }
  return canvas;
}

/** Size the backing store to a CSS-pixel box in device pixels.
 *  Only on real change — assigning width/height clears the canvas even when identical. */
function sizeCanvas(canvas: InkCanvas, { w, h }: { w: number; h: number }): CanvasRenderingContext2D | null {
  // Must match deviceRatio() — two different roundings caused lattice/axis disagreement.
  const dpr = deviceRatio();
  const px = Math.round(w * dpr);
  const py = Math.round(h * dpr);
  if (!(px > 0 && py > 0)) return null;
  if (canvas.width !== px || canvas.height !== py) {
    canvas.width = px;
    canvas.height = py;
  }
  canvas._dpr = dpr;
  return canvas.getContext('2d');
}

function clearCanvas(canvas: HTMLCanvasElement) {
  if (!canvas.width || !canvas.height) return;
  // A canvas this module made and has only ever drawn 2d into - see sizeCanvas().
  canvas.getContext('2d')!.clearRect(0, 0, canvas.width, canvas.height);
}

/** Resolved grid colours and dot size. Read once from getComputedStyle, held
 *  until resetGridInk() — called on every look change including slider drags. */
let ink: { major: string; minor: string; axis: string; dot: number } | null = null;

function gridInk() {
  if (ink) return ink;
  const s = getComputedStyle(document.documentElement);
  const dot = parseFloat(s.getPropertyValue('--grid-dot'));
  ink = {
    major: s.getPropertyValue('--grid-major').trim() || 'currentColor',
    minor: s.getPropertyValue('--grid-minor').trim() || 'currentColor',
    // Axes are drawn, not styled — their colour must be resolved with the rest.
    axis: s.getPropertyValue('--grid-axis').trim() || 'currentColor',
    dot: Number.isFinite(dot) ? dot : 1.5,
  };
  return ink;
}

/** Forget the resolved colours - the look changed. */
export function resetGridInk() {
  ink = null;
}
