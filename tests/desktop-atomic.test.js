// The desktop's atomic write (desktop/atomic.mts): a temp file flushed to the
// disk before the rename, so a power loss cannot keep the rename and lose the
// bytes. The flush itself cannot be seen from a test; what can be held is that
// the result is right and that every writer of a board or a store value goes
// through this one function.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { writeAtomic } from '../desktop/atomic.mts';

const DESKTOP = join(import.meta.dirname, '..', 'desktop');

test('a write replaces the file whole and leaves no temp file', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'mbrd-atomic-'));
  try {
    const target = join(dir, 'a.mbrd');
    writeFileSync(target, 'old and longer');
    await writeAtomic(target, Buffer.from('new'), target + '.mbrd-tmp', true);
    assert.equal(readFileSync(target, 'utf8'), 'new');
    await writeAtomic(target, 'text', target + '.tmp');
    assert.equal(readFileSync(target, 'utf8'), 'text');
    assert.deepEqual(readdirSync(dir), ['a.mbrd']);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a write into a missing folder fails and keeps nothing', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'mbrd-atomic-'));
  try {
    const target = join(dir, 'gone', 'a.mbrd');
    await assert.rejects(writeAtomic(target, 'x', target + '.tmp'));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('every board and store write goes through writeAtomic', () => {
  for (const file of ['files.ts', 'boards.ts', 'store.ts']) {
    const src = readFileSync(join(DESKTOP, file), 'utf8');
    assert.match(src, /import \{ writeAtomic \} from '\.\/atomic\.mts';/, file);
    assert.doesNotMatch(src, /\bwriteFile\(/, `${file} writes a file without the flush`);
  }
});
