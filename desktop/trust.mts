// The board files main lets the page name across runs, kept in a file that
// only main writes (userData/trusted-files.json, outside the store). A path
// joins from a dialog, argv or open-file, never from a value the page stored:
// the page can write any value there, and so could name any file.
// Pure Node with no `app`, like format.mts, so the root suite runs it.

import { readFile } from 'node:fs/promises';
import { isAbsolute } from 'node:path';
import { writeAtomic } from './atomic.mts';

export interface Trust {
  has(path: string): boolean;
  /** Keep `path` for later runs. Only a board file is kept. */
  add(path: string): void;
  /** Resolves when every add so far is on the disk. */
  settled(): Promise<void>;
}

type Warn = (message: string, detail: Record<string, unknown>) => void;

/** A board file, named in full. A picture saved from the page, or a relative
 *  path from somewhere that forgot its folder, never outlives the run. */
export const keepable = (path: unknown): path is string =>
  typeof path === 'string' && isAbsolute(path) && /\.mbrd$/i.test(path);

/** The board paths in an old shelf index (the page's kv/library-index). */
export function shelfPaths(index: unknown): string[] {
  if (!Array.isArray(index)) return [];
  const out: string[] = [];
  for (const row of index) {
    if (!row || typeof row !== 'object' || !('path' in row)) continue;
    // SAFETY: an object with a path key, and keepable() checks the value.
    const path = (row as { path?: unknown }).path;
    if (keepable(path)) out.push(path);
  }
  return out;
}

/**
 * Read the kept paths. With no file yet this is the first run since the file
 * came in, and the shelf's board rows are taken once, so a board somebody
 * saved outside the boards folder still opens. From then on the shelf is
 * never read for trust again.
 */
export async function openTrust(file: string, legacyShelf: () => Promise<string[]>, warn: Warn): Promise<Trust> {
  const kept = new Set<string>();
  let text: string | null = null;
  try {
    text = await readFile(file, 'utf8');
  } catch (err) {
    // SAFETY: read for one field that is compared, not trusted.
    if ((err as { code?: unknown } | null)?.code !== 'ENOENT') {
      warn('could not read the trusted files', { err: String(err) });
      text = '';
    }
  }

  let chain: Promise<void> = Promise.resolve();
  let queued = false;
  const save = () => {
    if (queued) return;
    queued = true;
    chain = chain.then(async () => {
      queued = false;
      await writeAtomic(file, JSON.stringify({ v: 1, paths: [...kept] }), file + '.tmp', true);
    }).catch(err => warn('could not keep the trusted files', { err: String(err) }));
  };

  if (text === null) {
    let carried: string[] = [];
    try {
      carried = await legacyShelf();
    } catch (err) {
      warn('could not read the shelf to carry its files over', { err: String(err) });
    }
    for (const path of carried) if (keepable(path)) kept.add(path);
    // Written even when empty: the file's presence is what ends the carry-over.
    save();
  } else if (text) {
    try {
      const parsed: unknown = JSON.parse(text);
      // SAFETY: a JSON value, read for one field whose entries keepable() checks.
      const paths: unknown = (parsed as { paths?: unknown } | null)?.paths;
      if (Array.isArray(paths)) for (const path of paths) if (keepable(path)) kept.add(path);
    } catch (err) {
      // Not carried over again: that would trust what the page wrote since.
      warn('the trusted files could not be read, so none are trusted', { err: String(err) });
    }
  }

  return {
    has: path => kept.has(path),
    add(path) {
      if (!keepable(path) || kept.has(path)) return;
      kept.add(path);
      save();
    },
    settled: () => chain,
  };
}
