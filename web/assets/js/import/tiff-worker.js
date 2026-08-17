// The worker the vendored TIFF decoder runs in.
//
// A classic worker, not a module one, for the same reason optimize/media-worker
// .js is one: UTIF.js is a script that assigns itself to `self.UTIF` and reads
// `self.pako` back out, which is what importScripts is for and what a module
// worker cannot do. Those two files are the only outside code here.
//
// Off the main thread because a TIFF is the one picture format that arrives
// enormous as a matter of course - a flatbed scan at 1200 dpi is 400 megapixels
// before anything is drawn - and the decode is straight-line JavaScript over
// every one of them. On the main thread that is a board that stops moving, with
// no frame to say why.
//
// It speaks one message and holds no state at all:
//   { id, bytes, lift }  ->  { id, blob, w, h } | { id, pixels } | { id, error }
//
// Everything it refuses, it refuses before allocating: the page is chosen from
// the directory headers, which are kilobytes, and its declared size is checked
// against the ceiling below before a single row of pixels is read.
//
// `pixels` in the reply is not an error, it is a question - the ceiling half of
// the retry contract in consent.ts. The worker cannot ask anybody anything, so
// it reports the number it stopped at and the door above turns that into the
// one question worth asking about a 400-megapixel scan. A second call with
// `lift` set decodes it.

importScripts('../../vendor/pako/pako_inflate.min.js', '../../vendor/utif/UTIF.js');

/**
 * Pixels one page may decode before this stops to ask.
 *
 * IMPORT_LIMITS.pixels in import/budget.ts, repeated rather than imported: this
 * file is a classic worker and cannot import a module, and the number is a
 * property of what a tab can hold rather than of either module. Four bytes a
 * pixel is 256 MB at this ceiling, before the WebP it is turned into.
 *
 * A ceiling to stop at rather than a refusal, which is the whole shape of
 * consent.ts: a 1200-dpi flatbed scan is honestly this large, the person who
 * made it knows that, and the number they need in order to answer is the one
 * this reports back.
 */
const MAX_PIXELS = 64 * 1024 * 1024;

/** How the raster comes back. WebP because it is what the PDF path already
 *  writes, and because a lossless PNG of a 200-megapixel scan is not a card. */
const OUT_TYPE = 'image/webp';
const OUT_QUALITY = 0.9;

self.onmessage = async e => {
  const { id, bytes, lift } = e.data || {};
  try {
    const out = await decode(bytes, !!lift);
    self.postMessage({ id, ...out });
  } catch (err) {
    // The message, not the error: an Error does not survive structured cloning
    // with its stack, and the caller only reports this to the console anyway.
    self.postMessage({ id, error: String((err && err.message) || err) });
  }
};

async function decode(bytes, lift) {
  const ifds = self.UTIF.decode(bytes);
  if (!ifds || !ifds.length) throw new Error('no image directory');

  // The largest page, not the first. A TIFF is a *container* of images and the
  // writers use that: Photoshop puts a thumbnail in front of the picture, a
  // scanner writes one page per sheet, and a pyramid TIFF holds the same image
  // at six sizes. The biggest is the one somebody means.
  //
  // Chosen from the declared tags - ImageWidth is 256 and ImageLength is 257,
  // both arrays of one - because that is what is known before any pixels are
  // touched, and choosing after decoding would mean decoding all of them.
  let best = null;
  let bestPx = 0;
  for (const ifd of ifds) {
    const w = Math.round(Number(ifd.t256 && ifd.t256[0]) || 0);
    const h = Math.round(Number(ifd.t257 && ifd.t257[0]) || 0);
    if (!(w > 0 && h > 0)) continue;
    const px = w * h;
    if (px > bestPx) { best = ifd; bestPx = px; }
  }
  if (!best) throw new Error('no page with a size');
  // Reported rather than thrown: this is a question for the person, and the
  // numbers are what they need to answer it. See the head of this file.
  if (bestPx > MAX_PIXELS && !lift) {
    return {
      pixels: bestPx,
      w: Math.round(Number(best.t256[0])),
      h: Math.round(Number(best.t257[0])),
    };
  }

  self.UTIF.decodeImage(bytes, best, ifds);
  const rgba = self.UTIF.toRGBA8(best);
  const w = best.width;
  const h = best.height;
  // Believed only after the fact: `width` and `height` are set by the decode
  // and may disagree with the tags read above on a file whose directory lies.
  // Four bytes a pixel is the contract toRGBA8 states, and a short buffer would
  // be an ImageData constructor throwing rather than a picture.
  if (!(w > 0 && h > 0) || rgba.length < w * h * 4) throw new Error('decoded to nothing');

  const canvas = new OffscreenCanvas(w, h);
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('no 2d context in this worker');
  ctx.putImageData(new ImageData(new Uint8ClampedArray(rgba.buffer, rgba.byteOffset, w * h * 4), w, h), 0, 0);
  const blob = await canvas.convertToBlob({ type: OUT_TYPE, quality: OUT_QUALITY });
  return { blob, w, h };
}
