// A raster picture's pixel dimensions, read from its header without decoding.
// Base layer and self-contained: import/budget.ts asks before a decode is
// allowed, canvas/display.ts before deciding whether a copy is worth making.
// Unrecognised or truncated headers answer null - the decoder is the backstop.

const u16be = (b: Uint8Array, o: number) => (b[o] << 8) | b[o + 1];
const u16le = (b: Uint8Array, o: number) => b[o] | (b[o + 1] << 8);
const u24le = (b: Uint8Array, o: number) => b[o] | (b[o + 1] << 8) | (b[o + 2] << 16);
const u32be = (b: Uint8Array, o: number) => b[o] * 2 ** 24 + (b[o + 1] << 16) + (b[o + 2] << 8) + b[o + 3];

export type Dimensions = { w: number, h: number };

// Read pixel dimensions from a raster header without decoding.
// Covers PNG, GIF, JPEG, WebP, BMP, ICO, AVIF/HEIC, TIFF.
// Returns null for unrecognised/truncated headers (the decoder is the backstop).
export function imageDimensions(b: Uint8Array): Dimensions | null {
  const n = b.length;
  // PNG: IHDR w/h at offsets 16, 20 (BE).
  if (n >= 24 && b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) {
    return { w: u32be(b, 16), h: u32be(b, 20) };
  }
  // GIF: w/h at 6, 8 (LE).
  if (n >= 10 && b[0] === 0x47 && b[1] === 0x49 && b[2] === 0x46) {
    return { w: u16le(b, 6), h: u16le(b, 8) };
  }
  // WebP: dimension layout depends on the chunk fourcc.
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
  // JPEG: walk segments to SOF.
  if (n >= 4 && b[0] === 0xff && b[1] === 0xd8) {
    let o = 2;
    while (o + 9 < n) {
      if (b[o] !== 0xff) { o++; continue; }
      const marker = b[o + 1];
      // SOI, EOI, RSTn have no length.
      if (marker === 0xd8 || marker === 0xd9 || (marker >= 0xd0 && marker <= 0xd7)) { o += 2; continue; }
      const len = u16be(b, o + 2);
      if (len < 2) break;
      // SOF0..SOF15 minus DHT(C4), JPG(C8), DAC(CC).
      if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
        return { h: u16be(b, o + 5), w: u16be(b, o + 7) };
      }
      o += 2 + len;
    }
    return null;
  }
  // BMP: signed LE w/h at 18, 22 (negative height = top-down, same pixel count).
  if (n >= 26 && b[0] === 0x42 && b[1] === 0x4d) {
    const dv = new DataView(b.buffer, b.byteOffset, b.byteLength);
    return { w: Math.abs(dv.getInt32(18, true)), h: Math.abs(dv.getInt32(22, true)) };
  }
  // ICO/CUR: largest directory entry. 0 in size field means 256.
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
  // AVIF/HEIC: scan for `ispe` box rather than walking the full box tree.
  if (n >= 12 && b[4] === 0x66 && b[5] === 0x74 && b[6] === 0x79 && b[7] === 0x70) {
    let best: Dimensions | null = null;
    for (let o = 0; o + 20 <= n; o++) {
      if (b[o] !== 0x69 || b[o + 1] !== 0x73 || b[o + 2] !== 0x70 || b[o + 3] !== 0x65) continue;
      // ispe: fourcc + version+flags(4) + w(4) + h(4).
      const w = u32be(b, o + 8), h = u32be(b, o + 12);
      if (w > 0 && h > 0 && (!best || w * h > best.w * best.h)) best = { w, h };
    }
    return best;
  }
  // TIFF: IFD tags 256/257. Type may be SHORT or LONG.
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

/** How much of a file the header read takes - a JPEG's SOF can sit behind its EXIF. */
export const HEADER_BYTES = 128 * 1024;

/** A Blob's dimensions from its first HEADER_BYTES, or null. Never throws. */
export async function blobDimensions(blob: Blob): Promise<Dimensions | null> {
  try {
    const dims = imageDimensions(new Uint8Array(await blob.slice(0, HEADER_BYTES).arrayBuffer()));
    return dims && dims.w > 0 && dims.h > 0 ? dims : null;
  } catch {
    return null;
  }
}
