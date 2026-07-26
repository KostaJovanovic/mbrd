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

import { toast, isDev, itemHashes } from '../util.js';
import {
  board, serializeBoard, loadBoard, markDirty, isDirty, setTitle, bus,
} from '../state.js';
import { packBoard, unpackBoard, MIME } from './mbrd.js';
import { allAssets, putAsset, clearAssets } from './assets.js';
import { idbGet, idbSet, idbDel, idbClear, idbKeys } from './idb.js';
// The only thing this module borrows from ui/, and on the same terms as
// toast(): it reaches for `document` inside a function, never at import time,
// so storage.js stays loadable without a browser. See tests/imports.test.js.
import { ask } from '../ui/dialog.js';

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
  toast('Saved in this browser');
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
    if (picking) setTitle(stripExt(fileHandle.name));

    const data = serializeBoard();
    const { blob, manifest } = await packBoard(data, { created });
    created = manifest.created;

    if (picking) {
      const writable = await fileHandle.createWritable();
      await writable.write(blob);
      await writable.close();
    } else {
      download(blob, fileNameFor(data.title));
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
    return await withFreshAssets(async () => {
      const { manifest, board: data } = await unpackBoard(file);
      loadBoard({ ...data, title: data.title || stripExt(file.name) });
      fileHandle = handle;
      created = manifest.created || null;
      toast('Opened ' + file.name);
      return true;
    });
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
  await clearSession();
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
    const answer = await ask({
      title: 'Unsaved changes',
      body: `This board has changes that are not in a file. ${what} will discard them.`,
      keep: 'Export first…',
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

/** Debounced snapshot of the board + any assets not already cached. */
function scheduleAutosave() {
  if (!cacheOk) return;
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => { autosave().catch(() => {}); }, 1200);
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
  // The faces the board is set in. Not on any item and so not in itemHashes(),
  // which makes them exactly the thing the sweep below would throw away: a face
  // dropped in would be gone by the next autosave, and the board would come
  // back after a reload set in a family that no longer resolves.
  for (const f of data.settings?.fonts || []) if (f?.hash) out.add(f.hash);
  return out;
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
export async function autosave() {
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
    for (const hash of needed) {
      const rec = await idbGet('assets', hash);
      if (rec?.blob) putAsset(hash, rec.blob, { ext: rec.ext, mime: rec.mime, name: rec.name });
      else lost++;
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

export async function clearSession() {
  try { await idbClear('kv'); await idbClear('assets'); } catch { /* nothing to clear */ }
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

function fileNameFor(title) {
  const base = (title || 'board').replace(/[\\/:*?"<>|]+/g, '-').trim() || 'board';
  return base.replace(/\.mbrd$/i, '') + '.mbrd';
}

function stripExt(name) {
  return name.replace(/\.mbrd$/i, '');
}
