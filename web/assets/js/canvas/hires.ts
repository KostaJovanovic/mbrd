// Sharpen a zoomed-in photo: past the point where Full's display copy would
// upscale, swap in the full original; swap the copy back when zoomed out again,
// so the big bitmap is only ever live for a card that fills the screen. The
// opposite end of stills.ts - that freezes GIFs when they are small, this
// sharpens photos when they are large - and per card, since a big card crosses
// the threshold before a small one does. The original is the asset's own shared
// URL (assetURL), so a swap creates no blob URL and there is nothing to revoke.
// It is decoded off screen first and the copy stays up until it has been.

import { byId } from '../state.ts';
import { assetURL } from '../storage/assets.ts';
import { quality, qualityPreset } from '../quality.ts';
import { copyEdge } from './display.ts';
import { deviceRatio } from './viewport.ts';
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

/**
 * Put a display copy that finished late on its card. A card the sweep already
 * swapped to its original keeps the original, and the copy becomes what it
 * returns to - else the copy replaced the original, and a zoom-out went back
 * to the thumbnail the sweep had recorded instead.
 */
export function landCopy(img: HiresImage, url: string): void {
  if (img.dataset.hires === 'on') img._copyUrl = url;
  else img.src = url;
}

let worldEl: HTMLElement | null = null;

/**
 * The zoom and mounted-card count the last sweep answered for.
 *
 * Whether a card wants its original is a function of the card's own size, the
 * zoom and the screen - and of nothing else. A *pan* changes none of them, so
 * for every frame of one this walked every mounted photograph, ran a closest()
 * and a byId() per image, and arrived at the answer it already had. The count
 * is what catches the one thing a pan does change: a card the cull has just
 * mounted, which has no `data-hires` yet and may be past the threshold already.
 *
 * A miss costs a frame's delay in a swap nobody has asked for yet, and the next
 * zoom corrects it; the sweep this skips is per-frame work on the device least
 * able to afford it.
 */
let lastZoom = -1;
let lastCount = -1;

export function initHires(world: HTMLElement, vp: ZoomSource): void {
  worldEl = world;
  const update = () => sweep(vp.zoom);
  vp.onChange(update);
  update();
}

/**
 * Ask again on the next view frame whatever the guard above thinks.
 *
 * The quality dial's, and the twin of refreshStills(): moving it rebuilds every
 * card (resetItems), so the mounted count can land back where it was with every
 * `<img>` freshly on its display copy. Without this a dial moved at high zoom
 * would leave the sweep believing it had already answered for that zoom.
 */
export function refreshHires(): void {
  lastZoom = -1;
  lastCount = -1;
}

function sweep(zoom: number): void {
  if (!worldEl) return;
  const count = worldEl.childElementCount;
  if (zoom === lastZoom && count === lastCount) return;
  lastZoom = zoom;
  lastCount = count;
  // Light gives the swap up altogether - see the note on PRESETS in quality.ts.
  // Written as a term of `wantOriginal` rather than an early return, so a card
  // left holding an original when the dial moves is handed its copy back by the
  // branch that already exists for zooming out.
  const allow = quality.hires;
  // deviceRatio(), which clamps at 3 - the same ceiling the grid's backing
  // store uses, and for the same reason. The question is how many device pixels
  // this card covers and a 3x screen genuinely has them, but a phone claiming 4
  // was reaching for a 48 MB camera frame on a card a third of the way across a
  // 400px-wide screen. Past three, more pixels is not more picture.
  const dpr = deviceRatio();
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
    const wantOriginal = allow && longEdge > swapEdge() * TRIGGER;
    const state = img.dataset.hires;
    if (wantOriginal && !state) {
      const orig = assetURL(hash);
      if (!orig || orig === img.src) continue;
      img.dataset.hires = 'wait';
      void land(img, orig);
    } else if (!wantOriginal && state === 'wait') {
      // Zoomed back out before it decoded: land() sees this and stands down.
      img.dataset.hires = '';
    } else if (!wantOriginal && state === 'on') {
      img.dataset.hires = '';
      // Swapping back frees the original's bitmap: nothing else holds it.
      if (img._copyUrl && img.src !== img._copyUrl) img.src = img._copyUrl;
    }
  }
}

/**
 * Put the original on the card once it is decoded, never before.
 *
 * Setting `src` straight to a 48 MB camera frame left the card blank from that
 * frame until the decode finished, which on a phone is long enough to see:
 * the flash that the note on PRESETS in quality.ts names. Decoded through a
 * detached image instead, the same URL is then an available image and the
 * swap paints on the next frame, with the copy on screen until it does.
 *
 * A zoom out in the meantime clears the mark and this stands down. One that
 * will not decode is marked 'no' and not asked again for this card, or every
 * zoom frame would start the same failing load.
 */
async function land(img: HiresImage, orig: string) {
  const probe = new Image();
  probe.decoding = 'async';
  probe.src = orig;
  try {
    await probe.decode();
  } catch {
    if (img.dataset.hires === 'wait') img.dataset.hires = 'no';
    return;
  }
  if (img.dataset.hires !== 'wait') return;
  // Culled while it decoded: unmarked, so the sweep asks again on remount.
  if (!img.isConnected) { img.dataset.hires = ''; return; }
  img._copyUrl = img.src;       // the copy to return to when zoomed back out
  img.dataset.hires = 'on';
  img.src = orig;
}
