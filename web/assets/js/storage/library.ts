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

import { idbGet, idbSet, idbDel, idbKeys, idbDelMany } from './idb.ts';

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
  // Serialised against every other writer. The index is a read-modify-write
  // over one key, so two overlapping stashes both read the same list, both
  // append their own row, and the second write wins - leaving the first board's
  // blob on disk with no row pointing at it. It is then unlistable and
  // undeletable through the interface while still holding its megabytes of
  // quota, and the quota error that eventually follows lands on
  // writeSnapshot(), which latches cacheOk = false and stops the *live* board
  // autosaving. Two overlapping stashes is not exotic: switchBoard() shelves
  // the outgoing board and openFile() shelves on the way in.
  //
  // A lock rather than a transaction because the blob and the row live in two
  // stores and idb.ts opens one transaction per call. What this cannot do is
  // survive the tab closing between the two writes, which is what the sweep
  // below is for.
  return (writes = writes.then(async () => {
    await idbSet(STORE, id, blob);
    const rest = (await libraryIndex()).filter(e => e.id !== id);
    rest.push({ id, title: title || 'Untitled board', at: at || 0, thumb: thumb || null });
    try {
      await writeIndex(rest);
    } catch (err) {
      // The row is what makes the blob reachable, so a blob with no row is
      // rubbish rather than a board. Cleaning up here is the difference between
      // a failed stash and a permanent leak.
      await idbDel(STORE, id).catch(() => {});
      throw err;
    }
  }, () => {}).then(() => {}));
}

/**
 * The tail of the write chain, so index writes never interleave.
 *
 * One promise rather than a lock object: every writer below chains onto it and
 * the chain is never allowed to reject, so one failed stash does not wedge the
 * shelf for the session.
 */
let writes: Promise<void> = Promise.resolve();

/**
 * Blobs on the shelf that no index row points at, removed.
 *
 * The gap the lock above cannot close: the blob is written first, so a tab shut
 * between the two writes leaves one behind. Cheap - a key walk over one store,
 * no blob is read - and it is the only thing that can ever reach these, since
 * the interface draws itself from the index.
 */
export async function sweepLibrary() {
  const known = new Set((await libraryIndex()).map(e => e.id));
  const keys = await idbKeys(STORE);
  const orphans = keys.filter(k => typeof k === 'string' && !known.has(k));
  if (orphans.length) await idbDelMany(STORE, orphans as string[]);
  return orphans.length;
}

/** The packed blob for a board, or null if the shelf has no such id. */
export async function getLibraryBoard(id: string): Promise<Blob | null> {
  // Safe: putLibraryBoard() above is the only writer of this store, and what it
  // puts under a board id is the packed .mbrd Blob.
  return ((await idbGet(STORE, id)) || null) as Blob | null;
}

/** Take a board off the shelf - both its blob and its index row. */
export async function removeLibraryBoard(id: string) {
  // On the same chain as putLibraryBoard, for the same reason: a remove that
  // reads the index while a stash is between its two writes puts the stash's
  // row back or drops it, depending on which lands last.
  return (writes = writes.then(async () => {
    await idbDel(STORE, id);
    await writeIndex((await libraryIndex()).filter(e => e.id !== id));
  }, () => {}).then(() => {}));
}

/**
 * How many boards the shelf keeps.
 *
 * There was no ceiling, and every Open, New and Switch files the outgoing board
 * through shelveCurrent() - so twenty opened photo boards is twenty complete
 * packed archives in IndexedDB, none of them ever evicted. What that eventually
 * produces is a QuotaExceededError, and it does not land on the shelf: it lands
 * on writeSnapshot(), which latches cacheOk = false and stops the board on
 * screen autosaving. The shelf filling up is not supposed to cost somebody the
 * board they are looking at.
 *
 * Twenty-four is generous for a switcher somebody actually reads - the panel
 * shows them as cards - and the oldest going first is the only rule that needs
 * no explanation. The board being worked on is never a candidate: it is
 * re-stashed on every switch, so its `at` is always the newest.
 */
const SHELF_MAX = 24;

/**
 * Drop the oldest boards past the ceiling. Returns how many went.
 *
 * Separate from putLibraryBoard so that filing a board and evicting from the
 * shelf are two things in the log rather than one surprising one, and so a
 * caller that wants to file without evicting can.
 */
export async function trimLibrary(keep = SHELF_MAX) {
  const index = await libraryIndex();          // newest first
  const drop = index.slice(Math.max(0, keep));
  for (const row of drop) await removeLibraryBoard(row.id);
  return drop.length;
}
