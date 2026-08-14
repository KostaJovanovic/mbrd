// The browser's own copy of the board: the IndexedDB working cache, the
// background autosave, and the restore that runs at boot.
//
// Lifted out of storage.js, which carried three different failure models in one
// file - Save (this), Export (a .mbrd on disk) and Open - and the interface
// already has to say which of them failed. They were not two sequential halves:
// this engine reached up for five things and the file half reached down for
// nine, so the split had to answer a question rather than move lines.
//
// The question was **who owns the file handle**, and the answer is: not this
// module. A handle is about the document somebody chose on disk; a session is
// about the copy this browser is keeping for them. So `d` below is the seam -
// the handle, the created-stamp, Export and the discard prompt all arrive from
// storage.js, and nothing here imports it back.
//
// This is crash recovery only. The durable artefact is always the .mbrd the
// user exported.

import { itemHashes, isRecord } from '../util.ts';
// The step ledger's share of the reference union. Read out of the stored
// document, like everything else this sweep walks.
import { timelineHashes } from '../timeline.ts';
import { toast, busy } from '../notify.ts';
import { clearPrefs } from '../prefs.ts';
import {
  board, serializeBoard, loadBoard, markDirty, isDirty, bus, isNotFoundBoard,
} from '../state.ts';
import { allAssets, putAsset } from './assets.ts';
import {
  idbGet, idbSet, idbClear, idbKeys, idbGetMany, idbSetMany, idbDelMany,
} from './idb.ts';
// The shape errors.ts will read this module's one answer through. A type only,
// and errors.ts sits in the base layer beside notify.ts - see setBoardProbe().
import type { BoardSafety } from '../errors.ts';

/** What this engine borrows from the file half. Filled by initSession(). */
export interface SessionDeps {
  fileName: () => string | null;
  /** The board's first-created stamp, as packBoard writes it: an ISO string. */
  created: () => string | null;
  setCreated: (at: string | null) => void;
  exportBoard: () => Promise<boolean>;
  prompt: (opts: PromptOptions) => Promise<string | null>;
}

/** The one dialog this module asks for - see ask() in ui/dialog.ts. */
export interface PromptOptions {
  title: string;
  body?: string;
  keep?: string;
  cancel?: string;
  go?: string;
  /**
   * Whether the `go` button is dressed as destructive. Absent means "decide
   * from the shape", which is what ui/dialog.ts did while every question this
   * app stopped to ask was a destructive one. The open-or-merge question is
   * not, and passes false.
   */
  danger?: boolean;
}

/**
 * Null until initSession(), which storage.ts calls as it is imported - so every
 * `d!` below is reached only from a command, a bus event or the autosave
 * interval, all of which are downstream of that. The alternative is a stand-in
 * object that would answer wrong once rather than throw once.
 */
let d: SessionDeps | null = null;

/** Hand the session engine what it needs from the file half. Called once. */
export function initSession(deps: SessionDeps) {
  d = deps;
}

/**
 * A board as this module reads one: the two item lists and the settings, at the
 * one depth referencedHashes() goes to. Loose on purpose, because it is asked of
 * two different things - the board serializeBoard() just produced, and the one
 * that came back out of IndexedDB, which is `unknown` until it is looked at.
 */
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
/**
 * Whether `cacheOk` is off because somebody turned it off, rather than because a
 * write failed. The two are the same latch and a completely different sentence:
 * one is "this browser will not store the board", which is alarming and, on a
 * not-found boot, untrue - the browser is fine, the app is deliberately not
 * writing, because this address is not the visitor's board.
 */
let suspended = false;
/**
 * Why the last write into this browser failed, for the button that has to say
 * so. Lives with the engine that sets it; the file half reads it through
 * lastSaveFailure() and clears all three latches through resetSessionLatches().
 */
let lastFailure = '';
/** Whether the "some bytes are missing" toast has already been shown. */
let warnedIncomplete = false;

/**
 * The background autosave, run on a fixed interval (AUTOSAVE_MS) rather than
 * after every edit. Each board-mutating event only bumps the change generation
 * (noteChange); this tick is the thing that actually writes, and only when
 * there is something new to write.
 *
 * Announces itself on the way out, and only when the save answered something
 * the user did. Two gates, because there are two ways to save nothing worth
 * mentioning:
 *
 * `isDirty` catches the clean board - panning about emits 'view', which is
 * snapshotted so the board reopens where you left it, and is not an edit.
 *
 * `quiet` catches the load. A board arriving emits 'board:load', which bumps
 * the generation like anything else - and a session restored from IndexedDB
 * comes back carrying the dirty flag it went down with, so the first gate lets
 * it through and every visit would open by announcing a save of a board nobody
 * had touched. One suppressed snapshot per board is the whole of it.
 *
 * Nothing is said about a failure here. autosave() already toasts the two ways
 * it can go wrong, and both are loud - a quiet mark in the corner going quietly
 * absent is not how you tell someone their board is not being kept.
 */
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

// No two background autosaves closer together than this. It throttles the
// per-commit save below: a burst of edits (place, move, delete in a row)
// coalesces into one write on the cooldown's trailing edge rather than a write
// apiece. The explicit Save (Ctrl+S) and the page-exit flush call autosave()
// directly and are not subject to it - they are asked-for, not automatic.
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

/**
 * Every asset hash a snapshot will need to come back whole - the live items
 * and the bin alike. The bin's bytes are not optional: restoring something
 * from it after a reload is the entire promise of a bin that survives one.
 *
 * Taken from the serialised board rather than from the in-memory asset store,
 * because those two are deliberately not the same set. The store also holds
 * bytes for items that have been deleted outright and are only reachable
 * through undo - and undo does not survive a reload (loadBoard clears the
 * history), so keeping those on disk buys nothing at all.
 */
function referencedHashes(data: BoardLike) {
  const out = new Set<string>();
  const add = (it: unknown) => {
    if (!isRecord(it)) return;
    for (const h of itemHashes(it)) out.add(h);
  };
  for (const it of listOf(data.items)) add(it);
  for (const t of listOf(data.trash)) add(isRecord(t) ? t.item : null);
  // And the history, which is the third class and the one with the sharpest
  // teeth, because it is the only one whose whole purpose is to name things the
  // board no longer has. A step that deleted a photograph carries that
  // photograph on its *before* side; that is what stepping back puts on the
  // board again. This sweep deletes whatever nothing claims, so missing it here
  // would leave the history standing and quietly unable to walk back through
  // anything that removed a picture.
  //
  // Note what this changes about the paragraph at the head of this function,
  // which reasoned that bytes reachable only through undo were not worth
  // keeping *because undo does not survive a reload*. The timeline does. That
  // argument retires with it.
  for (const hash of timelineHashes(data.timeline)) out.add(hash);
  // The files the optimiser replaced. Not in itemHashes() on purpose - that one
  // drives the *packer*, and an export is the artifact the optimising was for,
  // so it carries the small copies alone. Here they are held, because this drives
  // the sweep and the sweep would otherwise delete the very bytes the undo entry
  // exists to put back. See swapAssets() and discardOriginals() in state.js.
  // The bin as well as the board, exactly like the walk above it. A binned item
  // that was optimised still carries meta.was, discardOriginals() never clears
  // it and restoreItems() brings the item back live - so sweeping its original
  // bytes stranded it permanently: every later save then reported the hash
  // missing, refused to call itself complete, and the board never went clean
  // again. Preferred over stripping was/wasCover when an item is binned, because
  // undo across a delete closes over the old ids and stripping them would break
  // the undo the memo exists for.
  for (const it of [...listOf(data.items), ...listOf(data.trash).map(t => (isRecord(t) ? t.item : null))]) {
    const meta = isRecord(it) && isRecord(it.meta) ? it.meta : null;
    const was = str(meta?.was);
    const wasCover = str(meta?.wasCover);
    if (was) out.add(was);
    if (wasCover) out.add(wasCover);
  }
  // The faces the board is set in. Not on any item and so not in itemHashes(),
  // which makes them exactly the thing the sweep below would throw away: a face
  // dropped in would be gone by the next autosave, and the board would come
  // back after a reload set in a family that no longer resolves.
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
// writeSnapshot() is multi-step - serialise, write assets, write the snapshot,
// sweep - and used to be reachable twice at once: the interval tick, an explicit
// Save, and the pagehide flush all called it directly. Two overlapping runs
// could finish out of order, landing an older snapshot on top of a newer one,
// and an older run's sweep could delete an asset only the newer snapshot still
// referenced. See AUD-02 in research/old/full-code-audit-2026-07-26.md.
//
// One writer fixes both. `saveGen` counts changes worth persisting; a run
// captures the generation it is about to write and, if newer edits landed while
// it wrote, loops once more for the newest. Every caller awaits a run that
// covers the generation current when it asked, and no two runs ever overlap -
// so no stale snapshot and no stale sweep.
let saveGen = 0;         // bumped by every change worth a snapshot
let committedGen = -1;   // saveGen of the last durable write (-1: nothing yet)
let saving: Promise<boolean> | null = null;   // in-flight run, or null
let lastResult = false;  // result of the most recent completed run

/**
 * Persist the working state, coalescing concurrent callers into one writer.
 *
 * Resolves to whether a snapshot covering the caller's generation is durable.
 * A change arriving mid-write is captured by a follow-up write, so the newest
 * board is always what ends up on disk - never a stale snapshot that a slower,
 * older run finished writing last.
 */
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

/**
 * Wait for any in-flight writer to finish. Used by the destructive paths before
 * they clear the store, so a save already past its `cacheOk` gate cannot
 * repopulate IndexedDB after the wipe. Its result is not ours to report.
 */
export async function drainSave() {
  if (saving) { try { await saving; } catch { /* not our result */ } }
}

/**
 * Write the working state to IndexedDB, and take out the rubbish.
 *
 * The sweep at the end is the part this was missing. Autosave only ever
 * inserted, so every board ever opened left its assets behind: open three
 * boards of holiday photos in an afternoon and all three are still on disk,
 * for good. The store grew monotonically until the quota refused a write, at
 * which point autosave switched itself off and the user was told to export -
 * a disk full of boards they had already closed.
 *
 * The order is what makes it safe to delete anything:
 *
 *   1. write the assets the new snapshot will refer to
 *   2. write the snapshot
 *   3. delete assets that no snapshot refers to any more
 *
 * At no point does a stored snapshot point at bytes that are not there. Step 3
 * only removes hashes that were already on disk *before* this save and that
 * the board just written does not mention, so a failure anywhere earlier
 * leaves the previous snapshot and its assets completely intact - the sweep
 * simply does not happen that time round.
 */
async function writeSnapshot() {
  if (!cacheOk) {
    // Which of the two it is. A suspended writer is not a broken browser, and
    // saying it is sends somebody to check their storage settings over a board
    // the app is refusing to write on purpose.
    lastFailure = suspended
      ? 'This address has no board of its own yet - put something on it, or export a file'
      : 'This browser will not store the board (full, or blocked) - export it to a file';
    return false;
  }
  try {
    // Serialised once and reused, so the snapshot and the set of assets kept
    // for it can never describe two different boards.
    const data = serializeBoard();
    const referenced = referencedHashes(data);
    const known = new Set(await idbKeys('assets'));
    const store = allAssets();

    // A hash with no bytes on disk and none in memory is a card this snapshot
    // cannot bring back. Collected rather than skipped: quietly carrying on was
    // how a board with a hole in it became a *successful* save - "Saved in this
    // browser", the board marked clean, and one photograph that would come back
    // as an empty frame on the next visit. The export path has refused this
    // since it was found there; the browser save was still doing it.
    //
    // Collected and written in one transaction rather than awaited one at a
    // time. The first save after a large import is the case: five hundred
    // photographs used to be five hundred sequential transactions, each opened
    // and committed before the next was even issued, and the whole of that wait
    // stood between the user and a board they were told was safe.
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

    // Written even when something is missing, and returned as a failure anyway.
    // The two are not in tension: recovering a board with one broken card beats
    // recovering nothing at all, so the snapshot is worth having - but it is not
    // a board the user has been told is safe, so it goes down with `dirty` set
    // and saveBoard() does not clear that flag. What is refused here is the
    // claim, not the backup.
    await idbSet('kv', SESSION_KEY, {
      board: data,
      created: d!.created(),
      fileName: d!.fileName() || null,
      dirty: isDirty() || missing.length > 0,
      at: Date.now(),
      incomplete: missing.length > 0,
    });

    // A stored key that is not a string cannot be a content hash and so can
    // never be one of the referenced ones - which is the answer it already got,
    // now that the two sets no longer hold the same type of thing.
    await idbDelMany('assets',
      [...known].filter(key => typeof key !== 'string' || !referenced.has(key)));

    if (missing.length) {
      lastFailure = `${describeMissing(data, missing)} - the board cannot be saved complete`;
      // Once per run of trouble, not once per tick - autosave fires on the
      // interval, and a board that has lost an asset would otherwise put a
      // red toast on screen for the rest of the session. saveBoard() says it
      // again regardless, because a press was a question.
      if (!warnedIncomplete) {
        warnedIncomplete = true;
        toast(lastFailure, 'error');
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
    toast(lastFailure, 'error');
    return false;
  }
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
  // Nothing resolved to a name. Only item.asset.hash is matched above, and a
  // missing hash can be a cover, an optimiser original or a font - so the count
  // was right and the sentence was "0 items () have no stored data", which names
  // nothing and asks for nothing. Vaguer and true beats precise and absurd.
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
    // Read one key at a time. This is the app's own snapshot rather than a file
    // somebody handed over, but it comes back out of the store as `unknown` and
    // the two questions asked of it here - is there a board, does it hold items
    // - are exactly the ones `session?.board?.items` was asking.
    const session = await idbGet('kv', SESSION_KEY);
    if (!isRecord(session)) return false;
    const stored = session.board;
    if (!isRecord(stored) || !stored.items) return false;
    // Exactly what the autosave sweep decided was worth keeping, asked the same
    // way - the bin's items included, or restoring one would put an empty frame
    // on the board.
    //
    // The same question, and it used to be asked differently here: `asset.hash`
    // alone, which is one of the three ids an item can hold. So the sweep wrote
    // an album cover to disk and the restore never read it back, and the picture
    // on a music card - or the still on a model, or the face a board is set in -
    // was there until the first reload and gone after it. The bytes were never
    // lost; nothing asked for them.
    const needed = referencedHashes(stored);
    let lost = 0;
    // On a heavy board this is the whole of the wait between opening the tab and
    // seeing anything. Counted, because it is the one wait a person meets before
    // they have done anything at all, and a blank board with no explanation
    // reads as a board that was lost.
    //
    // Read a chunk at a time rather than one asset at a time: a transaction per
    // asset made the wait a few hundred sequential round trips, and reading them
    // all in one would remove the count that keeps the wait explicable. A chunk
    // is both - thirty-odd round trips instead of five hundred, and a progress
    // bar that still moves several times a second.
    const CHUNK = 32;
    const list = [...needed];
    const job = busy('Restoring your board');
    try {
      for (let i = 0; i < list.length; i += CHUNK) {
        job.step(i, list.length);
        const slice = list.slice(i, i + CHUNK);
        const recs = await idbGetMany('assets', slice);
        recs.forEach((rec, k) => {
          // The record this module wrote, read back the way it was written: a
          // Blob and three strings about it. Anything else is a row that cannot
          // rebuild a card, which is what `rec?.blob` was already testing for.
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
    loadBoard(stored);
    // A board that came back without all its bytes is not the board that was
    // put away, and the one thing it must not do is look settled: left clean,
    // the next export would refuse and the user would have had no warning
    // between the two. Dirty and said out loud, so the missing cards are news
    // now rather than at the moment they try to file the thing.
    markDirty(!!session.dirty || lost > 0);
    if (lost) {
      console.warn(`[mbrd] ${lost} asset(s) missing from the working cache`);
      toast(`${lost} item${lost === 1 ? '' : 's'} came back without ${lost === 1 ? 'its' : 'their'} data`, 'error');
    }
    return true;
  } catch (err) {
    console.warn('[mbrd] no session restored:', err);
    return false;
  }
}

/**
 * Wipe the working-cache stores, and let a real failure be seen.
 *
 * It used to swallow every error and return nothing, so "Clear everything"
 * could report success while user data survived the failed wipe (AUD-03). Now
 * it throws on failure - and with the honest idb helper (AUD-01) a throw means
 * the transaction genuinely did not commit. The one caller that must tolerate
 * failure (newBoard) catches it; the one that must not (clearAllData) reports
 * it.
 */
export async function clearSession() {
  await idbClear('kv');
  await idbClear('assets');
}

/**
 * Delete the service worker's caches and drop its registration - the app's own
 * code, not the user's data. Only clearAllData() reaches for this; it is
 * best-effort and never throws, because a wipe that fails to bin re-downloadable
 * scripts still succeeded at the part that mattered. The reload that follows
 * pulls a fresh copy from the network.
 */
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

/**
 * Everything this app has ever put in this browser, gone.
 *
 * Wider than New on purpose. New replaces the board and leaves the person
 * behind it - the palette, the whimsy level, the volume, whether the panel is
 * open - which is right, because starting a new board is not disowning the way
 * you like to work. This is the other request: hand the machine back, or start
 * from nothing after a look you cannot undo your way out of. So it takes the
 * preferences too, and the answer to "what is left?" is "the files you
 * exported", which the dialog says.
 *
 * It goes all the way: past the board and the preferences to the service
 * worker's caches and its registration too - the application's own scripts,
 * fonts and stylesheets. That is not anybody's *data*, and clearing it means an
 * offline device has no app to open until it is next online; but this is the one
 * request wide enough to mean "everything about this site", so it takes that as
 * well. The reload re-fetches and re-registers when there is a network. Best
 * effort, and never blocking the wipe: the app is re-downloadable, the data is
 * the part that had to go.
 *
 * One thing it deliberately does *not* touch: anything on disk. A .mbrd is a
 * file the user owns and put somewhere; no button in a web page is going to go
 * looking for those.
 *
 * The reload is the honest ending. Half a dozen modules hold state that came
 * out of the store - registered faces, custom properties written onto :root by
 * the boot script, the viewport's own position - and reconstructing a
 * first-run app from inside a running one is a list nobody keeps correct.
 * Starting the page again *is* the first run, so it cannot drift.
 */
export async function clearAllData(): Promise<boolean> {
  // The same gate New carries, for the same reason. This dialog asks about "the
  // board kept in this browser" - but on a not-found board that is not the board
  // on screen, it is one the visitor was deliberately never shown. Answering
  // "Delete it all" about a message they arrived at by mistake would take a board
  // they never saw and were never asked about, and "Export first" would offer to
  // save the message instead of the thing at risk.
  if (isNotFoundBoard()) {
    toast('This address has no board to clear - go to your board first');
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
  // Exporting can fail or be cancelled at the picker, and somebody who asked to
  // keep the board and did not keep it has not answered the question yet.
  if (answer === 'keep') return (await d!.exportBoard()) ? clearAllData() : false;

  // Before the wipe, not after: a snapshot landing between the clear and the
  // reload would put the board straight back. Dropping the latch stops a *new*
  // save - the interval tick gates on cacheOk - and draining the writer stops
  // one already past the latch (flushEdits() on the way out of the page calls
  // autosave() directly) from repopulating the store.
  cacheOk = false;
  await drainSave();
  // Surface a failed wipe instead of reloading over it. A reload that claimed
  // success while data remained is the exact privacy failure in AUD-03: the
  // person asked for everything gone and would have been told it was.
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
  // The app's own code goes too - this is the "everything about the site" wipe.
  // After the session, because it is re-downloadable and its failure must not
  // sink a wipe of the data that was the point.
  await clearAppCaches();
  location.reload();
  return true;
}

// ---------------------------------------------------------------------------
// Wiring
// ---------------------------------------------------------------------------

export function initSessionStorage() {
  // 'trash' belongs here with the rest. Emptying the bin emits nothing else,
  // and markDirty() is idempotent - so on an already-dirty board, purging the
  // bin would bump no change generation at all and a reload brought every
  // purged item back.
  // 'view' is emitted by main.js once a pan or zoom has settled. It does not
  // mark the board dirty - looking around is not editing - but it does have to
  // be snapshotted, or closing the tab after moving about restores the view the
  // board had before, which is not where it was left.
  // `as const` so each name stays the literal the bus knows rather than widening
  // to string: the event list is closed (see board-store.ts) and a typo in this
  // array should be a red run rather than a subscription to nothing.
  for (const evt of ['items', 'geom', 'item', 'settings', 'board', 'trash', 'view'] as const) {
    bus.on(evt, noteChange);
  }
  setInterval(requestAutosave, AUTOSAVE_MS);
  // Don't wait out the interval for a committed action - a card placed, moved or
  // removed should land on disk promptly. 'history' fires once per commit (and
  // on undo/redo), after its mutation event has already bumped the generation,
  // and never during a live drag - applyGeom() repaints without committing - so
  // this is one request per finished gesture, not one per frame. requestAutosave
  // holds it to the 5s cooldown, so a fast run of edits still writes just once.
  bus.on('history', requestAutosave);
  // A board replacing the one that was here is not an edit to it - see the note
  // on `quiet` above. Both doors: opened from a file, and started from nothing.
  bus.on('board:load', hushNextSave);
  bus.on('board:new', hushNextSave);
  // No "Leave site?" guard on close. The 20s autosave and the pagehide flush
  // (main.js) have already put the board in IndexedDB, and restoreSession()
  // brings it straight back on the next visit, so the prompt guarded nothing and
  // cost a click on every reload.
}

// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// What the file half reaches for
// ---------------------------------------------------------------------------

/** Why the last write into this browser failed, or '' if it did not. */
export const lastSaveFailure = () => lastFailure;

/**
 * Is the user's work safe? Asked by the global error handler (errors.ts) at the
 * moment it has to tell somebody something, and by nobody else.
 *
 * Synchronous, and it never starts a write. The app is already in trouble when
 * this is called - kicking off a save from inside an error handler would be
 * asking the broken thing to prove itself, and the answer would arrive after
 * the message that needed it.
 *
 * The ladder falls towards 'unknown' rather than towards reassurance, because
 * the one unrecoverable mistake here is telling somebody their board is kept
 * when it is not. Every latch this reads is above; nothing about it is new
 * state.
 *
 * The dirty flag is load-bearing in the middle of it. `saveGen` counts *changes
 * worth a snapshot*, and panning is one of those - a board reopens where it was
 * left, so 'view' bumps the generation - while it is emphatically not an edit.
 * A clean board with a pending generation therefore has nothing of the person's
 * waiting to be written, only where they were looking, and calling that
 * "unsaved changes" would send somebody to export a file over a scroll.
 */
export function boardSafety(): BoardSafety {
  // Not a broken browser: a not-found address, which the app is deliberately
  // not writing. There is no work of theirs here to be at risk, and saying
  // "unsaved" would send them looking for a board they never had.
  if (suspended) {
    return { state: 'unknown', detail: 'this address has no board of its own, so nothing here was being saved' };
  }
  if (!cacheOk) {
    return { state: 'unsaved', detail: 'your board is not being kept in this browser, export it to a file' };
  }
  // Every change is covered by a write that succeeded.
  if (committedGen >= saveGen && lastResult) return { state: 'saved' };
  // Nothing the person did is waiting, whatever the generation says.
  if (!isDirty()) return { state: 'saved' };
  // A writer already running may well land this, but it has not landed yet and
  // the app is mid-failure. Neither answer is knowable, so neither is given.
  if (saving) return { state: 'unknown', detail: 'a save was still running, so the last few changes may not have landed' };
  return { state: 'unsaved' };
}

/**
 * Stop accepting writes, so a closing board's autosave cannot repopulate the
 * store after it has been cleared. Paired with drainSave() - see AUD-03.
 */
export function suspendCache() {
  cacheOk = false;
  suspended = true;
}

/**
 * A fresh start is a fresh start.
 *
 * The latches are set by a failure that belonged to the board just closed - a
 * quota error raised by its photographs, or an asset it had lost - and by this
 * point the data that caused the first one is gone. Left set, they turned one
 * full disk into a session where nothing could be saved again until the page was
 * reloaded, on a board that is now empty.
 *
 * `suspended` goes with them: this is the other end of suspendCache(), and the
 * writer coming back on is exactly the moment the board stops being one the app
 * is deliberately not writing.
 */
export function resetSessionLatches() {
  cacheOk = true;
  suspended = false;
  warnedIncomplete = false;
  lastFailure = '';
}
