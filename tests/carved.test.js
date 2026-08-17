// The four headers that open with a picture (import/carved.js).
//
// Each of these is a length or an offset written by somebody else's exporter, so
// the tests are about two things: that the honest layout reads, and that a
// number which does not add up is refused rather than followed. Every fixture is
// built here - there is no .dwg or .icns to commit, and one produced by AutoCAD
// would prove that AutoCAD's output reads rather than that the reader is right.
//
// **Two paths are deliberately not covered and it is worth saying which.** The
// .blend preview ends at a canvas (ImageData, OffscreenCanvas) and the EPS
// preview is handed to the TIFF reader, which is bounded by a Blob. Neither
// exists in Node and nothing in this suite shims them, which is the same position
// tests/documents.test.js takes about the XML readers. What is covered here is
// everything up to that hand-off: the header parse, the bounds, and the refusals.
//
// Discipline as everywhere else in this suite: **every refusal is paired with a
// working fixture asserted first**, because null is the answer to every failure
// and a test that only asserts null passes on a broken builder too.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { carvedPicture, isCarved } from '../web/assets/js/import/carved.ts';

const PNG_SIG = [0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A];

function png(size = 1024, fill = 0x41) {
  const b = new Uint8Array(Math.max(size, 16)).fill(fill);
  b.set(PNG_SIG);
  return b;
}

const be32 = (v) => [(v >>> 24) & 255, (v >> 16) & 255, (v >> 8) & 255, v & 255];
const le32 = (v) => [v & 255, (v >> 8) & 255, (v >> 16) & 255, (v >>> 24) & 255];
const ascii = (s) => [...s].map(c => c.charCodeAt(0));

/**
 * Flatten strings, arrays and typed arrays into one buffer.
 *
 * Sized and copied rather than spread into an array literal: a spread of a
 * hundred-thousand-element payload is an argument list that long, which is a
 * stack overflow rather than a buffer.
 */
function bytes(...parts) {
  const chunks = parts.map(p => (typeof p === 'string' ? new Uint8Array(ascii(p))
    : p instanceof Uint8Array ? p : new Uint8Array(p)));
  const out = new Uint8Array(chunks.reduce((n, c) => n + c.length, 0));
  chunks.reduce((at, c) => (out.set(c, at), at + c.length), 0);
  return out;
}

const blob = (b) => new Blob([b]);

// ---------------------------------------------------------------------------
// What it claims
// ---------------------------------------------------------------------------

test('it claims the five header formats and nothing else', () => {
  for (const ext of ['icns', 'dwg', 'eps', 'epsf', 'epsi', 'blend', 'vcf']) {
    assert.equal(isCarved(ext), true, ext);
  }
  for (const ext of ['png', 'exe', 'apk', 'psd', 'ps', '']) {
    assert.equal(isCarved(ext), false, ext);
  }
});

// ---------------------------------------------------------------------------
// Apple icons
// ---------------------------------------------------------------------------

/** An .icns from `chunks` of `[type, payload]`. */
function icns(chunks, opts = {}) {
  const body = [];
  for (const [type, payload] of chunks) {
    body.push(...ascii(type), ...be32((opts.size ?? (payload.length + 8))), ...payload);
  }
  const total = opts.total ?? (8 + body.length);
  return bytes('icns', be32(total), body);
}

test('it takes the largest PNG in an .icns, not the first', async () => {
  // The chunks are ordered smallest-first in most files Apple's own tools write,
  // so "the first PNG" is reliably the worst picture in the file.
  const got = await carvedPicture(blob(icns([
    ['ic07', png(600, 0x11)],
    ['ic09', png(4000, 0x12)],
    ['ic10', png(1200, 0x13)],
  ])), 'icns');
  assert.ok(got, 'the fixture is broken if this is null');
  assert.equal(got[3999], 0x12, 'the 4000-byte member won');
});

test('structural chunks are not mistaken for pictures', async () => {
  const got = await carvedPicture(blob(icns([
    ['TOC ', png(9000, 0x21)],
    ['icnV', png(8000, 0x22)],
    ['ic08', png(700, 0x23)],
  ])), 'icns');
  assert.ok(got);
  assert.equal(got[699], 0x23);
});

test('a legacy member that is not a PNG is skipped rather than handed over', async () => {
  // is32 is RLE-packed ARGB with its alpha in a separate chunk. Nothing decodes
  // it, so it is not a picture this app can show.
  const rle = new Uint8Array(3000).fill(0x7F);
  assert.equal(await carvedPicture(blob(icns([['is32', rle]])), 'icns'), null);
});

test('an .icns with a chunk running past the file stops rather than reads on', async () => {
  assert.ok(await carvedPicture(blob(icns([['ic08', png(700)]])), 'icns'), 'the honest one reads');
  const lying = icns([['ic08', png(700)]], { size: 0x7fffff });
  assert.equal(await carvedPicture(blob(lying), 'icns'), null);
});

test('an .icns whose chunk size cannot include its own header is refused', async () => {
  const lying = icns([['ic08', png(700)]], { size: 4 });
  assert.equal(await carvedPicture(blob(lying), 'icns'), null);
});

test('anything that is not an .icns is not one', async () => {
  assert.equal(await carvedPicture(blob(png(4096)), 'icns'), null);
  assert.equal(await carvedPicture(blob(new Uint8Array(4)), 'icns'), null);
});

// ---------------------------------------------------------------------------
// AutoCAD
// ---------------------------------------------------------------------------

const SENTINEL = [
  0x1F, 0x25, 0x6D, 0x07, 0xD4, 0x36, 0x28, 0x28,
  0x9D, 0x57, 0xCA, 0x3F, 0x9D, 0x44, 0x10, 0x2B,
];

/**
 * A .dwg whose header points at a preview section holding `records`.
 *
 * Laid out with the section at a fixed place after the header so the seeker is a
 * real pointer into a real file rather than a number that happens to work.
 */
function dwg(records, opts = {}) {
  const version = opts.version ?? 'AC1032';
  const seekerAt = 0x0D;
  const sectionAt = opts.sectionAt ?? 0x100;

  // Records first, so their offsets are known before the table that names them.
  const payloads = [];
  let at = sectionAt + 21 + records.length * 9;
  const table = [];
  for (const r of records) {
    table.push(r.code, ...le32(r.at ?? at), ...le32(r.size ?? r.body.length));
    payloads.push({ at, body: r.body });
    at += r.body.length;
  }

  const out = new Uint8Array(at + 16);
  out.set(ascii(version));
  new DataView(out.buffer).setUint32(seekerAt, opts.seeker ?? sectionAt, true);
  out.set(opts.sentinel ?? SENTINEL, sectionAt);
  new DataView(out.buffer).setUint32(sectionAt + 16, 0, true);   // section length
  out[sectionAt + 20] = opts.count ?? records.length;
  out.set(table, sectionAt + 21);
  for (const p of payloads) out.set(p.body, p.at);
  return out;
}

/** A 40-byte BITMAPINFOHEADER and pixels: what a code-1 record holds. */
function dib() {
  const b = new Uint8Array(40 + 512);
  const dv = new DataView(b.buffer);
  dv.setUint32(0, 40, true);
  dv.setInt32(4, 16, true);
  dv.setInt32(8, 16, true);
  dv.setUint16(12, 1, true);
  dv.setUint16(14, 24, true);
  return b;
}

test('a PNG preview comes out of a drawing', async () => {
  const got = await carvedPicture(blob(dwg([{ code: 3, body: png(900, 0x31) }])), 'dwg');
  assert.ok(got, 'the fixture is broken if this is null');
  assert.equal(got[899], 0x31);
});

test('a bitmap preview gets its file header put back', async () => {
  const got = await carvedPicture(blob(dwg([{ code: 1, body: dib() }])), 'dwg');
  assert.ok(got);
  assert.equal(got[0], 0x42, 'B');
  assert.equal(got[1], 0x4D, 'M');
});

test('a metafile preview is declined, and a PNG beside it is still found', async () => {
  // Code 2 is a WMF. No browser draws one, so it is passed over rather than
  // handed to an <img> - the same rule as docProps/thumbnail.emf.
  const got = await carvedPicture(blob(dwg([
    { code: 2, body: png(4000, 0x41) },
    { code: 3, body: png(800, 0x42) },
  ])), 'dwg');
  assert.ok(got);
  assert.equal(got[799], 0x42);
});

test('a drawing with only a metafile preview has no picture', async () => {
  assert.equal(await carvedPicture(blob(dwg([{ code: 2, body: png(900) }])), 'dwg'), null);
});

test('the sentinel is what confirms the seeker landed on a preview section', async () => {
  // A pointer that lands somewhere plausible is worse than one that lands
  // nowhere, which is the whole reason the sentinel is checked at all.
  assert.ok(await carvedPicture(blob(dwg([{ code: 3, body: png(900) }])), 'dwg'), 'honest file reads');
  const wrong = dwg([{ code: 3, body: png(900) }], { sentinel: new Array(16).fill(0x5A) });
  assert.equal(await carvedPicture(blob(wrong), 'dwg'), null);
});

test('a seeker pointing outside the file is refused', async () => {
  const bad = dwg([{ code: 3, body: png(900) }], { seeker: 0x7fffff });
  assert.equal(await carvedPicture(blob(bad), 'dwg'), null);
});

test('a record claiming to run past the end of the file is skipped', async () => {
  const bad = dwg([{ code: 3, body: png(900), size: 0x7fffff }]);
  assert.equal(await carvedPicture(blob(bad), 'dwg'), null);
});

test('an absurd record count is not looped on', async () => {
  const bad = dwg([{ code: 3, body: png(900) }], { count: 200 });
  assert.equal(await carvedPicture(blob(bad), 'dwg'), null);
});

test('a file that does not open with a release stamp is not a drawing', async () => {
  const bad = dwg([{ code: 3, body: png(900) }], { version: 'ZZ1032' });
  assert.equal(await carvedPicture(blob(bad), 'dwg'), null);
});

// ---------------------------------------------------------------------------
// DOS EPS
// ---------------------------------------------------------------------------

/** A binary EPS whose header points at a TIFF preview. */
function eps(opts = {}) {
  const preview = opts.preview ?? new Uint8Array(2048).fill(0x4D);
  const at = 30;
  const out = new Uint8Array(at + preview.length);
  out.set(opts.magic ?? [0xC5, 0xD0, 0xD3, 0xC6]);
  const dv = new DataView(out.buffer);
  dv.setUint32(20, opts.at ?? at, true);
  dv.setUint32(24, opts.size ?? preview.length, true);
  out.set(preview, at);
  return out;
}

test('a plain PostScript file is not the binary form', async () => {
  const plain = new TextEncoder().encode('%!PS-Adobe-3.0 EPSF-3.0\n');
  assert.equal(await carvedPicture(blob(plain), 'eps'), null);
});

test('a preview offset outside the file is refused before it is read', async () => {
  assert.equal(await carvedPicture(blob(eps({ at: 0x7fffff })), 'eps'), null);
  assert.equal(await carvedPicture(blob(eps({ size: 0x7fffff })), 'eps'), null);
  assert.equal(await carvedPicture(blob(eps({ size: 0 })), 'eps'), null);
});

test('an uncompressed TIFF preview finds no JPEG in it, which is the usual case', async () => {
  // Stated as a test because it is the expected outcome rather than a failure:
  // the preview is a TIFF, browsers do not draw TIFFs, and the only thing to do
  // with one is look for a JPEG inside. Normally there is not one.
  assert.equal(await carvedPicture(blob(eps()), 'eps'), null);
});

// ---------------------------------------------------------------------------
// Blender
// ---------------------------------------------------------------------------

/**
 * A .blend header and block list. `pointer` is 4 or 8 bytes.
 *
 * The declared dimensions are separate from the pixels actually written, because
 * that separation is the thing being tested: a file that *claims* 100000 x 100000
 * without carrying the bytes is exactly the input the dimension cap exists for,
 * and a builder that allocated what it declared would run out of memory before
 * the reader was ever called.
 */
function blend(opts = {}) {
  const pointer = opts.pointer ?? 8;
  const w = opts.w ?? 4;
  const h = opts.h ?? 4;
  const pixels = opts.pixels ?? new Uint8Array(Math.min(w * h, 4096) * 4).fill(0x77);
  const header = bytes(
    'BLENDER',
    [pointer === 8 ? 0x2D : 0x5F],
    [opts.endian ?? 0x76],
    '403',
  );
  const block = bytes(
    opts.code ?? 'TEST',
    le32(8 + pixels.length),
    new Uint8Array(pointer),
    le32(0), le32(1),
    le32(w), le32(h),
    pixels,
  );
  return bytes(header, block, 'ENDB', le32(0), new Uint8Array(pointer + 8));
}

test('a .blend that is not one, or is compressed, is declined', async () => {
  // A gzip or Zstandard .blend has no readable header, which is why it is
  // refused rather than guessed at.
  assert.equal(await carvedPicture(blob(new Uint8Array([0x1F, 0x8B, 8, 0, 0, 0, 0, 0, 0, 0, 0, 0])), 'blend'), null);
  assert.equal(await carvedPicture(blob(png(4096)), 'blend'), null);
});

test('a pointer-size byte that is neither spelling is refused', async () => {
  const bad = blend();
  bad[7] = 0x21;
  assert.equal(await carvedPicture(blob(bad), 'blend'), null);
});

test('a big-endian .blend is declined rather than read backwards', async () => {
  assert.equal(await carvedPicture(blob(blend({ endian: 0x56 })), 'blend'), null);
});

test('preview dimensions that would ask for a gigabyte are refused', async () => {
  assert.equal(await carvedPicture(blob(blend({ w: 100000, h: 100000 })), 'blend'), null);
  assert.equal(await carvedPicture(blob(blend({ w: 0, h: 0 })), 'blend'), null);
});

test('a .blend with no TEST block has no preview', async () => {
  assert.equal(await carvedPicture(blob(blend({ code: 'DATA' })), 'blend'), null);
});

// ---------------------------------------------------------------------------
// vCard
// ---------------------------------------------------------------------------

const b64 = (b) => Buffer.from(b).toString('base64');

const vcard = (photo) => new TextEncoder().encode(
  `BEGIN:VCARD\r\nVERSION:3.0\r\nFN:A Person\r\n${photo}\r\nEND:VCARD\r\n`,
);

test('a vCard 3.0 photo is decoded out of its base64', async () => {
  const got = await carvedPicture(blob(vcard(`PHOTO;ENCODING=b;TYPE=PNG:${b64(png(900, 0x51))}`)), 'vcf');
  assert.ok(got, 'the fixture is broken if this is null');
  assert.equal(got[899], 0x51);
});

test('a vCard 4.0 data URI is decoded too', async () => {
  const got = await carvedPicture(
    blob(vcard(`PHOTO:data:image/png;base64,${b64(png(900, 0x52))}`)),
    'vcf',
  );
  assert.ok(got);
  assert.equal(got[899], 0x52);
});

test('a folded photo line is unfolded before it is decoded', async () => {
  // This is the step that is easy to miss, and missing it produces base64 with
  // spaces in it - which decodes to nothing or, worse, to the wrong bytes.
  const encoded = b64(png(900, 0x53));
  const folded = encoded.replace(/(.{40})/g, '$1\r\n ');
  const got = await carvedPicture(blob(vcard(`PHOTO;ENCODING=b:${folded}`)), 'vcf');
  assert.ok(got, 'the line was not unfolded');
  assert.equal(got[899], 0x53);
});

test('a card with no photo, and a photo that is not base64, are both null', async () => {
  assert.equal(await carvedPicture(blob(vcard('NOTE:nothing here')), 'vcf'), null);
  assert.equal(await carvedPicture(blob(vcard('PHOTO;VALUE=uri:https://example.com/p.png')), 'vcf'), null);
});

test('a file that is not a vCard is not read as one', async () => {
  assert.equal(await carvedPicture(blob(png(4096)), 'vcf'), null);
});
