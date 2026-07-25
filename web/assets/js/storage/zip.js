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

export function crc32(bytes) {
  let c = 0xffffffff;
  for (let i = 0; i < bytes.length; i++) c = CRC_TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
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

async function inflateRaw(bytes) {
  const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream('deflate-raw'));
  return new Uint8Array(await new Response(stream).arrayBuffer());
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
 * Build a ZIP from `[{ name, data: Uint8Array, compress?: boolean }]`.
 * Returns a Blob. Entry order is preserved.
 */
export async function writeZip(entries, { date = new Date(), mime = 'application/zip' } = {}) {
  const { time, date: dosDate } = dosDateTime(date);
  const parts = [];        // body chunks, in file order
  const central = [];      // central-directory records
  let offset = 0;

  for (const entry of entries) {
    const name = enc.encode(entry.name);
    const raw = entry.data instanceof Uint8Array ? entry.data : new Uint8Array(entry.data);
    const crc = crc32(raw);

    let method = 0;
    let payload = raw;
    if (entry.compress && supportsRaw() && raw.length > 256) {
      const deflated = await deflateRaw(raw);
      // Only take the compressed form when it actually helps.
      if (deflated.length < raw.length) { method = 8; payload = deflated; }
    }

    if (raw.length > MAX || payload.length > MAX) {
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
    lv.setUint32(18, payload.length, true);
    lv.setUint32(22, raw.length, true);
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
    cv.setUint32(20, payload.length, true);
    cv.setUint32(24, raw.length, true);
    cv.setUint16(28, name.length, true);
    cv.setUint32(42, offset, true);       // local header offset
    cd.set(name, 46);
    central.push(cd);

    offset += local.length + payload.length;
    if (offset > MAX) throw new Error('Board is too large for a non-ZIP64 .mbrd (4 GB limit)');
  }

  const cdSize = central.reduce((s, c) => s + c.length, 0);
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

/**
 * Read a ZIP Blob/ArrayBuffer into `Map<name, Uint8Array>`.
 * Reads the central directory (not a linear scan), so entries written by any
 * conforming zipper - including Explorer's "Send to > Compressed folder" - work.
 */
export async function readZip(source) {
  const buf = source instanceof ArrayBuffer ? source : await source.arrayBuffer();
  const bytes = new Uint8Array(buf);
  const view = new DataView(buf);

  const eocd = findEOCD(view, bytes.length);
  if (eocd < 0) throw new Error('Not a ZIP archive (no end-of-central-directory record)');

  const count = view.getUint16(eocd + 10, true);
  let p = view.getUint32(eocd + 16, true);
  const out = new Map();

  for (let n = 0; n < count; n++) {
    if (view.getUint32(p, true) !== CD_SIG) throw new Error('Corrupt central directory');
    const method = view.getUint16(p + 10, true);
    const csize = view.getUint32(p + 20, true);
    const usize = view.getUint32(p + 24, true);
    const nameLen = view.getUint16(p + 28, true);
    const extraLen = view.getUint16(p + 30, true);
    const commentLen = view.getUint16(p + 32, true);
    const localOff = view.getUint32(p + 42, true);
    const name = dec.decode(bytes.subarray(p + 46, p + 46 + nameLen));
    p += 46 + nameLen + extraLen + commentLen;

    // The local header's own name/extra lengths are authoritative for the data
    // offset - they can differ from the central directory's.
    if (view.getUint32(localOff, true) !== LOCAL_SIG) throw new Error(`Corrupt entry "${name}"`);
    const lNameLen = view.getUint16(localOff + 26, true);
    const lExtraLen = view.getUint16(localOff + 28, true);
    const start = localOff + 30 + lNameLen + lExtraLen;
    const raw = bytes.subarray(start, start + csize);

    if (name.endsWith('/')) continue;      // directory entry: nothing to store
    if (method === 0) {
      out.set(name, raw);
    } else if (method === 8) {
      if (typeof DecompressionStream === 'undefined') {
        throw new Error('This browser cannot inflate DEFLATE entries');
      }
      const inflated = await inflateRaw(raw);
      if (usize && inflated.length !== usize) throw new Error(`"${name}" failed to inflate cleanly`);
      out.set(name, inflated);
    } else {
      throw new Error(`"${name}" uses unsupported compression method ${method}`);
    }
  }
  return out;
}

/** Scan backwards for the EOCD signature (the record can carry a trailing comment). */
function findEOCD(view, size) {
  const min = Math.max(0, size - 0xffff - 22);
  for (let i = size - 22; i >= min; i--) {
    if (view.getUint32(i, true) === EOCD_SIG) return i;
  }
  return -1;
}
