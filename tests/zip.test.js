// The ZIP container - the whole storage substrate, since a .mbrd is a ZIP.
// Two halves: round-trip tests say the writer and reader agree, and the
// rest feed the reader damaged and hostile archives, since a .mbrd
// arrives from outside and every offset in it is a number this app is
// about to index memory by. Malformed cases are built by writing a good
// archive and corrupting one field, not hand-assembling bytes - keeps
// each test about the one thing it changed, and keeps them honest if the
// writer's layout moves.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { writeZip, readZip, crc32, LIMITS } from '../web/assets/js/storage/zip.ts';
import { isOversize } from '../web/assets/js/consent.ts';
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
  // Long and repetitive, so the writer takes the compressed form - only
  // when deflating wins, and only above 256 bytes.
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
  // Random bytes deflate to *more* than they started as; the writer
  // must notice and keep the original.
  const data = bytes(4096, 99);
  const files = await readZip(await buf([{ name: 'noise', data, compress: true }]));
  assert.deepEqual(files.get('noise'), data);
});

// ---------------------------------------------------------------------------
// Malformed and hostile archives
// ---------------------------------------------------------------------------

/**
 * Refused, and refused by the guard we meant. Used to be
 * `assert.rejects(promise, /.+/)`, satisfied by any non-empty error - a
 * TypeError from a half-broken reader read the same as a real CRC or
 * bomb refusal. Every caller now names the sentence its fixture earns,
 * recording *which* of zip.ts's twenty-odd refusals it exercises.
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
  // Keep the directory, lose the payload it points at. The old fixture
  // sliced at `cdAt(archive) - 500`, taking the central directory and the
  // EOCD with it, landing on the same "no EOCD" branch as the two tests
  // above and leaving zip.ts's truncation guard covered only by the
  // forged-csize fixture below.
  //
  // So: splice 500 bytes out of the payload and pull the trailer up to
  // meet it. The directory survives intact, still declaring 2000 bytes
  // of entry data no longer in the file.
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
  // depending on which one the reader keeps.
  const archive = await buf([
    { name: 'board.json', data: enc.encode('{"items":[]}') },
    { name: 'board.json', data: enc.encode('{"items":[{"evil":true}]}') },
  ]);
  await rejects(readZip(archive), /"board\.json" appears twice/);
});

test('rejects an absurd entry count', async () => {
  const archive = await buf([{ name: 'a.bin', data: bytes(100) }]);
  put16(archive, eocdAt(archive) + 10, 60000);
  // The separator is the machine's, not ours - these messages go through
  // toLocaleString(), like mesh.ts's triangle counts. The count is
  // matched loosely, the sentence around it exactly.
  await rejects(readZip(archive), /declares 60[., \s]000 entries|central directory/);
});

test('rejects a decompression bomb by its declared ratio', async () => {
  // 8 MiB of zeros deflates to a couple of kilobytes, a ratio in the
  // thousands - the reader must refuse on the declared numbers alone,
  // before spending the memory to find out.
  const data = zeros(8 * 1024 * 1024);
  const archive = await buf([{ name: 'bomb', data, compress: true }]);
  assert.ok(archive.length < 64 * 1024, 'fixture is not actually a bomb');
  await rejects(readZip(archive), /expands \d+ times over/);
});

test('rejects a bomb that lies about its uncompressed size', async () => {
  // The ratio guard reads the *declared* size, so declaring something
  // else gets past it. This entry claims one byte - under every
  // ceiling - then expands to 8 MiB.
  //
  // The reader used to collect the whole stream and compare lengths
  // afterwards, rejecting this only once the memory was already spent -
  // ~26 MiB of allocation here, a gigabyte at a larger fixture. Now the
  // declared size is a budget the inflate is cancelled against, bounding
  // cost by the claim, not the content.
  const data = zeros(8 * 1024 * 1024);
  const archive = await buf([{ name: 'bomb.bin', data, compress: true }]);
  const cd = cdAt(archive);
  put32(archive, cd + 24, 1);                  // central directory: usize
  await assert.rejects(readZip(archive), /more than the 1 bytes it declares/);
});

test('the inflate budget is the declared size, not a round number', async () => {
  // One byte over is still over: the cap is the entry's own claim, so
  // an archive cannot buy headroom by declaring something plausible.
  const data = enc.encode('the same sentence over and over. '.repeat(200));
  const archive = await buf([{ name: 'board.json', data, compress: true }]);
  const cd = cdAt(archive);
  put32(archive, cd + 24, data.length - 1);
  await rejects(readZip(archive), new RegExp(`inflates to more than the ${data.length - 1} bytes it declares`));
});

test('a big but honest entry is still accepted', async () => {
  // The ratio guard must not catch real content: 2 MiB of noise barely
  // compresses, what a photo or video chunk looks like.
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
  // A Blob-like whose arrayBuffer() would blow up if called: its cheap
  // `.size` is checked first, so a provably too-large file never gets
  // pulled into memory. See AUD-04. 768 MiB is the archive ceiling.
  const oversize = {
    size: 768 * 1024 ** 2 + 1,
    arrayBuffer() { throw new Error('must not allocate an over-limit archive'); },
  };
  await assert.rejects(readZip(oversize), /past the .* an archive is normally opened at/);
});

// ---------------------------------------------------------------------------
// Blob entries - the export's memory ceiling
// ---------------------------------------------------------------------------
//
// packBoard() hands assets over as Blobs, not bytes, so a board of video
// is not a board of video on the heap. The writer's two paths must
// produce the *same* archive - a Blob entry with a different CRC or
// declared size would be a file that opens nowhere, discovered only when
// somebody tries to reopen their board.

test('a Blob entry writes byte-for-byte the same archive as its bytes', async () => {
  const data = bytes(5000, 7);
  const at = new Date(2020, 0, 2, 3, 4, 5);
  const fromBytes = await buf([{ name: 'a.bin', data, compress: false }], { date: at });
  const fromBlob = await buf([{ name: 'a.bin', data: new Blob([data]), compress: false }], { date: at });
  assert.deepEqual(fromBlob, fromBytes);
});

test('a compressed Blob entry round-trips', async () => {
  // Deflate goes Blob to Blob through the platform compressor here, a
  // different call from the bytes path, so it gets its own trip.
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

// ---------------------------------------------------------------------------
// The container's own structure
//
// The fixtures above corrupt a *field* in a well-formed archive. These
// corrupt the structure around the fields - signatures, the directory's
// own extent, the payload - the shape a truncated or hand-rezipped
// .mbrd actually arrives in.
// ---------------------------------------------------------------------------

test('a corrupt central-directory signature is refused', async () => {
  const archive = await buf([{ name: 'a.bin', data: bytes(500) }]);
  put32(archive, cdAt(archive), 0xdeadbeef);
  await rejects(readZip(archive), /Corrupt central directory/);
});

test('a corrupt local-header signature is refused', async () => {
  const archive = await buf([{ name: 'a.bin', data: bytes(500) }]);
  put32(archive, 0, 0xdeadbeef);
  await rejects(readZip(archive), /Corrupt entry "a\.bin"/);
});

test('a central directory longer than the space before its own record is refused', async () => {
  // `p + cdSize > eocd` at zip.ts:405, a different guard from "points
  // past the end of the file": the directory fits inside the archive but
  // not inside the room the EOCD leaves it. Sized to land in that window,
  // not past the file, hence computed rather than a constant.
  const archive = await buf([{ name: 'a.bin', data: bytes(500) }]);
  const eocd = eocdAt(archive);
  put32(archive, eocd + 12, (eocd - cdAt(archive)) + 10);   // cdSize
  await rejects(readZip(archive), /the central directory overruns its own record/);
});

test('an entry over the per-entry ceiling is refused on its declared size', async () => {
  // Compressible content, so the writer actually deflates it - a stored
  // entry whose two sizes disagree is caught by an earlier guard and
  // never reaches this one.
  const archive = await buf([{ name: 'big.bin', data: enc.encode('x'.repeat(4000)), compress: true }]);
  put32(archive, cdAt(archive) + 24, LIMITS.entry + 1);
  await rejects(readZip(archive), /unpacked, past the .* one entry is normally given/);
});

test('a ceiling is thrown as Oversize, and a corrupt archive is not', async () => {
  // The distinction the asking-instead-of-refusing change rests on. Both
  // come out of readZip() as a throw, but the caller must tell "this is
  // large, shall I go on?" from "this file does not say what it means" -
  // told apart by the class alone, since a message changes when
  // somebody rewords a sentence.
  const big = await buf([{ name: 'big.bin', data: enc.encode('x'.repeat(4000)), compress: true }]);
  put32(big, cdAt(big) + 24, LIMITS.entry + 1);
  await assert.rejects(readZip(big), err => isOversize(err));

  const broken = await buf([{ name: 'a.bin', data: bytes(100) }]);
  put32(broken, cdAt(broken) + 42, 0x7fffffff);   // local header offset past the end
  await assert.rejects(readZip(broken), err => !isOversize(err) && err instanceof Error);
});

test('a lifted ceiling opens what the same ceiling refused', async () => {
  // The other half of the contract: a ceiling is a number the caller may
  // overrule once agreed to. Proved with a deliberately tiny cap rather
  // than a 512 MB fixture - same mechanism as the real ceilings, and a
  // test allocating half a gigabyte is a test nobody runs.
  const archive = await buf([{ name: 'a.bin', data: enc.encode('x'.repeat(4000)), compress: true }]);
  await rejects(readZip(archive, { entry: 10, total: 10 }), /one entry is normally given/);

  const entries = await readZip(archive, { entry: 10, total: 10, lift: true });
  assert.equal(entries.get('a.bin').length, 4000);
});

test('lifting a ceiling does not lift a corruption check', async () => {
  // `lift` is scoped to the size checks and must stay there. An archive
  // whose entry data runs off the end of the file is not a large
  // document, and agreeing to spend memory is not agreeing to read bytes
  // that are not there - the guard must hold even with `lift` set.
  const archive = await buf([{ name: 'a.bin', data: bytes(100) }]);
  put32(archive, cdAt(archive) + 42, 0x7fffffff);
  await assert.rejects(readZip(archive, { lift: true }), err => !isOversize(err));
});

test('a garbage DEFLATE payload fails as a bad entry, not as a crash', async () => {
  // A payload long enough that corrupting its middle cannot reach the
  // central directory - the first fixture for this scribbled straight
  // through the trailer instead.
  const data = bytes(40000, 5);
  const archive = await buf([{ name: 'a.bin', data, compress: true }]);
  const from = Math.floor(cdAt(archive) / 2);
  for (let i = from; i < from + 200; i++) archive[i] = 0xff;
  await rejects(archive.length ? readZip(archive) : Promise.reject(new Error('empty')),
    /failed to inflate cleanly|checksum mismatch|inflates to more than|is damaged/);
});

test('hostile entry names are read as names and nothing more', async () => {
  // readZip does not resolve paths - it returns a Map keyed by whatever
  // the archive said - so the traversal guard is one layer up, in
  // whoever consumes the map. This asserts readZip's own half: a name
  // full of separators, dots and control characters comes back as that
  // name and does not escape the reader.
  //
  // The control character is built, not typed, so this file stays
  // something grep reads as text.
  const names = [
    '../../etc/passwd',
    '/absolute',
    'back\\slash',
    'control' + String.fromCharCode(1) + 'char',
    '..',
  ];
  const archive = await buf(names.map((name, i) => ({ name, data: bytes(64, i + 1) })));
  const files = await readZip(archive);
  assert.deepEqual([...files.keys()], names, 'a name came back changed');
  for (const name of names) assert.equal(files.get(name).length, 64);
});

test('a name length past the end of the directory is refused', async () => {
  const archive = await buf([{ name: 'a.bin', data: bytes(500) }]);
  put16(archive, cdAt(archive) + 28, 0xffff);        // nameLen
  await rejects(readZip(archive), /an entry name points past the end of the file/);
});

test('the streamed CRC agrees with the whole-buffer one', async () => {
  // The two implementations share a table and nothing else. A Blob
  // larger than one stream chunk would catch a mis-carried running value.
  const data = bytes(300000, 11);
  const archive = await buf([{ name: 'big', data: new Blob([data]), compress: false }]);
  // The local header's CRC field, at a fixed offset from the start.
  const written = new DataView(archive.buffer).getUint32(14, true);
  assert.equal(written, crc32(data));
});

// ---------------------------------------------------------------------------
// The name filter
// ---------------------------------------------------------------------------
//
// `only` exists so reaching one small entry inside a large archive does
// not mean unpacking the whole thing (an .apk was the case it was added
// for). It must decide *before* the inflate, change nothing when absent,
// and never be a way around the ceilings.

test('only admits the entries it names and skips the rest', async () => {
  const archive = await buf([
    { name: 'wanted.txt', data: bytes(64, 1) },
    { name: 'ignored.bin', data: bytes(4096, 2) },
  ]);
  const all = await readZip(archive);
  assert.deepEqual([...all.keys()].sort(), ['ignored.bin', 'wanted.txt'],
    'the archive itself holds both, so the filtered read below means something');

  const some = await readZip(archive, { only: n => n === 'wanted.txt' });
  assert.deepEqual([...some.keys()], ['wanted.txt']);
  assert.equal(some.get('wanted.txt').length, 64);
});

test('an absent filter reads exactly what it always did', async () => {
  const archive = await buf([{ name: 'a', data: bytes(32, 3) }, { name: 'b', data: bytes(32, 4) }]);
  assert.deepEqual(
    [...(await readZip(archive)).keys()],
    [...(await readZip(archive, {})).keys()],
  );
});

test('a skipped entry is not inflated, so it cannot cross a ceiling', async () => {
  // The point of the filter: the entry that would refuse the whole read
  // is the one the caller never asked for.
  const archive = await buf([
    { name: 'small.txt', data: bytes(32, 5) },
    { name: 'huge.bin', data: zeros(1 << 20) },
  ]);
  await assert.rejects(
    () => readZip(archive, { entry: 4096 }),
    isOversize,
    'unfiltered, the big entry is past the ceiling',
  );
  const got = await readZip(archive, { entry: 4096, only: n => n === 'small.txt' });
  assert.deepEqual([...got.keys()], ['small.txt']);
});

test('an entry the filter admits is still held to every ceiling', async () => {
  const archive = await buf([{ name: 'huge.bin', data: zeros(1 << 20) }]);
  await assert.rejects(
    () => readZip(archive, { entry: 4096, only: () => true }),
    isOversize,
    'the filter is not a way around the caps',
  );
});

test('a filter that admits nothing is an empty read rather than an error', async () => {
  const archive = await buf([{ name: 'a', data: bytes(32, 6) }]);
  const got = await readZip(archive, { only: () => false });
  assert.equal(got.size, 0);
});
