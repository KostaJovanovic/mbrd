// Extract an embedded JPEG preview from files the browser cannot decode (HEIC,
// camera RAW, JPEG XL). Most carry a full-size JPEG the camera wrote for its
// LCD. TIFF/RAW: IFD walk for JPEGInterchangeFormat or JPEG strip. X3F: own
// directory. Fallback: bounded SOI/EOI marker scan. All offsets validated;
// malformed files return null (grey card, same as before).

import { oversize, isOversize, mb } from '../consent.ts';

// Ceilings — "file is lying" backstops, not correctness bounds.
const MAX_IFDS = 48;          // TIFF IFDs visited before we give up walking
const MAX_ENTRIES = 4096;     // directory entries read from one IFD
const MIN_JPEG = 1024;        // a "preview" under a kilobyte is not one
const MAX_JPEG = 128 * 1024 * 1024;
const SCAN_CAP = 12 * 1024 * 1024;   // window the marker-scan fallback reads

/** MAX_JPEG is liftable (caller asks the user). The other three are absolute
 * search bounds, not refusals — exceeding them just means the heuristic gave up. */
const jpegTooBig = (len: number) =>
  `The preview picture stored inside this file claims to be ${mb(len)}, past the ${mb(MAX_JPEG)} `
  + 'one is taken at. That size is the container\'s own claim rather than anything measured here.';

/** Formats one browser decodes but others do not. Safari draws HEIC natively,
 * so on iOS the preview was never extracted and boards arrived on desktop as grey
 * cards. Safari 27 stops converting HEIC→JPEG on input, making this the common
 * case. Closed set — only formats with real cross-browser divergence. */
export const NOT_PORTABLE = new Set(['heic', 'heif', 'hif', 'jxl']);

/** Min edge for a portability preview (original decodable here, not elsewhere).
 * 1280 = display ceiling in canvas/display.ts — below this, adopting the preview
 * would visibly degrade the card on the device that took the photo. */
export const PORTABLE_MIN_EDGE = 1280;

/** One candidate JPEG: where the container says it is, and how long it claims. */
type Candidate = { off: number, len: number };

/** One TIFF directory entry, as much of it as the walk below reads. */
type TiffEntry = { type: number, count: number, valueOff: number };

/** Embedded JPEG from an undecodable file. TIFF IFD walk first, then SOI/EOI
 * marker scan fallback. Every candidate verified by its own magic bytes. */
export async function embeddedPreview(file: Blob, lift = false): Promise<File | null> {
  try {
    const head = await bytes(file, 0, 16);
    if (head.length < 12) return null;
    // X3F only via its own directory — marker scan returns noise (Foveon sensor
    // blocks are full of stray FF D8 / FF D9 pairs).
    if (isX3f(head)) {
      const only = await fromX3f(file, lift);
      return only ? new File([only], 'preview.jpg', { type: 'image/jpeg' }) : null;
    }
    const jpeg = isTiff(head) ? await fromTiff(file, lift) : null;
    const found = jpeg || await scanForJpeg(file);
    if (!found) return null;
    return new File([found], 'preview.jpg', { type: 'image/jpeg' });
  } catch (err) {
    // Oversize = preview found but too large — caller decides via lift.
    if (isOversize(err)) throw err;
    return null;   // a preview that throws is a preview we did not find
  }
}

// ---------------------------------------------------------------------------
// Reading
// ---------------------------------------------------------------------------

async function bytes(file: Blob, start: number, length: number): Promise<Uint8Array> {
  if (start < 0 || length <= 0 || start >= file.size) return new Uint8Array(0);
  const end = Math.min(start + length, file.size);
  return new Uint8Array(await file.slice(start, end).arrayBuffer());
}

/** JPEG by its own first bytes, the one format this module ever returns. */
const isJpeg = (b: Uint8Array) => b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff;

// ---------------------------------------------------------------------------
// TIFF / RAW
// ---------------------------------------------------------------------------
//
// IFD chain walk. Preview found via JPEGInterchangeFormat/Length pair or a
// JPEG-compressed strip. SubIFDs and next-IFD links both followed.

const II = 0x4949, MM = 0x4d4d;

function isTiff(h: Uint8Array) {
  const order = (h[0] << 8) | h[1];
  const magic = order === MM ? (h[2] << 8) | h[3] : (h[3] << 8) | h[2];
  return (order === II || order === MM) && magic === 42;
}

// TIFF field types, in bytes. Only the two that carry offsets and counts here
// matter; anything else is read for its size and otherwise ignored.
const TYPE_BYTES: Record<number, number> = { 1: 1, 2: 1, 3: 2, 4: 4, 5: 8, 6: 1, 7: 1, 8: 2, 9: 4, 10: 8, 11: 4, 12: 8 };

async function fromTiff(file: Blob, lift = false): Promise<Blob | null> {
  const head = await bytes(file, 0, 8);
  const le = ((head[0] << 8) | head[1]) === II;
  const dv0 = new DataView(head.buffer, head.byteOffset, head.byteLength);
  const first = dv0.getUint32(4, le);

  // Largest verified JPEG wins (camera writes both thumbnail and full preview).
  const found: Candidate[] = [];
  const seen = new Set<number>();
  const queue: number[] = [first];
  let walked = 0;

  while (queue.length && walked < MAX_IFDS) {
    const at = queue.shift();
    if (!at || at < 8 || at >= file.size || seen.has(at)) continue;
    seen.add(at);
    walked++;

    const countBuf = await bytes(file, at, 2);
    if (countBuf.length < 2) continue;
    const cdv = new DataView(countBuf.buffer, countBuf.byteOffset, 2);
    const entries = cdv.getUint16(0, le);
    if (entries <= 0 || entries > MAX_ENTRIES) continue;

    // Entry block + 4-byte next-IFD pointer in one read.
    const block = await bytes(file, at + 2, entries * 12 + 4);
    if (block.length < entries * 12) continue;
    const dv = new DataView(block.buffer, block.byteOffset, block.byteLength);

    const tags = new Map<number, TiffEntry>();   // tag -> { type, count, valueOff }
    for (let i = 0; i < entries; i++) {
      const off = i * 12;
      const tag = dv.getUint16(off, le);
      const type = dv.getUint16(off + 2, le);
      const count = dv.getUint32(off + 4, le);
      tags.set(tag, { type, count, valueOff: off + 8 });
    }

    // Inline value when ≤ 4 bytes, else file offset. Only single-count entries.
    const scalar = (e: TiffEntry | undefined): number | null => {
      if (!e) return null;
      const size = TYPE_BYTES[e.type] || 0;
      if (!size || e.count !== 1 || size > 4) return null;
      return size === 2 ? dv.getUint16(e.valueOff, le)
        : size === 4 ? dv.getUint32(e.valueOff, le)
        : block[e.valueOff];
    };

    // Next-IFD + SubIFDs. Guard: block may be exactly entries*12 if the file is
    // truncated — reading past the DataView would RangeError and discard all
    // candidates already found.
    const next = block.length >= entries * 12 + 4 ? dv.getUint32(entries * 12, le) : 0;
    if (next) queue.push(next);
    const sub = tags.get(0x014a);
    if (sub && sub.count === 1) { const o = scalar(sub); if (o) queue.push(o); }

    // Candidate A - a JPEGInterchangeFormat / -Length pair pointing at a JPEG.
    const jOff = scalar(tags.get(0x0201));
    const jLen = scalar(tags.get(0x0202));
    if (jOff && jLen) found.push({ off: jOff, len: jLen });

    // Candidate B - a single JPEG-compressed strip (Compression 6 or 7).
    const comp = scalar(tags.get(0x0103));
    const strip = tags.get(0x0111), bytesTag = tags.get(0x0117);
    if ((comp === 6 || comp === 7) && strip?.count === 1 && bytesTag?.count === 1) {
      const sOff = scalar(strip), sLen = scalar(bytesTag);
      if (sOff && sLen) found.push({ off: sOff, len: sLen });
    }
  }

  // Largest first; verify JPEG magic at each offset.
  found.sort((a, b) => b.len - a.len);
  // Track largest blocked candidate — only thrown if no smaller one succeeds.
  let blocked = 0;
  for (const { off, len } of found) {
    if (len < MIN_JPEG || off + len > file.size) continue;
    if (!lift && len > MAX_JPEG) { blocked = Math.max(blocked, len); continue; }
    const lead = await bytes(file, off, 3);
    if (!isJpeg(lead)) continue;
    return file.slice(off, off + len, 'image/jpeg');
  }
  if (blocked) throw oversize('embedded-jpeg', jpegTooBig(blocked));
  return null;
}

// ---------------------------------------------------------------------------
// X3F  -  Sigma/Polaroid, the one RAW that is not a TIFF
// ---------------------------------------------------------------------------
//
// FOVb header, data, directory at EOF (last 4 bytes point to it). Image sections
// with format 18 = JPEG. Marker scan is wrong here (Foveon sensor data is full
// of stray SOI/EOI pairs), so X3F is handled exclusively by its own directory.

const isX3f = (h: Uint8Array) => h[0] === 0x46 && h[1] === 0x4f && h[2] === 0x56 && h[3] === 0x62;

/** X3F counts sections in a 32-bit field; this is the cap on believing it. */
const MAX_SECTIONS = 512;

/** The section format that means "an ordinary JPEG is in here". */
const X3F_JPEG = 18;

async function fromX3f(file: Blob, lift = false): Promise<Blob | null> {
  if (file.size < 16) return null;
  const foot = await bytes(file, file.size - 4, 4);
  const dirOff = le32(foot, 0);
  // Validate directory offset before reading.
  if (dirOff + 12 > file.size) return null;
  const dirHead = await bytes(file, dirOff, 12);
  if (dirHead.length < 12 || ascii(dirHead, 0, 4) !== 'SECd') return null;
  const count = Math.min(le32(dirHead, 8), MAX_SECTIONS);
  if (count < 1) return null;
  const table = await bytes(file, dirOff + 12, count * 12);

  // JPEG sections, largest pixel count first.
  const found: { off: number, len: number, px: number }[] = [];
  for (let i = 0; i + 12 <= table.length; i += 12) {
    const off = le32(table, i);
    const len = le32(table, i + 4);
    const type = ascii(table, i + 8, 4);
    if (type !== 'IMA2' && type !== 'IMAG') continue;
    if (len < 28 || off + 28 > file.size || off + len > file.size) continue;
    const sec = await bytes(file, off, 28);
    if (ascii(sec, 0, 4) !== 'SECi' || le32(sec, 12) !== X3F_JPEG) continue;
    const px = le32(sec, 16) * le32(sec, 20);
    // JPEG starts after the 28-byte section header.
    found.push({ off: off + 28, len: len - 28, px });
  }
  found.sort((a, b) => b.px - a.px);
  let blocked = 0;
  for (const { off, len } of found) {
    if (len < MIN_JPEG) continue;
    if (!lift && len > MAX_JPEG) { blocked = Math.max(blocked, len); continue; }
    const lead = await bytes(file, off, 3);
    if (!isJpeg(lead)) continue;
    return file.slice(off, off + len, 'image/jpeg');
  }
  if (blocked) throw oversize('embedded-jpeg', jpegTooBig(blocked));
  return null;
}

/** X3F is little-endian throughout, unlike the TIFF walk above which reads
 *  whichever order the file declares. */
const le32 = (b: Uint8Array, i: number) =>
  (b[i] | (b[i + 1] << 8) | (b[i + 2] << 16)) + b[i + 3] * 0x1000000;

const ascii = (b: Uint8Array, i: number, n: number) =>
  i + n <= b.length ? String.fromCharCode(...b.subarray(i, i + n)) : '';

// ---------------------------------------------------------------------------
// Marker scan  -  the fallback
// ---------------------------------------------------------------------------
//
// For unparsed containers (HEIC especially): find SOI (FF D8) / EOI (FF D9)
// bookends in a bounded window near the front of the file.

async function scanForJpeg(file: Blob): Promise<Blob | null> {
  const buf = await bytes(file, 0, Math.min(file.size, SCAN_CAP));
  if (buf.length < MIN_JPEG) return null;
  let best: Candidate | null = null;

  // Monotonic cursor for EOI — keeps the whole scan O(n). The previous nested
  // loop was O(n²) and froze the tab on pathological input (repeating FF D8 FF
  // with no FF D9).
  let cursor = 0;
  let found = -1;
  const endFrom = (from: number): number => {
    if (found >= from) return found;
    if (cursor >= buf.length) return -1;
    for (let j = Math.max(cursor, from); j + 1 < buf.length; j++) {
      if (buf[j] === 0xff && buf[j + 1] === 0xd9) { cursor = j; found = j; return j; }
    }
    cursor = buf.length;
    found = -1;
    return -1;
  };

  for (let i = 0; i + 2 < buf.length; i++) {
    if (buf[i] !== 0xff || buf[i + 1] !== 0xd8 || buf[i + 2] !== 0xff) continue;
    // FF D9 can appear in compressed data — a wrong match just makes the slice
    // longer, and the browser stops at the first real EOI anyway.
    const j = endFrom(i + 3);
    if (j < 0) break;                       // no end anywhere ahead: nothing left to find
    const len = j + 2 - i;
    if (len >= MIN_JPEG && (!best || len > best.len)) best = { off: i, len };
    // No need to re-enter the same JPEG on every byte of it.
    if (best && best.off === i) i += best.len - 1;
  }
  if (!best) return null;
  return file.slice(best.off, best.off + best.len, 'image/jpeg');
}
