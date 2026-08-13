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
 * The twin <img>, with the object URL it is currently showing hung off it. The
 * URL lives on the node rather than in a map here because the node is what
 * culling throws away, and a map would be the leak this property prevents.
 */
type StillImage = HTMLImageElement & { _stillUrl?: string };

let worldEl: HTMLElement | null = null;
let stilled = false;
/** How many nodes were mounted at the last sweep - see the guard in update(). */
let mounted = -1;
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
    // Guarded on the number of mounted nodes rather than run every time. The
    // sweep is a querySelectorAll across the whole world, and this runs on
    // every frame of every pan and zoom that happens to be below the freeze -
    // which is a tree walk per frame to find, almost always, nothing. The
    // count is what culling changes when it mounts something, so it answers
    // "is there anything new to look at" for the price of reading a property.
    if (!want) return;
    if (world.childElementCount === mounted) return;
    mounted = world.childElementCount;
    capture(false);
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
    // The twin is built as the GIF's next sibling <img> by the renderer - the
    // `.still` class is what says so, so the assertion is the class test.
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
  let canvas: OffscreenCanvas;
  try {
    canvas = new OffscreenCanvas(w, h);
    const ctx = canvas.getContext('2d');
    // A context this browser will not hand over lands where the throw did.
    if (!ctx) return;
    ctx.drawImage(img, 0, 0, w, h);
  } catch {
    return;
  }
  canvas.convertToBlob({ type: 'image/webp', quality: 0.8 }).then(blob => {
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
