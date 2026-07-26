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

import { bus } from '../state.js';
import { stillZoom } from './viewport.js';

/** Long edge of a captured frame. It is only ever shown at a third size. */
const MAX_STILL = 640;

let worldEl = null;
let stilled = false;
/** How many nodes were mounted at the last sweep - see the guard in update(). */
let mounted = -1;

export function initStills(world, vp) {
  worldEl = world;

  const update = () => {
    // `<`, matching the zoom-far toggle in viewport.js. The two read the same
    // rung, so the comparison has to agree as well or the one zoom that sits
    // exactly on it would freeze the pictures while leaving the chrome up.
    const want = vp.zoom < stillZoom();
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

  vp.onChange(update);
  bus.on('items', () => { if (stilled) capture(false); });
  update();
}

/** @param force  true to re-shoot every twin, false to fill in only the blanks. */
function capture(force) {
  if (!worldEl) return;
  for (const img of worldEl.querySelectorAll('img[data-gif]')) {
    const twin = img.nextElementSibling;
    if (!twin?.classList.contains('still')) continue;
    if (!force && twin.classList.contains('is-ready')) continue;
    shoot(img, twin);
  }
}

function shoot(img, twin) {
  // Nothing has been decoded yet - there is no frame to take. The next pass
  // picks it up, and until then the GIF simply keeps playing.
  if (!img.complete || !img.naturalWidth) return;
  const scale = Math.min(1, MAX_STILL / Math.max(img.naturalWidth, img.naturalHeight));
  const w = Math.max(1, Math.round(img.naturalWidth * scale));
  const h = Math.max(1, Math.round(img.naturalHeight * scale));
  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  try {
    canvas.getContext('2d').drawImage(img, 0, 0, w, h);
    // is-ready is set on load rather than here: the attribute lands
    // immediately but the data URL still has to decode, and switching to it
    // early would show a blank where the picture was.
    twin.addEventListener('load', () => twin.classList.add('is-ready'), { once: true });
    twin.src = canvas.toDataURL('image/png');
  } catch {
    // A tainted canvas. Better a GIF that keeps playing than a blank square.
  }
}
