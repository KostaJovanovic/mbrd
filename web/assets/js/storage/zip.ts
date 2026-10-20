// Minimal ZIP reader/writer — .mbrd is a ZIP. Hand-rolled because the browser
// already ships DEFLATE via CompressionStream. STORE for compressed media,
// DEFLATE for JSON. No ZIP64/encryption/multi-disk.
//
// Two throw kinds: Oversize (consent.ts) for ceilings the user can lift, and
// plain Error for corruption (bad offsets, duplicate names, inflate mismatch).
// The 4 GB writer limit is also corruption-class — the format cannot express it.

import { oversize, mb } from '../consent.ts';

/**
 * Bytes over a plain ArrayBuffer, which is what everything here holds.
 *
 * The parameter is not decoration: a Uint8Array may sit over a SharedArrayBuffer
 * as well, and one of those cannot be put in a Blob. Naming the buffer keeps the
 * archive's own pieces assignable to a BlobPart all the way to the writer, and
 * refuses a shared view at the door instead of at the last line.
 */
type Bytes = Uint8Array<ArrayBuffer>;

/** One file going into an archive. `data` may be bytes or, better, a Blob. */
export type ZipEntry = { name: string, data: Bytes | ArrayBuffer | Blob, compress?: boolean };

/**
 * Blob, in an environment that has one at all. The typeof is what the writer
 * has always done inline; as a predicate it also narrows what it is asked
 * about, which is what lets `size` and `length` be read off the same value.
 */
const isBlob = (v: unknown): v is Blob => typeof Blob !== 'undefined' && v instanceof Blob;

const LOCAL_SIG = 0x04034b50;
const CD_SIG = 0x02014b50;
const EOCD_SIG = 0x06054b50;
const MAX = 0xffffffff;

// --- CRC32 -----------------------------------------------------------------

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let i = 0; i < 256; i++) {
    let c = i;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[i] = c >>> 0;
  }
  return t;
})();

const CRC_INIT = 0xffffffff;
const crcChunk = (c: number, bytes: Uint8Array) => {
  for (let i = 0; i < bytes.length; i++) c = CRC_TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
  return c >>> 0;
};
const crcEnd = (c: number) => (c ^ 0xffffffff) >>> 0;

export function crc32(bytes: Uint8Array) {
  return crcEnd(crcChunk(CRC_INIT, bytes));
}

/**
 * The same digest over a Blob, read a chunk at a time and never held whole.
 *
 * A ZIP entry's CRC has to be known before its local header is written, which
 * is the one thing that stopped a photograph going into the archive as a Blob
 * rather than as bytes. Streaming it is the difference between a peak of every
 * asset resident at once and a peak of one chunk.
 *
 * Kept per Blob, which cannot change: a board's pictures are the same Blobs
 * save after save, and a 400 MB board otherwise read all of them through a
 * JavaScript loop at every whole write.
 */
const blobCrcs = new WeakMap<Blob, number>();
async function crc32Blob(blob: Blob) {
  const known = blobCrcs.get(blob);
  if (known !== undefined) return known;
  const reader = blob.stream().getReader();
  let c = CRC_INIT;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      c = crcChunk(c, value);
    }
  } finally {
    await reader.cancel().catch(() => {});
  }
  const crc = crcEnd(c);
  blobCrcs.set(blob, crc);
  return crc;
}

// --- DEFLATE via the platform ----------------------------------------------

let rawSupport: boolean | null = null;
function supportsRaw() {
  if (rawSupport === null) {
    try { new CompressionStream('deflate-raw'); rawSupport = true; }
    catch { rawSupport = false; }
  }
  return rawSupport;
}

async function deflateRaw(bytes: Bytes): Promise<Bytes> {
  const stream = new Blob([bytes]).stream().pipeThrough(new CompressionStream('deflate-raw'));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

/**
 * Deflate a Blob into a Blob, without either end being resident.
 *
 * The output is asked for as a Blob rather than an ArrayBuffer for the same
 * reason the input is one: the browser keeps a Blob wherever it likes,
 * including on disk, where a Uint8Array is unavoidably heap.
 */
async function deflateRawBlob(blob: Blob) {
  const stream = blob.stream().pipeThrough(new CompressionStream('deflate-raw'));
  return new Response(stream).blob();
}

/**
 * Inflate, counting output as it arrives and stopping the moment it exceeds
 * `cap` bytes.
 *
 * The counting is the whole point, and it is why this does not simply hand the
 * stream to `new Response(...).arrayBuffer()` the way deflateRaw does. Every
 * limit in the reader below is judged from the size the *central directory
 * declares*, and an archive is under no obligation to tell the truth: an entry
 * can claim to inflate to one byte, sail through the entry, total and ratio
 * checks, and then expand to gigabytes - with the cost already paid by the time
 * anything downstream could notice the declared size was a lie. Collecting the
 * whole stream first would mean the check happens after the damage.
 *
 * So the declared size becomes a budget rather than a claim. A correct entry
 * inflates to exactly `usize` and never trips this; a lying one is cancelled
 * mid-stream, at which point the browser stops pulling and the partial output
 * is dropped.
 */
async function inflateRaw(bytes: Bytes, cap: number, name: string): Promise<Bytes> {
  const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream('deflate-raw'));
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.length;
      if (total > cap) {
        throw new Error(`"${name}" inflates to more than the ${cap} bytes it declares`);
      }
      chunks.push(value);
    }
  } finally {
    // Release the stream whichever way the loop ended.
    await reader.cancel().catch(() => {});
  }
  const out = new Uint8Array(total);
  let at = 0;
  for (const chunk of chunks) { out.set(chunk, at); at += chunk.length; }
  return out;
}

// --- Writing ---------------------------------------------------------------

const enc = new TextEncoder();
const dec = new TextDecoder();
/** UTF-8 that refuses a byte that is not UTF-8, rather than writing U+FFFD. */
const strictUtf8 = new TextDecoder('utf-8', { fatal: true });

/**
 * The IBM PC code page, bytes 0x80 to 0xFF in order. Windows Explorer writes
 * entry names in it with bit 11 of the flags clear, so a rezipped board with
 * an accented name read as UTF-8 came out as U+FFFD, and two such names
 * collapsed into one "appears twice" refusal.
 */
const CP437_HIGH =
  'ÇüéâäàåçêëèïîìÄÅÉæÆôöòûùÿÖÜ¢£¥₧ƒáíóúñÑªº¿⌐¬½¼¡«»' +
  '░▒▓│┤╡╢╖╕╣║╗╝╜╛┐└┴┬├─┼╞╟╚╔╩╦╠═╬╧╨╤╥╙╘╒╓╫╪┘┌█▄▌▐▀' +
  'αßΓπΣσµτΦΘΩδ∞φε∩≡±≥≤⌠⌡÷≈°∙·√ⁿ²■ ';

/** An entry's name, by what its flags and its bytes say it is. */
function entryName(raw: Uint8Array, flags: number): string {
  // Bit 11: the name is UTF-8, said outright.
  if (flags & 0x800) return dec.decode(raw);
  try {
    // No flag and UTF-8 anyway, which most archivers write. This app's own
    // writer sets the flag.
    return strictUtf8.decode(raw);
  } catch {
    let out = '';
    for (const b of raw) out += b < 0x80 ? String.fromCharCode(b) : CP437_HIGH[b - 0x80];
    return out;
  }
}

function dosDateTime(date: Date) {
  const d = date instanceof Date ? date : new Date();
  const y = Math.max(1980, d.getFullYear());
  return {
    time: (d.getHours() << 11) | (d.getMinutes() << 5) | (d.getSeconds() >> 1),
    date: ((y - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate(),
  };
}

/**
 * Build a ZIP from `[{ name, data, compress?: boolean }]`. Returns a Blob.
 * Entry order is preserved.
 *
 * `data` may be a Uint8Array, an ArrayBuffer, or a **Blob**, and the third is
 * the one that matters. Everything an export writes that is large is an asset,
 * and an asset is already a Blob in the store - the browser's, kept wherever
 * the browser likes, quite possibly on disk. Turning it into a Uint8Array to
 * hand it over here pulled the whole board onto the heap, twice over: once as
 * the entry's `data` and again as the payload held in `parts` until the final
 * Blob was assembled. A four-gigabyte board could not be written by a tab that
 * had to hold four gigabytes to write it.
 *
 * Passed as a Blob it is never resident. The CRC is streamed, the deflate (when
 * it is worth doing) goes Blob to Blob through the platform's own compressor,
 * and `parts` holds a *reference* - `new Blob([...])` composes its members
 * rather than copying them. Peak memory becomes a chunk and a header instead of
 * the archive.
 */
export async function writeZip(entries: ZipEntry[], opts: ZipOptions = {}) {
  return (await build(entries, opts, null, () => false)).body;
}

/** writeZip(), and the layout an appendZip() onto the result will want. */
export async function writeZipLayout(entries: ZipEntry[], opts: ZipOptions = {}) {
  const { body, layout } = await build(entries, opts, null, () => false);
  return { blob: body, layout };
}

/**
 * The tail that turns a file this module wrote into one holding `entries`:
 * only the entries that are new or changed, then a whole new central directory
 * and its record. The file stays one ZIP. Its old directory and every entry
 * nothing points at any more stay behind as dead bytes, which `waste` counts,
 * so the caller can write the file whole again when there is too much of it.
 *
 * An entry the file already holds under the same name is pointed at rather
 * than written again when `keep(name)` says its name decides its bytes (a
 * content-addressed asset) or when its checksum and length match. Readers take
 * the last directory, and a tail cut short leaves the one before it standing -
 * see findEOCD().
 */
export async function appendZip(
  entries: ZipEntry[], prior: ZipLayout, keep: (name: string) => boolean, opts: ZipOptions = {},
) {
  const { body, layout, waste } = await build(entries, opts, prior, keep);
  return { tail: body, layout, waste };
}

type ZipOptions ={ date?: Date, mime?: string };

/** Where one entry sits in a file already written - what its central record says. */
type ZipRecord = {
  offset: number, crc: number, csize: number, usize: number,
  method: number, time: number, date: number,
};

/** A file this module wrote, as the next append needs it: its length, and where each entry sits. */
export type ZipLayout = { size: number, records: Map<string, ZipRecord> };

/**
 * How much of a file its directory does not point at: what appends left
 * behind. Counted as build() counts `waste`, every header as this module
 * writes one, so a file from another writer with extra fields reads a little
 * deader than it is - which errs towards compacting it.
 */
export function deadBytes(layout: ZipLayout): number {
  let live = 22;
  for (const [name, rec] of layout.records) {
    const len = enc.encode(name).length;
    live += 30 + len + rec.csize + 46 + len;
  }
  return Math.max(0, layout.size - live);
}

/**
 * A file's layout from its last bytes alone: the end record and the central
 * directory, never the entries in front of them, so a 400 MB board is read for
 * a few hundred KB. `tail` is the file's last tail.length bytes, `size` its
 * length. Answers the layout; or, when `tail` starts inside the directory, how
 * many bytes from the end it takes; or null for a file this cannot read that
 * way - a save cut short, a directory that does not add up - which is then
 * written whole, as it always was.
 */
export function layoutFromTail(tail: Uint8Array, size: number): ZipLayout | number | null {
  if (tail.length < 22 || tail.length > size) return null;
  const view = new DataView(tail.buffer, tail.byteOffset, tail.byteLength);
  // Where tail[0] sits in the file.
  const base = size - tail.length;
  const eocd = lastEOCD(view, tail.length - 22, Math.max(0, tail.length - 22 - 0xffff));
  if (eocd < 0) return null;
  const count = view.getUint16(eocd + 10, true);
  const cdSize = view.getUint32(eocd + 12, true);
  const cdStart = view.getUint32(eocd + 16, true);
  if (cdStart + cdSize > base + eocd) return null;
  if (cdStart < base) return size - cdStart;
  let p = cdStart - base;
  const end = p + cdSize;
  const records = new Map<string, ZipRecord>();
  for (let n = 0; n < count; n++) {
    let rec;
    // What readZip() would call corrupt is, here, a file to write whole.
    try { rec = cdRecord(view, tail, p, end); } catch { return null; }
    const { name, method, time, date, crc, csize, usize, nameLen, localOff: offset } = rec;
    p = rec.next;
    if (name.endsWith('/')) continue;
    // What readZip() would refuse, an append must not point at.
    if (method !== 0 && method !== 8) return null;
    if (method === 0 && csize !== usize) return null;
    if (offset + 30 + nameLen + csize > cdStart || records.has(name)) return null;
    records.set(name, { offset, crc, csize, usize, method, time, date });
  }
  return { size, records };
}

/**
 * The writer. With no `prior` it writes a whole archive. With one it writes
 * the tail appendZip() describes, every offset counted from the start of the
 * file the tail goes onto.
 */
async function build(
  entries: ZipEntry[],
  { date = new Date(), mime = 'application/zip' }: ZipOptions,
  prior: ZipLayout | null,
  keep: (name: string) => boolean,
) {
  const { time, date: dosDate } = dosDateTime(date);
  const parts: (Bytes | Blob)[] = [];   // body chunks, in file order
  const central: Bytes[] = [];          // central-directory records
  const records = new Map<string, ZipRecord>();
  let offset = prior ? prior.size : 0;
  // What the new directory points at, for the waste count. A reused entry's
  // local header is counted as this module writes one, with no extra field.
  let live = 0;

  // Fixed-width fields: a value that does not fit silently truncates the header.
  // Refuse everything that would need ZIP64.
  if (entries.length > 0xffff) {
    throw new Error(`Too many files for a non-ZIP64 archive (${entries.length}, limit 65535)`);
  }

  for (const entry of entries) {
    const name = enc.encode(entry.name);
    if (name.length > 0xffff) throw new Error(`"${entry.name}" has too long a name for a ZIP entry`);
    const had = prior?.records.get(entry.name);
    let rec = had && keep(entry.name) ? had : null;
    if (!rec) {
      // Blob stays Blob to the output; read size once for the headers.
      const raw = isBlob(entry.data) || entry.data instanceof Uint8Array
        ? entry.data : new Uint8Array(entry.data);
      const rawLen = isBlob(raw) ? raw.size : raw.length;
      const crc = isBlob(raw) ? await crc32Blob(raw) : crc32(raw);
      if (had && had.crc === crc && had.usize === rawLen) rec = had;
      else {
        rec = await writeLocal(entry.name, name, raw, rawLen, crc, !!entry.compress, offset, time, dosDate, parts);
        offset += 30 + name.length + rec.csize;
        if (offset > MAX) throw new Error('Board is too large for a non-ZIP64 .mbrd (4 GB limit)');
      }
    }
    records.set(entry.name, rec);
    live += 30 + name.length + rec.csize;
    central.push(centralRecord(name, rec));
  }

  const cdSize = central.reduce((s, c) => s + c.length, 0);
  if (cdSize > MAX || offset + cdSize > MAX) {
    throw new Error('Board is too large for a non-ZIP64 .mbrd (4 GB limit)');
  }
  const eocd = new Uint8Array(22);
  const ev = new DataView(eocd.buffer);
  ev.setUint32(0, EOCD_SIG, true);
  ev.setUint16(8, entries.length, true);
  ev.setUint16(10, entries.length, true);
  ev.setUint32(12, cdSize, true);
  ev.setUint32(16, offset, true);

  const size = offset + cdSize + eocd.length;
  live += cdSize + eocd.length;
  return {
    body: new Blob([...parts, ...central, eocd], { type: mime }),
    layout: { size, records },
    waste: size - live,
  };
}

/** One entry's local header and payload onto `parts`, and the record that points at it. */
async function writeLocal(
  label: string, name: Bytes, raw: Bytes | Blob, rawLen: number, crc: number,
  compress: boolean, offset: number, time: number, dosDate: number, parts: (Bytes | Blob)[],
): Promise<ZipRecord> {
  let method = 0;
  let payload: Bytes | Blob = raw;
  let payloadLen = rawLen;
  if (compress && supportsRaw() && rawLen > 256) {
    const deflated = isBlob(raw) ? await deflateRawBlob(raw) : await deflateRaw(raw);
    const deflatedLen = isBlob(deflated) ? deflated.size : deflated.length;
    // Only take the compressed form when it actually helps.
    if (deflatedLen < rawLen) { method = 8; payload = deflated; payloadLen = deflatedLen; }
  }

  if (rawLen > MAX || payloadLen > MAX) {
    throw new Error(`"${label}" is too large for a non-ZIP64 archive (4 GB limit)`);
  }

  const local = new Uint8Array(30 + name.length);
  const lv = new DataView(local.buffer);
  lv.setUint32(0, LOCAL_SIG, true);
  lv.setUint16(4, 20, true);            // version needed
  lv.setUint16(6, 0x0800, true);        // flag: UTF-8 names
  lv.setUint16(8, method, true);
  lv.setUint16(10, time, true);
  lv.setUint16(12, dosDate, true);
  lv.setUint32(14, crc, true);
  lv.setUint32(18, payloadLen, true);
  lv.setUint32(22, rawLen, true);
  lv.setUint16(26, name.length, true);
  lv.setUint16(28, 0, true);
  local.set(name, 30);
  parts.push(local, payload);
  return { offset, crc, csize: payloadLen, usize: rawLen, method, time, date: dosDate };
}

/** The central-directory record for one entry. */
function centralRecord(name: Bytes, rec: ZipRecord): Bytes {
  const cd = new Uint8Array(46 + name.length);
  const cv = new DataView(cd.buffer);
  cv.setUint32(0, CD_SIG, true);
  cv.setUint16(4, 20, true);            // version made by
  cv.setUint16(6, 20, true);            // version needed
  cv.setUint16(8, 0x0800, true);
  cv.setUint16(10, rec.method, true);
  cv.setUint16(12, rec.time, true);
  cv.setUint16(14, rec.date, true);
  cv.setUint32(16, rec.crc, true);
  cv.setUint32(20, rec.csize, true);
  cv.setUint32(24, rec.usize, true);
  cv.setUint16(28, name.length, true);
  cv.setUint32(42, rec.offset, true);   // local header offset
  cd.set(name, 46);
  return cd;
}

// --- Reading ---------------------------------------------------------------
//
// Treats the archive as hostile input. Every offset/length is bounds-checked
// where used. Limits are generous (video boards are large) but stop the
// pathological case (decompression bombs, absurd entry counts).

/**
 * What this reader will accept. Sized for a moodboard that might hold a few
 * hundred photos and some video, with a lot of headroom, rather than for the
 * format's own ceilings.
 */
// Exported so tests/zip.test.js can build a fixture that sits one byte over a
// ceiling rather than typing the number twice - a hostile-archive test written
// against a copy of the limit stops testing the limit the moment it moves.
export const LIMITS = {
  /** The archive itself. Beyond this the browser is in trouble regardless. */
  archive: 768 * 1024 ** 2,
  /** Entries. A 500-file board (import/drop.ts caps there) plus its notes and
   *  waveform sidecars lands near 1500; this is an order of magnitude clear. */
  entries: 20000,
  /** One entry, uncompressed. Comfortably past any single video worth pinning. */
  entry: 512 * 1024 ** 2,
  /**
   * Everything uncompressed, added up - the number that actually bounds how
   * much memory an open can cost, since every entry is held at once.
   *
   * Costed rather than picked. Opening holds, at the same time: the archive
   * bytes, every inflated entry, and then a copy of each asset as its own Blob
   * (mbrd.ts slices out of the archive buffer deliberately, so the whole ZIP is
   * not pinned by a handful of subarrays). So peak is roughly archive + 2x
   * total, and the pair below puts that near 2.3 GB in the worst case - which
   * is already optimistic for a phone and not comfortable on a desktop tab.
   *
   * These were 2 GB each, which costed out at something over 6 GB and could
   * not have been honoured by any browser that reached them: the ceiling was
   * high enough that the failure it produced was an out-of-memory crash rather
   * than the message it exists to give.
   */
  total: 768 * 1024 ** 2,
  /**
   * Expansion ratio a single entry may claim. DEFLATE tops out near 1032:1 on a
   * run of one byte; real content in a .mbrd is JSON at perhaps 10:1 and media
   * at ~1:1. 200 leaves honest files far below it while putting a floor under
   * the interesting attack, and it is only applied once an entry is big enough
   * for the ratio to mean anything - a 40-byte file that deflates to 12 has a
   * ratio of 3.3 and is not evidence of anything.
   */
  ratio: 200,
  ratioFloor: 1 << 20,
};

/** The measurement half of the archive-size warning, in the words a reader wants. */
const tooBig = (n: number) =>
  `This file is ${mb(n)}, past the ${mb(LIMITS.archive)} an archive is normally opened at.`;

const tooMany = (count: number) => oversize(
  'archive-entries',
  `This archive declares ${count.toLocaleString()} entries, past the ${LIMITS.entries.toLocaleString()} one is normally opened with.`,
);

/**
 * Whether one entry may be read, from what the directory declares. Shared by
 * both readers, so a ceiling moved in one moves in the other.
 */
function admit(
  name: string, method: number, csize: number, usize: number, totalOut: number,
  { lift, entryCap, totalCap }: { lift: boolean, entryCap: number, totalCap: number },
) {
  if (method !== 0 && method !== 8) {
    throw new Error(`"${name}" uses unsupported compression method ${method}`);
  }
  // Stored means the two sizes are the same number by definition; a file
  // saying otherwise is malformed however innocently it got that way.
  if (method === 0 && csize !== usize) {
    throw new Error(`Corrupt entry "${name}": stored, but its two sizes disagree`);
  }

  // Everything here is judged from the *declared* size, before a byte is
  // inflated. That is the point: the cost of a decompression bomb is paid
  // during the inflate, so the decision has to be made before it starts.
  if (!lift && usize > entryCap) {
    throw oversize(
      'entry-bytes',
      `"${name}" inside this file is ${mb(usize)} unpacked, past the ${mb(entryCap)} one entry is normally given.`,
    );
  }
  if (!lift && totalOut + usize > totalCap) {
    throw oversize(
      'inflated-bytes',
      `This file unpacks to at least ${mb(totalOut + usize)}, past the ${mb(totalCap)} opened at once.`,
    );
  }
  if (!lift && usize > LIMITS.ratioFloor && csize > 0 && usize / csize > LIMITS.ratio) {
    throw oversize(
      'entry-ratio',
      `"${name}" inside this file is ${mb(csize)} packed and claims ${mb(usize)} unpacked - `
      + `it expands ${Math.round(usize / csize)} times over.`,
    );
  }
}

/** Bounds-check before a read, with a message that names the file's fault. */
function within(end: number, size: number, what: string) {
  if (!Number.isFinite(end) || end < 0 || end > size) {
    throw new Error(`Corrupt archive: ${what} points past the end of the file`);
  }
}

/**
 * The central-directory record at `p`, every read bounds-checked against
 * `end` first. The three readers (readZip(), readZipBlob(), layoutFromTail())
 * all go through here, which is what keeps their checks the same checks.
 * Throws a plain Error for anything malformed, never an Oversize.
 */
function cdRecord(view: DataView, bytes: Uint8Array, p: number, end: number) {
  within(p + 46, end, 'a central-directory entry');
  if (view.getUint32(p, true) !== CD_SIG) throw new Error('Corrupt central directory');
  const flags = view.getUint16(p + 8, true);
  const nameLen = view.getUint16(p + 28, true);
  const extraLen = view.getUint16(p + 30, true);
  const commentLen = view.getUint16(p + 32, true);
  within(p + 46 + nameLen, end, 'an entry name');
  const next = p + 46 + nameLen + extraLen + commentLen;
  within(next, end, 'the central directory');
  return {
    name: entryName(bytes.subarray(p + 46, p + 46 + nameLen), flags),
    nameLen,
    method: view.getUint16(p + 10, true),
    time: view.getUint16(p + 12, true),
    date: view.getUint16(p + 14, true),
    crc: view.getUint32(p + 16, true),
    csize: view.getUint32(p + 20, true),
    usize: view.getUint32(p + 24, true),
    localOff: view.getUint32(p + 42, true),
    next,
  };
}

/** The last end-record signature from `from` back to `to`, or -1. */
function lastEOCD(view: DataView, from: number, to: number) {
  for (let i = from; i >= to; i--) {
    if (view.getUint32(i, true) === EOCD_SIG) return i;
  }
  return -1;
}

/**
 * An entry's bytes as written: inflated when deflated, then checksummed. The
 * length check stays after the inflate, whose cap can only catch an entry that
 * expands past what it promised, not one that stops early because the archive
 * is damaged. The checksum is the one check that reads the content, and what
 * turns "the archive parses" into "the archive is intact" - a .mbrd carries
 * the user's photographs, and a silently corrupted one is worse than a refused one.
 */
async function entryBytes(raw: Bytes, method: number, usize: number, crc: number, name: string): Promise<Bytes> {
  let data = raw;
  if (method !== 0) {
    if (typeof DecompressionStream === 'undefined') {
      throw new Error('This browser cannot inflate DEFLATE entries');
    }
    // Capped at the declared size, so the entry cannot cost more than the
    // checks made before it - see inflateRaw.
    data = await inflateRaw(raw, usize, name);
    if (data.length !== usize) throw new Error(`"${name}" failed to inflate cleanly`);
  }
  if (crc32(data) !== crc) throw new Error(`"${name}" is damaged (checksum mismatch)`);
  return data;
}

/**
 * Read a ZIP Blob/ArrayBuffer into `Map<name, Uint8Array>`.
 * Reads the central directory (not a linear scan), so entries written by any
 * conforming zipper - including Explorer's "Send to > Compressed folder" - work.
 */
export async function readZip(
  source: Blob | ArrayBuffer | ArrayBufferView<ArrayBuffer>,
  // Per-read overrides for inflate ceilings. `lift`: all Oversize ceilings
  // bypassed (caller asked the user). `only`: name filter applied before
  // inflate — skipped entries do not count toward total, but admitted ones
  // are checked as before. Corruption checks (plain Error) are never lifted.
  limits: { entry?: number, total?: number, lift?: boolean, only?: (name: string) => boolean } = {},
) {
  const lift = !!limits.lift;
  const entryCap = limits.entry ?? LIMITS.entry;
  const totalCap = limits.total ?? LIMITS.total;
  const only = limits.only;
  // Blob (File or packer output), ArrayBuffer, or typed-array view.
  let bytes: Bytes;
  if (ArrayBuffer.isView(source)) {
    bytes = new Uint8Array(source.buffer, source.byteOffset, source.byteLength);
  } else if (source instanceof ArrayBuffer) {
    bytes = new Uint8Array(source);
  } else {
    // Reject on the Blob's own cheap `.size` before allocating it. arrayBuffer()
    // pulls the whole file into memory first, so an archive already provably too
    // large could exhaust the tab before the length check below - the one it was
    // meant to be stopped by - ever ran. See AUD-04.
    if (!lift && typeof source.size === 'number' && source.size > LIMITS.archive) {
      throw oversize('archive-bytes', tooBig(source.size));
    }
    bytes = new Uint8Array(await source.arrayBuffer());
  }
  const size = bytes.length;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);

  if (!lift && size > LIMITS.archive) {
    throw oversize('archive-bytes', tooBig(size));
  }
  if (size < 22) throw new Error('Not a ZIP archive (too short to hold a directory)');

  const eocd = findEOCD(view, size);
  if (eocd < 0) throw new Error('Not a ZIP archive (no end-of-central-directory record)');

  const count = view.getUint16(eocd + 10, true);
  const cdSize = view.getUint32(eocd + 12, true);
  let p = view.getUint32(eocd + 16, true);

  if (!lift && count > LIMITS.entries) throw tooMany(count);
  // The directory has to lie inside the file and stop before the record that
  // describes it. A backwards scan for the EOCD signature can land on four
  // bytes that merely look like one from inside compressed data, and this is
  // what catches that: the offsets it then reports will not survive here.
  within(p + cdSize, size, 'the central directory');
  if (p + cdSize > eocd) throw new Error('Corrupt archive: the central directory overruns its own record');

  const out = new Map<string, Bytes>();
  let totalOut = 0;

  for (let n = 0; n < count; n++) {
    const { name, method, crc, csize, usize, localOff, next } = cdRecord(view, bytes, p, size);
    p = next;

    if (name.endsWith('/')) continue;      // directory entry: nothing to store
    // Before the duplicate check on purpose: a name the caller does not want is a
    // name this read has no opinion about, including about whether it appears
    // twice. The archive's own consistency is still checked for everything the
    // filter admits.
    if (only && !only(name)) continue;
    // Two entries under one name is not something a zipper produces, and it
    // makes the archive mean two different things depending on which the
    // reader keeps - which for board.json or manifest.json is the whole file.
    // Rejected outright rather than resolved by a rule nobody else shares.
    if (out.has(name)) throw new Error(`Corrupt archive: "${name}" appears twice`);

    // The local header's own name/extra lengths are authoritative for the data
    // offset - they can differ from the central directory's.
    within(localOff + 30, size, `the header for "${name}"`);
    if (view.getUint32(localOff, true) !== LOCAL_SIG) throw new Error(`Corrupt entry "${name}"`);
    const lNameLen = view.getUint16(localOff + 26, true);
    const lExtraLen = view.getUint16(localOff + 28, true);
    const start = localOff + 30 + lNameLen + lExtraLen;
    // The truncation check: a file cut short mid-entry has a start and a csize
    // that no longer fit inside it, and a subarray would silently return the
    // short remainder rather than fail.
    within(start + csize, size, `the data for "${name}"`);

    admit(name, method, csize, usize, totalOut, { lift, entryCap, totalCap });

    const data = await entryBytes(bytes.subarray(start, start + csize), method, usize, crc, name);
    totalOut += data.length;
    out.set(name, data);
  }
  return out;
}

/**
 * readZip() for an archive the app owns as a Blob - a board the shell handed
 * over - without ever holding it as bytes. Only the end, the directory, each
 * local header and the entries `keep()` does not want are read. A stored entry
 * `keep()` names a type for comes back as a slice of the archive, which the
 * browser composes rather than copies: a 400 MB board used to cost the file,
 * a copy of it and a copy of every picture in it, and now costs the file.
 *
 * Every check readZip() makes is made here, in the same words, and the kept
 * slices are checksummed too. The one thing this cannot do cheaply is find an
 * end record past a comment's reach, which only a save cut short leaves; that
 * archive goes to readZip(), whose search crosses the whole file.
 *
 * Not for a File from a picker or a drop: a slice of a file on disk stops
 * reading when the file changes, and the picture on its card with it.
 */
export async function readZipBlob(
  blob: Blob,
  { lift = false, keep }: { lift?: boolean, keep: (name: string) => string | null },
): Promise<{ files: Map<string, Bytes>, blobs: Map<string, Blob> }> {
  const size = blob.size;
  if (!lift && size > LIMITS.archive) throw oversize('archive-bytes', tooBig(size));
  if (size < 22) throw new Error('Not a ZIP archive (too short to hold a directory)');
  const read = async (from: number, to: number): Promise<Bytes> =>
    new Uint8Array(await blob.slice(from, to).arrayBuffer());

  const tailFrom = Math.max(0, size - 0xffff - 22);
  const tail = await read(tailFrom, size);
  const tv = new DataView(tail.buffer);
  const eocd = lastEOCD(tv, tail.length - 22, 0);
  if (eocd < 0) return { files: await readZip(blob, { lift }), blobs: new Map() };

  const count = tv.getUint16(eocd + 10, true);
  const cdSize = tv.getUint32(eocd + 12, true);
  const cdStart = tv.getUint32(eocd + 16, true);
  if (!lift && count > LIMITS.entries) throw tooMany(count);
  within(cdStart + cdSize, size, 'the central directory');
  if (cdStart + cdSize > tailFrom + eocd) throw new Error('Corrupt archive: the central directory overruns its own record');

  const cd = await read(cdStart, cdStart + cdSize);
  const view = new DataView(cd.buffer);
  const files = new Map<string, Bytes>();
  const blobs = new Map<string, Blob>();
  const caps = { lift, entryCap: LIMITS.entry, totalCap: LIMITS.total };
  let totalOut = 0;
  let p = 0;
  for (let n = 0; n < count; n++) {
    const { name, method, crc, csize, usize, localOff, next } = cdRecord(view, cd, p, cd.length);
    p = next;

    if (name.endsWith('/')) continue;
    if (files.has(name) || blobs.has(name)) throw new Error(`Corrupt archive: "${name}" appears twice`);

    // The local header's own lengths place the data, as in readZip().
    within(localOff + 30, size, `the header for "${name}"`);
    const local = await read(localOff, localOff + 30);
    const lv = new DataView(local.buffer);
    if (lv.getUint32(0, true) !== LOCAL_SIG) throw new Error(`Corrupt entry "${name}"`);
    const start = localOff + 30 + lv.getUint16(26, true) + lv.getUint16(28, true);
    within(start + csize, size, `the data for "${name}"`);

    admit(name, method, csize, usize, totalOut, caps);

    const type = method === 0 ? keep(name) : null;
    if (type !== null) {
      const slice = blob.slice(start, start + csize, type);
      if (await crc32Blob(slice) !== crc) throw new Error(`"${name}" is damaged (checksum mismatch)`);
      blobs.set(name, slice);
    } else {
      files.set(name, await entryBytes(await read(start, start + csize), method, usize, crc, name));
    }
    totalOut += usize;
  }
  return { files, blobs };
}

/** The most directory readZipEntry() reads: the entry ceiling at a generous 800 bytes a record. */
const ENTRY_CD_MAX = LIMITS.entries * 800;

/**
 * One small entry out of a ZIP Blob, reading only its end, its directory and
 * that entry, for a question that must be answered before the whole archive is
 * opened. Null when the entry is absent or past `cap` bytes either way, or when
 * the end record is past a comment's reach (readZipBlob()'s one blind spot).
 * Throws a plain Error for anything malformed, with the checks the readers make.
 */
export async function readZipEntry(blob: Blob, name: string, cap: number): Promise<Bytes | null> {
  const size = blob.size;
  if (size < 22) throw new Error('Not a ZIP archive (too short to hold a directory)');
  const read = async (from: number, to: number): Promise<Bytes> =>
    new Uint8Array(await blob.slice(from, to).arrayBuffer());

  const tailFrom = Math.max(0, size - 0xffff - 22);
  const tail = await read(tailFrom, size);
  const tv = new DataView(tail.buffer);
  const eocd = lastEOCD(tv, tail.length - 22, 0);
  if (eocd < 0) return null;
  const count = tv.getUint16(eocd + 10, true);
  const cdSize = tv.getUint32(eocd + 12, true);
  const cdStart = tv.getUint32(eocd + 16, true);
  within(cdStart + cdSize, size, 'the central directory');
  if (cdStart + cdSize > tailFrom + eocd) throw new Error('Corrupt archive: the central directory overruns its own record');
  if (count > LIMITS.entries || cdSize > ENTRY_CD_MAX) return null;

  const cd = await read(cdStart, cdStart + cdSize);
  const view = new DataView(cd.buffer);
  let found: ReturnType<typeof cdRecord> | null = null;
  let p = 0;
  for (let n = 0; n < count; n++) {
    const rec = cdRecord(view, cd, p, cd.length);
    p = rec.next;
    if (rec.name !== name) continue;
    if (found) throw new Error(`Corrupt archive: "${name}" appears twice`);
    found = rec;
  }
  if (!found) return null;
  const { method, crc, csize, usize, localOff } = found;
  if (csize > cap || usize > cap) return null;
  within(localOff + 30, size, `the header for "${name}"`);
  const local = await read(localOff, localOff + 30);
  const lv = new DataView(local.buffer);
  if (lv.getUint32(0, true) !== LOCAL_SIG) throw new Error(`Corrupt entry "${name}"`);
  const start = localOff + 30 + lv.getUint16(26, true) + lv.getUint16(28, true);
  within(start + csize, size, `the data for "${name}"`);
  admit(name, method, csize, usize, 0, { lift: false, entryCap: cap, totalCap: cap });
  return entryBytes(await read(start, start + csize), method, usize, crc, name);
}

/**
 * Scan backwards for the EOCD signature (the record can carry a trailing
 * comment). The first match from the end wins, and the caller then validates
 * what it points at - four bytes inside compressed data can spell EOCD by
 * chance, and only the offsets it claims can tell the difference.
 *
 * With no record where one belongs, the rest of the file is searched, for the
 * one case that produces that: a save appended to a board (appendZip()) that
 * died part way leaves its tail with no record after it, and the last whole
 * save's record further back than a comment could push it. Only a record whose
 * directory lies before it and starts with the directory signature is taken
 * there, since that search crosses every picture in the file.
 */
function findEOCD(view: DataView, size: number) {
  const min = Math.max(0, size - 0xffff - 22);
  const near = lastEOCD(view, size - 22, min);
  if (near >= 0) return near;
  for (let i = min - 1; i >= 0; i--) {
    if (view.getUint32(i, true) !== EOCD_SIG) continue;
    const cdSize = view.getUint32(i + 12, true);
    const p = view.getUint32(i + 16, true);
    if (p + cdSize <= i && (cdSize === 0 || view.getUint32(p, true) === CD_SIG)) return i;
  }
  return -1;
}
