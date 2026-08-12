// The one memory policy the importer answers to.
//
// import/drop.js caps a drop at 500 *files*, which is a UX guard against
// dropping a photo library by accident - not a memory boundary. A count says
// nothing about bytes: five files can be five 4K videos, and one 50 KB PNG can
// claim 30000x30000 and cost gigabytes the moment createImageBitmap() touches
// it. This module is the boundary the count was mistaken for. See AUD-05 in
// research/full-code-audit-2026-07-26.md.
//
// Pure by design - no DOM, no state - so it sits beside util/geometry and both
// the importer and any future caller share one set of limits. The only browser
// object it touches is a File, and only inside a function (File.slice), so this
// stays loadable without a browser like the rest of import/.

export const IMPORT_LIMITS = {
  /** One file, raw. Matches the ZIP single-entry ceiling in storage/zip.js. */
  fileBytes: 512 * 1024 ** 2,
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
      if (spent + n > limit) return false;
      spent += n;
      return true;
    },
    spent: () => spent,
  };
}

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
 * their size in a fixed or shallow-scannable header: PNG, GIF, JPEG, WebP.
 * Returns `{ w, h }` or null when the bytes are unrecognised or truncated - in
 * which case the byte caps still apply and the decoder's own failure is the
 * backstop.
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
