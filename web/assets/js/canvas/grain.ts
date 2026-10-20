// Paper-grain texture layer, anchored to the board origin and scaled with zoom.
// The window layer, #grain, is a canvas this file draws the tile into at one
// pixel per CSS pixel; the Mobile sheet's grain stays a CSS background it
// positions. Travels on pan + scales on zoom, every frame, so flecks belong to
// the paper, not the glass: carried by the compositor while the board moves,
// drawn afresh only when an edge would show - see follow().
// Fades out below 30% zoom to avoid resampling cost and moire.

import { deviceRatio } from './viewport.ts';
import type { Viewport } from './viewport.ts';
import { sheetBox } from './mobile-frame.ts';
import { quality } from '../quality.ts';
import { wrap } from '../util.ts';

// Tile side in world units (matches base.css #grain background-size).
const TILE = 512;

// Fade band: full at 40%, gone at 30%. Linear in between.
// Exported for the test.
export const FADE_FULL = 0.40;
export const FADE_GONE = 0.30;

export const fadeFor = (zoom: number): number =>
  zoom >= FADE_FULL ? 1
    : zoom <= FADE_GONE ? 0
      : (zoom - FADE_GONE) / (FADE_FULL - FADE_GONE);

// How far the canvas reaches past each edge of the window, in CSS px: the room
// follow() has to slide and shrink it before an edge would show. Half the tile
// at 100%, so a pan at 100% or below never draws: the texture repeats every
// tile, and follow() moves it less whole tiles. Affordable because the canvas
// is one pixel per CSS pixel - a phone's is about 5 MB, where the CSS layer
// this replaced, at the screen's own density with a 96px margin, was 22 MB.
// That layer repainted every 96px of a pan at 100%, and every repaint threw
// its tiles away. Nothing Phone (4a), Balanced, fresh installs: pan-100 29% of
// frames missed with that layer to 18% with this canvas, fling 9% to 6%.
const MARGIN = 256;

// Cache: last surface and last written values. Reset on layout change.
let lastEl: HTMLElement | null = null, lastPos = '', lastSize = '', lastFade = '';

// The view the canvas was last drawn for - zoom, the board origin on screen,
// the tile on screen - which follow() carries it on from. Null until the first
// drawing, and for the sheet, which is never carried.
type Drawn = { z: number, x: number, y: number, tile: number };
let base: Drawn | null = null;
// Whether follow() has a transform on the canvas, and the drawing its origin is for.
let carried = false;
let origin: Drawn | null = null;
// The window the canvas was drawn for. Read by draw() alone: innerWidth
// forces a style and layout pass when the board's transform has just been
// written, and follow() runs every frame of a gesture.
let winW = 0, winH = 0;

// The two grain surfaces, resolved once. Absent in test harnesses.
let el: HTMLCanvasElement | null = null, sheetEl: HTMLElement | null = null;

// The tile, read off #grain's CSS so the stylesheet stays the one place its
// address is written. Until it has decoded, #grain shows the CSS background
// and is positioned as the sheet is; once it has, the canvas takes over.
let url: string | null = null;
let ctx: CanvasRenderingContext2D | null = null;
let pattern: CanvasPattern | null = null;
let img: HTMLImageElement | null = null;

/** The paper tile's address, for an export that draws the same texture. */
export function grainUrl(): string | null {
  return url;
}

// Cached --grain token value. Caches the token, not resolved opacity (which
// includes the zoom fade this file writes). Reset by resetGrain().
let inked: number | null = null;

function hasGrain() {
  const from = el || sheetEl;
  if (!from) return true;
  const v = inked ?? (inked = parseFloat(getComputedStyle(from).getPropertyValue('--grain')));
  // Unreadable token paints rather than hides.
  return Number.isFinite(v) ? v > 0.001 : true;
}

// Clear the cached --grain value (call on look change).
export function resetGrain(): void {
  inked = null;
}

// Position and size the grain layer to match the current viewport.
export function paintGrain(vp: Viewport): void {
  // The dial says no texture, and quality.css has already taken the layer off
  // the page. Returning here is what stops the *writes* - three style
  // properties per frame on a surface that is not being painted.
  if (!quality.grain) return;
  const tile = TILE * vp.zoom;
  if (!(tile > 0)) return;

  // On mobile the sheet is the grain surface; on desktop it is the full-bleed layer.
  const mobile = !!vp.isMobile;
  const surface = mobile ? sheetEl : el;
  if (!surface) return;
  if (surface !== lastEl) {
    // Off to the sheet, where #grain is not shown: its canvas need not be held.
    if (lastEl === el) release();
    lastEl = surface;
    lastPos = lastSize = lastFade = '';
    base = null;
  }
  if (!hasGrain()) return;

  // Fade written on the surface, like its tile and position. It used to go on
  // :root so fences could inherit it too, and a custom property on the root
  // restyles the whole page: every frame of a zoom through the band did, 50 to
  // 90ms a time on a Galaxy S10. Fences work the same fade out from --iz in
  // fences.css, which lands when the view settles.
  const fade = fadeFor(vp.zoom);
  const f = fade.toFixed(3);
  if (f !== lastFade) {
    lastFade = f;
    surface.style.setProperty('--grain-fade', f);
  }
  // Faded out: nothing to draw, and the canvas gives its memory back, since
  // below 30% is where the WebView runs short of tile memory for the cards.
  if (fade === 0) { release(); return; }

  if (mobile || !pattern) {
    if (!mobile && el) fit(el);
    lay(surface, vp, tile, mobile);
    return;
  }
  // Every frame, at every quality: the flecks are the paper's, and paper that
  // stays behind while the board slides over it reads as a smear on the glass.
  if (vp.moving && base && follow(vp)) return;
  draw(vp, tile);
}

const snap = (n: number) => { const d = deviceRatio(); return Math.round(n * d) / d; };

/** Place the CSS background for the view as it is: the sheet's, and #grain's until the tile decodes. */
function lay(surface: HTMLElement, vp: Viewport, tile: number, mobile: boolean) {
  // Size before position: phase depends on the scaled tile.
  const size = `${snap(tile)}px ${snap(tile)}px`;
  if (size !== lastSize) {
    lastSize = size;
    surface.style.setProperty('--grain-tile', size);
  }

  // Subtract the sheet box on mobile so the grain follows the paper, not the
  // window; add the margin on the window layer, whose box starts outside it.
  const o = vp.toScreen(0, 0);
  let ox = o.x, oy = o.y;
  if (mobile && vp.mobileScreenRect) {
    const box = sheetBox(vp.mobileScreenRect(), vp.width, vp.height);
    ox -= box.x;
    oy -= box.y;
  } else {
    ox += MARGIN;
    oy += MARGIN;
  }
  const pos = `${snap(wrap(ox, tile))}px ${snap(wrap(oy, tile))}px`;
  if (pos !== lastPos) {
    lastPos = pos;
    surface.style.setProperty('--grain-pos', pos);
  }
}

/** Draw the tile into the canvas for the view as it is, and take any transform off. */
function draw(vp: Viewport, tile: number) {
  if (!el || !ctx || !pattern || !img) return;
  winW = innerWidth;
  winH = innerHeight;
  const w = winW + 2 * MARGIN, h = winH + 2 * MARGIN;
  if (el.width !== w || el.height !== h) {
    el.width = w;
    el.height = h;
    fit(el);
  }
  const o = vp.toScreen(0, 0);
  const k = tile / img.naturalWidth;
  // Whole pixels: a phase between two leaves every fleck resampled soft.
  pattern.setTransform(new DOMMatrix([k, 0, 0, k,
    Math.round(wrap(o.x + MARGIN, tile)), Math.round(wrap(o.y + MARGIN, tile))]));
  // Set every time: resizing a canvas resets its context. Medium is mipmapped,
  // which a tile shrunk to 40% needs to stay grain rather than shimmer.
  ctx.imageSmoothingQuality = 'medium';
  ctx.clearRect(0, 0, w, h);
  ctx.fillStyle = pattern;
  ctx.fillRect(0, 0, w, h);
  if (carried) { carried = false; el.style.transform = ''; }
  base = { z: vp.zoom, x: o.x, y: o.y, tile };
}

/**
 * Carry the canvas from where it was last drawn to where the board is now, as
 * a compositor transform: scaled by the zoom since, about the origin it was
 * drawn at, and moved by the pan since - less whole tiles, since a pan by one
 * tile shows the same texture. False when that would bring an edge of the
 * canvas on screen, and the caller draws afresh instead.
 */
function follow(vp: Viewport): boolean {
  if (!base || !el) return false;
  const s = vp.zoom / base.z;
  const o = vp.toScreen(0, 0);
  const period = base.tile * s;
  let dx = o.x - base.x, dy = o.y - base.y;
  dx -= Math.round(dx / period) * period;
  dy -= Math.round(dy / period) * period;
  // Window point p shows canvas point b + (p - b - d) / s; the canvas covers
  // -MARGIN to the window's side plus MARGIN.
  const covers = (b: number, d: number, side: number) =>
    b + (-b - d) / s >= -MARGIN && b + (side - b - d) / s <= side + MARGIN;
  if (!covers(base.x, dx, winW) || !covers(base.y, dy, winH)) return false;
  carried = true;
  if (origin !== base) {
    origin = base;
    el.style.transformOrigin = `${base.x + MARGIN}px ${base.y + MARGIN}px`;
  }
  el.style.transform = `translate(${snap(dx)}px, ${snap(dy)}px) scale(${s})`;
  return true;
}

/** Back to the canvas as drawn. */
function drop() {
  if (!carried || !el) return;
  carried = false;
  el.style.transform = '';
}

/**
 * The box: the window plus the margin. A canvas is a replaced element, so
 * base.css's inset does not stretch it, and its own 300x150 would crop the
 * CSS copy that shows before the tile decodes.
 */
function fit(c: HTMLCanvasElement) {
  c.style.width = `${innerWidth + 2 * MARGIN}px`;
  c.style.height = `${innerHeight + 2 * MARGIN}px`;
}

/** Give the canvas's memory back; the next draw sizes it again. */
function release() {
  drop();
  base = null;
  if (el && el.width) { el.width = 0; el.height = 0; }
}

// Resolve surfaces, start the tile decoding, and paint once. Does not
// subscribe to the view - main.ts calls paintGrain() from inside its measured
// listener.
export function initGrain(vp: Viewport): void {
  const g = document.getElementById('grain');
  el = g instanceof HTMLCanvasElement ? g : null;
  sheetEl = document.getElementById('mobile-board-frame');
  if (!el && !sheetEl) return;
  if (el) {
    // The margin follow() moves within, written here so its one number is MARGIN.
    el.style.left = el.style.top = `${-MARGIN}px`;
    // Its own layer for good: a canvas has nothing to re-raster, so the hint
    // costs no tiles, and the layer tree stays put between gestures.
    el.style.willChange = 'transform';
    url = getComputedStyle(el).backgroundImage.match(/url\(["']?([^"')]+)["']?\)/)?.[1] ?? null;
    ctx = el.getContext('2d');
    if (url && ctx) {
      const tile = new Image();
      tile.src = url;
      tile.decode().then(() => {
        if (!el || !ctx) return;
        img = tile;
        pattern = ctx.createPattern(tile, 'repeat');
        // The canvas draws it now; the CSS copy underneath would double it.
        el.style.backgroundImage = 'none';
        lastEl = null;
        paintGrain(vp);
      }, () => {});
    }
  }
  paintGrain(vp);
}
