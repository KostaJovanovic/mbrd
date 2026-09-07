// Dialogs, and the reading and writing of the file a board is.
//
// The half of FilesPort that has to be here rather than in the renderer, for
// one reason stated in main.ts's header and worth repeating where the paths
// actually are: **a renderer cannot name a path.** Every path in this process
// comes from a dialog this process opened or from argv, and every function
// below either produces one or is handed one it produced earlier. Nothing here
// takes a filename from the page and opens it.
//
// That is not a theoretical boundary. The app's whole job is opening documents
// somebody else wrote - a .mbrd is a renamed ZIP anybody can hand-edit - and
// the renderer parses all of them. A bridge function that read an arbitrary
// path would turn a parser bug into a file-disclosure bug.

import { dialog, BrowserWindow } from 'electron';
import { readFile, writeFile, rename, access } from 'node:fs/promises';
import { basename } from 'node:path';
import {
  CATEGORIES, FAMILIES, EXT_FAMILY,
  PHOTO_EXTS, AUDIO_EXTS, VIDEO_EXTS, DOC_EXTS, SVG_EXTS,
} from '../web/assets/js/import/formats.ts';
import { log } from './log.ts';

/** What a document is on this side: a name and the path that produced it. */
export interface Ref {
  name: string;
  path: string;
}

/** A file on its way to the renderer. The bytes travel; the path does not. */
export interface Handed {
  name: string;
  path: string;
  data: ArrayBuffer;
}

/**
 * Paths this process has handed out or been given.
 *
 * The other half of "a renderer cannot name a path". A ref crosses the bridge
 * with its path on it - the shelf's file rows need one to show, and the title
 * bar needs one to display - so the path does come back on the next write. This
 * set is what makes that safe: a path that arrives from the renderer is only
 * honoured if this process produced it. A page that invented one gets a
 * refusal, not a write.
 *
 * Three things legitimately put a path in here, and they are the three the plan
 * names: a dialog this process opened, a file the OS handed over (argv, or
 * macOS's open-file), and **the store**. That third one is not a loophole and
 * is easy to miss: the shelf's file rows outlive the process that made them, so
 * a board shelved yesterday arrives this morning as a path no dialog produced.
 * Those paths come out of userData, which this process owns and the renderer
 * cannot write to except through the store bridge - so they are as much this
 * process's own as the dialog's are. See vouchShelf() in main.ts.
 *
 * It grows for the life of the process and never shrinks, which is correct: a
 * board opened an hour ago is still a board this app may be asked to save.
 */
const known = new Set<string>();

/** Remember a path as ours. Called wherever one legitimately enters. */
export function vouch(path: unknown): void {
  if (typeof path === 'string' && path) known.add(path);
}

function refuse(path: string): never {
  log('error', 'refused a path this process did not produce', { path });
  throw new Error('that file was not opened by this app');
}

const checked = (path: unknown): string => {
  if (typeof path !== 'string' || !known.has(path)) refuse(String(path));
  return path;
};

/** The .mbrd filter, the one filter this app has for its own documents. */
const BOARD_FILTER = [{ name: 'mbrd board', extensions: ['mbrd'] }];

/**
 * The three categories mbrd has a word of its own for.
 *
 * The catalogue's labels are a catalogue's - Images, Audio, Video - and three
 * of them name things this app calls something else everywhere a person reads
 * them. The other nine it has no word for, and inventing nine here would be a
 * second vocabulary kept in a file about paths.
 */
const OUR_WORD = new Map([
  ['images', 'Pictures'],
  ['audio', 'Sound'],
  ['video', 'Clips'],
]);

/**
 * The routing sets, folded into the category each belongs to.
 *
 * Not redundancy, twice over.
 *
 * The catalogue does not contain all of them. `tif`, `jpe`, `heics`, `heifs`,
 * `aif`, `aifc`, `oga`, `wave`, `weba` and `m4v` are in the sets that decide
 * what gets *drawn* and in no family in the table, so a group built from the
 * table alone would be narrower than the app for the four kinds it actually
 * renders - a picker offering `.tiff` and not `.tif`.
 *
 * And `DOC_EXTS` straddles two categories: two thirds of it - `js`, `json`,
 * `py`, `csv` - is filed under Data & code rather than Documents, which is
 * where the table is right and where somebody who used the old Documents
 * filter to find a `.json` would stop finding it. Folding it back in costs a
 * few extensions listed under two groups, which nobody can see, and keeps that
 * group from narrowing under a person who was already using it.
 *
 * `svg` is the opposite case: one extension, filed under Design, which is right
 * about what it is and no help to somebody opening the picker to find a
 * picture. It is in both.
 */
const RENDERED = new Map([
  ['images', [PHOTO_EXTS, SVG_EXTS]],
  ['audio', [AUDIO_EXTS]],
  ['video', [VIDEO_EXTS]],
  ['documents', [DOC_EXTS]],
]);

/**
 * What Add files will show.
 *
 * Built from the generated catalogue rather than typed out - see
 * import/formats.ts, which is regenerated by tools/gen-formats.mjs and knows
 * about 1359 extensions across twelve categories. A list retyped here would be
 * a second answer to "what can this app open", and it would be wrong within a
 * release.
 *
 * One group per catalogue category, in the catalogue's order, under the
 * catalogue's label. That is the widening: this used to be the four *routing*
 * sets, which are the extensions a browser can draw, and a routing set is a
 * much smaller thing than a category - 48 pictures against 111, and nine of the
 * twelve categories had no group at all. A `.svg`, a `.stl`, a `.psd` and a
 * `.zip` were in no filter here, and the app draws the first two.
 *
 * `All files` is last and is not a courtesy: the app draws a named card for a
 * format it cannot render, which is often the point of putting one on a board,
 * and a picker that hid those would be narrower than the app.
 */
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

export async function pickOpen(win: BrowserWindow | null): Promise<Handed | null> {
  const { canceled, filePaths } = await open(win, {
    properties: ['openFile'],
    filters: BOARD_FILTER,
  });
  const path = filePaths[0];
  if (canceled || !path) return null;
  return hand(path);
}

export async function pickSave(win: BrowserWindow | null, suggested: unknown): Promise<Ref | null> {
  const options = {
    defaultPath: typeof suggested === 'string' ? suggested : 'board.mbrd',
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
