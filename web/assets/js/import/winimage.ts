// Two Windows picture formats that arrive headless and need bytes prepended:
//   RT_ICON → wrapAsIco(): manufactures a 22-byte ICONDIR to make a .ico.
//   CF_DIB  → dibToBmp():  computes pixel offset and writes BITMAPFILEHEADER.
// Single module so the logic is not duplicated across callers with subtle
// differences (edge normalisation, colour count). All fields bounds-checked.

import type { Bytes } from '../bytes.ts';

/** Second fence (callers already bound their reads). 64 MB far exceeds any
 * real icon/clipboard bitmap. */
const MAX_PICTURE = 64 * 1024 * 1024;

/** The size of the two headers this module writes. */
const ICONDIR = 6;
const ICONDIRENTRY = 16;
const BITMAPFILEHEADER = 14;

/** PNG by its first eight bytes. */
export const isPng = (b: Uint8Array) => b.length > 8
  && b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4E && b[3] === 0x47
  && b[4] === 0x0D && b[5] === 0x0A && b[6] === 0x1A && b[7] === 0x0A;

/** Apple-optimised PNG (CgBI chunk where IHDR belongs). BGRA + premultiplied
 * alpha — no browser outside Apple's decodes it. */
export const isCgBI = (b: Uint8Array) => isPng(b)
  && b.length > 16
  && b[12] === 0x43 && b[13] === 0x67 && b[14] === 0x42 && b[15] === 0x49;

/** A PNG a browser will actually draw. */
export const isDrawablePng = (b: Uint8Array) => isPng(b) && !isCgBI(b);

/** Wrap a headless icon image as a one-image .ico. w/h from the group record
 * (DIB's own header doubles height for the AND mask). 256 written as 0 (one
 * byte). PNG members returned as-is — already drawable. */
export function wrapAsIco(
  image: Bytes,
  w: number,
  h: number,
  planes = 1,
  bits = 32,
): Bytes | null {
  if (!image.length || image.length > MAX_PICTURE) return null;
  if (isPng(image)) return image;

  const out = new Uint8Array(ICONDIR + ICONDIRENTRY + image.length);
  const dv = new DataView(out.buffer);
  // ICONDIR: reserved must be 0, type 1 is an icon, then the member count.
  dv.setUint16(2, 1, true);
  dv.setUint16(4, 1, true);
  // ICONDIRENTRY. The two edges are bytes, and 0 means 256.
  out[6] = w >= 256 ? 0 : Math.max(0, w | 0);
  out[7] = h >= 256 ? 0 : Math.max(0, h | 0);
  out[8] = 0;                                   // colours in palette, 0 past 8bpp
  out[9] = 0;                                   // reserved
  dv.setUint16(10, planes || 1, true);
  dv.setUint16(12, bits || 32, true);
  dv.setUint32(14, image.length, true);
  dv.setUint32(18, ICONDIR + ICONDIRENTRY, true);
  out.set(image, ICONDIR + ICONDIRENTRY);
  return out;
}

/** Prepend BITMAPFILEHEADER to a clipboard DIB. Pixel offset computed from
 * header size + palette (≤8bpp). Wrong offset = image drawn from colour table
 * (looks like static). OS/2 BITMAPCOREHEADER (size 12) declined. */
export function dibToBmp(dib: Bytes): Bytes | null {
  if (dib.length < 40 || dib.length > MAX_PICTURE) return null;
  const dv = new DataView(dib.buffer, dib.byteOffset, dib.byteLength);

  const headerSize = dv.getUint32(0, true);
  if (headerSize !== 40 && headerSize !== 108 && headerSize !== 124) return null;
  if (headerSize > dib.length) return null;

  const bits = dv.getUint16(14, true);
  if (bits !== 1 && bits !== 4 && bits !== 8 && bits !== 16 && bits !== 24 && bits !== 32) return null;
  const clrUsed = dv.getUint32(32, true);

  // Palette only at ≤8bpp; above 8 the field is a hint and would misplace pixels.
  const entries = bits <= 8 ? (clrUsed || (1 << bits)) : 0;
  if (entries > 256) return null;
  // BI_BITFIELDS (3) and BI_ALPHABITFIELDS (6) after a 40-byte header put
  // three or four DWORD masks between it and the pixels. The V4 and V5
  // headers carry the masks inside themselves.
  const compression = dv.getUint32(16, true);
  const masks = headerSize === 40 ? (compression === 3 ? 12 : compression === 6 ? 16 : 0) : 0;
  const pixelOffset = BITMAPFILEHEADER + headerSize + masks + entries * 4;
  if (pixelOffset >= BITMAPFILEHEADER + dib.length) return null;

  const out = new Uint8Array(BITMAPFILEHEADER + dib.length);
  const odv = new DataView(out.buffer);
  out[0] = 0x42;                                // 'B'
  out[1] = 0x4D;                                // 'M'
  odv.setUint32(2, out.length, true);
  odv.setUint32(10, pixelOffset, true);
  out.set(dib, BITMAPFILEHEADER);
  return out;
}
