// The two Windows pictures that arrive without their own front page.
//
// Windows has a long habit of storing a picture as *the part after the header*,
// on the understanding that whoever reads it knows which header to put back.
// Two of those turn up wherever this app goes looking inside a file for a
// thumbnail, and neither is drawable until the missing bytes are in front of it:
//
//   RT_ICON       An icon resource inside a .exe or .dll is a lone image with no
//                 ICONDIR in front of it - the directory lives in a *separate*
//                 RT_GROUP_ICON resource, which is what names the member and its
//                 size. Handed to an <img> as-is it is not a file of any type.
//                 wrapAsIco() manufactures the 22 bytes that make it a
//                 one-image .ico, which every browser decodes.
//
//   CF_DIB        A clipboard bitmap - the thing a Windows application pastes,
//                 and the thing SolidWorks and old Office store as their
//                 thumbnail inside a compound file - is a BITMAPINFOHEADER and
//                 pixels with no 14-byte BITMAPFILEHEADER. dibToBmp() computes
//                 where the pixels start and writes that header.
//
// Both are pure arithmetic over bytes somebody else wrote, so both follow the
// rule the rest of import/ follows: every field is bounds-checked against the
// buffer actually in hand, nothing is trusted because the container said it, and
// anything that does not add up comes back null rather than as a picture that
// will not draw.
//
// One module rather than two functions in the two callers, and that is not tidiness
// - it is the whole reason to have the file. The sibling analyser has this logic
// three times (renderers/ico.ts, renderers/proprietary.ts, renderers/solidworks.ts)
// and the three disagree: one preserves the colour count and one hardcodes it,
// one normalises a 256-pixel edge and one does not. Those differences are
// invisible until an icon comes out the wrong size, which is the kind of bug
// that is found years later by somebody who is looking for something else.

/** A view whose buffer is named, so a subarray of it stays a legal BlobPart. */
type Bytes = Uint8Array<ArrayBuffer>;

/**
 * The largest picture either of these will build.
 *
 * Both take a length from a structure inside the file, and both are reached from
 * a reader that has already bounded its own read - so this is the second fence
 * rather than the first. A 256x256 32-bit icon is 256 KB and the biggest thing
 * either format legitimately holds; 64 MB is far past every honest case and
 * still refuses the allocation a lying header is asking for.
 */
const MAX_PICTURE = 64 * 1024 * 1024;

/** The size of the two headers this module writes. */
const ICONDIR = 6;
const ICONDIRENTRY = 16;
const BITMAPFILEHEADER = 14;

/** PNG by its first eight bytes. */
export const isPng = (b: Uint8Array) => b.length > 8
  && b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4E && b[3] === 0x47
  && b[4] === 0x0D && b[5] === 0x0A && b[6] === 0x1A && b[7] === 0x0A;

/**
 * Whether a PNG is one of Apple's, which no browser will decode.
 *
 * Xcode rewrites every PNG inside an .app: the channels are byte-swapped to BGRA
 * and the alpha is premultiplied, and the file is marked by a `CgBI` chunk sitting
 * where `IHDR` belongs. It is still a PNG by its signature and still fails in
 * every decoder outside Apple's, so sniffing the first eight bytes is not enough
 * to answer "can this be shown" for anything out of an .ipa.
 *
 * Declining one is the same rule this app already applies to the .emf spelling of
 * docProps/thumbnail: a picture nothing can draw is worse than no picture, because
 * the card stops saying what the file is and starts showing a broken image.
 */
export const isCgBI = (b: Uint8Array) => isPng(b)
  && b.length > 16
  && b[12] === 0x43 && b[13] === 0x67 && b[14] === 0x42 && b[15] === 0x49;

/** A PNG a browser will actually draw. */
export const isDrawablePng = (b: Uint8Array) => isPng(b) && !isCgBI(b);

/**
 * A lone icon image as a one-image `.ico`.
 *
 * `w` and `h` come from the GRPICONDIRENTRY that named this member, because the
 * ICONDIRENTRY needs them and a headerless DIB cannot be asked - its own
 * BITMAPINFOHEADER states *twice* the height, the image stacked on its AND mask,
 * which is the trap in reading the dimensions out of the payload instead.
 *
 * A 256-pixel edge is written as 0, which is what the format means by it: the
 * field is one byte, 256 does not fit, and 0 is the agreed spelling. Getting this
 * wrong is how a 256x256 icon becomes a 0x0 one that decodes to nothing.
 *
 * A PNG member is handed back untouched. Since Vista the 256-pixel member of an
 * icon group is a PNG rather than a DIB, and a PNG inside an ICONDIR is legal but
 * pointless here - the bytes are already a file every browser draws, and one less
 * wrapper is one less thing to have got wrong.
 */
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

/**
 * A clipboard DIB as a `.bmp`.
 *
 * The one number that has to be right is where the pixels begin, and it is not
 * stated anywhere in a DIB - it is the header's own length plus whatever palette
 * follows it. The palette is the part worth reading twice: it is present at 8 bits
 * per pixel and below, its length is `biClrUsed` entries when that is set and the
 * full 2^bits when it is not, and each entry is four bytes. A BITMAPFILEHEADER
 * whose offset lands short of the palette's end produces a picture drawn out of
 * its own colour table, which looks like static rather than like an error.
 *
 * Header sizes: 40 is BITMAPINFOHEADER, 108 and 124 are the V4 and V5 headers,
 * 12 is the OS/2 BITMAPCOREHEADER whose fields sit in different places - that last
 * one is declined rather than mis-read.
 */
export function dibToBmp(dib: Bytes): Bytes | null {
  if (dib.length < 40 || dib.length > MAX_PICTURE) return null;
  const dv = new DataView(dib.buffer, dib.byteOffset, dib.byteLength);

  const headerSize = dv.getUint32(0, true);
  if (headerSize !== 40 && headerSize !== 108 && headerSize !== 124) return null;
  if (headerSize > dib.length) return null;

  const bits = dv.getUint16(14, true);
  if (bits !== 1 && bits !== 4 && bits !== 8 && bits !== 16 && bits !== 24 && bits !== 32) return null;
  const clrUsed = dv.getUint32(32, true);

  // Only a palettised bitmap has a palette. Above 8 bits the field is either zero
  // or an optimisation hint, and honouring it there pushes the pixel offset past
  // where the pixels actually are.
  const entries = bits <= 8 ? (clrUsed || (1 << bits)) : 0;
  if (entries > 256) return null;
  const pixelOffset = BITMAPFILEHEADER + headerSize + entries * 4;
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
