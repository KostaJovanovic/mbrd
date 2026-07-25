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

const MIN_PX = 26;    // on-screen spacing below which we step up to a coarser grid
const MAX_PX = 104;   // ...and above which we step down to a finer one
const MAJOR = 4;      // major line every N minor steps

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
    el.style.backgroundImage = 'none';
    clearCanvas(canvas);
    return;
  }

  const step = gridStep(s.gridStep, vp.zoom);
  const minor = step * vp.zoom;
  const major = minor * MAJOR;
  const o = vp.toScreen(0, 0);
  // An attribute read, not getComputedStyle. This function runs on every frame
  // of every pan and pinch, and asking for a computed value in here would force
  // a synchronous style flush per frame for a value that changes about once an
  // afternoon. ui/appearance.js announces the change instead, so the attribute
  // is always current by the time we look at it.
  const harsh = document.documentElement.dataset.whimsy === HARSH;

  if (harsh) {
    // The two painters are exclusive. Leaving the gradients up under the canvas
    // would show a dot inside every cross.
    el.style.backgroundImage = 'none';
    drawCrosses(canvas, vp, o, minor, major);
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

  // Marks, never ruled lines. Lines were an option here and were the wrong one
  // on an infinite board: at any fractional zoom a full-bleed line grid beats
  // against the pixel grid into moire, and it competes with the world axes for
  // the same reading. A mark at each intersection states the same lattice and
  // stays quiet.
  // First layer paints on top, so majors are listed before minors.
  push(dot('var(--grid-major)', 1.5), major, o.x - major / 2, o.y - major / 2);
  push(dot('var(--grid-minor)', 1), minor, o.x - minor / 2, o.y - minor / 2);

  el.style.backgroundImage = images.join(', ');
  el.style.backgroundSize = sizes.join(', ');
  el.style.backgroundPosition = positions.join(', ');
}

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
function drawCrosses(canvas, vp, o, minor, major) {
  const ctx = sizeCanvas(canvas, vp);
  if (!ctx) return;
  const dpr = canvas._dpr;
  const ink = gridInk();

  ctx.clearRect(0, 0, canvas.width, canvas.height);
  // Minor first, then major over it: the heavier mark wins where they coincide,
  // which is every major intersection.
  lattice(ctx, minor, o, dpr, canvas, ink.minor, ink.dot, 1);
  lattice(ctx, major, o, dpr, canvas, ink.major, ink.dot, 1.5);
}

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
function lattice(ctx, tileCss, o, dpr, canvas, color, dotPx, scale) {
  const tile = tileCss * dpr;
  if (!(tile > 3)) return;         // gridStep() should never allow this

  // Snapped to whole device pixels, and never thinner than one. An arm under a
  // device pixel is not a fainter cross, it is a cross the rasteriser is
  // entitled to drop - which is the blinking this rewrite exists to end. The
  // strength slider is the control for "fainter".
  const arm = Math.max(1, Math.round(Math.min(dotPx * ARM_LONG * scale, ARM_LONG_MAX * scale) * dpr));
  const thick = Math.max(1, Math.round(dotPx * ARM_THICK * 2 * scale * dpr));
  const half = Math.floor(thick / 2);

  const W = canvas.width, H = canvas.height;
  const path = new Path2D();

  // Positions accumulate in floats and are rounded per mark, so the lattice
  // keeps its exact spacing over the whole screen instead of drifting by the
  // rounding error a stepped integer would compound.
  let x0 = (o.x * dpr) % tile;
  if (x0 > 0) x0 -= tile;
  let y0 = (o.y * dpr) % tile;
  if (y0 > 0) y0 -= tile;

  for (let y = y0; y < H + arm; y += tile) {
    const cy = Math.round(y);
    for (let x = x0; x < W + arm; x += tile) {
      const cx = Math.round(x);
      path.rect(cx - arm, cy - half, arm * 2, thick);
      path.rect(cx - half, cy - arm, thick, arm * 2);
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
  const dpr = Math.max(1, Math.min(3, window.devicePixelRatio || 1));
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
