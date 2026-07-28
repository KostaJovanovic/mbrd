// Board persistence, in two halves that answer two different questions.
//
//   Save   - "keep this". Writes the board into this browser, where it already
//            autosaves to, and where it is picked up again on the next visit.
//            No dialog, no file, no folder to choose: the common case is
//            wanting the work kept, not wanting a document filed.
//   Export - "give me the file". Packs a .mbrd and writes it out, through the
//            File System Access API where there is one and a download where
//            there is not. That is the copy you email, archive, or move to
//            another machine.
//
// The split matters because the two have different failure modes. A browser
// store can be cleared by the browser itself; a file cannot, but only exists
// if you remembered to ask for one. So Save is the cheap frequent one and
// Export is the deliberate one, and the interface says which is which.
//
// Underneath, both serialise the same board through mbrd.js. The IndexedDB
// side also runs on a debounce after every edit, so an unsaved board survives
// a closed tab regardless.

import { toast, busy, isDev, itemHashes, clearPrefs } from '../util.js';
import {
  board, serializeBoard, loadBoard, markDirty, isDirty, setTitle, bus, cleanBoardTitle,
} from '../state.js';
import { packBoard, unpackBoard, MIME } from './mbrd.js';
import { allAssets, putAsset, clearAssets } from './assets.js';
import { idbGet, idbSet, idbDel, idbClear, idbKeys } from './idb.js';
// The confirmation dialogs below - discard-unsaved and clear-everything - are
// the one thing this module needs from the interface, and ui/ sits *above*
// storage in the layering (AUD-12). So the prompt is injected rather than
// imported: main.js wires setPrompt() to ui/dialog's ask() at startup. Left
// unset - in a test, or before wiring - it answers 'cancel', which is the safe
// default here: nothing is discarded and nothing is wiped without a real answer.
let prompt = async () => 'cancel';
export function setPrompt(fn) {
  prompt = typeof fn === 'function' ? fn : async () => 'cancel';
}

const PICKER_TYPES = [{
  description: 'mbrd board',
  accept: { [MIME]: ['.mbrd'] },
}];

/** Handle of the file Export writes back to, when the browser supports it. */
let fileHandle = null;
/** First-created timestamp, carried across saves of the same board. */
let created = null;

export const canPickFiles = () => typeof window.showSaveFilePicker === 'function';
export const currentFileName = () => fileHandle?.name || null;

// ---------------------------------------------------------------------------
// Save
// ---------------------------------------------------------------------------

/**
 * Ask the engine to keep this origin's storage durable, once.
 *
 * WebKit stores an origin in best-effort mode by default and may evict it under
 * overall quota pressure, device storage pressure, or inactivity - so a board a
 * person was told was "saved in this browser" can later be gone with no
 * application-level delete (Safari audit S1). navigator.storage.persist() asks
 * the engine to exempt this origin from that eviction; WebKit grants it on
 * heuristics such as installed-web-app use.
 *
 * Asked on the first explicit Save rather than at boot, so the request is tied
 * to a real intent to keep something. Its answer only ever changes what the
 * receipt claims - never whether the save counts as a success - because the
 * durable copy is, and remains, the exported .mbrd file.
 */
let persistent = null;   // null: not asked yet; true/false: the engine's answer

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

/**
 * Keep the board in this browser. Nothing leaves the machine and no file is
 * written - this is the same IndexedDB store the autosave uses, flushed now
 * rather than in a second and a bit, and the board marked clean.
 */
export async function saveBoard() {
  clearTimeout(saveTimer);
  const ok = await autosave();
  if (!ok) {
    // Always an answer, and this is the fix. autosave() deliberately says a
    // thing like this only once per run of trouble - it fires after every edit
    // and would otherwise hold a red toast on screen for the session - and
    // once cacheOk has gone false it returns before it can say anything at
    // all. Both are right for a background save and both are wrong here:
    // pressing Save is a question, and the answer to a question is never
    // silence, nor "we mentioned it earlier".
    toast(lastFailure || 'Could not save in this browser', 'error');
    return false;
  }
  markDirty(false);
  // The receipt tells the truth about how safe "saved" is. Where the engine
  // granted persistence the browser copy will not be evicted from under the
  // user; where it did not - the common case on default Safari - saying so
  // plainly keeps the export as the copy they can actually rely on.
  const durable = await ensurePersistence();
  toast(durable
    ? 'Saved in this browser'
    : 'Saved in this browser — export a file to keep a durable copy');
  return true;
}

/**
 * Why the last autosave failed, kept for the explicit Save that has to report
 * it. Cleared on success, so it can never explain a failure that has since
 * been fixed.
 */
let lastFailure = '';

/**
 * Write the board out as a .mbrd.
 *
 * With a file picker, the handle is remembered, so exporting the same board a
 * second time overwrites the file you chose instead of asking again - pass
 * `pickNew` for a Save-as. Without one, every export is a download.
 */
export async function exportBoard({ pickNew = false } = {}) {
  const picking = canPickFiles();
  try {
    // The picker runs *before* anything is serialised, and that ordering is the
    // whole of the fix here.
    //
    // The board's title is part of what gets packed - it goes into
    // manifest.json and into board.json - and choosing a filename renames the
    // board to match it. Packing first meant the file was built around the old
    // title and only then renamed, so the very first export of an untitled
    // board wrote "Untitled board" *inside* a file called example.mbrd. Open
    // that file on another machine and it comes back untitled, because
    // board.json outranks the filename.
    //
    // Nothing is written and no state moves until the picker returns, so
    // cancelling still leaves the board exactly as it was: the AbortError
    // below is thrown from here, ahead of everything.
    if (picking && (pickNew || !fileHandle)) {
      fileHandle = await window.showSaveFilePicker({
        suggestedName: fileNameFor(board.title),
        types: PICKER_TYPES,
      });
    }
    if (picking) setTitle(titleFromFileName(fileHandle.name));

    // Everything past the picker is the slow half - deflating every asset on
    // the board into one archive - and on a board of video it is a long slow
    // half with no other sign of life. The strip goes up after the picker on
    // purpose: while that dialog is open the app is waiting on a person, not
    // on itself, and saying "working" over a file browser would be a lie.
    const job = busy('Packing the board');
    try {
      const data = serializeBoard();
      const { blob, manifest } = await packBoard(data, { created });
      created = manifest.created;

      if (picking) {
        job.label('Writing the file');
        const writable = await fileHandle.createWritable();
        await writable.write(blob);
        await writable.close();
      } else {
        download(blob, fileNameFor(data.title));
      }
    } finally {
      job.end();
    }

    // Exporting is also a save: the bytes are on disk now, and telling someone
    // their board has unsaved changes right after they wrote it to a file
    // would be a lie.
    markDirty(false);
    toast('Exported ' + fileNameFor(board.title));
    return true;
  } catch (err) {
    if (err?.name === 'AbortError') return false;   // user closed the picker
    console.error(err);
    toast('Export failed: ' + err.message, 'error');
    return false;
  }
}

function download(blob, name) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  a.click();
  // Revoke late: Safari needs the URL to survive the click turn.
  setTimeout(() => URL.revokeObjectURL(url), 20000);
}

// ---------------------------------------------------------------------------
// Open
// ---------------------------------------------------------------------------

/**
 * Choose a .mbrd and open it.
 *
 * The picker runs before anything is asked, which is the other way round from
 * how this read. Confirming first meant being asked to throw away an hour's
 * work and *then* being shown a file dialog you might well cancel - a question
 * about a thing that had not been requested yet. Nothing here replaces the
 * board until a file is actually in hand, so the question waits until there is
 * one, and openFile() is where it gets asked.
 */
export async function openBoard() {
  try {
    let file = null;
    let handle = null;
    if (typeof window.showOpenFilePicker === 'function') {
      [handle] = await window.showOpenFilePicker({ types: PICKER_TYPES, multiple: false });
      file = await handle.getFile();
    } else {
      file = await pickViaInput();
    }
    return file ? await openFile(file, handle) : false;
  } catch (err) {
    if (err?.name === 'AbortError') return false;
    console.error(err);
    toast('Open failed: ' + err.message, 'error');
    return false;
  }
}

/**
 * Open a .mbrd File. The one door onto "replace the board with this", and so
 * the one place the unsaved-work question belongs.
 *
 * It used to live in openBoard() alone, which covered the Open button and
 * nothing else: a .mbrd dropped on the canvas (import/drop.js) and one handed
 * over by the OS through the PWA's file handler (main.js, launchQueue) both
 * came straight in here and replaced an edited board without a word. Three
 * doors, one of them guarded. Now the guard is on the room.
 *
 * A clean board is never interrupted - confirmDiscard() only asks when there
 * is something to lose - so the common case of opening a board you have just
 * saved still costs nothing.
 *
 * Asked *before* unpacking, deliberately, even though that means a corrupt
 * file can prompt and then fail. withFreshAssets() sets the current board's
 * assets aside and registers the new file's in their place; answering "keep my
 * work" after that had run would leave the old board on screen with the new
 * board's bytes behind it.
 */
export async function openFile(file, handle = null) {
  if (!(await confirmDiscard('Opening another board'))) return false;
  try {
    // Unpack *and* load inside the transaction. Loading used to sit outside
    // it, on the reading that unpacking was the risky half - but the board is
    // only actually replaced by loadBoard(), and a file can be a perfectly
    // valid ZIP carrying a board.json that is not a board. Committing the
    // assets first meant that failure landed between the two: the old board's
    // object URLs revoked, the new file's bytes registered, and the old items
    // still on screen pointing at nothing. Now nothing is committed until the
    // board itself is in.
    const job = busy('Opening ' + file.name);
    try {
      return await withFreshAssets(async () => {
        const { manifest, board: data } = await unpackBoard(file);
        loadBoard({ ...data, title: titleForOpenedBoard(data.title, file.name) });
        fileHandle = handle;
        created = manifest.created || null;
        toast('Opened ' + file.name);
        return true;
      });
    } finally {
      job.end();
    }
  } catch (err) {
    console.error(err);
    toast('Could not open that file: ' + err.message, 'error');
    return false;
  }
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
async function withFreshAssets(commit) {
  const store = allAssets();
  const stash = new Map(store);
  store.clear();
  try {
    const result = await commit();
    for (const a of stash.values()) if (a.url) URL.revokeObjectURL(a.url);
    return result;
  } catch (err) {
    store.clear();
    for (const [k, v] of stash) store.set(k, v);
    throw err;
  }
}

/**
 * The fallback file chooser, for browsers with no File System Access API.
 *
 * Cancellation is the awkward part. A native file dialog that is dismissed
 * fires no `change`, so this promise used to simply never settle - and because
 * the hidden <input> is shared with Add files, it was also left holding
 * `.mbrd` and `multiple = false` for whatever came next. Modern engines fire
 * `cancel` for exactly this; the focus fallback covers the ones that do not, so
 * every exit restores the input and resolves.
 */
function pickViaInput() {
  return new Promise(resolve => {
    const input = document.getElementById('file-input');
    const prevAccept = input.accept;
    input.accept = '.mbrd,application/zip';
    input.multiple = false;

    let settled = false;
    const finish = file => {
      if (settled) return;
      settled = true;
      input.removeEventListener('change', onChange);
      input.removeEventListener('cancel', onCancel);
      removeEventListener('focus', onFocus);
      input.accept = prevAccept;
      input.multiple = true;
      input.value = '';
      resolve(file);
    };
    const onChange = () => finish(input.files[0] || null);
    const onCancel = () => finish(null);
    // Focus returns to the window the moment the dialog closes either way, so
    // this has to give `change` a turn to land before deciding it was a
    // cancellation. Harmless where `cancel` already fired: finish() is once.
    const onFocus = () => setTimeout(() => finish(input.files[0] || null), 300);

    input.addEventListener('change', onChange);
    input.addEventListener('cancel', onCancel);
    addEventListener('focus', onFocus, { once: true });
    input.click();
  });
}

// ---------------------------------------------------------------------------
// New
// ---------------------------------------------------------------------------

export async function newBoard() {
  if (!(await confirmDiscard('Starting a new one'))) return false;
  // Stop the closing board's autosave from repopulating the store after it is
  // cleared: drop the latch and drain any in-flight writer before touching the
  // asset store or the session. See AUD-03.
  clearTimeout(saveTimer);
  cacheOk = false;
  await drainSave();
  clearAssets();
  fileHandle = null;
  created = null;
  // Announced rather than acted on, because the look lives in ui/appearance.js
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
  loadBoard({ title: 'Untitled board' });
  // A failure here is self-healing: the session is one slot and the new board's
  // first autosave overwrites whatever stale bytes remain, so warn but do not
  // block starting fresh. clearAllData() is the path that must not paper over a
  // failed wipe; New is not.
  try { await clearSession(); }
  catch (err) { console.warn('[mbrd] could not clear the old session:', err); }
  // A fresh start is a fresh start. Both latches below are set by a failure
  // that belonged to the board just closed - a quota error raised by its
  // photographs, or an asset it had lost - and clearSession() has just deleted
  // the very data that caused the first one. Left set, they turned one full
  // disk into a session where nothing could be saved again until the page was
  // reloaded, on a board that is now empty.
  cacheOk = true;
  warnedIncomplete = false;
  lastFailure = '';
  return true;
}

/**
 * Stop and ask, when there is something to lose.
 *
 * Three answers rather than two, and the third is the point. Save keeps a board
 * in *this browser* and there is exactly one slot - newBoard() calls
 * clearSession() a few lines later, which wipes it - so "save it first" is not
 * an option that exists here. Writing a file is. A dialog that announces
 * unsaved changes and then offers no way to keep them is the one people
 * complain about, and Export is the honest version of that offer.
 *
 * Looped, because exporting can fail or be cancelled at the picker. Coming back
 * to the question is right: somebody who asked to keep the board and did not
 * keep it has not answered yet.
 */
async function confirmDiscard(what) {
  if (!isDirty()) return true;
  for (;;) {
    const answer = await prompt({
      title: 'Unsaved changes',
      body: `This board has changes that are not in a file. ${what} will discard them.`,
      keep: 'Export first',
      cancel: 'Cancel',
      go: 'Discard',
    });
    if (answer === 'cancel') return false;
    if (answer === 'go') return true;
    // exportBoard() clears the dirty flag when it writes, so a success here is
    // the same state as never having been dirty.
    if (await exportBoard()) return true;
  }
}

// ---------------------------------------------------------------------------
// IndexedDB working cache
// ---------------------------------------------------------------------------

const SESSION_KEY = 'session';
let saveTimer = 0;
let cacheOk = true;
/** Whether the "some bytes are missing" toast has already been shown. */
let warnedIncomplete = false;

/**
 * Debounced snapshot of the board + any assets not already cached.
 *
 * Announces itself on the way out, and only when the save answered something
 * the user did. Two gates, because there are two ways to save nothing worth
 * mentioning:
 *
 * `isDirty` catches the clean board - panning about emits 'view', which is
 * snapshotted so the board reopens where you left it, and is not an edit.
 *
 * `quiet` catches the load. A board arriving emits 'board:load', which arms
 * this like anything else - and a session restored from IndexedDB comes back
 * carrying the dirty flag it went down with, so the first gate lets it through
 * and every visit would open by announcing a save of a board nobody had
 * touched. One suppressed snapshot per board is the whole of it.
 *
 * Nothing is said about a failure here. autosave() already toasts the two ways
 * it can go wrong, and both are loud - a quiet mark in the corner going quietly
 * absent is not how you tell someone their board is not being kept.
 */
let quiet = true;
const hushNextSave = () => { quiet = true; };

function scheduleAutosave() {
  // Count the change before the latch check: even while caching is off the
  // generation must advance, so a later save knows this edit is not yet on disk.
  saveGen++;
  if (!cacheOk) return;
  clearTimeout(saveTimer);
  saveTimer = setTimeout(async () => {
    // Read before the write: a save that finds nothing missing leaves the flag
    // exactly as it was, so there would be nothing left to read afterwards.
    const had = isDirty();
    const announce = had && !quiet;
    quiet = false;
    const ok = await autosave().catch(() => false);
    if (ok && announce) bus.emit('autosaved');
  }, 1200);
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
function referencedHashes(data) {
  const out = new Set();
  const add = it => { for (const h of itemHashes(it)) out.add(h); };
  for (const it of data.items || []) add(it);
  for (const t of data.trash || []) add(t?.item);
  // The files the optimiser replaced. Not in itemHashes() on purpose - that one
  // drives the *packer*, and an export is the artifact the optimising was for,
  // so it carries the small copies alone. Here they are held, because this drives
  // the sweep and the sweep would otherwise delete the very bytes the undo entry
  // exists to put back. See swapAssets() and discardOriginals() in state.js.
  for (const it of data.items || []) {
    if (it?.meta?.was) out.add(it.meta.was);
    if (it?.meta?.wasCover) out.add(it.meta.wasCover);
  }
  // The faces the board is set in. Not on any item and so not in itemHashes(),
  // which makes them exactly the thing the sweep below would throw away: a face
  // dropped in would be gone by the next autosave, and the board would come
  // back after a reload set in a family that no longer resolves.
  for (const f of data.settings?.fonts || []) if (f?.hash) out.add(f.hash);
  return out;
}

// ---------------------------------------------------------------------------
// Save coordinator (single-flight)
// ---------------------------------------------------------------------------
//
// writeSnapshot() is multi-step - serialise, write assets, write the snapshot,
// sweep - and used to be reachable twice at once: the debounce, an explicit
// Save, and the pagehide flush all called it directly. Two overlapping runs
// could finish out of order, landing an older snapshot on top of a newer one,
// and an older run's sweep could delete an asset only the newer snapshot still
// referenced. See AUD-02 in research/full-code-audit-2026-07-26.md.
//
// One writer fixes both. `saveGen` counts changes worth persisting; a run
// captures the generation it is about to write and, if newer edits landed while
// it wrote, loops once more for the newest. Every caller awaits a run that
// covers the generation current when it asked, and no two runs ever overlap -
// so no stale snapshot and no stale sweep.
let saveGen = 0;         // bumped by every change worth a snapshot
let committedGen = -1;   // saveGen of the last durable write (-1: nothing yet)
let saving = null;       // in-flight run, a Promise<boolean>, or null
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
async function drainSave() {
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
    lastFailure = 'This browser will not store the board (full, or blocked) - export it to a file';
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
    const missing = [];
    for (const hash of referenced) {
      if (known.has(hash)) continue;
      const asset = store.get(hash);
      if (!asset) { missing.push(hash); continue; }
      await idbSet('assets', hash, {
        blob: asset.blob, ext: asset.ext, mime: asset.mime, name: asset.name,
      });
    }

    // Written even when something is missing, and returned as a failure anyway.
    // The two are not in tension: recovering a board with one broken card beats
    // recovering nothing at all, so the snapshot is worth having - but it is not
    // a board the user has been told is safe, so it goes down with `dirty` set
    // and saveBoard() does not clear that flag. What is refused here is the
    // claim, not the backup.
    await idbSet('kv', SESSION_KEY, {
      board: data,
      created,
      fileName: fileHandle?.name || null,
      dirty: isDirty() || missing.length > 0,
      at: Date.now(),
      incomplete: missing.length > 0,
    });

    for (const hash of known) {
      if (!referenced.has(hash)) await idbDel('assets', hash);
    }

    if (missing.length) {
      lastFailure = `${describeMissing(data, missing)} - the board cannot be saved complete`;
      // Once per run of trouble, not once per debounce - autosave fires after
      // every edit, and a board that has lost an asset would otherwise put a
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
function describeMissing(data, hashes) {
  const wanted = new Set(hashes);
  const names = [];
  for (const item of [...(data.items || []), ...(data.trash || []).map(t => t?.item)]) {
    const hash = item?.asset?.hash;
    if (!hash || !wanted.has(hash)) continue;
    wanted.delete(hash);
    names.push(item.name || item.type || 'item');
  }
  const shown = names.slice(0, 3).join(', ');
  const rest = names.length > 3 ? ` and ${names.length - 3} more` : '';
  return `${names.length} item${names.length === 1 ? '' : 's'} ` +
    `(${shown}${rest}) ${names.length === 1 ? 'has' : 'have'} no stored data`;
}

/** Restore the last working state. Returns true when a board was recovered. */
export async function restoreSession() {
  try {
    const session = await idbGet('kv', SESSION_KEY);
    if (!session?.board?.items) return false;
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
    const needed = referencedHashes(session.board);
    let lost = 0;
    // One read per asset, and on a heavy board that is the whole of the wait
    // between opening the tab and seeing anything. Counted, because it is the
    // one wait a person meets before they have done anything at all, and a
    // blank board with no explanation reads as a board that was lost.
    const job = busy('Restoring your board');
    let n = 0;
    try {
      for (const hash of needed) {
        job.step(n++, needed.length);
        const rec = await idbGet('assets', hash);
        if (rec?.blob) putAsset(hash, rec.blob, { ext: rec.ext, mime: rec.mime, name: rec.name });
        else lost++;
      }
    } finally {
      job.end();
    }
    created = session.created || null;
    loadBoard(session.board);
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
 * Two things it deliberately does *not* touch.
 *
 * The service worker's caches. Those hold the application - the scripts, the
 * fonts, the stylesheets - and none of it is anybody's data. Deleting them
 * would leave a phone in a field with no app to open, which is the one thing
 * this project is built not to do.
 *
 * Anything on disk. A .mbrd is a file the user owns and put somewhere; no
 * button in a web page is going to go looking for those.
 *
 * The reload is the honest ending. Half a dozen modules hold state that came
 * out of the store - registered faces, custom properties written onto :root by
 * the boot script, the viewport's own position - and reconstructing a
 * first-run app from inside a running one is a list nobody keeps correct.
 * Starting the page again *is* the first run, so it cannot drift.
 */
export async function clearAllData() {
  const answer = await prompt({
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
  if (answer === 'keep') return (await exportBoard()) ? clearAllData() : false;

  // Before the wipe, not after: the debounce is armed by every edit, and a
  // snapshot landing between the clear and the reload would put the board
  // straight back. Dropping the latch stops a *new* save; draining the writer
  // stops one already past the latch (flushEdits() on the way out of the page
  // calls autosave() directly, past any timer) from repopulating the store.
  clearTimeout(saveTimer);
  cacheOk = false;
  await drainSave();
  // Surface a failed wipe instead of reloading over it. A reload that claimed
  // success while data remained is the exact privacy failure in AUD-03: the
  // person asked for everything gone and would have been told it was.
  try {
    await clearSession();
  } catch (err) {
    console.error('[mbrd] clear everything failed:', err);
    toast('Could not clear this browser’s storage: ' + (err?.message || err), 'error');
    cacheOk = true;
    return false;
  }
  clearPrefs();
  location.reload();
  return true;
}

// ---------------------------------------------------------------------------
// Wiring
// ---------------------------------------------------------------------------

export function initStorage() {
  // 'trash' belongs here with the rest. Emptying the bin emits nothing else,
  // and markDirty() is idempotent - so on an already-dirty board whose debounce
  // had fired, purging the bin scheduled no snapshot at all and a reload
  // brought every purged item back.
  // 'view' is emitted by main.js once a pan or zoom has settled. It does not
  // mark the board dirty - looking around is not editing - but it does have to
  // be snapshotted, or closing the tab after moving about restores the view the
  // board had before, which is not where it was left.
  for (const evt of ['items', 'geom', 'item', 'settings', 'board', 'trash', 'view']) {
    bus.on(evt, scheduleAutosave);
  }
  // A board replacing the one that was here is not an edit to it - see the note
  // on `quiet` above. Both doors: opened from a file, and started from nothing.
  bus.on('board:load', hushNextSave);
  bus.on('board:new', hushNextSave);
  // "Leave site?" on every refresh is worse than useless while developing: the
  // autosave below has already put the board in IndexedDB, and restoreSession()
  // brings it straight back, so the prompt guards nothing and costs a click on
  // every edit-reload cycle. Off on the dev server, kept everywhere else, where
  // a closed tab really can be the end of an unsaved board.
  if (isDev()) return;
  addEventListener('beforeunload', e => {
    if (!isDirty()) return;
    e.preventDefault();
    e.returnValue = '';
  });
}

// ---------------------------------------------------------------------------

export function fileNameFor(title) {
  const base = cleanBoardTitle(title) || 'board';
  return base.replace(/\.mbrd$/i, '').replace(/ /g, '_') + '.mbrd';
}

export function titleFromFileName(name) {
  return stripExt(name).replace(/_/g, ' ');
}

export function titleForOpenedBoard(storedTitle, fileName) {
  const title = typeof storedTitle === 'string' && storedTitle
    ? storedTitle
    : titleFromFileName(fileName);
  // Older exports could pack the picker-safe filename back into board.json.
  // Decode that title as well as the fallback filename when the file is opened.
  return title.replace(/_/g, ' ');
}

function stripExt(name) {
  return name.replace(/\.mbrd$/i, '');
}
