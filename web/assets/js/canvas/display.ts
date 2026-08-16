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
//  - A copy is made whatever the engine can encode. There is exactly one reason
//    to mount the original instead - it is already small enough - and "the
//    encoder would not write the format we asked for" is not it. See encode(),
//    where treating those two as the same answer disabled this whole module on
//    Safari and cost the crash it exists to prevent.
//
//  - The cache owns only what it made. A picture already inside the ceiling is
//    left alone and the entry points at the asset store's own object URL; that
//    URL is storage/assets.js's to revoke, not this module's. Only the WebP
//    copies this module created are revoked by clearDisplay().

import { getAsset, assetURL } from '../storage/assets.ts';
import { quality } from '../quality.ts';
import { surface, surfaceToBlob, type Surface } from './surface.ts';

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

/** Encoder quality for the copy. High enough not to band on paper. */
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
  // Deleted by identity, not by key. `pending` is cleared wholesale by
  // clearDisplay(), so a job that started before the clear and settled after it
  // deleted a key that by then pointed at a *newer* job for the same picture -
  // and the next mount, finding nothing in flight, started a second
  // full-resolution decode. Not a leak (the `won` guard drops the duplicate),
  // just work done twice on the path that exists to do it once.
  const tracked: Promise<string | null> = job.finally(() => {
    if (pending.get(key) === tracked) pending.delete(key);
  });
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
    // Through canvas/surface.js rather than `new OffscreenCanvas(...)` directly,
    // and this is the whole module's fate riding on one constructor: it landed
    // in Safari 16.4, and below that the call threw straight into the catch
    // below - which answers "leave the original alone". So on an older iOS this
    // file did nothing at all, on a device with the same per-tab memory ceiling
    // as a current one. See the header there.
    //
    // No surface is one more "leave the original alone" case, and it already
    // was one: it threw into the same catch. Said out loud now.
    const face = surface(w, h);
    if (!face) return null;
    face.ctx.drawImage(bmp, sx, sy, sw, sh, 0, 0, w, h);
    return await encode(face, blob.type);
  } catch {
    return null;
  } finally {
    bmp.close?.();
  }
}

/**
 * The card-sized canvas as bytes. **Whatever came out is kept.**
 *
 * That sentence is the fix for a crash, so it is worth saying what it replaced.
 * This used to ask for WebP and, if the blob came back as anything else, return
 * null - which this module's caller reads as "leave it alone" and answers by
 * mounting the full-resolution original. The reasoning was a file-size one
 * borrowed from optimize/picture.js, where refusing a PNG is right because that
 * module *writes to the board* and a copy larger than the original is a bad
 * trade.
 *
 * Here it was catastrophic, because **no version of Safari can encode WebP from
 * a canvas** - not on iOS, not on the desktop. So on every Safari the refusal
 * fired for every picture on the board, every card mounted its original, and
 * the one module written to stop iOS Safari killing the tab was switched off on
 * the only engine that kills tabs. Two dozen phone photographs is a gigabyte of
 * decode and a dead page; the same board on Chrome was fine, which is exactly
 * why it survived.
 *
 * The size trade the refusal was making does not exist at this end. What bounds
 * memory here is the *decode*, and a decoded bitmap is width x height x 4 bytes
 * whatever wrote it - a 1280px PNG and a 1280px WebP cost the same on screen.
 * Only the blob differs, and a few megabytes of held bytes against a hundred of
 * decode is not a trade worth losing the feature over.
 *
 * So: WebP where it works, because it is much the smallest. Where it does not,
 * one retry as JPEG - but only for a source that was already JPEG, since that
 * is the one format that provably has no alpha to lose. Anything that might be
 * a cut-out keeps the canvas's own PNG rather than gaining a black background,
 * which would be this function trading a crash for a wrong picture.
 */
async function encode(face: Surface, sourceType: string): Promise<Blob | null> {
  const first = await surfaceToBlob(face, 'image/webp', QUALITY);
  if (!first) return null;
  if (first.type.toLowerCase() === 'image/webp') return first;
  if (!/^image\/jpe?g$/i.test(sourceType)) return first;
  // A second encode, and it can only improve on the first: JPEG or not, the
  // blob that comes back is the same pixels at the same size. Falls back to
  // `first` if this engine cannot write JPEG either, which no engine does.
  try {
    const jpeg = await surfaceToBlob(face, 'image/jpeg', QUALITY);
    return jpeg?.type.toLowerCase() === 'image/jpeg' ? jpeg : first;
  } catch {
    return first;
  }
}

/**
 * Drop the copies made from these originals, and release their URLs.
 *
 * The narrow half of clearDisplay(), for the one caller that throws specific
 * bytes away rather than all of them: emptying the bin (see forgetAssets() in
 * storage/assets.ts). Without it the copy of a purged photograph would sit in
 * this cache for the rest of the session - the original gone, the derived
 * WebP still held, and nothing left that could ever ask for it.
 *
 * Every key for a hash, not the hash itself: a cropped card keys its copy as
 * `hash|x,y,w,h` (see keyFor), so one photograph cropped two ways has three
 * entries here and the bare hash finds one of them.
 *
 * `pending` is cleared for the same keys, and deliberately not awaited. A job
 * in flight publishes into `cache` when it lands, which is a copy of bytes
 * nobody can reach - harmless, one entry, and gone on the next board load.
 * Waiting for a decode inside an action somebody pressed a button for is not.
 */
export function forgetDisplay(hashes: Iterable<string>) {
  const doomed = new Set(hashes);
  // The keys taken before anything is deleted, rather than deleting as the map
  // is walked. Deleting the current entry mid-iteration happens to be defined
  // for a Map, which is exactly the kind of thing a reader has to stop and look
  // up - and the lists here are a handful of entries.
  const mine = (key: string) => doomed.has(key.split('|')[0]);
  for (const key of Array.from(cache.keys()).filter(mine)) {
    const entry = cache.get(key);
    if (entry?.own) URL.revokeObjectURL(entry.url);
    cache.delete(key);
  }
  for (const key of Array.from(pending.keys()).filter(mine)) pending.delete(key);
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
