// The icon walk through a Windows program (import/pe.ts), and the two
// headers that make a headerless picture drawable (import/winimage.ts).
// Arithmetic over a structure somebody else wrote, with no fixture to
// check against - a real .exe would only prove one linker's output reads.
// So the whole file builds PE containers byte by byte.
//
// The discipline is preview.test.js's: every "it refuses X" case is
// paired with a working fixture asserted first, since null is the answer
// to every failure here and a null-only test passes on a broken fixture too.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { exeIcon, isExecutable } from '../web/assets/js/import/pe.ts';
import { wrapAsIco, dibToBmp, isCgBI, isDrawablePng } from '../web/assets/js/import/winimage.ts';
import { isOversize } from '../web/assets/js/consent.ts';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const PNG_SIG = [0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A];

/** A byte run that sniffs as a PNG. Four honest bytes exercise the same path. */
function png(extra = 64) {
  const b = new Uint8Array(8 + extra);
  b.set(PNG_SIG);
  b.set([0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52], 8);   // length + 'IHDR'
  return b;
}

/** The same, marked the way Xcode marks one. */
function cgbiPng(extra = 64) {
  const b = png(extra);
  b.set([0x43, 0x67, 0x42, 0x49], 12);               // 'CgBI' where 'IHDR' was
  return b;
}

/** A 32-bit DIB with no palette: 40-byte header, then pixels. */
function dib(w = 32, h = 32, bits = 32, clrUsed = 0) {
  const rows = bits <= 8 ? (clrUsed || (1 << bits)) : 0;
  const pixels = 64;
  const b = new Uint8Array(40 + rows * 4 + pixels);
  const dv = new DataView(b.buffer);
  dv.setUint32(0, 40, true);
  dv.setInt32(4, w, true);
  dv.setInt32(8, h * 2, true);                       // doubled: image over AND mask
  dv.setUint16(12, 1, true);
  dv.setUint16(14, bits, true);
  dv.setUint32(32, clrUsed, true);
  return b;
}

const u32 = (v) => [v & 255, (v >> 8) & 255, (v >> 16) & 255, (v >>> 24) & 255];
const u16 = (v) => [v & 255, (v >> 8) & 255];

/**
 * A resource directory: `entries` of `{ id, off, dir }`, where `off` is
 * already relative to the section and `dir` says whether the high bit is set.
 */
function resDir(entries) {
  const out = [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, ...u16(0), ...u16(entries.length)];
  for (const e of entries) {
    out.push(...u32(e.id), ...u32(e.dir ? (e.off | 0x80000000) >>> 0 : e.off));
  }
  return out;
}

/** IMAGE_RESOURCE_DATA_ENTRY. `rva` is an image address, not a section offset. */
const resLeaf = (rva, size) => [...u32(rva), ...u32(size), ...u32(0), ...u32(0)];

/** A GRPICONDIR naming `members` of `{ w, h, bits, id, bytes }`. */
function grpIconDir(members) {
  const out = [0, 0, ...u16(1), ...u16(members.length)];
  for (const m of members) {
    out.push(
      m.w >= 256 ? 0 : m.w, m.h >= 256 ? 0 : m.h, 0, 0,
      ...u16(1), ...u16(m.bits ?? 32),
      ...u32(m.bytes.length), ...u16(m.id),
    );
  }
  return out;
}

const RSRC_RVA = 0x4000;

/**
 * A PE file whose `.rsrc` section holds one icon group over `members`.
 * Laid out in one pass so every offset in the tree is a real position:
 * directory levels first, then leaves, then payloads. `opts` is how a
 * test moves one field without rebuilding the file.
 */
function pe(members, opts = {}) {
  const groups = opts.groups || [{ id: 1, members }];
  const all = groups.flatMap(g => g.members);

  // Lay the section out back to front: payloads last, so their offsets
  // are known before anything pointing at them is written.
  const parts = [];
  let at = 0;
  const push = (bytes) => { const off = at; parts.push({ off, bytes }); at += bytes.length; return off; };
  const reserve = (n) => { const off = at; at += n; return off; };

  const rootAt = reserve(16 + 8 * 2);
  const iconTypeAt = reserve(16 + 8 * all.length);
  const groupTypeAt = reserve(16 + 8 * groups.length);
  const iconNameAt = all.map(() => reserve(16 + 8));
  const groupNameAt = groups.map(() => reserve(16 + 8));
  const iconLeafAt = all.map(() => reserve(16));
  const groupLeafAt = groups.map(() => reserve(16));

  const grpBytes = groups.map(g => new Uint8Array(grpIconDir(g.members)));
  const iconPayloadAt = all.map(m => push(m.bytes));
  const groupPayloadAt = grpBytes.map(b => push(b));

  const section = new Uint8Array(at);
  const put = (off, bytes) => section.set(bytes, off);

  put(rootAt, new Uint8Array(resDir([
    { id: opts.iconType ?? 3, off: iconTypeAt, dir: true },
    { id: 14, off: groupTypeAt, dir: true },
  ])));
  put(iconTypeAt, new Uint8Array(resDir(
    all.map((m, i) => ({ id: m.id, off: iconNameAt[i], dir: true })),
  )));
  put(groupTypeAt, new Uint8Array(resDir(
    groups.map((g, i) => ({ id: g.id, off: groupNameAt[i], dir: true })),
  )));
  all.forEach((_, i) => put(iconNameAt[i], new Uint8Array(resDir([
    { id: 1033, off: iconLeafAt[i], dir: false },
  ]))));
  groups.forEach((_, i) => put(groupNameAt[i], new Uint8Array(resDir([
    { id: 1033, off: groupLeafAt[i], dir: false },
  ]))));
  all.forEach((m, i) => put(iconLeafAt[i],
    new Uint8Array(resLeaf(RSRC_RVA + iconPayloadAt[i], m.bytes.length))));
  groups.forEach((_, i) => put(groupLeafAt[i],
    new Uint8Array(resLeaf(RSRC_RVA + groupPayloadAt[i], grpBytes[i].length))));
  for (const p of parts) put(p.off, p.bytes);

  return wrapPe(section, opts);
}

/** The headers around a prepared `.rsrc` section. */
function wrapPe(section, opts = {}) {
  const peAt = 0x80;
  const optAt = peAt + 24;
  // PE32+ widens five fields to 64 bits, moving the data directory 16
  // bytes and its preceding count with them. `plus` builds the real
  // thing rather than moving the magic on a PE32 body, so the branch is
  // exercised by a file actually shaped that way.
  const plus = !!opts.plus;
  const dirOff = plus ? 112 : 96;
  const optSize = dirOff + 16 * 8;
  const tableAt = optAt + optSize;
  const rawAt = 0x400;

  const file = new Uint8Array(rawAt + section.length);
  const dv = new DataView(file.buffer);
  file[0] = 0x4D; file[1] = 0x5A;             // 'MZ'
  dv.setUint32(0x3C, opts.peAt ?? peAt, true);

  file.set([0x50, 0x45, 0, 0], peAt);         // 'PE\0\0'
  dv.setUint16(peAt + 6, 1, true);            // one section
  dv.setUint16(peAt + 20, optSize, true);
  dv.setUint16(optAt, opts.magic ?? (plus ? 0x20B : 0x10B), true);
  dv.setUint32(optAt + dirOff - 4, opts.dirCount ?? 16, true);
  dv.setUint32(optAt + dirOff + 16, opts.rsrcRva ?? RSRC_RVA, true);
  dv.setUint32(optAt + dirOff + 20, opts.rsrcSize ?? section.length, true);

  file.set([0x2E, 0x72, 0x73, 0x72, 0x63], tableAt);     // '.rsrc'
  dv.setUint32(tableAt + 8, section.length, true);       // virtual size
  dv.setUint32(tableAt + 12, RSRC_RVA, true);            // virtual address
  dv.setUint32(tableAt + 16, section.length, true);      // raw size
  dv.setUint32(tableAt + 20, rawAt, true);               // raw pointer
  file.set(section, rawAt);
  return new Blob([file]);
}

// ---------------------------------------------------------------------------
// Which files it claims
// ---------------------------------------------------------------------------

test('it claims the PE container extensions and nothing else', () => {
  for (const ext of ['exe', 'dll', 'scr', 'cpl', 'ocx', 'mun']) {
    assert.equal(isExecutable(ext), true, ext);
  }
  for (const ext of ['apk', 'zip', 'png', 'elf', 'app', '']) {
    assert.equal(isExecutable(ext), false, ext);
  }
});

// ---------------------------------------------------------------------------
// The happy paths, asserted before anything asserts a refusal
// ---------------------------------------------------------------------------

test('it pulls a PNG member out of an icon group', async () => {
  const got = await exeIcon(pe([{ w: 256, h: 256, id: 7, bytes: png(512) }]));
  assert.ok(got, 'the fixture itself is broken if this is null');
  assert.equal(got.ext, 'png');
  const bytes = new Uint8Array(await got.blob.arrayBuffer());
  assert.deepEqual([...bytes.subarray(0, 8)], PNG_SIG);
  assert.equal(bytes.length, 520, 'the member is handed back whole and unwrapped');
});

test('a bitmap member comes back wrapped as a one-image .ico', async () => {
  const body = dib(32, 32);
  const got = await exeIcon(pe([{ w: 32, h: 32, bits: 32, id: 3, bytes: body }]));
  assert.ok(got);
  assert.equal(got.ext, 'ico');
  const b = new Uint8Array(await got.blob.arrayBuffer());
  assert.deepEqual([...b.subarray(0, 6)], [0, 0, 1, 0, 1, 0], 'ICONDIR: type 1, one member');
  assert.equal(b[6], 32, 'width from the group record');
  assert.equal(b[7], 32, 'height from the group record, not the doubled one in the DIB');
  const dv = new DataView(b.buffer);
  assert.equal(dv.getUint32(14, true), body.length, 'declared payload length');
  assert.equal(dv.getUint32(18, true), 22, 'payload sits right after the 22-byte head');
  assert.deepEqual([...b.subarray(22, 22 + body.length)], [...body], 'payload copied verbatim');
});

test('a PNG member wins over a physically larger bitmap', async () => {
  // Ranking on pixels alone would take the 256px DIB. The PNG is the one
  // every engine decodes, the whole reason for the preference.
  const got = await exeIcon(pe([
    { w: 256, h: 256, bits: 32, id: 1, bytes: dib(256, 256) },
    { w: 64, h: 64, bits: 32, id: 2, bytes: png(128) },
  ]));
  assert.ok(got);
  assert.equal(got.ext, 'png');
});

test('a PNG too small to be worth it loses to the bitmap', async () => {
  const got = await exeIcon(pe([
    { w: 128, h: 128, bits: 32, id: 1, bytes: dib(128, 128) },
    { w: 16, h: 16, bits: 32, id: 2, bytes: png(16) },
  ]));
  assert.ok(got);
  assert.equal(got.ext, 'ico', 'a 16px PNG is not the program icon');
});

test('the lowest-numbered group wins, not the first one in the tree', async () => {
  // Tree order here puts group 9 first; Windows takes the lowest id as
  // the application icon, and so does this.
  const got = await exeIcon(pe([], {
    groups: [
      { id: 9, members: [{ w: 64, h: 64, bits: 32, id: 1, bytes: dib(64, 64) }] },
      { id: 2, members: [{ w: 64, h: 64, id: 2, bytes: png(200) }] },
    ],
  }));
  assert.ok(got);
  assert.equal(got.ext, 'png', 'group 2 is the program icon');
});

test('a 256-pixel edge is written as 0, which is what the format means', async () => {
  const got = await exeIcon(pe([{ w: 256, h: 256, bits: 32, id: 1, bytes: dib(256, 256) }]));
  assert.ok(got);
  const b = new Uint8Array(await got.blob.arrayBuffer());
  assert.equal(b[6], 0);
  assert.equal(b[7], 0);
});

test('a 64-bit PE reads, and its data directory is not where a 32-bit one is', async () => {
  // The directory moves 16 bytes when the optional header widens, and
  // reading the wrong one lands inside a different field instead of
  // failing outright.
  const bits32 = await exeIcon(pe([{ w: 64, h: 64, id: 1, bytes: png(96) }]));
  assert.ok(bits32, 'PE32 works, so the PE32+ result below means something');

  const bits64 = await exeIcon(pe([{ w: 64, h: 64, id: 1, bytes: png(96) }], { plus: true }));
  assert.ok(bits64, 'a real PE32+ file reads');
  assert.equal(bits64.ext, 'png');

  // A PE32 body wearing the 64-bit magic lies about its own shape and
  // must not read - confirming the two offsets are really different.
  assert.equal(
    await exeIcon(pe([{ w: 64, h: 64, id: 1, bytes: png(96) }], { magic: 0x20B })),
    null,
  );
});

// ---------------------------------------------------------------------------
// Refusals
// ---------------------------------------------------------------------------

test('a file that is not a PE is not an icon', async () => {
  assert.equal(await exeIcon(new Blob([new Uint8Array(4096)])), null);
  assert.equal(await exeIcon(new Blob([png(2048)])), null);
  assert.equal(await exeIcon(new Blob([])), null);
});

test('a resource tree with no icons at all comes back null', async () => {
  assert.equal(await exeIcon(pe([{ w: 64, h: 64, id: 1, bytes: png(64) }], { iconType: 5 })), null);
});

test('a lying optional-header magic is refused rather than mis-read', async () => {
  assert.equal(await exeIcon(pe([{ w: 64, h: 64, id: 1, bytes: png(64) }], { magic: 0x999 })), null);
});

test('a file with fewer data directories than the resource one is not resourceful', async () => {
  assert.equal(await exeIcon(pe([{ w: 64, h: 64, id: 1, bytes: png(64) }], { dirCount: 2 })), null);
});

test('an e_lfanew pointing past the file is refused', async () => {
  assert.equal(await exeIcon(pe([{ w: 64, h: 64, id: 1, bytes: png(64) }], { peAt: 0x7fffff })), null);
});

test('a resource RVA in no section finds nothing', async () => {
  assert.equal(await exeIcon(pe([{ w: 64, h: 64, id: 1, bytes: png(64) }], { rsrcRva: 0x900000 })), null);
});

test('a resource section past the ceiling is asked about, not refused', async () => {
  // The contract in consent.ts: no ceiling refuses on its own. A program
  // with enormous resources may hold a perfectly good icon, and spending
  // the memory to find out is the person's call, not this module's.
  const big = pe([{ w: 64, h: 64, id: 1, bytes: png(64) }], { rsrcSize: 64 * 1024 * 1024 });
  await assert.rejects(() => exeIcon(big), isOversize, 'it must throw an Oversize, not answer null');
  // Lifted, it reads - confirming the throw was the ceiling talking, not
  // a broken file.
  assert.ok(await exeIcon(big, true));
});

test('every truncation of a working file is refused, none of them throw', async () => {
  const whole = new Uint8Array(
    await pe([{ w: 64, h: 64, id: 1, bytes: png(96) }]).arrayBuffer(),
  );
  assert.ok(await exeIcon(new Blob([whole])), 'the whole file reads');
  for (const at of [4, 0x40, 0x82, 0x100, 0x300, 0x401, whole.length - 8]) {
    assert.equal(await exeIcon(new Blob([whole.subarray(0, at)])), null, `cut at ${at}`);
  }
});

test('a directory whose entries all point back at itself ends quickly, and is not a ceiling', async () => {
  // The crafted file from the 2026-09-23 hunt: one directory of N RT_ICON
  // subdirectory entries, every one at offset 0 - the directory itself. The
  // two-level walk under each member read N x N entries: N³ in all, 15 s at
  // N = 1024 and about 15 minutes at 4096. It is a loop, so the answer is
  // null (a plain Error inside), never an Oversize that `lift` could pass.
  const n = 4096;
  const section = new Uint8Array(resDir(Array.from({ length: n }, () => ({ id: 3, off: 0, dir: true }))));
  const file = wrapPe(section);
  const t0 = performance.now();
  assert.equal(await exeIcon(file), null);
  assert.equal(await exeIcon(file, true), null, 'lifted, it is still a loop');
  assert.ok(performance.now() - t0 < 2000, 'the tree walk did not stop');
});

// ---------------------------------------------------------------------------
// The two headers, on their own
// ---------------------------------------------------------------------------

test('wrapAsIco hands a PNG straight back rather than wrapping it', () => {
  const p = png(32);
  assert.equal(wrapAsIco(p, 256, 256), p);
});

test('wrapAsIco refuses nothing at all', () => {
  assert.equal(wrapAsIco(new Uint8Array(0), 32, 32), null);
});

test('dibToBmp puts the pixels where the header says they are', () => {
  const body = dib(32, 32, 32);
  const bmp = dibToBmp(body);
  assert.ok(bmp);
  assert.equal(bmp[0], 0x42);
  assert.equal(bmp[1], 0x4D);
  const dv = new DataView(bmp.buffer);
  assert.equal(dv.getUint32(2, true), bmp.length);
  assert.equal(dv.getUint32(10, true), 54, 'no palette above 8 bits: 14 + 40');
});

test('dibToBmp counts the palette, which is where the pixels actually start', () => {
  // Guards a file header whose offset lands inside the colour table: the
  // picture then draws out of its own palette and looks like static.
  const dv8 = dibToBmp(dib(8, 8, 8, 16));
  assert.ok(dv8);
  assert.equal(new DataView(dv8.buffer).getUint32(10, true), 14 + 40 + 16 * 4);
  // clrUsed of 0 at 8 bits means the full 256 entries, not none.
  const full = dibToBmp(dib(8, 8, 8, 0));
  assert.ok(full);
  assert.equal(new DataView(full.buffer).getUint32(10, true), 14 + 40 + 256 * 4);
});

test('dibToBmp steps over the colour masks that follow a 40-byte header', () => {
  // BI_BITFIELDS puts three DWORD masks between the header and the pixels,
  // BI_ALPHABITFIELDS four. Left out, the picture is drawn 12 or 16 bytes
  // early and every row is shifted.
  const at = (compression, size = 40) => {
    const body = dib(8, 8, 32);
    const dv = new DataView(body.buffer);
    dv.setUint32(0, size, true);
    dv.setUint32(16, compression, true);
    const bmp = dibToBmp(body);
    assert.ok(bmp);
    return new DataView(bmp.buffer).getUint32(10, true);
  };
  assert.equal(at(0), 14 + 40, 'BI_RGB has no masks');
  assert.equal(at(3), 14 + 40 + 12);
  assert.equal(at(6), 14 + 40 + 16);
  // A V4 header holds its masks inside its own 108 bytes.
  const v4 = new Uint8Array(108 + 64);
  v4.set(dib(8, 8, 32).subarray(0, 40));
  const dv = new DataView(v4.buffer);
  dv.setUint32(0, 108, true);
  dv.setUint32(16, 3, true);
  assert.equal(new DataView(dibToBmp(v4).buffer).getUint32(10, true), 14 + 108);
});

test('dibToBmp declines the headers whose fields are somewhere else', () => {
  const os2 = dib(8, 8, 24);
  new DataView(os2.buffer).setUint32(0, 12, true);      // BITMAPCOREHEADER
  assert.equal(dibToBmp(os2), null);
  const nonsense = dib(8, 8, 24);
  new DataView(nonsense.buffer).setUint32(0, 0x7fffffff, true);
  assert.equal(dibToBmp(nonsense), null);
  assert.equal(dibToBmp(new Uint8Array(8)), null);
});

test('dibToBmp declines a bit depth that is not one of the six', () => {
  const odd = dib(8, 8, 24);
  new DataView(odd.buffer).setUint16(14, 7, true);
  assert.equal(dibToBmp(odd), null);
});

test('an Apple-optimised PNG is spotted and is not called drawable', () => {
  assert.equal(isDrawablePng(png(32)), true, 'an ordinary PNG is drawable');
  assert.equal(isCgBI(png(32)), false);
  assert.equal(isCgBI(cgbiPng(32)), true);
  assert.equal(isDrawablePng(cgbiPng(32)), false);
});
