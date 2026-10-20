// A board saved by a newer mbrd, told apart before it is opened. Every save
// writes the version it came from into manifest.json's `app`, and the open
// reads that field alone (readZipEntry()) to ask before anything is filed. The
// order of versions and the peek's answer on a broken file are what is held.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { packBoard, newerWriter, newerWriterOf, versionParts } from '../web/assets/js/storage/mbrd.ts';
import { readZipEntry, writeZip } from '../web/assets/js/storage/zip.ts';
import { VERSION } from '../web/assets/js/version.js';

const enc = new TextEncoder();

const archive = (app, { compress = true } = {}) => writeZip([
  { name: 'manifest.json', data: enc.encode(JSON.stringify({ format: 'mbrd', version: 1, app, requires: [] })), compress },
  { name: 'board.json', data: enc.encode('{"items":[]}'), compress: true },
]);

test('every save says which version it came from', async () => {
  const { manifest } = await packBoard({ title: 'T', items: [], trash: [] });
  assert.equal(manifest.app, 'mbrd ' + VERSION);
  assert.ok(versionParts(manifest.app), 'and in a shape the check reads');
});

test('versions order by their two numbers, not as text', () => {
  assert.equal(newerWriter('mbrd 0.741', '0.740'), '0.741');
  assert.equal(newerWriter('mbrd 0.10', '0.09'), '0.10');
  assert.equal(newerWriter('mbrd 1.0', '0.999'), '1.0');
  assert.equal(newerWriter('mbrd 1.10', '1.9'), '1.10');
  assert.equal(newerWriter('mbrd 0.740', '0.740'), null, 'the same version is not newer');
  assert.equal(newerWriter('mbrd 0.739', '0.740'), null);
  assert.equal(newerWriter('mbrd v0.21', '0.740'), null, 'the old v-prefixed stamp still reads');
  assert.equal(newerWriter('mbrd v0.900', '0.740'), '0.900');
});

test('a stamp that is not a version is never newer', () => {
  for (const app of [undefined, null, 7, '', 'mbrd', 'mbrd next', 'sketch 9.9', 'mbrd 1.2.3', { v: 2 }]) {
    assert.equal(newerWriter(app, '0.740'), null, String(app));
  }
});

test('the peek finds a newer writer, deflated or stored', async () => {
  assert.equal(await newerWriterOf(await archive('mbrd 999.1')), '999.1');
  assert.equal(await newerWriterOf(await archive('mbrd 999.1', { compress: false })), '999.1');
});

test('the peek passes a board of this version or older', async () => {
  const { blob } = await packBoard({ title: 'T', items: [], trash: [] });
  assert.equal(await newerWriterOf(blob), null);
  assert.equal(await newerWriterOf(await archive('mbrd v0.21')), null);
});

test('the peek answers null, never throws, on a file it cannot read', async () => {
  const good = await archive('mbrd 999.1');
  const cut = good.slice(0, good.size - 10);
  assert.equal(await newerWriterOf(cut), null, 'cut short');
  assert.equal(await newerWriterOf(new Blob([new Uint8Array(40)])), null, 'not a ZIP');
  assert.equal(await newerWriterOf(new Blob([])), null, 'empty');
  const noManifest = await writeZip([{ name: 'board.json', data: enc.encode('{"items":[]}') }]);
  assert.equal(await newerWriterOf(noManifest), null, 'no manifest');
  const notJson = await writeZip([{ name: 'manifest.json', data: enc.encode('{nope') }]);
  assert.equal(await newerWriterOf(notJson), null, 'manifest not JSON');
});

test('readZipEntry refuses what the whole readers refuse', async () => {
  const good = new Uint8Array(await (await archive('mbrd 1.0', { compress: false })).arrayBuffer());
  assert.ok(await readZipEntry(new Blob([good]), 'manifest.json', 4096));

  // An entry's local header moved past the end of the file.
  const past = good.slice();
  const view = new DataView(past.buffer);
  const eocd = past.length - 22;
  const cd = view.getUint32(eocd + 16, true);
  view.setUint32(cd + 42, past.length + 100, true);
  await assert.rejects(() => readZipEntry(new Blob([past]), 'manifest.json', 4096), /past the end/);

  // A checksum that does not match the bytes.
  const damaged = good.slice();
  new DataView(damaged.buffer).setUint32(cd + 16, 0xdeadbeef, true);
  await assert.rejects(() => readZipEntry(new Blob([damaged]), 'manifest.json', 4096), /checksum/);

  // Two entries under the one name.
  const twice = await writeZip([
    { name: 'manifest.json', data: enc.encode('{}') },
    { name: 'manifest.json', data: enc.encode('{"app":"mbrd 9.9"}') },
  ]);
  await assert.rejects(() => readZipEntry(twice, 'manifest.json', 4096), /appears twice/);
});

test('readZipEntry leaves an entry past its cap unread', async () => {
  const big = await writeZip([{ name: 'manifest.json', data: new Uint8Array(5000), compress: false }]);
  assert.equal(await readZipEntry(big, 'manifest.json', 4096), null);
  assert.equal(await readZipEntry(big, 'board.json', 4096), null, 'and an absent one');
});
