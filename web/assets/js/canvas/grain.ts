// Paper-grain texture layer, anchored to the board origin and scaled with zoom.
// Tile is styled in base.css; this file positions and fades it.
// Travels on pan + scales on zoom, every frame, so flecks belong to the paper,
// not the glass. While the board moves the window layer is carried by the
// compositor rather than repainted - see follow().
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

// How far the window layer reaches past each edge of the window, in CSS px:
// the room follow() has to slide and shrink it before an edge would show.
// Kept small because the layer's tiles grow with it - a sheet far larger than
// the window once ran a phone out of tile memory (the grid's, v0.734).
const MARGIN = 96;

// Cache: last surface and last written values. Reset on layout change.
let lastEl: HTMLElement | null = null, lastPos = '', lastSize = '', lastFade = '';

// The view the window layer was last painted for - zoom, the board origin on
// screen, the tile on screen - which follow() carries it on from. Null until
// the first paint, and for the sheet, which is never carried.
let base: { z: number, x: number, y: number, tile: number } | null = null;
// Whether follow() has a transform on the layer.
let carried = false;

// The two grain surfaces, resolved once. Absent in test harnesses.
let el: HTMLElement | null = null, sheetEl: HTMLElement | null = null;

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
// Offset is modulo the tile (tiled background repeats), rounded to device pixels.
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
    if (lastEl) drop(lastEl);
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
  // Faded out — skip positioning (also avoids costly resample at small tile).
  if (fade === 0) { drop(surface); base = null; return; }

  // Every frame, at every quality: the flecks are the paper's, and paper that
  // stays behind while the board slides over it reads as a smear on the glass.
  // It was held still below Full while the board moved (2026-10-16), to save
  // repainting the window-sized layer, and that read as a bug. Carrying it
  // keeps the saving: a pan or a pinch moves it without a repaint.
  if (!mobile && vp.moving && base && follow(surface, vp)) return;
  drop(surface);
  lay(surface, vp, tile, mobile);
}

const snap = (n: number) => { const d = deviceRatio(); return Math.round(n * d) / d; };

/** Paint the texture for the view as it is: tile size and phase. */
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
  base = mobile ? null : { z: vp.zoom, x: o.x, y: o.y, tile: snap(tile) };
}

/**
 * Carry the window layer from where it was last painted to where the board is
 * now, as a compositor transform: scaled by the zoom since, about the origin
 * it was painted at, and moved by the pan since - less whole tiles, since a
 * pan by one tile shows the same texture. False when that would bring an edge
 * of the layer on screen, and the caller paints afresh instead.
 */
function follow(surface: HTMLElement, vp: Viewport): boolean {
  if (!base) return false;
  const s = vp.zoom / base.z;
  const o = vp.toScreen(0, 0);
  const period = base.tile * s;
  let dx = o.x - base.x, dy = o.y - base.y;
  dx -= Math.round(dx / period) * period;
  dy -= Math.round(dy / period) * period;
  // Window point p shows layer point b + (p - b - d) / s; the layer covers
  // -MARGIN to the window's side plus MARGIN.
  const covers = (b: number, d: number, side: number) =>
    b + (-b - d) / s >= -MARGIN && b + (side - b - d) / s <= side + MARGIN;
  if (!covers(base.x, dx, innerWidth) || !covers(base.y, dy, innerHeight)) return false;
  if (!carried) {
    carried = true;
    // The hint pins the raster scale, so a pinch is not re-rastered per frame;
    // drop() takes it off, and the next paint is at scale 1 again.
    surface.style.willChange = 'transform';
    surface.style.transformOrigin = `${base.x + MARGIN}px ${base.y + MARGIN}px`;
  }
  surface.style.transform = `translate(${snap(dx)}px, ${snap(dy)}px) scale(${s})`;
  return true;
}

/** Back to the layer as painted. */
function drop(surface: HTMLElement) {
  if (!carried) return;
  carried = false;
  surface.style.transform = '';
  surface.style.willChange = '';
}

// Resolve surfaces and paint once. Does not subscribe to the view — main.ts
// calls paintGrain() from inside its measured listener.
export function initGrain(vp: Viewport): void {
  el = document.getElementById('grain');
  sheetEl = document.getElementById('mobile-board-frame');
  if (!el && !sheetEl) return;
  // The margin follow() moves within, written here so its one number is MARGIN.
  if (el) el.style.inset = `${-MARGIN}px`;
  paintGrain(vp);
}
