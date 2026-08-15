// The ZIP container - the whole storage substrate, since a .mbrd is a ZIP.
//
// Two halves. The round-trip tests say the writer and reader agree, which is
// the thing a board depends on. The rest feed the reader damaged and hostile
// archives, because a .mbrd arrives from outside - emailed, downloaded, handed
// over on a stick - and every offset in it is a number this app is about to
// index memory by.
//
// Malformed cases are built by writing a good archive and then corrupting one
// field, rather than by hand-assembling bytes. That keeps each test about the
// single thing it changed, and it keeps them honest: if the writer's layout
// moves, these move with it instead of silently testing a format nobody emits.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { writeZip, readZip, crc32 } from '../web/assets/js/storage/zip.ts';
import { bytes, zeros } from './helpers.js';

const enc = new TextEncoder();
const dec = new TextDecoder();

const buf = async (entries, opts) =>
  new Uint8Array(await (await writeZip(entries, opts)).arrayBuffer());

/** Little-endian writes, for reaching into a built archive and breaking it. */
const put32 = (b, off, v) => new DataView(b.buffer).setUint32(off, v, true);
const put16 = (b, off, v) => new DataView(b.buffer).setUint16(off, v, true);

/** Offset of the EOCD record, found the way the reader finds it. */
function eocdAt(b) {
  const view = new DataView(b.buffer);
  for (let i = b.length - 22; i >= 0; i--) if (view.getUint32(i, true) === 0x06054b50) return i;
  throw new Error('no EOCD in test fixture');
}

/** Offset of the first central-directory record. */
const cdAt = b => new DataView(b.buffer).getUint32(eocdAt(b) + 16, true);

// ---------------------------------------------------------------------------
// Round trip
// ---------------------------------------------------------------------------

test('round-trips a stored entry', async () => {
  const data = bytes(1000);
  const files = await readZip(await buf([{ name: 'a.bin', data, compress: false }]));
  assert.deepEqual([...files.keys()], ['a.bin']);
  assert.deepEqual(files.get('a.bin'), data);
});

test('round-trips a deflated entry', async () => {
  // Long and repetitive, so the writer actually takes the compressed form:
  // it only does so when deflating wins, and only above 256 bytes.
  const data = enc.encode('the same sentence over and over. '.repeat(200));
  const archive = await buf([{ name: 'board.json', data, compress: true }]);
  assert.ok(archive.length < data.length, 'fixture did not actually compress');
  const files = await readZip(archive);
  assert.deepEqual(files.get('board.json'), data);
});

test('round-trips many entries, preserving names and order', async () => {
  const names = ['manifest.json', 'board.json', 'assets/abc.png', 'notes/a--i1.md'];
  const archive = await buf(names.map((name, i) => ({ name, data: bytes(300 + i, i + 1), compress: i % 2 === 0 })));
  const files = await readZip(archive);
  assert.deepEqual([...files.keys()], names);
});

test('round-trips UTF-8 names and content', async () => {
  const name = 'notes/ćirilica-и-ćevapi--i9.md';
  const data = enc.encode('# Ćevapi\n\nБеоград, 15 ком.\n');
  const files = await readZip(await buf([{ name, data, compress: true }]));
  assert.equal(dec.decode(files.get(name)), dec.decode(data));
});

test('skips directory entries', async () => {
  const files = await readZip(await buf([
    { name: 'assets/', data: new Uint8Array(0) },
    { name: 'assets/a.png', data: bytes(50) },
  ]));
  assert.deepEqual([...files.keys()], ['assets/a.png']);
});

test('an empty entry survives the trip', async () => {
  const files = await readZip(await buf([{ name: 'empty', data: new Uint8Array(0) }]));
  assert.equal(files.get('empty').length, 0);
});

test('incompressible data is stored, not deflated', async () => {
  // Random bytes deflate to *more* than they started as; the writer is
  // supposed to notice and keep the original.
  const data = bytes(4096, 99);
  const files = await readZip(await buf([{ name: 'noise', data, compress: true }]));
  assert.deepEqual(files.get('noise'), data);
});

// ---------------------------------------------------------------------------
// Malformed and hostile archives
// ---------------------------------------------------------------------------

/**
 * Refused, and refused by the guard we meant.
 *
 * This was `assert.rejects(promise, /.+/)` - satisfied by any error at all with
 * a non-empty message. Thirteen of the fifteen archives below routed through it,
 * so a TypeError out of a half-broken reader read as "rejects a CRC mismatch"
 * and "rejects a decompression bomb" identically to the guard firing. Every
 * caller now names the sentence its fixture is supposed to earn, which is also
 * the only way the file records *which* of the twenty-odd refusals in zip.ts
 * each fixture is here to exercise.
 */
const rejects = (promise, message, why) => assert.rejects(promise, message, why);

test('rejects something that is not a ZIP at all', async () => {
  await rejects(readZip(enc.encode('this is a text file, not a board')),
    /no end-of-central-directory record/);
});

test('rejects an archive too short to hold a directory', async () => {
  await rejects(readZip(new Uint8Array(8)), /too short to hold a directory/);
});

test('rejects a truncated archive', async () => {
  // Keep the directory, lose the payload it points at - which the old fixture
  // said it did and did not do. It sliced at `cdAt(archive) - 500`, taking the
  // central directory and the EOCD with it, so it landed on the same "no
  // end-of-central-directory record" branch as the two tests above and left
  // zip.ts's truncation guard - the one thing between a hostile .mbrd and an
  // out-of-range read - covered only by the forged-csize fixture below.
  //
  // So: splice 500 bytes out of the payload and pull the trailer up to meet it.
  // The directory survives intact and still declares 2000 bytes of entry data
  // that are no longer in the file.
  const archive = await buf([{ name: 'a.bin', data: bytes(2000), compress: false }]);
  const cd = cdAt(archive);
  const CUT = 500;
  const cut = new Uint8Array(archive.length - CUT);
  cut.set(archive.subarray(0, cd - CUT), 0);
  cut.set(archive.subarray(cd), cd - CUT);
  put32(cut, eocdAt(cut) + 16, cd - CUT);
  await rejects(readZip(cut), /the data for "a\.bin" points past the end of the file/);
});

test('rejects a central directory pointing outside the file', async () => {
  const archive = await buf([{ name: 'a.bin', data: bytes(500) }]);
  put32(archive, eocdAt(archive) + 16, 0xfffff0);
  await rejects(readZip(archive), /central directory/);
});

test('rejects a local-header offset pointing outside the file', async () => {
  const archive = await buf([{ name: 'a.bin', data: bytes(500) }]);
  put32(archive, cdAt(archive) + 42, 0xfffff0);
  await rejects(readZip(archive), /the header for "a\.bin" points past the end of the file/);
});

test('rejects an entry whose data runs past the end', async () => {
  const archive = await buf([{ name: 'a.bin', data: bytes(500), compress: false }]);
  put32(archive, cdAt(archive) + 20, 0xffff);      // csize
  put32(archive, cdAt(archive) + 24, 0xffff);      // usize, kept equal for STORE
  await rejects(readZip(archive), /the data for "a\.bin" points past the end of the file/);
});

test('rejects a stored entry whose two sizes disagree', async () => {
  const archive = await buf([{ name: 'a.bin', data: bytes(500), compress: false }]);
  put32(archive, cdAt(archive) + 24, 400);         // usize != csize
  await rejects(readZip(archive), /stored, but its two sizes disagree/);
});

test('rejects a CRC mismatch', async () => {
  const archive = await buf([{ name: 'a.bin', data: bytes(500), compress: false }]);
  put32(archive, cdAt(archive) + 16, 0xdeadbeef);
  await rejects(readZip(archive), /damaged \(checksum mismatch\)/,
    'a damaged photo must not open silently');
});

test('rejects a deflated entry that inflates to the wrong size', async () => {
  const data = enc.encode('x'.repeat(4000));
  const archive = await buf([{ name: 'a.txt', data, compress: true }]);
  put32(archive, cdAt(archive) + 24, 3999);        // declared usize is now a lie
  await rejects(readZip(archive), /inflates to more than the 3999 bytes it declares/);
});

test('rejects an unsupported compression method', async () => {
  const archive = await buf([{ name: 'a.bin', data: bytes(500) }]);
  put16(archive, cdAt(archive) + 10, 12);          // bzip2
  await rejects(readZip(archive), /uses unsupported compression method 12/);
});

test('rejects duplicate entry names', async () => {
  // Two board.json entries make the archive mean two different things
  // depending on which the reader keeps.
  const archive = await buf([
    { name: 'board.json', data: enc.encode('{"items":[]}') },
    { name: 'board.json', data: enc.encode('{"items":[{"evil":true}]}') },
  ]);
  await rejects(readZip(archive), /"board\.json" appears twice/);
});

test('rejects an absurd entry count', async () => {
  const archive = await buf([{ name: 'a.bin', data: bytes(100) }]);
  put16(archive, eocdAt(archive) + 10, 60000);
  await rejects(readZip(archive), /declares too many entries \(60000\)|central directory/);
});

test('rejects a decompression bomb by its declared ratio', async () => {
  // 8 MiB of zeros deflates to a couple of kilobytes: a ratio in the
  // thousands, and the reader must refuse it on the declared numbers alone,
  // before spending the memory to find out.
  const data = zeros(8 * 1024 * 1024);
  const archive = await buf([{ name: 'bomb', data, compress: true }]);
  assert.ok(archive.length < 64 * 1024, 'fixture is not actually a bomb');
  await rejects(readZip(archive), /expands \d+x - refusing to unpack it/);
});

test('rejects a bomb that lies about its uncompressed size', async () => {
  // The ratio guard above reads the *declared* size, so the way past it is to
  // declare something else. This entry says it inflates to one byte, which is
  // under every ceiling there is - and then expands to 8 MiB.
  //
  // The reader used to collect the whole stream and compare lengths afterwards,
  // so it did reject this, but only once the memory had already been spent: at
  // this size the check cost ~26 MiB of allocation to reach, and the size in
  // the fixture is the only thing stopping that being a gigabyte. Now the
  // declared size is a budget the inflate is cancelled against, so the cost is
  // bounded by what the entry claimed rather than by what it contains.
  const data = zeros(8 * 1024 * 1024);
  const archive = await buf([{ name: 'bomb.bin', data, compress: true }]);
  const cd = cdAt(archive);
  put32(archive, cd + 24, 1);                  // central directory: usize
  await assert.rejects(readZip(archive), /more than the 1 bytes it declares/);
});

test('the inflate budget is the declared size, not a round number', async () => {
  // One byte over is still over: the cap is the entry's own claim, so an
  // archive cannot buy headroom by declaring something merely plausible.
  const data = enc.encode('the same sentence over and over. '.repeat(200));
  const archive = await buf([{ name: 'board.json', data, compress: true }]);
  const cd = cdAt(archive);
  put32(archive, cd + 24, data.length - 1);
  await rejects(readZip(archive), new RegExp(`inflates to more than the ${data.length - 1} bytes it declares`));
});

test('a big but honest entry is still accepted', async () => {
  // The ratio guard must not catch real content. 2 MiB of noise compresses
  // barely at all, which is what a photo or a video chunk looks like.
  const data = bytes(2 * 1024 * 1024, 7);
  const files = await readZip(await buf([{ name: 'photo.jpg', data, compress: true }]));
  assert.equal(files.get('photo.jpg').length, data.length);
});

// ---------------------------------------------------------------------------
// CRC32
// ---------------------------------------------------------------------------

test('crc32 matches known vectors', () => {
  assert.equal(crc32(enc.encode('')), 0);
  assert.equal(crc32(enc.encode('123456789')), 0xcbf43926);
  assert.equal(crc32(enc.encode('The quick brown fox jumps over the lazy dog')), 0x414fa339);
});

test('an oversized Blob is rejected on its size, before it is ever allocated', async () => {
  // A Blob-like whose arrayBuffer() would blow up if called: the point of the
  // fix is that its cheap `.size` is checked first, so a file provably too large
  // never gets pulled into memory. See AUD-04. 768 MiB is the archive ceiling.
  const oversize = {
    size: 768 * 1024 ** 2 + 1,
    arrayBuffer() { throw new Error('must not allocate an over-limit archive'); },
  };
  await assert.rejects(readZip(oversize), /too large to open/);
});

// ---------------------------------------------------------------------------
// Blob entries - the export's memory ceiling
// ---------------------------------------------------------------------------
//
// packBoard() hands assets over as Blobs rather than as bytes, so a board of
// video is not a board of video on the heap. The writer therefore has two
// paths to the same archive, and the thing that must hold is that they produce
// the *same* archive - a Blob entry whose CRC or declared size came out
// differently would be a file that opens nowhere, and it would only be
// discovered by someone trying to reopen their board.

test('a Blob entry writes byte-for-byte the same archive as its bytes', async () => {
  const data = bytes(5000, 7);
  const at = new Date(2020, 0, 2, 3, 4, 5);
  const fromBytes = await buf([{ name: 'a.bin', data, compress: false }], { date: at });
  const fromBlob = await buf([{ name: 'a.bin', data: new Blob([data]), compress: false }], { date: at });
  assert.deepEqual(fromBlob, fromBytes);
});

test('a compressed Blob entry round-trips', async () => {
  // Deflate goes Blob to Blob through the platform compressor on this path,
  // which is a different call from the bytes one - so it gets its own trip.
  const data = zeros(20000);
  const files = await readZip(await buf([{ name: 'flat', data: new Blob([data]), compress: true }]));
  assert.deepEqual(files.get('flat'), data);
});

test('a Blob and a byte entry can share one archive', async () => {
  const a = bytes(300, 1), b = bytes(4000, 2);
  const files = await readZip(await buf([
    { name: 'bytes', data: a, compress: false },
    { name: 'blob', data: new Blob([b]), compress: false },
  ]));
  assert.deepEqual([...files.keys()], ['bytes', 'blob']);
  assert.deepEqual(files.get('bytes'), a);
  assert.deepEqual(files.get('blob'), b);
});

test('an empty Blob entry is written and read as empty', async () => {
  const files = await readZip(await buf([{ name: 'empty', data: new Blob([]), compress: true }]));
  assert.deepEqual(files.get('empty'), new Uint8Array(0));
});

test('the streamed CRC agrees with the whole-buffer one', async () => {
  // The two implementations share a table and nothing else. A Blob larger than
  // one stream chunk is the case that would catch a mis-carried running value.
  const data = bytes(300000, 11);
  const archive = await buf([{ name: 'big', data: new Blob([data]), compress: false }]);
  // The local header's CRC field, at a fixed offset from the start.
  const written = new DataView(archive.buffer).getUint32(14, true);
  assert.equal(written, crc32(data));
});
