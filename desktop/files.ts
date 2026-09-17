// File dialogs and read/write for .mbrd boards.
// A renderer cannot name a path. Every path here comes from a dialog, argv,
// open-file, the store, or the boards folder (boards.ts). Anything else is refused.

import { dialog, BrowserWindow } from 'electron';
import { readFile, writeFile, rename, access, open as openFile } from 'node:fs/promises';
import { basename, join } from 'node:path';
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

// Paths this process produced (dialog, argv, store). Grows forever; never shrinks.
const known = new Set<string>();

export function vouch(path: unknown): void {
  if (typeof path === 'string' && path) known.add(path);
}

function refuse(path: string): never {
  log('error', 'refused a path this process did not produce', { path });
  throw new Error('that file was not opened by this app');
}

export const checked = (path: unknown): string => {
  if (typeof path !== 'string' || !known.has(path)) refuse(String(path));
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
  vouch(path);
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
  vouch(filePath);
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
  const tmp = target + '.mbrd-tmp';
  await writeFile(tmp, Buffer.from(data));
  await rename(tmp, target);
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
  const handle = await openFile(target, 'r+');
  try {
    const { size } = await handle.stat();
    if (size !== at) throw new Error('the file changed on disk since it was last written');
    try {
      await handle.write(Buffer.from(data), 0, data.byteLength, at);
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

/** Read a document back. The shelf's file rows are the caller. */
export async function read(path: unknown): Promise<Handed> {
  return hand(checked(path));
}

/** Whether the file is still there. A shelf row that is not shows as missing. */
export async function exists(path: unknown): Promise<boolean> {
  if (typeof path !== 'string' || !known.has(path)) return false;
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}
