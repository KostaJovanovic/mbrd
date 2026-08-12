// The board library: several boards kept in this browser, not just the one.
//
// The working cache (session.js) has always held exactly one board - the one on
// screen - and "New" wiped it. This is the shelf beside it: each saved board is
// packed into a self-contained .mbrd blob (the very archive Export writes) and
// filed in its own IndexedDB store under a board id, with a small index in `kv`
// carrying the title, the time and a thumbnail for the switcher to draw.
//
// Packed blobs rather than live rows, and that is the whole safety of it. The
// live board's assets live in the shared `assets` store and are swept down to
// just what that board references on every autosave; a library of boards sharing
// that store would need the sweep taught about every board at once, and a sweep
// that gets that wrong deletes a board's pictures out from under it. A packed
// blob depends on nothing outside itself, so the sweep stays exactly as it was -
// one board at a time - and a board on the shelf cannot be corrupted by whatever
// the active one does. The cost is that a board's bytes are not deduplicated
// across the shelf, which for a handful of boards is a trade worth making for a
// persistence path that cannot eat your work.
//
// This module is only the store: the CRUD on the blobs and the index. The
// orchestration that packs the current board, swaps the assets and loads another
// lives in storage.js, which already owns the file handle and the session
// lifecycle a switch has to move through.

import { idbGet, idbSet, idbDel } from './idb.ts';

const STORE = 'library';
const INDEX_KEY = 'library-index';

/**
 * One row of the shelf's index - everything the switcher draws a card from,
 * and nothing that would need the packed board opened to know.
 *
 * `thumb` is a data URL rather than a Blob because it goes straight into an
 * `<img>` src and is small by construction - see ui/snapshot.js boardThumb().
 */
export type LibraryEntry = {
  id: string,
  title: string,
  at: number,
  thumb: string | null,
};

/**
 * The shelf's index: `[{ id, title, at, thumb }]`, newest first.
 *
 * Kept in `kv` beside the session snapshot rather than derived from the blob
 * store, so drawing the switcher never unpacks a single board - the title and
 * the thumbnail a card needs are right here, and the megabytes of packed board
 * are only read when one is actually opened.
 */
export async function libraryIndex(): Promise<LibraryEntry[]> {
  const list = await idbGet('kv', INDEX_KEY);
  if (!Array.isArray(list)) return [];
  // Safe: writeIndex() below is the only thing that has ever written this key,
  // and it writes exactly the rows putLibraryBoard() builds. The Array.isArray
  // above is the one shape check worth making - a key holding something else
  // entirely is the case a hand-edited database produces.
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

/**
 * File a board on the shelf: its packed blob, and its row in the index. An id
 * already present is overwritten in place - this is how the active board's shelf
 * copy is kept current as it is worked on and switched away from.
 */
export async function putLibraryBoard(
  id: string, blob: Blob, { title, at, thumb }: Partial<Omit<LibraryEntry, 'id'>>,
) {
  await idbSet(STORE, id, blob);
  const rest = (await libraryIndex()).filter(e => e.id !== id);
  rest.push({ id, title: title || 'Untitled board', at: at || 0, thumb: thumb || null });
  await writeIndex(rest);
}

/** The packed blob for a board, or null if the shelf has no such id. */
export async function getLibraryBoard(id: string): Promise<Blob | null> {
  // Safe: putLibraryBoard() above is the only writer of this store, and what it
  // puts under a board id is the packed .mbrd Blob.
  return ((await idbGet(STORE, id)) || null) as Blob | null;
}

/** Take a board off the shelf - both its blob and its index row. */
export async function removeLibraryBoard(id: string) {
  await idbDel(STORE, id);
  await writeIndex((await libraryIndex()).filter(e => e.id !== id));
}
