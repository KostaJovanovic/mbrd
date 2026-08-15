// The embedded-preview reader: a TIFF walk over a file the app did not write.
//
// import/preview.ts is one of the six hand-written binary readers CLAUDE.md
// names as "must bounds-check before allocating", and until this file it had no
// test and was imported by no test. It is also the reader with the widest
// hostile surface of the six: a RAW is a directory of offsets and lengths, all
// of them written by somebody else, and every one of them is chased.
//
// Everything here is built by hand out of bytes rather than by round-tripping
// the app's own writer - the app has no TIFF writer, and a fixture produced by
// the code under test proves only that it agrees with itself.
//
// The module returns null for everything malformed by design, which makes the
// fixtures below easy to get wrong: a test that asserts null passes when the
// reader is broken *and* when the fixture is. So every "refuses" case is paired
// with a working fixture built the same way, and the working one is asserted
// first. If the pair ever both return null, the fixture is what moved.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { embeddedPreview } from '../web/assets/js/import/preview.ts';

// ---------------------------------------------------------------------------
// A TIFF, assembled
// ---------------------------------------------------------------------------

const II = 0x4949;

/** A JPEG of `len` bytes: real SOI/EOI markers, filler in between. */
function jpeg(len) {
  const b = new Uint8Array(len);
  b[0] = 0xff; b[1] = 0xd8; b[2] = 0xff; b[3] = 0xe0;
  for (let i = 4; i < len - 2; i++) b[i] = (i * 7) & 0x7f;   // never 0xff
  b[len - 2] = 0xff; b[len - 1] = 0xd9;
  return b;
}

/**
 * A little-endian TIFF with one IFD.
 *
 * `entries` is a list of [tag, type, count, value] written in order; the header
 * is 8 bytes, the IFD lands at 8, and `payload` is appended after it at the
 * offset the builder reports back so a fixture can point an entry at it.
 */
function tiff(entries, payload = new Uint8Array(0), opts = {}) {
  const count = opts.declaredEntries ?? entries.length;
  const ifdSize = 2 + entries.length * 12 + 4;
  const payloadAt = 8 + ifdSize;
  const buf = new Uint8Array(payloadAt + payload.length);
  const dv = new DataView(buf.buffer);

  dv.setUint16(0, II, false);          // 'II', byte order
  dv.setUint16(2, 42, true);           // the magic
  dv.setUint32(4, 8, true);            // first IFD at byte 8

  dv.setUint16(8, count, true);
  entries.forEach(([tag, type, n, value], i) => {
    const at = 10 + i * 12;
    dv.setUint16(at, tag, true);
    dv.setUint16(at + 2, type, true);
    dv.setUint32(at + 4, n, true);
    dv.setUint32(at + 8, value, true);
  });
  dv.setUint32(10 + entries.length * 12, opts.nextIfd ?? 0, true);

  buf.set(payload, payloadAt);
  return { bytes: buf, payloadAt, blob: new Blob([buf]) };
}

const JPEG_OFFSET = 0x0201;   // JPEGInterchangeFormat
const JPEG_LENGTH = 0x0202;   // JPEGInterchangeFormatLength
const COMPRESSION = 0x0103;
const STRIP_OFFSET = 0x0111;
const STRIP_BYTES = 0x0117;
const LONG = 4;               // TIFF type 4: 32-bit unsigned

/** The ordinary case: a camera JPEG reachable through the offset/length pair. */
function goodTiff(len = 4096) {
  const art = jpeg(len);
  const t = tiff([], art);
  // Rebuilt now that the payload offset is known.
  return tiff([
    [JPEG_OFFSET, LONG, 1, t.payloadAt],
    [JPEG_LENGTH, LONG, 1, len],
  ], art);
}

// ---------------------------------------------------------------------------
// The path that works
// ---------------------------------------------------------------------------

test('a camera JPEG behind an offset/length pair is found and returned', async () => {
  const found = await embeddedPreview(goodTiff().blob);
  assert.ok(found, 'the ordinary fixture must work, or every refusal below is meaningless');
  assert.equal(found.type, 'image/jpeg');
  assert.equal(found.size, 4096);
  const head = new Uint8Array(await found.slice(0, 3).arrayBuffer());
  assert.deepEqual([...head], [0xff, 0xd8, 0xff], 'and it really is a JPEG');
});

test('a JPEG-compressed strip is the other way in', async () => {
  const art = jpeg(2048);
  const shape = tiff([[COMPRESSION, 3, 1, 6], [STRIP_OFFSET, LONG, 1, 0], [STRIP_BYTES, LONG, 1, 0]], art);
  const t = tiff([
    [COMPRESSION, 3, 1, 6],
    [STRIP_OFFSET, LONG, 1, shape.payloadAt],
    [STRIP_BYTES, LONG, 1, 2048],
  ], art);
  const found = await embeddedPreview(t.blob);
  assert.ok(found, 'a Compression 6 strip is a preview');
  assert.equal(found.size, 2048);
});

test('the largest candidate wins, not the first one listed', async () => {
  // A camera writes a postage-stamp thumbnail and a full-screen preview. The
  // big one is the picture worth showing, and it is not always written first.
  const small = jpeg(1500);
  const big = jpeg(9000);
  const payload = new Uint8Array(small.length + big.length);
  payload.set(small, 0);
  payload.set(big, small.length);

  const shape = tiff([[JPEG_OFFSET, LONG, 1, 0], [JPEG_LENGTH, LONG, 1, 0]], payload,
    { nextIfd: 0 });
  const at = shape.payloadAt;
  // Two IFDs: the first names the thumbnail, the second the full preview.
  const first = tiff([
    [JPEG_OFFSET, LONG, 1, at],
    [JPEG_LENGTH, LONG, 1, small.length],
  ], payload, { nextIfd: 0 });

  // Build the chain by hand: the second IFD goes after the payload.
  const secondIfd = new Uint8Array(2 + 2 * 12 + 4);
  const sdv = new DataView(secondIfd.buffer);
  sdv.setUint16(0, 2, true);
  sdv.setUint16(2, JPEG_OFFSET, true); sdv.setUint16(4, LONG, true);
  sdv.setUint32(6, 1, true); sdv.setUint32(10, at + small.length, true);
  sdv.setUint16(14, JPEG_LENGTH, true); sdv.setUint16(16, LONG, true);
  sdv.setUint32(18, 1, true); sdv.setUint32(22, big.length, true);

  const whole = new Uint8Array(first.bytes.length + secondIfd.length);
  whole.set(first.bytes, 0);
  whole.set(secondIfd, first.bytes.length);
  new DataView(whole.buffer).setUint32(10 + 2 * 12, first.bytes.length, true);

  const found = await embeddedPreview(new Blob([whole]));
  assert.ok(found, 'neither candidate was reachable - the fixture is wrong');
  assert.equal(found.size, big.length, 'the thumbnail was preferred over the preview');
});

// ---------------------------------------------------------------------------
// Counts and offsets the file made up
// ---------------------------------------------------------------------------

// Note on the three below. `embeddedPreview` falls back to the marker scan
// whenever the TIFF walk comes back empty, and these fixtures carry a real JPEG
// in their payload for the walk to point at - so the scan finds it and the call
// returns a preview rather than null. That is the designed behaviour and worth
// having tested; what these assert is the invariant underneath it, which is that
// nothing the container claims is ever believed past the end of the file.

test('an entry count past MAX_ENTRIES is not looped on', { timeout: 5000 }, async () => {
  const t = goodTiff();
  // 60000 entries declared over an IFD that holds two. Without the ceiling this
  // is 60000 twelve-byte reads off the end of a 4 KB buffer.
  new DataView(t.bytes.buffer).setUint16(8, 60000, true);
  const found = await embeddedPreview(new Blob([t.bytes]));
  assert.ok(!found || found.size <= t.bytes.length,
    'the directory count was believed over the file it is in');
});

test('a JPEG length larger than the file is never sliced', async () => {
  const art = jpeg(4096);
  const shape = tiff([[JPEG_OFFSET, LONG, 1, 0], [JPEG_LENGTH, LONG, 1, 0]], art);
  const t = tiff([
    [JPEG_OFFSET, LONG, 1, shape.payloadAt],
    [JPEG_LENGTH, LONG, 1, 0x7fffffff],
  ], art);
  const found = await embeddedPreview(t.blob);
  assert.ok(!found || found.size <= t.bytes.length,
    `off + len ran past the end of the file and ${found?.size} bytes came back`);
  assert.notEqual(found?.size, 0x7fffffff);
});

test('a JPEG offset past the end of the file is never sliced', async () => {
  const art = jpeg(4096);
  const t = tiff([
    [JPEG_OFFSET, LONG, 1, 0x00ffffff],
    [JPEG_LENGTH, LONG, 1, 4096],
  ], art);
  const found = await embeddedPreview(t.blob);
  assert.ok(!found || found.size <= t.bytes.length);
});

test('a TIFF whose candidates all lie, and no JPEG anywhere, yields nothing', async () => {
  // The same three lies with nothing for the fallback to rescue: the payload is
  // filler, so a null here is the walk refusing rather than the scan failing.
  const filler = new Uint8Array(4096).fill(0x41);
  const shape = tiff([[JPEG_OFFSET, LONG, 1, 0], [JPEG_LENGTH, LONG, 1, 0]], filler);
  for (const [off, len] of [
    [shape.payloadAt, 0x7fffffff],   // longer than the file
    [0x00ffffff, 4096],              // starts past the end of it
    [shape.payloadAt, 4096],         // in range, and not a JPEG
  ]) {
    const t = tiff([[JPEG_OFFSET, LONG, 1, off], [JPEG_LENGTH, LONG, 1, len]], filler);
    assert.equal(await embeddedPreview(t.blob), null, `off ${off} len ${len}`);
  }
});

test('a candidate under MIN_JPEG is not a preview', async () => {
  const art = jpeg(600);
  const shape = tiff([[JPEG_OFFSET, LONG, 1, 0], [JPEG_LENGTH, LONG, 1, 0]], art);
  const t = tiff([
    [JPEG_OFFSET, LONG, 1, shape.payloadAt],
    [JPEG_LENGTH, LONG, 1, 600],
  ], art);
  assert.equal(await embeddedPreview(t.blob), null,
    'a "preview" under a kilobyte is a favicon, not a picture');
});

test('a candidate that is not a JPEG where it claims to be is refused', async () => {
  // The container's word against the file's own bytes: the length and offset
  // are perfectly valid, and what is there is not a JPEG.
  const art = new Uint8Array(4096).fill(0x41);
  const shape = tiff([[JPEG_OFFSET, LONG, 1, 0], [JPEG_LENGTH, LONG, 1, 0]], art);
  const t = tiff([
    [JPEG_OFFSET, LONG, 1, shape.payloadAt],
    [JPEG_LENGTH, LONG, 1, 4096],
  ], art);
  assert.equal(await embeddedPreview(t.blob), null);
});

test('an IFD chain that points at itself terminates', { timeout: 5000 }, async () => {
  // MAX_IFDS bounds the walk and `seen` bounds it again. Without either, a
  // next-IFD pointer back to byte 8 is a loop with an await in it, which does
  // not even burn the CPU visibly - the import just never finishes.
  const t = goodTiff();
  new DataView(t.bytes.buffer).setUint32(10 + 2 * 12, 8, true);
  const found = await embeddedPreview(new Blob([t.bytes]));
  assert.ok(found, 'the self-referencing chain should still find the preview it names');
});

test('a truncated header is not a TIFF and not a crash', async () => {
  for (const n of [0, 1, 8, 11]) {
    assert.equal(await embeddedPreview(new Blob([new Uint8Array(n)])), null, `${n} bytes`);
  }
});

test('a file that is not a TIFF falls through to the marker scan', async () => {
  // The HEIC case: not a TIFF, but with a JPEG thumbnail sitting near the
  // front, which is exactly what the fallback is for.
  const lead = new Uint8Array(64).fill(0x20);
  const art = jpeg(3000);
  const buf = new Uint8Array(lead.length + art.length);
  buf.set(lead, 0);
  buf.set(art, lead.length);
  const found = await embeddedPreview(new Blob([buf]));
  assert.ok(found, 'the marker scan did not find a JPEG lying in plain sight');
  assert.equal(found.size, art.length);
});

test('a file with an SOI and no EOI yields nothing', async () => {
  const buf = new Uint8Array(8192);
  buf[100] = 0xff; buf[101] = 0xd8; buf[102] = 0xff;
  assert.equal(await embeddedPreview(new Blob([buf])), null);
});
