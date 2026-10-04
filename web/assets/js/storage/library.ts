// Board library: multiple boards in IndexedDB. Each is a packed .mbrd blob
// (self-contained, like Export) under its own id, plus a lightweight index for
// the switcher. Packed blobs (not shared asset rows) so the asset sweep stays
// per-board and a shelved board cannot be corrupted by the active one.
// CRUD only — orchestration (pack, swap, load) lives in storage.ts.

import { idbGet, idbSet, idbDel, idbKeys, idbDelMany } from './idb.ts';

const STORE = 'library';
const INDEX_KEY = 'library-index';

/** One shelf entry. `thumb` is a data URL (goes straight into <img> src). */
export type LibraryEntry = {
  id: string,
  title: string,
  at: number,
  thumb: string | null,
  /** Desktop only. With a path the file on disk *is* the board (no blob stored).
   *  Without one the packed blob is the only copy. Never both — two copies
   *  diverge on first write and there's no way to pick which is right. */
  path?: string,
};

/** Shelf index, newest first. Stored in kv — the switcher never unpacks a board. */
export async function libraryIndex(): Promise<LibraryEntry[]> {
  const list = await idbGet('kv', INDEX_KEY);
  if (!Array.isArray(list)) return [];
  // SAFETY: writeIndex() in this module is the one writer of this key, and it takes
  // LibraryEntry[]. Array.isArray above is the shape check.
  const rows = list as LibraryEntry[];
  return [...rows].sort((a, b) => (b.at || 0) - (a.at || 0));
}

async function writeIndex(list: LibraryEntry[]) {
  await idbSet('kv', INDEX_KEY, list);
}

/** Whether the shelf holds a board under this id. */
export async function hasLibraryBoard(id: string) {
  return (await libraryIndex()).some(e => e.id === id);
}

/** Store a board on the shelf. Existing id is overwritten in place. */
export async function putLibraryBoard(
  id: string, blob: Blob | null, { title, at, thumb, path }: Partial<Omit<LibraryEntry, 'id'>>,
) {
  // Serialised: two overlapping stashes race the read-modify-write index and
  // the loser's blob becomes an orphan holding quota forever. A promise chain
  // (not IDB transaction) because blob and index live in different stores.
  // Tab-close between the two writes → orphan cleaned by sweepLibrary().
  return inTurn(async () => {
    // null blob = path row (file-backed). Delete the old blob — leaving it
    // would create the two-copy divergence this design exists to avoid.
    if (blob) await idbSet(STORE, id, blob);
    else await idbDel(STORE, id).catch(() => {});
    const rest = (await libraryIndex()).filter(e => e.id !== id);
    // Default `at` to now, not 0 — 0 is 1970 and sinks the row to the bottom
    // of the shelf forever.
    const entry: LibraryEntry = {
      id, title: title || 'Untitled board', at: at || Date.now(), thumb: thumb || null,
    };
    // Absent (not undefined) so `'path' in entry` is unambiguous.
    if (path) entry.path = path;
    rest.push(entry);
    try {
      await writeIndex(rest);
    } catch (err) {
      // A blob with no row is a permanent leak — clean it up on failure.
      await idbDel(STORE, id).catch(() => {});
      throw err;
    }
  });
}

/** A row's picture, and nothing else about it. A no-op for an id with no row.
 *  Not putLibraryBoard(), which would drop a blob row's blob for want of one. */
export async function setLibraryThumb(id: string, thumb: string) {
  return inTurn(async () => {
    const list = await libraryIndex();
    const row = list.find(e => e.id === id);
    if (!row || row.thumb === thumb) return;
    row.thumb = thumb;
    await writeIndex(list);
  });
}

/** Write chain — serialises index writes. Never rejects, so one failed stash
 *  does not wedge the shelf for the session. */
let writes: Promise<void> = Promise.resolve();

/** Run `work` after every earlier write, and hand its outcome to the caller.
 *  `then(work, () => {})` would skip `work` after a rejection and resolve,
 *  so the write after a failed one would report success and store nothing. */
function inTurn<T>(work: () => Promise<T>): Promise<T> {
  const run = writes.then(work);
  writes = run.then(() => {}, () => {});
  return run;
}

/** Remove orphaned blobs (tab closed between blob write and index write).
 *  Cheap — key walk only, no blob reads. */
export async function sweepLibrary() {
  const known = new Set((await libraryIndex()).map(e => e.id));
  const keys = await idbKeys(STORE);
  const orphans = keys.filter(k => typeof k === 'string' && !known.has(k));
  if (orphans.length) {
    // SAFETY: filter above already narrowed to strings.
    await idbDelMany(STORE, orphans as string[]);
  }
  return orphans.length;
}

/** The packed blob for a board, or null if the shelf has no such id. */
export async function getLibraryBoard(id: string): Promise<Blob | null> {
  // SAFETY: putLibraryBoard() is the one writer of this store, and it writes only Blobs.
  // The caller opens the blob as a zip, so a hand-edited value is refused there.
  return ((await idbGet(STORE, id)) || null) as Blob | null;
}

/** Take a board off the shelf - both its blob and its index row. */
export async function removeLibraryBoard(id: string) {
  // Same write chain as put — avoids racing the index read-modify-write.
  return inTurn(async () => {
    await idbDel(STORE, id);
    await writeIndex((await libraryIndex()).filter(e => e.id !== id));
  });
}

/** Max boards on the shelf. Without eviction, every Open/New/Switch accumulates
 *  packed archives until QuotaExceededError hits writeSnapshot() and stops
 *  autosave for the *live* board. 24 is generous; oldest first. */
export const SHELF_MAX = 24;

/**
 * The rows trimLibrary() would take once `filing` is filed as the newest -
 * read, never written, so a caller can ask before the shelving rather than
 * report after it. Only blob rows: a path row's board is its file, and dropping
 * the row loses nothing.
 */
export async function wouldTrim(filing: string, spare = '', keep = SHELF_MAX) {
  const rest = (await libraryIndex()).filter(e => e.id !== filing);
  // `filing` takes the top slot, so one fewer of the rest stays.
  return rest.slice(Math.max(0, keep - 1)).filter(e => e.id !== spare && !e.path);
}

/** Drop oldest boards past the ceiling. Separate from put so filing and
 *  eviction are distinct operations. `spare` is the board about to be opened:
 *  it is often the oldest row, and evicting it would lose its only copy. */
export async function trimLibrary(keep = SHELF_MAX, spare = '') {
  // One index read/write instead of removeLibraryBoard() per row.
  return inTurn(async () => {
    const index = await libraryIndex();          // newest first
    const drop = index.slice(Math.max(0, keep)).filter(e => e.id !== spare);
    if (!drop.length) return 0;
    const gone = new Set(drop.map(e => e.id));
    await idbDelMany(STORE, drop.map(e => e.id));
    await writeIndex(index.filter(e => !gone.has(e.id)));
    return drop.length;
  });
}
