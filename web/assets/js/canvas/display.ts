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

import { getAsset, assetURL } from '../storage/assets.ts';
import { quality } from '../quality.ts';

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

/**
 * The rectangle of the source a copy keeps: four fractions, or null for all of
 * it. See itemCrop() in board-model.ts, which is where the shape is defined and
 * validated; this module only draws what it is handed.
 *
 * **The crop is baked into the display copy, and that is the whole design.**
 * The alternative was CSS - an oversized <img> inside an overflow-hidden box,
 * offset by a percentage - and it fails on the thing this app cares about
 * most: object-fit. A card's picture is already being fitted or filled inside
 * its box, and object-fit works on the whole image, so a CSS crop would have
 * had to reimplement cover/contain arithmetic over a sub-rectangle at every
 * card size and every zoom. Cropping the pixels instead means everything
 * downstream - fit, the far-zoom twin, the aspect the card adopts on load -
 * carries on working without knowing crops exist.
 *
 * It costs one WebP per distinct crop of a picture, held for the session. A
 * board where the same photograph is cropped three ways holds three copies,
 * which is correct, and re-cropping one card leaves the previous rectangle's
 * copy behind until the board closes. Card-sized, so that is tens of kilobytes
 * per abandoned attempt rather than megabytes, and clearDisplay() collects the
 * lot on the next board load.
 */
export type Crop = { x: number, y: number, w: number, h: number } | null;

/**
 * The cache key: the content hash, plus the rectangle when there is one.
 *
 * The uncropped key is the bare hash and not `hash|0,0,1,1`, so every entry
 * made before crops existed keys exactly as it did - and, more to the point, so
 * the common case stays one string concatenation of nothing.
 */
const keyFor = (hash: string, crop: Crop) =>
  (crop ? `${hash}|${crop.x},${crop.y},${crop.w},${crop.h}` : hash);

/** key -> { url, own }. own=false when the entry points at the original's URL. */
const cache = new Map<string, { url: string; own: boolean }>();
/** key -> in-flight Promise<url|null>, so two mounts of one photo share a job. */
const pending = new Map<string, Promise<string | null>>();
/** The serialization chain: one full decode live at a time. */
let queue: Promise<unknown> = Promise.resolve();
/**
 * Bumped by clearDisplay(). A job carries the epoch it started under and
 * publishes nothing if that has moved on - see generate(). Generation is
 * asynchronous and a full decode is slow, so a board load or a sharpness change
 * lands mid-flight often enough to matter, not rarely.
 */
let epoch = 0;

/**
 * The display URL for a hash if it is already made, else null. Synchronous, so a
 * re-mount of a picture whose copy exists (panned back into view, say) sets its
 * src at once with no flicker.
 */
export function displayURLReady(hash: string, crop: Crop = null): string | null {
  return cache.get(keyFor(hash, crop))?.url || null;
}

/**
 * Make the display copy for a hash if it does not exist yet, and resolve to its
 * URL. Idempotent and shared: repeated calls for the same hash return the one
 * in-flight or finished job. Resolves to null only if the asset is gone.
 */
export function ensureDisplay(hash: string, crop: Crop = null): Promise<string | null> {
  const key = keyFor(hash, crop);
  const done = cache.get(key);
  if (done) return Promise.resolve(done.url);
  const inFlight = pending.get(key);
  if (inFlight) return inFlight;
  // Chain onto the queue so generation is serial; keep the chain alive past a
  // failure so one undecodable file does not stall every picture behind it.
  const mine = epoch;
  const job = queue.then(() => generate(hash, crop, mine));
  queue = job.catch(() => {});
  const tracked = job.finally(() => pending.delete(key));
  pending.set(key, tracked);
  return tracked;
}

async function generate(hash: string, crop: Crop, mine: number): Promise<string | null> {
  const key = keyFor(hash, crop);
  const existing = cache.get(key);
  if (existing) return existing.url;
  const a = getAsset(hash);
  if (!a) return null;
  const small = await shrink(a.blob, crop);
  // A clear landed while that decode ran - a new board, or a new sharpness
  // ceiling. Publishing now would put back a copy the clear meant to drop, at a
  // resolution nobody asked for, and the entry would outlive the board it came
  // from. Checked before createObjectURL rather than after, so a refused job
  // has nothing to revoke and cannot leak. Callers read null as "no copy yet",
  // which is true, and resetItems() remounts every card behind the clear anyway.
  if (mine !== epoch) return null;
  // Two jobs for one key can only exist across a clear, which empties pending.
  // If the later one already published, keep its entry: it was made under the
  // current ceiling. Dropping `small` here is free - no URL was ever handed out.
  const won = cache.get(key);
  if (won) return won.url;
  // A copy that came out is ours to revoke; a picture already small enough rides
  // the asset store's own URL, which assets.js revokes - do not double-manage it.
  // assetURL() is null only for a hash the store does not hold, and getAsset()
  // above already proved it holds this one - so the assertion cannot fire.
  const entry = small
    ? { url: URL.createObjectURL(small), own: true }
    : { url: assetURL(hash)!, own: false };
  cache.set(key, entry);
  return entry.url;
}

/**
 * A card-sized WebP of a picture, or null to mount the original as-is.
 *
 * Null for the ordinary "leave it alone" cases - already within the ceiling,
 * the browser cannot decode it - because those are not failures: the original is
 * already a fine thing to mount. Same four-call shape as optimize/picture.js.
 */
async function shrink(blob: Blob | null | undefined, crop: Crop = null): Promise<Blob | null> {
  if (!blob || !/^image\//i.test(blob.type)) return null;
  let bmp;
  try {
    bmp = await createImageBitmap(blob);
  } catch {
    return null;
  }
  try {
    // The region being kept, in the source's own pixels. The whole picture when
    // there is no crop, which is what makes the two paths one piece of code.
    const sx = crop ? Math.round(crop.x * bmp.width) : 0;
    const sy = crop ? Math.round(crop.y * bmp.height) : 0;
    const sw = Math.max(1, crop ? Math.round(crop.w * bmp.width) : bmp.width);
    const sh = Math.max(1, crop ? Math.round(crop.h * bmp.height) : bmp.height);
    const scale = Math.min(1, displayMax() / Math.max(sw, sh));
    // Already inside the ceiling: mount the original - but only when there is no
    // crop to apply. A cropped picture always needs a copy made, however small
    // it is, because the copy *is* the crop. This is the one branch where the
    // two paths genuinely differ.
    if (scale === 1 && !crop) return null;
    const w = Math.max(1, Math.round(sw * scale));
    const h = Math.max(1, Math.round(sh * scale));
    const canvas = new OffscreenCanvas(w, h);
    const ctx = canvas.getContext('2d', { alpha: true });
    // No 2d context is one more "leave the original alone" case, and it already
    // was one: reaching for a property of null threw straight into the catch
    // below, which returns null. Said out loud now that the type says it can be.
    if (!ctx) return null;
    // Default is 'low' on some engines, which aliases every hard edge on a big
    // downscale.
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(bmp, sx, sy, sw, sh, 0, 0, w, h);
    // A browser that cannot write WebP hands back a PNG silently, which would be
    // a copy larger than the original - refuse it and mount the original instead.
    //
    // Unless there is a crop, where "mount the original" is not a graceful
    // fallback but a wrong picture: the card would show the whole photograph
    // where the person cropped it to a detail, silently and only on that
    // engine. A larger-than-ideal PNG of the right rectangle beats a
    // right-sized picture of the wrong one, so the size trade is taken the
    // other way round here and the copy is kept whatever came out.
    const out = await canvas.convertToBlob({ type: 'image/webp', quality: QUALITY });
    if (!out) return null;
    if (out.type.toLowerCase() !== 'image/webp' && !crop) return null;
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
  // Not queue = Promise.resolve(). A decode in flight right now is still
  // holding a full-resolution bitmap, and a fresh chain would let the next one
  // start alongside it - two full decodes live at once, which is the crash this
  // module exists to prevent. The chain stays; the epoch bump above is what
  // stops the stale job from publishing, and it costs nothing to let it finish.
  epoch++;
}
