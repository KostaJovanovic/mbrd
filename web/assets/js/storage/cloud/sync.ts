// Cloud sync: per-asset upload to the user's own Drive folder.
// Assets are content-addressed (<sha-256>.<ext>), so re-sync only
// uploads board.json — unchanged assets are never re-uploaded.
// Not a merge (no CRDT), not a daemon (token expires ~1h). Conflict
// detection by comparing Drive's modifiedTime against last-seen.
// Bookkeeping in a `kv` row (local to this browser, not in the .mbrd).

import { idbGet, idbSet } from '../idb.ts';
import { getAsset, putAsset } from '../assets.ts';
import { boardAssetHashes, mimeFor } from '../mbrd.ts';
import { isHash } from '../../util.ts';

import type { Asset } from '../assets.ts';
import type { PackedBoard } from '../mbrd.ts';
import type { CloudFile, CloudStore, ShareProvider } from './provider.ts';

/** The one folder in the person's Drive that everything else sits under. */
const APP_FOLDER = 'mbrd';

/** The board itself, inside its folder. One name, read from two directions. */
const BOARD_FILE = 'board.json';

/** Where the per-board bookkeeping lives in `kv`. */
const SYNC_KEY = 'cloud-sync';

/** What this browser remembers about one board's life in the cloud. */
export interface BoardSync {
  provider: string;
  folder: string;
  /** board.json's file id — re-sync replaces rather than duplicates. */
  file: string | null;
  /** modifiedTime from Drive after our last write. Mismatch = conflict. */
  seen: string | null;
  /** Local push timestamp, for "synced 3m ago". */
  at: number;
}

type SyncTable = Record<string, BoardSync>;

/** Everything this browser knows about synced boards. Never throws. */
export async function syncTable(): Promise<SyncTable> {
  const raw = await idbGet('kv', SYNC_KEY).catch(() => null);
  // SAFETY: only writeSyncRow() and forgetAllSyncs() write this key; syncFor() field-checks each row.
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
 * Synchronous mirror of the current board's sync row for ui/settings-schema.ts.
 * Updated on board load, push, stop, and adopt. Null = not synced or not yet read.
 */
let current: BoardSync | null = null;

export const syncedNow = (): BoardSync | null => current;

/** Update the mirror. Separate from writeSyncRow because arrival changes the mirror without writing. */
export function noteCurrentSync(row: BoardSync | null): void {
  current = row;
}

/** Write a sync row. Called after the board is on screen — a failed load must not leave a stale row. */
export async function writeSyncRow(boardId: string, row: BoardSync | null): Promise<void> {
  const table = await syncTable();
  if (row) table[boardId] = row;
  else delete table[boardId];
  await idbSet('kv', SYNC_KEY, table);
}

/** Stop syncing — clears the row but leaves the remote folder. Purge is a separate action. */
export async function forgetSync(boardId: string): Promise<void> {
  await writeSyncRow(boardId, null);
}

/** Clear all sync bookkeeping. Must run after the remote purge — this table is the recovery record. */
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

/** Typed no-op — avoids assertion in each default parameter. */
const noProgress: SyncProgress = () => {};

/** Push result. Row returned (not written) to keep this testable without a browser. */
export type SyncOutcome =
  /** `removed` counts old assets the board no longer names, moved to the trash. */
  | { ok: true, uploaded: number, removed: number, row: BoardSync }
  /** Remote was modified by another machine. Caller asks user, then retries with `force`. */
  | { ok: false, conflict: true, theirs: string };

/** Unwrap provider.store or throw naming the service. */
function storeOf(provider: ShareProvider) {
  const store = provider.store;
  if (!store) throw new Error(`${provider.label} cannot keep boards in sync`);
  return store;
}

/**
 * Upload missing assets then board.json (last, so a partial push leaves a
 * complete older board). `force` skips conflict check (user said overwrite).
 */
export async function pushBoard(
  provider: ShareProvider,
  boardId: string,
  data: PackedBoard,
  { known = null, force = false, onProgress = noProgress }:
    { known?: BoardSync | null, force?: boolean, onProgress?: SyncProgress } = {},
): Promise<SyncOutcome> {
  const store = storeOf(provider);

  // Find or create the board folder (cached in kv after first push).
  const folder = known?.folder
    ?? await store.folder(boardId, await store.folder(APP_FOLDER, null));

  const listing = await store.list(folder);
  const byName = new Map(listing.map(f => [f.name, f]));
  const remote = byName.get(BOARD_FILE) ?? null;

  // Conflict: modifiedTime differs from what we last saw (or never pushed from here).
  if (!force && remote && remote.modifiedTime !== known?.seen) {
    return { ok: false, conflict: true, theirs: remote.modifiedTime };
  }

  const want = boardAssetHashes(data);
  const missing = [...want].filter(hash => {
    const asset = getAsset(hash);
    return asset && !byName.has(assetName(hash, asset.ext));
  });

  // Progress in files, not bytes — each upload is separate.
  const total = missing.length + 1;
  let done = 0;
  for (const hash of missing) {
    const asset = getAsset(hash);
    // Re-read: asset store is mutable. Missing hash skipped, not fatal.
    if (!asset) continue;
    await store.put(folder, assetName(hash, asset.ext), asset.blob, null);
    onProgress(++done, total);
  }

  const json = new Blob([JSON.stringify(data)], { type: 'application/json' });
  const file = await store.put(folder, BOARD_FILE, json, remote?.id ?? null);
  onProgress(total, total);

  // Read back modifiedTime from Drive's clock — guessing would trigger false conflicts.
  const listed = await store.list(folder);
  const after = listed.find(f => f.name === BOARD_FILE);
  const removed = await sweep(store, listed, want);
  return {
    ok: true,
    uploaded: missing.length,
    removed,
    row: { provider: provider.id, folder, file, seen: after?.modifiedTime ?? null, at: Date.now() },
  };
}

/**
 * How long an asset nobody names stays in the folder before a push takes it
 * away. A push from another machine sends its assets before its board.json, so
 * for a while an asset the board up there does not name yet is one it is about
 * to name. A day is far past any push.
 */
const ORPHAN_MS = 24 * 60 * 60 * 1000;

/**
 * Move to the trash every asset in the folder that the board just written no
 * longer names, once it is older than ORPHAN_MS (research/old/done-2026-09-15.md,
 * R13). After board.json, never before: until it lands, the board up there is
 * the older one, and it may still name them. The trash, not a delete, as purge
 * does: thirty days to get one back. A file that will not go stays for the next
 * push, since a push that worked must not fail over housekeeping.
 */
async function sweep(store: CloudStore, listing: CloudFile[], want: Set<string>): Promise<number> {
  const now = Date.now();
  let removed = 0;
  for (const file of listing) {
    const named = hashOf(file.name);
    if (!named || want.has(named.hash)) continue;
    if (!(now - Date.parse(file.modifiedTime) > ORPHAN_MS)) continue;
    try {
      await store.trash(file.id);
      removed++;
    } catch (err) {
      console.warn('[mbrd] could not clear an old asset out of the cloud:', err);
    }
  }
  return removed;
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
