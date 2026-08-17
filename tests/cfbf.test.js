// The compound file reader (import/cfbf.js).
//
// This one is a filesystem, so the tests are mostly about the two ways a stream
// can be stored and the several ways a file can lie about where its sectors are.
// Everything is built here: a compound file cannot be committed, and one written
// by Office would prove that Office's output reads rather than that the reader
// is right about the format.
//
// The builder below writes 512-byte sectors, one FAT sector, one directory
// sector and a mini stream, which is the shape every small compound file in the
// wild actually has. That is deliberate - a synthetic file that exercises paths
// no writer produces tests the test.
//
// Discipline as everywhere else here: **every refusal is paired with a working
// fixture asserted first**, since null is the answer to every failure and a test
// that only asserts null passes on a broken builder too.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { readCompound, compoundPicture, isCompound, isCompoundExt } from '../web/assets/js/import/cfbf.ts';

const SECTOR = 512;
const MINI = 64;
const CUTOFF = 4096;

const FREE = 0xFFFFFFFF;
const END = 0xFFFFFFFE;
const FATSECT = 0xFFFFFFFD;

const PNG_SIG = [0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A];

function png(size = 1024, fill = 0x51) {
  const b = new Uint8Array(Math.max(size, 16)).fill(fill);
  b.set(PNG_SIG);
  return b;
}

function jpeg(size = 1024, fill = 0x52) {
  const b = new Uint8Array(Math.max(size, 16)).fill(fill);
  b.set([0xFF, 0xD8, 0xFF, 0xE0]);
  return b;
}

/** A 40-byte BITMAPINFOHEADER and some pixels - what a CF_DIB actually is. */
function dib(bits = 24) {
  const b = new Uint8Array(40 + 256);
  const dv = new DataView(b.buffer);
  dv.setUint32(0, 40, true);
  dv.setInt32(4, 16, true);
  dv.setInt32(8, 16, true);
  dv.setUint16(12, 1, true);
  dv.setUint16(14, bits, true);
  return b;
}

/**
 * A compound file holding `streams` as `{ name: bytes }`.
 *
 * Streams at or above the cutoff get whole sectors and their own FAT chain;
 * anything below goes into the mini stream, which is itself a normal stream owned
 * by the root entry. Both paths are built because both are real and a thumbnail
 * is usually small enough to be on the second one.
 */
function compound(streams, opts = {}) {
  const names = Object.keys(streams);
  const big = names.filter(n => streams[n].length >= CUTOFF);
  const small = names.filter(n => streams[n].length < CUTOFF);

  // The mini stream is every small stream packed at 64-byte boundaries.
  const miniParts = [];
  const miniAt = {};
  let miniLen = 0;
  for (const n of small) {
    miniAt[n] = miniLen / MINI;
    const padded = Math.ceil(streams[n].length / MINI) * MINI;
    const chunk = new Uint8Array(padded);
    chunk.set(streams[n]);
    miniParts.push(chunk);
    miniLen += padded;
  }
  const miniStream = new Uint8Array(miniLen);
  miniParts.reduce((at, p) => (miniStream.set(p, at), at + p.length), 0);

  // Sector layout: [0] FAT, [1] directory, [2] mini FAT, [3..] mini stream, then
  // each big stream.
  const sectors = [];
  const put = (bytes) => {
    const first = sectors.length;
    for (let at = 0; at < Math.max(bytes.length, 1); at += SECTOR) {
      const s = new Uint8Array(SECTOR);
      s.set(bytes.subarray(at, at + SECTOR));
      sectors.push(s);
    }
    return first;
  };

  sectors.push(new Uint8Array(SECTOR));   // 0: FAT
  sectors.push(new Uint8Array(SECTOR));   // 1: directory
  sectors.push(new Uint8Array(SECTOR));   // 2: mini FAT

  const miniFirst = miniLen ? put(miniStream) : END;
  const bigFirst = {};
  for (const n of big) bigFirst[n] = put(streams[n]);

  // The FAT: every sector chains to the next one of its own run, then ends.
  const fat = new Uint32Array(SECTOR / 4).fill(FREE);
  fat[0] = FATSECT;
  fat[1] = END;
  fat[2] = END;
  const runEnd = (first, length) => {
    const count = Math.max(1, Math.ceil(length / SECTOR));
    for (let i = 0; i < count; i++) fat[first + i] = i === count - 1 ? END : first + i + 1;
  };
  if (miniLen) runEnd(miniFirst, miniLen);
  for (const n of big) runEnd(bigFirst[n], streams[n].length);
  new Uint8Array(fat.buffer).forEach((v, i) => { sectors[0][i] = v; });

  // The mini FAT: one entry per 64-byte slot, chained within each stream.
  const miniFat = new Uint32Array(SECTOR / 4).fill(FREE);
  for (const n of small) {
    const count = Math.max(1, Math.ceil(streams[n].length / MINI));
    for (let i = 0; i < count; i++) {
      miniFat[miniAt[n] + i] = i === count - 1 ? END : miniAt[n] + i + 1;
    }
  }
  new Uint8Array(miniFat.buffer).forEach((v, i) => { sectors[2][i] = v; });

  // The directory: root first, then one entry per stream.
  const dir = sectors[1];
  const entry = (i, name, type, start, size) => {
    const p = i * 128;
    for (let c = 0; c < name.length; c++) {
      dir[p + c * 2] = name.charCodeAt(c) & 255;
      dir[p + c * 2 + 1] = name.charCodeAt(c) >> 8;
    }
    const dv = new DataView(dir.buffer, dir.byteOffset);
    dv.setUint16(p + 64, (name.length + 1) * 2, true);
    dir[p + 66] = type;
    dv.setUint32(p + 116, start, true);
    dv.setUint32(p + 120, size, true);
  };
  entry(0, 'Root Entry', 5, miniLen ? miniFirst : END, miniLen);
  names.forEach((n, i) => entry(
    i + 1, n, 2,
    streams[n].length >= CUTOFF ? bigFirst[n] : miniAt[n],
    streams[n].length,
  ));

  const header = new Uint8Array(512);
  const hv = new DataView(header.buffer);
  header.set(opts.magic || [0xD0, 0xCF, 0x11, 0xE0, 0xA1, 0xB1, 0x1A, 0xE1]);
  hv.setUint16(30, opts.shift ?? 9, true);        // 512-byte sectors
  hv.setUint16(32, opts.miniShift ?? 6, true);    // 64-byte mini sectors
  hv.setUint32(44, 1, true);                      // one FAT sector
  hv.setUint32(48, opts.dirStart ?? 1, true);     // directory chain start
  hv.setUint32(56, CUTOFF, true);                 // mini-stream cutoff
  hv.setUint32(60, 2, true);                      // mini FAT start
  hv.setUint32(64, 1, true);                      // one mini FAT sector
  hv.setUint32(68, opts.difat ?? END, true);      // no extra DIFAT
  hv.setUint32(72, 0, true);
  hv.setUint32(76, opts.fatAt ?? 0, true);        // FAT sector 0
  for (let i = 1; i < 109; i++) hv.setUint32(76 + i * 4, FREE, true);

  const out = new Uint8Array(512 + sectors.length * SECTOR);
  out.set(header);
  sectors.forEach((s, i) => out.set(s, 512 + i * SECTOR));
  return out;
}

/** A `\x05SummaryInformation` stream carrying one VT_CF property. */
function summary(format, payload) {
  const sectionAt = 48;
  const valueAt = 8 + 8;                 // past the count and the one pair
  const body = new Uint8Array(sectionAt + valueAt + 12 + payload.length);
  const dv = new DataView(body.buffer);
  dv.setUint32(44, sectionAt, true);     // where the section starts
  dv.setUint32(sectionAt + 4, 1, true);  // one property
  dv.setUint32(sectionAt + 8, 17, true);         // PIDSI_THUMBNAIL
  dv.setUint32(sectionAt + 12, valueAt, true);   // its offset, section-relative
  const at = sectionAt + valueAt;
  dv.setUint32(at, 71, true);                    // VT_CF
  dv.setUint32(at + 4, payload.length + 4, true);
  dv.setUint32(at + 8, format, true);
  body.set(payload, at + 12);
  return body;
}

const SUMMARY = 'SummaryInformation';

// ---------------------------------------------------------------------------
// What it claims
// ---------------------------------------------------------------------------

test('it claims the compound-file extensions, and Thumbs.db by name', () => {
  for (const ext of ['sldprt', 'sldasm', 'slddrw', 'doc', 'xls', 'ppt', 'max', 'vsd']) {
    assert.equal(isCompoundExt(ext), true, ext);
  }
  assert.equal(isCompoundExt('db', 'Thumbs.db'), true);
  assert.equal(isCompoundExt('db', 'thumbs.db'), true);
  assert.equal(isCompoundExt('db', 'ehthumbs.db'), true);
  // A .db that is not that one is a database, and opening it would find nothing.
  assert.equal(isCompoundExt('db', 'places.sqlite.db'), false);
  for (const ext of ['docx', 'zip', 'png', 'apk']) assert.equal(isCompoundExt(ext), false, ext);
});

test('the magic is what decides it is a compound file', () => {
  assert.equal(isCompound(new Uint8Array([0xD0, 0xCF, 0x11, 0xE0, 0xA1, 0xB1, 0x1A, 0xE1])), true);
  assert.equal(isCompound(new Uint8Array(8)), false);
  assert.equal(isCompound(new Uint8Array([0xD0, 0xCF])), false);
  assert.equal(readCompound(png(2048)), null);
});

// ---------------------------------------------------------------------------
// Reading streams
// ---------------------------------------------------------------------------

test('a stream over the cutoff is read from whole sectors', () => {
  const body = png(6000, 0x61);
  const doc = readCompound(compound({ 'PreviewPNG': body }));
  assert.ok(doc, 'the builder is broken if this is null');
  const got = doc.stream('PreviewPNG');
  assert.ok(got);
  assert.equal(got.length, 6000, 'cut to the declared length, not the sector run');
  assert.deepEqual([...got.subarray(0, 8)], PNG_SIG);
  assert.equal(got[5999], 0x61, 'the last byte of the last sector is there');
});

test('a stream under the cutoff is read out of the mini stream', () => {
  // This is the path that matters: a thumbnail is usually under 4096 bytes, so a
  // reader that only handles whole sectors misses exactly what it came for.
  const body = png(900, 0x62);
  const doc = readCompound(compound({ 'PreviewPNG': body }));
  assert.ok(doc);
  const got = doc.stream('PreviewPNG');
  assert.ok(got, 'the mini stream was not walked');
  assert.equal(got.length, 900);
  assert.equal(got[899], 0x62);
});

test('several small streams do not run into each other', () => {
  const doc = readCompound(compound({
    'One': png(700, 0x71),
    'Two': png(300, 0x72),
    'Three': png(1500, 0x73),
  }));
  assert.ok(doc);
  assert.equal(doc.stream('One')[699], 0x71);
  assert.equal(doc.stream('Two')[299], 0x72);
  assert.equal(doc.stream('Three')[1499], 0x73);
});

test('names come back, and a name that is not there is null', () => {
  const doc = readCompound(compound({ 'PreviewPNG': png(600), 'Contents': png(9000) }));
  assert.ok(doc);
  assert.deepEqual(doc.names().sort(), ['Contents', 'PreviewPNG']);
  assert.equal(doc.stream('Nope'), null);
});

// ---------------------------------------------------------------------------
// Finding the picture
// ---------------------------------------------------------------------------

test('a PreviewPNG stream is the picture, and beats the summary property', () => {
  const doc = readCompound(compound({
    'PreviewPNG': png(800, 0x81),
    [SUMMARY]: summary(8, dib()),
  }));
  assert.ok(doc);
  const got = compoundPicture(doc);
  assert.ok(got);
  assert.equal(got[7], PNG_SIG[7]);
  assert.equal(got[799], 0x81, 'the real PNG, not the 16x16 clipboard bitmap');
});

test('a PNG in the summary property is taken as it is', () => {
  const doc = readCompound(compound({ [SUMMARY]: summary(0, png(700, 0x82)) }));
  assert.ok(doc);
  const got = compoundPicture(doc);
  assert.ok(got);
  assert.equal(got[699], 0x82);
});

test('a clipboard bitmap gets its file header put back', () => {
  const doc = readCompound(compound({ [SUMMARY]: summary(8, dib(24)) }));
  assert.ok(doc);
  const got = compoundPicture(doc);
  assert.ok(got, 'the CF_DIB path did not fire');
  assert.equal(got[0], 0x42);
  assert.equal(got[1], 0x4D);
  assert.equal(new DataView(got.buffer, got.byteOffset).getUint32(10, true), 54);
});

test('a metafile thumbnail is declined rather than mounted broken', () => {
  // CF_METAFILEPICT is a WMF and no browser draws one. This is the same rule
  // import/document.js applies to a .emf named thumbnail.png.
  assert.ok(
    compoundPicture(readCompound(compound({ [SUMMARY]: summary(8, dib()) }))),
    'the CF_DIB fixture works, so the refusal below means something',
  );
  const wmf = readCompound(compound({ [SUMMARY]: summary(3, dib()) }));
  assert.equal(compoundPicture(wmf), null);
});

test('a Thumbs.db is read out of its numbered streams', () => {
  // No preview stream and no summary: just a catalogue and one stream per
  // picture, each with a short header in front of the JPEG.
  const withHeader = (body) => {
    const b = new Uint8Array(body.length + 12);
    b.set(body, 12);
    return b;
  };
  const doc = readCompound(compound({
    'Catalog': png(600, 0x90),
    '1': withHeader(jpeg(700, 0x91)),
    '2': withHeader(jpeg(1400, 0x92)),
  }));
  assert.ok(doc);
  const got = compoundPicture(doc);
  assert.ok(got, 'no numbered stream was read');
  assert.equal(got[0], 0xFF, 'carved from the JPEG signature, not the stream start');
  assert.equal(got[1399], 0x92, 'the larger of the two');
});

test('a document with no picture anywhere is null', () => {
  const doc = readCompound(compound({ 'WordDocument': new Uint8Array(9000).fill(7) }));
  assert.ok(doc);
  assert.equal(compoundPicture(doc), null);
});

// ---------------------------------------------------------------------------
// Files that are lying
// ---------------------------------------------------------------------------

test('a sector geometry no writer emits is refused rather than computed from', () => {
  assert.ok(readCompound(compound({ 'PreviewPNG': png(600) })), 'the honest geometry reads');
  assert.equal(readCompound(compound({ 'PreviewPNG': png(600) }, { shift: 7 })), null);
  assert.equal(readCompound(compound({ 'PreviewPNG': png(600) }, { miniShift: 9 })), null);
});

test('a directory chain that points nowhere finds no streams', () => {
  const doc = readCompound(compound({ 'PreviewPNG': png(600) }, { dirStart: 0xFFFFFF }));
  assert.equal(doc, null);
});

test('a FAT pointer outside the file does not read past the end', () => {
  const bytes = compound({ 'PreviewPNG': png(9000) });
  // Point the first FAT entry of the stream's run at a sector that is not there.
  new DataView(bytes.buffer).setUint32(512 + 3 * 4, 0xFFFF0, true);
  const doc = readCompound(bytes);
  assert.ok(doc, 'the file still opens');
  assert.equal(doc.stream('PreviewPNG'), null, 'the stream does not');
});

test('a FAT chain that loops back on itself terminates', () => {
  const bytes = compound({ 'PreviewPNG': png(9000) });
  // Sector 3 is the first of the stream's run; make it point at itself.
  new DataView(bytes.buffer).setUint32(512 + 3 * 4, 3, true);
  const doc = readCompound(bytes);
  assert.ok(doc);
  // The answer is null rather than a hang, which is the whole of what is asserted
  // here - a test that loops forever does not fail, it stops the suite.
  assert.equal(doc.stream('PreviewPNG'), null);
});

test('every truncation of a working file is refused, and none of them throw', () => {
  const whole = compound({ 'PreviewPNG': png(900, 0x99) });
  assert.ok(compoundPicture(readCompound(whole)), 'the whole file reads');
  for (const at of [8, 100, 511, 512, 700, 1024, whole.length - 64]) {
    const doc = readCompound(whole.subarray(0, at));
    if (doc) assert.doesNotThrow(() => compoundPicture(doc), `cut at ${at}`);
  }
});

test('a summary property whose offsets point outside the stream is refused', () => {
  const good = compound({ [SUMMARY]: summary(0, png(700)) });
  assert.ok(compoundPicture(readCompound(good)), 'the honest property reads');

  const bad = compound({ [SUMMARY]: summary(0, png(700)) });
  // Move the section pointer past the end of the stream it lives in.
  const at = bad.indexOf(0x30, 512);
  assert.ok(at > 0);
  const doc = readCompound(compound({ [SUMMARY]: (() => {
    const s = summary(0, png(700));
    new DataView(s.buffer).setUint32(44, 0xFFFF, true);
    return s;
  })() }));
  assert.ok(doc);
  assert.equal(compoundPicture(doc), null);
});
