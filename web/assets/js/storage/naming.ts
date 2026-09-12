// Board title <-> file name. Pure string work, split out of storage.ts.
// Spaces → underscores for the file system; reading back is not just stripping
// the extension because underscores may be intentional.

import { cleanBoardTitle } from '../state.ts';

export function fileNameFor(title: string): string {
  const base = cleanBoardTitle(title) || 'board';
  return base.replace(/\.mbrd$/i, '').replace(/ /g, '_') + '.mbrd';
}

export function titleFromFileName(name: string): string {
  return stripExt(name).replace(/_/g, ' ');
}

/** Builds before this version packed the underscored filename into board.json
 *  as the title (v0.51 fixed it). manifest.json's `app` field identifies these. */
const PACKED_TITLES_BEFORE: [number, number] = [0, 51];

/** Title for an opened file. Stored title wins (underscores are intentional).
 *  Only old builds that packed the filename get underscore→space repair. */
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
