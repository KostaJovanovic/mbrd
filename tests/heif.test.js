// The HEIF container reader: a box walk over a file the app did not write,
// and the one that decides what forty-eight offsets get handed to a hardware
// video decoder. Only the half that runs without WebCodecs is reachable here -
// readPlan(), isHeif() and the codec name - which is also the half a malformed
// file reaches first.
//
// Built by hand out of bytes, like tests/preview.test.js and for the same
// reason: there is no writer in this app to round-trip through, and a fixture
// produced by the reader's own idea of the format would only prove agreement
// with itself.
//
// readPlan() returns null for everything malformed, which makes fixtures easy
// to get wrong: a null-only test passes when the reader is broken *and* when
// the fixture is. So every refusal below is a named edit to the one whole file
// asserted first, and `whole()` is checked before any of them.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { readPlan, isHeif, codecName } from '../web/assets/js/import/heif.ts';

// ---------------------------------------------------------------------------
// Bytes
// ---------------------------------------------------------------------------

const u8 = (...n) => Uint8Array.from(n);
const u16 = n => u8((n >> 8) & 255, n & 255);
const u32 = n => u8((n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255);
const ascii = s => Uint8Array.from(s, c => c.charCodeAt(0));

function cat(...parts) {
  const flat = parts.flat();
  const out = new Uint8Array(flat.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of flat) { out.set(p, at); at += p.length; }
  return out;
}

/** A box: its own length, its four-character name, then everything given. */
const box = (type, ...body) => {
  const payload = cat(...body);
  return cat(u32(8 + payload.length), ascii(type), payload);
};

/** A FullBox: a box whose first four bytes are a version and three flag bytes. */
const full = (type, version, flags, ...body) =>
  box(type, u8(version, (flags >> 16) & 255, (flags >> 8) & 255, flags & 255), ...body);

// ---------------------------------------------------------------------------
// A HEIC, assembled
// ---------------------------------------------------------------------------

/** A configuration record shaped like the one a phone writes: Main profile,
 *  level 3.0. The bytes the codec name is read out of are real. */
const HVCC = cat(
  u8(0x01, 0x01), u32(0x60000000),        // version, profile byte, compatibility
  u8(0xb0, 0, 0, 0, 0, 0),                // six constraint bytes
  u8(0x5a),                               // level_idc 90 -> L90
  u8(0xf0, 0, 0xfc, 0xfd, 0xf8, 0xf8, 0, 0, 0),
);

/** A tile's payload. Never read as HEVC here - only its length and position
 *  matter to the container reader - but distinct per tile so a plan that puts
 *  them in the wrong order is visible. */
const tile = (n, len = 64) => Uint8Array.from({ length: len }, (_, i) => (n * 31 + i) & 255);

/**
 * A whole 2x2 grid HEIC. Every named option is one thing to break; the
 * defaults build the file the first test asserts is read whole.
 *
 * Layout is ftyp, mdat, meta - so every iloc offset is known before meta is
 * built, which is the order a camera writes too.
 */
function heic({
  brand = 'heic', cols = 2, rows = 2, cells = [1, 2, 3, 4], tileType = 'hvc1',
  width = 96, height = 96, rotate = 0, mirror = null, gridInIdat = true,
  primary = 5, tileLen = 64, extraTileBytes = 0, dropIdat = false,
} = {}) {
  const ftyp = box('ftyp', ascii(brand), u32(0), ascii('mif1'), ascii(brand));
  // The grid descriptor: version, flags (0 = 16-bit output size), rows-1, cols-1.
  const grid = cat(u8(0, 0, rows - 1, cols - 1), u16(width), u16(height));

  const payloads = cells.map((_, i) => tile(i + 1, tileLen));
  const mdatBody = cat(...payloads, gridInIdat ? new Uint8Array(0) : grid);
  const mdat = box('mdat', mdatBody);
  const mdatAt = ftyp.length + 8;

  // Absolute file offset of each tile, and of the grid when it is in mdat.
  const at = [];
  let cursor = mdatAt;
  for (const p of payloads) { at.push(cursor); cursor += p.length; }
  const gridAt = cursor;

  const items = [
    ...cells.map(id => ({ id, type: tileType })),
    { id: 5, type: 'grid' },
  ];
  const iinf = full('iinf', 0, 0, u16(items.length),
    ...items.map(it => full('infe', 2, 0, u16(it.id), u16(0), ascii(it.type), u8(0))));

  const iref = full('iref', 0, 0,
    box('dimg', u16(5), u16(cells.length), ...cells.map(u16)));

  const props = [box('hvcC', HVCC), full('ispe', 0, 0, u32(width), u32(height))];
  if (rotate) props.push(box('irot', u8(rotate & 3)));
  if (mirror !== null) props.push(box('imir', u8(mirror & 1)));
  const ipco = box('ipco', ...props);
  // Every tile gets the hvcC and the ispe; the grid gets whatever turns it.
  const assoc = [
    ...cells.map(id => cat(u16(id), u8(2), u8(0x81), u8(2))),
    cat(u16(5), u8(props.length - 2), ...props.slice(2).map((_, i) => u8(3 + i))),
  ];
  const ipma = full('ipma', 0, 0, u32(assoc.length), ...assoc);
  const iprp = box('iprp', ipco, ipma);

  // iloc v1: 4-byte offsets and lengths, no base, no index.
  const entry = (id, method, off, len) =>
    cat(u16(id), u16(method), u16(0), u16(1), u32(off), u32(len));
  const iloc = full('iloc', 1, 0, u8((4 << 4) | 4), u8(0),
    u16(cells.length + 1),
    ...cells.map((id, i) => entry(id, 0, at[i], payloads[i].length + extraTileBytes)),
    gridInIdat ? entry(5, 1, 0, grid.length) : entry(5, 0, gridAt, grid.length));

  const idat = box('idat', grid);
  const meta = full('meta', 0, 0,
    full('hdlr', 0, 0, u32(0), ascii('pict'), u32(0), u32(0), u32(0), u8(0)),
    full('pitm', 0, 0, u16(primary)),
    iinf, iref, iprp, iloc,
    ...(gridInIdat && !dropIdat ? [idat] : []));

  return cat(ftyp, mdat, meta);
}

/** The file every refusal below is one edit away from. */
const whole = () => heic();

// ---------------------------------------------------------------------------
// The brand
// ---------------------------------------------------------------------------

test('a HEIC is recognised by its brand, and other files are not', () => {
  assert.equal(isHeif(whole().subarray(0, 64)), true);
  // The brand can be any of the compatible ones rather than the major one.
  assert.equal(isHeif(heic({ brand: 'msf1' }).subarray(0, 64)), true);
  // A JPEG, a TIFF and an empty head are all not-HEIF rather than a throw.
  assert.equal(isHeif(u8(0xff, 0xd8, 0xff, 0xe0, 0, 16, 0x4a, 0x46, 0x49, 0x46, 0, 1)), false);
  assert.equal(isHeif(u8(0x49, 0x49, 0x2a, 0, 8, 0, 0, 0, 0, 0, 0, 0)), false);
  assert.equal(isHeif(new Uint8Array(0)), false);
});

test('an ftyp with no brand this reads is refused whole', () => {
  // An MP4 is an ftyp box too, which is why the brand list is closed.
  const mp4 = cat(box('ftyp', ascii('isom'), u32(512), ascii('iso2'), ascii('avc1')));
  assert.equal(isHeif(mp4.subarray(0, 64)), false);
  assert.equal(readPlan(mp4), null);
});

// ---------------------------------------------------------------------------
// The whole file
// ---------------------------------------------------------------------------

test('a 2x2 grid is read as four tiles in raster order', () => {
  const plan = readPlan(whole());
  assert.ok(plan, 'the fixture itself should read');
  assert.equal(plan.cols, 2);
  assert.equal(plan.rows, 2);
  assert.equal(plan.width, 96);
  assert.equal(plan.height, 96);
  assert.equal(plan.tiles.length, 4);
  assert.deepEqual(plan.rotate, 0);
  assert.equal(plan.mirror, 'none');
  // The order the dimg reference gave, not the order iloc happened to store.
  for (let i = 0; i < 4; i++) assert.deepEqual([...plan.tiles[i]], [...tile(i + 1)]);
  assert.deepEqual([...plan.hvcC], [...HVCC]);
});

test('a grid descriptor stored in idat is found there', () => {
  // The default fixture already puts it in idat; this pins that the other
  // construction method - an offset into the file at large - reads the same.
  const inFile = readPlan(heic({ gridInIdat: false }));
  assert.ok(inFile);
  assert.equal(inFile.cols, 2);
  assert.equal(inFile.tiles.length, 4);
  assert.deepEqual([...inFile.tiles[3]], [...tile(4)]);
});

test('an idat item with no idat box is refused rather than read from the file', () => {
  // Offset zero into a pool that is not there would otherwise be offset zero
  // into the file, which is the ftyp box.
  assert.ok(readPlan(heic({ gridInIdat: true })));
  assert.equal(readPlan(heic({ gridInIdat: true, dropIdat: true })), null);
});

test('a single hvc1 item needs no grid at all', () => {
  // pitm names a tile instead of the grid: one tile, one cell, its own ispe.
  const plan = readPlan(heic({ primary: 1 }));
  assert.ok(plan);
  assert.equal(plan.cols, 1);
  assert.equal(plan.rows, 1);
  assert.equal(plan.tiles.length, 1);
  assert.deepEqual([...plan.tiles[0]], [...tile(1)]);
  assert.deepEqual([...plan.hvcC], [...HVCC]);
});

test('irot and imir are read off the item that carries them', () => {
  assert.equal(readPlan(whole()).rotate, 0);
  assert.equal(readPlan(heic({ rotate: 1 })).rotate, 1);
  assert.equal(readPlan(heic({ rotate: 3 })).rotate, 3);
  assert.equal(readPlan(heic({ mirror: 0 })).mirror, 'y');
  assert.equal(readPlan(heic({ mirror: 1 })).mirror, 'x');
});

// ---------------------------------------------------------------------------
// The refusals
// ---------------------------------------------------------------------------

test('a tile extent reaching past the end of the file is refused', () => {
  assert.ok(readPlan(heic({ extraTileBytes: 0 })), 'the unedited fixture should read');
  assert.equal(readPlan(heic({ extraTileBytes: 1 << 20 })), null);
});

test('a grid whose dimg does not name every cell is refused', () => {
  assert.ok(readPlan(heic({ cols: 2, rows: 2, cells: [1, 2, 3, 4] })));
  // Three cells for four places: half a picture is not a picture.
  assert.equal(readPlan(heic({ cols: 2, rows: 2, cells: [1, 2, 3] })), null);
});

test('a grid larger than the tile ceiling is refused on its own arithmetic', () => {
  // 256 x 256 cells is a quarter of a million tiles claimed by two bytes.
  assert.equal(readPlan(heic({ cols: 256, rows: 256, cells: [1, 2, 3, 4] })), null);
});

test('a cell that is not an hvc1 item is refused', () => {
  assert.ok(readPlan(heic({ tileType: 'hvc1' })));
  // 'av01' is an AVIF tile - a real item type, and not one this can decode.
  assert.equal(readPlan(heic({ tileType: 'av01' })), null);
});

test('a primary item that is neither a picture nor a grid is refused', () => {
  // Item 5 is the grid; nothing numbered 9 exists, so the fallback picks the
  // first item that could be a picture rather than reading past the table.
  const plan = readPlan(heic({ primary: 9 }));
  assert.ok(plan, 'a missing pitm falls back to the first picture item');
  assert.equal(plan.tiles.length, 1);
});

test('a truncated file is refused rather than read half way', () => {
  const file = whole();
  assert.ok(readPlan(file));
  // Every prefix: none of them may throw, and none may claim a whole picture.
  for (let cut = 8; cut < file.length; cut += 7) {
    const plan = readPlan(file.subarray(0, cut));
    assert.equal(plan, null, `a ${cut}-byte prefix read as a whole picture`);
  }
});

test('a box claiming more than its parent holds ends the walk', () => {
  assert.ok(readPlan(whole()));
  // The meta box is the last one; stretching it past the end of the file must
  // not be believed, and must not throw on the way to not being believed.
  const broken = Uint8Array.from(whole());
  const view = new DataView(broken.buffer, broken.byteOffset, broken.byteLength);
  view.setUint32(findMeta(broken), 1 << 24);
  assert.equal(readPlan(broken), null);
});

/** Where the meta box starts in a fixture - the only offset a test needs. */
function findMeta(file) {
  for (let o = 0; o + 8 <= file.length;) {
    const size = new DataView(file.buffer, file.byteOffset, file.byteLength).getUint32(o);
    if (String.fromCharCode(...file.subarray(o + 4, o + 8)) === 'meta') return o;
    if (size < 8) break;
    o += size;
  }
  throw new Error('the fixture has no meta box');
}

// ---------------------------------------------------------------------------
// The codec name
// ---------------------------------------------------------------------------

test('the codec name is built from the configuration record', () => {
  // The bytes are a Samsung phone's, and the answer is what Chrome accepts for
  // them. The compatibility word prints bit-reversed - 0x60000000 becomes 6 -
  // which is the one step in here that is not a transcription.
  assert.equal(codecName(HVCC), 'hvc1.1.6.L90.b0');
});

test('the high tier, a profile space and a level all reach the name', () => {
  const rec = Uint8Array.from(HVCC);
  rec[1] = (1 << 6) | (1 << 5) | 2;    // space 1 ('A'), high tier, profile 2
  rec[12] = 120;                        // level 4.0
  assert.equal(codecName(rec), 'hvc1.A2.6.H120.b0');
});

test('an all-zero constraint tail is dropped rather than printed', () => {
  const rec = Uint8Array.from(HVCC);
  rec[6] = 0;
  assert.equal(codecName(rec), 'hvc1.1.6.L90');
});
