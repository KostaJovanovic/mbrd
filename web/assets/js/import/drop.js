// Getting things onto the board: drag-and-drop, clipboard paste, the "Add
// files" picker, and dropping a .mbrd to open it.
//
// Every path funnels into importFiles(), which hashes the bytes, classifies
// each file, and asks the arrangement engine where to put them - so a drop of
// forty photos lands as a spiral around the cursor rather than a stack.

import { toast, extOf } from '../util.js';
import { board, addItems, select, NOTE_MAX } from '../state.js';
import { addFile } from '../storage/assets.js';
import { classify, defaultSize, measureSize, linkURL, linkDraft } from './renderers.js';
import { arrange } from '../arrange/arrangements.js';
import { looksLikeMbrd } from '../storage/mbrd.js';
import { openFile } from '../storage/storage.js';

/** Guard against someone dropping a whole photo library by accident. */
const MAX_FILES = 500;

export function initDrop(vp) {
  const overlay = document.getElementById('drop-overlay');
  let depth = 0;                       // dragenter/dragleave fire per element
  let lastPoint = null;

  const show = () => { overlay.hidden = false; };
  const hide = () => { depth = 0; overlay.hidden = true; };

  addEventListener('dragenter', e => {
    if (!hasFiles(e.dataTransfer)) return;
    e.preventDefault();
    depth++;
    show();
  });

  addEventListener('dragover', e => {
    if (!hasFiles(e.dataTransfer)) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = 'copy';
    lastPoint = { x: e.clientX, y: e.clientY };
  });

  addEventListener('dragleave', e => {
    if (!hasFiles(e.dataTransfer)) return;
    if (--depth <= 0) hide();
  });

  addEventListener('drop', async e => {
    if (!hasFiles(e.dataTransfer)) return;
    e.preventDefault();
    hide();
    const pt = lastPoint || { x: e.clientX, y: e.clientY };
    const files = await filesFrom(e.dataTransfer);
    await importFiles(files, vp.toWorld(pt.x, pt.y));
  });

  addEventListener('paste', async e => {
    const target = e.target;
    if (target instanceof HTMLElement && (target.isContentEditable || /INPUT|TEXTAREA/.test(target.tagName))) return;
    const centre = vp.toWorld(vp.left + vp.cx, vp.top + vp.cy);
    const files = [...(e.clipboardData?.files || [])];
    if (files.length) {
      e.preventDefault();
      await importFiles(files, centre);
      return;
    }
    const text = e.clipboardData?.getData('text/plain');
    if (text && text.trim()) {
      e.preventDefault();
      // A pasted address is a link, not a note about a link. Tested before the
      // note branch because a note is the fallback for "some text arrived" and
      // a bare URL is the one shape of text that means something narrower than
      // that. It is also the one shape a note handles badly: NOTE_MAX would cut
      // a long address in half, leaving a sticky that quietly says somewhere
      // else. linkURL() is strict, so a paragraph that merely mentions a link
      // still lands as the note it is.
      const url = linkURL(text);
      if (url) addLink(centre, url);
      else addNote(centre, text.trim());
    }
  });

  // The "Add files" button and the picker fallback share one hidden input.
  const input = document.getElementById('file-input');
  input.addEventListener('change', async () => {
    if (!input.dataset.mode) return;             // storage.js is using it for .mbrd
    const files = [...input.files];
    input.value = '';
    delete input.dataset.mode;
    if (files.length) await importFiles(files, vp.toWorld(vp.left + vp.cx, vp.top + vp.cy));
  });
}

/** Open the OS file picker for content (not for .mbrd - that's storage.js). */
export function pickFiles() {
  const input = document.getElementById('file-input');
  input.accept = '';
  input.multiple = true;
  input.dataset.mode = 'content';
  input.click();
}

/**
 * Turn a list of Files into board items around `centre`.
 * A lone .mbrd opens as a board instead of being embedded.
 */
export async function importFiles(files, centre) {
  files = [...files].filter(f => f && (f.size > 0 || f.type));
  if (!files.length) return [];

  if (files.length === 1 && looksLikeMbrd(files[0])) {
    await openFile(files[0]);
    return [];
  }

  let trimmed = false;
  if (files.length > MAX_FILES) {
    files = files.slice(0, MAX_FILES);
    trimmed = true;
  }

  const drafts = [];
  const failed = [];
  for (const file of files) {
    try {
      let type = classify(file);
      // Measured before the layout runs, so the arrangement reserves the cell
      // the item will actually occupy (see renderers.measureSize).
      let size = await measureSize(type, file);
      // A photo this browser can't decode - HEIC, JPEG XL, camera RAW - would
      // mount as a broken <img>. A named card is a better answer than a hole,
      // and it upgrades itself for free the day a decoder lands.
      if (type === 'image' && !size.decodable) {
        type = 'generic';
        size = defaultSize('generic');
      }
      const hash = await addFile(file);
      drafts.push({
        type,
        name: file.name,
        w: size.w,
        h: size.h,
        asset: { hash, embedded: true },
        meta: {
          mime: file.type || '',
          ext: extOf(file.name),
          size: file.size,
          mtime: file.lastModified || 0,
          // Tells adoptAspect() the size is already right; only unmeasurable
          // media leaves this off and gets resized once it loads.
          sized: !!size.measured,
        },
      });
    } catch (err) {
      console.error('[mbrd] import failed for', file.name, err);
      failed.push(file.name);
    }
  }
  if (!drafts.length) {
    toast('Nothing could be imported', 'error');
    return [];
  }

  // "Free" preserves existing positions, but fresh imports have none - so a
  // drop under Free falls back to the grid instead of stacking at one point.
  const name = board.arrangement === 'free' ? 'grid' : board.arrangement;
  const spots = arrange(drafts, { name, center: centre, spacing: board.settings.spacing });
  drafts.forEach((d, i) => { d.x = spots[i].x; d.y = spots[i].y; });

  const added = addItems(drafts, drafts.length > 1 ? `Add ${drafts.length} items` : 'Add item');
  select(added.map(i => i.id));

  let msg = `Added ${added.length} item${added.length === 1 ? '' : 's'}`;
  if (trimmed) msg += ` (capped at ${MAX_FILES})`;
  if (failed.length) msg += `, ${failed.length} failed`;
  toast(msg, failed.length ? 'error' : '');
  return added;
}

/** How many colours the sticky pad comes in (see --note-1..4 in tokens.css). */
const NOTE_TINTS = 4;

/** A text card with no source file - the one item type born on the board. */
export function addNote(centre, text = '') {
  text = text.slice(0, NOTE_MAX);
  const size = defaultSize('note');
  // Cycled rather than random, so a run of notes comes off the pad in order
  // and you never get three of the same colour in a row. Stored on the item,
  // so a note keeps its colour across a save.
  const tint = board.items.filter(i => i.type === 'note').length % NOTE_TINTS + 1;
  const [item] = addItems([{
    type: 'note',
    name: text ? text.split('\n')[0].slice(0, 40) : 'Note',
    x: centre.x, y: centre.y, w: size.w, h: size.h,
    meta: { text, tint },
  }], 'Add note');
  select([item.id]);
  return item;
}

/**
 * A card for somewhere else. The second item type with no source file behind
 * it, and unlike a note it is never empty: there is no such thing as a blank
 * link, so this takes a URL that has already been through linkURL() rather
 * than a string it would have to re-check.
 *
 * No cap on the length. A note has one because a sticky is a thought you can
 * take in at a glance, and an address is not a thought - it is one value, and
 * half of one is not a shorter link but a broken one.
 */
export function addLink(centre, url) {
  const [item] = addItems([{ ...linkDraft(url), x: centre.x, y: centre.y }], 'Add link');
  select([item.id]);
  return item;
}

// --- drag payload helpers --------------------------------------------------

function hasFiles(dt) {
  return !!dt && [...(dt.types || [])].includes('Files');
}

/**
 * Files out of a DataTransfer, walking into dropped folders when the browser
 * exposes the entries API. Falls back to the flat file list elsewhere.
 */
async function filesFrom(dt) {
  const items = [...(dt.items || [])];
  const canWalk = items.length && typeof items[0].webkitGetAsEntry === 'function';
  if (!canWalk) return [...dt.files];

  const entries = items.map(i => i.webkitGetAsEntry()).filter(Boolean);
  const out = [];
  for (const entry of entries) {
    await walkEntry(entry, out);
    if (out.length >= MAX_FILES) break;
  }
  return out.length ? out : [...dt.files];
}

async function walkEntry(entry, out) {
  if (out.length >= MAX_FILES) return;
  if (entry.isFile) {
    const file = await new Promise(res => entry.file(res, () => res(null)));
    if (file) out.push(file);
    return;
  }
  if (!entry.isDirectory) return;
  const reader = entry.createReader();
  // readEntries returns at most ~100 per call and must be drained in a loop.
  for (;;) {
    const batch = await new Promise(res => reader.readEntries(res, () => res([])));
    if (!batch.length) break;
    for (const child of batch) await walkEntry(child, out);
    if (out.length >= MAX_FILES) break;
  }
}
