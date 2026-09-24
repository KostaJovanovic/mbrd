// Which paths the desktop's main process lets the page name in a later run
// (desktop/trust.mts). A page script that finds an XSS can write any value
// into the store, so the page's shelf index must never make a path trusted.
// The shelf is read once, on the first run with no trust file, so a board
// saved outside the boards folder before the upgrade still opens.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import { openTrust, keepable, shelfPaths } from '../desktop/trust.mts';

const DESKTOP = join(import.meta.dirname, '..', 'desktop');
const quiet = () => {};

function scratch(fn) {
  return async () => {
    const dir = mkdtempSync(join(tmpdir(), 'mbrd-trust-'));
    try {
      await fn(dir);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  };
}

const board = name => resolve('/home/someone/Desktop', name);

test('only a board named in full is kept', () => {
  assert.ok(keepable(board('a.mbrd')));
  assert.ok(keepable(board('A.MBRD')));
  assert.ok(!keepable('a.mbrd'), 'relative');
  assert.ok(!keepable(board('run.bat')));
  assert.ok(!keepable(board('x.mbrd-tmp')));
  assert.ok(!keepable(42));
});

test('the first run carries the shelf\'s board rows over, once', scratch(async dir => {
  const file = join(dir, 'trusted-files.json');
  const shelf = [
    { id: 'a', path: board('a.mbrd') },
    { id: 'b', path: board('Startup/x.bat') },
    { id: 'c', path: 'relative.mbrd' },
    { id: 'd' },
    null,
  ];
  assert.deepEqual(shelfPaths(shelf), [board('a.mbrd')]);
  assert.deepEqual(shelfPaths({ path: board('a.mbrd') }), []);
  const first = await openTrust(file, async () => shelfPaths(shelf), quiet);
  await first.settled();
  assert.ok(first.has(board('a.mbrd')));
  assert.ok(!first.has(board('Startup/x.bat')));
  assert.ok(!first.has('relative.mbrd'));
  assert.deepEqual(JSON.parse(readFileSync(file, 'utf8')).paths, [board('a.mbrd')]);

  // The page writes a new row after the upgrade: it is never read again.
  let asked = 0;
  const later = await openTrust(file, async () => { asked++; return [board('planted.mbrd')]; }, quiet);
  assert.equal(asked, 0);
  assert.ok(later.has(board('a.mbrd')));
  assert.ok(!later.has(board('planted.mbrd')));
}));

test('an empty first run still writes the file, so the shelf is read once', scratch(async dir => {
  const file = join(dir, 'trusted-files.json');
  await (await openTrust(file, async () => shelfPaths(undefined), quiet)).settled();
  let asked = 0;
  await openTrust(file, async () => { asked++; return []; }, quiet);
  assert.equal(asked, 0);
}));

test('a picked board is kept for the next run, and nothing else is', scratch(async dir => {
  const file = join(dir, 'trusted-files.json');
  const trust = await openTrust(file, async () => [], quiet);
  trust.add(board('picked.mbrd'));
  trust.add(board('export.png'));
  trust.add(board('picked.mbrd'));
  await trust.settled();
  const next = await openTrust(file, async () => [], quiet);
  assert.ok(next.has(board('picked.mbrd')));
  assert.ok(!next.has(board('export.png')));
}));

test('an unreadable trust file trusts nothing and does not read the shelf again', scratch(async dir => {
  const file = join(dir, 'trusted-files.json');
  writeFileSync(file, '{"v":1,"paths":[');
  const warned = [];
  let asked = 0;
  const trust = await openTrust(file, async () => { asked++; return [board('a.mbrd')]; }, m => warned.push(m));
  assert.equal(asked, 0);
  assert.ok(!trust.has(board('a.mbrd')));
  assert.equal(warned.length, 1);
}));

test('main trusts no path from the page\'s store, and only the board relaunches', () => {
  const main = readFileSync(join(DESKTOP, 'main.ts'), 'utf8');
  const files = readFileSync(join(DESKTOP, 'files.ts'), 'utf8');
  // The one read of the shelf is the carry-over handed to loadTrust().
  assert.equal([...main.matchAll(/library-index/g)].length, 1);
  assert.match(main, /files\.loadTrust\(\s*join\(app\.getPath\('userData'\), 'trusted-files\.json'\),\s*async \(\) => shelfPaths\(await store\.get\('kv', 'library-index'\)\),/);
  assert.match(main, /ipcMain\.on\('app:relaunch', event => \{\s*if \(event\.sender !== appContents\(\)\) return;/);
  // An imported picture is read, and never becomes a path the page can write.
  const hand = /async function hand\([\s\S]*?\n\}/.exec(files)[0];
  assert.doesNotMatch(hand, /vouch/);
  const pickImport = /export async function pickImport\([\s\S]*?\n\}/.exec(files)[0];
  assert.doesNotMatch(pickImport, /vouch/);
});
