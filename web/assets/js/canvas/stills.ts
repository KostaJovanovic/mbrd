// Freezing GIFs when the board is zoomed out.
//
// Past a certain distance an animation stops being content and becomes
// flicker: at 30% a GIF is a postage stamp, nothing in it is legible, and a
// board with a dozen of them is a field of twitching confetti that pulls the
// eye away from whatever you actually zoomed out to see. So they hold still.
//
// A browser gives no way to pause an <img>, so this works the way an animator
// would: it shoots a frame. Each animated item carries a second, static <img>
// alongside it; crossing the threshold paints the GIF's *current* frame into
// that twin and swaps which of the two is displayed. The GIF element stays
// loaded and merely stops being rendered - which is also what stops it
// advancing, since engines do not run animations for images they are not
// painting - so coming back in resumes rather than re-downloading.
//
// The twin is a sibling <img>, not a <canvas> overlay, on purpose: it inherits
// the exact same sizing and object-fit rules as the picture it stands in for,
// so a `contain` item does not become a `cover` one for as long as it is
// frozen.

import { bus } from '../state.ts';
import { quality } from '../quality.ts';
import { stillZoom } from './viewport.ts';
import { surface, surfaceToBlob } from './surface.ts';
import type { Viewport } from './viewport.ts';

/** Long edge of a captured frame. It is only ever shown at a third size. */
const MAX_STILL = 640;

/**
 * All this module wants of the viewport: the magnification, and somewhere to
 * hear that it moved. Named off `Viewport` rather than restated, because that
 * really is the whole of the dependency and the two facts should not be able to
 * disagree - the class declares its fields now, so a subset of it can be taken
 * instead of described.
 */
type ZoomSource = Pick<Viewport, 'zoom' | 'onChange'>;

/**
 * The twin <img>, with the object URL it is currently showing hung off it.
 *
 * The URL lives on the node rather than in a map here because the node is what
 * culling throws away - and the reason that is not the whole story is the whole
 * of releaseStills() below. A blob URL is an entry in the *document's* URL
 * store, not a property of the element that names it: throwing the node away
 * throws away the string and leaves the blob where it was, for the life of the
 * tab. Zoom out below stillZoom() on a board of thirty GIFs, pan until they are
 * discarded, come back: one WebP per GIF per freeze, pinned.
 */
type StillImage = HTMLImageElement & { _stillUrl?: string };

/**
 * Give back every frozen frame inside `el`. Called by discard() in
 * canvas/items.ts, beside the src-clearing it does for the same reason.
 *
 * Not called by culling, which puts the same node back and wants the frame it
 * had. The two are told apart there and this is the discard half.
 */
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
    // `<`, matching the zoom-far toggle in viewport.js. The two read the same
    // rung, so the comparison has to agree as well or the one zoom that sits
    // exactly on it would freeze the pictures while leaving the chrome up.
    //
    // Or unconditionally, when the quality dial has taken motion away. That is
    // also the only thing that reaches a Mobile board: its fitted zoom never
    // drops below stillZoom() on touch, so distance alone never freezes a GIF
    // on a phone - which is where a field of them costs the most.
    const want = !quality.motion || vp.zoom < stillZoom();
    if (want !== stilled) {
      stilled = want;
      // Shoot before swapping, so what freezes is the frame that was on
      // screen at the moment it stopped rather than whatever came after.
      if (want) capture(true);
      world.classList.toggle('is-stilled', want);
      return;
    }
    // Still zoomed out: catch anything that has been mounted since the last
    // pass. Culling remounts items as you pan, and a GIF that arrived after
    // the freeze has no frame of its own yet.
    //
    // Throttled to a frame rather than guarded on a count. The sweep is a
    // querySelectorAll across the whole world, and this runs on every frame of
    // every pan and zoom that happens to be below the freeze - a tree walk per
    // frame to find, almost always, nothing.
    //
    // It was guarded on `world.childElementCount`, which is the wrong question
    // asked cheaply: a pan across a large board mounts and discards in the same
    // onChange pass, so the count is frequently unchanged while the *set* is
    // not, and a GIF that arrived in one of those passes never had capture()
    // run over it. It kept animating with `is-stilled` on - the one state this
    // module exists to prevent, in the case it is most likely to happen.
    //
    // A rAF coalesces every onChange in a frame into one sweep, which is the
    // same saving the count was after and does not depend on guessing what
    // changed.
    if (!want) return;
    if (sweep) return;
    sweep = requestAnimationFrame(() => { sweep = 0; capture(false); });
  };

  recheck = update;
  vp.onChange(update);
  bus.on('items', () => { if (stilled) capture(false); });
  update();
}

/**
 * Ask the freeze question again without the view having moved.
 *
 * The one caller is the quality dial: motion is the only input to this module
 * that is not the zoom, and nothing else can change it. A no-op before
 * initStills().
 */
export const refreshStills = () => recheck();

/** @param force  true to re-shoot every twin, false to fill in only the blanks. */
function capture(force: boolean) {
  if (!worldEl) return;
  for (const img of worldEl.querySelectorAll<HTMLImageElement>('img[data-gif]')) {
    // SAFETY: the twin is built as the GIF's next sibling <img> by the renderer,
    // and the `.still` class on the next line is what says so - the assertion is
    // that test, which runs before anything is read off it.
    const twin = img.nextElementSibling as StillImage | null;
    if (!twin?.classList.contains('still')) continue;
    if (!force && twin.classList.contains('is-ready')) continue;
    shoot(img, twin);
  }
}

function shoot(img: HTMLImageElement, twin: StillImage) {
  // Nothing has been decoded yet - there is no frame to take. The next pass
  // picks it up, and until then the GIF simply keeps playing.
  if (!img.complete || !img.naturalWidth) return;
  const scale = Math.min(1, MAX_STILL / Math.max(img.naturalWidth, img.naturalHeight));
  const w = Math.max(1, Math.round(img.naturalWidth * scale));
  const h = Math.max(1, Math.round(img.naturalHeight * scale));
  // Draw the current frame now - synchronously, before the GIF advances a
  // frame - but leave the encode to an async convertToBlob. capture(true) runs
  // mid zoom-out, once per mounted GIF; a synchronous toDataURL('image/png')
  // per twin blocked that gesture frame. OffscreenCanvas + WebP matches what
  // poster.js/display.js already do for exactly this reason.
  // Through canvas/surface.js, which falls back to an ordinary <canvas> where
  // OffscreenCanvas does not exist - Safari before 16.4, where this used to
  // land in the catch below and every GIF simply kept animating at every zoom.
  let face;
  try {
    face = surface(w, h);
    // A surface this browser will not hand over lands where the throw did.
    if (!face) return;
    face.ctx.drawImage(img, 0, 0, w, h);
  } catch {
    return;
  }
  surfaceToBlob(face, 'image/webp', 0.8).then(blob => {
    if (!blob) return;
    const url = URL.createObjectURL(blob);
    // is-ready is set on load rather than here: the attribute lands
    // immediately but the blob still has to decode, and switching to it early
    // would show a blank where the picture was. The previous frame's object
    // URL is revoked once the new one has painted, so re-shoots do not leak.
    twin.addEventListener('load', () => {
      twin.classList.add('is-ready');
      if (twin._stillUrl) URL.revokeObjectURL(twin._stillUrl);
      twin._stillUrl = url;
    }, { once: true });
    twin.src = url;
  }).catch(() => {
    // A tainted canvas rejects here. Better a GIF that keeps playing than a
    // blank square.
  });
}
