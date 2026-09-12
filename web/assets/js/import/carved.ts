// Embedded-picture carvers for .icns, .dwg, .eps, .blend, and .vcf.
// Each reads a bounded header, validates offsets, and returns null on failure.

import { surface, surfaceToBlob } from '../canvas/surface.ts';
import { embeddedPreview } from './preview.ts';
import { dibToBmp, isPng } from './winimage.ts';

type Bytes = Uint8Array<ArrayBuffer>;

const HEAD = 4 * 1024 * 1024;

const MAX_PICTURE = 64 * 1024 * 1024;
const MIN_IMAGE = 256;

const le32 = (b: Bytes, i: number) =>
  ((b[i] | (b[i + 1] << 8) | (b[i + 2] << 16)) + b[i + 3] * 0x1000000) >>> 0;
const be32 = (b: Bytes, i: number) =>
  ((b[i] << 24) | (b[i + 1] << 16) | (b[i + 2] << 8) | b[i + 3]) >>> 0;
const tag = (b: Bytes, i: number, n = 4) =>
  i + n <= b.length ? String.fromCharCode(...b.subarray(i, i + n)) : '';

async function bytes(file: Blob, start: number, length: number): Promise<Bytes> {
  if (start < 0 || length <= 0 || start >= file.size) return new Uint8Array(0);
  return new Uint8Array(await file.slice(start, start + length).arrayBuffer());
}

const CARVED = new Set(['icns', 'dwg', 'eps', 'epsf', 'epsi', 'blend', 'vcf']);
export const isCarved = (ext: string) => CARVED.has(ext);

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

const ICNS_SKIP = new Set(['TOC ', 'icnV', 'info', 'name', 'sbtp', 'slct']);

// Largest PNG chunk from an .icns (smallest-first order, so "first" would be a smudge).
async function fromIcns(file: Blob): Promise<Bytes | null> {
  const head = await bytes(file, 0, Math.min(HEAD, file.size));
  if (head.length < 16 || tag(head, 0) !== 'icns') return null;

  const total = Math.min(be32(head, 4) || head.length, head.length);
  let best: Bytes | null = null;
  let at = 8;
  for (let guard = 0; at + 8 <= total && guard < 4096; guard++) {
    const type = tag(head, at);
    const size = be32(head, at + 4);
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

// Sentinel before the DWG preview section. Verified to guard against layout changes.
const DWG_SENTINEL = [
  0x1F, 0x25, 0x6D, 0x07, 0xD4, 0x36, 0x28, 0x28,
  0x9D, 0x57, 0xCA, 0x3F, 0x9D, 0x44, 0x10, 0x2B,
];

// Preview record types: 1=headerless BMP, 2=WMF, 3=PNG.
const DWG_BMP = 1;
const DWG_PNG = 3;

// DWG preview: seeker at 0x0D points to sentinel + preview records. Works R13+.
async function fromDwg(file: Blob): Promise<Bytes | null> {
  const head = await bytes(file, 0, 64);
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
    // Code 1: headerless DIB, same as compound-file thumbnails.
    const bmp = dibToBmp(body);
    if (bmp) return bmp;
  }
  return null;
}

// ---------------------------------------------------------------------------
// DOS EPS
// ---------------------------------------------------------------------------

// DOS-format EPS: 30-byte header with offsets. Preview is TIFF, usually
// uncompressed RGB with no embedded JPEG, so this often returns null.
async function fromEps(file: Blob): Promise<Bytes | null> {
  const head = await bytes(file, 0, 30);
  if (head.length < 30) return null;
  // Binary EPS magic (not plain PostScript).
  if (head[0] !== 0xC5 || head[1] !== 0xD0 || head[2] !== 0xD3 || head[3] !== 0xC6) return null;

  const at = le32(head, 20);
  const size = le32(head, 24);
  if (!at || !size || size < MIN_IMAGE || size > MAX_PICTURE || at + size > file.size) return null;

  const found = await embeddedPreview(file.slice(at, at + size));
  return found ? new Uint8Array(await found.arrayBuffer()) : null;
}

// ---------------------------------------------------------------------------
// Blender
// ---------------------------------------------------------------------------

const BLEND_MAX_BLOCKS = 64;

// .blend: walk block headers to find the TEST block (raw RGBA preview).
// Pointer size ('_'=32, '-'=64) and endianness ('v'=LE) from bytes 7-8 shape
// every block header. Compressed .blend files are skipped (header not readable).
async function fromBlend(file: Blob): Promise<Bytes | null> {
  const head = await bytes(file, 0, Math.min(HEAD, file.size));
  if (head.length < 12 || tag(head, 0, 7) !== 'BLENDER') return null;

  const pointer = head[7] === 0x2D ? 8 : head[7] === 0x5F ? 4 : 0;
  if (!pointer) return null;
  // Only LE supported (every machine Blender still runs on is LE).
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
      // Cap to stop a lying dimension pair from allocating a huge canvas.
      if (w < 1 || h < 1 || w > 4096 || h > 4096) return null;
      const need = w * h * 4;
      if (body + 8 + need > head.length) return null;
      return await fromRgba(head.subarray(body + 8, body + 8 + need), w, h);
    }
    at += headerLen + length;
  }
  return null;
}

// Convert raw RGBA to PNG via surface. Rows flipped (Blender writes bottom-up).
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

const VCARD_MAX = 8 * 1024 * 1024;

// vCard PHOTO: v4.0 data: URI or v3.0 ENCODING=b base64. Lines may be folded.
async function fromVcard(file: Blob): Promise<Bytes | null> {
  const head = await bytes(file, 0, Math.min(VCARD_MAX, file.size));
  const text = new TextDecoder().decode(head);
  if (!/^BEGIN:VCARD/im.test(text)) return null;

  // Match PHOTO line with folded continuations in place, then unfold.
  const match = /^PHOTO[;:].*(?:\r?\n[ \t].*)*/im.exec(text);
  if (!match) return null;
  const line = match[0].replace(/\r?\n[ \t]/g, '');

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
    return null;
  }
}
