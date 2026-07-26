// Shrinking a picture, with the browser's own decoder and encoder.
//
// No dependency and none wanted: `createImageBitmap` reads every format the
// board can display, a canvas resamples it, and `convertToBlob` writes WebP.
// The whole of it is four calls; what is worth writing down is the judgement
// around them, which is when *not* to swap the file.

/**
 * The long edge a picture is allowed to keep.
 *
 * A moodboard card is rarely drawn much past 600 world units and a screen is
 * rarely worth more than two device pixels per unit, so 1200 is the size at
 * which the picture stops being the thing that limits what you see. Above it
 * you are storing a photograph library, not a board.
 */
export const MAX_SIDE = 1200;

/**
 * Album art and card pictures are drawn smaller than the card itself, so they
 * get a lower ceiling. They are kept, not dropped - see the module note in
 * optimize.js.
 */
export const MAX_SIDE_COVER = 600;

/** WebP quality. High enough that a photograph does not band on paper. */
export const QUALITY = 0.82;

/**
 * How much smaller the new file has to be before the swap is worth making.
 *
 * A re-encode that saves four percent has still thrown away a generation of
 * quality, and doing that to every picture on a board to save a rounding error
 * is a bad trade. Below this the original is kept exactly as it arrived.
 */
const WORTH_IT = 0.1;

/**
 * Formats this refuses to touch, and why each one.
 *
 * An animated GIF or WebP would come back as a single frame - the canvas holds
 * one - and a picture that stops moving is not an optimisation. SVG is text and
 * already small, and rasterising it would throw away the one thing it has.
 * AVIF is already the small end of the scale.
 */
const SKIP = /^image\/(gif|svg\+xml|avif)$/i;

/**
 * A smaller version of this picture, or null to leave it alone.
 *
 * Null rather than an exception for every one of the ordinary refusals -
 * animated, already small, already efficient, the re-encode came out bigger -
 * because none of those is a failure. The caller counts them as "left alone",
 * which is what they are.
 */
export async function shrinkPicture(blob, { maxSide = MAX_SIDE, quality = QUALITY, type = 'image/webp' } = {}) {
  if (!blob || !/^image\//i.test(blob.type) || SKIP.test(blob.type)) return null;
  // An animated WebP is a still WebP as far as the canvas is concerned, so it
  // is caught by its own bytes rather than by its type - see isAnimated().
  if (await isAnimated(blob)) return null;

  let bmp;
  try {
    bmp = await createImageBitmap(blob);
  } catch {
    // Not something this browser can decode. Leaving it alone is the only
    // honest answer: it is still on the board and still exports.
    return null;
  }

  try {
    const scale = Math.min(1, maxSide / Math.max(bmp.width, bmp.height));
    const w = Math.max(1, Math.round(bmp.width * scale));
    const h = Math.max(1, Math.round(bmp.height * scale));
    // Never enlarged, and never re-encoded for nothing: a picture already
    // inside the ceiling and already in the format being asked for keeps its
    // bytes. Only when it is being asked for - a WebP asked to become a JPEG
    // for an Opus tag is a conversion, not a re-encode, and has to happen.
    if (scale === 1 && blob.type.toLowerCase() === type) return null;

    const canvas = new OffscreenCanvas(w, h);
    const ctx = canvas.getContext('2d', { alpha: true });
    // The default is 'low' on some engines, which on a 4:1 downscale is visible
    // as aliasing along every hard edge in the picture.
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(bmp, 0, 0, w, h);

    // A browser that cannot write the format asked for silently hands back a
    // PNG, which is how a shrink turns into a file three times the size.
    const out = await canvas.convertToBlob({ type, quality });
    if (!out || out.type.toLowerCase() !== type) return null;
    if (out.size > blob.size * (1 - WORTH_IT)) return null;
    return { blob: out, width: w, height: h, from: blob.size, to: out.size };
  } finally {
    bmp.close?.();
  }
}

/**
 * How wide a thumbnail is.
 *
 * A hundred is not a guess at a nice round number - it is the widest a card can
 * be drawn at the zoom where thumbnails are used. Below the detail rung - 0.4
 * with a mouse, 0.55 under a finger, see thumbZoom() in canvas/viewport.js - a
 * card of the default 320 world units covers 128 screen pixels or fewer, and
 * the boards where this matters are the ones zoomed further out than that. So a hundred pixels
 * is the picture at roughly life size for that view, and every pixel past it is
 * downsampled by the compositor for nothing.
 */
export const THUMB_SIDE = 100;

/**
 * And how hard it is compressed.
 *
 * Far below QUALITY, and it can be: this is only ever seen at a size where a
 * pixel of it is under a pixel of screen. At 0.5 a hundred-pixel WebP lands at
 * one to three kilobytes, which is the entire point - a board of two hundred
 * photographs becomes half a megabyte of thumbnails rather than two hundred
 * full-size decodes held in memory at once.
 */
const THUMB_QUALITY = 0.5;

/**
 * A hundred-pixel-wide copy of a picture, or null if it does not want one.
 *
 * Null, not an exception, for all four ordinary refusals:
 *
 *  - not a picture, or a vector. An SVG is already small and already scales;
 *    rasterising it to a hundred pixels would be strictly worse at every zoom.
 *  - animated. Those already have a far-zoom stand-in and it is a better one -
 *    canvas/stills.js shoots the frame that was actually on screen, so a GIF
 *    freezes where you left it rather than snapping back to frame one.
 *  - already this small. The file is its own thumbnail; a second copy of it
 *    would be bytes spent to save nothing.
 *  - the browser could not decode it. It stays a full-size picture, which is
 *    what it was going to be anyway.
 *
 * Height is whatever the aspect ratio says, uncapped. A hundred wide is the
 * instruction, and a tall picture that obeys it is still only a few thousand
 * pixels of WebP.
 */
export async function makeThumb(blob) {
  if (!blob || !/^image\//i.test(blob.type)) return null;
  if (/^image\/svg\+xml$/i.test(blob.type)) return null;
  if (await isAnimated(blob)) return null;

  let bmp;
  try {
    bmp = await createImageBitmap(blob);
  } catch {
    return null;
  }
  try {
    if (!bmp.width || bmp.width <= THUMB_SIDE) return null;
    const scale = THUMB_SIDE / bmp.width;
    const w = THUMB_SIDE;
    const h = Math.max(1, Math.round(bmp.height * scale));
    const canvas = new OffscreenCanvas(w, h);
    const ctx = canvas.getContext('2d', { alpha: true });
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(bmp, 0, 0, w, h);
    const out = await canvas.convertToBlob({ type: 'image/webp', quality: THUMB_QUALITY });
    // The same trap shrinkPicture() guards: a browser that cannot write WebP
    // hands back a PNG without saying so, and a PNG at this quality setting is
    // not the small file this was for.
    if (!out || out.type.toLowerCase() !== 'image/webp') return null;
    // A thumbnail bigger than its original is not a thumbnail. Rare, and real:
    // a hundred-pixel crop of pure noise can out-weigh a tiny flat-colour PNG.
    if (out.size >= blob.size) return null;
    return { blob: out, width: w, height: h };
  } finally {
    bmp.close?.();
  }
}

/**
 * Whether these bytes hold more than one frame.
 *
 * Read from the file rather than from its MIME type, because the type is
 * `image/gif` and `image/webp` either way and the difference is the whole
 * question: flattening an animation to its first frame is not a smaller file,
 * it is a different picture.
 *
 * GIF: any block whose graphic control extension is followed by a second image
 * descriptor. Cheaper and just as decisive - a GIF with more than one
 * `0x21 0xF9` extension block is animated, and a still one has at most one.
 *
 * WebP: the RIFF chunk list carries 'ANIM' when it is animated. The header is
 * enough; there is no need to walk the frames.
 */
async function isAnimated(blob) {
  const head = new Uint8Array(await blob.slice(0, 4096).arrayBuffer());
  const tag = String.fromCharCode(...head.subarray(0, 4));
  if (tag === 'GIF8') {
    let seen = 0;
    for (let i = 0; i < head.length - 1; i++) {
      if (head[i] === 0x21 && head[i + 1] === 0xf9 && ++seen > 1) return true;
    }
    return false;
  }
  if (tag === 'RIFF') {
    for (let i = 12; i < head.length - 4; i += 2) {
      if (String.fromCharCode(head[i], head[i + 1], head[i + 2], head[i + 3]) === 'ANIM') return true;
    }
    return false;
  }
  return false;
}
