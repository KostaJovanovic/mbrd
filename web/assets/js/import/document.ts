// Extract the embedded preview picture from documents (OOXML, ODF, Krita,
// Procreate, iWork, Sketch, PSD, PDN). ZIP families use storage/zip.ts; PSD
// walks Image Resources; PDN decodes base64 from its XML header. Every path
// returns null on failure — the card stays named. Original file is untouched.

import { readZip } from '../storage/zip.ts';
import { extOf } from '../util.ts';
import { oversize, isOversize, mb } from '../consent.ts';
// PE icons (pe.ts) and app/book packages (packages.ts) — dispatched from bakedPreview().
import { exeIcon, isExecutable } from './pe.ts';
import { packagePicture, isPackage } from './packages.ts';
import { isDrawablePng } from './winimage.ts';
import { openCompound, compoundPicture, isCompoundExt } from './cfbf.ts';
import { carvedPicture, isCarved } from './carved.ts';

/** Ceiling for opening one document container. Separate from zip.ts's board-archive limit. */
// Exported for import/slide.ts.
export const MAX_CONTAINER = 96 * 1024 * 1024;

/** Cap on inflated size (not compressed). Six run at once under IMPORT_WORKERS. */
export const MAX_INFLATED = 192 * 1024 * 1024;

/** A preview under a kilobyte is not one. Same floor import/preview.ts uses. */
const MIN_IMAGE = 512;

/** Preview paths per family, best-first. Exact and case-sensitive per spec. */
const WELLS: Record<string, string[]> = {
  // OpenDocument — spec requires this path.
  odf: [
    'Thumbnails/thumbnail.png',
  ],
  // OOXML — optional; .emf/.wmf spellings omitted (no browser draws them).
  ooxml: [
    'docProps/thumbnail.jpeg',
    'docProps/thumbnail.jpg',
    'docProps/thumbnail.png',
  ],
  // Krita — full composite first, small preview as fallback.
  krita: [
    'mergedimage.png',
    'preview.png',
  ],
  // Procreate — layers are proprietary; QuickLook thumbnail is all we can use.
  procreate: [
    'QuickLook/Thumbnail.png',
    'QuickLook/Thumbnail.jpg',
  ],
  // iWork — Snappy-compressed protobuf, so QuickLook preview is all there is.
  iwork: [
    'preview.jpg',
    'QuickLook/Thumbnail.jpg',
    'preview-web.jpg',
    'preview-micro.jpg',
  ],
  // Sketch, same idea.
  sketch: [
    'previews/preview.png',
  ],
  // Fusion — expected to miss (entries are Zstandard, zip.ts reads STORE/DEFLATE only).
  fusion: [
    'thumbnail.png',
  ],
};

/** Extension -> which family's paths to look down. */
const FAMILY = new Map<string, string>([
  ...['odt', 'ott', 'ods', 'ots', 'odp', 'otp', 'odg', 'otg', 'odf', 'odc', 'odb']
    .map((e): [string, string] => [e, 'odf']),
  ...['docx', 'docm', 'dotx', 'dotm', 'xlsx', 'xlsm', 'xltx', 'xltm',
      'pptx', 'pptm', 'ppsx', 'ppsm', 'potx', 'potm', 'vsdx']
    .map((e): [string, string] => [e, 'ooxml']),
  ['kra', 'krita'],
  ['krz', 'krita'],
  ['procreate', 'procreate'],
  ...['pages', 'numbers', 'key', 'keynote'].map((e): [string, string] => [e, 'iwork']),
  ['sketch', 'sketch'],
  ['f3d', 'fusion'],
  ['f3z', 'fusion'],
]);

/** Whether this file is one this module knows how to look inside. */
export function hasBakedPreview(file: File) {
  const ext = extOf(file.name);
  return FAMILY.has(ext) || ext === 'psd' || ext === 'psb' || ext === 'pdn'
    || isExecutable(ext) || isPackage(ext) || isCompoundExt(ext, file.name) || isCarved(ext);
}

/** Extract a viewable picture from a document, or null. Returns File for addFile()/measureSize(). */
export async function bakedPreview(file: File, lift = false): Promise<File | null> {
  try {
    const ext = extOf(file.name);
    if (ext === 'psd' || ext === 'psb') return await fromPsd(file);
    if (ext === 'pdn') return await fromPdn(file);
    // pe.ts reads only the section it needs — no full-file read.
    if (isExecutable(ext)) {
      const icon = await exeIcon(file, lift);
      return icon ? named(new Uint8Array(await icon.blob.arrayBuffer())) : null;
    }
    // Archive ceiling owned by readZip.
    if (isPackage(ext)) {
      const bytes = await packagePicture(file, ext, lift);
      return bytes ? named(bytes) : null;
    }
    // Compound files (SolidWorks, legacy Office, 3ds Max, Thumbs.db).
    if (isCompoundExt(ext, file.name)) {
      const doc = await openCompound(file, lift);
      const bytes = doc && compoundPicture(doc);
      return bytes ? named(bytes) : null;
    }
    // Apple icons, AutoCAD, binary EPS, Blender, vCards.
    if (isCarved(ext)) {
      const bytes = await carvedPicture(file, ext);
      return bytes ? named(bytes) : null;
    }
    const family = FAMILY.get(ext);
    if (!family) return null;
    // Thrown (not returned) — a question the caller must ask via consent.ts.
    if (!lift && file.size > MAX_CONTAINER) {
      throw oversize(
        'container-bytes',
        `This document is ${mb(file.size)}, past the ${mb(MAX_CONTAINER)} one is opened at to look for `
        + 'the preview picture inside it.',
      );
    }
    return await fromZip(file, WELLS[family], lift);
  } catch (err) {
    // Rethrow Oversize — it is a question, not a failure.
    if (isOversize(err)) throw err;
    // A throw means readZip refused the archive (bad CDir, checksum, ZIP64, etc.).
    console.warn('[mbrd] document: the container would not read', file.name, err);
    return null;
  }
}

// ---------------------------------------------------------------------------
// ZIP containers
// ---------------------------------------------------------------------------

async function fromZip(file: Blob, paths: string[], lift = false): Promise<File | null> {
  // Own inflate ceiling (not the board archive's) — six of these run at once.
  const entries = await readZip(file, { entry: MAX_INFLATED, total: MAX_INFLATED, lift });
  for (const path of paths) {
    const bytes = entries.get(path);
    if (!bytes || bytes.length < MIN_IMAGE) continue;
    const type = imageType(bytes);
    // Identified by signature, not by the path's extension.
    if (!type) continue;
    return new File([bytes], 'preview.' + type.ext, { type: type.mime });
  }
  return null;
}

/** JPEG or PNG, by signature. The only two anything here is allowed to return. */
function imageType(b: Uint8Array): { ext: string, mime: string } | null {
  if (b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) {
    return { ext: 'jpg', mime: 'image/jpeg' };
  }
  if (b.length >= 8 && b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47
      && b[4] === 0x0d && b[5] === 0x0a && b[6] === 0x1a && b[7] === 0x0a) {
    // CgBI PNG passes the signature but only decodes in Apple's software.
    return isDrawablePng(b) ? { ext: 'png', mime: 'image/png' } : null;
  }
  // ICO, BMP, WebP, GIF — from executables and packages. Browser-drawable.
  if (b.length >= 6 && b[0] === 0 && b[1] === 0 && b[2] === 1 && b[3] === 0) {
    return { ext: 'ico', mime: 'image/x-icon' };
  }
  if (b.length >= 14 && b[0] === 0x42 && b[1] === 0x4d) {
    return { ext: 'bmp', mime: 'image/bmp' };
  }
  if (b.length >= 12 && b[0] === 0x52 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x46
      && b[8] === 0x57 && b[9] === 0x45 && b[10] === 0x42 && b[11] === 0x50) {
    return { ext: 'webp', mime: 'image/webp' };
  }
  if (b.length >= 6 && b[0] === 0x47 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x38) {
    return { ext: 'gif', mime: 'image/gif' };
  }
  return null;
}

/** Wrap bytes as a named File, typed by signature (not by what the reader claimed). */
function named(bytes: Uint8Array<ArrayBuffer>): File | null {
  const type = imageType(bytes);
  return type ? new File([bytes], `preview.${type.ext}`, { type: type.mime }) : null;
}

// ---------------------------------------------------------------------------
// PSD
// ---------------------------------------------------------------------------
//
// PSD: 26-byte header, then Image Resources — a chain of records containing a
// JPEG composite (resource 1036/1033). Only the front of the file is read.

/** How far into a PSD the resource chain is allowed to be looked for. */
const PSD_SCAN = 8 * 1024 * 1024;
/** Records walked before giving up. A real file has a few dozen. */
const PSD_MAX_RECORDS = 4096;

const RES_THUMBNAIL = 1036;      // kJpegRGB, Photoshop 5 and later
const RES_THUMBNAIL_OLD = 1033;  // the same picture, BGR order

async function fromPsd(file: Blob): Promise<File | null> {
  const head = new Uint8Array(await file.slice(0, Math.min(PSD_SCAN, file.size)).arrayBuffer());
  if (head.length < 34) return null;
  // '8BPS'
  if (head[0] !== 0x38 || head[1] !== 0x42 || head[2] !== 0x50 || head[3] !== 0x53) return null;
  const view = new DataView(head.buffer, head.byteOffset, head.byteLength);

  // 26-byte header, then the Colour Mode Data section, then Image Resources.
  let p = 26;
  const modeLen = view.getUint32(p, false);
  p += 4 + modeLen;
  if (p + 4 > head.length) return null;

  const resLen = view.getUint32(p, false);
  p += 4;
  // Bounded to what was actually read, not to the file's claim.
  const end = Math.min(head.length, p + resLen);

  let best: Uint8Array<ArrayBuffer> | null = null;
  for (let n = 0; n < PSD_MAX_RECORDS && p + 12 <= end; n++) {
    // '8BIM'
    if (view.getUint32(p, false) !== 0x3842494d) break;
    const id = view.getUint16(p + 4, false);
    // Pascal string name, padded to even length. Usually empty (2 bytes).
    const nameLen = head[p + 6];
    let q = p + 6 + 1 + nameLen;
    if (q % 2) q++;
    if (q + 4 > end) break;
    const size = view.getUint32(q, false);
    q += 4;
    // Bounds check.
    if (q + size > end) break;

    if ((id === RES_THUMBNAIL || id === RES_THUMBNAIL_OLD) && size > 28) {
      // 28-byte record header, then JPEG. Format 1 = JPEG; 0 = raw RGB (unusable).
      const format = view.getUint32(q, false);
      if (format === 1) {
        const jpeg = head.subarray(q + 28, q + size);
        // Verified by signature.
        if (jpeg.length >= MIN_IMAGE && imageType(jpeg)?.ext === 'jpg') {
          // 1036 (RGB) wins over 1033 (BGR, shows blue-for-red in some writers).
          if (id === RES_THUMBNAIL) return file1(jpeg);
          best = best || jpeg;
        }
      }
    }

    // Records are padded to an even length.
    p = q + size + (size % 2);
  }
  return best ? file1(best) : null;
}

// View onto our own buffer — File constructor requires an owned BlobPart.
const file1 = (bytes: Uint8Array<ArrayBuffer>) =>
  new File([bytes], 'preview.jpg', { type: 'image/jpeg' });

// ---------------------------------------------------------------------------
// PDN  -  Paint.NET
// ---------------------------------------------------------------------------
//
// PDN: 4-byte magic, 24-bit LE length, then XML with a base64 PNG thumbnail
// in `<thumb png="...">`. Layers are .NET objects — not readable here.

/** Cap on XML header read. Thumbnail is tens of KB of base64. */
const PDN_MAX_XML = 4 * 1024 * 1024;

async function fromPdn(file: Blob): Promise<File | null> {
  const head = new Uint8Array(await file.slice(0, 7).arrayBuffer());
  // 'PDN3'
  if (head.length < 7 || head[0] !== 0x50 || head[1] !== 0x44 || head[2] !== 0x4e || head[3] !== 0x33) {
    return null;
  }
  const len = Math.min(head[4] | (head[5] << 8) | (head[6] << 16), PDN_MAX_XML);
  if (len < 32) return null;
  const xml = new TextDecoder().decode(await file.slice(7, 7 + len).arrayBuffer());
  const b64 = xml.match(/<thumb\s+png="([A-Za-z0-9+/=\s]*)"/i)?.[1];
  if (!b64) return null;
  const png = fromBase64(b64);
  // Verified by signature.
  if (!png || png.length < MIN_IMAGE || imageType(png)?.ext !== 'png') return null;
  return new File([png], 'preview.png', { type: 'image/png' });
}

/** Base64 to bytes. Whitespace stripped (XML attributes may wrap). Returns null on bad input. */
function fromBase64(s: string): Uint8Array<ArrayBuffer> | null {
  try {
    const bin = atob(s.replace(/\s+/g, ''));
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  } catch {
    return null;
  }
}
