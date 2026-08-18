// Compound File Binary Format: a filesystem in a file, and the thumbnails in it.
//
// Before OOXML made a .docx a ZIP, Microsoft's answer to "a document is several
// things" was a FAT filesystem written inside one file - sectors, an allocation
// table, a directory of named streams. It is called CFBF, or OLE2, or a Compound
// File, or a Structured Storage, all for the same thing, and it is still what
// holds a .doc, a .xls, a .ppt, a .msi, an Outlook .msg, a 3ds Max scene, a
// SolidWorks part and the Thumbs.db Windows leaves in picture folders.
//
// It is worth reading here for one reason: several of those store a rendered
// thumbnail, and there is no other way to reach it. A .sldprt is otherwise
// completely opaque, and a moodboard full of grey CAD cards is the case this
// whole corner of import/ exists to fix.
//
// ── What is actually being read ──
//
// A 512-byte header, then the file is a run of equal-sized sectors. Three
// structures matter:
//
//   FAT        A chain-per-sector table: entry N holds the number of the sector
//              following sector N, or a terminator. Reading a stream means
//              following that chain. The FAT's own sectors are listed in the
//              DIFAT, the first 109 entries of which live in the header.
//   Directory  A chain of 128-byte entries, each a name in UTF-16, a type, a
//              start sector and a length. This is what turns "PreviewPNG" into
//              an offset.
//   Mini FAT   Streams under 4096 bytes do not get whole sectors; they live
//              packed inside one big stream owned by the root entry, indexed by
//              a second, parallel allocation table. **A thumbnail is very often
//              under 4096 bytes**, so a reader that skips the mini stream is a
//              reader that misses exactly the thing it came for.
//
// ── The property set, which is the other half ──
//
// Where there is no dedicated stream, the thumbnail is a *property* inside
// `\x05SummaryInformation` - the same place the title and author live. That is a
// second container format layered on the first: a header, a section, then
// (id, offset) pairs into typed values. Property 17 is the thumbnail and its type
// is VT_CF, a clipboard format - which means the bytes are whatever Windows had
// on its clipboard, usually a metafile and sometimes a bitmap.
//
// **That last part is why this family misses more than it hits, and it is not a
// bug in this file.** A CF_METAFILEPICT is WMF, no browser draws one, and it is
// declined for the same reason import/document.js declines docProps/thumbnail.emf.
// The CF_DIB case works and comes out through import/winimage.js. So .doc and
// .xls will often still be grey cards, .sldprt usually will not because
// SolidWorks writes a real PNG stream, and that difference is the format's
// rather than the reader's.

import { dibToBmp, isPng } from './winimage.ts';
import { oversize, mb } from '../consent.ts';

/** A view whose buffer is named, so a subarray of it stays a legal BlobPart. */
type Bytes = Uint8Array<ArrayBuffer>;

/** The magic every compound file opens with. */
const MAGIC = [0xD0, 0xCF, 0x11, 0xE0, 0xA1, 0xB1, 0x1A, 0xE1];

/**
 * How much of one of these will be read.
 *
 * The whole file, because the sector chains jump backwards as often as forwards
 * and walking them against a Blob would be a read per sector. That makes this a
 * real memory cost rather than a nominal one, so it is a ceiling that asks -
 * see the contract in consent.ts.
 */
const MAX_FILE = 96 * 1024 * 1024;

/** Caps on the structures themselves. Each is "this file is lying", not a bound. */
const MAX_SECTORS = 1 << 21;
const MAX_DIR_ENTRIES = 8192;
const MAX_CHAIN = 1 << 20;

/** Sector chain terminators. */
const FREE = 0xFFFFFFFF;
const END = 0xFFFFFFFE;

/** Directory entry types. */
const STREAM = 2;
const ROOT = 5;

/** An open compound file: every stream it holds, by name. */
export type Compound = {
  /** A stream's bytes by its exact name, or null. */
  stream(name: string): Bytes | null;
  /** Every stream name in the file, in directory order. */
  names(): string[];
  /** Stream names with the sizes the directory declares, for ranking without reading. */
  sizes(): { name: string, size: number }[];
  /** The first `n` bytes of a stream, reading only the sectors that far reaches. */
  head(name: string, n: number): Bytes | null;
};

const le16 = (b: Bytes, i: number) => b[i] | (b[i + 1] << 8);
const le32 = (b: Bytes, i: number) =>
  ((b[i] | (b[i + 1] << 8) | (b[i + 2] << 16)) + b[i + 3] * 0x1000000) >>> 0;

/** Whether these first bytes are a compound file. */
export const isCompound = (b: Uint8Array) =>
  b.length >= 8 && MAGIC.every((v, i) => b[i] === v);

/**
 * Open `file` as a compound file, or null if it is not one.
 *
 * Throws Oversize past MAX_FILE, which is the ceiling contract: reading one of
 * these means holding all of it, and whether that is worth spending is a question
 * for whoever dropped the file rather than a decision for this module.
 */
export async function openCompound(file: Blob, lift = false): Promise<Compound | null> {
  const head = new Uint8Array(await file.slice(0, 8).arrayBuffer());
  if (!isCompound(head)) return null;
  if (!lift && file.size > MAX_FILE) {
    throw oversize(
      'container-bytes',
      `This file is ${mb(file.size)}, past the ${mb(MAX_FILE)} a compound document is opened at to `
      + 'look for the picture inside it.',
    );
  }
  const b = new Uint8Array(await file.arrayBuffer());
  return parse(b);
}

/** The same, for bytes already in hand. */
export function readCompound(b: Bytes): Compound | null {
  return isCompound(b) ? parse(b) : null;
}

function parse(b: Bytes): Compound | null {
  if (b.length < 512) return null;

  // Sector and mini-sector sizes are stored as powers of two. 512 and 4096 are
  // the only two shifts any real writer emits, and anything else is a file
  // describing a geometry this reader would then compute offsets from.
  const shift = le16(b, 30);
  const miniShift = le16(b, 32);
  if (shift !== 9 && shift !== 12) return null;
  if (miniShift !== 6) return null;
  const sectorSize = 1 << shift;
  const miniSize = 1 << miniShift;
  const cutoff = le32(b, 56);

  const sectors = Math.floor((b.length - 512) / sectorSize);
  if (sectors <= 0 || sectors > MAX_SECTORS) return null;

  /** Where a sector's bytes begin. Sector 0 is the one after the header. */
  const at = (s: number) => 512 + s * sectorSize;
  const valid = (s: number) => s >= 0 && s < sectors;

  // ── The FAT, through the DIFAT ──
  //
  // The header carries the first 109 FAT sector numbers; past that they continue
  // in DIFAT sectors, each of which ends with a pointer to the next. Both are
  // walked, and both are bounded - a DIFAT that points at itself is the obvious
  // way to make this loop forever.
  const fatSectors: number[] = [];
  for (let i = 0; i < 109; i++) {
    const s = le32(b, 76 + i * 4);
    if (valid(s)) fatSectors.push(s);
  }
  let difat = le32(b, 68);
  const difatCount = le32(b, 72);
  for (let n = 0; n < Math.min(difatCount, MAX_CHAIN) && valid(difat); n++) {
    const base = at(difat);
    const perSector = sectorSize / 4 - 1;
    for (let i = 0; i < perSector; i++) {
      const s = le32(b, base + i * 4);
      if (valid(s)) fatSectors.push(s);
    }
    difat = le32(b, base + perSector * 4);
  }
  if (!fatSectors.length) return null;

  const fat = new Uint32Array(fatSectors.length * (sectorSize / 4));
  fatSectors.forEach((s, n) => {
    const base = at(s);
    for (let i = 0; i < sectorSize / 4; i++) fat[n * (sectorSize / 4) + i] = le32(b, base + i * 4);
  });

  /**
   * A chain of sector numbers from `start`.
   *
   * `seen` is what makes this terminate: a FAT whose entry points back into the
   * chain it belongs to is a malformed file, not a loop to follow, and without
   * this the reader hangs on one rather than refusing it.
   */
  function chain(start: number, limit = MAX_CHAIN): number[] {
    const out: number[] = [];
    const seen = new Set<number>();
    let s = start;
    while (valid(s) && s !== END && s !== FREE && out.length < limit) {
      if (seen.has(s)) break;
      seen.add(s);
      out.push(s);
      s = fat[s] ?? END;
    }
    return out;
  }

  /** A stream's bytes, following a chain and cutting to its declared length. */
  function read(start: number, length: number): Bytes | null {
    if (length <= 0 || length > b.length) return null;
    const need = Math.ceil(length / sectorSize);
    const path = chain(start, need);
    if (path.length < need) return null;
    const out = new Uint8Array(length);
    let done = 0;
    for (const s of path) {
      const take = Math.min(sectorSize, length - done);
      out.set(b.subarray(at(s), at(s) + take), done);
      done += take;
    }
    return out;
  }

  // ── The directory ──
  const dirSectors = chain(le32(b, 48));
  const entries: { name: string, type: number, start: number, size: number }[] = [];
  for (const s of dirSectors) {
    for (let i = 0; i < sectorSize / 128; i++) {
      if (entries.length >= MAX_DIR_ENTRIES) break;
      const p = at(s) + i * 128;
      if (p + 128 > b.length) break;
      // The name is UTF-16 and its length includes the terminator, in bytes.
      const nameLen = le16(b, p + 64);
      if (nameLen < 2 || nameLen > 64) continue;
      let name = '';
      for (let c = 0; c < nameLen / 2 - 1; c++) name += String.fromCharCode(le16(b, p + c * 2));
      entries.push({
        name,
        type: b[p + 66],
        start: le32(b, p + 116),
        // 64-bit, but a stream past 4 GB inside a document is not a thing this
        // app opens and the high word is only read to refuse one.
        size: le32(b, p + 120) + le32(b, p + 124) * 0x100000000,
      });
    }
  }
  const root = entries.find(e => e.type === ROOT);
  if (!root) return null;

  // ── The mini stream ──
  //
  // Everything under the cutoff lives packed inside the root entry's own stream,
  // indexed by a second allocation table. Thumbnails are usually small, so this
  // is the path most of them are actually on.
  const miniFatSectors = chain(le32(b, 60), le32(b, 64) || MAX_CHAIN);
  const miniFat = new Uint32Array(miniFatSectors.length * (sectorSize / 4));
  miniFatSectors.forEach((s, n) => {
    const base = at(s);
    for (let i = 0; i < sectorSize / 4; i++) miniFat[n * (sectorSize / 4) + i] = le32(b, base + i * 4);
  });
  const miniStream = root.size > 0 && root.size <= b.length ? read(root.start, root.size) : null;

  function readMini(start: number, length: number): Bytes | null {
    if (!miniStream || length <= 0 || length > miniStream.length) return null;
    const out = new Uint8Array(length);
    let s = start;
    let done = 0;
    const seen = new Set<number>();
    while (done < length && s !== END && s !== FREE && !seen.has(s)) {
      seen.add(s);
      const from = s * miniSize;
      if (from + 1 > miniStream.length) return null;
      const take = Math.min(miniSize, length - done, miniStream.length - from);
      if (take <= 0) return null;
      out.set(miniStream.subarray(from, from + take), done);
      done += take;
      s = miniFat[s] ?? END;
    }
    return done === length ? out : null;
  }

  return {
    names: () => entries.filter(e => e.type === STREAM).map(e => e.name),
    sizes: () => entries.filter(e => e.type === STREAM).map(e => ({ name: e.name, size: e.size })),
    stream(name: string) {
      const e = entries.find(x => x.type === STREAM && x.name === name);
      if (!e || !e.size) return null;
      return e.size < cutoff ? readMini(e.start, e.size) : read(e.start, e.size);
    },
    head(name: string, n: number) {
      const e = entries.find(x => x.type === STREAM && x.name === name);
      if (!e || !e.size) return null;
      const len = Math.min(e.size, n);
      return e.size < cutoff ? readMini(e.start, len) : read(e.start, len);
    },
  };
}

// ---------------------------------------------------------------------------
// The thumbnail, wherever this family keeps it
// ---------------------------------------------------------------------------

/** Property 17 of the summary information: PIDSI_THUMBNAIL. */
const PIDSI_THUMBNAIL = 17;
/** VT_CF - a clipboard format, which is what a thumbnail is stored as. */
const VT_CF = 71;
/** Clipboard format tags, of which exactly two are pictures a browser can take. */
const CF_DIB = 8;
const CF_DIBV5 = 17;

/**
 * The picture inside a compound file, or null.
 *
 * Two places, in the order worth trying. A dedicated stream first because where
 * one exists it is a real PNG at a real size - SolidWorks writes `PreviewPNG` and
 * it is the best picture any of these files hold. The summary property second,
 * which is where everything else keeps a much smaller one.
 */
export function compoundPicture(doc: Compound): Bytes | null {
  const direct = doc.names().find(n => /^Preview.*PNG$/i.test(n));
  if (direct) {
    const bytes = doc.stream(direct);
    if (bytes && isPng(bytes)) return bytes;
  }
  // The stream's name really does begin with a 0x05 byte - that is the format's
  // marker for "this is a property set rather than content", and it is a literal
  // control character in the string below rather than an escape because that is
  // the byte the directory holds.
  return pictureFrom(doc, doc.stream('SummaryInformation'));
}

/**
 * The summary property, and failing that whatever a stream simply opens with.
 *
 * The caller does the SummaryInformation lookup and hands the bytes in, so this
 * is a thin two-way fallback rather than the place that lookup is saved.
 */
function pictureFrom(doc: Compound, summary: Bytes | null): Bytes | null {
  return fromSummary(summary) || fromCache(doc);
}

/**
 * The largest picture sitting whole at the front of a numbered stream.
 *
 * This is what a Thumbs.db is: no summary, no preview stream, just a `Catalog`
 * and one numbered stream per picture in the folder, each holding a JPEG behind
 * a short header whose length has varied by Windows version. Rather than track
 * those versions, the front of each stream is checked for a picture signature -
 * which is bounded, and which also picks up the occasional application that keeps
 * its thumbnail in a stream this module has no name for.
 *
 * Only the *front* of a stream is looked at, and that is what separates this from
 * carving. Scanning a whole compound file for anything that resembles a JPEG
 * would find the pictures inside a document's own content, and a picture from the
 * middle of a document is not a picture of it.
 *
 * Ranked by the size the directory already holds and sniffed largest-first, so
 * only the head of each candidate is read until one opens with a signature - and
 * only that winner is then read in full. This used to materialise *every* stream
 * (each a fresh array plus a chain copy, up to MAX_FILE) to read eight bytes of
 * each, which on a real `.doc`/`.xls` is the whole document walked to find a
 * thumbnail that is usually not even there.
 */
function fromCache(doc: Compound): Bytes | null {
  const candidates = doc.sizes()
    .filter(e => e.name !== 'Catalog' && e.size >= 512)
    .sort((a, b) => b.size - a.size);
  for (const e of candidates) {
    const head = doc.head(e.name, 72);
    if (!head) continue;
    let sigAt = -1;
    for (let at = 0; at < Math.min(64, head.length - 8); at++) {
      const lead = head.subarray(at);
      if ((lead[0] === 0xFF && lead[1] === 0xD8 && lead[2] === 0xFF) || isPng(lead)) { sigAt = at; break; }
    }
    if (sigAt < 0) continue;
    // The largest stream that opens with a picture wins; read it in full now and
    // carve from the signature, the same bytes the old scan kept.
    const full = doc.stream(e.name);
    return full ? full.subarray(sigAt) : null;
  }
  return null;
}

/**
 * The thumbnail property out of a summary-information stream.
 *
 * A property set is a header, a section offset, then a table of (id, offset)
 * pairs into typed values - so finding one property means reading the table
 * rather than scanning. Every offset in the table is relative to the section's
 * own start, which is the step that is easy to get wrong and lands the read in
 * the middle of the author's name.
 */
function fromSummary(s: Bytes | null): Bytes | null {
  if (!s || s.length < 48) return null;
  const sectionAt = le32(s, 44);
  if (sectionAt + 8 > s.length) return null;
  const count = le32(s, sectionAt + 4);
  if (count > 256) return null;

  for (let i = 0; i < count; i++) {
    const p = sectionAt + 8 + i * 8;
    if (p + 8 > s.length) return null;
    if (le32(s, p) !== PIDSI_THUMBNAIL) continue;

    const at = sectionAt + le32(s, p + 4);
    if (at + 12 > s.length) return null;
    if (le32(s, at) !== VT_CF) return null;

    // VT_CF: a byte count, then a clipboard format tag, then the data. The count
    // covers the tag as well, which is the four bytes it is easy to lose.
    const size = le32(s, at + 4);
    const format = le32(s, at + 8);
    const from = at + 12;
    const length = Math.min(size - 4, s.length - from);
    if (length < 16) return null;
    const data = s.subarray(from, from + length);

    if (isPng(data)) return data;
    // CF_METAFILEPICT and CF_ENHMETAFILE land here and are declined: a WMF is a
    // picture no browser draws, and the rule this codebase already applies to a
    // .emf named thumbnail.png is that no picture beats a broken one.
    if (format !== CF_DIB && format !== CF_DIBV5) return null;
    return dibToBmp(data);
  }
  return null;
}

/** Extensions whose picture, where they have one, is inside a compound file. */
const COMPOUND_EXTS = new Set([
  // SolidWorks - the one family here that reliably carries a real PNG.
  'sldprt', 'sldasm', 'slddrw',
  // Office before OOXML, and Visio and Publisher with them. Usually a metafile,
  // so usually a miss - see this file's header.
  'doc', 'xls', 'ppt', 'pps', 'pub', 'vsd',
  // 3ds Max scenes, which store a rendered thumbnail the same way.
  'max',
]);

/** Whether this file is one to look inside as a compound file. */
export const isCompoundExt = (ext: string, name = '') =>
  COMPOUND_EXTS.has(ext) || /^thumbs\.db$/i.test(name) || /^ehthumbs\.db$/i.test(name);
