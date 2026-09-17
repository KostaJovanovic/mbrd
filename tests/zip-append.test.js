// A save appended to a board file (appendZip() in storage/zip.ts): the file
// plus its tail reads as the new save, an entry the file already holds is
// pointed at rather than written again, and a tail cut short - a crash part
// way through an append - leaves the save before it readable.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { appendZip, layoutFromTail, readZip, writeZipLayout } from '../web/assets/js/storage/zip.ts';
import { bytes } from './helpers.js';

const enc = new TextEncoder();
const dec = new TextDecoder();
const text = (files, name) => dec.decode(files.get(name));
const whole = async blob => new Uint8Array(await blob.arrayBuffer());
const keepAssets = name => name.startsWith('assets/');

async function firstSave() {
  return writeZipLayout([
    { name: 'mimetype', data: enc.encode('application/vnd.mbrd+zip') },
    { name: 'board.json', data: enc.encode('{"v":1}'), compress: true },
    { name: 'assets/a', data: bytes(4000) },
  ]);
}

test('a file and its tail read as the new save', async () => {
  const { blob, layout } = await firstSave();
  const { tail, layout: next } = await appendZip([
    { name: 'mimetype', data: enc.encode('application/vnd.mbrd+zip') },
    { name: 'board.json', data: enc.encode('{"v":2}'), compress: true },
    { name: 'assets/a', data: bytes(4000) },
    { name: 'assets/b', data: bytes(300) },
  ], layout, keepAssets);
  const file = new Blob([blob, tail]);
  assert.equal(file.size, next.size);
  const files = await readZip(file);
  assert.equal(text(files, 'board.json'), '{"v":2}');
  assert.deepEqual([...files.keys()], ['mimetype', 'board.json', 'assets/a', 'assets/b']);
  assert.deepEqual(files.get('assets/a'), bytes(4000));
});

test('a file\'s layout reads from its end alone, and asks for more when the end is short', async () => {
  const { blob, layout } = await firstSave();
  const file = await whole(blob);
  assert.deepEqual(layoutFromTail(file, file.length), layout);
  // The last 100 bytes hold the end record but start inside the directory.
  const need = layoutFromTail(file.subarray(file.length - 100), file.length);
  assert.equal(typeof need, 'number');
  assert.deepEqual(layoutFromTail(file.subarray(file.length - need), file.length), layout);
});

test('an append onto a layout read from the end reads as the new save', async () => {
  const { blob } = await firstSave();
  const file = await whole(blob);
  const { tail } = await appendZip([
    { name: 'mimetype', data: enc.encode('application/vnd.mbrd+zip') },
    { name: 'board.json', data: enc.encode('{"v":2}'), compress: true },
    { name: 'assets/a', data: bytes(4000) },
  ], layoutFromTail(file, file.length), keepAssets);
  assert.ok(tail.size < 600, `the asset was pointed at, not written: tail is ${tail.size} bytes`);
  const files = await readZip(new Blob([blob, tail]));
  assert.equal(text(files, 'board.json'), '{"v":2}');
  assert.deepEqual(files.get('assets/a'), bytes(4000));
});

test('a file whose end holds no directory has no layout, and is written whole', async () => {
  assert.equal(layoutFromTail(new Uint8Array(5000), 5000), null);
  // A save cut short: its end record is not whole.
  const file = await whole((await firstSave()).blob);
  assert.equal(layoutFromTail(file.subarray(0, file.length - 10), file.length - 10), null);
});

test('what the file already holds is pointed at, not written again', async () => {
  const { layout } = await firstSave();
  const { tail } = await appendZip([
    { name: 'mimetype', data: enc.encode('application/vnd.mbrd+zip') },
    { name: 'board.json', data: enc.encode('{"v":1}'), compress: true },
    { name: 'assets/a', data: bytes(4000) },
  ], layout, keepAssets);
  // Nothing changed, so the tail is a directory and its record: no entry data.
  assert.ok(tail.size < 300, `tail is ${tail.size} bytes`);
});

test('waste counts what the new directory no longer points at', async () => {
  const { layout } = await firstSave();
  const { waste, layout: next } = await appendZip([
    { name: 'board.json', data: enc.encode('{"v":2}'), compress: true },
  ], layout, keepAssets);
  // The asset, the mimetype, the old board.json and the old directory are dead.
  assert.ok(waste > 4000 && waste < next.size, `waste ${waste} of ${next.size}`);
});

test('a tail cut short leaves the save before it readable', async () => {
  const { blob, layout } = await firstSave();
  // A big stored entry, so the old record sits further back than a comment
  // could push it and the reader has to walk past the dead tail to find it.
  const { tail } = await appendZip([
    { name: 'board.json', data: enc.encode('{"v":2}') },
    { name: 'assets/big', data: bytes(90000) },
  ], layout, keepAssets);
  const cut = new Blob([blob, (await whole(tail)).subarray(0, tail.size - 40)]);
  assert.equal(text(await readZip(cut), 'board.json'), '{"v":1}');
  // And a short tail, still inside the window the record is normally looked for in.
  const { tail: small } = await appendZip([
    { name: 'board.json', data: enc.encode('{"v":3}') },
  ], layout, keepAssets);
  const cutSmall = new Blob([blob, (await whole(small)).subarray(0, small.size - 22)]);
  assert.equal(text(await readZip(cutSmall), 'board.json'), '{"v":1}');
});
