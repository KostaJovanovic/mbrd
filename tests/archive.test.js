// The reader behind Unzip (import/archive.ts): paths made plain, one level of a
// tree in the archive's own order, and TAR and gzip read through code that
// refuses a broken file rather than reading it short.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { children, cleanPath, readArchive, readTar } from '../web/assets/js/import/archive.ts';
import { writeZip } from '../web/assets/js/storage/zip.ts';
import { isOversize } from '../web/assets/js/consent.ts';

const enc = new TextEncoder();
const text = async blob => new TextDecoder().decode(await blob.arrayBuffer());
const paths = files => files.map(f => f.path);

/** One ustar header and its data, padded to whole blocks. */
function tarEntry(name, body = '', type = '0') {
  const data = typeof body === 'string' ? enc.encode(body) : body;
  const h = new Uint8Array(512);
  const put = (s, at) => h.set(enc.encode(s), at);
  put(name, 0);
  put('0000644\0', 100);
  put(data.length.toString(8).padStart(11, '0') + '\0', 124);
  put('        ', 148);
  put(type, 156);
  put('ustar\0', 257);
  put('00', 263);
  let sum = 0;
  for (const b of h) sum += b;
  put(sum.toString(8).padStart(6, '0') + '\0 ', 148);
  const padded = new Uint8Array(Math.ceil(data.length / 512) * 512);
  padded.set(data);
  return [h, padded];
}

/** Entries, then the two zero blocks that end an archive. */
const tar = (...entries) => new Blob([...entries.flat(), new Uint8Array(1024)]);

const gzip = async bytes =>
  new Blob([await new Response(new Blob([bytes]).stream().pipeThrough(new CompressionStream('gzip'))).arrayBuffer()]);

test('a path out of an archive is made plain, or refused', () => {
  assert.equal(cleanPath('a\\b.png'), 'a/b.png');
  assert.equal(cleanPath('/x/./y.txt'), 'x/y.txt');
  assert.equal(cleanPath('C:\\notes.txt'), 'notes.txt');
  assert.equal(cleanPath('../evil.txt'), null);
  assert.equal(cleanPath('a/../../evil.txt'), null);
  assert.equal(cleanPath('__MACOSX/._a.png'), null);
  assert.equal(cleanPath('photos/.DS_Store'), null);
  assert.equal(cleanPath('photos/Thumbs.db'), null);
});

test('one level of a tree, in the order each thing first appears', () => {
  const all = ['b.txt', 'photos/1.jpg', 'a.txt', 'photos/2.jpg', 'photos/raw/3.nef'];
  assert.deepEqual(children(all), [
    { kind: 'file', path: 'b.txt', name: 'b.txt' },
    { kind: 'folder', path: 'photos/', name: 'photos', count: 3 },
    { kind: 'file', path: 'a.txt', name: 'a.txt' },
  ]);
  assert.deepEqual(children(all, 'photos/'), [
    { kind: 'file', path: 'photos/1.jpg', name: '1.jpg' },
    { kind: 'file', path: 'photos/2.jpg', name: '2.jpg' },
    { kind: 'folder', path: 'photos/raw/', name: 'raw', count: 1 },
  ]);
});

test('a ZIP reads in its own order, without the leftovers', async () => {
  const zip = await writeZip([
    { name: 'b.txt', data: enc.encode('bee') },
    { name: '__MACOSX/._b.txt', data: enc.encode('junk') },
    { name: 'dir/a.txt', data: enc.encode('ay'), compress: true },
  ]);
  const files = await readArchive(zip, 'x.zip');
  assert.deepEqual(paths(files), ['b.txt', 'dir/a.txt']);
  assert.equal(await text(files[1].data), 'ay');
});

test('a TAR reads files, long names and pax paths, and skips folders', async () => {
  const long = `${'deep/'.repeat(30)}name.txt`;
  const files = await readTar(tar(
    tarEntry('top/', '', '5'),
    tarEntry('top/a.txt', 'alpha'),
    tarEntry('././@LongLink', long + '\0', 'L'),
    tarEntry(long.slice(0, 99), 'long'),
    tarEntry('PaxHeader', '31 path=pax/named/file.txt\n', 'x'),
    tarEntry('short', 'pax'),
  ));
  assert.deepEqual(paths(files), ['top/a.txt', long, 'pax/named/file.txt']);
  assert.equal(await text(files[0].data), 'alpha');
  assert.equal(await text(files[2].data), 'pax');
});

test('a TAR that runs past its end, or fails a checksum, is refused', async () => {
  const [header] = tarEntry('big.bin', new Uint8Array(5000));
  await assert.rejects(readTar(new Blob([header, new Uint8Array(512)])), /past the end/);
  const [bad, body] = tarEntry('a.txt', 'alpha');
  bad[0] ^= 1;
  await assert.rejects(readTar(new Blob([bad, body])), /checksum/);
});

test('a .tar.gz is a TAR inside, and any other .gz is one file', async () => {
  const inner = new Uint8Array(await tar(tarEntry('a.txt', 'alpha'), tarEntry('b/c.txt', 'see')).arrayBuffer());
  assert.deepEqual(paths(await readArchive(await gzip(inner), 'set.tar.gz')), ['a.txt', 'b/c.txt']);
  assert.deepEqual(paths(await readArchive(await gzip(inner), 'set.tgz')), ['a.txt', 'b/c.txt']);
  const one = await readArchive(await gzip(enc.encode('hello')), 'notes.txt.gz');
  assert.deepEqual(paths(one), ['notes.txt']);
  assert.equal(await text(one[0].data), 'hello');
});

test('a gzip that expands suspiciously is a question, and a yes reads it', async () => {
  const bomb = await gzip(new Uint8Array(3 << 20));
  await assert.rejects(readArchive(bomb, 'zeros.gz'), err => isOversize(err) && err.ceiling === 'entry-ratio');
  const [file] = await readArchive(bomb, 'zeros.gz', true);
  assert.equal(file.data.size, 3 << 20);
});

test('broken gzip and unknown kinds are refused, not guessed at', async () => {
  await assert.rejects(readArchive(new Blob([enc.encode('not gzip at all')]), 'x.gz'), /not gzip/);
  await assert.rejects(readArchive(new Blob(['x']), 'x.cab'), /not an archive/);
});
