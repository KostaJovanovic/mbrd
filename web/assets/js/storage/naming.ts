// Board title <-> file name, and nothing else.
//
// Pure string work, split out of storage.ts so both halves could have it. A
// file name is picker-safe (spaces become underscores) and a title is not,
// which is why reading a title back is not stripping the extension.

import { cleanBoardTitle } from '../state.ts';

export function fileNameFor(title: string): string {
  const base = cleanBoardTitle(title) || 'board';
  return base.replace(/\.mbrd$/i, '').replace(/ /g, '_') + '.mbrd';
}

export function titleFromFileName(name: string): string {
  return stripExt(name).replace(/_/g, ' ');
}

/**
 * The last build that packed the picker-safe filename into board.json.
 *
 * Up to v0.50, exportBoard() did `setTitle(stripExt(fileHandle.name))` after
 * the picker, renaming the board itself, so every save after wrote the
 * underscored form. v0.51 switched to titleFromFileName(), and manifest.json
 * records which build wrote each file - which is what makes `app` worth
 * reading rather than decoration.
 */
const PACKED_TITLES_BEFORE: [number, number] = [0, 51];

/**
 * The title an opened file should carry.
 *
 * The stored title wins, taken as typed - cleanBoardTitle() permits
 * underscores, so a board named `my_board` keeps that name. Underscores go
 * back to spaces only on the filename branch, whose mapping is this module's
 * own, and on stored titles old enough to have packed one.
 *
 * Do not widen it. Over every stored title, a deliberate `my_board` came back
 * as `my board` on reopen and stayed - the load marks it durable. Narrowing
 * instead to "stored title equals the file's base name" rewrote every board
 * saved under its suggested name, the same shape. A manifest naming no build
 * is not repaired - nothing this app writes lacks the field, so such a title
 * was made by hand and is one to believe.
 */
export function titleForOpenedBoard(
  storedTitle: unknown, fileName: string, writtenBy: unknown = '',
): string {
  const stored = typeof storedTitle === 'string' && storedTitle ? storedTitle : '';
  if (!stored) return titleFromFileName(fileName);
  return packedFilenames(writtenBy) ? stored.replace(/_/g, ' ') : stored;
}

/** Whether `app` names a build from before the packing stopped. See above. */
function packedFilenames(app: unknown): boolean {
  const m = /^mbrd\s+v?(\d+)\.(\d+)/i.exec(typeof app === 'string' ? app : '');
  if (!m) return false;
  const [major, minor] = [+m[1], +m[2]];
  const [limitMajor, limitMinor] = PACKED_TITLES_BEFORE;
  return major < limitMajor || (major === limitMajor && minor < limitMinor);
}

function stripExt(name: string): string {
  return name.replace(/\.mbrd$/i, '');
}
