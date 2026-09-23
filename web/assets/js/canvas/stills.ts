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

/** Minimal viewport dependency: zoom level, whether it is mid-gesture, and a
 *  change listener. `moving` absent (a test's stand-in) reads as at rest, which
 *  is the behaviour this module had before it asked. */
type ZoomSource = Pick<Viewport, 'zoom' | 'onChange'> & Partial<Pick<Viewport, 'moving'>>;

/** Twin <img> with its current blob URL, and the one still loading. Tracked on
 * the node so releaseStills() can revoke them — blob URLs outlive the element
 * otherwise. */
type StillImage = HTMLImageElement & { _stillUrl?: string, _nextUrl?: string };

/** Twins whose card was thrown away while a frame was being encoded. */
const released = new WeakSet<StillImage>();

/** Revoke blob URLs and reset all frozen twins inside `el`. Called on discard,
 * not on cull (culled nodes keep their frame for remount). */
export function releaseStills(el: Element): void {
  for (const twin of el.querySelectorAll<StillImage>('img.still')) {
    if (twin._stillUrl) URL.revokeObjectURL(twin._stillUrl);
    if (twin._nextUrl) URL.revokeObjectURL(twin._nextUrl);
    twin._stillUrl = undefined;
    twin._nextUrl = undefined;
    twin.classList.remove('is-ready');
    released.add(twin);
  }
}

let worldEl: HTMLElement | null = null;
let stilled = false;
/** A sweep already booked for this frame - see the throttle in update(). */
let sweep = 0;
/** A capture the gesture put off, taken on the settling frame - see update(). */
let owed = false;
/** The live update, so a quality change can ask the question again. */
let recheck = () => {};

export function initStills(world: HTMLElement, vp: ZoomSource): void {
  worldEl = world;

  const update = () => {
    // Two reasons to hold a GIF, and two classes. The rung (matching
    // viewport.ts's `<`) is is-stilled, which also swaps every photograph to
    // its hundred-pixel thumbnail (items.css). quality.motion off - the only
    // way to reach Mobile boards - is is-held, which touches GIFs alone: it
    // used to set is-stilled too, and Light drew every photo from its thumbnail
    // at every zoom, blinking each card as the swap landed.
    const far = vp.zoom < stillZoom();
    const held = !quality.motion;
    const want = far || held;
    // Not while the board is moving, and this is the one line that keeps a
    // pinch smooth. A shot is a readback of pixels from the GPU, and a traced
    // pinch on an Android phone put each one at about 110ms - a hitch you can
    // see, landing exactly on the frame that crosses the rung. Owed instead,
    // and paid on the settling frame, which the viewport emits for precisely
    // this kind of work. What it costs is a GIF that plays on for the length of
    // the gesture: the twin has no frame yet, no rule swaps to a twin without
    // `is-ready`, so the card keeps showing the real picture until it does.
    const still = !vp.moving;
    if (want !== stilled) {
      stilled = want;
      // Shoot before swapping — capture the frame that was visible.
      if (want) { if (still) capture(true); else owed = true; }
    } else if (want && owed && still) {
      owed = false;
      capture(true);
    } else if (want && still && !sweep) {
      // Still frozen: catch GIFs remounted by culling since last pass. Throttled
      // to one rAF sweep per frame — childElementCount cannot detect set changes.
      sweep = requestAnimationFrame(() => { sweep = 0; capture(false); });
    }
    // Forced toggles, so a frame on the same side of both writes nothing.
    //
    // Towards the thumbnails at once, even mid-gesture; back to the display
    // copies only once the view stops. A zoom-out is what crosses the rung
    // going far, and everything it brings into view - and all of it again at
    // each re-pin (viewport.ts's _pin) - is rastered from whatever the cards
    // show: every card's 1280px display copy, decoded and shrunk, if the swap
    // waits. On a Galaxy S22+ that was three to five frames of 60-175ms around
    // 25%, and swapping on the crossing frame leaves 25-50ms at worst. The swap
    // itself restyles the board, about 14ms there (95ms on a Galaxy S10 once,
    // under a :has() rule since removed). The other way stays held: the display
    // copies are the expensive raster, and landing them mid-gesture is that hitch.
    if (still || far) world.classList.toggle('is-stilled', far);
    world.classList.toggle('is-held', held);
  };

  recheck = update;
  vp.onChange(update);
  bus.on('items', () => { if (stilled) capture(false); });
  update();
}

/** Re-evaluate freeze state. Called by the quality dial when motion changes. */
export const refreshStills = () => recheck();

/**
 * Shoot the twins under `el`, so something else can hold those GIFs still with
 * a class of its own - the cleaning mode parks a dirty card's GIF until the card
 * comes clean (clean.css).
 *
 * Fills in blanks only. A twin that never gets its frame stays without
 * `is-ready`, and every rule that swaps to one asks for that class: the worst a
 * failed capture can do is leave the GIF playing, never blank the card.
 */
export function captureStills(el: Element): void {
  capture(false, el);
}

/** @param force  true to re-shoot every twin, false to fill in only the blanks. */
function capture(force: boolean, root: Element | null = worldEl) {
  if (!root) return;
  for (const img of root.querySelectorAll<HTMLImageElement>('img[data-gif]')) {
    // SAFETY: the twin is the GIF's next sibling. Every .still built (renderers.ts, model.ts)
    // is an <img>, and the class is tested next.
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
    // A card discarded during the encode already ran releaseStills(), so a URL
    // made now would be revoked by nothing.
    if (!blob || released.has(twin)) return;
    const url = URL.createObjectURL(blob);
    // Wait for load before showing — avoids a blank flash. Revoke old URL after.
    twin.addEventListener('load', () => {
      twin.classList.add('is-ready');
      if (twin._stillUrl) URL.revokeObjectURL(twin._stillUrl);
      twin._stillUrl = url;
      if (twin._nextUrl === url) twin._nextUrl = undefined;
    }, { once: true });
    // Until it loads, the only record of it: a release in that window takes
    // the src away, so no load comes to file it as _stillUrl.
    twin._nextUrl = url;
    twin.src = url;
  }).catch(() => {
    // Tainted canvas — let the GIF keep playing rather than show blank.
  });
}
