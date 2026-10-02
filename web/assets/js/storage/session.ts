// IndexedDB working cache, background autosave, and boot restore. Split from
// storage.ts on the question "who owns the file handle" — not this module.
// The seam is `d` (deps from storage.ts); nothing here imports it back.
// On the web this is crash recovery and the durable artefact is an exported
// .mbrd. In the apps the board's own file is the save, and the store keeps no copy.

import { itemHashes, isRecord } from '../util.ts';
// Timeline references, read from the stored document like everything else.
import { timelineHashes } from '../timeline.ts';
import { toast, busy } from '../notify.ts';
import type { ToastAction } from '../notify.ts';
import { clearPrefs } from '../prefs.ts';
import {
  board, serializeBoard, loadBoard, markDirty, isDirty, bus, isNotFoundBoard, notUsersBoard,
  isBenchBoard,
} from '../state.ts';
import { allAssets, getAsset, putAsset } from './assets.ts';
import {
  idbGet, idbSet, idbDel, idbClear, idbKeys, idbGetMany, idbSetMany, idbDelMany,
} from './idb.ts';
import { clearMatteCache } from './matte-cache.ts';
// Type only — errors.ts sits in the base layer, reads through setBoardProbe().
import type { BoardSafety } from '../errors.ts';
import { platform, isDesktop } from '../platform/platform.ts';

/** What this engine borrows from the file half. Filled by initSession(). */
export interface SessionDeps {
  fileName: () => string | null;
  /** The board's first-created stamp, as packBoard writes it: an ISO string. */
  created: () => string | null;
  setCreated: (at: string | null) => void;
  exportBoard: () => Promise<boolean>;
  prompt: (opts: PromptOptions) => Promise<string | null>;
  // The apps. Absent, as in a test wired by hand, is the web.
  /** Whether the board on screen is a file in the boards folder, which is then
   *  the save: the autosave writes it, and the store keeps no copy. */
  fileBacked?: () => boolean;
  filePath?: () => string | null;
  /** Resolves once the boards folder is known (adoptFolder()). */
  settled?: () => Promise<void>;
  /** Write the board to its file (saveDocument()). */
  saveFile?: () => Promise<boolean>;
  /** Boot: open the board file the last run was on. */
  reopen?: (path: string) => Promise<boolean>;
  /** The shelf id of the board on screen, stored with each snapshot. */
  boardId?: () => Promise<string>;
  /** Boot: make the restored snapshot's id the current one. */
  adoptBoardId?: (id: string) => Promise<void>;
}

/** The one dialog this module asks for - see ask() in ui/dialog.ts. */
export interface PromptOptions {
  title: string;
  body?: string;
  keep?: string;
  cancel?: string;
  go?: string;
    /** Whether `go` is styled destructive. Absent = decide from shape. */
  danger?: boolean;
}

/** Null until initSession(). Every `d!` below runs from a command, bus event
 *  or autosave — all downstream of init. */
let d: SessionDeps | null = null;

/** Hand the session engine what it needs from the file half. Called once. */
export function initSession(deps: SessionDeps) {
  d = deps;
  // A boot has started, so what is in the store is not known until
  // restoreSession() has been in and looked. See boardSafety(), and `opened`
  // for why the default is the other way round.
  opened = false;
}

/** Loose board shape for referencedHashes() — asked of both serializeBoard()
 *  output and raw IndexedDB data (`unknown` until inspected). */
type BoardLike = {
  items?: unknown, trash?: unknown, settings?: unknown, timeline?: unknown,
};

/** The list at a key, or none. What `data.items || []` said before it had a type. */
const listOf = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);

/** A string, or nothing. The narrowing the records below need at each key. */
const str = (v: unknown): string | undefined => (typeof v === 'string' ? v : undefined);

// ---------------------------------------------------------------------------
// IndexedDB working cache
// ---------------------------------------------------------------------------

const SESSION_KEY = 'session';
/** How often the background autosave writes, if anything has changed. */
const AUTOSAVE_MS = 20000;
let cacheOk = true;
/** True when caching is off deliberately (not-found board), not due to a write
 *  failure. Same latch as cacheOk, different error message. */
let suspended = false;
/** Last failure reason. Read via lastSaveFailure(), cleared by resetSessionLatches(). */
let lastFailure = '';
/** Whether the "some bytes are missing" toast has already been shown. */
let warnedIncomplete = false;

/**
 * The browser refused a write, and the cache is off for the rest of the board.
 *
 * Its own flag rather than `!cacheOk`, because three deliberate doors turn the
 * cache off too - suspendCache() for the not-found board, /patch and the bench,
 * and the wipe in clearAllData() - and none of those is a board in danger. This
 * is the one that is: every edit from here on lives only in the tab.
 *
 * While it holds, the HUD keeps a standing mark ('save:refused' on the bus) and
 * the tab asks before it closes on unsaved edits. The guard comes and goes with
 * the flag because a page with a beforeunload listener is kept out of the
 * back-forward cache, and the ordinary board has no reason to pay for that -
 * the autosave and the pagehide flush already cover it, which stops being true
 * only here.
 */
let refused = false;

function guardClose(e: BeforeUnloadEvent) {
  if (!isDirty()) return;
  e.preventDefault();
  // The legacy half, which some engines still need to show the question.
  e.returnValue = '';
}

function setRefused(on: boolean) {
  if (refused === on) return;
  refused = on;
  // Not in the apps: there a beforeunload that answers closes nothing, and
  // silently, and the board is a file with its own save anyway.
  if (!isDesktop()) {
    if (on) globalThis.addEventListener?.('beforeunload', guardClose);
    else globalThis.removeEventListener?.('beforeunload', guardClose);
  }
  bus.emit('save:refused', on);
}

/** Whether the browser has stopped keeping this board - see `refused`. */
export const saveRefused = () => refused;

/** Suppresses the first autosave announcement per board load. Two gates:
 *  `isDirty` (pan is not an edit) and `quiet` (a restored session bumps the
 *  generation but nobody touched it). Failures are already toasted by autosave(). */
let quiet = true;
const hushNextSave = () => { quiet = true; };

// Bump the change generation so a later save knows this edit is not yet on disk.
// This runs even while caching is off; the tick below is what gates on cacheOk.
const noteChange = () => { saveGen++; };

async function autosaveTick() {
  if (committedGen >= saveGen || !cacheOk) return;   // nothing new, or caching off
  const announce = isDirty() && !quiet;
  quiet = false;
  const ok = await autosave().catch(() => false);
  if (ok && announce) bus.emit('autosaved');
}

// Cooldown between background autosaves — bursts of edits coalesce into one
// write. Explicit Save (Ctrl+S) and pagehide bypass this.
const AUTOSAVE_COOLDOWN_MS = 5000;
let lastAutosaveAt = 0;
let coolTimer = 0;

function requestAutosave() {
  const wait = AUTOSAVE_COOLDOWN_MS - (Date.now() - lastAutosaveAt);
  if (wait <= 0) {
    lastAutosaveAt = Date.now();
    autosaveTick().catch(() => {});
  } else if (!coolTimer) {
    // Inside the cooldown: fire once when it lifts, catching the newest edit.
    coolTimer = setTimeout(() => {
      coolTimer = 0;
      lastAutosaveAt = Date.now();
      autosaveTick().catch(() => {});
    }, wait);
  }
}

/** Every hash a snapshot needs: items, bin, and fonts. Taken from the
 *  serialised board (not in-memory store, which also holds undo-only bytes
 *  that do not survive a reload). */
function referencedHashes(data: BoardLike) {
  const out = new Set<string>();
  // One pass for item hashes + optimiser originals (meta.was/wasCover).
  // Originals are NOT in itemHashes() (that drives the packer, which exports
  // only the small copies). Here they are kept because the sweep would otherwise
  // delete the bytes an undo entry needs to put back. Bin included — a binned
  // optimised item still carries meta.was.
  const add = (it: unknown) => {
    if (!isRecord(it)) return;
    for (const h of itemHashes(it)) out.add(h);
    const meta = isRecord(it.meta) ? it.meta : null;
    const was = str(meta?.was);
    const wasCover = str(meta?.wasCover);
    if (was) out.add(was);
    if (wasCover) out.add(wasCover);
  };
  for (const it of listOf(data.items)) add(it);
  for (const t of listOf(data.trash)) add(isRecord(t) ? t.item : null);
  // Timeline — the one class whose purpose is naming things the board no longer
  // has (a delete step carries the photo on its before side). Unlike undo, the
  // timeline survives reloads, so its hashes must be kept.
  for (const hash of timelineHashes(data.timeline)) out.add(hash);
  // Fonts — not on any item, so the sweep would delete them without this.
  const settings = isRecord(data.settings) ? data.settings : null;
  for (const f of listOf(settings?.fonts)) {
    const hash = isRecord(f) ? str(f.hash) : undefined;
    if (hash) out.add(hash);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Save coordinator (single-flight)
// ---------------------------------------------------------------------------
//
// One writer at a time: `saveGen` counts changes, a run captures the current
// gen and loops if newer edits landed mid-write. Prevents stale snapshots and
// stale sweeps (AUD-02).
let saveGen = 0;         // bumped by every change worth a snapshot
let committedGen = -1;   // saveGen of the last durable write (-1: nothing yet)
let saving: Promise<boolean> | null = null;   // in-flight run, or null
let lastResult = false;  // result of the most recent completed run
/** Whether the store has been read. initSession() → false, restoreSession() →
 *  true. Used by boardSafety() alone — true by default so tests and manual
 *  loads are never in doubt. */
let opened = true;

/** Persist working state. Concurrent callers coalesce into one writer.
 *  Mid-write changes trigger a follow-up write. */
export function autosave() {
  const wanted = saveGen;
  if (!saving && committedGen >= wanted) return Promise.resolve(lastResult);
  if (!saving) saving = runSaves();
  return saving.then(() => (committedGen >= wanted ? lastResult : false));
}

async function runSaves() {
  try {
    for (;;) {
      const gen = saveGen;
      const ok = await writeSnapshot();
      lastResult = ok;
      if (ok) committedGen = gen;
      // Stop on failure - a full disk must not spin - or when no newer edit
      // landed while this write ran. Otherwise loop and write the newest.
      if (!ok || saveGen === gen) return ok;
    }
  } finally {
    saving = null;
  }
}

/** Wait for any in-flight save. Called before clearing the store so an
 *  in-flight write does not repopulate after the wipe. */
export async function drainSave() {
  if (saving) { try { await saving; } catch { /* not our result */ } }
}

/** Write working state to IndexedDB and sweep unreferenced assets.
 *  Order: (1) write new assets, (2) write snapshot, (3) delete unreferenced.
 *  A failure at any step leaves the previous snapshot intact. Survives torn
 *  batches (idb.ts file backend has no multi-store transactions). */
async function writeSnapshot() {
  // Suspended at boot as well (main.ts), but that latch has doors that lift it
  // and this one has none: the benchmark's board is never the session.
  if (isBenchBoard()) {
    lastFailure = 'This is the benchmark board - nothing on it is saved';
    return false;
  }
  if (!cacheOk) {
    // Different message for suspended (deliberate) vs. broken (quota/block).
    lastFailure = suspended
      ? 'This address has no board of its own yet - put something on it, or export a file'
      : 'This browser will not store the board (full, or blocked) - export it to a file';
    return false;
  }
  // Not before the folder is known, or a write at start would put a copy of
  // the whole board back into the store.
  await d!.settled?.();
  if (d!.fileBacked?.()) return writeToFile();
  try {
    // Read before the serialise, so no await falls between the id and the board.
    const boardId = await d!.boardId?.();
    // Serialise once — snapshot and asset set must describe the same board.
    const data = serializeBoard();
    const referenced = referencedHashes(data);
    const known = new Set(await idbKeys('assets'));
    const store = allAssets();

    // Collect missing hashes (board with a hole must not claim success).
    // Written in one batch — sequential transactions were too slow for large imports.
    const missing: string[] = [];
    const arriving: [IDBValidKey, unknown][] = [];
    for (const hash of referenced) {
      if (known.has(hash)) continue;
      const asset = store.get(hash);
      if (!asset) { missing.push(hash); continue; }
      arriving.push([hash, {
        blob: asset.blob, ext: asset.ext, mime: asset.mime, name: asset.name,
      }]);
    }
    await idbSetMany('assets', arriving);

    // Written even when incomplete (a partial snapshot beats none), but
    // returned as failure so the board stays dirty.
    await idbSet('kv', SESSION_KEY, {
      board: data,
      boardId: boardId ?? null,
      created: d!.created(),
      fileName: d!.fileName() || null,
      dirty: isDirty() || missing.length > 0,
      at: Date.now(),
      incomplete: missing.length > 0,
    });

    // Non-string keys cannot be content hashes — always unreferenced.
    await idbDelMany('assets',
      [...known].filter(key => typeof key !== 'string' || !referenced.has(key)));

    if (missing.length) {
      lastFailure = `${describeMissing(data, missing)} - the board cannot be saved complete`;
      // Once per run of trouble, not once per tick.
      if (!warnedIncomplete) {
        warnedIncomplete = true;
        toast(lastFailure, 'error', showMissing());
      }
      return false;
    }
    warnedIncomplete = false;
    lastFailure = '';
    return true;
  } catch (err) {
    // Quota or a private-mode refusal: stop trying and say so once.
    cacheOk = false;
    console.warn('[mbrd] autosave disabled:', err);
    lastFailure = 'This browser will not store the board (full, or blocked) - export it to a file';
    const deps = d!;
    toast(lastFailure, 'error', { label: 'Export', run: () => { void deps.exportBoard(); } });
    setRefused(true);
    return false;
  }
}

/**
 * The apps: the board's own file is the save. The store keeps which file that
 * is and where the view was - a pan is not an edit, so the file does not hear
 * of it - and no copy of the board. The pictures a copy from before kept are
 * deleted once the file holds the board.
 */
async function writeToFile() {
  if (!(await d!.saveFile!())) {
    lastFailure = 'The board could not be written to its file';
    return false;
  }
  lastFailure = '';
  try {
    const { pan, zoom } = board.view;
    await idbSet('kv', SESSION_KEY, { file: d!.filePath!(), view: { pan: { ...pan }, zoom }, at: Date.now() });
    const left = await idbKeys('assets');
    if (left.length) await idbDelMany('assets', left);
  } catch (err) {
    // The board is in its file. What failed is the note of where it is.
    console.warn('[mbrd] could not note which file the board is:', err);
  }
  return true;
}

/** Boot, in the apps: the board is its file, and the record says which. */
async function restoreFile(file: string, view: unknown) {
  if (!(await d!.reopen!(file))) return false;
  const pan = isRecord(view) && isRecord(view.pan) ? view.pan : null;
  if (isRecord(view) && pan) {
    board.view = { pan: { x: Number(pan.x) || 0, y: Number(pan.y) || 0 }, zoom: Number(view.zoom) || 1 };
  }
  return true;
}

/**
 * "Show them", for a toast about files that are gone: the cards that name
 * one, selected and framed - they are marked (canvas/item-dom.ts) but may be
 * anywhere on the board. Each takes the file back through Replace file… or by
 * dropping it in again (import/drop.ts heals it). None when no card names a
 * missing file, which is a lost cover or font with nothing to point at.
 */
function showMissing(): ToastAction | undefined {
  const ids = board.items
    .filter(it => itemHashes(it).some(h => !getAsset(h)))
    .map(it => it.id);
  if (!ids.length) return undefined;
  return { label: 'Show them', run: () => bus.emit('reveal', ids) };
}

/** "2 items (photo.jpg, note) have no stored data", for a message. */
function describeMissing(data: BoardLike, hashes: string[]) {
  const wanted = new Set(hashes);
  const names: string[] = [];
  for (const it of [...listOf(data.items), ...listOf(data.trash).map(t => (isRecord(t) ? t.item : null))]) {
    const item = isRecord(it) ? it : null;
    const hash = isRecord(item?.asset) ? str(item.asset.hash) : undefined;
    if (!hash || !wanted.has(hash)) continue;
    wanted.delete(hash);
    names.push(str(item?.name) || str(item?.type) || 'item');
  }
  // Missing hash may be a cover, original, or font — no item to name.
  if (!names.length) {
    return `${wanted.size} file${wanted.size === 1 ? '' : 's'} this board needs ` +
      `${wanted.size === 1 ? 'is' : 'are'} not stored`;
  }
  const shown = names.slice(0, 3).join(', ');
  const rest = names.length > 3 ? ` and ${names.length - 3} more` : '';
  return `${names.length} item${names.length === 1 ? '' : 's'} ` +
    `(${shown}${rest}) ${names.length === 1 ? 'has' : 'have'} no stored data`;
}

/** Restore the last working state. Returns true when a board was recovered. */
export async function restoreSession() {
  try {
    // Comes back as `unknown` — narrowed one key at a time.
    const session = await idbGet('kv', SESSION_KEY);
    if (!isRecord(session)) return false;
    if (typeof session.file === 'string' && d?.reopen) return await restoreFile(session.file, session.view);
    const stored = session.board;
    if (!isRecord(stored) || !stored.items) return false;
    // Same referencedHashes() as the sweep — bin included. Previously only
    // checked `asset.hash`, missing covers, stills, and fonts.
    const needed = referencedHashes(stored);
    let lost = 0;
    // Chunked reads: one-at-a-time was hundreds of sequential round trips;
    // all-at-once removes the progress bar. Chunks give both speed and feedback.
    const CHUNK = 32;
    const list = [...needed];
    const job = busy('Restoring your board');
    try {
      for (let i = 0; i < list.length; i += CHUNK) {
        job.step(i, list.length);
        const slice = list.slice(i, i + CHUNK);
        const recs = await idbGetMany('assets', slice);
        recs.forEach((rec, k) => {
          // Blob + three strings, as written by writeSnapshot.
          const blob = isRecord(rec) && rec.blob instanceof Blob ? rec.blob : null;
          if (blob && isRecord(rec)) {
            putAsset(slice[k], blob, { ext: str(rec.ext), mime: str(rec.mime), name: str(rec.name) });
          } else lost++;
        });
      }
    } finally {
      job.end();
    }
    d!.setCreated(str(session.created) || null);
    // A switch names the next board at once, and the slot keeps the last one
    // until the next write. The snapshot's own id wins, or a later shelving
    // files this board over the other board's only copy.
    const id = str(session.boardId);
    if (id) await d!.adoptBoardId?.(id);
    loadBoard(stored);
    // Mark dirty if any assets were lost — the user needs to know before
    // they try to export.
    markDirty(!!session.dirty || lost > 0);
    if (lost) {
      console.warn(`[mbrd] ${lost} asset(s) missing from the working cache`);
      toast(`${lost} item${lost === 1 ? '' : 's'} came back without ${lost === 1 ? 'its' : 'their'} data`, 'error',
        showMissing());
    }
    return true;
  } catch (err) {
    console.warn('[mbrd] no session restored:', err);
    return false;
  } finally {
    // Store has been read — boardSafety() can now give a definite answer.
    opened = true;
  }
}

/** Wipe working-cache stores. Throws on failure (AUD-03: used to swallow
 *  errors and report success while data remained). */
export async function clearSession() {
  await idbClear('kv');
  await idbClear('assets');
  // Matte cache too — a cut-out left after "clear everything" is that photo.
  await clearMatteCache();
}

/** Empty the board slot for New: the session record and the assets. Not the
 *  whole `kv` store, which also holds the list of boards (library.ts). New
 *  wiped it with clearSession(), so the list lost every row, and the next
 *  shelving swept every packed board the list had held. */
export async function clearBoardSlot() {
  await idbDel('kv', SESSION_KEY);
  await idbClear('assets');
  await clearMatteCache();
}

/** Delete SW caches and registration (app code, not user data). Best-effort —
 *  a failure here only leaves re-downloadable scripts behind. */
async function clearAppCaches() {
  try {
    if (typeof caches !== 'undefined') {
      const names = await caches.keys();
      await Promise.all(names.map(n => caches.delete(n)));
    }
    const regs = await navigator.serviceWorker?.getRegistrations?.() || [];
    await Promise.all(regs.map(r => r.unregister()));
  } catch (err) {
    console.warn('[mbrd] could not clear app caches:', err);
  }
}

/** Wipe everything: board, assets, preferences, SW caches. Wider than New
 *  (keeps preferences) — this is "hand the machine back". Does not touch files
 *  on disk. Ends with a relaunch because too much in-memory state to reset. */
export async function clearAllData(): Promise<boolean> {
  // Not-found boards have nothing to clear — the dialog would ask about a
  // board the visitor was never shown.
  if (notUsersBoard()) {
    toast(isNotFoundBoard()
      ? 'This address has no board to clear - go to your board first'
      : 'This is the benchmark board - go back to your board first');
    return false;
  }
  const answer = await d!.prompt({
    title: 'Clear everything?',
    body: 'The board kept in this browser, everything in it and the look you '
      + 'set are all deleted, and mbrd starts over. Boards you exported to a '
      + 'file are not touched.',
    keep: board.items.length ? 'Export first' : '',
    cancel: 'Cancel',
    go: 'Delete it all',
  });
  if (answer === 'cancel') return false;
  // Export can fail or be cancelled — re-ask if so.
  if (answer === 'keep') return (await d!.exportBoard()) ? clearAllData() : false;

  // Stop saves before the wipe — a snapshot landing after clear would
  // repopulate the store.
  cacheOk = false;
  await drainSave();
  // Surface a failed wipe instead of reloading over it (AUD-03).
  try {
    await clearSession();
  } catch (err) {
    console.error('[mbrd] clear everything failed:', err);
    toast('Could not clear this browser’s storage: '
      + ((err instanceof Error && err.message) || String(err)), 'error');
    cacheOk = true;
    return false;
  }
  clearPrefs();
  // App code too — after session, since it is re-downloadable.
  await clearAppCaches();
  // Relaunch through the platform port (desktop relaunches the process).
  platform.relaunch();
  return true;
}

// ---------------------------------------------------------------------------
// Wiring
// ---------------------------------------------------------------------------

export function initSessionStorage() {
  // 'trash': emptying the bin needs a gen bump or purged items come back.
  // 'view': not dirty, but must be snapshotted so the board reopens where left.
  // `as const` so typos are caught at compile time.
  for (const evt of ['items', 'geom', 'item', 'settings', 'board', 'trash', 'view'] as const) {
    bus.on(evt, noteChange);
  }
  setInterval(requestAutosave, AUTOSAVE_MS);
  // Save promptly after committed actions. 'history' fires once per commit
  // (not during live drag), throttled to the 5s cooldown.
  bus.on('history', requestAutosave);
  // A board load is not an edit — suppress the first autosave announcement.
  bus.on('board:load', hushNextSave);
  bus.on('board:new', hushNextSave);
  // No standing beforeunload guard — autosave + pagehide flush already persist
  // the board. The one exception arms its own: see `refused`.
}

// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// What the file half reaches for
// ---------------------------------------------------------------------------

/** Why the last write into this browser failed, or '' if it did not. */
export const lastSaveFailure = () => lastFailure;

/** Is the user's work safe? Synchronous, never starts a write — called by
 *  errors.ts at crash time. Falls towards 'unknown' rather than false
 *  reassurance. Dirty flag distinguishes real edits from panning (which bumps
 *  saveGen but is not an edit). */
export function boardSafety(): BoardSafety {
  // Suspended = not-found address, no work at risk.
  if (suspended) {
    return { state: 'unknown', detail: 'this address has no board of its own, so nothing here was being saved' };
  }
  if (!cacheOk) {
    return { state: 'unsaved', detail: 'your board is not being kept in this browser, export it to a file' };
  }
  // Still booting — what is in the store is not known yet.
  if (!opened) {
    return { state: 'unknown', detail: 'your board was still being read back, so what is in this browser is not known yet' };
  }
  // Every change is covered by a write that succeeded.
  if (committedGen >= saveGen && lastResult) return { state: 'saved' };
  // Nothing the person did is waiting, whatever the generation says.
  if (!isDirty()) return { state: 'saved' };
  // Save in flight — outcome not yet known.
  if (saving) return { state: 'unknown', detail: 'a save was still running, so the last few changes may not have landed' };
  return { state: 'unsaved' };
}

/** Stop writes so a closing board's autosave cannot repopulate after clear. */
export function suspendCache() {
  cacheOk = false;
  suspended = true;
}

/** Reset all latches (cacheOk, suspended, incomplete warning, failure reason).
 *  Previous failures belonged to the closed board — a fresh start should write. */
export function resetSessionLatches() {
  cacheOk = true;
  suspended = false;
  warnedIncomplete = false;
  lastFailure = '';
  setRefused(false);
}

/** Clear `suspended` only (not `cacheOk`). After a failed handover the board
 *  may be half-restored — the writer must stay off, but the "no board of its
 *  own" message should stop applying. */
export function failHandover() {
  suspended = false;
}
