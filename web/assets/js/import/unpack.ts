// Unzip and Open. An archive card or a folder card gives way to what it holds:
// on the canvas in a spiral round where it sat, on the Feed in its place in the
// column, as one undo step with the card's leaving (replaceItem() in state.ts).
// What is inside is imported like any drop, so a picture out of a ZIP lands as
// the same card a picture dropped on its own would, and an archive inside the
// archive lands as another archive card.

import { byId } from '../state.ts';
import { toast, busy } from '../notify.ts';
import { lift, fileKey, isOversize, mb } from '../consent.ts';
import { getAsset } from '../storage/assets.ts';
import { extOf, isHash, isRecord } from '../util.ts';
import type { Item } from '../board-model.ts';
import { readArchive, children, type ArchiveFile } from './archive.ts';
import { importFiles, folderDraft, type Incoming } from './drop.ts';

/** Cards being opened now. A second press while the first is reading does nothing. */
const opening = new Set<string>();

const str = (v: unknown) => (typeof v === 'string' ? v : '');

/** Unzip an archive card, or open a folder card. */
export async function unpackItem(id: string) {
  const item = byId(id);
  if (!item || (item.type !== 'archive' && item.type !== 'folder') || opening.has(id)) return;
  const archive = item.type === 'archive';
  opening.add(id);
  try {
    const job = busy(archive ? 'Unzipping' : 'Opening');
    let inside: Incoming[] | null;
    try {
      inside = await contents(item);
    } catch (err) {
      console.error('[mbrd] could not open', item.name, err);
      const why = err instanceof Error ? err.message.slice(0, 80) : '';
      toast(`${item.name} could not be opened${why ? ` - ${why}` : ''}`, 'error');
      return;
    } finally {
      job.end();
    }
    // Null is a ceiling somebody said no to, which needs no second word.
    if (!inside) return;
    if (!inside.length) {
      toast(`There is nothing inside ${item.name}`);
      return;
    }
    await importFiles(inside, { x: item.x, y: item.y }, {
      replace: { id, label: archive ? 'Unzip' : 'Open folder', verb: archive ? 'Unzipped' : 'Opened' },
    });
  } finally {
    opening.delete(id);
  }
}

/**
 * What one level of the card holds: each file there as a File, and each
 * folder as a folder card. Null when a ceiling was declined.
 */
async function contents(item: Item): Promise<Incoming[] | null> {
  const meta = item.meta || {};
  if (item.type === 'folder' && Array.isArray(meta.files)) return diskContents(meta.files);
  // An archive card holds its archive; a folder out of one points into it.
  const hash = item.type === 'archive' ? item.asset?.hash : meta.archive;
  const asset = typeof hash === 'string' ? getAsset(hash) : undefined;
  if (!asset || typeof hash !== 'string') throw new Error('its archive is missing from this board');
  const name = item.type === 'archive' ? archiveName(item, asset.name) : str(meta.archiveName) || asset.name;
  const files = await readConsenting(asset.blob, name);
  if (!files) return null;
  const data = new Map(files.map(f => [f.path, f.data]));
  const prefix = item.type === 'folder' ? str(meta.path) : '';
  return children(files.map(f => f.path), prefix).flatMap((child): Incoming[] => {
    if (child.kind === 'folder') {
      return [folderDraft(child.name, { archive: hash, archiveName: name, path: child.path, count: child.count })];
    }
    const bytes = data.get(child.path);
    return bytes ? [new File([bytes], child.name, { type: bytes.type })] : [];
  });
}

/**
 * The archive's own filename, which is what says how to read it. The card's
 * name is editable, so the name it arrived under comes first, and the stored
 * extension is put back on a name that has lost it.
 */
function archiveName(item: Item, stored: string) {
  const base = str(item.meta?.origName) || stored || item.name;
  const ext = str(item.meta?.ext);
  return ext && extOf(base) !== ext ? `${base}.${ext}` : base;
}

/** A folder dropped from the disk: its files are assets already, listed by path. */
function diskContents(list: unknown[]): Incoming[] {
  const files = new Map<string, string>();
  for (const f of list) {
    if (isRecord(f) && typeof f.path === 'string' && isHash(f.hash)) files.set(f.path, f.hash);
  }
  return children([...files.keys()]).flatMap((child): Incoming[] => {
    if (child.kind === 'folder') {
      const under = [...files]
        .filter(([path]) => path.startsWith(child.path))
        .map(([path, hash]) => ({ path: path.slice(child.path.length), hash, size: getAsset(hash)?.size || 0 }));
      return [folderDraft(child.name, { files: under, count: under.length })];
    }
    const asset = getAsset(files.get(child.path));
    return asset ? [new File([asset.blob], child.name, { type: asset.mime })] : [];
  });
}

/** Read, and at a ceiling ask once and read again with it lifted. Null for a no. */
async function readConsenting(blob: Blob, name: string): Promise<ArchiveFile[] | null> {
  try {
    return await readArchive(blob, name);
  } catch (err) {
    if (!isOversize(err)) throw err;
    if (!await lift(err, fileKey({ name, size: blob.size }), `${name} - ${mb(blob.size)}`, 'Unzip')) return null;
    return readArchive(blob, name, true);
  }
}
