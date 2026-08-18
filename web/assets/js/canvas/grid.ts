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

import { board } from '../state.ts';
import { deviceRatio, onTouch, mobilePerfFlags } from './viewport.ts';
import type { Viewport } from './viewport.ts';
import { MM_PER_INCH, PX_PER_INCH } from '../measure.ts';
import { viewShift } from '../geometry.ts';

/** The screen-space box the lattice is drawn in - see inkBox(). */
type InkBox = {
  x: number;
  y: number;
  w: number;
  h: number;
  topRadius: string;
  bottomRadius: string;
};

/**
 * A layer canvas, carrying the device ratio its backing store was sized at.
 *
 * `_dpr` is written by sizeCanvas() and read by every painter below, and it is
 * on the element rather than in a module variable on purpose: there are two
 * canvases (lattice and axes), they are re-made when the viewport is, and the
 * ratio belongs to the bitmap rather than to this file.
 */
type InkCanvas = HTMLCanvasElement & { _dpr: number };

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
// Exported for the same reason MIN_PX and MAX_PX are, and one more: ui/snapshot.ts
// draws the lattice a second time onto the export canvas, and had its own copy of
// this number. The techniques cannot be shared - that file's header says so and is
// right - but the policy can, and a major every fifth mark in a PNG and every
// fourth on screen would be two different grids.
export const MAJOR = 4;      // major line every N minor steps

/** How much heavier a major mark is drawn than a minor one, on both surfaces. */
export const MAJOR_WEIGHT = 1.5;

/**
 * The same band for a finger, in the only unit that makes the question
 * answerable: how far apart the dots are on the actual glass.
 *
 * 40px is a comfortable lattice on a desk and is not one on a phone, and the
 * reason is not preference - it is that a CSS pixel is a different size on the
 * two devices. A desktop panel runs near the spec's 96 CSS px to the inch, so
 * 40px is about a centimetre; a phone packs closer to 150, so the identical
 * number comes out under seven millimetres. Same code, same lattice, and on the
 * screen where a fingertip covers ten millimetres it is drawn twice as fine.
 *
 * So the touch floor is stated as a distance and converted, rather than picked
 * as a second pixel count that would drift from the first one. 1.41 cm is a
 * lattice you can put a finger between.
 *
 * The nominal 96 is doing the conversion, which means this is still the
 * spec's centimetre rather than a measured one - the browser gives no other -
 * and on a phone it therefore lands short of a true 1.41 cm rather than over
 * it. That is the right direction to be wrong in: it errs towards the grid the
 * desktop already has, and every millimetre of the correction is one the old
 * fixed number was not making at all.
 */
const TOUCH_MIN_MM = 14.1;
// Up, not to nearest. This is a floor, and 53.29 rounded to 53 is a lattice
// drawn at 1.402 cm by a constant that says 1.41 - which is the sort of
// off-by-a-rounding that is invisible on screen and wrong in the one place
// anybody would go looking for the number.
export const MIN_PX_TOUCH = Math.ceil(TOUCH_MIN_MM * PX_PER_INCH / MM_PER_INCH);
/** The band keeps its factor of four, which is MAJOR - see the note above. */
export const MAX_PX_TOUCH = MIN_PX_TOUCH * MAJOR;
// At the supported 4px maximum weight, the largest dot reaches 6.7px from its
// centre and the largest Harsh cross reaches 6.3px. Pulling Mobile's ink box in
// by seven clips the complete marks centred on the physical board boundary.
export const MOBILE_GRID_EDGE_CLEARANCE = 7;

/** Axes are a Desktop spatial aid; Mobile keeps only the quieter lattice. */
export const axesVisible = (settings = board.settings, mode = board.layoutMode) =>
  !!settings.axes && mode !== 'mobile';

/**
 * World-space grid step whose on-screen spacing lands inside the band in force.
 *
 * `touch` is a parameter with a live default rather than a module constant, so
 * a tablet with a keyboard folded onto it re-tiers when the pointer changes -
 * and so the band can be named outright by a test, which cannot ask a browser.
 */
export function gridStep(base: number, zoom: number, touch = onTouch()): number {
  const min = touch ? MIN_PX_TOUCH : MIN_PX;
  const max = touch ? MAX_PX_TOUCH : MAX_PX;
  let step = base > 0 ? base : 64;
  let guard = 0;
  while (step * zoom < min && guard++ < 64) step *= 2;
  while (step * zoom > max && guard++ < 64) step /= 2;
  return step;
}

/**
 * Grid step used by both the painter and pointer gestures for this viewport.
 *
 * Desktop may coarsen its unbounded grid as zoom changes. Mobile cannot: its
 * selected width is explicitly measured in six or eight spaces, so doubling
 * the step at the fitted 8-wide zoom silently turns that choice into four.
 */
// The two fields of a Viewport this asks for, named off the class rather than
// re-stated: it is a pure function of a zoom and a mode, and tests/layout.test.js
// exercises it with exactly those two and nothing else.
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

/**
 * The screen-space box the lattice is drawn in.
 *
 * Desktop has no edges to speak of - the board is unbounded, the grid is the
 * background, and the box is simply the viewport. Mobile does: the strip is a
 * finite sheet with paper above it and below it, and a mark out there is not a
 * grid mark, it is a grid mark on nothing.
 *
 * Cutting it here rather than covering it up is the point. The lattice at two
 * of the three tiers is a tiled background and at the third it is a canvas, and
 * both draw exactly as far as this element reaches - so a box that stops at the
 * board's edge is a lattice that was never painted outside it. A mask or a
 * clip would have been a rectangle's worth of compositor work every frame to
 * throw away pixels that had already been rasterised, on the device least able
 * to afford it.
 *
 * Clipped to the viewport as well as to the board, because the two overlap in
 * whatever way the pan has left them: scrolled to the head of a long board, the
 * box starts under the masthead and runs off the bottom of the screen. An empty
 * intersection - the board entirely above or below the window - comes back with
 * a zero side, and paintGrid() draws nothing at all.
 */
// Three fields and a method of a Viewport, named off the class for the reason
// boardGridStep() gives: this one is pure too, and the test that guards the
// clearance hands it a rectangle rather than a board.
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
  // Recorded at the top rather than at the foot: this function has three exits,
  // and what the guard above compares against is the view a paint was made for,
  // which is this one whichever way the paint goes out.
  // Shaped like a view (pan/zoom) so viewShift() can take it directly, with the
  // frame the grid is drawn in carried alongside.
  lastView = { pan: { x: vp.pan.x, y: vp.pan.y }, zoom: vp.zoom,
               cx: vp.cx, cy: vp.cy, left: vp.left, top: vp.top, moving: vp.moving };

  el.classList.toggle('no-axes', !axesVisible());

  // Before the early return below: the axes are not part of the grid and do not
  // leave with it. "Show grid" and "Show axes" are two settings.
  paintAxes(vp);

  const canvas = ensureCanvas(el);
  const box = inkBox(vp);
  placeInk(canvas, box);

  if (!s.grid || !(box.w > 0 && box.h > 0)) {
    clearTiles(canvas);
    clearCanvas(canvas);
    return;
  }

  // What is drawn is always a *coarse* lattice at full strength plus the marks
  // that sit between its own, at whatever the fade has reached - see tierFade().
  // Outside a fade the two collapse to one: alpha is 0 or 1 and the pair is
  // exactly the lattice gridStep() asked for.
  const { coarse, alpha } = tierFade(boardGridStep(s.gridStep, vp), vp);
  const minor = coarse * vp.zoom;
  const major = minor * MAJOR;
  // The origin the axis rules use, not the raw one - see Viewport.axisOrigin().
  // The fallback is for the render harnesses, which pass a viewport stub.
  const screenOrigin = vp.axisOrigin ? vp.axisOrigin() : vp.toScreen(0, 0);
  // ...moved into the ink layer's own coordinates, because the layer no longer
  // starts at the corner of the viewport. Everything below - the tile offsets,
  // the cross positions, the hole - is measured from the box, and the world
  // origin is the one point they all have to agree on.
  const o = { x: screenOrigin.x - box.x, y: screenOrigin.y - box.y };
  // An attribute read, not getComputedStyle. This function runs on every frame
  // of every pan and pinch, and asking for a computed value in here would force
  // a synchronous style flush per frame for a value that changes about once an
  // afternoon. ui/appearance.js announces the change instead, so the attribute
  // is always current by the time we look at it.
  const harsh = harshGrid();

  if (harsh) {
    // The two painters are exclusive. Leaving the gradients up under the canvas
    // would show a dot inside every cross.
    clearTiles(canvas);
    drawCrosses(canvas, box, o, minor, major, alpha);
    return;
  }

  clearCanvas(canvas);

  const images: string[] = [], sizes: string[] = [], positions: string[] = [];
  // A mark is a list of image layers rather than one, because the dot's major
  // and minor lattices each want their own. Every layer of a mark shares its
  // lattice's tile and origin, so they are pushed together.
  const push = (layers: string[], size: number, px: number, py: number) => {
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
  const between = (layers: string[], size: number, ox: number, oy: number) => {
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
  // The one write left on the hot path, and the one this cannot cache away: the
  // marks have to land where the board is. It is also a full re-raster of the
  // layer's tiled background, which is why there is a switch on it - see
  // mobilePerfFlags. Off, the lattice is left where it was and the board slides
  // out from under it; that is a broken picture on purpose, for measuring only.
  if (mobilePerfFlags.gridPos) canvas.style.backgroundPosition = positions.join(', ');
  punchHole(canvas, o, vp, box);
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
function clearTiles(canvas: HTMLCanvasElement) {
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
function punchHole(canvas: HTMLCanvasElement, o: { x: number; y: number }, vp: Viewport, box: InkBox) {
  // ...and dropped while the board is moving, wherever the origin is.
  //
  // The comment below is right that this is usually the same string twice, and
  // wrong about the case that matters. The origin sits in the middle of the
  // screen on a board nobody has panned yet - which is every board at the moment
  // it is opened, and the whole of an empty one - and there the position in this
  // string changes on every single frame. Rewriting a mask is not a cheap write:
  // it invalidates the layer it applies to, which here is the full screen, so
  // the one case where the guard below never fires is also the case where the
  // cost is highest. On a phone that alone was the difference between a smooth
  // pinch and a visibly stepping one, on a board with nothing on it.
  //
  // What is given up is a grid mark peeping out from behind the origin ring for
  // as long as a gesture lasts, under a mark that is drawn over the top of it
  // anyway. It comes back the moment the board settles - Viewport announces the
  // stop, which repaints this - and a still board is the only one anybody is
  // looking at closely enough to see a dot under a ring.
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
/**
 * Where the two axis lines were last drawn, how thick, and on a bitmap of what
 * size. Null on either coordinate means that axis was off screen.
 */
type AxisMemo = { x: number | null; y: number | null; t?: number; w: number; h: number };

let axisWas: AxisMemo = { x: null, y: null, t: 0, w: 0, h: 0 };

/**
 * The two world axes, in whole device pixels.
 *
 * This used to be two absolutely-positioned <div>s one device pixel thick, and
 * it could not be made to work. A browser lays out in sixty-fourths of a CSS
 * pixel, and one device pixel is a whole number of those only when the display
 * is at 100% or 200% - at 125%, at 150%, or on a phone at 3x, the closest
 * expressible height is a fraction under a full row. Standing still that is
 * invisible; the rasteriser paints 99% of a row and nobody can tell. But the
 * *position* moves with every pan, and wherever that missing fraction happened
 * to straddle a pixel boundary the row could round away to nothing, so the axis
 * blinked out and came back a few pixels later.
 *
 * There is no arithmetic that fixes it, because the problem is that the unit
 * being asked for does not exist in the units the answer is given in. A canvas
 * has no such gap: a pixel is filled or it is not, and fillRect on integer
 * coordinates fills exactly the row it names. So the rules are drawn rather
 * than laid out, and the question stops being asked.
 *
 * Its own canvas rather than the grid's, and that is not tidiness either. The
 * grid cuts a hole in itself where the origin mark stands, and it does it with
 * a CSS mask - which applies to the whole element. Drawn on that canvas, both
 * rules would have a notch taken out of them exactly where they cross.
 */
function paintAxes(vp: Viewport) {
  const canvas = ensureAxisCanvas(vp.el);
  const ctx = sizeCanvas(canvas, { w: vp.width, h: vp.height });
  if (!ctx) return;
  const W = canvas.width, H = canvas.height;

  // A resize blanks the bitmap, so there is nothing left to wipe - and the rows
  // named in axisWas may not even exist any more.
  // null rather than a negative number for "not drawn": a rule running off the
  // top of the screen is drawn at a negative row, and a sentinel it could be
  // mistaken for would leave that one on the canvas for good.
  if (axisWas.w !== W || axisWas.h !== H) axisWas = { x: null, y: null, t: 0, w: W, h: H };
  // Cleared to a whole pixel, though it is drawn to a fraction of one. A
  // clearRect over four fifths of a row removes four fifths of what is in it and
  // leaves the rest, so a fractional wipe would build up a faint stripe along
  // every path the axis had ever taken. Erasing a hair more than was drawn costs
  // nothing, since the rule is about to be redrawn anyway.
  // Number() is a formality, and saying so is the point: the case it used to
  // describe cannot happen. `t` is absent in one of the two shapes assigned to
  // axisWas (ensureAxisCanvas), and that one also sets `w: 0, h: 0` - so
  // sizeCanvas() answers null and this function has already returned by the
  // time either line below runs. A comment explaining how a NaN reaches a
  // clearRect is a comment the next reader spends time on for nothing.
  if (axisWas.y !== null) ctx.clearRect(0, Math.floor(axisWas.y), W, Math.ceil(Number(axisWas.t)) + 1);
  if (axisWas.x !== null) ctx.clearRect(Math.floor(axisWas.x), 0, Math.ceil(Number(axisWas.t)) + 1, H);
  axisWas.x = axisWas.y = null;

  if (!axesVisible()) return;

  // The same origin the grid lattice lands on - see Viewport.axisOrigin(), and
  // the note there about the two having once rounded it differently. It hands
  // back the centre of a device pixel, and the band is laid symmetrically about
  // that point - so a rule of any thickness still has the crossing at its middle
  // and the origin mark, which is centred on the same point, sits true on it.
  const o = vp.axisOrigin ? vp.axisOrigin() : vp.toScreen(0, 0);
  const d = canvas._dpr;
  // Not rounded to a whole row - see AXIS_PX - and the *start* is not rounded
  // either, which it used to be.
  //
  // Rounding it looked like the way to keep the first row solid, and it did,
  // but it bought that by pushing the whole band onto the low side of the
  // crossing: at 1x the rule sat in the row the origin is in plus a fifth of
  // the next one down, so its weight was left of centre and above it. The
  // origin mark is symmetric about the crossing, so the two disagreed by about
  // a fifth of a pixel on top of whatever the mark's own placement was doing,
  // and the crosshair ran visibly nearer one wall of the ring than the other.
  //
  // Laid symmetrically instead, and nothing is lost by it: o is the *centre* of
  // a device pixel and the band is at least one pixel thick, so the pixel the
  // origin is in is still covered end to end. What was one solid row and one
  // soft one is now one solid row with a matched shade either side of it -
  // same weight, same hairline, and it is centred on the point it marks.
  const t = Math.max(1, AXIS_PX * d);
  const y = o.y * d - t / 2;
  const x = o.x * d - t / 2;
  axisWas.t = t;

  ctx.fillStyle = gridInk().axis;
  // Tested against the band rather than against a single row, so a rule half off
  // the top of the screen still draws the half that is on it.
  if (y + t > 0 && y < H) { ctx.fillRect(0, y, W, t); axisWas.y = y; }
  if (x + t > 0 && x < W) { ctx.fillRect(x, 0, t, H); axisWas.x = x; }
}

/**
 * A hidden `<canvas>` for one of the viewport's ink layers, with its id. The two
 * ensure*() functions below differ in where they insert it and what state they
 * reset; this is the part they shared.
 */
function makeInkCanvas(id: string): InkCanvas {
  // SAFETY: the cast is the `_dpr` field, written by sizeCanvas() before any
  // painter reads it - every painter sizes the backing store before it draws -
  // and the field is this module's own.
  const canvas = document.createElement('canvas') as InkCanvas;
  canvas.id = id;
  canvas.setAttribute('aria-hidden', 'true');
  return canvas;
}

/** The axis layer, made if it is not there - see ensureCanvas() for why. */
function ensureAxisCanvas(el: HTMLElement): InkCanvas {
  let canvas = el.querySelector<InkCanvas>(':scope > #axis-ink');
  if (!canvas) {
    canvas = makeInkCanvas('axis-ink');
    // Over the lattice and under the board, which is where index.html puts it.
    // Appending would put the rules on top of every item.
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
 *
 * Nor is a tier crossed *during a live zoom*. The fade draws both lattices at
 * once - on the gradient tiers that is up to fourteen radial gradients repainted
 * full-viewport, on Harsh a doubled Path2D fill - and holds a repaint loop up
 * for its whole hundred milliseconds. Standing still that is a nicety nobody
 * notices paying for; under a continuous zoom, where the board crosses one tier
 * after another and the fades overlap, it is a sustained double-paint that lands
 * exactly as the lag you feel when the dots re-tier. The fade is invisible at
 * that speed anyway - a hundred-millisecond dissolve cannot be seen inside a
 * gesture that is already past it - so mid-motion the marks simply snap, and the
 * fade is kept for the slow, settled crossing it was written for. `vp.moving` is
 * already true by the time paintGrid runs inside a gesture (see _moving()).
 */
function tierFade(step: number, vp: Viewport) {
  const now = performance.now();
  if (step !== tier.step) {
    const adjacent = tier.step > 0 && (step === tier.step * 2 || step === tier.step / 2);
    // A second change mid-fade abandons the first rather than queueing behind
    // it. Pinching through three tiers should land on the third, not play two
    // animations of somewhere it no longer is.
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
 * note on `apply()` in ui/appearance.js - so an absent attribute here means
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
function drawCrosses(canvas: InkCanvas, box: InkBox, o: { x: number; y: number },
                     minor: number, major: number, alpha: number) {
  const ctx = sizeCanvas(canvas, box);
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
function ensureCanvas(el: HTMLElement): InkCanvas {
  let canvas = el.querySelector<InkCanvas>(':scope > #grid-ink');
  if (!canvas) {
    canvas = makeInkCanvas('grid-ink');
    el.prepend(canvas);
    // A new element carries none of the styles the last one was written, so
    // what paintGrid() remembers writing is now a memory of a different node.
    // Left alone, the first paint onto a fresh canvas would skip the very
    // writes that put the lattice there.
    lastImage = lastSize = lastMask = lastBox = '';
  }
  return canvas;
}

/**
 * Match the backing store to a CSS-pixel box in device pixels.
 *
 * A box rather than the viewport, because the lattice layer is no longer
 * viewport-sized - on Mobile it is the board, and a bitmap wider than the
 * element it is stretched into is the marks drawn at the wrong pitch. The axis
 * layer passes the viewport itself, which is still what it covers.
 *
 * Only on a real change: assigning width or height clears the canvas even when
 * the value is identical, so doing it unconditionally would blank the lattice
 * every frame and draw it again - which looks exactly like the flicker this is
 * replacing.
 */
function sizeCanvas(canvas: InkCanvas, { w, h }: { w: number; h: number }): CanvasRenderingContext2D | null {
  // The same ratio the axis rules snap to, from the same place - see
  // deviceRatio(). Two roundings of two different numbers is how the lattice
  // and the axes came to disagree in the first place.
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

/**
 * The grid's resolved colours and dot size.
 *
 * getComputedStyle is exactly what the note in paintGrid() forbids per frame,
 * so this is read once and held. resetGridInk() below is how it is given back,
 * and ui/appearance.js calls it on every change to a look - which includes each
 * drag of the strength and weight sliders, since a canvas cannot follow those
 * on its own the way a gradient carrying var() can.
 */
let ink: { major: string; minor: string; axis: string; dot: number } | null = null;

function gridInk() {
  if (ink) return ink;
  const s = getComputedStyle(document.documentElement);
  const dot = parseFloat(s.getPropertyValue('--grid-dot'));
  ink = {
    major: s.getPropertyValue('--grid-major').trim() || 'currentColor',
    minor: s.getPropertyValue('--grid-minor').trim() || 'currentColor',
    // The axes are drawn rather than styled now, so their colour has to be
    // resolved here with the rest of them - and is given back by the same
    // resetGridInk() when a look changes.
    axis: s.getPropertyValue('--grid-axis').trim() || 'currentColor',
    dot: Number.isFinite(dot) ? dot : 1.5,
  };
  return ink;
}

/** Forget the resolved colours - the look changed. */
export function resetGridInk() {
  ink = null;
}
