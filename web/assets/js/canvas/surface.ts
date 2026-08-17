// A drawing surface, on engines that have OffscreenCanvas and on those that do not.
//
// Five places in this app draw a picture into a canvas and ask for the bytes
// back: the display copy (canvas/display.ts), the optimiser's shrink and its
// thumbnails (optimize/picture.ts), a video poster (canvas/poster.ts), a model's
// still (canvas/model.ts) and a GIF's freeze frame (canvas/stills.ts). Every one
// of them reached for `new OffscreenCanvas(...)` directly.
//
// **OffscreenCanvas landed in Safari 16.4.** Below that every one of those calls
// throws, and every one of them is inside a try/catch that answers "leave it
// alone" - so nothing crashed and everything quietly stopped working. What
// stopped working is the whole of this app's memory defence: no display copies,
// no thumbnails, no posters, no stills. A board of two dozen photographs then
// mounts two dozen full-resolution originals, which is about a gigabyte of
// decode.
//
// Worth being exact about who that hurts, because the obvious guess is wrong.
// It is **not** a story about old, small-memory phones. The crash that started
// all of this was an iPhone 12 on a current iOS, and the ceiling it hit was
// iOS Safari's per-tab memory limit rather than the device's RAM - the same
// limit a phone released this year has. So the defence matters on every iPhone,
// and this file is only about making sure it is *present* on the engines that
// cannot build it the tidy way.
//
// The fallback is not exotic: an ordinary `<canvas>` element does all of this
// and has since the beginning. What OffscreenCanvas buys here is not capability
// but tidiness - no element, no document, no risk of a stylesheet reaching it -
// so it stays the first choice and this is the second.
//
// ── Why a surface rather than a canvas ──
//
// The two canvases differ in exactly one way that matters to a caller: how the
// bytes come out. OffscreenCanvas has `convertToBlob({type, quality})` returning
// a promise; HTMLCanvasElement has `toBlob(callback, type, quality)`. Everything
// else - the 2D context, drawImage, imageSmoothingQuality, getImageData - is the
// same object shape under both. So this module hands back the pair a caller
// actually wants (the surface and its context, already obtained) and owns the
// one difference in surfaceToBlob() below, rather than making five call sites
// each learn both spellings.

/** A canvas of either kind, with its 2D context already taken. */
export type Surface = {
  canvas: OffscreenCanvas | HTMLCanvasElement,
  ctx: OffscreenCanvasRenderingContext2D | CanvasRenderingContext2D,
};

/**
 * A `w` x `h` drawing surface with a 2D context, or null.
 *
 * Null for the two cases every caller already handled: no canvas of either kind
 * to be had, and a canvas that will not give up a 2D context. Both were already
 * "leave the original alone" answers at every call site, which is why this can
 * return null rather than throw and change nothing about how it is used.
 *
 * Smoothing is set here rather than at each call site because all five wanted
 * the same thing and one of them kept forgetting: the default is 'low' on some
 * engines, which aliases every hard edge on a large downscale.
 */
export function surface(w: number, h: number, opts: { alpha?: boolean } = {}): Surface | null {
  // Both kinds, in order, and the second is tried when the first hands back no
  // context - not only when it cannot be constructed. See withContext().
  return withContext(offscreen(w, h), opts) || withContext(element(w, h), opts);
}

/**
 * A canvas and its 2D context, or null if this canvas will not give one.
 *
 * **A canvas that exists is not a canvas that draws, and the gap between those
 * two is a whole engine.** Firefox on Android has had `OffscreenCanvas` as a
 * global while its 2D context was unimplemented: the constructor succeeds,
 * `getContext('2d')` answers null, and the old shape of this function - build
 * one, take its context, return null if there is no context - stopped there
 * without ever trying the element that would have worked. `blank()` only fell
 * back when the *constructor* threw, which is the one failure that engine does
 * not have.
 *
 * What that would cost is every picture this app derives: no display copies, no
 * thumbnails, no video posters, no model stills, no GIF stills - every one of
 * them reading as "the preview did not work" on an engine that was capable of
 * all of it.
 *
 * Written as "would" rather than "did", because this fallback was added during
 * a hunt for a bug that turned out to be two other things entirely (see
 * ui/feed.ts's shownHash and canvas/gl-frame.ts), and it was never shown to
 * have fired on anybody's phone. It stays because the gap it covers is real and
 * the cost of covering it is one extra call on an engine that has already
 * failed - not because it is known to have been the fault.
 *
 * `alpha` is passed through because one caller means it: a video poster draws
 * onto an opaque context (canvas/poster.js), which lets the engine skip the
 * compositing pass and is why that file could take JPEG unconditionally.
 * Default true, which is the platform default and what the other four want.
 */
function withContext(
  canvas: OffscreenCanvas | HTMLCanvasElement | null,
  opts: { alpha?: boolean },
): Surface | null {
  if (!canvas) return null;
  // SAFETY: the union is the whole point of this module and is the one place
  // the two canvases have to be spoken of together. `getContext('2d')` is
  // declared to return each canvas's own context type, and TypeScript cannot
  // narrow the call across the union of receivers - but both members return a
  // 2D context whose every member the Surface type names, and nothing anywhere
  // in this app reads a property that only one of them has. The `| null` is
  // kept rather than asserted away, because a canvas refusing a context is a
  // real answer and is the whole reason this function exists.
  //
  // Wrapped, because refusing is not the only way to say no: an engine may
  // throw on an argument it does not know rather than answer null.
  let ctx: Surface['ctx'] | null = null;
  try {
    // SAFETY: the paragraph above is the invariant - both canvases answer with
    // a 2D context whose every member the Surface type names, and the checker
    // cannot narrow one call across a union of receivers. The null is kept.
    ctx = canvas.getContext('2d', { alpha: opts.alpha !== false }) as Surface['ctx'] | null;
  } catch { /* the next canvas, or null */ }
  if (!ctx) return null;
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = 'high';
  return { canvas, ctx };
}

/**
 * An OffscreenCanvas, or null on an engine that has none.
 *
 * `typeof` rather than a try/catch alone, so that an engine without it costs
 * nothing to detect - the try is for the ones that have the name and refuse the
 * size.
 */
function offscreen(w: number, h: number): OffscreenCanvas | null {
  if (typeof OffscreenCanvas !== 'function') return null;
  try { return new OffscreenCanvas(w, h); } catch { return null; }
}

/**
 * An ordinary `<canvas>`, or null with no document to make one in - which is a
 * Node test, and is what keeps this module loadable by tests/imports.test.js
 * like every other.
 */
function element(w: number, h: number): HTMLCanvasElement | null {
  if (typeof document === 'undefined') return null;
  const el = document.createElement('canvas');
  el.width = w;
  el.height = h;
  return el;
}

/**
 * Whether this browser will hand back the pixels it just drew.
 *
 * It is not a given, and the engines that refuse do it silently. Firefox's
 * fingerprinting protection - on by default in its strict mode, which is the
 * default on Android - treats reading a canvas back as an attempt to fingerprint
 * the device, and answers with blank or randomised data rather than with an
 * error. Safari's Lockdown Mode does something similar. Nothing throws, nothing
 * is logged, and every feature in this app that inspects what it drew quietly
 * stops working:
 *
 *   - a video poster, because looksFlat() reads the frame to see whether the
 *     decoder actually drew one, and a blank read means every frame of every
 *     clip is discarded as empty;
 *   - the palette taken from the board's own pictures (ui/pigments.ts);
 *   - the cut-out guess on an imported picture (optimize/picture.ts).
 *
 * **It has never been seen to happen here**, and that is worth saying because
 * this function was written believing it had. A board that answered "could not
 * read any of the pictures on the board" looked exactly like this and was not:
 * the board held nothing but PDFs, and the palette was handing an image decoder
 * each PDF's own bytes rather than its rendered page. That was one bug (see
 * shownHash in board-model.ts) and the missing clip frames were another
 * (canvas/gl-frame.ts), and neither had anything to do with reading a canvas.
 *
 * What is left is a documented browser behaviour with no confirmed sighting,
 * guarded cheaply. That is a fair thing to keep and a bad thing to reason from:
 * anybody reaching for this to explain a missing picture should find the actual
 * cause first, because twice now it has been somewhere else entirely.
 *
 * So it is asked once, here, rather than guessed at three times: draw a known
 * colour into a two-pixel canvas and read it back. A tolerance of eight per
 * channel is wide enough for the *randomising* form of the protection, which
 * perturbs a few least-significant bits and is harmless to everything above,
 * and narrow enough to catch the blanking form, which is what actually breaks
 * them.
 *
 * **A yes is remembered and a no is not**, which is the one asymmetry here and
 * is not tidiness. A browser that hands its pixels back will not stop, so the
 * first yes settles it for the session and the callers - which are in loops -
 * pay nothing after that. A no *can* turn into a yes while the page is open:
 * Firefox asks before it blocks, in a prompt at the top of the screen, and
 * somebody who allows it there would otherwise stay degraded until they
 * reloaded, with nothing to tell them a reload was what was wanted. The probe
 * is a two-pixel fill and one pixel read, so asking again costs less than being
 * wrong about it.
 *
 * False on any engine with no canvas at all, which is a Node test - and no
 * caller does anything with that but skip an inspection it could not have made.
 */
let readable = false;

export function canvasReads(): boolean {
  if (readable) return true;
  readable = probeReads();
  return readable;
}

function probeReads(): boolean {
  const face = surface(2, 2, { alpha: false });
  if (!face) return false;
  try {
    face.ctx.fillStyle = '#3b7dd8';
    face.ctx.fillRect(0, 0, 2, 2);
    const [r, g, b] = face.ctx.getImageData(0, 0, 1, 1).data;
    return Math.abs(r - 0x3b) <= 8 && Math.abs(g - 0x7d) <= 8 && Math.abs(b - 0xd8) <= 8;
  } catch {
    return false;
  }
}

/**
 * The surface as bytes, in the format asked for where the engine can write it.
 *
 * The second half of the Safari story this app has been unpicking, and the two
 * halves are independent: *no* version of Safari encodes WebP from a canvas, at
 * any version through 27, and the specification says an engine that cannot
 * write the type asked for substitutes PNG without complaint. So a caller must
 * check the type that came back rather than the type it asked for - which is
 * what every caller now does, and why this returns the blob rather than
 * pretending the request was honoured.
 *
 * **The two spellings do not agree about the refusal, and that is what the
 * try/catch below is for.** "Substitutes PNG without complaint" is `toBlob`'s
 * rule. `convertToBlob` is specified the other way round: an unsupported type
 * *rejects* the promise. So the same unencodable request came back as a
 * relabelled PNG through the element path and as a thrown error through the
 * OffscreenCanvas path - and a caller written against the docstring above, which
 * is all five of them, loses the picture rather than keeping a substitute. The
 * worst of it is where that lands: canvas/poster.ts awaits this unguarded, so a
 * clip's poster was not "no frame could be decoded" but "the frame was decoded
 * and then thrown away", and every repair pass afterwards re-decoded it to reach
 * the same throw.
 *
 * PNG on the retry because it is the one format a canvas must encode. The type
 * still comes back on the blob, so the caller's check is unchanged and this
 * stays a report rather than a pretence.
 */
export async function surfaceToBlob(
  { canvas }: Surface,
  type: string,
  quality: number,
): Promise<Blob | null> {
  // Both branches test for the method rather than for the kind of canvas, for
  // the reason surface() above now builds them that way: an engine may ship one
  // of these objects with half of it missing, and calling the method the other
  // kind has is a TypeError thrown out of a promise nobody expected to reject.
  if ('convertToBlob' in canvas && typeof canvas.convertToBlob === 'function') {
    try {
      return await canvas.convertToBlob({ type, quality });
    } catch {
      try {
        return await canvas.convertToBlob({ type: 'image/png' });
      } catch {
        return null;
      }
    }
  }
  if ('toBlob' in canvas && typeof canvas.toBlob === 'function') {
    return new Promise(resolve => canvas.toBlob(resolve, type, quality));
  }
  return null;
}
