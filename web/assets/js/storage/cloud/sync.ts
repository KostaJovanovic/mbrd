// Keeping a board in somebody's own Drive, one asset at a time.
//
// The second thing the cloud sign-in is for. Sharing packs the whole board into
// one .mbrd and uploads it; this does the opposite, and the opposite is the only
// thing that works at this size:
//
//   mbrd/                      one folder, made once
//     <board id>/              one folder per synced board
//       board.json             the board, minus its bytes. Small.
//       <sha-256>.<ext>        one file per asset, written once and never again
//
// **A re-sync uploads board.json and nothing else.** The asset store is already
// content-addressed, so a file named by the SHA-256 of its own contents can only
// ever have one set of bytes in it - which means "has this already been
// uploaded" is answered by listing the folder, with no manifest to keep in step
// and nothing that can go stale. A 200 MB video goes up once, on the sync where
// it arrived, and is never touched again however many times the board is edited.
//
// That is the whole reason this is not four lines calling the share uploader.
// The share path re-uploads every photograph every time, which is correct for a
// thing that happens when you press a button and ruinous for a thing that
// happens every ten minutes.
//
// ── What this deliberately is not ──
//
// **Not a merge.** Item positions are absolute and there is no CRDT, so two
// machines that both moved the same photograph have no correct answer -
// `old/gdrive-implementation.md` reached that conclusion years before any of
// this was built and nothing since has changed it. What this does is notice, by
// comparing the modification time Drive reports against the one we last saw, and
// hand the question to a person. Last writer wins, but never silently.
//
// **Not a daemon.** Browser-only OAuth gives an hour-long token with no safe way
// to hold a refresh token, and a popup cannot be reopened without a user
// gesture - so a sync that ran on a timer would, once an hour, fail in a way
// nothing could recover from without somebody clicking something. Instead this
// is called from the `autosaved` signal, which already answers "did a person
// actually change something", and when the token dies it stops and says so. The
// failure mode is a board that stopped syncing and told you, which is the one
// failure mode a storage feature is allowed to have.
//
// **Not the .mbrd format.** Nothing here changes what a board file is. The
// export is still one archive you can email; this is a *representation in a
// provider*, and the split that would be a bad idea in a file is the only good
// idea in a folder. `old/gdrive-implementation.md` worried the two were the same
// decision. They are not.
//
// ── Where the bookkeeping lives ──
//
// One `kv` row, `cloud-sync`, mapping a board id to the folder it lives in, the
// file id of its board.json and the modification time we last saw. It is local
// to this browser on purpose: it is a record of *this machine's* relationship
// with the remote, not a property of the board, so it must not travel inside a
// .mbrd - a board file carrying somebody's Drive folder id would leak it to
// everybody they ever send the board to.
//
// The consequence is that a second machine has to find the folder by name, which
// it can: the folder is named for the board id, board.json carries the same id,
// and `drive.file` listings only ever return files this app made.

import { idbGet, idbSet } from '../idb.ts';
import { getAsset, putAsset } from '../assets.ts';
import { boardAssetHashes, mimeFor } from '../mbrd.ts';
import { isHash } from '../../util.ts';

import type { Asset } from '../assets.ts';
import type { PackedBoard } from '../mbrd.ts';
import type { CloudFile, ShareProvider } from './provider.ts';

/** The one folder in the person's Drive that everything else sits under. */
const APP_FOLDER = 'mbrd';

/** The board itself, inside its folder. One name, read from two directions. */
const BOARD_FILE = 'board.json';

/** Where the per-board bookkeeping lives in `kv`. */
const SYNC_KEY = 'cloud-sync';

/** What this browser remembers about one board's life in the cloud. */
export interface BoardSync {
  /** Which provider - so a board synced to Drive is not looked for in OneDrive. */
  provider: string;
  /** The board's own folder. */
  folder: string;
  /** board.json's file id, so a re-sync replaces it rather than making a second. */
  file: string | null;
  /**
   * The `modifiedTime` Drive reported for board.json immediately after *we*
   * wrote it. A later listing that disagrees means somebody else has written
   * since, which is the entire conflict detector.
   */
  seen: string | null;
  /** When this machine last pushed, for the interface to say "synced 3m ago". */
  at: number;
}

type SyncTable = Record<string, BoardSync>;

/** Everything this browser knows about synced boards. Never throws. */
export async function syncTable(): Promise<SyncTable> {
  const raw = await idbGet('kv', SYNC_KEY).catch(() => null);
  // SAFETY: the shape is asserted and every read of it below goes through
  // syncFor(), which checks the one row it wants field by field. writeTable() is
  // the only writer of this key; a key holding something else entirely is a
  // hand-edited database, and it reads as "no board is synced" rather than
  // throwing on a boot.
  return (raw && typeof raw === 'object' ? raw as SyncTable : {});
}

/** What is known about one board, or null. Field-checked, because it is storage. */
export async function syncFor(boardId: string): Promise<BoardSync | null> {
  const row = (await syncTable())[boardId];
  if (!row || typeof row.folder !== 'string' || !row.folder) return null;
  if (typeof row.provider !== 'string' || !row.provider) return null;
  return row;
}

/** Whether this board is one the person asked to keep in the cloud. */
export const isSynced = async (boardId: string) => !!(await syncFor(boardId));

/**
 * The open board's row, synchronously, for the one caller that cannot await.
 *
 * `ui/settings-schema.ts` builds the Cloud section while the panel is being
 * drawn, and every predicate in that schema - `when`, and a hint's `text` - is
 * synchronous by construction. The real answer is in IndexedDB, so what the
 * schema reads is this mirror: the last row anybody established for the board on
 * screen.
 *
 * **Stale by design, and bounded.** It is written on every board arrival and
 * after every push, stop and adopt, which is every event that can change it - so
 * the only window where it lies is between a board being loaded and the async
 * read landing, a few milliseconds during which the panel is very unlikely to be
 * mid-paint. The alternative was an async schema, which would mean every
 * predicate in that file becoming a promise to answer one question here.
 *
 * Null means two things and the section treats them alike: this board is not
 * synced, or nobody has looked yet.
 */
let current: BoardSync | null = null;

export const syncedNow = (): BoardSync | null => current;

/**
 * Point the mirror at what is now true. Called by whoever established it.
 *
 * Separate from writeSyncRow() rather than folded into it, because the two do
 * not always fire together: a board *arriving* changes what the mirror should
 * say without writing anything, and a row written for a board that is not on
 * screen must not change what the panel reports about the one that is.
 */
export function noteCurrentSync(row: BoardSync | null): void {
  current = row;
}

/**
 * Record what a push or a pull established. The one writer of that `kv` row.
 *
 * Called by the caller rather than by pushBoard(), and after the board is
 * actually on screen in the pull case. The ordering is the point: a pull that
 * succeeded and a load that then failed must not leave this browser believing it
 * holds a current copy, because the next push would overwrite the remote from a
 * board that never opened.
 */
export async function writeSyncRow(boardId: string, row: BoardSync | null): Promise<void> {
  const table = await syncTable();
  if (row) table[boardId] = row;
  else delete table[boardId];
  await idbSet('kv', SYNC_KEY, table);
}

/** Stop syncing a board. Leaves what is already in Drive exactly where it is. */
export async function forgetSync(boardId: string): Promise<void> {
  // Deliberately does not remove the remote folder. "Stop keeping this in sync"
  // and "take my board out of my Drive" are two different sentences, and a
  // button that quietly meant both would be the worst kind of data loss - the
  // kind where the app was technically told to do it. The folder stays.
  //
  // There *is* now a button that means the second sentence - see the store's
  // purge() and cmds.cloudPurge - and it is a separate control, worded
  // separately, behind its own dialog. That is the point rather than a
  // contradiction of it: the two readings each got a button, so neither has to
  // be guessed at from one.
  await writeSyncRow(boardId, null);
}

/**
 * Forget every board's cloud bookkeeping at once.
 *
 * The local half of a purge, and it has to run *after* the remote half rather
 * than before. If the trashing failed halfway, this table is the only record of
 * what is up there - clearing it first would strand whatever survived, with no
 * folder id left to find it by and no row to try again from.
 *
 * The mirror goes with it. `syncedNow()` is what the Sync section reads to
 * decide which buttons to draw, and a table cleared under a live mirror leaves
 * the panel offering "Sync now" for a board whose folder is in the trash.
 */
export async function forgetAllSyncs(): Promise<void> {
  await idbSet('kv', SYNC_KEY, {});
  noteCurrentSync(null);
}

/** `<hash>.<ext>`, which is exactly the .mbrd archive's convention minus its slug. */
function assetName(hash: string, ext: string): string {
  const clean = /^[a-z0-9]{1,12}$/.test((ext || '').toLowerCase()) ? '.' + ext.toLowerCase() : '';
  return hash + clean;
}

/** And back again. A name this app did not write answers null and is ignored. */
function hashOf(name: string): { hash: string, ext: string } | null {
  const dot = name.indexOf('.');
  const hash = dot < 0 ? name : name.slice(0, dot);
  const ext = dot < 0 ? '' : name.slice(dot + 1);
  return isHash(hash) ? { hash, ext } : null;
}

/** What a caller is told while a push runs. Files, not bytes - see the note below. */
export interface SyncProgress {
  (done: number, total: number): void;
}

/**
 * The default, for a caller that does not want to be told.
 *
 * A named constant rather than an inline `() => {}` in each default parameter,
 * and that is not a style preference: an arrow written in the defaults has to be
 * asserted to the interface type, and an assertion in this codebase owes a
 * SAFETY comment (`.oxlintrc.json`). One declaration with the type on it owes
 * nothing and reads better in both signatures.
 */
const noProgress: SyncProgress = () => {};

/**
 * How a push ended.
 *
 * The success case hands back the row to store rather than storing it, and that
 * is what keeps this engine testable: writing to IndexedDB from inside the
 * algorithm would mean no assertion about it could run without a browser, and
 * the interesting behaviour here - what gets uploaded, what does not, and what
 * counts as a conflict - is exactly the part worth asserting. The caller writes
 * the row through `writeSyncRow()` once the push has actually landed.
 */
export type SyncOutcome =
  /** Everything the board points at is up there, and board.json is current. */
  | { ok: true, uploaded: number, row: BoardSync }
  /**
   * Somebody else wrote this board since we last did. Nothing was uploaded and
   * nothing local was touched - the caller asks a person and calls back with
   * `force`.
   */
  | { ok: false, conflict: true, theirs: string };

/**
 * The store half of a provider, or a refusal that says which provider.
 *
 * A named function rather than `provider.store!` at four call sites: the
 * optionality is real - a provider may share and not sync - and the message a
 * person gets should name the service rather than being a TypeError.
 */
function storeOf(provider: ShareProvider) {
  const store = provider.store;
  if (!store) throw new Error(`${provider.label} cannot keep boards in sync`);
  return store;
}

/**
 * Put the board up: every asset it points at that is not there yet, then
 * board.json.
 *
 * **board.json goes last, and that ordering is the only durability guarantee
 * here.** A push that dies half way has written some assets and left the
 * previous board.json in place, so the remote is still a complete, older board
 * rather than a newer one with holes in it. The orphaned assets cost storage and
 * nothing else, and the next successful push adopts them for free because they
 * are named by their content.
 *
 * `force` skips the conflict check and is what the caller passes after a person
 * has been asked and said overwrite.
 */
export async function pushBoard(
  provider: ShareProvider,
  boardId: string,
  data: PackedBoard,
  { known = null, force = false, onProgress = noProgress }:
    { known?: BoardSync | null, force?: boolean, onProgress?: SyncProgress } = {},
): Promise<SyncOutcome> {
  const store = storeOf(provider);

  // The folder, found or made. A board that has never synced pays two extra
  // requests once; every push after this one reads the id out of `kv`.
  const folder = known?.folder
    ?? await store.folder(boardId, await store.folder(APP_FOLDER, null));

  const listing = await store.list(folder);
  const byName = new Map(listing.map(f => [f.name, f]));
  const remote = byName.get(BOARD_FILE) ?? null;

  // The conflict, and the whole of it. `seen` is what Drive said the moment we
  // last wrote; anything else means another machine has written in between.
  // A board that has never been pushed from here has no `seen`, so finding one
  // already up there is *also* a conflict - that is the second machine opening a
  // board it has never synced, and overwriting silently would be exactly the
  // case this check exists for.
  if (!force && remote && remote.modifiedTime !== known?.seen) {
    return { ok: false, conflict: true, theirs: remote.modifiedTime };
  }

  const want = boardAssetHashes(data);
  const missing = [...want].filter(hash => {
    const asset = getAsset(hash);
    return asset && !byName.has(assetName(hash, asset.ext));
  });

  // Files rather than bytes, and the reason is that this is forty separate
  // uploads: "3 of 40" is the number that means something here, where a byte bar
  // would restart at zero forty times.
  const total = missing.length + 1;
  let done = 0;
  for (const hash of missing) {
    const asset = getAsset(hash);
    // Filtered for above; re-read because the store is mutable and an optimise
    // could have run between the two lines. A hash whose bytes have gone is
    // skipped rather than fatal, matching what packBoard() does with the faces
    // and the step history.
    if (!asset) continue;
    await store.put(folder, assetName(hash, asset.ext), asset.blob, null);
    onProgress(++done, total);
  }

  const json = new Blob([JSON.stringify(data)], { type: 'application/json' });
  const file = await store.put(folder, BOARD_FILE, json, remote?.id ?? null);
  onProgress(total, total);

  // Read back rather than assumed. The modification time is Drive's own clock
  // and there is no way to know it from here - guessing it, or storing our own
  // Date.now(), would make the very next push look like somebody else's edit.
  const after = (await store.list(folder)).find(f => f.name === BOARD_FILE);
  return {
    ok: true,
    uploaded: missing.length,
    row: { provider: provider.id, folder, file, seen: after?.modifiedTime ?? null, at: Date.now() },
  };
}

/** A board found in the cloud, before anything has been fetched of it. */
export interface RemoteBoard {
  boardId: string;
  folder: string;
  modifiedTime: string;
}

/**
 * Every board this app has ever put in the person's Drive.
 *
 * Derived from the folder listing rather than from the local table, which is the
 * point: on a second machine the local table is empty, and this is how that
 * machine finds the boards the first one put there. `drive.file` makes it safe -
 * the listing cannot see anything this app did not create.
 */
export async function remoteBoards(provider: ShareProvider): Promise<RemoteBoard[]> {
  const store = storeOf(provider);
  const root = await store.folder(APP_FOLDER, null);
  const folders = await store.list(root);
  const out: RemoteBoard[] = [];
  for (const folder of folders) {
    const inside = await store.list(folder.id);
    const board = inside.find(f => f.name === BOARD_FILE);
    // A folder with no board.json is a push that died before its last step, or
    // a folder somebody made by hand. Not an error and not a board.
    if (board) out.push({ boardId: folder.name, folder: folder.id, modifiedTime: board.modifiedTime });
  }
  return out;
}

/**
 * Bring a board down: board.json, then every asset it names that this browser
 * does not already hold.
 *
 * **Assets are registered before the board is returned, never after.** The
 * caller hands what comes back to loadBoard(), and a board mounted against an
 * asset store that has not been filled yet is a screen of empty frames - the
 * same failure the session restore is written to avoid. So this is finished or
 * it throws; there is no partial answer.
 *
 * Already-held hashes are skipped, which makes the common case - the same
 * machine reopening its own board - almost free. It is also what makes the sync
 * cheap in the other direction: two boards sharing a photograph share the
 * download.
 */
export async function pullBoard(
  provider: ShareProvider,
  remote: RemoteBoard,
  { onProgress = noProgress, reuse = null }:
    { onProgress?: SyncProgress, reuse?: Map<string, Asset> | null } = {},
): Promise<{ board: PackedBoard, seen: string }> {
  const store = storeOf(provider);
  const listing = await store.list(remote.folder);
  const boardFile = listing.find(f => f.name === BOARD_FILE);
  if (!boardFile) throw new Error('that board is not in the cloud any more');

  const text = await (await store.fetch(boardFile.id)).text();
  // Parsed here and validated nowhere: normalizeBoard() is the thing that holds
  // a board to a shape, and it runs at the caller on exactly the same terms as a
  // board out of a .mbrd. What this owns is that the bytes are JSON at all.
  let board: PackedBoard;
  try {
    // SAFETY: asserted and then handed straight to the caller, which puts it
    // through normalizeBoard() - the same door a .mbrd's board.json goes
    // through, and for the same reason. Nothing here reads a field of it except
    // boardAssetHashes(), which checks every value it touches.
    board = JSON.parse(text) as PackedBoard;
  } catch {
    throw new Error('the stored board is not readable');
  }

  // Anything the outgoing board was already holding is moved across rather than
  // fetched again. Content addressing is what makes this sound: a hash names its
  // bytes and nothing else, so bytes under that hash are *the* bytes, whichever
  // board was pointing at them a moment ago.
  //
  // Without this, reopening your own synced board re-downloaded every photograph
  // on it - not because the browser lacked them, but because openCloudBoard()
  // runs this inside withFreshAssets(), which empties the store before the pull
  // so that a failure can put the old board back. The assets were sitting in the
  // stash the whole time; nothing had a way to reach them.
  if (reuse) {
    for (const hash of boardAssetHashes(board)) {
      if (getAsset(hash)) continue;
      const held = reuse.get(hash);
      if (held) putAsset(hash, held.blob, { ext: held.ext, mime: held.mime, name: held.name });
    }
  }

  const wanted = [...boardAssetHashes(board)].filter(hash => !getAsset(hash));
  const byHash = new Map<string, CloudFile>();
  for (const file of listing) {
    const parsed = hashOf(file.name);
    if (parsed) byHash.set(parsed.hash, file);
  }

  let done = 0;
  for (const hash of wanted) {
    const file = byHash.get(hash);
    // A hash with no file behind it is the remote equivalent of a .mbrd with a
    // hole in it. Not fatal, for the reason unpackBoard gives: the item keeps
    // its hash, the card comes back if the bytes ever do, and refusing the whole
    // board over one missing picture helps nobody.
    if (!file) continue;
    const ext = hashOf(file.name)?.ext ?? '';
    const blob = await store.fetch(file.id);
    putAsset(hash, blob, { ext, mime: mimeFor(ext) || blob.type });
    onProgress(++done, wanted.length);
  }

  return { board, seen: boardFile.modifiedTime };
}

/** The row a freshly pulled board should be filed under, once it has loaded. */
export function adoptedRow(provider: ShareProvider, remote: RemoteBoard, seen: string): BoardSync {
  return { provider: provider.id, folder: remote.folder, file: null, seen, at: Date.now() };
}
