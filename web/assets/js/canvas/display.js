// Display-resolution pictures: mount a bounded copy, keep the original for export.
//
// The board stores every photograph at the resolution it arrived - a phone
// picture is six or eight thousand pixels on a side. A card is a few hundred
// world units and a screen is worth about two device pixels per unit, so the
// pixels past ~1200 on the long edge never reach the eye; the browser decodes
// them anyway, and a decoded bitmap is naturalWidth x naturalHeight x 4 bytes
// regardless of how small the card is drawn. One 6000x4000 photo is ~96 MB of
// decode. A board of them, all mounted at once - which is exactly what zooming
// out to frame the whole board does (see sync() in canvas/items.js) - is why
// iOS Safari kills the tab with fewer than fifty items on screen.
//
// So the renderer mounts a *display copy* instead: a card-sized WebP made once,
// held for the session, keyed by the same content hash the asset store uses.
// The original bytes stay in storage/assets.js for export and for the manual
// optimize step; only what the <img> decodes changes.
//
// Two properties matter for not making the problem worse while fixing it:
//
//  - Generation is serialized. Making a display copy means decoding the full
//    original once (createImageBitmap), and doing that to fifty photos in
//    parallel would hold fifty full decodes at once - the very crash this
//    avoids. The queue below runs one at a time, and each bitmap is closed
//    before the next starts, so at most one full-resolution decode is ever
//    live. Mid-generation the cards show their hundred-pixel thumbnail (or
//    nothing), never the full-res original, so memory stays bounded throughout.
//
//  - The cache owns only what it made. A picture already inside the ceiling is
//    left alone and the entry points at the asset store's own object URL; that
//    URL is storage/assets.js's to revoke, not this module's. Only the WebP
//    copies this module created are revoked by clearDisplay().

import { getAsset, assetURL } from '../storage/assets.js';
import { quality } from '../quality.js';

/**
 * The long edge a display copy is allowed to keep. Matches the reasoning behind
 * optimize's MAX_SIDE (1200): far enough that the picture stops being what
 * limits the view, close enough that a full board of copies is a few hundred
 * megabytes of decode rather than several gigabytes.
 *
 * Now the quality dial's, rather than a constant - lower is safer on old
 * phones, higher is crisper on a card zoomed right in, which is exactly the
 * trade that dial exists to offer. 1280 is its top stop, so nothing moved for
 * anyone who never touches it.
 *
 * The cache below is keyed by content hash alone, so this must not change
 * without emptying it: a copy made at 1024 would otherwise be served for the
 * rest of the session. ui/quality.js answers a change with resetItems(), which
 * calls clearDisplay() on the way through.
 */
const displayMax = () => quality.sharpness;

/** WebP quality for the copy. High enough not to band on paper. */
const QUALITY = 0.82;

/** hash -> { url, own }. own=false when the entry points at the original's URL. */
const cache = new Map();
/** hash -> in-flight Promise<url|null>, so two mounts of one photo share a job. */
const pending = new Map();
/** The serialization chain: one full decode live at a time. */
let queue = Promise.resolve();

/**
 * The display URL for a hash if it is already made, else null. Synchronous, so a
 * re-mount of a picture whose copy exists (panned back into view, say) sets its
 * src at once with no flicker.
 */
export function displayURLReady(hash) {
  return cache.get(hash)?.url || null;
}

/**
 * Make the display copy for a hash if it does not exist yet, and resolve to its
 * URL. Idempotent and shared: repeated calls for the same hash return the one
 * in-flight or finished job. Resolves to null only if the asset is gone.
 */
export function ensureDisplay(hash) {
  const done = cache.get(hash);
  if (done) return Promise.resolve(done.url);
  const inFlight = pending.get(hash);
  if (inFlight) return inFlight;
  // Chain onto the queue so generation is serial; keep the chain alive past a
  // failure so one undecodable file does not stall every picture behind it.
  const job = queue.then(() => generate(hash));
  queue = job.catch(() => {});
  const tracked = job.finally(() => pending.delete(hash));
  pending.set(hash, tracked);
  return tracked;
}

async function generate(hash) {
  const existing = cache.get(hash);
  if (existing) return existing.url;
  const a = getAsset(hash);
  if (!a) return null;
  const small = await shrink(a.blob);
  // A copy that came out is ours to revoke; a picture already small enough rides
  // the asset store's own URL, which assets.js revokes - do not double-manage it.
  const entry = small
    ? { url: URL.createObjectURL(small), own: true }
    : { url: assetURL(hash), own: false };
  cache.set(hash, entry);
  return entry.url;
}

/**
 * A card-sized WebP of a picture, or null to mount the original as-is.
 *
 * Null for the ordinary "leave it alone" cases - already within the ceiling,
 * the browser cannot decode it - because those are not failures: the original is
 * already a fine thing to mount. Same four-call shape as optimize/picture.js.
 */
async function shrink(blob) {
  if (!blob || !/^image\//i.test(blob.type)) return null;
  let bmp;
  try {
    bmp = await createImageBitmap(blob);
  } catch {
    return null;
  }
  try {
    const scale = Math.min(1, displayMax() / Math.max(bmp.width, bmp.height));
    if (scale === 1) return null;   // already inside the ceiling: mount the original
    const w = Math.max(1, Math.round(bmp.width * scale));
    const h = Math.max(1, Math.round(bmp.height * scale));
    const canvas = new OffscreenCanvas(w, h);
    const ctx = canvas.getContext('2d', { alpha: true });
    // Default is 'low' on some engines, which aliases every hard edge on a big
    // downscale.
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(bmp, 0, 0, w, h);
    // A browser that cannot write WebP hands back a PNG silently, which would be
    // a copy larger than the original - refuse it and mount the original instead.
    const out = await canvas.convertToBlob({ type: 'image/webp', quality: QUALITY });
    if (!out || out.type.toLowerCase() !== 'image/webp') return null;
    return out;
  } catch {
    return null;
  } finally {
    bmp.close?.();
  }
}

/**
 * Drop every copy and release the URLs this module made. Called on board load
 * and close, beside the asset store's own clear - the copies are keyed by
 * content hash, and a new board is new content.
 */
export function clearDisplay() {
  for (const e of cache.values()) if (e.own) URL.revokeObjectURL(e.url);
  cache.clear();
  pending.clear();
  queue = Promise.resolve();
}
