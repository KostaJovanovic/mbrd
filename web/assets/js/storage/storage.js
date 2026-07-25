// Board persistence: the .mbrd file on one side, an IndexedDB working cache on
// the other.
//
//   .mbrd  - the durable artefact. Written through the File System Access API
//            when the browser has it (so Save overwrites in place), otherwise
//            downloaded and re-opened through a file input.
//   IndexedDB - the safety net. Every change is debounced into a snapshot plus
//            the asset blobs, so closing the tab mid-edit doesn't lose work.

import { toast, IS_DEV } from '../util.js';
import {
  board, serializeBoard, loadBoard, markDirty, isDirty, setTitle, bus,
} from '../state.js';
import { packBoard, unpackBoard, MIME } from './mbrd.js';
import { allAssets, putAsset, clearAssets } from './assets.js';
import { idbGet, idbSet, idbClear, idbKeys } from './idb.js';

const PICKER_TYPES = [{
  description: 'mbrd board',
  accept: { [MIME]: ['.mbrd'] },
}];

/** Handle of the file Save writes back to, when the browser supports it. */
let fileHandle = null;
/** First-created timestamp, carried across saves of the same board. */
let created = null;

export const canPickFiles = () => typeof window.showSaveFilePicker === 'function';
export const currentFileName = () => fileHandle?.name || null;

// ---------------------------------------------------------------------------
// Save
// ---------------------------------------------------------------------------

export async function saveBoard({ pickNew = false } = {}) {
  try {
    const data = serializeBoard();
    const { blob, manifest } = await packBoard(data, { created });
    created = manifest.created;

    if (canPickFiles()) {
      if (pickNew || !fileHandle) {
        fileHandle = await window.showSaveFilePicker({
          suggestedName: fileNameFor(data.title),
          types: PICKER_TYPES,
        });
      }
      const writable = await fileHandle.createWritable();
      await writable.write(blob);
      await writable.close();
      setTitle(stripExt(fileHandle.name));
    } else {
      download(blob, fileNameFor(data.title));
    }

    markDirty(false);
    toast('Saved ' + fileNameFor(board.title));
    return true;
  } catch (err) {
    if (err?.name === 'AbortError') return false;   // user closed the picker
    console.error(err);
    toast('Save failed: ' + err.message, 'error');
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

export async function openBoard() {
  if (!(await confirmDiscard())) return false;
  try {
    if (typeof window.showOpenFilePicker === 'function') {
      const [handle] = await window.showOpenFilePicker({ types: PICKER_TYPES, multiple: false });
      return await openFile(await handle.getFile(), handle);
    }
    const file = await pickViaInput();
    return file ? await openFile(file) : false;
  } catch (err) {
    if (err?.name === 'AbortError') return false;
    console.error(err);
    toast('Open failed: ' + err.message, 'error');
    return false;
  }
}

/** Open a .mbrd File (from a picker, a drop, or a file input). */
export async function openFile(file, handle = null) {
  try {
    const { manifest, board: data } = await unpackBoardFresh(file);
    fileHandle = handle;
    created = manifest.created || null;
    loadBoard({ ...data, title: data.title || stripExt(file.name) });
    toast('Opened ' + file.name);
    return true;
  } catch (err) {
    console.error(err);
    toast('Could not open that file: ' + err.message, 'error');
    return false;
  }
}

/**
 * Unpack into a clean asset registry, atomically.
 *
 * The current board's assets are set aside rather than cleared outright: a
 * corrupt or half-written file must leave the open board fully intact, and
 * revoking its object URLs up front would blank every image on screen before
 * we know whether the new file is even readable. The old URLs are only
 * released once the new board is definitely in.
 */
async function unpackBoardFresh(file) {
  const store = allAssets();
  const stash = new Map(store);
  store.clear();
  try {
    const result = await unpackBoard(file);
    for (const a of stash.values()) if (a.url) URL.revokeObjectURL(a.url);
    return result;
  } catch (err) {
    store.clear();
    for (const [k, v] of stash) store.set(k, v);
    throw err;
  }
}

function pickViaInput() {
  return new Promise(resolve => {
    const input = document.getElementById('file-input');
    const prevAccept = input.accept;
    input.accept = '.mbrd,application/zip';
    input.multiple = false;
    const done = () => {
      input.removeEventListener('change', onChange);
      input.accept = prevAccept;
      input.multiple = true;
      input.value = '';
    };
    const onChange = () => { const f = input.files[0] || null; done(); resolve(f); };
    input.addEventListener('change', onChange, { once: true });
    input.click();
  });
}

// ---------------------------------------------------------------------------
// New
// ---------------------------------------------------------------------------

export async function newBoard() {
  if (!(await confirmDiscard())) return false;
  clearAssets();
  fileHandle = null;
  created = null;
  loadBoard({ title: 'Untitled board', settings: board.settings });
  await clearSession();
  return true;
}

async function confirmDiscard() {
  if (!isDirty()) return true;
  return confirm('This board has unsaved changes. Discard them?');
}

// ---------------------------------------------------------------------------
// IndexedDB working cache
// ---------------------------------------------------------------------------

const SESSION_KEY = 'session';
let saveTimer = 0;
let cacheOk = true;

/** Debounced snapshot of the board + any assets not already cached. */
export function scheduleAutosave() {
  if (!cacheOk) return;
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => { autosave().catch(() => {}); }, 1200);
}

export async function autosave() {
  if (!cacheOk) return;
  try {
    const known = new Set(await idbKeys('assets'));
    for (const [hash, asset] of allAssets()) {
      if (known.has(hash)) continue;
      await idbSet('assets', hash, {
        blob: asset.blob, ext: asset.ext, mime: asset.mime, name: asset.name,
      });
    }
    await idbSet('kv', SESSION_KEY, {
      board: serializeBoard(),
      created,
      fileName: fileHandle?.name || null,
      dirty: isDirty(),
      at: Date.now(),
    });
  } catch (err) {
    // Quota or a private-mode refusal: stop trying and say so once.
    cacheOk = false;
    console.warn('[mbrd] autosave disabled:', err);
    toast('Autosave unavailable (storage full or blocked) - save to a .mbrd file', 'error');
  }
}

/** Restore the last working state. Returns true when a board was recovered. */
export async function restoreSession() {
  try {
    const session = await idbGet('kv', SESSION_KEY);
    if (!session?.board?.items) return false;
    const needed = new Set(session.board.items.map(i => i.asset?.hash).filter(Boolean));
    for (const hash of needed) {
      const rec = await idbGet('assets', hash);
      if (rec?.blob) putAsset(hash, rec.blob, { ext: rec.ext, mime: rec.mime, name: rec.name });
    }
    created = session.created || null;
    loadBoard(session.board);
    markDirty(!!session.dirty);
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
  for (const evt of ['items', 'geom', 'item', 'settings', 'board']) {
    bus.on(evt, scheduleAutosave);
  }
  // "Leave site?" on every refresh is worse than useless while developing: the
  // autosave below has already put the board in IndexedDB, and restoreSession()
  // brings it straight back, so the prompt guards nothing and costs a click on
  // every edit-reload cycle. Off on the dev server, kept everywhere else, where
  // a closed tab really can be the end of an unsaved board.
  if (IS_DEV) return;
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
