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
// side also runs on a timer every 20s (and flushes on the way out of the page),
// so an unsaved board survives a closed tab regardless.
//
// This file is now the *file* half - the picker, Save, Export, Open and New.
// The browser's own copy went to session.js when 949 lines carrying three
// failure models became hard to read as one, and the split had to answer a
// question rather than move lines: **who owns the file handle.** The answer is
// this module. A handle is about the document somebody chose on disk; a session
// is about the copy this browser is keeping for them - so session.js is handed
// the handle, the created-stamp, Export and the discard prompt through
// initSession() at the foot of this file, and never imports back.
//
// Every caller still asks here. The façade at the foot re-exports what moved,
// which is what kept the split from reaching main.js, ui/board-actions.js,
// commands.js and four tests.

import { toast, busy } from '../util.js';
import {
  board, serializeBoard, loadBoard, markDirty, isDirty, setTitle, bus,
  defaultBoardTitle, isNotFoundBoard,
} from '../state.js';
import { packBoard, unpackBoard, MIME } from './mbrd.js';
import { allAssets, clearAssets } from './assets.js';
import { fileNameFor, titleFromFileName, titleForOpenedBoard } from './naming.js';
// The browser's own copy of the board. It is handed what it needs from this
// half through initSession() below rather than importing it back - see the
// header of session.js for why the file handle stays on this side.
import {
  initSession, autosave, drainSave, clearSession,
  initSessionStorage, lastSaveFailure, suspendCache,
  resetSessionLatches,
} from './session.js';
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
  const ok = await autosave();
  if (!ok) {
    // Always an answer, and this is the fix. autosave() deliberately says a
    // thing like this only once per run of trouble - it fires after every edit
    // and would otherwise hold a red toast on screen for the session - and
    // once cacheOk has gone false it returns before it can say anything at
    // all. Both are right for a background save and both are wrong here:
    // pressing Save is a question, and the answer to a question is never
    // silence, nor "we mentioned it earlier".
    toast(lastSaveFailure() || 'Could not save in this browser', 'error');
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
        // Piped rather than handed over whole. The archive packBoard returns is
        // a composition of the assets' own Blobs (see writeZip), so it is a
        // description of a file rather than a file in memory - and pipeTo pulls
        // it a chunk at a time, which is the only way that stays true all the
        // way to the disk. pipeTo closes the destination on its own.
        await blob.stream().pipeTo(writable);
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

/** Whether the engine can hand a packed board to a native share sheet. */
export const canShareBoard = () =>
  typeof navigator !== 'undefined' && typeof navigator.canShare === 'function';

/**
 * Hand the packed .mbrd to the operating system's share sheet.
 *
 * The mobile answer to Export. On a phone there is no folder to file a download
 * into that another app can then reach; the share sheet is how a file gets to
 * Messages, mail, AirDrop or another board. So this packs the very same archive
 * Export writes - through the same serializeBoard()/packBoard() pipeline, so a
 * shared board and an exported one are byte-for-byte the same file - and offers
 * it to navigator.share() instead of writing it to disk.
 *
 * Falls through to exportBoard() wherever sharing a file is not on offer, so the
 * button never dead-ends: a desktop that has canShare but refuses files, or a
 * browser without the API at all, still gets the download it would have got.
 * A dismissed sheet is an AbortError, swallowed like the picker's - the board is
 * untouched either way, because nothing here changes state.
 */
export async function shareBoard() {
  try {
    const data = serializeBoard();
    const { blob, manifest } = await packBoard(data, { created });
    created = manifest.created;
    const file = new File([blob], fileNameFor(board.title), { type: MIME });
    // canShare({files}) is the honest probe: a browser can have navigator.share
    // for text and still refuse files, and share() would then throw. Where files
    // are not shareable, the export path is the right fallback, not an error.
    if (navigator.canShare?.({ files: [file] })) {
      await navigator.share({ files: [file], title: board.title });
      return true;
    }
    return exportBoard();
  } catch (err) {
    if (err?.name === 'AbortError') return false;   // user dismissed the sheet
    console.error(err);
    toast('Share failed: ' + err.message, 'error');
    return false;
  }
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
        // manifest.app decides whether the stored title needs its underscores
        // decoding - see titleForOpenedBoard(). The field was documented as
        // informational; this is the one thing that reads it.
        loadBoard({ ...data, title: titleForOpenedBoard(data.title, file.name, manifest.app) });
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
    // Say whose picker this is rather than saying nothing. import/drop.js
    // listens on the same input and stands down on a mode it does not own - it
    // used to stand down on the *absence* of one, which is the same thing only
    // while every other opener remembers to clear it. Naming the owner makes
    // that guard positive at both ends.
    input.dataset.mode = 'mbrd';

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
      delete input.dataset.mode;
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
  // A not-found board is not the visitor's board. It was never loaded from the
  // session slot, so clearing that slot below would delete a board they cannot
  // see and have not been asked about - confirmDiscard() would ask about the
  // blank message on screen, which has nothing to lose - and resetSessionLatches()
  // would then let the blank replacement autosave over it. Refused rather than
  // routed through leaveNotFound(): restoring their board only to discard it a
  // line later is tidier to read and worse to be on the end of, and it would
  // announce "Moved to your board" on the way past.
  if (isNotFoundBoard()) {
    toast('This address has no board to start over - put something on it first');
    return false;
  }
  if (!(await confirmDiscard('Starting a new one'))) return false;
  // Stop the closing board's autosave from repopulating the store after it is
  // cleared: drop the latch and drain any in-flight writer before touching the
  // asset store or the session. See AUD-03.
  suspendCache();
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
  loadBoard({ title: defaultBoardTitle() });
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
  resetSessionLatches();
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
// The façade
// ---------------------------------------------------------------------------

// Save, Export and Open live here; the browser's own copy lives in session.js.
// Every caller still asks this module, which is what kept the split from
// reaching main.js, ui/board-actions.js, commands.js and four tests. Written out
// rather than as a star re-export for the reason state.js is: a name that goes
// missing should break loudly at the import, not quietly at runtime.
export {
  autosave, restoreSession, clearAllData, clearSession,
  // Out to main.js as well as used in here, and as a pair: a boot into
  // not-found opens a blank board that must never be written over the one the
  // visitor already has, so the writer is stopped before anything can fire.
  // resetSessionLatches is how it comes back on, once the board underneath is
  // the real one - see leaveNotFound() in main.js.
  suspendCache, resetSessionLatches,
} from './session.js';
export { fileNameFor, titleFromFileName, titleForOpenedBoard } from './naming.js';

/**
 * Bring persistence up: hand the session engine the four things it borrows from
 * this half, then start it.
 *
 * The handle and the created-stamp go through as getters because both are
 * reassigned here - opening a file replaces them - and a captured value would
 * go stale the first time somebody opened a board.
 */
export function initStorage() {
  initSession({
    fileName: () => fileHandle?.name || null,
    created: () => created,
    setCreated: at => { created = at; },
    exportBoard,
    prompt: opts => prompt(opts),
  });
  initSessionStorage();
}
