// Freeze GIFs when zoomed out — past a threshold, animation is just flicker.
// Each animated item has a twin <img>; crossing the threshold captures the
// current frame into the twin and swaps display. Twin is <img> (not canvas)
// so it inherits the same sizing/object-fit rules.

import { bus } from '../state.ts';
import { quality } from '../quality.ts';
import { stillZoom } from './viewport.ts';
import { surface, surfaceToBlob } from './surface.ts';
import type { Viewport } from './viewport.ts';

/** Long edge of a captured frame. It is only ever shown at a third size. */
const MAX_STILL = 640;

/** Minimal viewport dependency: zoom level and change listener. */
type ZoomSource = Pick<Viewport, 'zoom' | 'onChange'>;

/** Twin <img> with its current blob URL. URL tracked on the node so
 * releaseStills() can revoke it — blob URLs outlive the element otherwise. */
type StillImage = HTMLImageElement & { _stillUrl?: string };

/** Revoke blob URLs and reset all frozen twins inside `el`. Called on discard,
 * not on cull (culled nodes keep their frame for remount). */
export function releaseStills(el: Element): void {
  for (const twin of el.querySelectorAll<StillImage>('img.still')) {
    if (twin._stillUrl) URL.revokeObjectURL(twin._stillUrl);
    twin._stillUrl = undefined;
    twin.classList.remove('is-ready');
  }
}

let worldEl: HTMLElement | null = null;
let stilled = false;
/** A sweep already booked for this frame - see the throttle in update(). */
let sweep = 0;
/** The live update, so a quality change can ask the question again. */
let recheck = () => {};

export function initStills(world: HTMLElement, vp: ZoomSource): void {
  worldEl = world;

  const update = () => {
    // Matches viewport.ts's `<` for the same rung. Also freezes when
    // quality.motion is off — the only way to reach Mobile boards.
    const want = !quality.motion || vp.zoom < stillZoom();
    if (want !== stilled) {
      stilled = want;
      // Shoot before swapping — capture the frame that was visible.
      if (want) capture(true);
      world.classList.toggle('is-stilled', want);
      return;
    }
    // Still frozen: catch GIFs remounted by culling since last pass. Throttled
    // to one rAF sweep per frame — childElementCount cannot detect set changes.
    if (!want) return;
    if (sweep) return;
    sweep = requestAnimationFrame(() => { sweep = 0; capture(false); });
  };

  recheck = update;
  vp.onChange(update);
  bus.on('items', () => { if (stilled) capture(false); });
  update();
}

/** Re-evaluate freeze state. Called by the quality dial when motion changes. */
export const refreshStills = () => recheck();

/** @param force  true to re-shoot every twin, false to fill in only the blanks. */
function capture(force: boolean) {
  if (!worldEl) return;
  for (const img of worldEl.querySelectorAll<HTMLImageElement>('img[data-gif]')) {
    // Twin is the GIF's next sibling, verified by .still class.
    const twin = img.nextElementSibling as StillImage | null;
    if (!twin?.classList.contains('still')) continue;
    if (!force && twin.classList.contains('is-ready')) continue;
    shoot(img, twin);
  }
}

function shoot(img: HTMLImageElement, twin: StillImage) {
  // Not decoded yet — next pass picks it up.
  if (!img.complete || !img.naturalWidth) return;
  const scale = Math.min(1, MAX_STILL / Math.max(img.naturalWidth, img.naturalHeight));
  const w = Math.max(1, Math.round(img.naturalWidth * scale));
  const h = Math.max(1, Math.round(img.naturalHeight * scale));
  // Draw synchronously (before the GIF advances), encode async via surface.ts
  // to avoid blocking the zoom gesture frame.
  let face;
  try {
    face = surface(w, h);
    // null surface = unsupported browser, same as a throw.
    if (!face) return;
    face.ctx.drawImage(img, 0, 0, w, h);
  } catch {
    return;
  }
  surfaceToBlob(face, 'image/webp', 0.8).then(blob => {
    if (!blob) return;
    const url = URL.createObjectURL(blob);
    // Wait for load before showing — avoids a blank flash. Revoke old URL after.
    twin.addEventListener('load', () => {
      twin.classList.add('is-ready');
      if (twin._stillUrl) URL.revokeObjectURL(twin._stillUrl);
      twin._stillUrl = url;
    }, { once: true });
    twin.src = url;
  }).catch(() => {
    // Tainted canvas — let the GIF keep playing rather than show blank.
  });
}
