// Minimal ZIP reader/writer.
//
// A .mbrd *is* a ZIP (same trick as .3mf / .docx), so this is the whole storage
// substrate. It is deliberately hand-rolled rather than a vendored library: the
// browser already ships DEFLATE via CompressionStream('deflate-raw'), so all
// that's left is the container format - a few headers and a CRC32.
//
// Written entries use STORE for anything already compressed (jpg/png/mp4/...)
// and DEFLATE for the JSON, which is where the only real win is.
//
// Not supported (and not needed here): ZIP64, encryption, multi-disk, data
// descriptors. Archives at or above 4 GB are rejected with a clear error rather
// than silently written as corrupt.

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
const crcChunk = (c, bytes) => {
  for (let i = 0; i < bytes.length; i++) c = CRC_TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
  return c >>> 0;
};
const crcEnd = c => (c ^ 0xffffffff) >>> 0;

export function crc32(bytes) {
  return crcEnd(crcChunk(CRC_INIT, bytes));
}

/**
 * The same digest over a Blob, read a chunk at a time and never held whole.
 *
 * A ZIP entry's CRC has to be known before its local header is written, which
 * is the one thing that stopped a photograph going into the archive as a Blob
 * rather than as bytes. Streaming it is the difference between a peak of every
 * asset resident at once and a peak of one chunk.
 */
async function crc32Blob(blob) {
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
  return crcEnd(c);
}

// --- DEFLATE via the platform ----------------------------------------------

let rawSupport = null;
function supportsRaw() {
  if (rawSupport === null) {
    try { new CompressionStream('deflate-raw'); rawSupport = true; }
    catch { rawSupport = false; }
  }
  return rawSupport;
}

async function deflateRaw(bytes) {
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
async function deflateRawBlob(blob) {
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
async function inflateRaw(bytes, cap, name) {
  const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream('deflate-raw'));
  const reader = stream.getReader();
  const chunks = [];
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
    // Releases the underlying source whichever way we left the loop. Cancelling
    // an already-closed stream is a no-op, so this is safe on the happy path.
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

function dosDateTime(date) {
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
export async function writeZip(entries, { date = new Date(), mime = 'application/zip' } = {}) {
  const { time, date: dosDate } = dosDateTime(date);
  const parts = [];        // body chunks, in file order
  const central = [];      // central-directory records
  let offset = 0;

  // Every field below is written at a fixed width, so a value that does not fit
  // is not an overflow that shows up later - it is a number silently truncated
  // into a header that then describes a different archive. A writer that
  // refuses ZIP64 owes it to the reader to refuse *everything* that would need
  // ZIP64, not just the sizes that happen to be easy to check.
  if (entries.length > 0xffff) {
    throw new Error(`Too many files for a non-ZIP64 archive (${entries.length}, limit 65535)`);
  }

  for (const entry of entries) {
    const name = enc.encode(entry.name);
    if (name.length > 0xffff) throw new Error(`"${entry.name}" has too long a name for a ZIP entry`);
    // A Blob stays a Blob all the way to the output; anything else is bytes.
    // `size` and `length` are the same fact under two names, so they are read
    // once here and the headers below use the numbers rather than the objects.
    const blobbed = typeof Blob !== 'undefined' && entry.data instanceof Blob;
    const raw = blobbed || entry.data instanceof Uint8Array
      ? entry.data : new Uint8Array(entry.data);
    const rawLen = blobbed ? raw.size : raw.length;
    const crc = blobbed ? await crc32Blob(raw) : crc32(raw);

    let method = 0;
    let payload = raw;
    let payloadLen = rawLen;
    if (entry.compress && supportsRaw() && rawLen > 256) {
      const deflated = blobbed ? await deflateRawBlob(raw) : await deflateRaw(raw);
      const deflatedLen = blobbed ? deflated.size : deflated.length;
      // Only take the compressed form when it actually helps.
      if (deflatedLen < rawLen) { method = 8; payload = deflated; payloadLen = deflatedLen; }
    }

    if (rawLen > MAX || payloadLen > MAX) {
      throw new Error(`"${entry.name}" is too large for a non-ZIP64 archive (4 GB limit)`);
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

    const cd = new Uint8Array(46 + name.length);
    const cv = new DataView(cd.buffer);
    cv.setUint32(0, CD_SIG, true);
    cv.setUint16(4, 20, true);            // version made by
    cv.setUint16(6, 20, true);            // version needed
    cv.setUint16(8, 0x0800, true);
    cv.setUint16(10, method, true);
    cv.setUint16(12, time, true);
    cv.setUint16(14, dosDate, true);
    cv.setUint32(16, crc, true);
    cv.setUint32(20, payloadLen, true);
    cv.setUint32(24, rawLen, true);
    cv.setUint16(28, name.length, true);
    cv.setUint32(42, offset, true);       // local header offset
    cd.set(name, 46);
    central.push(cd);

    offset += local.length + payloadLen;
    if (offset > MAX) throw new Error('Board is too large for a non-ZIP64 .mbrd (4 GB limit)');
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

  return new Blob([...parts, ...central, eocd], { type: mime });
}

// --- Reading ---------------------------------------------------------------
//
// A .mbrd arrives from outside: emailed, downloaded, dropped in from a USB
// stick, or handed over by someone who made it in another app. Everything below
// therefore treats the archive as hostile input rather than as a file this app
// wrote, and that shapes the whole reader.
//
// Every field is an offset or a length that some other part of the file is
// about to be indexed by, and an unchecked one is either an exception thrown
// from inside a DataView - which reaches the user as an incomprehensible
// RangeError - or a subarray quietly reading somebody else's bytes. So each is
// bounds-checked at the point it is used, and the errors say what was wrong
// with the file.
//
// The limits are the other half. Decompression is the classic asymmetry: a few
// hundred kilobytes of DEFLATE expands to gigabytes, and the tab is gone long
// before anything reports a problem. They are deliberately generous - a board
// full of video is a large and perfectly legitimate file - and they are here to
// stop the pathological case, not to police size.

/**
 * What this reader will accept. Sized for a moodboard that might hold a few
 * hundred photos and some video, with a lot of headroom, rather than for the
 * format's own ceilings.
 */
const LIMITS = {
  /** The archive itself. Beyond this the browser is in trouble regardless. */
  archive: 768 * 1024 ** 2,
  /** Entries. A 500-file board (import/drop.js caps there) plus its notes and
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
   * (mbrd.js slices out of the archive buffer deliberately, so the whole ZIP is
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

/** Bounds-check before a read, with a message that names the file's fault. */
function within(end, size, what) {
  if (!Number.isFinite(end) || end < 0 || end > size) {
    throw new Error(`Corrupt archive: ${what} points past the end of the file`);
  }
}

/**
 * Read a ZIP Blob/ArrayBuffer into `Map<name, Uint8Array>`.
 * Reads the central directory (not a linear scan), so entries written by any
 * conforming zipper - including Explorer's "Send to > Compressed folder" - work.
 */
export async function readZip(source) {
  // Blob is what the app passes (a File, or one built by the packer). The
  // typed-array and ArrayBuffer forms are for anything already in memory -
  // notably the tests, which have no reason to wrap bytes in a Blob first.
  // A view is honoured at its own offset rather than through its whole
  // buffer, so a subarray of a larger allocation reads as itself.
  let bytes;
  if (ArrayBuffer.isView(source)) {
    bytes = new Uint8Array(source.buffer, source.byteOffset, source.byteLength);
  } else if (source instanceof ArrayBuffer) {
    bytes = new Uint8Array(source);
  } else {
    // Reject on the Blob's own cheap `.size` before allocating it. arrayBuffer()
    // pulls the whole file into memory first, so an archive already provably too
    // large could exhaust the tab before the length check below - the one it was
    // meant to be stopped by - ever ran. See AUD-04.
    if (typeof source.size === 'number' && source.size > LIMITS.archive) {
      throw new Error(`Archive is too large to open (${source.size} bytes)`);
    }
    bytes = new Uint8Array(await source.arrayBuffer());
  }
  const size = bytes.length;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);

  if (size > LIMITS.archive) {
    throw new Error(`Archive is too large to open (${size} bytes)`);
  }
  if (size < 22) throw new Error('Not a ZIP archive (too short to hold a directory)');

  const eocd = findEOCD(view, size);
  if (eocd < 0) throw new Error('Not a ZIP archive (no end-of-central-directory record)');

  const count = view.getUint16(eocd + 10, true);
  const cdSize = view.getUint32(eocd + 12, true);
  let p = view.getUint32(eocd + 16, true);

  if (count > LIMITS.entries) {
    throw new Error(`Archive declares too many entries (${count})`);
  }
  // The directory has to lie inside the file and stop before the record that
  // describes it. A backwards scan for the EOCD signature can land on four
  // bytes that merely look like one from inside compressed data, and this is
  // what catches that: the offsets it then reports will not survive here.
  within(p + cdSize, size, 'the central directory');
  if (p + cdSize > eocd) throw new Error('Corrupt archive: the central directory overruns its own record');

  const out = new Map();
  let totalOut = 0;

  for (let n = 0; n < count; n++) {
    within(p + 46, size, 'a central-directory entry');
    if (view.getUint32(p, true) !== CD_SIG) throw new Error('Corrupt central directory');

    const method = view.getUint16(p + 10, true);
    const crc = view.getUint32(p + 16, true);
    const csize = view.getUint32(p + 20, true);
    const usize = view.getUint32(p + 24, true);
    const nameLen = view.getUint16(p + 28, true);
    const extraLen = view.getUint16(p + 30, true);
    const commentLen = view.getUint16(p + 32, true);
    const localOff = view.getUint32(p + 42, true);

    within(p + 46 + nameLen, size, 'an entry name');
    const name = dec.decode(bytes.subarray(p + 46, p + 46 + nameLen));
    p += 46 + nameLen + extraLen + commentLen;
    within(p, size, 'the central directory');

    if (name.endsWith('/')) continue;      // directory entry: nothing to store
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
    if (usize > LIMITS.entry) {
      throw new Error(`"${name}" is too large to open (${usize} bytes)`);
    }
    if (totalOut + usize > LIMITS.total) {
      throw new Error('Archive expands to more than this app will open at once');
    }
    if (usize > LIMITS.ratioFloor && csize > 0 && usize / csize > LIMITS.ratio) {
      throw new Error(`"${name}" expands ${Math.round(usize / csize)}x - refusing to unpack it`);
    }

    const raw = bytes.subarray(start, start + csize);
    let data;
    if (method === 0) {
      data = raw;
    } else {
      if (typeof DecompressionStream === 'undefined') {
        throw new Error('This browser cannot inflate DEFLATE entries');
      }
      // Capped at the declared size, so the entry cannot cost more than the
      // checks above were made against - see inflateRaw. Coming back short is
      // still a failure, and that check has to stay here: the cap can only
      // catch an entry that expands past what it promised, not one that stops
      // early because the archive is damaged.
      data = await inflateRaw(raw, usize, name);
      if (data.length !== usize) {
        throw new Error(`"${name}" failed to inflate cleanly`);
      }
    }

    // The last word on whether these are the bytes that were written. Every
    // check so far has been about structure; this is the only one that reads
    // the content, and it is what turns "the archive parses" into "the archive
    // is intact". A .mbrd carries the user's photographs - a silently
    // corrupted one is worse than a refused one.
    if (crc32(data) !== crc) {
      throw new Error(`"${name}" is damaged (checksum mismatch)`);
    }

    totalOut += data.length;
    out.set(name, data);
  }
  return out;
}

/**
 * Scan backwards for the EOCD signature (the record can carry a trailing
 * comment). The first match from the end wins, and the caller then validates
 * what it points at - four bytes inside compressed data can spell EOCD by
 * chance, and only the offsets it claims can tell the difference.
 */
function findEOCD(view, size) {
  const min = Math.max(0, size - 0xffff - 22);
  for (let i = size - 22; i >= min; i--) {
    if (view.getUint32(i, true) === EOCD_SIG) return i;
  }
  return -1;
}
