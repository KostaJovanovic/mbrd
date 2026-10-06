// Rolling backups of each board file, taken before a save overwrites it. In the
// apps the file is the only copy, and atomic writes guard a torn save but not a
// whole save of something wrong. At most one copy per board per INTERVAL_MS, the
// newest KEEP of them, and never so many that a big board fills the disk.
// Plain node:fs, no Electron, so tests/desktop-backups.test.js runs it as is.

import { copyFile, mkdir, readdir, stat, unlink } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { basename, join } from 'node:path';

/** A save every few seconds would otherwise copy the board every few seconds. */
export const INTERVAL_MS = 15 * 60 * 1000;
export const KEEP = 10;
/** All of one board's copies together stay under this, the newest two aside. */
export const BUDGET_BYTES = 2 * 1024 ** 3;
const MIN_KEEP = 2;

/** One folder per board file: its name, and a hash of its path so two boards
 *  named alike in different folders keep apart. */
export function folderFor(dir: string, target: string): string {
  const name = basename(target).replace(/\.mbrd$/i, '').replace(/[^\p{L}\p{N} _-]+/gu, '').trim().slice(0, 40) || 'board';
  const tag = createHash('sha256').update(target).digest('hex').slice(0, 8);
  return join(dir, `${name}-${tag}`);
}

/** A file name that sorts by time and is legal on every system. */
const stampOf = (at: number) => new Date(at).toISOString().replace(/[:.]/g, '-') + '.mbrd';

/**
 * Copy `target` into its backup folder under `dir`, unless the newest copy is
 * younger than INTERVAL_MS, then drop the oldest past KEEP and BUDGET_BYTES.
 * Resolves to the copy it made, or null. A board not yet on disk has nothing to
 * keep. Throws only on a failed copy, which the caller logs and saves anyway.
 */
export async function keepBackup(target: string, dir: string, now = Date.now()): Promise<string | null> {
  let size: number;
  try {
    size = (await stat(target)).size;
  } catch {
    return null;
  }
  if (size === 0) return null;
  const folder = folderFor(dir, target);
  await mkdir(folder, { recursive: true });
  const names = (await readdir(folder)).filter(n => n.endsWith('.mbrd')).sort();
  const newest = names.at(-1);
  if (newest) {
    const at = (await stat(join(folder, newest))).mtimeMs;
    if (now - at < INTERVAL_MS) return null;
  }
  const copy = join(folder, stampOf(now));
  await copyFile(target, copy);
  names.push(basename(copy));
  await prune(folder, names);
  return copy;
}

/** Oldest first out, until both limits hold. `names` is sorted, oldest first. */
async function prune(folder: string, names: string[]): Promise<void> {
  const sizes = await Promise.all(names.map(n => stat(join(folder, n)).then(s => s.size, () => 0)));
  let total = sizes.reduce((a, b) => a + b, 0);
  for (let i = 0; i < names.length; i++) {
    const left = names.length - i;
    if (left <= MIN_KEEP) break;
    if (left <= KEEP && total <= BUDGET_BYTES) break;
    await unlink(join(folder, names[i])).catch(() => {});
    total -= sizes[i];
  }
}
