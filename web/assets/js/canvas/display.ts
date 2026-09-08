// Display-resolution pictures: mount a bounded copy, keep the original for export.
//
// The board stores every photograph at the resolution it arrived - a phone
// picture is six or eight thousand pixels on a side. A card is a few hundred
// world units and a screen is worth about two device pixels per unit, so the
// pixels past ~1200 on the long edge never reach the eye; the browser decodes
// them anyway, and a decoded bitmap is naturalWidth x naturalHeight x 4 bytes
// regardless of how small the card is drawn. One 6000x4000 photo is ~96 MB of
// decode. A board of them, all mounted at once - which is exactly what zooming
// out to frame the whole board does (see sync() in canvas/items.ts) - is why
// iOS Safari kills the tab with fewer than fifty items on screen.
//
// So the renderer mounts a *display copy* instead: a card-sized WebP made once,
// held for the session, keyed by the same content hash the asset store uses.
// The original bytes stay in storage/assets.ts for export and for the manual
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
//    URL is storage/assets.ts's to revoke, not this module's. Only the WebP
//    copies this module created are revoked by clearDisplay().
//
// ── One kind of copy outlives the session ──
//
// Held-for-the-session is right for a copy that costs a decode and an encode.
// It is wrong for a copy that ran a neural network to exist: a matted card is a
// pass through u2netp (canvas/matte.ts), serialized against every other matted
// card, and session-only meant a board of cut-outs re-derived all of them, in
// order, on every load, arriving at the same bytes each time. So those - and
// only those - are also written to storage/matte-cache.ts and read back on the
// next load. Everything about that cache is derived and droppable; what this
// module owes it is a key that changes whenever the pixels would, which is what
// persistKey() below is, and the truth about whether the model actually ran,
// which is what `knocked` is.

import { getAsset, assetURL } from '../storage/assets.ts';
import { loadMatte, saveMatte, forgetMatte } from '../storage/matte-cache.ts';
import { quality } from '../quality.ts';
import { cutout, MODEL_NAME, ORT_VERSION } from './matte.ts';
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
 * rest of the session. ui/quality.ts answers a change with resetItems(), which
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
 * The other two things baked in beside the crop, and why they are baked at all.
 *
 * `rot` is a quarter turn - 90, 180 or 270 clockwise, or null. It is here rather
 * than on the card as a CSS transform for one reason, argued in full at
 * itemRotate() in board-model.ts: a quarter turn swaps the box, so a card that
 * turned its picture with the compositor would still be laying out, fitting and
 * far-zooming the shape of the untouched file.
 *
 * `matte` is whether the background is taken out. It is here because there is no
 * CSS that does it at all - see canvas/matte.ts, which is the model and the
 * argument for it.
 *
 * **Both are applied to the region the crop left, in that order**, so the crop
 * stays four fractions of the source and a reader that carries either key
 * through without understanding it still cuts the right slice.
 */
export type Turn = 90 | 180 | 270 | null;
export type Matte = boolean;

/**
 * The cache key: the content hash, plus whatever of the three there is.
 *
 * The plain key is the bare hash and not `hash|0,0,1,1@0%0`, so every entry made
 * before any of this existed keys exactly as it did - and, more to the point, so
 * the common case stays one string concatenation of nothing. Each part carries
 * its own sigil, so a picture that is only turned and a picture that is only
 * matted cannot collide.
 */
const keyFor = (hash: string, crop: Crop, rot: Turn, matte: Matte) =>
  hash
  + (crop ? `|${crop.x},${crop.y},${crop.w},${crop.h}` : '')
  + (rot ? `@${rot}` : '')
  + (matte ? '%' : '');

/** Whether a copy has to be made at all, whatever size the original already is. */
const derived = (crop: Crop, rot: Turn, matte: Matte) => !!(crop || rot || matte);

/**
 * Bumped by hand when this module would draw the same picture differently.
 *
 * The in-memory cache never needed one - it dies with the page, so a change to
 * the drawing takes effect on the next load whatever the key says. The persisted
 * one does: an entry written by the build before a change to the crop
 * arithmetic, the rotation, or the way the mask is composited would be served
 * for as long as it survives eviction, and the picture would be subtly wrong
 * with nothing to point at. Bump this and every stale entry misses once.
 *
 * The numbers that already move on their own are in persistKey() rather than
 * here, so the only thing left to remember is a change to the *code*.
 */
const COPY_REV = 1;

/**
 * The key the persisted cut-out cache is asked under: everything that moved a
 * pixel, spelled out.
 *
 * The hash and the three edits come from keyFor above, so the two caches cannot
 * disagree about what a variant is. What is added is everything the session
 * cache gets to leave implicit because it does not outlive the thing that set
 * it: the sharpness ceiling (a copy made at 1024 must not be served to a board
 * now asking for 1280 - see displayMax()), the encoder quality, the model and
 * the runtime that produced the mask, and the revision above.
 *
 * MODEL_NAME and ORT_VERSION are the pins tests/matte-vendor.test.js holds to
 * the bytes on disk, so swapping either vendored thing invalidates every cached
 * cut-out without anybody having to think of it.
 *
 * Exported for tests/display.test.js, which has to seed the cache under the key
 * this module will actually ask for. Writing the format out a second time there
 * would be a test that passes while the app misses.
 */
export const matteVariant = (hash: string, crop: Crop, rot: Turn) =>
  keyFor(hash, crop, rot, true).slice(hash.length)
  + `~${displayMax()}~${QUALITY}~${MODEL_NAME}@${ORT_VERSION}~${COPY_REV}`;

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
export function displayURLReady(
  hash: string, crop: Crop = null, rot: Turn = null, matte: Matte = false,
): string | null {
  return cache.get(keyFor(hash, crop, rot, matte))?.url || null;
}

/**
 * Make the display copy for a hash if it does not exist yet, and resolve to its
 * URL. Idempotent and shared: repeated calls for the same hash return the one
 * in-flight or finished job. Resolves to null only if the asset is gone.
 */
export function ensureDisplay(
  hash: string, crop: Crop = null, rot: Turn = null, matte: Matte = false,
): Promise<string | null> {
  const key = keyFor(hash, crop, rot, matte);
  const done = cache.get(key);
  if (done) return Promise.resolve(done.url);
  const inFlight = pending.get(key);
  if (inFlight) return inFlight;
  const mine = epoch;
  const job = start(hash, crop, rot, matte, mine);
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

/**
 * The two ways a copy can arrive, and the reason they are not the same queue.
 *
 * **A cached cut-out is bytes, not work.** It is already a card-sized WebP - the
 * decode it would have cost was paid on some earlier load, and paid into
 * IndexedDB. So it is fetched and published straight away, ahead of the queue
 * entirely.
 *
 * Putting it *in* the queue is what the first version of this did, and it undid
 * most of what the cache was for. That queue exists to hold the app to one
 * full-resolution decode at a time (see the header), and on a board of thirty
 * photographs it is seconds long - so a matted card whose picture was sitting
 * ready on disk waited behind every 6000x4000 JPEG ahead of it and appeared
 * about as late as it had before anything was cached. The model no longer ran
 * and the wait was unchanged, which is the worst of both: all of the storage and
 * none of the speed.
 *
 * Everything else still queues, because everything else really does decode.
 *
 * The chain is extended here rather than in ensureDisplay() and that is still
 * safe: `const decode = queue.then(...)` and `queue = decode.catch(...)` run as
 * one synchronous pair, so whichever job reaches this line next chains onto the
 * tail rather than beside it. What is lost is that jobs may now enter the queue
 * in a different order than they were asked for - a matted miss joins it one
 * IndexedDB read late - and nothing anywhere depends on that order.
 */
async function start(
  hash: string, crop: Crop, rot: Turn, matte: Matte, mine: number,
): Promise<string | null> {
  if (matte) {
    const kept = await loadMatte(hash, matteVariant(hash, crop, rot));
    if (kept) return publish(hash, crop, rot, matte, kept, mine);
  }
  // Chain onto the queue so generation is serial; keep the chain alive past a
  // failure so one undecodable file does not stall every picture behind it.
  const decode = queue.then(() => derive(hash, crop, rot, matte, mine));
  queue = decode.catch(() => {});
  return decode;
}

/** The slow path: decode the original, draw it, cut it, encode it, keep it. */
async function derive(
  hash: string, crop: Crop, rot: Turn, matte: Matte, mine: number,
): Promise<string | null> {
  const key = keyFor(hash, crop, rot, matte);
  const existing = cache.get(key);
  if (existing) return existing.url;
  const a = getAsset(hash);
  if (!a) return null;
  // Fixed before anything is drawn, so that a sharpness change landing mid-decode
  // cannot file this picture under a ceiling it was not made at.
  const variant = matte ? matteVariant(hash, crop, rot) : '';
  const made = await shrink(a.blob, crop, rot, matte);
  // Kept only when the model actually cut. cutout() answers false on a browser
  // with no worker, a runtime that would not import or a canvas that will not
  // hand its pixels back, and what it leaves behind is a correct picture with
  // its background still on - persisting that would pin the failure to disk, and
  // the cut-out would never appear on a machine where it later works.
  //
  // Not awaited, and not behind the epoch check below. A cached copy is keyed by
  // content rather than by board, so one finished after a clear is still a
  // correct copy of the same bytes - and a write nobody is waiting on has no
  // business holding a mount.
  if (matte && made.knocked && made.blob) void saveMatte(hash, variant, made.blob);
  return publish(hash, crop, rot, matte, made.blob, mine);
}

/**
 * Hand a finished copy to the cache, or decline to - the tail both paths share.
 *
 * `small` null means "mount the original", which is the ordinary answer for a
 * picture already inside the ceiling with nothing to apply. It cannot be the
 * answer on the cached path, which only ever holds copies that were made.
 */
function publish(
  hash: string, crop: Crop, rot: Turn, matte: Matte, small: Blob | null, mine: number,
): string | null {
  // A clear landed while that decode ran - a new board, or a new sharpness
  // ceiling. Publishing now would put back a copy the clear meant to drop, at a
  // resolution nobody asked for, and the entry would outlive the board it came
  // from. Checked before createObjectURL rather than after, so a refused job
  // has nothing to revoke and cannot leak. Callers read null as "no copy yet",
  // which is true, and resetItems() remounts every card behind the clear anyway.
  if (mine !== epoch) return null;
  const key = keyFor(hash, crop, rot, matte);
  // Two jobs for one key can only exist across a clear, which empties pending.
  // If the later one already published, keep its entry: it was made under the
  // current ceiling. Dropping `small` here is free - no URL was ever handed out.
  const won = cache.get(key);
  if (won) return won.url;
  // A copy that came out is ours to revoke; a picture already small enough rides
  // the asset store's own URL, which assets.ts revokes - do not double-manage it.
  // assetURL() is null only for a hash the store does not hold, and the caller
  // proved it holds this one - so the assertion cannot fire.
  const entry = small
    ? { url: URL.createObjectURL(small), own: true }
    : { url: assetURL(hash)!, own: false };
  cache.set(key, entry);
  return entry.url;
}

/**
 * What one attempt at a display copy produced: the bytes, and whether the
 * background was actually taken off.
 *
 * `blob` is null for the ordinary "leave it alone" cases - already within the
 * ceiling, the browser cannot decode it - because those are not failures: the
 * original is already a fine thing to mount.
 *
 * `knocked` is the second half and exists for one caller: generate() persists a
 * cut-out and must not persist a picture that was *asked* to be one and came
 * back whole. Every path that declines - no worker, no runtime, no readable
 * canvas - returns a correct uncut picture, and only this flag tells the two
 * apart. It is false whenever `blob` is null, which has no cut-out to describe.
 */
type Made = { blob: Blob | null, knocked: boolean };

/** Nothing came of it, and there is nothing to say about a cut that did not run. */
const NOTHING: Made = { blob: null, knocked: false };

/**
 * A card-sized WebP of a picture, or null to mount the original as-is.
 *
 * Same four-call shape as optimize/picture.ts.
 */
async function shrink(
  blob: Blob | null | undefined, crop: Crop = null, rot: Turn = null, matte: Matte = false,
): Promise<Made> {
  if (!blob || !/^image\//i.test(blob.type)) return NOTHING;
  let bmp;
  try {
    bmp = await createImageBitmap(blob);
  } catch {
    return NOTHING;
  }
  try {
    // The region being kept, in the source's own pixels. The whole picture when
    // there is no crop, which is what makes the two paths one piece of code.
    const sx = crop ? Math.round(crop.x * bmp.width) : 0;
    const sy = crop ? Math.round(crop.y * bmp.height) : 0;
    const sw = Math.max(1, crop ? Math.round(crop.w * bmp.width) : bmp.width);
    const sh = Math.max(1, crop ? Math.round(crop.h * bmp.height) : bmp.height);
    const scale = Math.min(1, displayMax() / Math.max(sw, sh));
    // Already inside the ceiling: mount the original - but only when there is
    // nothing to apply. A picture that is cropped, turned or matted always needs
    // a copy made, however small it is, because the copy *is* the edit. This is
    // the one branch where the two paths genuinely differ.
    if (scale === 1 && !derived(crop, rot, matte)) return NOTHING;
    const w = Math.max(1, Math.round(sw * scale));
    const h = Math.max(1, Math.round(sh * scale));
    // A quarter turn swaps the surface, and only a quarter turn: 180 lands back
    // on the same box. This is the one place the swap is computed - everything
    // downstream reads the copy's own dimensions and needs no branch.
    const quarter = rot === 90 || rot === 270;
    const dw = quarter ? h : w;
    const dh = quarter ? w : h;
    // Through canvas/surface.ts rather than `new OffscreenCanvas(...)` directly,
    // and this is the whole module's fate riding on one constructor: it landed
    // in Safari 16.4, and below that the call threw straight into the catch
    // below - which answers "leave the original alone". So on an older iOS this
    // file did nothing at all, on a device with the same per-tab memory ceiling
    // as a current one. See the header there.
    //
    // No surface is one more "leave the original alone" case, and it already
    // was one: it threw into the same catch. Said out loud now.
    const face = surface(dw, dh);
    if (!face) return NOTHING;
    if (rot) {
      // About the middle of the *destination*, then the source is drawn centred
      // on the new origin. Written this way rather than as a translate-to-corner
      // because the corner differs per angle and the centre does not, so there
      // is one line here instead of a table of four.
      face.ctx.translate(dw / 2, dh / 2);
      face.ctx.rotate(rot * Math.PI / 180);
      face.ctx.drawImage(bmp, sx, sy, sw, sh, -w / 2, -h / 2, w, h);
      face.ctx.setTransform(1, 0, 0, 1, 0, 0);
    } else {
      face.ctx.drawImage(bmp, sx, sy, sw, sh, 0, 0, w, h);
    }
    // After the turn, so the model sees the picture the way the person does -
    // a saliency network is not orientation-invariant, and a subject lying on
    // its side is a subject it was not trained on. It answers false on an engine
    // with no workers, a runtime that would not load or a canvas that will not
    // hand its pixels back, in which case the copy is still a correct cropped
    // and turned picture, just an opaque one. See canvas/matte.ts.
    const knocked = matte ? await cutout(face, dw, dh) : false;
    return { blob: await encode(face, blob.type, knocked), knocked };
  } catch {
    return NOTHING;
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
 * borrowed from optimize/picture.ts, where refusing a PNG is right because that
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
 *
 * `knocked` is that same rule for the alpha this module puts there itself. A
 * JPEG whose background has just been removed is a JPEG *with* alpha now, and it
 * is the one case where "the source had none to lose" stops being true: without
 * this flag, a matted photograph on Safari came back as a JPEG and the
 * transparency it was asked for became a black rectangle. The flag rather than a
 * pixel test, because the caller already knows and reading the canvas back a
 * second time to ask is work to learn something nobody forgot.
 */
async function encode(
  face: Surface, sourceType: string, knocked = false,
): Promise<Blob | null> {
  const first = await surfaceToBlob(face, 'image/webp', QUALITY);
  if (!first) return null;
  if (first.type.toLowerCase() === 'image/webp') return first;
  if (knocked || !/^image\/jpe?g$/i.test(sourceType)) return first;
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
 * Every key for a hash, not the hash itself: an edited card keys its copy as
 * `hash|x,y,w,h@rot%matte` (see keyFor), so one photograph cropped two ways has
 * three entries here and the bare hash finds one of them.
 *
 * Cut at the first of the three sigils rather than at `|` alone. A picture that
 * is turned but not cropped keys as `hash@90`, which a split on `|` hands back
 * whole - so emptying the bin on it left the copy behind, holding an object URL
 * for bytes that no longer exist anywhere. A hash is hex and can contain none of
 * the three, which is what makes one character enough to find the end of it.
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
  const mine = (key: string) => doomed.has(key.split(/[|@%]/)[0]);
  for (const key of Array.from(cache.keys()).filter(mine)) {
    const entry = cache.get(key);
    if (entry?.own) URL.revokeObjectURL(entry.url);
    cache.delete(key);
  }
  for (const key of Array.from(pending.keys()).filter(mine)) pending.delete(key);
  // And the half that would otherwise outlive the bytes it was made from. A
  // cut-out is the photograph with its background taken off, so a purge that
  // left one in IndexedDB would have left the photograph - the one thing
  // emptying the bin is supposed to mean. Not awaited, for the reason `pending`
  // is not: this is inside an action somebody pressed a button for.
  void forgetMatte(doomed);
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
