// readZipBlob() in storage/zip.ts: a board the app owns, read without holding
// it as bytes. It reads what readZip() reads, keeps the stored entries it is
// asked to as slices of the archive, refuses what readZip() refuses, and hands
// a save cut short to readZip(), whose search reaches the save before it.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { appendZip, readZip, readZipBlob, writeZip, writeZipLayout } from '../web/assets/js/storage/zip.ts';
import { packBoard, unpackBoard } from '../web/assets/js/storage/mbrd.ts';
import { clearAssets, getAsset, putAsset } from '../web/assets/js/storage/assets.ts';
import { sha256 } from '../web/assets/js/crypto.ts';
import { bytes } from './helpers.js';

const enc = new TextEncoder();
const dec = new TextDecoder();
const whole = async blob => new Uint8Array(await blob.arrayBuffer());
const keepPictures = name => (name.startsWith('assets/') ? 'image/png' : null);

const entries = (v, extra = []) => [
  { name: 'mimetype', data: enc.encode('application/vnd.mbrd+zip') },
  { name: 'board.json', data: enc.encode(`{"v":${v}}`), compress: true },
  { name: 'assets/a.png', data: bytes(5000) },
  ...extra,
];

test('it reads what readZip() reads, with the kept entries as slices of the archive', async () => {
  const zip = await writeZip(entries(1));
  const { files, blobs } = await readZipBlob(zip, { keep: keepPictures });
  const all = await readZip(zip);
  assert.deepEqual([...files.keys()], ['mimetype', 'board.json']);
  assert.deepEqual(files.get('board.json'), all.get('board.json'));
  const kept = blobs.get('assets/a.png');
  assert.ok(kept instanceof Blob);
  assert.equal(kept.type, 'image/png');
  assert.deepEqual(await whole(kept), all.get('assets/a.png'));
});

test('a damaged picture is refused, as readZip() refuses it', async () => {
  const bad = await whole(await writeZip(entries(1)));
  // Most of the archive is the picture's 5000 bytes.
  bad[2500] ^= 0xff;
  await assert.rejects(readZipBlob(new Blob([bad]), { keep: keepPictures }), /damaged/);
});

test('two entries under one name are refused', async () => {
  const zip = await writeZip([{ name: 'a', data: bytes(10) }, { name: 'a', data: bytes(10) }]);
  await assert.rejects(readZipBlob(zip, { keep: () => null }), /appears twice/);
});

test('a directory pointing past the end is refused', async () => {
  const zip = await whole(await writeZip(entries(1)));
  const view = new DataView(zip.buffer);
  // The end record's directory offset, pointed past the file.
  view.setUint32(zip.length - 22 + 16, zip.length + 100, true);
  await assert.rejects(readZipBlob(new Blob([zip]), { keep: keepPictures }), /Corrupt archive/);
});

test('a board with a save appended reads as its newest save', async () => {
  const { blob, layout } = await writeZipLayout(entries(1));
  const { tail } = await appendZip(entries(2), layout, name => name.startsWith('assets/'));
  const { files, blobs } = await readZipBlob(new Blob([blob, tail]), { keep: keepPictures });
  assert.equal(dec.decode(files.get('board.json')), '{"v":2}');
  assert.deepEqual(await whole(blobs.get('assets/a.png')), bytes(5000));
});

test('a save cut short opens as the save before it', async () => {
  const { blob, layout } = await writeZipLayout(entries(1));
  // A tail longer than a comment's reach, so the last whole end record is
  // out of it once the new one is cut off.
  const { tail } = await appendZip(entries(2, [{ name: 'assets/b.png', data: bytes(70000, 2) }]),
    layout, name => name.startsWith('assets/'));
  const cut = (await whole(new Blob([blob, tail]))).subarray(0, blob.size + tail.size - 10);
  const { files } = await readZipBlob(new Blob([cut]), { keep: keepPictures });
  assert.equal(dec.decode(files.get('board.json')), '{"v":1}');
});

test('unpackBoard keeps an owned board\'s pictures where they are in it', async () => {
  const data = bytes(3000, 3);
  const h = await sha256(data);
  const asset = { hash: h, ext: 'png', mime: 'image/png', name: 'p.png' };
  putAsset(h, new Blob([data], { type: 'image/png' }), asset);
  const { blob } = await packBoard({
    title: 'Owned',
    items: [{ id: 'i1', type: 'image', x: 0, y: 0, w: 10, h: 10, name: 'p.png', asset }],
  });
  clearAssets();
  const { board } = await unpackBoard(blob, { owned: true });
  assert.equal(board.title, 'Owned');
  const back = getAsset(h);
  assert.ok(back, 'the picture is registered');
  assert.equal(back.blob.type, 'image/png');
  assert.deepEqual(await whole(back.blob), data);
});
