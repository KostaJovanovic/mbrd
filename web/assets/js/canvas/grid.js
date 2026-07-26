// Background grid. Purely visual: it never participates in hit-testing and no
// item is ever snapped to it unless the snap setting is on.
//
// The grid is painted in screen space on #viewport, not inside the transformed
// #world - so marks stay crisp at any zoom instead of being scaled up into fat
// blurry blobs. The world origin is tracked through the mark positions, and the
// spacing is quantised in powers of two so it never degenerates into a solid
// fill when you zoom out.
//
// Two tiers draw it two ways, and the split is not an accident:
//
//   Softish, Middle   layered CSS radial gradients. A dot is a circle, a
//                     gradient is a circle, and a gradient carrying var()
//                     restyles itself when a slider moves with no repaint at
//                     all. Panning is one background-position write.
//   Harsh             a <canvas>. See drawCrosses() for why nothing else works.

import { board } from '../state.js';
import { deviceRatio } from './viewport.js';

// The on-screen window a minor step is allowed to live in. Outside it the
// world-space step doubles or halves and the lattice re-tiers.
//
// Both numbers were raised by half - 26..104 became 40..160 - and the ratio of
// four between them is kept, because it is MAJOR: at the tight end of the
// window a minor lattice is exactly as dense as a major one at the loose end,
// so the board never gets tighter than the tier below it has already been.
//
// Raising them moves *when* the change happens in the useful direction at both
// ends. Zooming out, the step-up comes sooner, so the marks never crowd down to
// 26px before the lattice thins out; zooming in, the halving comes later, so a
// fresh crop of marks is not introduced the moment there is room for it. Both
// were the same complaint: it went dense right at the tier boundary.
// Exported so the test that guards the band asserts against the band itself
// rather than against a copy of two numbers that has to be edited twice.
export const MIN_PX = 40;    // spacing below which we step up to a coarser grid
export const MAX_PX = 160;   // ...and above which we step down to a finer one
const MAJOR = 4;             // major line every N minor steps

/** World-space grid step whose on-screen spacing lands inside [MIN_PX, MAX_PX]. */
export function gridStep(base, zoom) {
  let step = base > 0 ? base : 64;
  let guard = 0;
  while (step * zoom < MIN_PX && guard++ < 64) step *= 2;
  while (step * zoom > MAX_PX && guard++ < 64) step /= 2;
  return step;
}

export function paintGrid(vp) {
  const el = vp.el;
  const s = board.settings;

  el.classList.toggle('no-axes', !s.axes);

  const canvas = ensureCanvas(el);

  if (!s.grid) {
    clearTiles(canvas);
    clearCanvas(canvas);
    return;
  }

  // What is drawn is always a *coarse* lattice at full strength plus the marks
  // that sit between its own, at whatever the fade has reached - see tierFade().
  // Outside a fade the two collapse to one: alpha is 0 or 1 and the pair is
  // exactly the lattice gridStep() asked for.
  const { coarse, alpha } = tierFade(gridStep(s.gridStep, vp.zoom), vp);
  const minor = coarse * vp.zoom;
  const major = minor * MAJOR;
  // The origin the axis rules use, not the raw one - see Viewport.axisOrigin().
  // The fallback is for the render harnesses, which pass a viewport stub.
  const o = vp.axisOrigin ? vp.axisOrigin() : vp.toScreen(0, 0);
  // An attribute read, not getComputedStyle. This function runs on every frame
  // of every pan and pinch, and asking for a computed value in here would force
  // a synchronous style flush per frame for a value that changes about once an
  // afternoon. ui/appearance.js announces the change instead, so the attribute
  // is always current by the time we look at it.
  const harsh = document.documentElement.dataset.whimsy === HARSH;

  if (harsh) {
    // The two painters are exclusive. Leaving the gradients up under the canvas
    // would show a dot inside every cross.
    clearTiles(canvas);
    drawCrosses(canvas, vp, o, minor, major, alpha);
    return;
  }

  clearCanvas(canvas);

  const images = [], sizes = [], positions = [];
  // A mark is a list of image layers rather than one, because the dot's major
  // and minor lattices each want their own. Every layer of a mark shares its
  // lattice's tile and origin, so they are pushed together.
  const push = (layers, size, px, py) => {
    for (const img of layers) {
      images.push(img);
      sizes.push(`${size}px ${size}px`);
      positions.push(`${px.toFixed(1)}px ${py.toFixed(1)}px`);
    }
  };

  /**
   * The three marks a finer lattice adds inside each of this one's tiles.
   *
   * Three layers rather than one lattice at half the tile, and that is the
   * whole reason this is not two lines of code: a half-tile lattice includes
   * the coarse positions, and these colours are translucent - a mark painted
   * twice is twice as dark. Every marked point has to be drawn exactly once,
   * so the ones that already exist are stepped over by construction.
   */
  const between = (layers, size, ox, oy) => {
    const h = size / 2;
    for (const [dx, dy] of [[h, 0], [0, h], [h, h]]) push(layers, size, ox + dx, oy + dy);
  };

  // Marks, never ruled lines. Lines were an option here and were the wrong one
  // on an infinite board: at any fractional zoom a full-bleed line grid beats
  // against the pixel grid into moire, and it competes with the world axes for
  // the same reading. A mark at each intersection states the same lattice and
  // stays quiet.
  // First layer paints on top, so majors are listed before minors, and each
  // lattice before the fainter one arriving underneath it.
  push(dot('var(--grid-major)', 1.5), major, o.x - major / 2, o.y - major / 2);
  if (alpha > 0.002) {
    between(dot(faded('var(--grid-major)', alpha), 1.5), major, o.x - major / 2, o.y - major / 2);
  }
  push(dot('var(--grid-minor)', 1), minor, o.x - minor / 2, o.y - minor / 2);
  if (alpha > 0.002) {
    between(dot(faded('var(--grid-minor)', alpha), 1), minor, o.x - minor / 2, o.y - minor / 2);
  }

  // On #grid-ink, not on #viewport, and that is a deliberate move rather than
  // tidiness. The middle of the board needs the mark at the origin taken out -
  // the origin mark is already standing there - and a tiled background cannot
  // skip one of its own tiles. A mask can cut a hole in one, but a mask applies
  // to an element's children as well, and #viewport's children are the axes,
  // the origin mark and every item on the board. #grid-ink has none: it is the
  // full-bleed layer the plain tier already draws its crosses on, empty at this
  // tier, aria-hidden and childless. So the tiles move down onto it and the
  // hole is cut there, where there is nothing else to cut.
  // Only the position actually changes on a pan.
  //
  // The layers are built from `var()` colours and a calc() off --grid-dot, so
  // the image list is the same string on every frame unless the tier fade is
  // running; the size list is the same string unless the zoom moved. Assigning
  // them anyway is not free - eight radial gradients have to be parsed and
  // compared against what is already there before the browser can conclude
  // nothing happened - and this runs on every frame of every pan on a board
  // that may have a few hundred cards competing for the same frame.
  //
  // Compared as strings rather than tracked with flags, because the inputs are
  // several (zoom, the fade, the weight slider, the palette) and a flag per
  // input is a flag somebody forgets to set. The string is the answer itself.
  const image = images.join(', ');
  const size = sizes.join(', ');
  if (image !== lastImage) { canvas.style.backgroundImage = image; lastImage = image; }
  if (size !== lastSize) { canvas.style.backgroundSize = size; lastSize = size; }
  canvas.style.backgroundPosition = positions.join(', ');
  punchHole(canvas, o, vp);
}

/**
 * What was last written to the tiled layer.
 *
 * Only so the writes above can be skipped when nothing moved - see paintGrid().
 * Every path that writes these properties has to keep them honest, which is why
 * clearTiles() below sets them rather than merely clearing the element: a cache
 * that says "already none" while the element says otherwise is a grid that
 * never comes back.
 */
let lastImage = '', lastSize = '', lastMask = '';

/** Take the tiled marks - and any hole in them - back off. */
function clearTiles(canvas) {
  canvas.style.backgroundImage = 'none';
  canvas.style.maskImage = '';
  canvas.style.webkitMaskImage = '';
  lastImage = 'none';
  lastSize = '';
  lastMask = '';
}

/**
 * Cut the origin out of the tiled lattice.
 *
 * Sized in CSS rather than here: the layer inherits --grid-dot from :root, so
 * the hole is a function of the weight slider and needs no repaint of its own
 * when that slider moves. Big enough for the major mark, which is the largest
 * thing that can be sitting there.
 *
 * Dropped entirely whenever the origin is off screen, which is most of the time
 * on a board anybody has panned. A full-screen mask is real compositor work and
 * this one is doing nothing at all out there.
 */
function punchHole(canvas, o, vp) {
  const near = originHole()
    && o.x > -20 && o.y > -20 && o.x < vp.width + 20 && o.y < vp.height + 20;
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

/** A grid colour at a fraction of itself. Takes a var() as happily as a hex. */
const faded = (color, a) =>
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

/**
 * Turn "the step is now X" into "draw this lattice solid and this one at a".
 *
 * A re-tier is a doubling or a halving, so the two lattices either side of one
 * are always a coarse one and the same coarse one with a mark added between
 * each pair. That is the only shape this needs to express, and it is the same
 * shape in both directions:
 *
 *   zooming out  the coarse lattice is the new one; the marks between it are
 *                the ones being dropped, and they go 1 -> 0
 *   zooming in   the coarse lattice is the old one; the marks between it are
 *                the ones arriving, and they go 0 -> 1
 *
 * So the caller never has to know which way the zoom went, and at either end of
 * the animation what it draws is exactly one lattice at full strength.
 *
 * A jump of more than one tier - a fit, a board load, the zoom readout being
 * clicked back to 100% - is not faded. There is no pair of lattices to cross
 * between when the step changes by eight, and half a second of a grid dissolving
 * would be a strange thing to have asked for by pressing "zoom to fit".
 */
function tierFade(step, vp) {
  const now = performance.now();
  if (step !== tier.step) {
    const adjacent = tier.step > 0 && (step === tier.step * 2 || step === tier.step / 2);
    // A second change mid-fade abandons the first rather than queueing behind
    // it. Pinching through three tiers should land on the third, not play two
    // animations of somewhere it no longer is.
    tier = { step, from: adjacent && !still() ? tier.step : 0, at: now };
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
 * note on `apply()` in ui/appearance.js - so an absent attribute here means
 * the page has not booted yet, not "the middle".
 */
const HARSH = '2';

/** Both marks are sized from --grid-dot, the user's grid-weight slider. */
const scaled = scale => `calc(var(--grid-dot) * ${scale})`;

const dot = (color, scale) => {
  const r = scaled(scale);
  return [`radial-gradient(circle at center, ${color} 0, ${color} ${r}, transparent calc(${r} + 0.7px))`];
};

// The cross, in multiples of --grid-dot: half an arm's length, and half its
// thickness.
//
// The length is capped, and the cap is the whole point. A dot's extent is
// --grid-dot itself, so at the weight slider's maximum of 4px it is 8px across
// and the lattice stays a lattice. A cross built by the same rule is not: it
// spans twice its half-length, so scaling the length with the slider made the
// mark 2.7x the dot's width at the same setting, and on the minor lattice's
// tightest tile - gridStep() will let it down to 26px - a mark that wide leaves
// a few pixels of gap and the whole board floods with the grid's own colour.
// Past a certain size a bigger mark is not a heavier grid, it is a fill.
//
// So thickness follows the slider and length stops. That is also the more
// honest reading of "grid weight": turning it up should press harder, not draw
// a bigger cross.
//
// Both lengths were cut by 30% after looking at a real board: the mark reads as
// a registration cross rather than a plus sign at this size, and the lattice
// stops competing with the items sitting on it. Thickness is deliberately not
// part of that cut - it is what the weight slider drives, and shrinking it here
// would quietly rescale the whole slider.
const ARM_LONG = 2.1;
const ARM_LONG_MAX = 4.2;   // CSS px, before the lattice's own scale factor
const ARM_THICK = 0.5;

// ---------------------------------------------------------------------------
// The Harsh lattice
// ---------------------------------------------------------------------------

/**
 * Why this is a canvas and not a background image.
 *
 * The mark at this tier is a registration cross - the drawing-office reference
 * the whole tier is quoting - and it has been attempted twice before as
 * something CSS could tile.
 *
 * First as two elliptical gradients, an arm and its transpose. No gradient can
 * bound a rectangle on both axes: a linear one is unbounded on the second axis
 * and rules lines through every tile, and a radial one with two radii *is* an
 * ellipse. An ellipse 10px long and 1.7px thick keeps barely 40% of its
 * thickness at 90% of its length, so both arms tapered to points and the mark
 * read as a smudge with a bright middle.
 *
 * Then as one SVG polygon in a data URI, tiled by background-size. That drew
 * the right shape and brought two problems that are really the same problem.
 * The tile has to be baked into the image, so every zoom step minted a new URL
 * for the browser to decode and rasterise - 90 distinct images across 91 frames
 * of one gesture, measured. Quantising the baked tile fixed the churn and
 * *caused a worse bug*: with the SVG canvas rounded and background-size exact,
 * the image is scaled by a hair, the arms land on fractional device pixels, and
 * the rasteriser drops them. The crosses blinked in and out while resizing.
 *
 * Both failures come from one root: a tiled image cannot know where the device
 * pixel grid is. A canvas can. Every mark below is snapped to whole device
 * pixels and every arm is at least one of them wide, so a cross is either drawn
 * properly or not at all - it can never be a fraction of a pixel the rasteriser
 * is free to round away. Nothing is decoded, so there is no churn to cache, and
 * the colours are read at paint time instead of being baked into a URI.
 *
 * The cost is that panning now redraws rather than moving a background-position.
 * One Path2D and one fill() per lattice, measured at well under a frame - and
 * only this tier pays it. The other two never enter this function.
 */
function drawCrosses(canvas, vp, o, minor, major, alpha) {
  const ctx = sizeCanvas(canvas, vp);
  if (!ctx) return;
  const dpr = canvas._dpr;
  const ink = gridInk();

  ctx.clearRect(0, 0, canvas.width, canvas.height);
  // Minor first, then major over it: the heavier mark wins where they coincide,
  // which is every major intersection.
  //
  // The half-strength passes are the lattice arriving or leaving, and they are
  // faded with globalAlpha rather than with a weaker colour: these colours are
  // already a low-alpha mix of the ink, and re-mixing a mix in a string is how
  // you end up multiplying two alphas and wondering where the marks went.
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
const originHole = () => !!board.settings.axes;

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
function lattice(ctx, tileCss, o, dpr, canvas, color, dotPx, scale, between = false) {
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
  // A bar `thick` wide drawn from `cx - half` has its middle at
  // `cx - half + thick/2`, which is half a pixel past cx whenever thick is odd
  // - and thick is 1 at every ordinary weight and resolution. So the integer
  // the mark is drawn from is not the point it marks, and asking for the point
  // means asking for the integer half a pixel before it. Without this the whole
  // lattice sits half a device pixel down and to the right of the axes.
  const bias = half - thick / 2;
  // An odd bar cannot be centred on an even span, so the arms take the parity
  // of the bar they cross. One pixel of length, in exchange for a cross whose
  // two strokes actually intersect at their middles.
  const span = arm * 2 + (thick % 2);

  const W = canvas.width, H = canvas.height;
  const path = new Path2D();

  // Indexed from the origin rather than accumulated across the screen. The
  // index is what carries the parity `between` needs - i and j are counted from
  // the mark at 0,0, so "even in both" is the coarse lattice wherever the board
  // has been panned to - and computing each position outright also drops the
  // rounding drift a repeated `+= tile` compounds towards the far edge.
  const ox = o.x * dpr, oy = o.y * dpr;
  const i0 = Math.ceil((-arm - ox) / tile), i1 = Math.floor((W + arm - ox) / tile);
  const j0 = Math.ceil((-arm - oy) / tile), j1 = Math.floor((H + arm - oy) / tile);

  const hole = originHole();

  // The column positions, worked out once for the whole lattice rather than
  // once per mark. A mark's x does not depend on which row it is in, so the
  // inner loop below was rounding the same handful of numbers over and over -
  // on a wide screen at a tight tile that is a few thousand roundings a frame
  // to arrive at the sixty-odd values in here.
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

/**
 * The canvas layer, made if it is not there.
 *
 * index.html carries it like the axes and the origin mark, since it is one of
 * the viewport's permanent layers rather than something a gesture puts up. The
 * fallback is for the tests and the render harnesses, which mount a #viewport
 * without the rest of the page around it.
 */
function ensureCanvas(el) {
  let canvas = el.querySelector(':scope > #grid-ink');
  if (!canvas) {
    canvas = document.createElement('canvas');
    canvas.id = 'grid-ink';
    canvas.setAttribute('aria-hidden', 'true');
    el.prepend(canvas);
    // A new element carries none of the styles the last one was written, so
    // what paintGrid() remembers writing is now a memory of a different node.
    // Left alone, the first paint onto a fresh canvas would skip the very
    // writes that put the lattice there.
    lastImage = lastSize = lastMask = '';
  }
  return canvas;
}

/**
 * Match the backing store to the viewport in device pixels.
 *
 * Only on a real change: assigning width or height clears the canvas even when
 * the value is identical, so doing it unconditionally would blank the lattice
 * every frame and draw it again - which looks exactly like the flicker this is
 * replacing.
 */
function sizeCanvas(canvas, vp) {
  // The same ratio the axis rules snap to, from the same place - see
  // deviceRatio(). Two roundings of two different numbers is how the lattice
  // and the axes came to disagree in the first place.
  const dpr = deviceRatio();
  const w = Math.round(vp.width * dpr);
  const h = Math.round(vp.height * dpr);
  if (!(w > 0 && h > 0)) return null;
  if (canvas.width !== w || canvas.height !== h) {
    canvas.width = w;
    canvas.height = h;
  }
  canvas._dpr = dpr;
  return canvas.getContext('2d');
}

function clearCanvas(canvas) {
  if (!canvas.width || !canvas.height) return;
  canvas.getContext('2d').clearRect(0, 0, canvas.width, canvas.height);
}

/**
 * The grid's resolved colours and dot size.
 *
 * getComputedStyle is exactly what the note in paintGrid() forbids per frame,
 * so this is read once and held. resetGridInk() below is how it is given back,
 * and ui/appearance.js calls it on every change to a look - which includes each
 * drag of the strength and weight sliders, since a canvas cannot follow those
 * on its own the way a gradient carrying var() can.
 */
let ink = null;

function gridInk() {
  if (ink) return ink;
  const s = getComputedStyle(document.documentElement);
  const dot = parseFloat(s.getPropertyValue('--grid-dot'));
  ink = {
    major: s.getPropertyValue('--grid-major').trim() || 'currentColor',
    minor: s.getPropertyValue('--grid-minor').trim() || 'currentColor',
    dot: Number.isFinite(dot) ? dot : 1.5,
  };
  return ink;
}

/** Forget the resolved colours - the look changed. */
export function resetGridInk() {
  ink = null;
}
