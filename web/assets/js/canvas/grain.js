// The tooth of the stock, moved with the board.
//
// The tile itself is described where it is styled, at the #grain rule in
// base.css. This file is only about where it sits, and that is one decision:
// the paper travels on a pan and does not scale on a zoom.
//
// Travelling is what makes it paper. Locked to the glass, a grain layer is a
// filter over the window - you slide a board four screens sideways and the
// same fleck stays under the same pixel, which reads as dirt on the lens
// rather than as a surface the board is lying on. Anchored to the world origin
// it behaves the way the sheet under a real pinboard does: the marks belong to
// the paper, and moving the paper moves them.
//
// The tile scales with the zoom for the same reason, taken to its conclusion:
// if the flecks belong to the paper then they are a fixed size *on the paper*,
// and zooming in on a sheet shows you a bigger fleck. A grain that travelled
// but did not scale was the half-measure - it made the sheet slide under the
// board like a second surface with its own idea of how big things are.
//
// Two costs come with it, and both are real.
//
// The first is that a zoom is now a re-raster rather than a re-position: the
// browser resamples a 512px tile to whatever the zoom asks for, full-screen,
// on every frame of a pinch. A pan is still one background-position write, and
// that is the common gesture, but a pinch on this layer is no longer free.
//
// The second is moire, and it is the thing the note above the body rule in
// base.css refuses for hatching. A scaling grain sweeps its own spatial
// frequency through the dot grid's on the way out, so somewhere in the zoom
// range the two beat. What keeps it survivable is that the grain is isotropic
// noise rather than a lattice - noise has no single period to beat against, so
// what would be a hard interference pattern with ruled lines comes out as a
// broad swim instead. It is still worth looking at a zoom-out over a Harsh
// board, which is where the grid's marks are the most regular.
//
// So: both position and size from the board. The size write is the new one.

import { deviceRatio } from './viewport.js';
import { sheetBox } from './mobile-frame.js';

/**
 * The tile's side in *world* units - its on-screen size at 100%.
 *
 * base.css carries the same number as #grain's background-size, which is what
 * the layer wears until the first paint here replaces it. The two only have to
 * agree to the extent that a boot with script broken should not look wrong.
 */
const TILE = 512;

/** Positive remainder. `-3 % 512` is -3 in JavaScript, and a tile has no -3. */
const wrap = (n, tile) => ((n % tile) + tile) % tile;

/**
 * Where the stock stops being stock.
 *
 * Zoomed out, a grain that scales runs out of room: by 30% the tile is 154px
 * and each fleck is a third of a pixel, so what was paper texture becomes a
 * uniform grey film over the board - the mean darkening with none of the
 * detail that justified it, and the frequency where it has the most to say to
 * the dot grid. Rather than let it degrade into a tint, it is taken off.
 *
 * A band rather than a threshold, because a texture that vanished between one
 * wheel notch and the next would read as a bug. Full strength at 40% and above,
 * gone at 30% and below, linear across the twenty-odd percent of zoom in
 * between - which at the 1.3 step of the corner buttons is about one notch, and
 * under a pinch is continuous.
 *
 * Only downward. There is no ceiling: zoomed in, a big fleck is what looking
 * closely at paper does.
 */
// Exported so the test that guards the band asserts against the band itself
// rather than against a copy of two numbers that has to be edited twice - the
// same bargain gridStep()'s MIN_PX and MAX_PX make next door.
export const FADE_FULL = 0.40;
export const FADE_GONE = 0.30;

export const fadeFor = zoom =>
  zoom >= FADE_FULL ? 1
    : zoom <= FADE_GONE ? 0
      : (zoom - FADE_GONE) / (FADE_FULL - FADE_GONE);

/**
 * What was last written, and to which surface.
 *
 * The surface changes when the board changes layout, and the caches have to go
 * with it: a position remembered against the full-bleed layer says nothing
 * about what the Mobile sheet is currently wearing, and believing it would
 * leave the new surface at whatever the old one happened to be.
 */
let lastEl = null, lastPos = '', lastSize = '', lastFade = '';

/**
 * The layer, resolved once.
 *
 * index.html carries it, like the grid's canvas and the axes: it is one of the
 * page's permanent layers rather than something a gesture puts up. Absent - the
 * render harnesses mount a bare #viewport - every function here is a no-op.
 */
let el = null, sheetEl = null;

/**
 * Whether there is any grain to move.
 *
 * --grain is 0 at the plain end of the whimsy axis, and a look may set it
 * anywhere. At 0 the layer is fully transparent, and writing a background
 * position onto a transparent full-screen layer is a re-raster of the whole
 * window to show nothing - so the answer is resolved once and held, exactly as
 * grid.js holds its resolved ink, and given back by resetGrain() when a look
 * changes.
 *
 * The token and not the resolved opacity, which is the tempting read and is
 * wrong here: the resolved opacity now carries the zoom fade this file writes
 * itself, so caching it would latch the layer off the first time anybody zoomed
 * past 30% and only a look change would ever bring it back. This asks what the
 * board wants; fadeFor() asks what the zoom allows; they are different
 * questions and only the first one is worth caching.
 */
let inked = null;

function hasGrain() {
  // Either surface answers: --grain is a token on :root and both inherit it.
  const from = el || sheetEl;
  const v = inked ?? (inked = parseFloat(getComputedStyle(from).getPropertyValue('--grain')));
  // An unreadable token paints rather than hides: a missing dial should not be
  // the thing that silently takes the stock off the board.
  return Number.isFinite(v) ? v > 0.001 : true;
}

/** Forget the resolved strength - the look changed. */
export function resetGrain() {
  inked = null;
}

/**
 * Put the sheet where the board is, at the size the board is.
 *
 * The anchor is the world origin in screen space, which is the one point every
 * other screen-space painter here measures from, and it moves by exactly the
 * distance the board moved. Reduced modulo the tile because a tiled background
 * repeats: the phase is all that shows, and carrying the raw offset would hand
 * the browser numbers in the millions on a board somebody has travelled across.
 * The modulus is the *scaled* tile, so the phase stays correct as it grows.
 *
 * Rounded to a device pixel, and that is the guard rather than a distance test
 * like the grid's. The grid has to ask whether any of its marks moved far
 * enough to land in a different row; the grain is one rigid layer, so the
 * question is only whether its offset rounds to the same pair of numbers - and
 * if it does, the write would re-raster the window to paint the picture that is
 * already there. This is what makes the settling tail of an inertial pan, and a
 * trackpad zoom arriving in fractions, cost nothing here.
 */
export function paintGrain(vp) {
  const tile = TILE * vp.zoom;
  if (!(tile > 0)) return;

  // Whichever surface is this layout's paper. On Mobile that is the sheet, and
  // the full-bleed layer is display:none - see the rules in the CSS.
  const mobile = !!vp.isMobile;
  const surface = mobile ? sheetEl : el;
  if (!surface) return;
  if (surface !== lastEl) {
    lastEl = surface;
    lastPos = lastSize = lastFade = '';
  }
  if (!hasGrain()) return;

  // The fade first, and unconditionally: it is the one write that still has to
  // happen on the frame the grain goes away, and the early return below depends
  // on it having happened.
  const fade = fadeFor(vp.zoom);
  const f = fade.toFixed(3);
  if (f !== lastFade) {
    lastFade = f;
    surface.style.setProperty('--grain-fade', f);
  }
  // Faded out, so there is nothing to place. Skipping this is the point of the
  // band as much as the look is: below 30% the tile is at its smallest and a
  // resample of it is at its most expensive, which is exactly where a board is
  // most likely to be showing every card it has.
  if (fade === 0) return;

  const d = deviceRatio();
  const q = n => Math.round(n * d) / d;

  // Size first: the position below is a phase within the tile, so writing a new
  // phase against the old size would put the sheet in the wrong place for one
  // frame of every zoom.
  const size = `${q(tile)}px ${q(tile)}px`;
  if (size !== lastSize) {
    lastSize = size;
    surface.style.setProperty('--grain-tile', size);
  }

  // The anchor is the world origin either way. What differs is what the
  // background is measured from: the full-bleed layer starts at the corner of
  // the window, and the sheet starts at its own box - which is the board
  // *clipped to the window*, so its top is 0 for the whole middle of a scroll
  // while the board's own top is far above. Subtracting the box is what keeps
  // the grain on the paper rather than on the glass.
  const o = vp.toScreen(0, 0);
  let ox = o.x, oy = o.y;
  if (mobile && vp.mobileScreenRect) {
    const box = sheetBox(vp.mobileScreenRect(), vp.width, vp.height);
    ox -= box.x;
    oy -= box.y;
  }
  const pos = `${q(wrap(ox, tile))}px ${q(wrap(oy, tile))}px`;
  if (pos !== lastPos) {
    lastPos = pos;
    surface.style.setProperty('--grain-pos', pos);
  }
}

/**
 * Resolve the two surfaces and place the stock once.
 *
 * Deliberately does *not* subscribe to the view. Not because a subscription
 * would be wrong - it is what a self-contained subsystem here normally does -
 * but because this module registers well before main.js does, so its handler
 * would run ahead of the profiler's first timestamp and the one full-screen
 * re-raster on the pan path would be invisible to mbrd.perf. main.js calls
 * paintGrain() from inside the listener it already measures.
 *
 * Not folded into paintGrid() either: the grain is not the grid. It does not
 * re-tier, reads no setting and has no hole in it, and the only thing the two
 * share is an origin.
 */
export function initGrain(vp) {
  el = document.getElementById('grain');
  sheetEl = document.getElementById('mobile-board-frame');
  if (!el && !sheetEl) return;
  paintGrain(vp);
}
