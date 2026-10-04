// A board's picture inside its own file: packed last and stored, read back by
// unpackBoard() and from the file's end alone, and refused when its bytes are
// not the picture its name claims. The list of boards draws from the tail read.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { packBoard, packBoardFile, unpackBoard, thumbnailFromTail } from '../web/assets/js/storage/mbrd.ts';
import { readZip, writeZip } from '../web/assets/js/storage/zip.ts';
import { clearAssets } from '../web/assets/js/storage/assets.ts';

const board = () => ({ title: 'Pictured', view: { pan: { x: 0, y: 0 }, zoom: 1 }, items: [], trash: [] });

/** Enough of a WebP to pass the sniff: RIFF, a length, WEBP, then filler. */
function webp(n = 200) {
  const b = new Uint8Array(n);
  b.set([0x52, 0x49, 0x46, 0x46, 0, 0, 0, 0, 0x57, 0x45, 0x42, 0x50]);
  for (let i = 12; i < n; i++) b[i] = i & 0xff;
  return b;
}
const urlOf = (bytes, type = 'image/webp') => `data:${type};base64,${Buffer.from(bytes).toString('base64')}`;
const bytesOf = async blob => new Uint8Array(await blob.arrayBuffer());

test('a packed board carries its picture, last and stored', async () => {
  clearAssets();
  const url = urlOf(webp());
  const { blob } = await packBoard(board(), { thumb: url });
  const files = await readZip(blob);
  assert.equal([...files.keys()].at(-1), 'thumbnail.webp');
  assert.deepEqual(files.get('thumbnail.webp'), webp());
  clearAssets();
  const { thumb } = await unpackBoard(blob);
  assert.equal(thumb, url);
});

test('no picture given, none written, and none read back', async () => {
  clearAssets();
  const { blob } = await packBoard(board());
  assert.equal((await readZip(blob)).has('thumbnail.webp'), false);
  clearAssets();
  assert.equal((await unpackBoard(blob)).thumb, null);
});

test('the picture is read from the end of the file alone', async () => {
  clearAssets();
  const url = urlOf(webp(5000));
  const { blob } = await packBoardFile(board(), { thumb: url });
  const all = await bytesOf(blob);
  assert.ok(all.length > 5400);
  // The last 5400 bytes hold the picture and the directory behind it.
  assert.equal(thumbnailFromTail(all.subarray(all.length - 5400), all.length), url);
  // Too short a tail answers how far back to read, as storage.ts reads it.
  let found = thumbnailFromTail(all.subarray(all.length - 64), all.length);
  assert.equal(typeof found, 'number');
  for (let i = 0; i < 2 && typeof found === 'number'; i++) {
    found = thumbnailFromTail(all.subarray(all.length - found), all.length);
  }
  assert.equal(found, url);
});

test('a JPEG goes under its own name', async () => {
  clearAssets();
  const jpeg = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3, 4]);
  const { blob } = await packBoard(board(), { thumb: urlOf(jpeg, 'image/jpeg') });
  const files = await readZip(blob);
  assert.ok(files.has('thumbnail.jpg'));
  assert.equal(files.has('thumbnail.webp'), false);
});

test('a picture whose bytes are not what its type says is not written', async () => {
  clearAssets();
  const { blob } = await packBoard(board(), { thumb: urlOf(new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13])) });
  assert.equal((await readZip(blob)).has('thumbnail.webp'), false);
  const svg = 'data:image/svg+xml;base64,' + Buffer.from('<svg/>').toString('base64');
  const { blob: other } = await packBoard(board(), { thumb: svg });
  assert.equal([...(await readZip(other)).keys()].some(n => n.startsWith('thumbnail')), false);
});

test('a file whose thumbnail entry is something else shows nothing', async () => {
  const blob = await writeZip([
    { name: 'board.json', data: new TextEncoder().encode('{"items":[]}') },
    { name: 'thumbnail.webp', data: new TextEncoder().encode('<script>alert(1)</script>') },
  ]);
  const all = await bytesOf(blob);
  assert.equal(thumbnailFromTail(all, all.length), null);
  clearAssets();
  assert.equal((await unpackBoard(blob)).thumb, null);
});

test('a tail that is not a ZIP answers null', () => {
  const junk = new Uint8Array(400).fill(7);
  assert.equal(thumbnailFromTail(junk, junk.length), null);
});
