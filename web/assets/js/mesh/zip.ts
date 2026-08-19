// DEFLATE and the ZIP directory, by hand and synchronously.
//
// **Why this is not storage/zip.ts.** That module is the app's real archive
// reader and it is *async*, because it decompresses through the platform's
// DecompressionStream - which is the right call there: a .mbrd is the whole
// board, the entries are large, and the caller is already awaiting a file.
//
// parseMesh() is synchronous end to end, and that is not an accident of how it
// was written. The whole ceiling mechanism in shared.ts depends on it: CAPS is
// module state, and the argument that no two parses can interleave is exactly
// the argument that there is no `await` beneath parseMesh(). The retry contract
// in consent.ts leans on it too - canvas/model.ts parses, catches an Oversize,
// asks, and parses again, and both parses are ordinary calls inside one async
// function that owns the question.
//
// A 3MF is a ZIP and most of an FBX is zlib streams, so supporting either meant
// choosing: make the whole family async and rewrite the ceiling argument and the
// retry contract around it, or write two hundred lines of RFC 1951. This is the
// two hundred lines. It is the same bargain the rest of this project makes
// everywhere - import/artwork.ts walks its own ID3 frames, mesh.ts reads its own
// glTF - and the same one that keeps `npm test` needing no install.
//
// It is a decoder only. Nothing here compresses; writing a ZIP is storage/'s job
// and it has the platform's CompressionStream for it.
//
// The bounds rule from CLAUDE.md applies with force: these bytes come out of a
// file the app did not write. Every read is checked against the buffer's length,
// every allocation is checked against a stated size, and a stated size is
// checked against CAPS.buf *before* anything is allocated. A truncated stream is
// a plain Error - a file that does not say what it means - and never an Oversize.

import { oversize, mb } from '../consent.ts';
import { CAPS, MeshError } from './shared.ts';

// ---------------------------------------------------------------------------
// Huffman
// ---------------------------------------------------------------------------

/** A canonical Huffman table: how many codes of each length, and the symbols in
 *  canonical order. Decoding walks the lengths rather than building a lookup
 *  table - slower per symbol and a tenth of the code, which is the right trade
 *  for a few megabytes of model read once. */
type Tree = { counts: Uint16Array; symbols: Uint16Array };

function buildTree(lengths: Uint8Array, off: number, num: number): Tree {
  const counts = new Uint16Array(16);
  const symbols = new Uint16Array(num);
  for (let i = 0; i < num; i++) counts[lengths[off + i]]++;
  // Length 0 means "this symbol is not in the alphabet", not "a zero-bit code".
  counts[0] = 0;
  const offs = new Uint16Array(16);
  let sum = 0;
  for (let i = 1; i < 16; i++) { offs[i] = sum; sum += counts[i]; }
  for (let i = 0; i < num; i++) {
    const len = lengths[off + i];
    if (len) symbols[offs[len]++] = i;
  }
  return { counts, symbols };
}

/** The fixed literal/length and distance trees, built once. RFC 1951 3.2.6. */
const FIXED_LIT = (() => {
  const l = new Uint8Array(288);
  for (let i = 0; i < 144; i++) l[i] = 8;
  for (let i = 144; i < 256; i++) l[i] = 9;
  for (let i = 256; i < 280; i++) l[i] = 7;
  for (let i = 280; i < 288; i++) l[i] = 8;
  return buildTree(l, 0, 288);
})();

const FIXED_DIST = (() => {
  const l = new Uint8Array(30).fill(5);
  return buildTree(l, 0, 30);
})();

const LENGTH_BASE = [
  3, 4, 5, 6, 7, 8, 9, 10, 11, 13, 15, 17, 19, 23, 27, 31,
  35, 43, 51, 59, 67, 83, 99, 115, 131, 163, 195, 227, 258,
];
const LENGTH_EXTRA = [
  0, 0, 0, 0, 0, 0, 0, 0, 1, 1, 1, 1, 2, 2, 2, 2,
  3, 3, 3, 3, 4, 4, 4, 4, 5, 5, 5, 5, 0,
];
const DIST_BASE = [
  1, 2, 3, 4, 5, 7, 9, 13, 17, 25, 33, 49, 65, 97, 129, 193,
  257, 385, 513, 769, 1025, 1537, 2049, 3073, 4097, 6145, 8193, 12289, 16385, 24577,
];
const DIST_EXTRA = [
  0, 0, 0, 0, 1, 1, 2, 2, 3, 3, 4, 4, 5, 5, 6, 6,
  7, 7, 8, 8, 9, 9, 10, 10, 11, 11, 12, 12, 13, 13,
];

/** The order the code-length alphabet's own lengths arrive in. RFC 1951 3.2.7. */
const CLEN_ORDER = [16, 17, 18, 0, 8, 7, 9, 6, 10, 5, 11, 4, 12, 3, 13, 2, 14, 1, 15];

// ---------------------------------------------------------------------------
// The stream
// ---------------------------------------------------------------------------

class Bits {
  src: Uint8Array;
  pos = 0;
  buf = 0;
  cnt = 0;
  constructor(src: Uint8Array) { this.src = src; }

  bit() {
    if (!this.cnt) {
      if (this.pos >= this.src.length) throw new MeshError('This compressed data ends mid-stream');
      this.buf = this.src[this.pos++];
      this.cnt = 8;
    }
    const b = this.buf & 1;
    this.buf >>= 1;
    this.cnt--;
    return b;
  }

  /** `n` bits, least-significant first, plus a base. n is at most 13 here. */
  bits(n: number, base = 0) {
    let v = 0;
    for (let i = 0; i < n; i++) v |= this.bit() << i;
    return v + base;
  }

  symbol(tree: Tree) {
    let sum = 0, cur = 0, len = 0;
    do {
      cur = 2 * cur + this.bit();
      // 15 is the deepest a DEFLATE code may be. Past it the table cannot
      // answer and the loop would run to the end of the buffer.
      if (++len > 15) throw new MeshError('This compressed data has a malformed code in it');
      sum += tree.counts[len];
      cur -= tree.counts[len];
    } while (cur >= 0);
    return tree.symbols[sum + cur];
  }
}

/** How far a model's compressed payload may expand.
 *
 *  The point of a decompression bomb is that the number on the outside says
 *  nothing about the number on the inside, so this is the only number in the
 *  file's path that the file did not write. It is a ceiling and not a refusal -
 *  a genuinely enormous 3MF is offered like any other oversized model. */
export const MAX_INFLATE = 512 * 1024 ** 2;

/** The most that is allocated before a single byte has been decoded. `hint` is
 *  the container's claim about the result, and a claim costs the file four
 *  bytes - so it sizes the first buffer only up to here, and past that the
 *  doubling below earns it. */
const FIRST_ALLOC = 4 * 1024 ** 2;

/** A growable output the copies can read back out of. Doubling rather than
 *  exact, because a length/distance pair may reach 258 bytes back into what has
 *  already been written and the buffer must not move under it mid-copy - it may,
 *  but only between symbols, which is what this shape guarantees. */
class Out {
  buf: Uint8Array;
  len = 0;
  cap: number;
  constructor(hint: number, cap: number) {
    this.cap = cap;
    const want = Number.isFinite(hint) && hint > 0 ? Math.min(hint, FIRST_ALLOC) : 1024;
    this.buf = new Uint8Array(Math.max(want, 1024));
  }
  need(extra: number) {
    if (this.len + extra <= this.buf.length) return;
    if (this.len + extra > this.cap) {
      throw oversize('inflated-bytes', tooMuch(this.len + extra));
    }
    let size = this.buf.length || 1024;
    while (size < this.len + extra) size *= 2;
    if (size > this.cap) size = this.cap;
    const next = new Uint8Array(size);
    next.set(this.buf.subarray(0, this.len));
    this.buf = next;
  }
  byte(v: number) { this.need(1); this.buf[this.len++] = v; }
  done() { return this.buf.subarray(0, this.len); }
}

const tooMuch = (n: number) =>
  `This file expands to at least ${mb(n)} once decompressed, past the ${mb(MAX_INFLATE)} a model is `
  + 'normally opened with.';

/** The ceiling in force for one inflate: whichever of the two is tighter, or no
 *  ceiling at all once somebody has lifted it. */
const inflateCap = () => (CAPS.buf === Infinity ? Infinity : Math.min(CAPS.buf, MAX_INFLATE));

/**
 * Raw DEFLATE (RFC 1951), start to finish.
 *
 * `hint` is what the container claimed the result would be, used only to size
 * the first allocation - it is never trusted as a limit, because a lie there is
 * free. The limit is CAPS.buf, checked as the output grows rather than up front,
 * which is the only check a stream with no honest declared size can get.
 */
export function inflateRaw(src: Uint8Array, hint = 0): Uint8Array {
  const d = new Bits(src);
  const out = new Out(hint, inflateCap());
  const lengths = new Uint8Array(288 + 32);

  for (;;) {
    const last = d.bit();
    const type = d.bits(2);

    if (type === 0) {
      // Stored: back to a byte boundary, then LEN and its complement.
      d.buf = 0; d.cnt = 0;
      if (d.pos + 4 > src.length) throw new MeshError('This compressed data ends mid-stream');
      const len = src[d.pos] | (src[d.pos + 1] << 8);
      const nlen = src[d.pos + 2] | (src[d.pos + 3] << 8);
      d.pos += 4;
      if ((len ^ 0xffff) !== nlen) throw new MeshError('This compressed data has a corrupt block in it');
      if (d.pos + len > src.length) throw new MeshError('This compressed data ends mid-stream');
      out.need(len);
      out.buf.set(src.subarray(d.pos, d.pos + len), out.len);
      out.len += len;
      d.pos += len;
    } else if (type === 1 || type === 2) {
      let lit = FIXED_LIT, dist = FIXED_DIST;
      if (type === 2) {
        const hlit = d.bits(5, 257);
        const hdist = d.bits(5, 1);
        const hclen = d.bits(4, 4);
        if (hlit > 288 || hdist > 32) throw new MeshError('This compressed data has a malformed header');
        const clen = new Uint8Array(19);
        for (let i = 0; i < hclen; i++) clen[CLEN_ORDER[i]] = d.bits(3);
        const clenTree = buildTree(clen, 0, 19);
        lengths.fill(0);
        for (let n = 0; n < hlit + hdist;) {
          const sym = d.symbol(clenTree);
          if (sym === 16) {
            // Copy the previous length 3-6 times. There has to *be* a previous.
            if (!n) throw new MeshError('This compressed data has a malformed header');
            const prev = lengths[n - 1];
            for (let r = d.bits(2, 3); r > 0; r--) lengths[n++] = prev;
          } else if (sym === 17) {
            for (let r = d.bits(3, 3); r > 0; r--) lengths[n++] = 0;
          } else if (sym === 18) {
            for (let r = d.bits(7, 11); r > 0; r--) lengths[n++] = 0;
          } else if (sym < 16) {
            lengths[n++] = sym;
          } else {
            throw new MeshError('This compressed data has a malformed header');
          }
          if (n > hlit + hdist) throw new MeshError('This compressed data has a malformed header');
        }
        lit = buildTree(lengths, 0, hlit);
        dist = buildTree(lengths, hlit, hdist);
      }

      for (;;) {
        const sym = d.symbol(lit);
        if (sym === 256) break;
        if (sym < 256) { out.byte(sym); continue; }
        const li = sym - 257;
        if (li >= LENGTH_BASE.length) throw new MeshError('This compressed data has a malformed code in it');
        const len = d.bits(LENGTH_EXTRA[li], LENGTH_BASE[li]);
        const di = d.symbol(dist);
        if (di >= DIST_BASE.length) throw new MeshError('This compressed data has a malformed code in it');
        const back = d.bits(DIST_EXTRA[di], DIST_BASE[di]);
        if (back > out.len) throw new MeshError('This compressed data refers to bytes before its start');
        out.need(len);
        // Byte at a time on purpose: the source may overlap the destination -
        // that is how DEFLATE encodes a run - so a bulk copy would be wrong.
        let from = out.len - back;
        for (let i = 0; i < len; i++) out.buf[out.len++] = out.buf[from++];
      }
    } else {
      throw new MeshError('This compressed data has a reserved block type in it');
    }

    if (last) break;
  }
  return out.done();
}

/**
 * zlib (RFC 1950) - two header bytes and an Adler-32 tail around a raw stream.
 *
 * The checksum is not verified. It would catch a corrupt file one step earlier
 * than the parser above it does, at the cost of a second pass over every byte,
 * and everything downstream of here already refuses geometry that does not
 * parse. What *is* checked is the header, because a file that is not zlib at all
 * should say so rather than being fed to the bit reader as noise.
 */
export function inflateZlib(src: Uint8Array, hint = 0): Uint8Array {
  if (src.length < 2) throw new MeshError('This compressed data ends mid-stream');
  const cmf = src[0], flg = src[1];
  // Low nibble 8 is DEFLATE; the 16-bit header must be a multiple of 31; FDICT
  // (bit 5 of FLG) means a preset dictionary this has no way to supply.
  if ((cmf & 0x0f) !== 8 || ((cmf << 8) | flg) % 31 !== 0 || (flg & 0x20)) {
    throw new MeshError('This is not a zlib stream');
  }
  return inflateRaw(src.subarray(2), hint);
}

// ---------------------------------------------------------------------------
// The ZIP directory
// ---------------------------------------------------------------------------

const EOCD = 0x06054b50;
const CEN = 0x02014b50;
const LOC = 0x04034b50;
const EOCD64 = 0x06064b50;
const EOCD64_LOC = 0x07064b50;

/** One entry, with its bytes still compressed. `read()` inflates on demand and
 *  is not cached - a 3MF's caller wants two entries out of forty and inflating
 *  the rest to find them is what makes reading a package expensive. */
export type ZipFile = { name: string; size: number; read: () => Uint8Array };

/** The most entries a model container may declare. A 3MF is a handful of parts
 *  and a thumbnail; anything with a five-figure directory is not one. */
const MAX_ENTRIES = 20_000;

/**
 * Every entry in a ZIP, by name, read through the central directory.
 *
 * Through the directory rather than by walking local headers, for the reason
 * storage/zip.ts gives too: a local header may declare zero sizes and defer them
 * to a data descriptor *after* the data, which cannot be read forwards. The
 * directory at the end always has the real numbers.
 */
export function readZip(bytes: Uint8Array): Map<string, ZipFile> {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const eocd = findEOCD(bytes, view);
  let count = view.getUint16(eocd + 10, true);
  let cdOff = view.getUint32(eocd + 16, true);

  // ZIP64, when the 32-bit fields are saturated. Rare for a model and cheap to
  // honour; the alternative is reading a directory at offset 0xffffffff.
  if (count === 0xffff || cdOff === 0xffffffff) {
    const loc = eocd - 20;
    if (loc < 0 || view.getUint32(loc, true) !== EOCD64_LOC) {
      throw new MeshError('This archive says it is ZIP64 and has no ZIP64 directory');
    }
    const rec = Number(view.getBigUint64(loc + 8, true));
    if (rec < 0 || rec + 56 > bytes.length || view.getUint32(rec, true) !== EOCD64) {
      throw new MeshError('This archive has a corrupt ZIP64 directory');
    }
    count = Number(view.getBigUint64(rec + 32, true));
    cdOff = Number(view.getBigUint64(rec + 48, true));
  }

  if (count > MAX_ENTRIES) throw new MeshError('This archive declares more entries than a model has');

  const out = new Map<string, ZipFile>();
  let at = cdOff;
  for (let i = 0; i < count; i++) {
    if (at + 46 > bytes.length || view.getUint32(at, true) !== CEN) {
      throw new MeshError('This archive has a corrupt directory');
    }
    const method = view.getUint16(at + 10, true);
    let comp = view.getUint32(at + 20, true);
    let size = view.getUint32(at + 24, true);
    const nameLen = view.getUint16(at + 28, true);
    const extraLen = view.getUint16(at + 30, true);
    const commentLen = view.getUint16(at + 32, true);
    let local = view.getUint32(at + 42, true);
    if (at + 46 + nameLen + extraLen + commentLen > bytes.length) {
      throw new MeshError('This archive has a corrupt directory');
    }
    const name = utf8(bytes.subarray(at + 46, at + 46 + nameLen));

    // The ZIP64 extra field carries whichever of the three were saturated, in
    // that fixed order and only for the ones that were.
    if (size === 0xffffffff || comp === 0xffffffff || local === 0xffffffff) {
      const ex = at + 46 + nameLen;
      let p = ex;
      while (p + 4 <= ex + extraLen) {
        const id = view.getUint16(p, true), len = view.getUint16(p + 2, true);
        if (id === 0x0001) {
          let q = p + 4;
          if (size === 0xffffffff && q + 8 <= p + 4 + len) { size = Number(view.getBigUint64(q, true)); q += 8; }
          if (comp === 0xffffffff && q + 8 <= p + 4 + len) { comp = Number(view.getBigUint64(q, true)); q += 8; }
          if (local === 0xffffffff && q + 8 <= p + 4 + len) { local = Number(view.getBigUint64(q, true)); }
          break;
        }
        p += 4 + len;
      }
    }
    at += 46 + nameLen + extraLen + commentLen;

    // Captured by value, so the closure holds three numbers rather than the
    // directory cursor. A duplicate name is a plain Error and not "last wins":
    // two entries under one name is the oldest trick in the archive book and
    // CLAUDE.md names it among the things that are corruption rather than size.
    if (out.has(name)) throw new MeshError('This archive has two entries under one name');
    out.set(name, {
      name,
      size,
      read: () => entryBytes(bytes, view, local, method, comp, size),
    });
  }
  return out;
}

function entryBytes(
  bytes: Uint8Array, view: DataView,
  local: number, method: number, comp: number, size: number,
): Uint8Array {
  if (local + 30 > bytes.length || view.getUint32(local, true) !== LOC) {
    throw new MeshError('This archive entry is not where its directory says');
  }
  const nameLen = view.getUint16(local + 26, true);
  const extraLen = view.getUint16(local + 28, true);
  const start = local + 30 + nameLen + extraLen;
  if (start + comp > bytes.length) throw new MeshError('This archive entry runs past the end of the file');
  if (size > inflateCap()) throw oversize('inflated-bytes', tooMuch(size));
  const raw = bytes.subarray(start, start + comp);
  if (method === 0) return raw;
  if (method !== 8) throw new MeshError('This archive entry uses a compression this cannot read');
  return inflateRaw(raw, size);
}

/** The end-of-central-directory record, found by scanning back for its
 *  signature. It is the last 22 bytes unless there is an archive comment, which
 *  may be up to 64KB - so the scan is bounded by that and not by the file. */
function findEOCD(bytes: Uint8Array, view: DataView) {
  const min = Math.max(0, bytes.length - 22 - 0xffff);
  for (let i = bytes.length - 22; i >= min; i--) {
    if (view.getUint32(i, true) === EOCD) return i;
  }
  throw new MeshError('This is not a ZIP archive');
}

const utf8 = (b: Uint8Array) => new TextDecoder().decode(b);
