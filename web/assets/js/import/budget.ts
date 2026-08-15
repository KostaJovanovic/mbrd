// The one memory policy the importer answers to.
//
// import/drop.js caps a drop at 500 *files*, which is a UX guard against
// dropping a photo library by accident - not a memory boundary. A count says
// nothing about bytes: five files can be five 4K videos, and one 50 KB PNG can
// claim 30000x30000 and cost gigabytes the moment createImageBitmap() touches
// it. This module is the boundary the count was mistaken for. See AUD-05 in
// research/old/full-code-audit-2026-07-26.md.
//
// Pure by design - no DOM, no state - so it sits beside util/geometry and both
// the importer and any future caller share one set of limits. The only browser
// object it touches is a File, and only inside a function (File.slice), so this
// stays loadable without a browser like the rest of import/.

export const IMPORT_LIMITS = {
  /** One file, raw. Matches the ZIP single-entry ceiling in storage/zip.js. */
  fileBytes: 512 * 1024 ** 2,
  /**
   * Not a limit - the size at which one file is worth mentioning first.
   *
   * The two numbers around it are refusals, decided here and reported after the
   * fact. This one is a question, and it is a question because the answer is
   * not the importer's to give: a 90 MB video is a perfectly reasonable thing
   * to put on a board and also a perfectly common thing to have dropped by
   * accident, and nothing measurable tells the two apart. Everything past this
   * point in an import is slow and hard to interrupt - hashing, decoding,
   * thumbnailing - so the moment to ask is before any of it starts.
   *
   * Well clear of the sizes an ordinary import is made of - a phone photo is
   * 3 MB, a scan 30 - so the dialog stays a thing that means something when it
   * appears rather than one more press between somebody and their own files.
   */
  warnBytes: 60 * 1024 ** 2,
  /** Raw bytes summed across one import. Peak decode cost is a multiple of this. */
  batchBytes: 1024 ** 3,
  /**
   * Decoded pixels a single raster image may claim. A decode allocates about
   * 4 bytes a pixel, so 64 MP (e.g. 8192x8192) is ~256 MB per image - and the
   * importer decodes several at once. Past this the image is not decoded at all;
   * it becomes a named card, the same graceful fallback an undecodable image
   * already gets.
   */
  pixels: 64 * 1024 * 1024,
};

/**
 * A running byte account for one import.
 *
 * `take(bytes)` returns whether a file fits both the per-file and the remaining
 * batch budget, charging it when it does. Called in file order before the work
 * pool starts, so which files are accepted near the ceiling is deterministic.
 */
export function makeByteBudget(limit: number = IMPORT_LIMITS.batchBytes) {
  let spent = 0;
  return {
    take(bytes: number) {
      const n = Number.isFinite(bytes) ? bytes : 0;
      if (n > IMPORT_LIMITS.fileBytes) return false;
      if (spent + n > limit || inFlight + n > limit) return false;
      spent += n;
      inFlight += n;
      return true;
    },
    spent: () => spent,
    /** Give this budget's charge back to the shared account. */
    release() { inFlight = Math.max(0, inFlight - spent); },
  };
}

/**
 * Bytes charged across every import that has not finished yet.
 *
 * The budget above is per call, so two folder drops a second apart each got a
 * fresh gigabyte - and a drop while a paste is still preparing is not exotic,
 * it is what happens when somebody is filling a board. Each import was under
 * budget on its own and the two together were two gigabytes of files being
 * hashed, decoded and thumbnailed at once, which is the thing batchBytes
 * exists to bound. MAX_FILES has exactly the same shape and the same answer.
 *
 * A module-level counter rather than a queue: the point is not to serialise
 * imports, which would make a second drop feel broken, but to stop the second
 * one claiming a budget the first is still spending. releaseByteBudget() is
 * called when an import finishes, however it finishes.
 */
let inFlight = 0;

/** For a test, or a caller that wants the shared account back at zero. */
export const resetByteBudget = () => { inFlight = 0; };

const u16be = (b: Uint8Array, o: number) => (b[o] << 8) | b[o + 1];
const u16le = (b: Uint8Array, o: number) => b[o] | (b[o + 1] << 8);
const u24le = (b: Uint8Array, o: number) => b[o] | (b[o + 1] << 8) | (b[o + 2] << 16);
const u32be = (b: Uint8Array, o: number) => b[o] * 2 ** 24 + (b[o + 1] << 16) + (b[o + 2] << 8) + b[o + 3];

/** Pixel dimensions of a raster image, in pixels. */
export type Dimensions = { w: number, h: number };

/**
 * Pixel dimensions read from a raster header, without decoding.
 *
 * Covers the formats a browser will actually turn into a bitmap and that carry
 * their size in a fixed or shallow-scannable header: PNG, GIF, JPEG, WebP, BMP,
 * ICO, AVIF/HEIC and TIFF.
 * Returns `{ w, h }` or null when the bytes are unrecognised or truncated - in
 * which case the byte caps still apply and the decoder's own failure is the
 * backstop.
 *
 * The last four are late arrivals and the reason is the finding that added
 * them: this knew only the first four, while all eight are in PHOTO_EXTS
 * (import/formats.ts) and all eight are things a browser will decode. So
 * overPixelBudget() answered false for a BMP on the grounds that it could not
 * read one - and a sixty-byte file whose BITMAPINFOHEADER declares 30000x30000
 * went straight to createImageBitmap(), which allocated about 3.6 GB. That is
 * precisely the allocation this module's header says it exists to stop, made by
 * a file small enough to paste into a chat window.
 *
 * Being unable to read a header is still a false: the caps and the decoder
 * remain the backstop, and a false positive here would refuse somebody's
 * photograph. That asymmetry is why the ISO-BMFF branch scans for `ispe` rather
 * than walking the box tree - a miss costs a check we did not make, and a wrong
 * hit costs a picture.
 */
export function imageDimensions(b: Uint8Array): Dimensions | null {
  const n = b.length;
  // PNG: IHDR width/height are big-endian at fixed offsets 16 and 20.
  if (n >= 24 && b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) {
    return { w: u32be(b, 16), h: u32be(b, 20) };
  }
  // GIF: logical-screen width/height, little-endian at 6 and 8.
  if (n >= 10 && b[0] === 0x47 && b[1] === 0x49 && b[2] === 0x46) {
    return { w: u16le(b, 6), h: u16le(b, 8) };
  }
  // WebP: RIFF ... WEBP, then a chunk fourcc that decides the dimension layout.
  if (n >= 30 && b[0] === 0x52 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x46
    && b[8] === 0x57 && b[9] === 0x45 && b[10] === 0x42 && b[11] === 0x50) {
    const cc = String.fromCharCode(b[12], b[13], b[14], b[15]);
    if (cc === 'VP8X') return { w: u24le(b, 24) + 1, h: u24le(b, 27) + 1 };
    if (cc === 'VP8 ') return { w: u16le(b, 26) & 0x3fff, h: u16le(b, 28) & 0x3fff };
    if (cc === 'VP8L') {
      const b0 = b[21], b1 = b[22], b2 = b[23], b3 = b[24];
      return {
        w: 1 + (((b1 & 0x3f) << 8) | b0),
        h: 1 + (((b3 & 0x0f) << 10) | (b2 << 2) | ((b1 & 0xc0) >> 6)),
      };
    }
    return null;
  }
  // JPEG: walk the segment chain to the start-of-frame, which carries the size.
  if (n >= 4 && b[0] === 0xff && b[1] === 0xd8) {
    let o = 2;
    while (o + 9 < n) {
      if (b[o] !== 0xff) { o++; continue; }
      const marker = b[o + 1];
      // Standalone markers (SOI, EOI, RSTn) have no length field.
      if (marker === 0xd8 || marker === 0xd9 || (marker >= 0xd0 && marker <= 0xd7)) { o += 2; continue; }
      const len = u16be(b, o + 2);
      if (len < 2) break;
      // SOF0..SOF15 carry dimensions - except DHT (C4), JPG (C8), DAC (CC).
      if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
        return { h: u16be(b, o + 5), w: u16be(b, o + 7) };
      }
      o += 2 + len;
    }
    return null;
  }
  // BMP: BITMAPINFOHEADER width/height, signed little-endian at 18 and 22. The
  // height is negative for a top-down bitmap, which is legal and says nothing
  // about how many pixels there are.
  if (n >= 26 && b[0] === 0x42 && b[1] === 0x4d) {
    const dv = new DataView(b.buffer, b.byteOffset, b.byteLength);
    return { w: Math.abs(dv.getInt32(18, true)), h: Math.abs(dv.getInt32(22, true)) };
  }
  // ICO/CUR: the largest entry in the directory, since that is the one a
  // browser draws. A zero byte in the size field means 256, which is the format
  // being clever about fitting a dimension in eight bits.
  if (n >= 6 && b[0] === 0 && b[1] === 0 && (b[2] === 1 || b[2] === 2) && b[3] === 0) {
    const count = u16le(b, 4);
    let best: Dimensions | null = null;
    for (let i = 0; i < count && 6 + i * 16 + 2 <= n; i++) {
      const at = 6 + i * 16;
      const w = b[at] || 256, h = b[at + 1] || 256;
      if (!best || w * h > best.w * best.h) best = { w, h };
    }
    return best;
  }
  // AVIF and HEIC: ISO-BMFF, so the size lives in an `ispe` box somewhere in
  // the metadata rather than at a fixed offset. Scanned for rather than walked,
  // which is the same bargain the JPEG branch above makes - the box tree is
  // deep, the fourcc is four bytes, and being wrong here costs a false negative
  // rather than a false positive.
  if (n >= 12 && b[4] === 0x66 && b[5] === 0x74 && b[6] === 0x79 && b[7] === 0x70) {
    let best: Dimensions | null = null;
    for (let o = 0; o + 20 <= n; o++) {
      if (b[o] !== 0x69 || b[o + 1] !== 0x73 || b[o + 2] !== 0x70 || b[o + 3] !== 0x65) continue;
      // ispe: fourcc, version+flags (4), width (4), height (4).
      const w = u32be(b, o + 8), h = u32be(b, o + 12);
      if (w > 0 && h > 0 && (!best || w * h > best.w * best.h)) best = { w, h };
    }
    return best;
  }
  // TIFF: the first IFD's ImageWidth (256) and ImageLength (257). Both may be
  // SHORT or LONG, which is why the type is read rather than assumed.
  if (n >= 8 && ((b[0] === 0x49 && b[1] === 0x49) || (b[0] === 0x4d && b[1] === 0x4d))) {
    const le = b[0] === 0x49;
    const dv = new DataView(b.buffer, b.byteOffset, b.byteLength);
    if (dv.getUint16(2, le) !== 42) return null;
    const ifd = dv.getUint32(4, le);
    if (ifd + 2 > n) return null;
    const entries = dv.getUint16(ifd, le);
    let w = 0, h = 0;
    for (let i = 0; i < entries && ifd + 2 + i * 12 + 12 <= n; i++) {
      const at = ifd + 2 + i * 12;
      const tag = dv.getUint16(at, le);
      if (tag !== 256 && tag !== 257) continue;
      const type = dv.getUint16(at + 2, le);
      const value = type === 3 ? dv.getUint16(at + 8, le)
        : type === 4 ? dv.getUint32(at + 8, le)
        : 0;
      if (tag === 256) w = value; else h = value;
    }
    return w > 0 && h > 0 ? { w, h } : null;
  }
  return null;
}

/** How much of a file to read to find its dimensions - JPEG needs a scan. */
const HEADER_BYTES = 128 * 1024;

/**
 * Whether a file is a raster image that declares more pixels than the budget.
 *
 * Reads a header slice only. An unrecognised or unreadable header returns false:
 * the byte caps and the decoder remain the backstop for anything this cannot
 * measure cheaply.
 */
export async function overPixelBudget(file: Blob): Promise<boolean> {
  try {
    const head = new Uint8Array(await file.slice(0, HEADER_BYTES).arrayBuffer());
    const dims = imageDimensions(head);
    return !!dims && dims.w > 0 && dims.h > 0 && dims.w * dims.h > IMPORT_LIMITS.pixels;
  } catch {
    return false;
  }
}
