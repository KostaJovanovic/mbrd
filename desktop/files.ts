// File dialogs and read/write for .mbrd boards.
// A renderer cannot name a path. Every path here comes from a dialog, argv,
// open-file, trust.mts's file, or the boards folder (boards.ts); a rolling copy
// versions() listed may be read and never written. Anything else,
// a path the page stored included, is refused. An imported picture is read once
// and never becomes a path the page can write.

import { dialog, BrowserWindow } from 'electron';
import { readFile, readdir, stat, access, open as openFile } from 'node:fs/promises';
import { basename, join } from 'node:path';
import { writeAtomic } from './atomic.mts';
import { folderFor, keepBackup } from './backups.mts';
import { openTrust } from './trust.mts';
import type { Trust } from './trust.mts';
import {
  CATEGORIES, FAMILIES, EXT_FAMILY,
  PHOTO_EXTS, AUDIO_EXTS, VIDEO_EXTS, DOC_EXTS, SVG_EXTS,
} from '../web/assets/js/import/formats.ts';
import { log } from './log.ts';

export interface Ref {
  name: string;
  path: string;
}

export interface Handed {
  name: string;
  path: string;
  data: ArrayBuffer;
}

// Paths this process produced. Grows forever; never shrinks.
const known = new Set<string>();
/** The boards picked in earlier runs. Null until loadTrust(). */
let kept: Trust | null = null;
/** Whether a path is a board directly in the boards folder (boards.ts). */
let inBoardsFolder: (path: string) => boolean = () => false;

/** For this run only: a path main produced for its own reasons. */
export function vouch(path: unknown): void {
  if (typeof path === 'string' && path) known.add(path);
}

/** A path the person picked: a dialog, argv or open-file. A board stays
 *  trusted in later runs, which is what lets a shelf row outside the boards
 *  folder open after a restart. */
export function vouchPicked(path: unknown): void {
  vouch(path);
  if (typeof path === 'string') kept?.add(path);
}

/** Read the paths picked in earlier runs. Once, at boot, before the page asks. */
export async function loadTrust(file: string, legacyShelf: () => Promise<string[]>): Promise<void> {
  kept = await openTrust(file, legacyShelf, (message, detail) => log('warn', message, detail));
}

export function trustFolder(rule: (path: string) => boolean): void {
  inBoardsFolder = rule;
}

const trusted = (path: string) => known.has(path) || !!kept?.has(path) || inBoardsFolder(path);

function refuse(path: string): never {
  log('error', 'refused a path this process did not produce', { path });
  throw new Error('that file was not opened by this app');
}

export const checked = (path: unknown): string => {
  if (typeof path !== 'string' || !trusted(path)) refuse(String(path));
  return path;
};

const BOARD_FILTER = [{ name: 'mbrd board', extensions: ['mbrd'] }];

// Friendly names for three catalogue categories.
const OUR_WORD = new Map([
  ['images', 'Pictures'],
  ['audio', 'Sound'],
  ['video', 'Clips'],
]);

// Extensions that the app renders, grouped by category. Wider than the catalogue
// alone (includes aliases like .tif, .jpe that have no family entry).
const RENDERED = new Map([
  ['images', [PHOTO_EXTS, SVG_EXTS]],
  ['audio', [AUDIO_EXTS]],
  ['video', [VIDEO_EXTS]],
  ['documents', [DOC_EXTS]],
]);

// Build file-picker filters from the generated catalogue (import/formats.ts).
function importFilters() {
  const groups = new Map<string, Set<string>>();
  for (const key of Object.keys(CATEGORIES)) {
    groups.set(key, new Set<string>(RENDERED.get(key)?.flatMap(s => [...s])));
  }
  // A family names its category; the table addresses families by index.
  for (const [ext, family] of Object.entries(EXT_FAMILY)) {
    groups.get(FAMILIES[family].category)?.add(ext);
  }
  const named = [...groups].map(([key, exts]) => ({
    name: OUR_WORD.get(key) ?? CATEGORIES[key],
    extensions: [...exts].sort(),
  }));
  return [
    // First, so it is the one the dialog opens on - as the four sets' union was.
    { name: 'Everything mbrd knows', extensions: [...new Set(named.flatMap(g => g.extensions))].sort() },
    ...named,
    { name: 'All files', extensions: ['*'] },
  ];
}

/** Read a file into what the renderer can make a File out of. */
async function hand(path: string): Promise<Handed> {
  const raw = await readFile(path);
  // A copy, not a view onto Node's shared buffer pool - see the same note in
  // store.ts. Handing over `.buffer` would hand over whatever else was pooled
  // beside it.
  const data = new ArrayBuffer(raw.byteLength);
  new Uint8Array(data).set(raw);
  return { name: basename(path), path, data };
}

/**
 * A modal dialog where there is a window to be modal to.
 *
 * Two overloads rather than one with a nullable first argument, because a
 * sheet attached to the window is what makes it modal on macOS - and a dialog
 * that is not modal there is a dialog somebody can lose behind the app.
 */
function open(win: BrowserWindow | null, options: Electron.OpenDialogOptions) {
  return win ? dialog.showOpenDialog(win, options) : dialog.showOpenDialog(options);
}

// Both board dialogs start in the boards folder (boards.ts), which main hands in.
export async function pickOpen(win: BrowserWindow | null, home = ''): Promise<Handed | null> {
  const options: Electron.OpenDialogOptions = { properties: ['openFile'], filters: BOARD_FILTER };
  if (home) options.defaultPath = home;
  const { canceled, filePaths } = await open(win, options);
  const path = filePaths[0];
  if (canceled || !path) return null;
  vouchPicked(path);
  return hand(path);
}

export async function pickSave(win: BrowserWindow | null, suggested: unknown, home = ''): Promise<Ref | null> {
  const name = typeof suggested === 'string' ? basename(suggested) : 'board.mbrd';
  const options = {
    defaultPath: home ? join(home, name) : name,
    filters: BOARD_FILTER,
  };
  const { canceled, filePath } = win
    ? await dialog.showSaveDialog(win, options)
    : await dialog.showSaveDialog(options);
  if (canceled || !filePath) return null;
  vouchPicked(filePath);
  return { name: basename(filePath), path: filePath };
}

export async function pickImport(win: BrowserWindow | null): Promise<Handed[]> {
  const { canceled, filePaths } = await open(win, {
    properties: ['openFile', 'multiSelections'],
    filters: importFilters(),
  });
  if (canceled) return [];
  return Promise.all(filePaths.map(hand));
}

/**
 * Write the board, atomically.
 *
 * Temp file and a rename, for the reason store.ts gives at more length: a
 * truncated .mbrd is worse than an old one, because the old one still opens.
 * The temp file sits beside the target rather than in the system temp
 * directory, so the rename stays within one filesystem and stays atomic.
 */
export async function write(path: unknown, data: unknown): Promise<void> {
  const target = checked(path);
  if (!(data instanceof ArrayBuffer)) throw new Error('expected bytes to write');
  await backup(target);
  await writeAtomic(target, Buffer.from(data), target + '.mbrd-tmp', true);
}

/** Where the rolling copies go: .autosave/ in the boards folder, which for a
 *  portable copy is inside its data folder, so it keeps them beside it. */
let backupDir = '';

export function setBackupDir(dir: string): void {
  backupDir = dir;
}

/** For Help > Show Backups. Empty before main has set it. */
export const backupFolder = (): string => backupDir;

/** A copy of the file as it is, before a save changes it (backups.mts). Never blocks the save. */
async function backup(target: string): Promise<void> {
  if (!backupDir) return;
  try {
    const copy = await keepBackup(target, backupDir);
    if (copy) log('info', 'kept a backup', { copy });
  } catch (err) {
    log('warn', 'could not keep a backup', { target, err: String(err) });
  }
}

/** One rolling copy of a board, as the shelf's "Earlier versions" lists it. */
export interface Version {
  name: string;
  path: string;
  /** When the copy was taken, in ms since the epoch. */
  at: number;
  size: number;
}

/** Rolling copies handed to the page by versions(): read() takes them, and
 *  nothing that writes does, so the page can never overwrite a backup. */
const readOnly = new Set<string>();

/**
 * The rolling copies of one board (backups.mts), newest first. Each may be
 * read back through read(), and only read.
 */
export async function versions(path: unknown): Promise<Version[]> {
  const target = checked(path);
  if (!backupDir) return [];
  const folder = folderFor(backupDir, target);
  let names: string[];
  try {
    names = (await readdir(folder)).filter(n => n.endsWith('.mbrd'));
  } catch {
    return [];
  }
  const out: Version[] = [];
  for (const name of names) {
    const copy = join(folder, name);
    try {
      const s = await stat(copy);
      if (!s.isFile()) continue;
      readOnly.add(copy);
      out.push({ name, path: copy, at: s.mtimeMs, size: s.size });
    } catch {
      // Pruned between the listing and the look: one copy fewer.
    }
  }
  return out.sort((a, b) => b.at - a.at);
}

/**
 * Add a save's tail to the end of a board file (appendZip() in the page's
 * storage/zip.ts): the new and changed entries and a new directory, so a save
 * that changed one card writes one card's worth of bytes.
 *
 * Only onto a file exactly `at` bytes long, which is how long the page's last
 * write left it - anything else means the file changed under the page, and
 * the page writes it whole instead. A write that fails is cut back to `at`,
 * leaving the last save standing. A crash part way leaves a tail with no
 * directory after it, and the reader walks back past it to the save before.
 */
export async function append(path: unknown, data: unknown, at: unknown): Promise<void> {
  const target = checked(path);
  if (!(data instanceof ArrayBuffer)) throw new Error('expected bytes to write');
  if (typeof at !== 'number' || !Number.isSafeInteger(at) || at < 0) {
    throw new Error('expected the length the file had');
  }
  await backup(target);
  const handle = await openFile(target, 'r+');
  try {
    const { size } = await handle.stat();
    if (size !== at) throw new Error('the file changed on disk since it was last written');
    try {
      // A write may take fewer bytes than asked, on a full disk for one.
      const bytes = Buffer.from(data);
      let done = 0;
      while (done < bytes.byteLength) {
        const { bytesWritten } = await handle.write(bytes, done, bytes.byteLength - done, at + done);
        if (bytesWritten <= 0) throw new Error('the disk took no more of the save');
        done += bytesWritten;
      }
      await handle.sync();
    } catch (err) {
      await handle.truncate(at).catch(() => {});
      throw err;
    }
  } finally {
    await handle.close();
  }
}

/** A tail() longer than this is not a directory worth reading for. */
const TAIL_MAX = 64 * 1024 * 1024;

/**
 * A board's size and its last `length` bytes, all of it when shorter: the ZIP
 * directory, which the page reads the file's layout from (layoutFromTail() in
 * its storage/zip.ts), so the first save of a run need not write it whole.
 */
export async function tail(path: unknown, length: unknown): Promise<{ size: number, data: ArrayBuffer }> {
  const target = checked(path);
  if (typeof length !== 'number' || !Number.isSafeInteger(length) || length < 0 || length > TAIL_MAX) {
    throw new Error('expected a length to read');
  }
  const handle = await openFile(target, 'r');
  try {
    const { size } = await handle.stat();
    const n = Math.min(length, size);
    const data = new ArrayBuffer(n);
    const { bytesRead } = await handle.read(new Uint8Array(data), 0, n, size - n);
    if (bytesRead !== n) throw new Error('the file changed on disk while it was read');
    return { size, data };
  } finally {
    await handle.close();
  }
}

/** Read a document back. The shelf's file rows are the caller, and its
 *  "Earlier versions" (versions() above). */
export async function read(path: unknown): Promise<Handed> {
  if (typeof path === 'string' && readOnly.has(path)) return hand(path);
  return hand(checked(path));
}

/** Whether the file is still there. A shelf row that is not shows as missing. */
export async function exists(path: unknown): Promise<boolean> {
  if (typeof path !== 'string' || !trusted(path)) return false;
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}
