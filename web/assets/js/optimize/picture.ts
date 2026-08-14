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

/** A re-encoded picture, with what it cost before and after. */
export type ShrunkPicture = {
  blob: Blob,
  width: number,
  height: number,
  from: number,
  to: number,
};

/** What a caller may ask of a shrink; every field has a default. */
export type ShrinkOptions = {
  maxSide?: number,
  quality?: number,
  type?: string,
};

/**
 * A smaller version of this picture, or null to leave it alone.
 *
 * Null rather than an exception for every one of the ordinary refusals -
 * animated, already small, already efficient, the re-encode came out bigger -
 * because none of those is a failure. The caller counts them as "left alone",
 * which is what they are.
 */
export async function shrinkPicture(
  blob: Blob | null | undefined,
  { maxSide = MAX_SIDE, quality = QUALITY, type = 'image/webp' }: ShrinkOptions = {},
): Promise<ShrunkPicture | null> {
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
    // A canvas with no 2D context is one more thing this browser cannot do with
    // this picture, and it is answered the way all the others are - see the note
    // above. Unreachable on a fresh canvas; the type says it is possible and the
    // module's contract already says what to do about it.
    if (!ctx) return null;
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

/** A thumbnail: the small bytes and the size they were written at. */
export type Thumbnail = { blob: Blob, width: number, height: number, cutout: boolean };

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
 *
 * `naturalWidth` is the file's own width when the caller already knows it, and
 * it is worth a paragraph because of what it saves rather than what it does.
 * Without it this decodes the whole picture and then throws away 99.97% of the
 * pixels: a 6000-wide photograph allocates about 96 MB of bitmap to produce a
 * hundred-wide thumbnail, and the import path runs six of these at once. Given
 * the width, the decoder is asked for the small bitmap directly - resizeWidth
 * alone, because the specification computes the other side from the aspect
 * ratio, which is exactly the arithmetic below.
 *
 * Every part of it degrades rather than breaks. A browser that ignores
 * resizeWidth hands back the full bitmap and the scaling below is unchanged,
 * because `scale` is computed from what actually arrived. A caller that does not
 * know the width passes nothing and gets the old behaviour. And the
 * already-small refusal is measured against `naturalWidth` when there is one,
 * since after a resize the bitmap is a hundred wide whatever the file was, and
 * asking it would refuse every picture.
 */
export async function makeThumb(
  blob: Blob | null | undefined,
  naturalWidth = 0,
): Promise<Thumbnail | null> {
  if (!blob || !/^image\//i.test(blob.type)) return null;
  if (/^image\/svg\+xml$/i.test(blob.type)) return null;
  if (await isAnimated(blob)) return null;
  // Refused before the decode when the width is known, which is the other half
  // of the saving: a picture already this small used to be decoded in full and
  // then turned down.
  if (naturalWidth && naturalWidth <= THUMB_SIDE) return null;

  let bmp;
  try {
    bmp = naturalWidth > THUMB_SIDE
      ? await createImageBitmap(blob, { resizeWidth: THUMB_SIDE, resizeQuality: 'high' })
      : await createImageBitmap(blob);
  } catch {
    return null;
  }
  try {
    if (!bmp.width || (naturalWidth || bmp.width) <= THUMB_SIDE) return null;
    const scale = THUMB_SIDE / bmp.width;
    const w = THUMB_SIDE;
    const h = Math.max(1, Math.round(bmp.height * scale));
    const canvas = new OffscreenCanvas(w, h);
    const ctx = canvas.getContext('2d', { alpha: true });
    if (!ctx) return null;   // one more thing this browser cannot do - see shrinkPicture()
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(bmp, 0, 0, w, h);
    // Read before the encode, off the bitmap that is already here. This is the
    // whole cost of the cut-out guess: a hundred-pixel canvas that had to be
    // drawn anyway, sampled once. Doing it from the full-size picture would mean
    // a second decode of the very thing the resize above exists to avoid.
    const cutout = looksCutOut(ctx, w, h);
    const out = await canvas.convertToBlob({ type: 'image/webp', quality: THUMB_QUALITY });
    // The same trap shrinkPicture() guards: a browser that cannot write WebP
    // hands back a PNG without saying so, and a PNG at this quality setting is
    // not the small file this was for.
    if (!out || out.type.toLowerCase() !== 'image/webp') return null;
    // A thumbnail bigger than its original is not a thumbnail. Rare, and real:
    // a hundred-pixel crop of pure noise can out-weigh a tiny flat-colour PNG.
    if (out.size >= blob.size) return null;
    return { blob: out, width: w, height: h, cutout };
  } finally {
    bmp.close?.();
  }
}

/**
 * Does this picture look cut out - a shape on a transparent ground rather than
 * a photograph?
 *
 * **Read the pixels, not the header, and that is the whole decision here.** A
 * PNG declares its colour type and a WebP declares alpha in its VP8X flags, and
 * both are cheap and both are wrong in the direction that hurts: an enormous
 * share of ordinary rectangular screenshots are saved as PNG-32 with a fully
 * opaque alpha channel, and no header can tell one of those from a logo.
 * Guessing from it would strip the card off a large share of the photographs on
 * a board, which is a worse result than the fault being fixed and one that
 * arrives silently in bulk.
 *
 * The test is the outer ring, because that is what the question actually is: a
 * cut-out is a shape that does not reach its own corners. A photograph's ring is
 * opaque everywhere, whatever its alpha channel says it could be.
 *
 * Two-thirds rather than everything: a logo on a transparent ground often has
 * one edge bled to it, and a wordmark can run the full width. The ring is not
 * asked to be empty, only to be mostly nothing.
 *
 * A wholly transparent image is refused. It is not a cut-out, it is an accident,
 * and taking the card off it would leave a card-sized hole nothing can be
 * grabbed by except its grips.
 */
function looksCutOut(ctx: OffscreenCanvasRenderingContext2D, w: number, h: number): boolean {
  if (w < 3 || h < 3) return false;
  let clear = 0;
  let ring = 0;
  let opaque = 0;
  // getImageData once over the whole small canvas rather than four strips: it is
  // a hundred pixels wide and four calls would each pay the same readback.
  let data;
  try {
    data = ctx.getImageData(0, 0, w, h).data;
  } catch {
    return false;   // a tainted or zero-sized canvas: no guess rather than a wrong one
  }
  for (let y = 0; y < h; y++) {
    const edgeRow = y === 0 || y === h - 1;
    for (let x = 0; x < w; x++) {
      if (!edgeRow && x !== 0 && x !== w - 1) continue;
      const a = data[(y * w + x) * 4 + 3];
      ring++;
      if (a < 16) clear++;
    }
  }
  // Cheap second pass over the middle row and column only, to find out whether
  // there is anything solid in here at all.
  for (let x = 0; x < w; x++) if (data[((h >> 1) * w + x) * 4 + 3] > 240) opaque++;
  for (let y = 0; y < h; y++) if (data[(y * w + (w >> 1)) * 4 + 3] > 240) opaque++;
  return ring > 0 && clear / ring >= 0.66 && opaque > 0;
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
async function isAnimated(blob: Blob): Promise<boolean> {
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
