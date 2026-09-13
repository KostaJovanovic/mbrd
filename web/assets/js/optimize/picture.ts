// Picture shrinking via createImageBitmap + canvas WebP (JPEG on Safari).
// Surface from canvas/surface.ts for OffscreenCanvas compat (Safari 16.4+).
// The judgement is when NOT to swap — see WORTH_IT below.

import { surface, surfaceToBlob, type Surface } from '../canvas/surface.ts';

/** Max long edge — 1200px is where a card stops being pixel-limited. */
export const MAX_SIDE = 1200;

/** Long edge of the baked display copy carried in the .mbrd (meta.display).
 *  1024 is sharp for any Feed tile and every ordinary card; the canvas swaps in
 *  the original when a card is zoomed past this, so it is a floor, not a ceiling. */
export const DISPLAY_SIDE = 1024;

/** Cover art ceiling — drawn smaller than the card, so a lower limit. */
export const MAX_SIDE_COVER = 600;

/** WebP quality. High enough that a photograph does not band on paper. */
export const QUALITY = 0.82;

/** Minimum saving to justify the quality loss of a re-encode. */
const WORTH_IT = 0.1;

/** Skip: animated (would lose frames), SVG (would lose vectors), AVIF (already small). */
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

/** Shrink this picture, or null if it should be left alone. */
export async function shrinkPicture(
  blob: Blob | null | undefined,
  { maxSide = MAX_SIDE, quality = QUALITY, type = 'image/webp' }: ShrinkOptions = {},
): Promise<ShrunkPicture | null> {
  if (!blob || !/^image\//i.test(blob.type) || SKIP.test(blob.type)) return null;
  // Animated WebP: canvas would freeze it, so check by bytes, not type.
  if (await isAnimated(blob)) return null;

  let bmp;
  try {
    bmp = await createImageBitmap(blob);
  } catch {
    // Cannot decode — leave it alone.
    return null;
  }

  try {
    const scale = Math.min(1, maxSide / Math.max(bmp.width, bmp.height));
    const w = Math.max(1, Math.round(bmp.width * scale));
    const h = Math.max(1, Math.round(bmp.height * scale));
    // Already inside ceiling and in the right format — keep original bytes.
    if (scale === 1 && blob.type.toLowerCase() === type) return null;

    // Via canvas/surface.ts for OffscreenCanvas compat (Safari 16.4+).
    const face = surface(w, h);
    if (!face) return null;
    face.ctx.drawImage(bmp, 0, 0, w, h);

    const out = await encodeShrunk(face, type, quality, blob.type);
    if (!out) return null;
    // Only keep if the saving exceeds WORTH_IT.
    if (out.size > blob.size * (1 - WORTH_IT)) return null;
    return { blob: out, width: w, height: h, from: blob.size, to: out.size };
  } finally {
    bmp.close?.();
  }
}

/** Encode the shrunk canvas. Falls back to JPEG (for JPEG sources, Safari
 * cannot encode WebP) or keeps PNG for transparent sources. Spec says an engine
 * that cannot write the type asked for hands back a PNG without complaint. So
 * on every Safari the refusal fired for every picture on the board, and
 * Optimise ran its dialog, its progress bar and its minutes of work to report
 * that nothing needed doing. If the asked-for type comes back, keep it.
 * Pinned type miss → null (toOpus needs exact JPEG). Default WebP miss →
 * retry JPEG for JPEG sources, else keep PNG for transparency. */
async function encodeShrunk(
  face: Surface,
  type: string,
  quality: number,
  sourceType: string,
): Promise<Blob | null> {
  const out = await surfaceToBlob(face, type, quality);
  if (!out) return null;
  if (out.type.toLowerCase() === type) return out;
  if (type !== 'image/webp') return null;
  if (/^image\/jpe?g$/i.test(sourceType)) {
    try {
      const jpeg = await surfaceToBlob(face, 'image/jpeg', quality);
      if (jpeg?.type.toLowerCase() === 'image/jpeg') return jpeg;
    } catch { /* no JPEG encoder either: the PNG below is still the right pixels */ }
  }
  return out;
}

/** Thumbnail width — matches the widest a card is drawn at thumb zoom. */
const THUMB_SIDE = 100;

/** Low quality is fine — thumbnails are always displayed below 1:1. */
const THUMB_QUALITY = 0.5;

/** A thumbnail: the small bytes and the size they were written at. */
export type Thumbnail = { blob: Blob, width: number, height: number, cutout: boolean };

/** A 100px-wide thumbnail, or null for SVG/animated/already-small/undecoded.
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
    const face = surface(w, h);
    if (!face) return null;   // one more thing this browser cannot do - see shrinkPicture()
    face.ctx.drawImage(bmp, 0, 0, w, h);
    // Read before the encode, off the bitmap that is already here. This is the
    // whole cost of the cut-out guess: a hundred-pixel canvas that had to be
    // drawn anyway, sampled once. Doing it from the full-size picture would mean
    // a second decode of the very thing the resize above exists to avoid.
    const cutout = looksCutOut(face.ctx, w, h);
    const out = await surfaceToBlob(face, 'image/webp', THUMB_QUALITY);
    // Whatever came back is kept, and this used to refuse anything but WebP on
    // the grounds that a PNG at this quality setting is not the small file the
    // thumbnail was for. True of the bytes and wrong about the stakes.
    //
    // No version of Safari encodes WebP from a canvas - not on iOS, not on the
    // desktop - so the refusal meant Safari made *no thumbnails at all*. A
    // thumbnail is not a size optimisation, it is the memory defence for a
    // zoomed-out board (see the twin in canvas/renderers.ts: two hundred
    // hundred-pixel pictures instead of two hundred full decodes) and the
    // stand-in a card shows while its display copy renders. Withholding it from
    // the one engine that runs out of memory is the wrong way round.
    //
    // The cost is honest and bounded: a hundred-pixel PNG is tens of kilobytes
    // where the WebP is a few, and it travels in the .mbrd. The guard below
    // still refuses one that outweighs the picture it stands for. No JPEG
    // fallback here, unlike canvas/display.ts - looksCutOut() above says this
    // module deals in pictures with holes in them, and a flattened background
    // is exactly what it must not introduce.
    if (!out) return null;
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
function looksCutOut(ctx: Surface['ctx'], w: number, h: number): boolean {
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
