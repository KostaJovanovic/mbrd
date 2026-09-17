// Paper-grain texture layer, anchored to the board origin and scaled with zoom.
// Tile is styled in base.css; this file positions and fades it.
// Travels on pan + scales on zoom so flecks belong to the paper, not the glass.
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

// Cache: last surface and last written values. Reset on layout change.
let lastEl: HTMLElement | null = null, lastPos = '', lastSize = '', lastFade = '';

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
    lastEl = surface;
    lastPos = lastSize = lastFade = '';
  }
  if (!hasGrain()) return;

  // Fade written on :root so fences (inside #viewport) and the grain layer
  // (outside it) both inherit it.
  const fade = fadeFor(vp.zoom);
  const f = fade.toFixed(3);
  if (f !== lastFade) {
    lastFade = f;
    document.documentElement.style.setProperty('--grain-fade', f);
  }
  // Faded out — skip positioning (also avoids costly resample at small tile).
  if (fade === 0) return;

  const d = deviceRatio();
  const q = (n: number) => Math.round(n * d) / d;

  // Size before position: phase depends on the scaled tile.
  const size = `${q(tile)}px ${q(tile)}px`;
  if (size !== lastSize) {
    lastSize = size;
    surface.style.setProperty('--grain-tile', size);
  }

  // Subtract the sheet box on mobile so the grain follows the paper, not the window.
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

// Resolve surfaces and paint once. Does not subscribe to the view — main.ts
// calls paintGrain() from inside its measured listener.
export function initGrain(vp: Viewport): void {
  el = document.getElementById('grain');
  sheetEl = document.getElementById('mobile-board-frame');
  if (!el && !sheetEl) return;
  paintGrain(vp);
}
