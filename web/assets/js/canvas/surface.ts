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
  const canvas = blank(w, h);
  if (!canvas) return null;
  // `alpha` is passed through because one caller means it: a video poster draws
  // onto an opaque context (canvas/poster.js), which lets the engine skip the
  // compositing pass and is why that file could take JPEG unconditionally.
  // Default true, which is the platform default and what the other four want.
  //
  // SAFETY: the union is the whole point of this module and is the one place
  // the two canvases have to be spoken of together. `getContext('2d')` is
  // declared to return each canvas's own context type, and TypeScript cannot
  // narrow the call across the union of receivers - but both members return a
  // 2D context whose every member the Surface type names, and nothing anywhere
  // in this app reads a property that only one of them has. The `| null` is
  // kept rather than asserted away, because a canvas refusing a context is a
  // real answer and is handled on the next line.
  const ctx = canvas.getContext('2d', { alpha: opts.alpha !== false }) as Surface['ctx'] | null;
  if (!ctx) return null;
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = 'high';
  return { canvas, ctx };
}

/**
 * OffscreenCanvas where it exists, an ordinary `<canvas>` where it does not.
 *
 * `typeof` rather than a try/catch around the constructor, so that an engine
 * without it costs nothing to detect. The element path needs a document, which
 * a Node test does not have - hence the second guard, which also makes this
 * module loadable by tests/imports.test.js like every other.
 */
function blank(w: number, h: number): OffscreenCanvas | HTMLCanvasElement | null {
  if (typeof OffscreenCanvas === 'function') {
    try { return new OffscreenCanvas(w, h); } catch { /* fall through */ }
  }
  if (typeof document === 'undefined') return null;
  const el = document.createElement('canvas');
  el.width = w;
  el.height = h;
  return el;
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
  if (!('convertToBlob' in canvas)) {
    return new Promise(resolve => canvas.toBlob(resolve, type, quality));
  }
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
