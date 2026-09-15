// Sharpen a zoomed-in photo: past the point where Full's display copy would
// upscale, swap in the full original; swap the copy back when zoomed out again,
// so the big bitmap is only ever live for a card that fills the screen. The
// opposite end of stills.ts - that freezes GIFs when they are small, this
// sharpens photos when they are large - and per card, since a big card crosses
// the threshold before a small one does. The original is the asset's own shared
// URL (assetURL), so a swap creates no blob URL and there is nothing to revoke.

import { byId } from '../state.ts';
import { assetURL } from '../storage/assets.ts';
import { qualityPreset } from '../quality.ts';
import { copyEdge } from './display.ts';
import type { Viewport } from './viewport.ts';

/** Minimal viewport dependency: the zoom level and a change listener. */
type ZoomSource = Pick<Viewport, 'zoom' | 'onChange'>;

// A margin so a card sitting near 1:1 with its copy does not swap source on tiny
// zoom jitter, and so the original is asked for a touch before it is needed.
const TRIGGER = 1.15;

/**
 * The long edge the swap is measured against: Full's copy, at every stop.
 * Measured against the copy actually shown, a lower stop - whose copy is
 * smaller - reached for the original *sooner*, so Light decoded a camera's
 * full frame for a card Full was still drawing from its copy. A lower stop
 * keeps its softer copy up to where Full would swap, which is the trade it
 * asked for.
 */
export const swapEdge = () => Math.max(copyEdge(), qualityPreset('full').sharpness);

/** The main <img> of a plain photo card, with the copy URL to return to. */
type HiresImage = HTMLImageElement & { _copyUrl?: string };

let worldEl: HTMLElement | null = null;

export function initHires(world: HTMLElement, vp: ZoomSource): void {
  worldEl = world;
  const update = () => sweep(vp.zoom);
  vp.onChange(update);
  update();
}

function sweep(zoom: number): void {
  if (!worldEl) return;
  // The real device ratio, not the viewport's clamped one: the question is how
  // many device pixels this card covers, and a 3x screen genuinely has them.
  const dpr = Math.max(1, globalThis.devicePixelRatio || 1);
  // Only plain photo cards are tagged (canvas/renderers.ts) - an edited card's
  // copy is the crop/turn/cut-out, with no untouched original to sharpen up to.
  for (const img of worldEl.querySelectorAll<HiresImage>('img[data-hires-hash]')) {
    const hash = img.dataset.hiresHash;
    if (!hash) continue;
    const item = byId(img.closest<HTMLElement>('.item')?.dataset.id || '');
    if (!item) continue;
    // The card's drawn long edge in device pixels. Past the copy's own long edge
    // (times the margin) the copy is upscaling and the original earns its memory.
    const longEdge = Math.max(item.w, item.h) * zoom * dpr;
    const wantOriginal = longEdge > swapEdge() * TRIGGER;
    const isHi = img.dataset.hires === 'on';
    if (wantOriginal && !isHi) {
      const orig = assetURL(hash);
      if (!orig || orig === img.src) continue;
      img._copyUrl = img.src;       // the copy to return to when zoomed back out
      img.dataset.hires = 'on';
      img.src = orig;
    } else if (!wantOriginal && isHi) {
      img.dataset.hires = '';
      // Swapping back frees the original's bitmap: nothing else holds it.
      if (img._copyUrl && img.src !== img._copyUrl) img.src = img._copyUrl;
    }
  }
}
