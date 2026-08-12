// Board title <-> file name, and nothing else.
//
// Pure string work, pulled out when storage.js was split so that both halves
// could have it without either owning it. A file name is picker-safe (spaces
// become underscores) and a title is not, and exports before v0.51 packed the
// picker-safe form back into board.json - which is why reading one is not
// simply stripping the extension, and why the manifest's `app` field is read
// here rather than left as decoration.

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
 * Not a guess. Up to and including v0.50, exportBoard() did
 * `setTitle(stripExt(fileHandle.name))` after the picker - so saving "my board"
 * to my_board.mbrd renamed the board itself to `my_board`, and every save after
 * that wrote the underscored form into board.json. v0.51 changed that one line
 * to titleFromFileName() and added the repair below. So the set of files whose
 * stored title may be a filename in disguise is exactly "written before 0.51",
 * and manifest.json has recorded which build wrote each file all along.
 */
const PACKED_TITLES_BEFORE: [number, number] = [0, 51];

/**
 * The title an opened file should carry.
 *
 * The stored title wins and is taken as typed - underscores included, because
 * cleanBoardTitle() permits them and a board somebody named `my_board` is named
 * `my_board`. The repair runs on the filename branch, where the mapping is this
 * module's own, and on stored titles from a build old enough to have packed one.
 *
 * It used to run over every stored title unconditionally, and that was the
 * defect: a deliberate `my_board` came back as `my board` the first time it was
 * reopened and stayed that way, because the load marks the change durable. The
 * first fix narrowed it to a stored title identical to the file's own base name,
 * which is the shape a packed filename has - but it is also the shape of every
 * ordinary board saved under its suggested name, so the commonest case in the
 * app went on being rewritten. Reading `app` settles it outright.
 *
 * A file whose manifest names no build it not repaired. Nothing this app has
 * ever written lacks the field, so the only way to arrive here is by hand, and a
 * hand-made title is one to believe.
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
