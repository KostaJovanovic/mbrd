// Entry names in a ZIP the app did not write. Bit 11 of an entry's flags says
// its name is UTF-8. With the bit clear, a name that is valid UTF-8 is still
// read as UTF-8 (most archivers), and one that is not is read as CP437, which
// is what Windows Explorer writes (research/old/done-2026-09-15.md, R12).

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { writeZip, readZip } from '../web/assets/js/storage/zip.ts';

const enc = new TextEncoder();

const buf = async entries =>
  new Uint8Array(await (await writeZip(entries)).arrayBuffer());

/** Every offset where `needle` starts in `hay`: the local header and the central directory. */
function everywhere(hay, needle) {
  const out = [];
  for (let i = 0; i + needle.length <= hay.length; i++) {
    if (needle.every((b, j) => hay[i + j] === b)) out.push(i);
  }
  return out;
}

/** Clear bit 11 on every entry, in the central directory and the local header,
 *  as an archiver that does not say its names are UTF-8 leaves it. This app's
 *  writer sets the bit, so the tests below have to take it off. */
function clearUtf8Flags(b) {
  const view = new DataView(b.buffer);
  let eocd = b.length - 22;
  while (view.getUint32(eocd, true) !== 0x06054b50) eocd--;
  const count = view.getUint16(eocd + 10, true);
  let p = view.getUint32(eocd + 16, true);
  for (let n = 0; n < count; n++) {
    view.setUint16(p + 8, view.getUint16(p + 8, true) & ~0x800, true);
    const local = view.getUint32(p + 42, true);
    view.setUint16(local + 6, view.getUint16(local + 6, true) & ~0x800, true);
    p += 46 + view.getUint16(p + 28, true) + view.getUint16(p + 30, true) + view.getUint16(p + 32, true);
  }
  return b;
}

/** A one-entry archive named `name`, with the bytes at `patch` rewritten in both headers. */
async function archiveNamed(name, patch) {
  const b = clearUtf8Flags(await buf([{ name, data: enc.encode('x'), compress: false }]));
  const at = everywhere(b, [...enc.encode(name)]);
  assert.equal(at.length, 2, 'the name should appear in the local header and the central directory');
  for (const start of at) for (const [offset, byte] of Object.entries(patch)) b[start + Number(offset)] = byte;
  return b;
}

test('a name that is not UTF-8 and carries no flag reads as CP437', async () => {
  const files = await readZip(await archiveNamed('a_b_c.txt', { 1: 0x81, 3: 0xe1 }));
  assert.deepEqual([...files.keys()], ['aübßc.txt']);
});

test('the CP437 table runs from 0x80 to 0xFF', async () => {
  const files = await readZip(await archiveNamed('xy.txt', { 0: 0x80, 1: 0xff }));
  assert.deepEqual([...files.keys()], ['Ç .txt']);
});

test('two accented names from Windows stay two entries', async () => {
  const b = clearUtf8Flags(await buf([
    { name: 'a_.txt', data: enc.encode('1'), compress: false },
    { name: 'b_.txt', data: enc.encode('2'), compress: false },
  ]));
  for (const name of ['a_.txt', 'b_.txt']) {
    for (const start of everywhere(b, [...enc.encode(name)])) b[start + 1] = 0x94;
  }
  assert.deepEqual([...(await readZip(b)).keys()].sort(), ['aö.txt', 'bö.txt']);
});

test('a UTF-8 name with no flag still reads as UTF-8', async () => {
  const b = clearUtf8Flags(await buf([{ name: 'café.txt', data: enc.encode('x'), compress: false }]));
  assert.deepEqual([...(await readZip(b)).keys()], ['café.txt']);
});
