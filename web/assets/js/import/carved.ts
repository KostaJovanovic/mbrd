// Four more files that open with a picture of themselves.
//
// The last of the embedded-thumbnail readers, and the ones that share nothing
// but their shape: each is a header with a picture somewhere behind it, each is
// twenty to sixty lines, and not one of them is worth a module. They live
// together because the alternative is four files whose headers would all say the
// same thing.
//
//   .icns    An Apple icon: a chunk list, and since Snow Leopard the large
//            members are ordinary PNGs sitting inside it.
//   .dwg     AutoCAD keeps a preview image the drawing's own header points at -
//            the picture Explorer and every CAD browser shows.
//   .eps     A DOS-format EPS opens with a binary header giving the offsets of
//            the PostScript and of a preview for screens that cannot render it.
//   .blend   Blender writes a small render of the scene into the file, when the
//            preference for it is on.
//
// What they have in common with the rest of import/ is the discipline: read a
// bounded head, believe no length until it has been checked against the bytes
// actually in hand, identify what comes out by its own first bytes, and answer
// null rather than throwing.
//
// ── The one that is honest about mostly failing ──
//
// The EPS preview is a TIFF, and a TIFF is not something a browser draws. It is
// handed to the reader in import/preview.js, which knows how to find a JPEG
// inside one - and an EPS preview is usually uncompressed RGB, so usually there
// is no JPEG to find and the answer is null. It is here because the carve is ten
// lines and the miss costs nothing, not because it is expected to work often.

import { surface, surfaceToBlob } from '../canvas/surface.ts';
import { embeddedPreview } from './preview.ts';
import { dibToBmp, isPng } from './winimage.ts';

/** A view whose buffer is named, so a subarray of it stays a legal BlobPart. */
type Bytes = Uint8Array<ArrayBuffer>;

/** How much of a file's front is read to find its header. */
const HEAD = 4 * 1024 * 1024;

/** The largest picture any of these will hand back. */
const MAX_PICTURE = 64 * 1024 * 1024;

/** A picture under this is a placeholder rather than a thumbnail. */
const MIN_IMAGE = 256;

const le32 = (b: Bytes, i: number) =>
  ((b[i] | (b[i + 1] << 8) | (b[i + 2] << 16)) + b[i + 3] * 0x1000000) >>> 0;
const be32 = (b: Bytes, i: number) =>
  ((b[i] << 24) | (b[i + 1] << 16) | (b[i + 2] << 8) | b[i + 3]) >>> 0;
const tag = (b: Bytes, i: number, n = 4) =>
  i + n <= b.length ? String.fromCharCode(...b.subarray(i, i + n)) : '';

/** A bounded read, the same shape every other reader in import/ uses. */
async function bytes(file: Blob, start: number, length: number): Promise<Bytes> {
  if (start < 0 || length <= 0 || start >= file.size) return new Uint8Array(0);
  return new Uint8Array(await file.slice(start, start + length).arrayBuffer());
}

/** The extensions this module answers for. */
const CARVED = new Set(['icns', 'dwg', 'eps', 'epsf', 'epsi', 'blend', 'vcf']);

/** Whether this file is one of the four. */
export const isCarved = (ext: string) => CARVED.has(ext);

/**
 * A picture out of `file`, or null.
 *
 * Answers with bytes, which the caller sniffs and names - see import/document.js,
 * which owns the list of picture types this app will actually mount.
 */
export async function carvedPicture(file: Blob, ext: string): Promise<Bytes | null> {
  try {
    if (ext === 'icns') return await fromIcns(file);
    if (ext === 'dwg') return await fromDwg(file);
    if (ext === 'blend') return await fromBlend(file);
    if (ext === 'vcf') return await fromVcard(file);
    if (ext === 'eps' || ext === 'epsf' || ext === 'epsi') return await fromEps(file);
    return null;
  } catch (err) {
    console.warn('[mbrd] carved: nothing came out of the header', err);
    return null;
  }
}

// ---------------------------------------------------------------------------
// Apple icons
// ---------------------------------------------------------------------------

/** Chunk types that are structure rather than picture. */
const ICNS_SKIP = new Set(['TOC ', 'icnV', 'info', 'name', 'sbtp', 'slct']);

/**
 * The largest PNG inside an `.icns`.
 *
 * Largest and not first, which is the whole of the difference between a card
 * showing a recognisable icon and one showing a 16-pixel smudge: the chunks are
 * ordered smallest-first in most files that Apple's own tools write, so "the
 * first PNG" is the worst one in the file. The sibling analyser takes the first
 * while its comment says largest, which is worth knowing before copying it.
 *
 * Only PNG members are taken. The legacy `is32`/`il32` members are RLE-packed
 * 24-bit ARGB with their alpha in a separate `*mk` chunk, and the `ic09`-era
 * ones can be JPEG 2000 - none of which a browser decodes, and unpacking them
 * here would be a decoder rather than a carve.
 */
async function fromIcns(file: Blob): Promise<Bytes | null> {
  const head = await bytes(file, 0, Math.min(HEAD, file.size));
  if (head.length < 16 || tag(head, 0) !== 'icns') return null;

  // The file states its own total length, which is the bound every offset below
  // is checked against rather than the length of what happened to be read.
  const total = Math.min(be32(head, 4) || head.length, head.length);
  let best: Bytes | null = null;
  let at = 8;
  // A chunk header is eight bytes, so a run of them cannot outnumber the bytes.
  for (let guard = 0; at + 8 <= total && guard < 4096; guard++) {
    const type = tag(head, at);
    const size = be32(head, at + 4);
    // A size that does not include its own header, or that runs off the end, is a
    // chunk list to stop reading rather than to skip through.
    if (size < 8 || at + size > total) break;
    if (!ICNS_SKIP.has(type)) {
      const body = head.subarray(at + 8, at + size);
      if (isPng(body) && body.length >= MIN_IMAGE && (!best || body.length > best.length)) {
        best = body;
      }
    }
    at += size;
  }
  return best;
}

// ---------------------------------------------------------------------------
// AutoCAD
// ---------------------------------------------------------------------------

/**
 * The sentinel that stands in front of a DWG preview section.
 *
 * Checked rather than trusted-by-offset, because the seeker below points into a
 * file whose layout changed between releases and a pointer that lands somewhere
 * plausible is worse than one that lands nowhere.
 */
const DWG_SENTINEL = [
  0x1F, 0x25, 0x6D, 0x07, 0xD4, 0x36, 0x28, 0x28,
  0x9D, 0x57, 0xCA, 0x3F, 0x9D, 0x44, 0x10, 0x2B,
];

/** Preview record types. 1 is a headerless bitmap, 2 a metafile, 3 a PNG. */
const DWG_BMP = 1;
const DWG_PNG = 3;

/**
 * The preview picture AutoCAD stores in a drawing.
 *
 * The image seeker is a 32-bit pointer at offset 0x0D, and it is the one number
 * this reader needs. It has been there since R13 - what changed at R2004 is
 * everything *around* it, which is why a reader that hard-codes a layout for one
 * era finds nothing on the other. Reading the seeker and then verifying the
 * sentinel where it points works for both, and refuses politely where the release
 * is one this does not know: a pointer that lands on sixteen bytes that are not
 * the sentinel is not a preview section.
 */
async function fromDwg(file: Blob): Promise<Bytes | null> {
  const head = await bytes(file, 0, 64);
  // Every release stamps six characters: AC1015 is R2000, AC1032 is R2018.
  if (head.length < 32 || tag(head, 0, 2) !== 'AC') return null;

  const seeker = le32(head, 0x0D);
  if (!seeker || seeker + 20 > file.size) return null;

  const at = await bytes(file, seeker, 4096);
  if (at.length < 24) return null;
  if (!DWG_SENTINEL.every((v, i) => at[i] === v)) return null;

  const count = at[20];
  if (!count || count > 8) return null;
  for (let i = 0; i < count; i++) {
    const p = 21 + i * 9;
    if (p + 9 > at.length) break;
    const code = at[p];
    const start = le32(at, p + 1);
    const size = le32(at, p + 5);
    if (!size || size > MAX_PICTURE || start + size > file.size) continue;
    if (code !== DWG_BMP && code !== DWG_PNG) continue;

    const body = await bytes(file, start, size);
    if (body.length < MIN_IMAGE) continue;
    if (code === DWG_PNG) {
      if (isPng(body)) return body;
      continue;
    }
    // Code 1 is a BITMAPINFOHEADER and pixels with no file header, which is the
    // same headerless bitmap a compound file's thumbnail is - see winimage.js.
    const bmp = dibToBmp(body);
    if (bmp) return bmp;
  }
  return null;
}

// ---------------------------------------------------------------------------
// DOS EPS
// ---------------------------------------------------------------------------

/**
 * The preview out of a binary EPS.
 *
 * A DOS-format EPS opens with a 30-byte binary header that is nothing but
 * offsets: where the PostScript is, where a WMF preview is, where a TIFF one is.
 * Carving is arithmetic - there is no parsing to do, the numbers are simply
 * there.
 *
 * **And it usually finds nothing, which is expected rather than a fault.** The
 * preview is a TIFF, browsers do not draw TIFFs, and the one thing that can be
 * done with it is to look for a JPEG inside - which is exactly what
 * import/preview.js already does for camera RAW. An EPS preview is normally
 * uncompressed RGB, so normally there is no JPEG in there and the card is the
 * grey one it was. The alternative is decoding a TIFF, which is a decoder.
 */
async function fromEps(file: Blob): Promise<Bytes | null> {
  const head = await bytes(file, 0, 30);
  if (head.length < 30) return null;
  // The magic that says this is the binary form rather than plain PostScript.
  if (head[0] !== 0xC5 || head[1] !== 0xD0 || head[2] !== 0xD3 || head[3] !== 0xC6) return null;

  const at = le32(head, 20);
  const size = le32(head, 24);
  if (!at || !size || size > MAX_PICTURE || at + size > file.size) return null;

  const tiff = await bytes(file, at, size);
  if (tiff.length < MIN_IMAGE) return null;
  const found = await embeddedPreview(new Blob([tiff]));
  return found ? new Uint8Array(await found.arrayBuffer()) : null;
}

// ---------------------------------------------------------------------------
// Blender
// ---------------------------------------------------------------------------

/** How far into the block list the preview is looked for. */
const BLEND_MAX_BLOCKS = 64;

/**
 * The render Blender saves into a `.blend`.
 *
 * The only reader here whose answer is pixels rather than a file, and the only
 * one that has to read the file's own header before it can read anything else.
 * Bytes 7 to 11 give the pointer size and the endianness, and both change the
 * shape of every block header that follows:
 *
 *   byte 7    '_' for 32-bit pointers, '-' for 64-bit
 *   byte 8    'v' little-endian, 'V' big-endian
 *
 * A block header is `code(4) length(4) old-pointer(4|8) SDNA(4) count(4)`, so the
 * pointer size is not a detail - get it wrong and every offset after the first
 * block is out by four bytes. That is why this is a walk rather than a fixed
 * offset, and why a compressed `.blend` (gzip or Zstandard, which is now the
 * default in Blender's own save dialog) is declined rather than guessed at: the
 * header is not there to read.
 *
 * The `TEST` block is the preview: two 32-bit dimensions and then raw RGBA, which
 * is why this ends at a canvas.
 */
async function fromBlend(file: Blob): Promise<Bytes | null> {
  const head = await bytes(file, 0, Math.min(HEAD, file.size));
  if (head.length < 12 || tag(head, 0, 7) !== 'BLENDER') return null;

  const pointer = head[7] === 0x2D ? 8 : head[7] === 0x5F ? 4 : 0;
  if (!pointer) return null;
  // 'v' is little-endian, 'V' big. Only the first is worth carrying: every
  // machine Blender still runs on is little-endian, and a reader for the other
  // could not be tested against a real file.
  if (head[8] !== 0x76) return null;

  const headerLen = 16 + pointer;
  let at = 12;
  for (let n = 0; n < BLEND_MAX_BLOCKS && at + headerLen <= head.length; n++) {
    const code = tag(head, at);
    const length = le32(head, at + 4);
    if (code === 'ENDB') break;
    if (length > head.length) break;

    if (code === 'TEST') {
      const body = at + headerLen;
      if (body + 8 > head.length) return null;
      const w = le32(head, body);
      const h = le32(head, body + 4);
      // A preview is a couple of hundred pixels square. The cap is what stops a
      // lying pair of dimensions from asking for a gigabyte of canvas.
      if (w < 1 || h < 1 || w > 4096 || h > 4096) return null;
      const need = w * h * 4;
      if (body + 8 + need > head.length) return null;
      return await fromRgba(head.subarray(body + 8, body + 8 + need), w, h);
    }
    at += headerLen + length;
  }
  return null;
}

/**
 * Raw RGBA as a picture file.
 *
 * Through canvas/surface.js, which is the same pair import/slide.js uses and
 * which falls back to a `<canvas>` element where OffscreenCanvas is absent. The
 * row order is flipped because Blender writes its preview bottom-up, the way
 * OpenGL reads a framebuffer.
 */
async function fromRgba(rgba: Bytes, w: number, h: number): Promise<Bytes | null> {
  const face = surface(w, h);
  if (!face) return null;
  const image = new ImageData(w, h);
  for (let y = 0; y < h; y++) {
    const from = (h - 1 - y) * w * 4;
    image.data.set(rgba.subarray(from, from + w * 4), y * w * 4);
  }
  face.ctx.putImageData(image, 0, 0);
  const blob = await surfaceToBlob(face, 'image/png', 1);
  return blob ? new Uint8Array(await blob.arrayBuffer()) : null;
}

// ---------------------------------------------------------------------------
// vCard
// ---------------------------------------------------------------------------

/** How much of a contact file is read looking for its picture. */
const VCARD_MAX = 8 * 1024 * 1024;

/**
 * The photograph in a contact card.
 *
 * Text rather than binary, and the one reader here that is a search rather than a
 * walk. Two spellings, both still written: vCard 4.0 puts a `data:` URI in the
 * value, and 3.0 puts base64 after an `ENCODING=b` parameter. Both may be folded
 * across lines - a continuation line begins with a space or a tab, and unfolding
 * is the step that is easy to miss and produces base64 with spaces in it.
 */
async function fromVcard(file: Blob): Promise<Bytes | null> {
  const head = await bytes(file, 0, Math.min(VCARD_MAX, file.size));
  const text = new TextDecoder().decode(head);
  if (!/^BEGIN:VCARD/im.test(text)) return null;

  // Unfold first: a folded line is a newline followed by one space or tab, and
  // the bytes either side of it belong to the same value.
  const unfolded = text.replace(/\r?\n[ \t]/g, '');
  const line = unfolded.split(/\r?\n/).find(l => /^PHOTO[;:]/i.test(l));
  if (!line) return null;

  const value = line.slice(line.indexOf(':') + 1).trim();
  const base64 = /^data:image\/[a-z0-9.+-]+;base64,(.*)$/i.exec(value)?.[1]
    ?? (/ENCODING=b/i.test(line) ? value : null);
  if (!base64) return null;

  try {
    const raw = atob(base64.replace(/\s+/g, ''));
    if (raw.length < MIN_IMAGE || raw.length > MAX_PICTURE) return null;
    const out = new Uint8Array(raw.length);
    for (let i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i);
    return out;
  } catch {
    // A PHOTO whose base64 does not decode is a card with no picture in it.
    return null;
  }
}
