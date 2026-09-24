// Board persistence, file half: picker, Save, Export, Open, New. The browser's
// own copy (IndexedDB autosave, restore) is session.ts — split on "who owns
// the file handle" (this module does). session.ts gets what it needs through
// initSession() at the foot and never imports back. Re-exports at the foot
// keep the split invisible to callers.

import { uid, isRecord } from '../util.ts';
import { toast, busy } from '../notify.ts';
// Platform abstraction — browser vs desktop file handling.
import { platform, isDesktop, fileNameOf } from '../platform/platform.ts';
import type { DocumentRef, PickSpec } from '../platform/platform.ts';
import { idbGet, idbSet, idbKeys, idbGetMany } from './idb.ts';
import type { StoreName } from './idb.ts';
import {
  libraryIndex, putLibraryBoard, getLibraryBoard, removeLibraryBoard, hasLibraryBoard,
  trimLibrary, sweepLibrary,
} from './library.ts';
import type { LibraryEntry } from './library.ts';
import {
  board, serializeBoard, loadBoard, markDirty, isDirty, setTitle, bus, mergeBoard,
  defaultBoardTitle, isNotFoundBoard, isBenchBoard, notUsersBoard, hasContent,
} from '../state.ts';
import { normalizeBoard } from '../board-schema.ts';
import { planMerge } from '../merge.ts';
import { packBoard, packBoardFile, unpackBoard, MIME } from './mbrd.ts';
import type { PackedBoard } from './mbrd.ts';
import { layoutFromTail, deadBytes } from './zip.ts';
import type { ZipLayout } from './zip.ts';
import { allAssets, clearAssets, getAsset } from './assets.ts';
import { viewingCopy } from './viewing-copy.ts';
import type { Asset } from './assets.ts';
import { fileNameFor, titleFromFileName, titleForOpenedBoard } from './naming.ts';
// Session engine — handed deps through initSession(), never imports back.
import {
  initSession, autosave, drainSave, clearBoardSlot,
  initSessionStorage, lastSaveFailure, suspendCache,
  resetSessionLatches,
} from './session.ts';
import type { PromptOptions } from './session.ts';

/** Dialog answer: one of the button names, or null. */
export type Prompt = (opts: PromptOptions) => Promise<string | null>;

/** Extract error message for toasts. */
const detailOf = (err: unknown) => String(isRecord(err) ? err.message : undefined);

/** The one throw every picker and share sheet makes when it is dismissed. */
const isAbort = (err: unknown) => isRecord(err) && err.name === 'AbortError';
// Prompt injected (ui/ sits above storage in layering). Unset = 'cancel'.
// No "discard unsaved?" — Open/New shelve the outgoing board instead.
let prompt: Prompt = async () => 'cancel';
export function setPrompt(fn: Prompt | null | undefined) {
  prompt = typeof fn === 'function' ? fn : async () => 'cancel';
}

/** Board thumbnail for the shelf. Injected (ui/ sits above storage).
 *  Unwired → null, which is a shelf row without a picture. */
type ThumbMaker = () => Promise<string | null>;
let makeThumb: ThumbMaker = async () => null;
export function setBoardThumb(fn: ThumbMaker | null | undefined) {
  makeThumb = typeof fn === 'function' ? fn : async () => null;
}

/** File picker spec for .mbrd. Two accept lists because iOS UTI resolution
 *  greys out unknown extensions — octet-stream keeps the door open. */
const PICK_SPEC: PickSpec = {
  types: [{ description: 'mbrd board', accept: { [MIME]: ['.mbrd'] } }],
  accept: '.mbrd,application/zip,application/octet-stream',
  mode: 'mbrd',
};

/** The file this board is, when it is one. A DocumentRef (not a raw handle) —
 *  web: name + handle in platform.ts; desktop: name + path; Safari: name only. */
let doc: DocumentRef | null = null;
/** First-created timestamp, carried across saves of the same board. */
let created: string | null = null;

/** Sync the shell's title bar / proxy icon with the current document.
 *  Fired from `board` bus (title or dirty-flag change) and directly when
 *  `doc` itself moves. No-op on web. */
function reportDocument() {
  platform.setDocument({ title: board.title, ref: doc, dirty: isDirty() });
}
bus.on('board', reportDocument);
bus.on('board:load', reportDocument);

// ---------------------------------------------------------------------------
// Save
// ---------------------------------------------------------------------------

/** Ask the engine for durable storage, once, on first explicit Save.
 *  WebKit may evict best-effort origins under pressure (Safari audit S1).
 *  The answer affects the receipt, never whether the save itself succeeded —
 *  the durable copy is always the exported .mbrd file. */
let persistent: boolean | null = null;   // null: not asked yet; else the engine's answer

async function ensurePersistence() {
  if (persistent !== null) return persistent;
  const store = navigator.storage;
  if (!store || typeof store.persist !== 'function') { persistent = false; return persistent; }
  try {
    persistent = (await store.persisted?.()) || (await store.persist());
  } catch {
    persistent = false;   // an engine that refuses to answer is not a durable one
  }
  return persistent;
}

/** Durability answer + storage estimate. Reports only — asking here would
 *  make a Debug row request a permission. Estimate is the engine's (vague,
 *  rounded); null `persisted` means nobody has saved yet. */
export async function storageReport() {
  const est = await navigator.storage?.estimate?.().catch(() => null) || null;
  return {
    persisted: persistent,
    used: typeof est?.usage === 'number' ? est.usage : null,
    quota: typeof est?.quota === 'number' ? est.quota : null,
  };
}

/** One storage source (e.g. `idb:library`, `cache:mbrd-v263`).
 *  `what` is a machine name, not a label — the Debug row formats it. */
export type StorageSlice = { what: string, bytes: number, count: number };

/** Approximate byte size of a stored value. Blobs answer via `.size` (no read);
 *  the rest is a structured-clone walk. Approximate on purpose — this identifies
 *  which store is the big one, not for reconciling against estimate().usage. */
function weigh(value: unknown, seen: Set<object>): number {
  if (value == null) return 1;
  if (typeof value === 'string') return value.length;
  if (typeof value === 'boolean') return 1;
  if (typeof value === 'number') return 8;
  if (typeof value !== 'object') return 8;
  if (value instanceof Blob) return value.size;
  if (value instanceof ArrayBuffer) return value.byteLength;
  if (ArrayBuffer.isView(value)) return value.byteLength;
  // A structured clone may carry a cycle even though nothing here writes one.
  if (seen.has(value)) return 0;
  seen.add(value);
  let n = 0;
  if (Array.isArray(value)) {
    for (const v of value) n += weigh(v, seen);
    return n;
  }
  for (const [k, v] of Object.entries(value)) n += k.length + weigh(v, seen);
  return n;
}

/** One store of the `mbrd` database, weighed. Unreadable reads as empty. */
async function weighStore(store: StoreName): Promise<StorageSlice> {
  try {
    const keys = await idbKeys(store);
    const values = await idbGetMany(store, keys);
    const seen = new Set<object>();
    let bytes = 0;
    for (const v of values) bytes += weigh(v, seen);
    return { what: `idb:${store}`, bytes, count: keys.length };
  } catch {
    return { what: `idb:${store}`, bytes: 0, count: 0 };
  }
}

/** Cache Storage, one slice per cache. Origin-wide — on a dev server with
 *  multiple projects these rows show the unexplained megabytes. More than one
 *  `mbrd-*` row means a worker that never activated. Uses content-length when
 *  present, reads the body only when it doesn't. */
async function weighCaches(): Promise<StorageSlice[]> {
  const store = globalThis.caches;   // absent on an insecure origin
  if (!store) return [];
  const out: StorageSlice[] = [];
  for (const name of await store.keys()) {
    const cache = await store.open(name);
    const reqs = await cache.keys();
    let bytes = 0;
    for (const req of reqs) {
      const res = await cache.match(req);
      if (!res) continue;
      const len = Number(res.headers.get('content-length'));
      bytes += Number.isFinite(len) && len > 0 ? len : (await res.blob()).size;
    }
    out.push({ what: `cache:${name}`, bytes, count: reqs.length });
  }
  return out;
}

/** Per-store breakdown of what the estimate reports. `rest` is the estimate
 *  minus what was measured (engine padding, per-record overhead, other DBs).
 *  Can't weigh a stranger's DB without opening it at a version. */
export async function storageBreakdown() {
  const { persisted, used, quota } = await storageReport();
  const stores: StoreName[] = ['kv', 'assets', 'library', 'matte'];
  const slices = [
    ...await Promise.all(stores.map(weighStore)),
    ...await weighCaches().catch(() => []),
  ];
  const measured = slices.reduce((n, s) => n + s.bytes, 0);
  let others: string[] = [];
  try {
    // Chrome and Safari list them; Firefox has no such method and answers with
    // the empty list, which reads as "nothing else here" rather than as a hole.
    const dbs = typeof indexedDB.databases === 'function' ? await indexedDB.databases() : [];
    others = dbs.map(d => d.name || '').filter(name => name && name !== 'mbrd');
  } catch { others = []; }
  slices.sort((a, b) => b.bytes - a.bytes);
  // `persisted` is carried through rather than left to a second call: one
  // Debug row printing one sentence, and asking the engine twice inside it is
  // two answers that can disagree.
  return { slices, measured, others, persisted, used, quota, rest: used == null ? null : used - measured };
}

/** Save to IndexedDB (same store as autosave, flushed immediately). */
export async function saveBoard() {
  const ok = await autosave();
  if (!ok) {
    // autosave() throttles its own errors for background use. Save is explicit —
    // always give an answer.
    toast(lastSaveFailure() || 'Could not save in this browser', 'error');
    return false;
  }
  markDirty(false);
  // Receipt reflects actual durability — non-persistent (common on Safari)
  // tells the user to export for a durable copy.
  const durable = await ensurePersistence();
  toast(durable
    ? 'Saved in this browser'
    : 'Saved in this browser — export a file to keep a durable copy');
  return true;
}

/** Export as .mbrd. Handle remembered for overwrite; `pickNew` forces re-pick.
 *  `history` defaults true (Export never asks; Share does, and falls through
 *  here when Web Share is unavailable — the answer must survive the fallback). */
export async function exportBoard({ pickNew = false, history = true } = {}) {
  // Desktop: native dialog. Safari/Firefox: no picker, every export is a download.
  const picking = platform.files.canPick();
  try {
    // Picker runs first: choosing a filename renames the board, and the packed
    // title must match. Cancel throws AbortError before any state moves.
    const picked = picking && (pickNew || !doc);
    if (picked) {
      doc = await platform.files.pickSave(fileNameFor(board.title), PICK_SPEC);
      reportDocument();
    }
    // Non-null: either had a doc or the branch above just set one.
    if (picking) setTitle(titleFromFileName(doc!.name));

    // Busy strip after the picker — packing is the slow half, and showing
    // "working" over a file browser would be a lie.
    const job = busy('Packing the board');
    try {
      const data = serializeBoard();
      // Drop the key — a file without a timeline is already a valid older-build shape.
      if (!history) delete data.timeline;

      // Port writes to handle or downloads. `data.title` for the fallback name
      // (no picker = no rename). `picking &&` keeps the two paths distinct —
      // a stale doc must not write to a file the user never picked. In turn
      // with the file timer, which writes the same file (saveDocument()).
      const target = picking && doc ? doc : { name: fileNameFor(data.title) };
      await inTurn(() => writeBoardFile(target, data, {
        allowMissing: false,
        whole: picked,
        compact: true,
        writing: () => { if (picking) job.label('Writing the file'); },
      }));
    } finally {
      job.end();
    }

    // Exporting is also a save — bytes are on disk.
    markDirty(false);
    toast('Exported ' + fileNameFor(board.title));
    return true;
  } catch (err) {
    if (isAbort(err)) return false;   // user closed the picker
    console.error(err);
    toast('Export failed: ' + detailOf(err), 'error');
    return false;
  }
}

/** Write a non-.mbrd blob to disk (PNG, PDF). Uses the same write path as
 *  export but never touches the document or picker spec. */
export function saveBlob(blob: Blob, name: string) {
  return platform.files.write({ name }, blob);
}

/** Share via the OS share sheet (mobile answer to Export). Same pack pipeline
 *  as exportBoard(). Falls through to exportBoard() when file sharing is
 *  unavailable, so the button never dead-ends. */
export async function shareBoard({ history = true } = {}) {
  try {
    const data = serializeBoard();
    // Share is the one path that asks about history (file goes to someone else).
    if (!history) delete data.timeline;
    const { blob, manifest } = await packBoard(data, { created });
    created = manifest.created;
    const file = new File([blob], fileNameFor(board.title), { type: MIME });
    // canShare({files}) is the real probe — a browser can have share() for
    // text but refuse files.
    if (navigator.canShare?.({ files: [file] })) {
      await navigator.share({ files: [file], title: board.title });
      return true;
    }
    return exportBoard({ history });
  } catch (err) {
    if (isAbort(err)) return false;   // user dismissed the sheet
    console.error(err);
    toast('Share failed: ' + detailOf(err), 'error');
    return false;
  }
}

/** Pack for the share-link path (bytes in memory, not on disk). Same pipeline
 *  as Export/Share. `history` not defaulted — the caller decides. Throws on
 *  failure (unlike Export/Share) so the upload caller catches once for all steps.
 *  `viewing` packs the lighter viewing copy instead (storage/viewing-copy.ts). */
export async function packForShare({ history, viewing = false }: { history: boolean, viewing?: boolean }) {
  let data = serializeBoard();
  if (!history) delete data.timeline;
  if (viewing) data = viewingCopy(data, hash => !!getAsset(hash));
  const { blob, manifest } = await packBoard(data, { created });
  created = manifest.created;
  return { blob, name: fileNameFor(data.title) };
}

// ---------------------------------------------------------------------------
// Open
// ---------------------------------------------------------------------------

/** Pick and open a .mbrd. Picker runs first — no confirmation until a file
 *  is actually in hand (openFile() handles that). */
export async function openBoard() {
  try {
    // Both picker implementations (FSA and hidden <input>) are behind this call.
    const { file, ref } = await platform.files.pickOpen(PICK_SPEC);
    return await openFile(file, ref);
  } catch (err) {
    if (isAbort(err)) return false;
    console.error(err);
    toast('Open failed: ' + detailOf(err), 'error');
    return false;
  }
}

/** Open a .mbrd File — the one door to "replace the board". Shelves the
 *  current board first (before unpack, because withFreshAssets() swaps the
 *  asset store). Takes the id of the row that already points at this file, or
 *  mints a fresh one so the new board doesn't overwrite the outgoing row. */
export async function openFile(file: File, ref: DocumentRef | null = null) {
  try {
    // If the outgoing board couldn't be shelved, refuse — opening would destroy it.
    if (!(await shelveCurrent())) return false;
    // Unpack and load inside the same transaction — committing assets before
    // loadBoard() succeeds would leave the old items pointing at revoked URLs.
    const job = busy('Opening ' + file.name);
    // Set inside the transaction, read in finally to decide shelf-row ownership.
    let opened = false;
    try {
      return await withFreshAssets(async () => {
        // A file the shell read is the app's own copy, and its pictures stay
        // where they are in it (readZipBlob()). A picked or dropped File is not.
        const { manifest, board: data } = await unpackBoard(file, { owned: isDesktop() && !!ref?.path });
        // manifest.app decides whether the stored title needs its underscores
        // decoding - see titleForOpenedBoard(). The field was documented as
        // informational; this is the one thing that reads it.
        loadBoard({ ...data, title: titleForOpenedBoard(data.title, file.name, manifest.app) });
        doc = ref;
        reportDocument();
        // The manifest is a file's, so its stamp is only a stamp if it is text.
        // Anything else starts the board's created date afresh at the next save,
        // which is what an absent one has always done.
        created = (typeof manifest.created === 'string' && manifest.created) || null;
        opened = true;
        toast('Opened ' + file.name);
        return true;
      });
    } finally {
      job.end();
      // Only a successfully opened board gets an id — a failed open keeps the
      // old board's shelf row. A file already on the shelf is that row's
      // board, so opening it twice lists it once.
      if (opened) await setCurrentBoardId(await rowForFile(ref) ?? uid('brd'));
      // Latches belong to the outgoing board (same as switchBoard/New).
      resetSessionLatches();
      // The board and its row, now, on a desktop with a boards folder: the row
      // for a file, and a file in the folder for a board that came with none
      // (a drop, a share link). See saveDocument().
      if (opened && folder) {
        if (doc?.path) await fileRow().catch(err => console.warn('[mbrd] no row for the file:', err));
        else await saveDocument();
      }
    }
  } catch (err) {
    console.error(err);
    toast('Could not open that file: ' + detailOf(err), 'error');
    return false;
  }
}

/** Open a board from a share link: fetch, then openFile(). Funnels through
 *  openFile() so the shelve/swap policy is in one place. Provider loaded
 *  dynamically (keeps this module off the OAuth graph). Anonymous fetch —
 *  no sign-in to receive. No retry on failure (revoked or deleted). */
export async function openSharedBoard(ref: { provider: string, id: string }) {
  const job = busy('Fetching the shared board');
  try {
    const { shareProvider } = await import('./cloud/cloud.ts');
    const provider = shareProvider(ref.provider);
    if (!provider) {
      // Unknown provider — either this build doesn't know it or it's not configured.
      toast('This app cannot open that kind of share link', 'error');
      return false;
    }
    const blob = await provider.download(ref.id);
    // A name for the sake of the board's title and the receipt. The real title
    // is inside board.json and titleForOpenedBoard() prefers it; this only shows
    // where a file has none, which is the same bargain every other open makes.
    const file = new File([blob], fileNameFor('shared board'), { type: MIME });
    return await openFile(file);
  } catch (err) {
    console.error(err);
    toast('Could not open the shared board: ' + detailOf(err), 'error');
    return false;
  } finally {
    job.end();
  }
}

// ---------------------------------------------------------------------------
// The cloud copy
//
// Three functions, and they sit here rather than in storage/cloud/ for the
// reason every other door in this file does: they need the board id, the
// serialiser and the board-swap transaction, and those are this module's. The
// *algorithm* - what to upload, what counts as a conflict - is sync.ts, which
// knows nothing about this app's state and is tested against a fake store.
// ---------------------------------------------------------------------------

/** Which board is on screen, for the sync table to file it under. */
export const currentBoardId = () => ensureBoardId();

/**
 * Whether this board is one somebody asked to keep in the cloud, read fresh.
 *
 * Every call also points the synchronous mirror the settings panel reads at the
 * answer, which is what keeps that mirror true without a second thing having to
 * remember to update it. See syncedNow() in cloud/sync.ts.
 */
export async function boardSyncState() {
  const { syncFor, noteCurrentSync } = await import('./cloud/sync.ts');
  const row = await syncFor(await ensureBoardId());
  noteCurrentSync(row);
  return row;
}

/**
 * Push the board on screen to whichever provider it is filed under.
 *
 * The row is written **after** the push lands, never before, and never at all on
 * a conflict - so a refused push leaves this browser's idea of the remote
 * exactly as it was and the next attempt asks the same question rather than
 * quietly deciding it has won.
 *
 * `force` is what a caller passes once a person has been asked and said
 * overwrite. Nothing in the automatic path may pass it.
 */
export async function pushBoardToCloud(
  { force = false, onProgress }:
    { force?: boolean, onProgress?: (done: number, total: number) => void } = {},
) {
  const { shareProvider } = await import('./cloud/cloud.ts');
  const { pushBoard, syncFor, writeSyncRow, noteCurrentSync } = await import('./cloud/sync.ts');
  const id = await ensureBoardId();
  const known = await syncFor(id);
  const provider = shareProvider(known?.provider || 'gdrive');
  if (!provider) throw new Error('that cloud account is not available in this build');
  if (!provider.signedIn()) throw new Error(`sign in to ${provider.label} first`);

  const out = await pushBoard(provider, id, serializeBoard(), { known, force, onProgress });
  if (out.ok) {
    await writeSyncRow(id, out.row);
    noteCurrentSync(out.row);
  }
  return out;
}

/** Stop keeping this board in the cloud. What is already up there stays. */
export async function stopSyncingBoard() {
  const { forgetSync, noteCurrentSync } = await import('./cloud/sync.ts');
  await forgetSync(await ensureBoardId());
  noteCurrentSync(null);
}

/**
 * Start keeping this board in the cloud: file it, then push it once.
 *
 * Two steps rather than one because the row has to exist before the first push
 * can know which provider it belongs to, and the push is what makes the row
 * true. A first push that fails leaves no row at all, which is the honest
 * outcome - a board marked as synced that has never reached the cloud is worse
 * than one that plainly is not.
 */
export async function startSyncingBoard(providerId: string) {
  const { shareProvider } = await import('./cloud/cloud.ts');
  const { pushBoard, writeSyncRow, noteCurrentSync } = await import('./cloud/sync.ts');
  const provider = shareProvider(providerId);
  if (!provider) throw new Error('that cloud account is not available in this build');
  const id = await ensureBoardId();
  const out = await pushBoard(provider, id, serializeBoard(), { known: null });
  if (out.ok) {
    await writeSyncRow(id, out.row);
    noteCurrentSync(out.row);
  }
  return out;
}

/**
 * Open a board out of the cloud, over the top of whatever is on screen.
 *
 * Modelled on openFile() line for line, and the shape is the point rather than
 * the similarity: the outgoing board is filed on the shelf first, the assets are
 * swapped inside withFreshAssets() so a failure puts the old ones back, and
 * nothing is replaced until the board is actually in hand. A second board-swap
 * written from scratch is a second place that policy can drift from, which is
 * why this one is a copy of that one and not an improvement on it.
 *
 * The pull happens *inside* the transaction, which is the one thing worth
 * reading twice. pullBoard() registers what it downloads through putAsset(), so
 * running it outside would file the incoming board's bytes into the outgoing
 * board's store and then throw them away with it.
 */
export async function openCloudBoard(remote: { boardId: string, folder: string, modifiedTime: string }) {
  const { shareProvider } = await import('./cloud/cloud.ts');
  const { pullBoard, adoptedRow, writeSyncRow, noteCurrentSync } = await import('./cloud/sync.ts');
  const provider = shareProvider('gdrive');
  if (!provider) throw new Error('that cloud account is not available in this build');

  try {
    if (!(await shelveCurrent())) return false;
    const job = busy('Fetching the board');
    let seen: string | null = null;
    try {
      await withFreshAssets(async stash => {
        const pulled = await pullBoard(provider, remote, {
          onProgress: (done, total) => job.step(done, total),
          // The board being replaced, offered to the one arriving. Two boards
          // sharing a photograph share the bytes, so reopening your own synced
          // board fetches board.json and nothing else.
          reuse: stash,
        });
        seen = pulled.seen;
        loadBoard(normalizeBoard(pulled.board));
      });
    } finally {
      job.end();
    }
    doc = null;
    reportDocument();
    created = null;
    // The board's own id follows the remote's, which is what makes a second
    // machine's copy the *same* board rather than a duplicate of it: the folder
    // is named for the id, so a machine that minted a fresh one would push into
    // a second folder and the two would never converge again.
    await setCurrentBoardId(remote.boardId);
    // After the board is on screen, deliberately. A pull that succeeded and a
    // load that then failed must not leave this browser believing it holds a
    // current copy - the next push would overwrite the remote from a board that
    // never opened.
    if (seen) {
      const row = adoptedRow(provider, remote, seen);
      await writeSyncRow(remote.boardId, row);
      noteCurrentSync(row);
    }
    resetSessionLatches();
    // A file of its own in the boards folder, as every board has on the desktop.
    if (folder) await saveDocument();
    toast('Opened the cloud copy');
    return true;
  } catch (err) {
    console.error(err);
    toast('Could not open that board: ' + detailOf(err), 'error');
    return false;
  }
}

/**
 * Fold a .mbrd into the board that is already open, instead of replacing it.
 *
 * The third thing that can be done with a board file, beside Open and Export,
 * and the only one that is additive. Everything about it follows from that:
 *
 * **No withFreshAssets(), and this is the load-bearing difference from
 * openFile().** That transaction exists to swap one board's assets for
 * another's atomically; a merge wants both. The incoming bytes are registered
 * alongside what is there, and because every asset is keyed by the SHA-256 of
 * itself, two boards sharing a photograph share one entry with no work. If the
 * merge then fails, a few blobs nothing points at are left in the registry -
 * which is not a leak to fix: the autosave sweep collects unreferenced assets on
 * the next write, so it heals itself. Wrapping this in the transaction to
 * "tidy" that would take the arriving items' bytes away from the board they
 * just landed on.
 *
 * **No loadBoard().** normalizeBoard() gives a clean incoming board without
 * touching the live one, and planMerge() turns that into items and relations
 * with every id remapped. The live board is only written by mergeBoard(), in
 * one undoable step.
 *
 * **Most of the file is deliberately dropped**: the incoming title, settings,
 * look, palette sources, Mobile geometry and - the one worth naming - its
 * *bin*. A merge that carried the incoming trash would silently push the host's
 * own deleted items out against TRASH_LIMIT, throwing away something the person
 * had not thrown away. Mobile geometry is left for completeLayout() to pack,
 * since a column somebody else's phone packed says nothing about this one.
 */
async function mergeFile(file: File) {
  const job = busy('Merging ' + file.name);
  try {
    const { board: data } = await unpackBoard(file);
    const incoming = normalizeBoard(data);
    // The live ids *and* the bin's: a restored card comes back with the id it
    // had, so an arrival that took that string would collide the moment somebody
    // dragged the old one out of the trash.
    const taken = new Set([
      ...board.items.map(i => i.id),
      ...board.trash.map(t => t.item.id),
    ]);
    const plan = planMerge(incoming, taken, board.items);
    const n = mergeBoard(plan, 'Merge ' + file.name);
    if (!n) { toast('There was nothing on that board to merge'); return false; }
    toast(`Merged ${n} item${n === 1 ? '' : 's'} from ${file.name}`);
    return true;
  } catch (err) {
    console.error(err);
    toast('Could not merge that file: ' + detailOf(err), 'error');
    return false;
  } finally {
    job.end();
  }
}

/**
 * A .mbrd has landed on the board. Open it, or fold it in?
 *
 * The question lives here rather than in import/drop.ts because import/ sits
 * below ui/ and cannot reach a dialog, while this module already has one
 * injected for the clear-everything question - and because both answers are
 * this module's functions. drop.ts asks the door, the door asks the person.
 *
 * **Not asked on an empty board.** Merging into nothing and opening are the
 * same outcome, so offering two words for one result would be a dialog that
 * teaches people to stop reading them. hasContent() is the same test the
 * onboarding hints use for "is there anything here yet", which is exactly the
 * question being asked.
 *
 * Merge leads, because the drop happened *onto* something: a person with a
 * board in front of them who drags a second board onto it has said where they
 * want it. Open is the second answer rather than the first, and neither wears
 * the danger dressing - see AskOptions.danger in ui/dialog.ts, which became a
 * parameter for this question.
 */
export async function openOrMergeFile(file: File) {
  if (!hasContent()) return openFile(file);
  const answer = await prompt({
    title: 'Two boards',
    body: `Add ${file.name} to the board you have here, or open it on its own?`,
    go: 'Merge it in',
    keep: 'Open it',
    cancel: 'Cancel',
    danger: false,
  });
  if (answer === 'go') return mergeFile(file);
  if (answer === 'keep') return openFile(file);
  return false;
}

/**
 * Run `commit` against a clean asset registry, atomically.
 *
 * The current board's assets are set aside rather than cleared outright: a
 * corrupt or half-written file must leave the open board fully intact, and
 * revoking its object URLs up front would blank every image on screen before
 * we know whether the new file is even readable. The old URLs are only
 * released once the new board is definitely in - which is why the whole of
 * "open" runs in here rather than just the unpacking.
 */
async function withFreshAssets<T>(commit: (stash: Map<string, Asset>) => Promise<T>): Promise<T> {
  const store = allAssets();
  const stash = new Map(store);
  store.clear();
  try {
    // The stash is handed to the commit, and exactly one caller wants it: the
    // cloud pull, which would otherwise re-download every photograph on a board
    // this browser already holds, because the store it looks in was emptied one
    // line above. Handing it over rather than exposing it is what keeps the
    // rollback below the only other thing that can touch it - a caller holding
    // the stash after this returns would be holding the assets of a board that
    // has either been replaced or been put back, and neither is a thing to keep.
    const result = await commit(stash);
    for (const a of stash.values()) if (a.url) URL.revokeObjectURL(a.url);
    return result;
  } catch (err) {
    store.clear();
    for (const [k, v] of stash) store.set(k, v);
    throw err;
  }
}

// ---------------------------------------------------------------------------
// New
// ---------------------------------------------------------------------------

/**
 * Start a fresh board, putting the one on screen on the shelf first.
 *
 * **This is the only New.** There used to be two - this one, which guarded a
 * single session slot and so stopped to ask whether to discard, and
 * newLibraryBoard(), which had the shelf to set the old board on and simply
 * did. Two doors onto one room with two different safety models is the drift
 * the headers in this codebase keep warning about, and it survived only as long
 * as the top-level door had nowhere to put anything. It has somewhere now, so
 * the two collapsed into the better of them.
 *
 * The library's New calls this; so does the Board panel's.
 */
/** The one answer every board-replacing door gives on the benchmark's board. */
function refuseOnBench() {
  toast('This is the benchmark board - go back to your board first');
  return false;
}

export async function newBoard() {
  // A not-found board is not the visitor's board. It was never loaded from the
  // session slot, so clearing that slot below would delete a board they cannot
  // see and have not been asked about - and worse now than when this only
  // refused a prompt, because the stash below would file the blank message onto
  // the shelf under their board's id. resetSessionLatches() would then let the
  // blank replacement autosave over it. Refused rather than routed through
  // leaveNotFound(): restoring their board only to discard it a line later is
  // tidier to read and worse to be on the end of, and it would announce "Moved
  // to your board" on the way past.
  if (isNotFoundBoard()) {
    toast('This address has no board to start over - put something on it first');
    return false;
  }
  if (isBenchBoard()) return refuseOnBench();
  // Stop the closing board's autosave from repopulating the store after it is
  // cleared, and put the board being left onto the shelf. See AUD-03 for the
  // latch, and shelveCurrent() for why nothing is asked any more.
  //
  // **The order is load-bearing and always has been.** clearAssets() revokes
  // every object URL, and the stash inside shelveCurrent() packs *from* the
  // asset store - so a clear before the stash writes an empty board onto the
  // shelf, silently, and the board that was on screen is gone.
  if (!(await shelveCurrent())) return false;
  clearAssets();
  doc = null;
  reportDocument();
  created = null;
  // A new board is a new board, and it needs a row of its own. Without this it
  // would inherit the shelf row of the board just filed and overwrite it at the
  // next stash.
  await setCurrentBoardId(uid('brd'));
  // Announced rather than acted on, because the look lives in ui/appearance.ts
  // and this module has to keep loading without a browser.
  //
  // Emitted *before* the load, and that ordering is the whole trick: resetting
  // the look calls persist(), which marks the board dirty - and loadBoard()
  // clears the flag on its way past. The other order leaves a board nobody has
  // touched claiming unsaved changes, so the next New asks whether to discard
  // an empty board.
  bus.emit('board:new');
  // Settings deliberately *not* carried over. A new board is a new board: grid,
  // axes, snapping, spacing, the arrangement and the look all start where a
  // first-run board starts, rather than inheriting whatever the last one drifted
  // into. That matters more since a board can derive its palette from its own
  // photographs - without this, every board after the first would open in the
  // colours of the previous board's pictures.
  loadBoard({ title: defaultBoardTitle() });
  // A failure here is self-healing: the session is one slot and the new board's
  // first autosave overwrites whatever stale bytes remain, so warn but do not
  // block starting fresh. clearAllData() is the path that must not paper over a
  // failed wipe; New is not. The slot only, and not the list of boards beside
  // it - see clearBoardSlot().
  try { await clearBoardSlot(); }
  catch (err) { console.warn('[mbrd] could not clear the old session:', err); }
  // A fresh start is a fresh start. Both latches below are set by a failure
  // that belonged to the board just closed - a quota error raised by its
  // photographs, or an asset it had lost - and clearSession() has just deleted
  // the very data that caused the first one. Left set, they turned one full
  // disk into a session where nothing could be saved again until the page was
  // reloaded, on a board that is now empty.
  resetSessionLatches();
  // On the desktop the new board is a file at once, in the boards folder.
  if (folder) await saveDocument();
  return true;
}

// ---------------------------------------------------------------------------
// The library - several boards kept in this browser
// ---------------------------------------------------------------------------
//
// The shelf beside the single session slot. Each board is packed into its own
// self-contained .mbrd blob and filed under a board id (storage/library.ts), so
// switching between them never disturbs the one-board-at-a-time asset store the
// live board is swept against - the sweep, the most dangerous thing in this
// file's neighbourhood, is left exactly as it was. Switching is pack-then-unpack,
// the same two operations Export and Open already trust, pointed at IndexedDB
// rather than the disk.

/** The active board's library id, restored on boot and minted on first need. */
let boardId: string | null = null;

async function ensureBoardId() {
  if (boardId) return boardId;
  const saved = await idbGet('kv', 'current-board').catch(() => null);
  boardId = (typeof saved === 'string' && saved) || uid('brd');
  await idbSet('kv', 'current-board', boardId).catch(() => {});
  return boardId;
}

async function setCurrentBoardId(id: string) {
  boardId = id;
  await idbSet('kv', 'current-board', id).catch(() => {});
}

/** The shelf, each row flagged with whether it is the board on screen now. */
export async function listLibrary() {
  const id = await ensureBoardId();
  return (await libraryIndex()).map(e => ({ ...e, current: e.id === id }));
}

/**
 * File the board on screen onto the shelf, thumbnail and all. Overwrites its own
 * row if it already has one, which is how a board's shelf copy is kept current.
 *
 * The thumbnail is taken here rather than handed in. It used to be a parameter,
 * because the only caller was the library and the library is a ui/ module that
 * could render one; every door onto "replace the board" stashes now, and two of
 * those doors are modules that may not reach ui/ at all. See setBoardThumb().
 *
 * A failed thumbnail is not a failed stash. The picture is how you recognise a
 * board on the shelf, and a board on the shelf without one is still the board.
 */
export async function stashCurrent() {
  const id = await ensureBoardId();
  // The id is the user's board's, and the board on screen is not: filing it
  // would put the benchmark's pictures over their row. Nothing to file.
  if (isBenchBoard()) return id;
  const thumb = await makeThumb().catch(() => null);
  // With a boards folder the file is brought up to date first, and made if the
  // board has none, so the row below is always a pointer. A board that could
  // not be written is not filed, and the caller keeps it on screen. The wait
  // is for adoptFolder(), which is what sets `folder`.
  await adopted;
  if (folder && !(await saveDocument())) throw new Error('the board could not be written to its file');
  // A board that is a file gets a row that points at the file, and no copy.
  //
  // This is the whole of the desktop shelf. On the web a packed blob is the only
  // place an outgoing board can go, which is why every row here is one; on the
  // desktop the file already is that place, and a blob beside it would be a
  // second board that the next Save leaves stale. So a saved board is filed as a
  // pointer and an untitled one is filed as a blob, exactly as on the web, and
  // the row changes kind at the first Save rather than at any other moment.
  //
  // It is also the cheap path: no serialise, no pack, no deflate of every
  // photograph on the board just to shelve a file that is already on disk.
  if (isDesktop() && doc?.path) {
    await putLibraryBoard(id, null, { title: board.title, at: Date.now(), thumb, path: doc.path });
    return id;
  }
  const data = serializeBoard();
  // The shelf tolerates a missing asset; Export does not. Both go through
  // packBoard() and the refusal was written for the file, so a board that had
  // lost one photograph could not be shelved - and since every door out of a
  // board shelves first, it could not be opened away from, switched, replaced
  // or exported either. The only escape the interface offered was Clear
  // everything. See the allowMissing note in storage/mbrd.ts: the shelf is the
  // app's own working copy, and one that is a picture short beats none.
  const { blob, manifest } = await packBoard(data, { created, allowMissing: true });
  created = manifest.created;
  await putLibraryBoard(id, blob, { title: board.title, at: Date.now(), thumb });
  return id;
}

/**
 * The one question a document application has to ask, and the web app was
 * proud not to.
 *
 * On the web nothing is asked, and the header of shelveCurrent() below carries
 * the argument: a board that is always filed on the shelf before the next one
 * arrives has nothing to lose, so there is nothing to ask about.
 *
 * That argument turns on the shelf being the only place the board can go. On the
 * desktop it is not - the file is - and a board with a file and unsaved changes
 * has somewhere the changes belong. Filing it as a path row without asking would
 * point the shelf at a file that is *older* than what was on screen, and the
 * changes would be gone with no dialog having admitted it. So the question is
 * asked exactly where that is true: a desktop board, with a document, that is
 * dirty. An untitled board is still filed as a blob and still asks nothing.
 *
 * Cancel keeps the board, which is why this can refuse the whole shelving.
 */
async function askBeforeLeaving() {
  // With a boards folder the stash writes the file on the way out, so the
  // changes do reach it and there is nothing to ask. This stays for Android.
  if (folder) return true;
  if (!isDesktop() || !doc || !isDirty()) return true;
  const answer = await prompt({
    title: 'Save changes to ' + doc.name + '?',
    body: 'This board is a file on disk. Changes you have not saved are not in it yet.',
    go: 'Save',
    keep: "Don't save",
    cancel: 'Cancel',
    danger: false,
  });
  // Null is the dialog closing without an answer, which is a cancel - the same
  // reading every other caller of prompt() takes.
  if (answer !== 'go' && answer !== 'keep') return false;
  // A save that fails or is cancelled at its own picker is not a "don't save":
  // somebody asked for the file to be written and it was not, so the board stays
  // where it is rather than being filed over.
  if (answer === 'go') return await exportBoard();
  return true;
}

/**
 * Put the board on screen on the shelf, and stop the writer that was serving it.
 *
 * The three lines every door onto "replace the board" opens with, and the whole
 * of what replaced the discard prompt. Suspend the autosave latch so the closing
 * board cannot repopulate the store behind the swap, let any in-flight write
 * finish, then file the board.
 *
 * **This is why nothing asks about unsaved work any more.** The question
 * "you have changes that are not in a file, discard them?" had one honest answer
 * while there was one session slot and the shelf was somewhere you had to go on
 * purpose: there was nowhere to put the outgoing board, so the only thing on
 * offer was Export. There is somewhere now. A board that is always filed before
 * the next one arrives has nothing to lose, so there is nothing to ask - and a
 * dialog that interrupts every Open to protect work that is already safe is
 * worse than no dialog, because people learn to dismiss it.
 *
 * What it does not do is clear the dirty flag. loadBoard() does that on the way
 * in, and the flag is about the board on screen rather than about the shelf.
 *
 * **Answers whether the board is actually on the shelf, and the callers must
 * refuse if it is not.** This is where the safety the discard prompt used to
 * provide now lives, and it is the whole reason this returns anything. The
 * prompt existed because a board could be destroyed by the next one arriving;
 * that is still true if the shelf write fails, which is what a full disk or a
 * broken IndexedDB looks like from here. Carrying on regardless would mean the
 * one case the old dialog was built for is the one case nothing now guards -
 * and it would fail silently, which is worse than the dialog ever was.
 */
async function shelveCurrent() {
  // Every door that replaces the board comes through here, and on the bench
  // board each of them would end with the arriving board autosaving into the
  // user's session slot with nothing of theirs filed first. Refused, all of
  // them at once: the way to another board from here is Back to your board.
  if (isBenchBoard()) return refuseOnBench();
  if (!(await askBeforeLeaving())) return false;
  suspendCache();
  await drainSave();
  try {
    await stashCurrent();
    // After the stash, and never allowed to fail it: an eviction that throws
    // must not turn a board that *is* on the shelf into one the caller thinks
    // is not. The sweep is here rather than at boot because this is the only
    // place that adds to the shelf, so it is the only place it can grow.
    await trimLibrary().catch(err => console.warn('[mbrd] shelf not trimmed:', err));
    await sweepLibrary().catch(() => {});
    return true;
  } catch (err) {
    console.error('[mbrd] could not file the board on the shelf:', err);
    toast('Could not file this board, so it has been left where it is. '
      + 'Export it before opening another.', 'error');
    // The writer went down at the top of this function and the board is staying,
    // so it has to come back up or the board on screen stops autosaving for the
    // rest of the session.
    resetSessionLatches();
    return false;
  }
}

/**
 * Make sure the board on screen has a row on the shelf, and put one there if it
 * has not.
 *
 * The library only ever wrote a row on the way *out* of a board - stashCurrent()
 * ran from switchBoard() and from New and nowhere else - so on a browser that
 * had never switched boards the shelf was empty and "Your boards" said so, with
 * the board you were looking at absent from its own list. It was not missing a
 * badge; it was missing a row.
 *
 * Called by the library before it draws. hasLibraryBoard() has waited for a
 * caller since it was written and this is the one: the check is cheap, and the
 * stash behind it costs a pack and a thumbnail once per browser, on a click that
 * was about to render a thumbnail anyway.
 *
 * The rejected alternative was a virtual "current" row with no blob behind it.
 * That makes the list honest and the shelf a lie - Delete would face a row with
 * nothing under it, and Switch would write the real one a moment later anyway.
 */
export async function ensureCurrentOnShelf() {
  const id = await ensureBoardId();
  if (isBenchBoard()) return id;
  if (await hasLibraryBoard(id).catch(() => true)) return id;
  await stashCurrent().catch(err => {
    console.warn('[mbrd] could not file the current board on the shelf:', err);
  });
  return id;
}

/**
 * Put the current board on the shelf and open another in its place.
 *
 * Stash-then-load, so nothing is lost in the swap. This was once the only door
 * that behaved this way and the argument for it was written here; Open and New
 * do it now too, and the argument moved to shelveCurrent() with them. The asset
 * swap is the same atomic withFreshAssets() Open uses, so a corrupt shelf blob
 * leaves the current board intact.
 *
 * Note what this one does *not* do that the other two do: it does not mint a new
 * board id, because the board arriving already has one - it is the row being
 * opened. Open and New are arrivals from outside the shelf and need a row made
 * for them.
 */
export async function switchBoard(id: string) {
  if (!id || id === boardId) return false;
  // A file in the boards folder with no row yet: opened as a file, which
  // gives it its row.
  if (id.startsWith(FILE_ID)) return openBoardFile(id.slice(FILE_ID.length));
  const job = busy('Switching boards');
  try {
    if (!(await shelveCurrent())) return false;
    // Which kind of row this is decides where the bytes come from, and it is the
    // only place in this function that the desktop differs. A path row has no
    // blob on the shelf by construction - see stashCurrent() - so the file *is*
    // the board, and it is read now rather than unpacked from a copy.
    const row = (await libraryIndex()).find(e => e.id === id);
    const ref: DocumentRef | null =
      row?.path ? { name: fileNameOf(row.path), path: row.path } : null;
    let file: File;
    if (ref) {
      // Checked rather than caught, so a file that has moved says so plainly
      // instead of arriving as an unpack failure. The row stays on the shelf
      // either way: it is a pointer, and Locate is how it is repaired.
      if (!(await platform.files.exists(ref))) {
        toast('That file has moved or been deleted - use Locate to find it', 'error');
        return false;
      }
      file = await platform.files.read(ref);
    } else {
      const blob = await getLibraryBoard(id);
      if (!blob) { toast('That board is not on the shelf any more', 'error'); return false; }
      file = new File([blob], 'board.mbrd', { type: MIME });
    }
    await withFreshAssets(async () => {
      const { manifest, board: data } = await unpackBoard(file, { owned: isDesktop() });
      loadBoard(data);
      // A string or nothing, as in openFile() above and for the same reason:
      // this manifest came out of a packed blob rather than out of this run.
      created = (typeof manifest.created === 'string' && manifest.created) || null;
    });
    doc = ref;
    reportDocument();
    await setCurrentBoardId(id);
    return true;
  } catch (err) {
    console.error(err);
    toast('Could not open that board: ' + detailOf(err), 'error');
    return false;
  } finally {
    resetSessionLatches();
    job.end();
  }
}

/**
 * Point a shelf row at the file again, after it moved.
 *
 * Desktop only, and the repair for the one failure a path row has that a blob
 * row does not: the board is somewhere this app is not allowed to go looking.
 * There is no copy to fall back on, deliberately - keeping one is the two-places
 * problem the whole design of a path row avoids - so the only honest answer is
 * to ask where the file went.
 *
 * It rewrites the row rather than opening the board. Somebody repairing four
 * rows in a row should not be opening four boards on the way past, and the row
 * being right again is the thing they asked for.
 */
export async function relocateLibraryBoard(id: string) {
  try {
    const { ref } = await platform.files.pickOpen(PICK_SPEC);
    if (!ref.path) return false;
    const row = (await libraryIndex()).find(e => e.id === id);
    await putLibraryBoard(id, null, {
      title: row?.title, at: row?.at, thumb: row?.thumb, path: ref.path,
    });
    return true;
  } catch (err) {
    if (isAbort(err)) return false;
    console.error(err);
    toast('Could not find that board: ' + detailOf(err), 'error');
    return false;
  }
}

/** Take a board off the shelf. The board on screen cannot be deleted from under itself.
 *  `file` is a board in the boards folder: it goes to the bin with its row, or
 *  the folder would list it again at the next look. A file elsewhere only
 *  leaves the list. */
export async function deleteLibraryBoard(id: string, { file = '' } = {}) {
  if (id === boardId) {
    toast('That is the board you are on - switch away from it first');
    return false;
  }
  if (file) {
    try {
      await platform.files.folder?.trash({ name: fileNameOf(file), path: file });
    } catch (err) {
      console.error(err);
      toast('Could not move that board to the bin: ' + detailOf(err), 'error');
      return false;
    }
  }
  if (!id.startsWith(FILE_ID)) await removeLibraryBoard(id);
  return true;
}

// ---------------------------------------------------------------------------
// The boards folder (the apps)
// ---------------------------------------------------------------------------
//
// On the desktop no board lives inside the app. That is the web's limit, and a
// desktop has a disk: every board is a .mbrd file, and the ones the app makes
// go into the boards folder the shell keeps (Documents/mbrd). The board on
// screen always has its file. New makes it at once, and the autosave
// (session.ts) writes the edits to it, adding only what changed. The file is
// the only copy: the store keeps which file it is and where the view was.
//
// Android keeps the same folder (MbrdBoards.java): Documents/mbrd with the
// storage grant. On the web `folder` stays null and everything here stands down.

/** The boards folder, once the shell has named one. */
let folder: string | null = null;

/** Where the boards are, for the board list's Open folder. Null on the web. */
export const boardFolder = () => folder;

/** A file in the folder with no shelf row is listed under this id. */
const FILE_ID = 'file:';

/**
 * Where this session's last write left each entry of the board's file, so the
 * next save can append only what changed (packBoardFile()). Null until a write
 * has happened in this session, and read from the file's own end until then
 * (priorLayout()). Save and Export keep it (writeBoardFile()).
 */
let fileLayout: { path: string, layout: ZipLayout } | null = null;

/** Set by Optimize: the next write is whole, so what it shrank leaves the
 *  file rather than staying in it as dead bytes. */
let writeWhole = false;

/** The next save to the board's file writes it whole, compacting it. */
export function forgetFileLayout() { fileLayout = null; writeWhole = true; }

/** Read from a board's end for its directory: 1500 entries make one near
 *  200 KB. A longer one is read again at its own length, up to TAIL_MAX. */
const TAIL_READ = 256 * 1024;
const TAIL_MAX = 32 * 1024 * 1024;

/**
 * Where each entry of the file at `ref` sits, for an append: this session's
 * last write to it, or else the file's own directory, read from its end, so
 * the first save after a start adds what changed instead of the whole board.
 * Null for no path, no file yet, or a directory that will not read.
 */
async function priorLayout(ref: DocumentRef): Promise<ZipLayout | null> {
  if (!ref.path || writeWhole) return null;
  if (fileLayout?.path === ref.path) return fileLayout.layout;
  const tail = platform.files.tail;
  if (!tail) return null;
  try {
    let read = await tail(ref, TAIL_READ);
    let found = layoutFromTail(read.bytes, read.size);
    if (typeof found === 'number' && found <= TAIL_MAX) {
      read = await tail(ref, found);
      found = layoutFromTail(read.bytes, read.size);
    }
    return typeof found === 'number' ? null : found;
  } catch {
    // Most often a file that is not there yet. Written whole, as before.
    return null;
  }
}

/** Bumped by every change the file should hear about, so a write that ran
 *  while somebody kept working does not mark the newer work as written. */
let edits = 0;
for (const evt of ['items', 'geom', 'item', 'settings', 'board', 'trash'] as const) {
  bus.on(evt, () => { edits++; });
}

/** File work, one piece at a time: a write, a rename, Save. A rename between
 *  a write's temp file and its rename would leave two files. */
let fileWork: Promise<unknown> = Promise.resolve();
function inTurn<T>(work: () => Promise<T>): Promise<T> {
  const run = fileWork.then(work);
  fileWork = run.catch(() => {});
  return run;
}

/** Set by adoptFolder(). A write waits for it, or the board on screen could
 *  get a second file before its first one is found. */
let adopted: Promise<void> = Promise.resolve();

/** The title the file is named for, so that only a rename renames it. */
let namedTitle = '';

/** Said once per run of trouble, not once per tick. */
let warnedFile = false;

// A rename is the one title change that dirties the board: a load and a Save
// both change the title with the flag down. The edits reach the file through
// the autosave (session.ts), which calls saveDocument().
bus.on('board', () => {
  if (isDirty() && folder && board.title !== namedTitle) void renameDocument();
});
bus.on('board:load', () => { namedTitle = board.title; });

/** The id of the shelf row that already points at this file, if one does. */
async function rowForFile(ref: DocumentRef | null) {
  if (!ref?.path) return undefined;
  return (await libraryIndex()).find(e => e.path === ref.path)?.id;
}

/** Point the board's shelf row at its file. The picture stays what it was:
 *  taking one costs a render, and the timer runs while somebody works. */
async function fileRow() {
  if (!doc?.path) return;
  const id = await ensureBoardId();
  const row = (await libraryIndex()).find(e => e.id === id);
  await putLibraryBoard(id, null, {
    title: board.title, at: Date.now(), thumb: row?.thumb ?? null, path: doc.path,
  });
}

/**
 * Write the board on screen to its file, and make the file first if it has none.
 *
 * Answers whether the file now holds the board. Quiet when it works, because
 * the autosave runs it: the dirty mark going out is the whole receipt.
 */
export async function saveDocument(): Promise<boolean> {
  await adopted;
  return writeDocument();
}

/**
 * Write the board to the file `ref` names, from inside inTurn(). When the
 * file's layout is known (priorLayout()) and the shell can append, only what
 * changed goes: a Save that moved one card on a 400 MB board writes that card's
 * worth. Whole otherwise - `whole` for a file just picked, which may be another
 * board being replaced, `compact` for a file appends have left too dead
 * (worthCompacting()) - and whole again if the append is refused. Either way
 * fileLayout then describes the file.
 */
async function writeBoardFile(
  ref: DocumentRef, data: PackedBoard,
  { allowMissing, whole = false, compact = false, writing }:
    { allowMissing: boolean, whole?: boolean, compact?: boolean, writing?: () => void },
) {
  const append = platform.files.append;
  let prior = append && !whole ? await priorLayout(ref) : null;
  // A Save somebody waits for anyway: the moment to drop what appends left.
  if (prior && compact && worthCompacting(deadBytes(prior), prior.size)) prior = null;
  let packed = await packBoardFile(data, { created, allowMissing, prior });
  created = packed.manifest.created;
  writing?.();
  if (packed.appended && append && prior) {
    // Refused when the file changed length under the page: written whole.
    try { await append(ref, packed.blob, prior.size); }
    catch (err) {
      console.warn('[mbrd] could not append to the board file, writing it whole:', err);
      packed = await packBoardFile(data, { created, allowMissing });
      await platform.files.write(ref, packed.blob);
    }
  } else {
    await platform.files.write(ref, packed.blob);
  }
  fileLayout = ref.path ? { path: ref.path, layout: packed.layout } : null;
  writeWhole = false;
}

/**
 * Dead bytes worth a whole write at a quiet moment: a fifth of the file once
 * that is 4 MB, or 64 MB whatever its size. An append by itself writes whole
 * only past half (packBoardFile()), which let a 388 MB board sit at 650 MB;
 * a quiet moment is the cheaper time to do the same sooner.
 */
const COMPACT_MIN = 4 * 1024 * 1024;
const COMPACT_ANY = 64 * 1024 * 1024;
export function worthCompacting(dead: number, size: number) {
  return dead >= COMPACT_ANY || (dead >= COMPACT_MIN && dead * 5 >= size);
}

/**
 * Write the board's file whole when appends have left enough of it dead, and
 * answer whether that happened. For quiet moments - a minute with no edit, the
 * app going to the background - since a whole write of a 400 MB board takes
 * seconds. The rename over the old file is atomic in both shells, so one cut
 * short leaves the file as it was.
 */
export async function compactDocument(): Promise<boolean> {
  await adopted;
  if (!folder || !platform.files.append || notUsersBoard()) return false;
  return inTurn(async () => {
    const ref = doc;
    if (!ref?.path) return false;
    const prior = await priorLayout(ref);
    if (!prior || !worthCompacting(deadBytes(prior), prior.size)) return false;
    const gen = edits;
    try {
      await writeBoardFile(ref, serializeBoard(), { allowMissing: true, whole: true });
      if (edits === gen) markDirty(false);
      return true;
    } catch (err) {
      // The appends go on as before; the next quiet moment tries again.
      console.warn('[mbrd] could not compact the board file:', err);
      return false;
    }
  });
}

/** saveDocument() without the wait, for adoptFolder(), which is what it waits for. */
function writeDocument(): Promise<boolean> {
  const port = platform.files.folder;
  if (!folder || !port || notUsersBoard()) return Promise.resolve(true);
  return inTurn(async () => {
    if (doc?.path && !isDirty()) return true;
    const gen = edits;
    try {
      // A board a picture short still goes to its file, as it goes to the
      // shelf. Refusing would stop the file hearing about every later edit.
      const data = serializeBoard();
      if (doc?.path) {
        await writeBoardFile(doc, data, { allowMissing: true });
      } else {
        const packed = await packBoardFile(data, { created, allowMissing: true });
        created = packed.manifest.created;
        doc = await port.create(fileNameFor(board.title), packed.blob);
        fileLayout = doc.path ? { path: doc.path, layout: packed.layout } : null;
        namedTitle = board.title;
        reportDocument();
      }
      await fileRow();
      warnedFile = false;
      // Work done while this wrote is the next autosave's: it loops on it.
      if (edits === gen) markDirty(false);
      return true;
    } catch (err) {
      console.error('[mbrd] could not write the board to its file:', err);
      if (!warnedFile) {
        warnedFile = true;
        toast('Could not write ' + (doc?.name || 'the board file') + ': ' + detailOf(err), 'error');
      }
      return false;
    }
  });
}

/** Rename the file after the board, when the board was renamed. The shell
 *  renames only a board in the folder, and leaves a file elsewhere alone. */
async function renameDocument() {
  await adopted;
  const port = platform.files.folder;
  if (!folder || !port) return;
  await inTurn(async () => {
    const ref = doc;
    if (!ref?.path || board.title === namedTitle) return;
    namedTitle = board.title;
    // A name that already reads as this title stays. "My Board.mbrd" from
    // Explorer and My_Board.mbrd name one board, and a rename would move
    // somebody's file for a spelling.
    if (titleFromFileName(ref.name) === board.title) return;
    try {
      const moved = await port.rename(ref, fileNameFor(board.title));
      if (!moved || moved.path === ref.path) return;
      doc = moved;
      reportDocument();
      await fileRow();
    } catch (err) {
      console.error('[mbrd] could not rename the board file:', err);
      toast('Could not rename ' + ref.name + ': ' + detailOf(err), 'error');
    }
  });
}

/**
 * Find the boards folder, and move every board kept inside the app into it.
 *
 * Called once at start, after the store's board is back on screen. Each board
 * the shelf held as a packed copy becomes a file named for its title, and its
 * row becomes a pointer at that file, the row a saved board always had. The
 * board on screen gets its file back from its row, or a new one. On a later
 * start there is nothing to move: every row is a pointer by then.
 */
export function adoptFolder(): Promise<void> {
  adopted = (async () => {
    const port = platform.files.folder;
    if (!port) return;
    const listing = await port.list();
    if (!listing) return;
    folder = listing.folder;
    const id = await ensureBoardId();
    const rows = await libraryIndex();
    // The board on screen, back at its file. A file that has gone since is
    // made again at the next write, under the board's name.
    const mine = rows.find(e => e.id === id);
    if (!doc && mine?.path) {
      const ref = { name: fileNameOf(mine.path), path: mine.path };
      if (await platform.files.exists(ref)) {
        doc = ref;
        reportDocument();
      }
    }
    namedTitle = board.title;
    const packed = rows.filter(e => !e.path && e.id !== id);
    let moved = 0;
    if (packed.length) {
      const job = busy('Moving your boards into their folder');
      try {
        for (const [i, row] of packed.entries()) {
          job.step(i, packed.length);
          try {
            const blob = await getLibraryBoard(row.id);
            // A row with nothing behind it was a lost board already.
            if (!blob) { await removeLibraryBoard(row.id); continue; }
            const ref = await port.create(fileNameFor(row.title), blob);
            await putLibraryBoard(row.id, null, {
              title: row.title, at: row.at, thumb: row.thumb, path: ref.path,
            });
            moved++;
          } catch (err) {
            // The row keeps its blob, and the next start tries it again.
            console.error('[mbrd] could not move a board into the folder:', err);
          }
        }
      } finally {
        job.end();
      }
      if (moved) toast(`Moved ${moved} board${moved === 1 ? '' : 's'} into ${folder}`);
      if (moved < packed.length) {
        toast(`${packed.length - moved} board${packed.length - moved === 1 ? '' : 's'} stayed `
          + 'inside the app. mbrd tries again at the next start.', 'error');
      }
    }
    // The board on screen last. Its own blob row goes when its file is written.
    await writeDocument();
  })().catch(err => {
    console.error('[mbrd] could not open the boards folder:', err);
    toast('Could not open the boards folder: ' + detailOf(err), 'error');
  });
  return adopted;
}

/**
 * Boot, in the apps: the board the last run was on, read back from its file,
 * which is the only copy there is (session.ts keeps none). Read as a Blob the
 * shell handed over, so its pictures stay where they are in it.
 */
async function reopenFile(path: string): Promise<boolean> {
  const ref: DocumentRef = { name: fileNameOf(path), path };
  const job = busy('Opening ' + ref.name);
  try {
    if (!(await platform.files.exists(ref))) {
      toast(`${ref.name} has moved or been deleted, so it could not be reopened`, 'error');
      return false;
    }
    const file = await platform.files.read(ref);
    await withFreshAssets(async () => {
      const { manifest, board: data } = await unpackBoard(file, { owned: true });
      loadBoard(data);
      created = (typeof manifest.created === 'string' && manifest.created) || null;
    });
    doc = ref;
    reportDocument();
    return true;
  } catch (err) {
    console.error(err);
    toast('Could not reopen ' + ref.name + ': ' + detailOf(err), 'error');
    return false;
  } finally {
    job.end();
  }
}

/** Open a board in the folder that has no shelf row yet. */
async function openBoardFile(path: string) {
  const ref: DocumentRef = { name: fileNameOf(path), path };
  try {
    if (!(await platform.files.exists(ref))) {
      toast('That board has moved or been deleted', 'error');
      return false;
    }
    return await openFile(await platform.files.read(ref), ref);
  } catch (err) {
    console.error(err);
    toast('Could not open that board: ' + detailOf(err), 'error');
    return false;
  }
}

/** One board in the list: a shelf row, or a file in the folder with no row yet. */
export type BoardEntry = LibraryEntry & { current: boolean, inFolder: boolean };

/** Paths compared without case or slash direction. Windows and macOS match
 *  names without case, and one board listed twice is the worse mistake. */
const pathKey = (path: string) => path.replace(/\\/g, '/').toLowerCase();
const folderOf = (path: string) => path.slice(0, Math.max(path.lastIndexOf('/'), path.lastIndexOf('\\')));

/**
 * The boards to show: the shelf, and on the desktop every board in the folder.
 *
 * A file in the folder with no row is listed under FILE_ID, with no picture
 * until it has been opened and left. A row whose file was in the folder and is
 * gone was deleted outside the app, so the row goes too: the folder is the
 * list. A row for a file elsewhere stays, there or not, because Locate is the
 * repair for a file somebody moved.
 */
export async function listBoards(): Promise<BoardEntry[]> {
  const rows = await listLibrary();
  const listing = folder ? await platform.files.folder?.list().catch(() => null) : null;
  if (!listing) return rows.map(r => ({ ...r, inFolder: false }));
  const home = pathKey(listing.folder);
  const within = (path: string) => pathKey(folderOf(path)) === home;
  const files = new Map(listing.files.map(f => [pathKey(f.path), f]));
  const seen = new Set<string>();
  const out: BoardEntry[] = [];
  for (const row of rows) {
    if (!row.path) { out.push({ ...row, inFolder: false }); continue; }
    const key = pathKey(row.path);
    // Two rows for one file, from before a reopen found its row: the newer one.
    if (seen.has(key)) continue;
    seen.add(key);
    if (within(row.path) && !files.has(key) && !row.current) {
      await removeLibraryBoard(row.id).catch(() => {});
      continue;
    }
    out.push({ ...row, inFolder: within(row.path) });
  }
  for (const [key, f] of files) {
    if (seen.has(key)) continue;
    out.push({
      id: FILE_ID + f.path, title: titleFromFileName(f.name), at: f.at, thumb: null,
      path: f.path, current: false, inFolder: true,
    });
  }
  return out.sort((a, b) => (b.at || 0) - (a.at || 0));
}

/** Open the boards folder in the file manager. */
export async function revealBoardFolder() {
  try {
    await platform.files.folder?.reveal();
  } catch (err) {
    console.error(err);
    toast('Could not open the boards folder: ' + detailOf(err), 'error');
  }
}

// ---------------------------------------------------------------------------
// The façade
// ---------------------------------------------------------------------------

// Save, Export and Open live here; the browser's own copy lives in session.ts.
// Every caller still asks this module, which is what kept the split from
// reaching main.ts, ui/board-actions.ts, commands.ts and four tests. Written out
// rather than as a star re-export for the reason state.ts is: a name that goes
// missing should break loudly at the import, not quietly at runtime.
export {
  autosave, restoreSession, clearAllData, clearSession,
  // Out to main.ts, which hands it to the global error handler. It is not part
  // of saving at all - it is the one question a broken app has to be able to
  // answer about a board - but the latches that answer it are session.ts's, so
  // it is asked where they live rather than reconstructed anywhere else.
  boardSafety,
  // Out for the same reason and to the same kind of caller: the Debug fold's
  // safety row says what went wrong as well as that something did, and the text
  // is the engine's own.
  lastSaveFailure,
  // Out to main.ts as well as used in here, and as a pair: a boot into
  // not-found opens a blank board that must never be written over the one the
  // visitor already has, so the writer is stopped before anything can fire.
  // resetSessionLatches is how it comes back on, once the board underneath is
  // the real one - see leaveNotFound() in main.ts. failHandover is the third of
  // them, for the way out that the handover reaching neither end leaves behind.
  suspendCache, resetSessionLatches, failHandover,
} from './session.ts';
export { fileNameFor, titleFromFileName, titleForOpenedBoard } from './naming.ts';

/**
 * Bring persistence up: hand the session engine the five things it borrows from
 * this half, then start it.
 *
 * The handle and the created-stamp go through as getters because both are
 * reassigned here - opening a file replaces them - and a captured value would
 * go stale the first time somebody opened a board.
 */
export function initStorage() {
  initSession({
    fileName: () => doc?.name || null,
    created: () => created,
    setCreated: at => { created = at; },
    exportBoard,
    prompt: opts => prompt(opts),
    fileBacked: () => !!folder && !!doc?.path,
    filePath: () => doc?.path ?? null,
    settled: () => adopted,
    saveFile: () => saveDocument(),
    reopen: reopenFile,
  });
  initSessionStorage();
}
