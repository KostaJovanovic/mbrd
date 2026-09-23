// The boards folder. Every board on this computer is a .mbrd file, and the page
// lists this folder, makes a board in it, renames one and moves one to the bin.
// Documents/mbrd, or boards/ in the data folder of a portable copy or of a run
// given --user-data-dir, so neither writes outside its own folder. A board
// directly in the folder is one the page may name (isFolderBoard). The names
// and that rule come from board-names.mts.

import { app, shell } from 'electron';
import { access, mkdir, readdir, rename as move, stat } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
import { writeAtomic } from './atomic.mts';
import { isFolderBoard, nthName, plainName } from './board-names.mts';
import { checked, trustFolder, vouch } from './files.ts';
import type { Ref } from './files.ts';
import { log } from './log.ts';

let root = '';

/** Choose the folder. Called once after `ready`. `inData` keeps it inside the
 *  data folder: a portable copy promises to leave the computer as it found it. */
export function chooseFolder(inData: boolean): string {
  root = join(app.getPath('userData'), 'boards');
  if (!inData) {
    try {
      root = join(app.getPath('documents'), 'mbrd');
    } catch (err) {
      log('warn', 'no Documents folder, so the boards stay in the data folder', { err: String(err) });
    }
  }
  // The page may name a board here before it lists the folder: a start
  // reopens the board it closed on.
  trustFolder(path => isFolderBoard(path, root));
  return root;
}

export const folder = () => root;

// Windows and macOS match names without case, so two spellings name one file.
const fold = (path: string) => (process.platform === 'linux' ? path : path.toLowerCase());
const same = (a: string, b: string) => fold(a) === fold(b);
const inFolder = (path: string) => same(dirname(path), root);

const refOf = (path: string): Ref => ({ name: basename(path), path });

async function there(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

/** The first free path for `name`. `self` is the file being renamed, and its
 *  own name does not count as taken. */
async function freePath(name: string, self = ''): Promise<string> {
  for (let n = 1; n <= 999; n++) {
    const path = join(root, nthName(name, n));
    if ((self && same(path, self)) || !(await there(path))) return path;
  }
  throw new Error('the boards folder has too many boards with that name');
}

// One change at a time, so two new boards never take the same free name.
let queue: Promise<unknown> = Promise.resolve();
function inTurn<T>(work: () => Promise<T>): Promise<T> {
  const run = queue.then(work);
  queue = run.catch(() => {});
  return run;
}

/** The folder and the boards in it, made if it is missing. Hidden files and
 *  the temp files of a write (`.mbrd-tmp`) are not boards. */
export async function list(): Promise<{ folder: string, files: (Ref & { at: number })[] }> {
  await mkdir(root, { recursive: true });
  const files: (Ref & { at: number })[] = [];
  for (const entry of await readdir(root, { withFileTypes: true })) {
    if (!entry.isFile() || entry.name.startsWith('.') || !/\.mbrd$/i.test(entry.name)) continue;
    const path = join(root, entry.name);
    try {
      const { mtimeMs } = await stat(path);
      vouch(path);
      files.push({ ...refOf(path), at: mtimeMs });
    } catch {
      // Gone between the listing and the stat.
    }
  }
  return { folder: root, files };
}

/** A new board file under the first free name like `suggested`. */
export function create(suggested: unknown, data: unknown): Promise<Ref> {
  if (!(data instanceof ArrayBuffer)) return Promise.reject(new Error('expected bytes to write'));
  return inTurn(async () => {
    await mkdir(root, { recursive: true });
    const path = await freePath(plainName(suggested));
    // The temp file and the rename of files.ts's write: a board is whole or absent.
    await writeAtomic(path, Buffer.from(data), path + '.mbrd-tmp', true);
    vouch(path);
    log('info', 'board made in the folder', { path });
    return refOf(path);
  });
}

/** Rename a board in the folder. A file elsewhere keeps its name, and the
 *  answer is null: it is somebody's own file, where they put it. */
export function rename(path: unknown, suggested: unknown): Promise<Ref | null> {
  const from = checked(path);
  if (!inFolder(from)) return Promise.resolve(null);
  return inTurn(async () => {
    const to = await freePath(plainName(suggested), from);
    if (same(to, from)) return refOf(from);
    await move(from, to);
    vouch(to);
    log('info', 'board renamed', { from, to });
    return refOf(to);
  });
}

/** Move a board in the folder to the bin, where it can still be restored. */
export async function trash(path: unknown): Promise<void> {
  const file = checked(path);
  if (!inFolder(file)) throw new Error('only a board in the boards folder goes to the bin from here');
  await shell.trashItem(file);
  log('info', 'board moved to the bin', { path: file });
}

/** Open the folder in the file manager. */
export async function reveal(): Promise<void> {
  await mkdir(root, { recursive: true });
  const err = await shell.openPath(root);
  if (err) throw new Error(err);
}
