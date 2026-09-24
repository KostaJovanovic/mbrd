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

// ---------------------------------------------------------------------------
// A guard around UTIF's directory reader
// ---------------------------------------------------------------------------
//
// UTIF.decode follows the file's own offsets with no memory of where it has
// been: 16 bytes whose one directory names itself as the next one push an
// object per turn until the tab dies, and an entry claiming four billion
// SHORTs pushes four billion zeros (UTIF reads past the end as 0). Every
// directory - the page chain, SubIFDs, Exif, maker notes, a Nikon note's own
// TIFF - goes through UTIF._readIFD, so the checks sit in front of that one
// function and read with UTIF's own byte order. The vendored file stays as it
// was published.
//
// All three are plain Errors, never the `pixels` question: a loop is not a
// large picture, and there is nothing to lift.

/** Bytes per value of each TIFF type UTIF expands into an array. */
const TYPE_BYTES = { 1: 1, 2: 1, 3: 2, 4: 4, 5: 8, 7: 1, 8: 2, 9: 4, 10: 8, 11: 4, 12: 8 };

/** Nesting deeper than any writer uses. A SubIFD that names an ancestor
 *  recurses until the stack gives out; this stops it well before. */
const MAX_DEPTH = 16;

/** One decode's state. Set by decode() around the synchronous UTIF.decode. */
let guard = null;

const readIFD = self.UTIF._readIFD;
self.UTIF._readIFD = function (bin, data, offset, _ifds, depth, _debug) {
  if (guard) {
    if (depth > MAX_DEPTH) throw new Error('image directories nest too deep');
    // Depth 0 is a page chain: the main one, or a Nikon note's. A chain that
    // comes back to a directory it has read loops for ever.
    if (depth === 0) {
      let seen = guard.chains.get(data);
      if (!seen) guard.chains.set(data, seen = new Set());
      if (seen.has(offset)) throw new Error('the image directories point back into themselves');
      seen.add(offset);
    }
    // Each value UTIF will expand is work, and an honest file stores each
    // array once, so the whole decode reads about as many values as the file
    // has bytes. The per-entry test catches one lying count; the total
    // catches many directories that all point at the same big array.
    const count = bin.readUshort(data, offset);
    let work = 1;
    for (let i = 0; i < count; i++) {
      const at = offset + 2 + i * 12;
      const size = TYPE_BYTES[bin.readUshort(data, at + 2)];
      if (!size) continue;
      const num = bin.readUint(data, at + 4);
      if (num * size > data.length) throw new Error('an image directory entry is longer than the file');
      work += num;
    }
    guard.left -= work;
    if (guard.left < 0) throw new Error('the image directories ask for more than the file holds');
  }
  return readIFD.apply(this, arguments);
};

/** UTIF.decode with the guard above on. */
function directories(bytes) {
  guard = { chains: new WeakMap(), left: 2 * bytes.byteLength + 65536 };
  try {
    return self.UTIF.decode(bytes);
  } finally {
    guard = null;
  }
}

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
  const ifds = directories(bytes);
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
