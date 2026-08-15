// A viewable picture pulled out of one the browser cannot decode.
//
// HEIC, camera RAW (CR2/NEF/ARW/DNG and the rest) and a few others are formats
// this app catalogues but no browser draws unaided - measureSize() asks the
// engine to decode one, it refuses, and import/drop.js turns the card into a
// named placeholder. That is honest but bleak: a folder of RAWs lands as a wall
// of grey cards.
//
// The saving grace is that almost every one of these files carries a *second*
// copy of the same image in a format the browser does draw - a full-size JPEG
// preview the camera wrote for its own screen, or a JPEG/Exif thumbnail. This
// module goes and gets that copy. The original file is untouched and still the
// one embedded in the .mbrd (see prepareFile), so the day a real decoder lands
// the card upgrades itself; until then it shows the picture the camera already
// made rather than a hole.
//
// The style is import/artwork.js's, deliberately, because it is the same job -
// walk a container written by something that is not this app, find one blob
// inside it, and trust none of the numbers on the way. So: slice, never slurp;
// cap every count read from the file before it is used to loop or allocate;
// bound every offset against the file's real size; and identify the blob by its
// own first bytes rather than by anything the container claimed. Every path
// returns null on anything malformed - a preview that cannot be found is a named
// card, which is exactly where the caller was headed anyway.

// Ceilings. None is a correctness bound - a real preview clears all of them by a
// wide margin - they are the "this file is lying to us" backstops that keep a
// hostile or truncated container from turning into an unbounded loop or a
// gigabyte allocation.
const MAX_IFDS = 48;          // TIFF IFDs visited before we give up walking
const MAX_ENTRIES = 4096;     // directory entries read from one IFD
const MIN_JPEG = 1024;        // a "preview" under a kilobyte is not one
const MAX_JPEG = 128 * 1024 * 1024;
const SCAN_CAP = 12 * 1024 * 1024;   // window the marker-scan fallback reads

/** One candidate JPEG: where the container says it is, and how long it claims. */
type Candidate = { off: number, len: number };

/** One TIFF directory entry, as much of it as the walk below reads. */
type TiffEntry = { type: number, count: number, valueOff: number };

/**
 * A viewable JPEG for a file the browser will not decode, or null.
 *
 * Tries the structured path first - a TIFF/RAW directory walk that finds the
 * camera's own embedded JPEG, usually the full-size one - and falls back to a
 * bounded scan for a JPEG's start-and-end markers, which is what reaches a
 * HEIC's thumbnail and anything else that simply carries a JPEG somewhere near
 * its front. Whatever comes back is verified to actually begin with JPEG's own
 * bytes before it is handed on, so a wrong offset yields null rather than a
 * broken picture.
 */
export async function embeddedPreview(file: Blob): Promise<File | null> {
  try {
    const head = await bytes(file, 0, 16);
    if (head.length < 12) return null;
    const jpeg = isTiff(head)
      ? await fromTiff(file)
      : null;
    const found = jpeg || await scanForJpeg(file);
    if (!found) return null;
    return new File([found], 'preview.jpg', { type: 'image/jpeg' });
  } catch {
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
// A TIFF file - and every TIFF-based RAW, which is most of them - is a header
// naming a byte order and pointing at the first Image File Directory, and each
// IFD is a count followed by that many 12-byte entries and then the offset of
// the next IFD. The camera's JPEG preview is reached one of two ways from an
// entry: a JPEGInterchangeFormat/-Length pair that points straight at it, or a
// strip whose Compression tag says JPEG. Previews hide in sub-directories as
// often as in the main chain, so both SubIFDs and the next-IFD link are walked.

const II = 0x4949, MM = 0x4d4d;

function isTiff(h: Uint8Array) {
  const order = (h[0] << 8) | h[1];
  const magic = order === MM ? (h[2] << 8) | h[3] : (h[3] << 8) | h[2];
  return (order === II || order === MM) && magic === 42;
}

// TIFF field types, in bytes. Only the two that carry offsets and counts here
// matter; anything else is read for its size and otherwise ignored.
const TYPE_BYTES: Record<number, number> = { 1: 1, 2: 1, 3: 2, 4: 4, 5: 8, 6: 1, 7: 1, 8: 2, 9: 4, 10: 8, 11: 4, 12: 8 };

async function fromTiff(file: Blob): Promise<Blob | null> {
  const head = await bytes(file, 0, 8);
  const le = ((head[0] << 8) | head[1]) === II;
  const dv0 = new DataView(head.buffer, head.byteOffset, head.byteLength);
  const first = dv0.getUint32(4, le);

  // The candidates gathered across every directory, then the largest verified
  // one wins: a camera writes both a postage-stamp thumbnail and a full-screen
  // preview, and the big one is the picture worth showing.
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

    // The whole directory in one read: the entry block plus the 4-byte pointer
    // to the next IFD that follows it.
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

    // The scalar in an entry's value slot. When the value fits in four bytes it
    // sits inline; otherwise those four bytes are an offset into the file, which
    // is only chased for single values (the counts and offsets this needs).
    const scalar = async (e: TiffEntry | undefined): Promise<number | null> => {
      if (!e) return null;
      const size = TYPE_BYTES[e.type] || 0;
      if (!size || e.count !== 1) return null;
      const read = (buf: Uint8Array, o: number) =>
        size === 2 ? new DataView(buf.buffer, buf.byteOffset, buf.byteLength).getUint16(o, le)
        : size === 4 ? new DataView(buf.buffer, buf.byteOffset, buf.byteLength).getUint32(o, le)
        : buf[o];
      if (size <= 4) return read(block, e.valueOff);
      return null;
    };

    // Chase this directory's sub-directories and its next-IFD link. SubIFDs
    // (0x014A) may be a single inline offset or a pointer to a list of them;
    // only the single-offset case is followed, which covers the RAW layouts
    // that actually hide previews there.
    // Only when the four bytes are actually there. `bytes()` clamps its read to
    // file.size, so a .dng or .cr2 truncated exactly at the end of its last IFD
    // entry gives a block of precisely `entries * 12` - the guard above uses
    // `<` and passes - and this read went four bytes past the DataView. The
    // RangeError escaped fromTiff() entirely and was caught by
    // embeddedPreview()'s outer catch, which threw away every candidate already
    // collected *and* skipped the scanForJpeg() fallback that would have found
    // the picture. A truncated file lost its preview twice over.
    const next = block.length >= entries * 12 + 4 ? dv.getUint32(entries * 12, le) : 0;
    if (next) queue.push(next);
    const sub = tags.get(0x014a);
    if (sub && sub.count === 1) { const o = await scalar(sub); if (o) queue.push(o); }

    // Candidate A - a JPEGInterchangeFormat / -Length pair pointing at a JPEG.
    const jOff = await scalar(tags.get(0x0201));
    const jLen = await scalar(tags.get(0x0202));
    if (jOff && jLen) found.push({ off: jOff, len: jLen });

    // Candidate B - a single JPEG-compressed strip (Compression 6 or 7).
    const comp = await scalar(tags.get(0x0103));
    const strip = tags.get(0x0111), bytesTag = tags.get(0x0117);
    if ((comp === 6 || comp === 7) && strip?.count === 1 && bytesTag?.count === 1) {
      const sOff = await scalar(strip), sLen = await scalar(bytesTag);
      if (sOff && sLen) found.push({ off: sOff, len: sLen });
    }
  }

  // Largest first, and take the first that is really a JPEG where it claims to
  // be. The length is the container's claim; the sniff is the file's own word.
  found.sort((a, b) => b.len - a.len);
  for (const { off, len } of found) {
    if (len < MIN_JPEG || len > MAX_JPEG || off + len > file.size) continue;
    const lead = await bytes(file, off, 3);
    if (!isJpeg(lead)) continue;
    return file.slice(off, off + len, 'image/jpeg');
  }
  return null;
}

// ---------------------------------------------------------------------------
// Marker scan  -  the fallback
// ---------------------------------------------------------------------------
//
// For a container this module does not parse - a HEIC, most of all, whose real
// image is HEVC-coded and out of reach but which almost always carries a JPEG or
// Exif thumbnail - the last resort is to look for a JPEG's own bookends: the
// SOI marker FF D8 that opens one and the EOI marker FF D9 that closes it. Only
// a window at the front of the file is read, both to bound the memory and
// because a thumbnail lives in the metadata near the start, not past megabytes
// of picture data.

async function scanForJpeg(file: Blob): Promise<Blob | null> {
  const buf = await bytes(file, 0, Math.min(file.size, SCAN_CAP));
  if (buf.length < MIN_JPEG) return null;
  let best: Candidate | null = null;

  // The end marker at or after `from`, or -1 when there is none left.
  //
  // A cursor rather than a fresh inner loop, and that is the whole of the fix.
  // The nested version was O(n squared) over a 12 MB window on the main thread,
  // uncapped and uncancellable: a file whose extension makes classify() say
  // image and whose bytes are 12 MB of repeating FF D8 FF with no FF D9 gave
  // about four million matching offsets, each running the inner scan to the end
  // of the buffer - roughly 5x10^13 comparisons, and the tab is gone for the
  // rest of the afternoon. The `i += best.len - 1` skip below only ever fires
  // when an end *was* found, so the pathological input never reached it, and
  // the module header's promise to "cap every count read from the file before
  // it is used to loop" was not kept for this loop.
  //
  // Ends are non-decreasing as `i` advances, so one pointer that never rewinds
  // answers every question and the whole scan is linear.
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
    // Found a start; find its matching end. Scanning forward for FF D9 is not
    // exact - a marker's byte pattern can occur inside compressed data - but a
    // wrong end only makes the blob longer, and the browser stops decoding a
    // JPEG at the first real EOI regardless, so an over-long slice still draws.
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
