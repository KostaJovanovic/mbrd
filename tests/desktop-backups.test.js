// desktop/backups.mts: one copy per interval, the newest KEEP, and nothing for a
// board that is not on disk yet. Run against a real temporary folder.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readdir, rm, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { keepBackup, folderFor, INTERVAL_MS, KEEP } from '../desktop/backups.mts';

async function scratch(body) {
  const dir = await mkdtemp(join(tmpdir(), 'mbrd-backups-'));
  try { await body(dir); } finally { await rm(dir, { recursive: true, force: true }); }
}

test('a board not yet on disk keeps nothing', () => scratch(async dir => {
  assert.equal(await keepBackup(join(dir, 'none.mbrd'), join(dir, 'backups')), null);
}));

test('one copy per interval, however often it saves', () => scratch(async dir => {
  const board = join(dir, 'Kitchen.mbrd');
  const into = join(dir, 'backups');
  await writeFile(board, 'one');
  const t0 = Date.now();
  const first = await keepBackup(board, into, t0);
  assert.ok(first);
  assert.equal(await keepBackup(board, into, t0 + 1000), null, 'too soon');
  // The interval is read off the copy's own time, so age it rather than wait.
  await utimes(first, (t0 - INTERVAL_MS - 1) / 1000, (t0 - INTERVAL_MS - 1) / 1000);
  assert.ok(await keepBackup(board, into, t0 + 2000), 'past the interval');
  assert.equal((await readdir(folderFor(into, board))).length, 2);
}));

test('only the newest KEEP stay', () => scratch(async dir => {
  const board = join(dir, 'Kitchen.mbrd');
  const into = join(dir, 'backups');
  await writeFile(board, 'bytes');
  const folder = folderFor(into, board);
  let at = Date.UTC(2026, 0, 1);
  for (let i = 0; i < KEEP + 3; i++) {
    const copy = await keepBackup(board, into, at);
    assert.ok(copy, `copy ${i}`);
    await utimes(copy, (at - INTERVAL_MS * 2) / 1000, (at - INTERVAL_MS * 2) / 1000);
    at += INTERVAL_MS * 2;
  }
  const left = (await readdir(folder)).sort();
  assert.equal(left.length, KEEP);
  // Copies every half hour from midnight: 00:00, 00:30 and 01:00 went.
  assert.match(left[0], /^2026-01-01T01-30/, 'the three oldest went');
}));

test('two boards with one name keep apart', () => {
  assert.notEqual(folderFor('/b', '/one/Kitchen.mbrd'), folderFor('/b', '/two/Kitchen.mbrd'));
});
