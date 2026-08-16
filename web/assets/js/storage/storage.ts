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

import { uid, isRecord } from '../util.ts';
import { toast, busy } from '../notify.ts';
import { idbGet, idbSet } from './idb.ts';
import {
  libraryIndex, putLibraryBoard, getLibraryBoard, removeLibraryBoard, hasLibraryBoard,
  trimLibrary, sweepLibrary,
} from './library.ts';
import {
  board, serializeBoard, loadBoard, markDirty, setTitle, bus, mergeBoard,
  defaultBoardTitle, isNotFoundBoard, hasContent,
} from '../state.ts';
import { normalizeBoard } from '../board-schema.ts';
import { planMerge } from '../merge.ts';
import { packBoard, unpackBoard, MIME } from './mbrd.ts';
import { allAssets, clearAssets } from './assets.ts';
import { fileNameFor, titleFromFileName, titleForOpenedBoard } from './naming.ts';
// The browser's own copy of the board. It is handed what it needs from this
// half through initSession() below rather than importing it back - see the
// header of session.js for why the file handle stays on this side.
import {
  initSession, autosave, drainSave, clearSession,
  initSessionStorage, lastSaveFailure, suspendCache,
  resetSessionLatches,
} from './session.ts';
import type { PromptOptions } from './session.ts';

/**
 * The question this module has to be able to ask, in the shape ui/dialog.ts's
 * ask() answers it: one of the three button names, or null where a field was
 * involved (never here - none of these questions has a box).
 */
export type Prompt = (opts: PromptOptions) => Promise<string | null>;

/**
 * Why a thrown thing failed, for a toast. `err.message` is what these messages
 * have always interpolated, and a throw that is not an object has none - which
 * reads as "undefined" here exactly as it did before there were types.
 */
const detailOf = (err: unknown) => String(isRecord(err) ? err.message : undefined);

/** The one throw every picker and share sheet makes when it is dismissed. */
const isAbort = (err: unknown) => isRecord(err) && err.name === 'AbortError';
// The clear-everything dialog is the one thing this module still needs from the
// interface, and ui/ sits *above* storage in the layering (AUD-12). So the
// prompt is injected rather than imported: main.js wires setPrompt() to
// ui/dialog's ask() at startup. Left unset - in a test, or before wiring - it
// answers 'cancel', which is the safe default here: nothing is wiped without a
// real answer.
//
// It used to ask twice. The other question was "you have unsaved changes,
// discard them?" in front of Open and New, and it is gone: both now file the
// outgoing board onto the library shelf instead, which is a better answer than
// any dialog because it needs no answer. See shelveCurrent().
let prompt: Prompt = async () => 'cancel';
export function setPrompt(fn: Prompt | null | undefined) {
  prompt = typeof fn === 'function' ? fn : async () => 'cancel';
}

/**
 * The board's own picture, for the shelf. Injected for exactly the reason the
 * prompt above is: it is rendered by ui/snapshot.ts and ui/ sits above storage.
 *
 * It became an injection when every door onto "replace the board" started
 * putting the old one on the shelf first. Before that only the library asked
 * for a stash, and the library is a ui/ module and could hand a thumbnail in as
 * an argument. Now openFile() stashes too - and openFile() is also called by
 * import/drop.ts, which may not import ui/ either, and by main.ts's file
 * handler. An argument would have had to be threaded through all three; this is
 * one wire in main.ts and none of the three knows.
 *
 * Unwired it answers null, which is exactly what LibraryEntry.thumb already
 * means. A shelf row without a picture is a shelf row.
 */
type ThumbMaker = () => Promise<string | null>;
let makeThumb: ThumbMaker = async () => null;
export function setBoardThumb(fn: ThumbMaker | null | undefined) {
  makeThumb = typeof fn === 'function' ? fn : async () => null;
}

/**
 * The File System Access API, which lib.dom does not declare.
 *
 * Only the two entry points this module calls and only the fields it passes -
 * a wider guess would be this file asserting a shape for an API it asks two
 * things of. Both are optional because the whole of canPickFiles() is whether
 * they are there: Safari and Firefox have neither, and the download path below
 * exists for exactly that.
 */
interface FilePickerOptions {
  suggestedName?: string;
  types?: { description?: string, accept: Record<string, string[]> }[];
  multiple?: boolean;
}

declare global {
  interface Window {
    showSaveFilePicker?: (opts?: FilePickerOptions) => Promise<FileSystemFileHandle>;
    showOpenFilePicker?: (opts?: FilePickerOptions) => Promise<FileSystemFileHandle[]>;
  }
}

const PICKER_TYPES = [{
  description: 'mbrd board',
  accept: { [MIME]: ['.mbrd'] },
}];

/** Handle of the file Export writes back to, when the browser supports it. */
let fileHandle: FileSystemFileHandle | null = null;
/** First-created timestamp, carried across saves of the same board. */
let created: string | null = null;

const canPickFiles = () => typeof window.showSaveFilePicker === 'function';

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

/**
 * What the engine said about durability, and how much room it thinks there is.
 *
 * Reported rather than asked: `persisted` is whatever ensurePersistence() has
 * already settled on, and null means nobody has saved yet, which is a real
 * answer and not a missing one. Asking here instead would make a Debug row
 * request a permission, which is not what a readout does.
 *
 * The estimate is the browser's and is deliberately vague - engines round it,
 * and some report the whole origin group - so it is worth showing and not worth
 * computing anything from. Absent where the API is not there.
 */
export async function storageReport() {
  const est = await navigator.storage?.estimate?.().catch(() => null) || null;
  return {
    persisted: persistent,
    used: typeof est?.usage === 'number' ? est.usage : null,
    quota: typeof est?.quota === 'number' ? est.quota : null,
  };
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
/**
 * Write the board out as a `.mbrd`.
 *
 * `history` decides whether the step ledger travels with it, and it defaults to
 * **false**: the history records everything that was tried and thrown away -
 * the rejected pictures, the layout that was abandoned, the note that was
 * deleted - and a recipient can scrub back through all of it. The failure is
 * asymmetric, which is what settles the default: forgetting to include the
 * history costs a resend, and forgetting to exclude it cannot be taken back.
 *
 * The *asking* is not here. This module sits below ui/ and may not open a
 * dialog; commands/file.ts asks, and only when there is a history to ask about.
 * What lives here is the honest default, so that a caller which never asks
 * still cannot leak.
 */
export async function exportBoard({ pickNew = false, history = false } = {}) {
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
      // Non-null: canPickFiles() *is* the test for this function, and `picking`
      // is its answer, taken one line above and not re-read since.
      fileHandle = await window.showSaveFilePicker!({
        suggestedName: fileNameFor(board.title),
        types: PICKER_TYPES,
      });
    }
    // Non-null for the reason the branch above is: with a picker there was
    // either a handle already or that branch has just put one here.
    if (picking) setTitle(titleFromFileName(fileHandle!.name));

    // Everything past the picker is the slow half - deflating every asset on
    // the board into one archive - and on a board of video it is a long slow
    // half with no other sign of life. The strip goes up after the picker on
    // purpose: while that dialog is open the app is waiting on a person, not
    // on itself, and saying "working" over a file browser would be a lie.
    const job = busy('Packing the board');
    try {
      const data = serializeBoard();
      // Dropping the key rather than serialising differently, and that is the
      // point: a file without a timeline is exactly what an older build writes
      // when it does not understand the key, so this is a shape the format
      // already has to survive rather than a second way of writing a board.
      if (!history) delete data.timeline;
      const { blob, manifest } = await packBoard(data, { created });
      created = manifest.created;

      if (picking) {
        job.label('Writing the file');
        const writable = await fileHandle!.createWritable();
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
    if (isAbort(err)) return false;   // user closed the picker
    console.error(err);
    toast('Export failed: ' + detailOf(err), 'error');
    return false;
  }
}

function download(blob: Blob, name: string) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  a.click();
  // Revoke late: Safari needs the URL to survive the click turn.
  setTimeout(() => URL.revokeObjectURL(url), 20000);
}

/**
 * Write any blob to disk under `name`, through the same download the exporter
 * uses. For the derived artefacts - a PNG or PDF of the board - which are not
 * .mbrd files and so never touch the file handle or the picker types, but do
 * want the one Safari-safe download in this module rather than a second copy.
 */
export function saveBlob(blob: Blob, name: string) {
  download(blob, name);
}

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
export async function shareBoard({ history = false } = {}) {
  try {
    const data = serializeBoard();
    // The same default and for the stronger reason: sharing is the case where
    // the file is going to somebody else by definition. See exportBoard().
    if (!history) delete data.timeline;
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
    return exportBoard({ history });
  } catch (err) {
    if (isAbort(err)) return false;   // user dismissed the sheet
    console.error(err);
    toast('Share failed: ' + detailOf(err), 'error');
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
    let file: File | null = null;
    let handle: FileSystemFileHandle | null = null;
    if (typeof window.showOpenFilePicker === 'function') {
      [handle] = await window.showOpenFilePicker({ types: PICKER_TYPES, multiple: false });
      file = await handle.getFile();
    } else {
      file = await pickViaInput();
    }
    return file ? await openFile(file, handle) : false;
  } catch (err) {
    if (isAbort(err)) return false;
    console.error(err);
    toast('Open failed: ' + detailOf(err), 'error');
    return false;
  }
}

/**
 * Open a .mbrd File. The one door onto "replace the board with this", and so
 * the one place the board being replaced is put somewhere safe.
 *
 * It used to be the one place the unsaved-work *question* belonged, and it used
 * to ask. It does not any more: the board leaving the screen is filed on the
 * shelf a moment before the next one arrives, so there is nothing to lose and
 * nothing to ask about. See shelveCurrent(), which carries the argument.
 *
 * The stash happens *before* unpacking, deliberately, and for the same reason
 * the question used to: withFreshAssets() sets the current board's assets aside
 * and registers the new file's in their place, so a stash after that had run
 * would be packing the outgoing board against the incoming board's bytes.
 *
 * A fresh board id is minted on the way past. Without it the arriving board
 * would inherit the shelf row of the one just put away and overwrite it on the
 * next stash - two boards, one row, and the older of them gone.
 */
export async function openFile(file: File, handle: FileSystemFileHandle | null = null) {
  try {
    // Refused rather than risked: if the outgoing board could not be filed,
    // opening this one would destroy it. shelveCurrent() has already said so.
    if (!(await shelveCurrent())) return false;
    // Unpack *and* load inside the transaction. Loading used to sit outside
    // it, on the reading that unpacking was the risky half - but the board is
    // only actually replaced by loadBoard(), and a file can be a perfectly
    // valid ZIP carrying a board.json that is not a board. Committing the
    // assets first meant that failure landed between the two: the old board's
    // object URLs revoked, the new file's bytes registered, and the old items
    // still on screen pointing at nothing. Now nothing is committed until the
    // board itself is in.
    const job = busy('Opening ' + file.name);
    // Set inside the transaction, read in the finally. `handle` is null on two
    // of the three doors into here, so it cannot tell a completed open from a
    // failed one - and what the finally decides is whether the arriving board
    // takes a new shelf row or the outgoing one keeps its old one.
    let opened = false;
    try {
      return await withFreshAssets(async () => {
        const { manifest, board: data } = await unpackBoard(file);
        // manifest.app decides whether the stored title needs its underscores
        // decoding - see titleForOpenedBoard(). The field was documented as
        // informational; this is the one thing that reads it.
        loadBoard({ ...data, title: titleForOpenedBoard(data.title, file.name, manifest.app) });
        fileHandle = handle;
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
      // After the load and outside the transaction: an open that failed leaves
      // the old board on screen, and that board must keep the id its shelf row
      // is filed under. Only a board that actually arrived gets a new one.
      if (opened) await setCurrentBoardId(uid('brd'));
      // The latches belong to the board that has just left - a quota error its
      // photographs raised, an asset it had lost. Same reasoning switchBoard()
      // and New both give.
      resetSessionLatches();
    }
  } catch (err) {
    console.error(err);
    toast('Could not open that file: ' + detailOf(err), 'error');
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
async function withFreshAssets<T>(commit: () => Promise<T>): Promise<T> {
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
  return new Promise<File | null>(resolve => {
    // #file-input is the one hidden <input type="file"> in index.html, shared
    // with Add files - see the dataset.mode note below. Absent, this whole
    // fallback has nothing to click, which is a broken build rather than a
    // state to recover from.
    // SAFETY: #file-input is the one <input type="file"> in index.html - the
    // same element import/drop.ts reaches for, and the paragraph above says why
    // an absent one is a broken build rather than a state to recover from.
    const input = document.getElementById('file-input') as HTMLInputElement;
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
    const finish = (file: File | null) => {
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
    const onChange = () => finish(input.files?.[0] || null);
    const onCancel = () => finish(null);
    // Focus returns to the window the moment the dialog closes either way, so
    // this has to give `change` a turn to land before deciding it was a
    // cancellation. Harmless where `cancel` already fired: finish() is once.
    const onFocus = () => setTimeout(() => finish(input.files?.[0] || null), 300);

    input.addEventListener('change', onChange);
    input.addEventListener('cancel', onCancel);
    addEventListener('focus', onFocus, { once: true });
    input.click();
  });
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
  fileHandle = null;
  created = null;
  // A new board is a new board, and it needs a row of its own. Without this it
  // would inherit the shelf row of the board just filed and overwrite it at the
  // next stash.
  await setCurrentBoardId(uid('brd'));
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

// ---------------------------------------------------------------------------
// The library - several boards kept in this browser
// ---------------------------------------------------------------------------
//
// The shelf beside the single session slot. Each board is packed into its own
// self-contained .mbrd blob and filed under a board id (storage/library.js), so
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
  const thumb = await makeThumb().catch(() => null);
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
  const job = busy('Switching boards');
  try {
    if (!(await shelveCurrent())) return false;
    const blob = await getLibraryBoard(id);
    if (!blob) { toast('That board is not on the shelf any more', 'error'); return false; }
    await withFreshAssets(async () => {
      const { manifest, board: data } = await unpackBoard(new File([blob], 'board.mbrd', { type: MIME }));
      loadBoard(data);
      // A string or nothing, as in openFile() above and for the same reason:
      // this manifest came out of a packed blob rather than out of this run.
      created = (typeof manifest.created === 'string' && manifest.created) || null;
    });
    fileHandle = null;
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

/** Take a board off the shelf. The board on screen cannot be deleted from under itself. */
export async function deleteLibraryBoard(id: string) {
  if (id === boardId) {
    toast('That is the board you are on - switch away from it first');
    return false;
  }
  await removeLibraryBoard(id);
  return true;
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
  // Out to main.js, which hands it to the global error handler. It is not part
  // of saving at all - it is the one question a broken app has to be able to
  // answer about a board - but the latches that answer it are session.js's, so
  // it is asked where they live rather than reconstructed anywhere else.
  boardSafety,
  // Out for the same reason and to the same kind of caller: the Debug fold's
  // safety row says what went wrong as well as that something did, and the text
  // is the engine's own.
  lastSaveFailure,
  // Out to main.js as well as used in here, and as a pair: a boot into
  // not-found opens a blank board that must never be written over the one the
  // visitor already has, so the writer is stopped before anything can fire.
  // resetSessionLatches is how it comes back on, once the board underneath is
  // the real one - see leaveNotFound() in main.js. failHandover is the third of
  // them, for the way out that the handover reaching neither end leaves behind.
  suspendCache, resetSessionLatches, failHandover,
} from './session.ts';
export { fileNameFor, titleFromFileName, titleForOpenedBoard } from './naming.ts';

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
