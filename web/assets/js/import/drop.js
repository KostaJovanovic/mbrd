// Getting things onto the board: drag-and-drop, clipboard paste, the "Add
// files" picker, and dropping a .mbrd to open it.
//
// Every path funnels into importFiles(), which hashes the bytes, classifies
// each file, and asks the arrangement engine where to put them - so a drop of
// forty photos lands as a spiral around the cursor rather than a stack.

import { toast, extOf } from '../util.js';
import { board, bus, addItems, select, setItemCover, NOTE_MAX } from '../state.js';
import { addFile } from '../storage/assets.js';
import { classify, defaultSize, measureSize, linkURL, linkDraft } from '../canvas/renderers.js';
import { arrange } from '../arrange/arrangements.js';
import { coverArt, mayHaveArt } from './artwork.js';
import { looksLikeMbrd } from '../storage/mbrd.js';
import { openFile } from '../storage/storage.js';

/**
 * Extensions a browser can turn into a FontFace.
 *
 * Here rather than in ui/fonts.js because this is the question "what kind of
 * file is this", which is this layer's job - and because naming it there and
 * importing it from here is the import edge the bus exists to avoid. Not in
 * formats.js either: that file is generated from the sibling catalog and would
 * lose a hand-written addition on the next run.
 */
const FONT_EXTS = new Set(['woff2', 'woff', 'ttf', 'otf']);

/** Guard against someone dropping a whole photo library by accident. */
const MAX_FILES = 500;

/**
 * How many files are prepared at once.
 *
 * Small on purpose. Each one holds a whole file in memory while it is hashed
 * and measured, so this is the number that decides the peak cost of a big
 * drop - and a drop can be 500 videos. Six keeps the two-second measurement
 * timeouts overlapping, which is where all the wall-clock went, without
 * turning a folder of video into a folder of video decoded simultaneously.
 */
const IMPORT_WORKERS = 6;

export function initDrop(vp) {
  const overlay = document.getElementById('drop-overlay');
  let depth = 0;                       // dragenter/dragleave fire per element
  let lastPoint = null;

  const show = () => { overlay.hidden = false; };
  const hide = () => { depth = 0; overlay.hidden = true; };

  // Files or a link. Both are "something from outside landing on the board",
  // and the overlay says the same thing for either.
  const takes = dt => hasFiles(dt) || hasLink(dt);

  addEventListener('dragenter', e => {
    if (!takes(e.dataTransfer)) return;
    e.preventDefault();
    depth++;
    show();
  });

  addEventListener('dragover', e => {
    if (!takes(e.dataTransfer)) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = 'copy';
    lastPoint = { x: e.clientX, y: e.clientY };
  });

  addEventListener('dragleave', e => {
    if (!takes(e.dataTransfer)) return;
    if (--depth <= 0) hide();
  });

  addEventListener('drop', async e => {
    if (!takes(e.dataTransfer)) return;
    e.preventDefault();
    hide();
    const pt = lastPoint || { x: e.clientX, y: e.clientY };
    const at = vp.toWorld(pt.x, pt.y);
    // Files first. A drag can carry both - dragging an image out of a page
    // offers the picture *and* the address it came from - and in that case the
    // picture is what was being dragged, with the URL along for the ride.
    if (hasFiles(e.dataTransfer)) {
      await importFiles(await filesFrom(e.dataTransfer), at);
      return;
    }
    const urls = urlsFrom(e.dataTransfer);
    // The overlay has already said yes by this point - it has to, since a drag's
    // contents cannot be read until it lands - so a payload that turns out to
    // hold nothing we will open needs saying out loud. Silently swallowing it
    // would look exactly like the drop having missed.
    if (!urls.length) { toast('That link is not one this can open'); return; }
    addLinks(at, urls);
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
    const mode = input.dataset.mode;
    if (!mode) return;                           // storage.js is using it for .mbrd
    const files = [...input.files];
    input.value = '';
    delete input.dataset.mode;
    // Back to the defaults the content picker wants, so the next opening of it
    // is not still filtered to images and limited to one.
    input.accept = '';
    input.multiple = true;
    if (mode === 'cover') {
      const id = coverFor;
      coverFor = null;
      if (files[0]) await applyCover(id, files[0]);
      return;
    }
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
 * The item waiting for a picture, between opening the picker and it answering.
 *
 * Module state rather than a closure because the one hidden input is shared
 * three ways - content here, .mbrd in storage.js, and now this - and `mode` on
 * the element is how they stay out of each other's way. Cleared as soon as it
 * is read, so a cancelled picker cannot leave a card armed to receive the next
 * unrelated file.
 */
let coverFor = null;

/** Choose a picture for one card. See setItemCover() in state.js. */
export function pickCover(id) {
  const input = document.getElementById('file-input');
  input.accept = 'image/*';
  input.multiple = false;
  input.dataset.mode = 'cover';
  coverFor = id;
  input.click();
}

/**
 * Attach a chosen picture to a card.
 *
 * Decodability is checked rather than assumed, and that is the whole of the
 * work here. `accept="image/*"` is a filter on a dialog, not a promise: it lets
 * through HEIC out of a phone and camera RAW out of a folder, both of which
 * this browser may well be unable to draw. Setting one anyway would replace a
 * card that looked like something with a card showing a broken image - a worse
 * result than the one being fixed, and undoable only if the user works out
 * what happened.
 */
async function applyCover(id, file) {
  if (classify(file) !== 'image') {
    toast(`${file.name} is not a picture`, 'error');
    return;
  }
  const { decodable } = await measureSize('image', file);
  if (!decodable) {
    toast(`This browser cannot draw ${file.name}`, 'error');
    return;
  }
  setItemCover(id, await addFile(file));
  toast('Picture set');
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

  // A font is not a thing to put on a board, it is a thing to set the board in.
  // Taken out here rather than turned into a card and reclassified later,
  // because everything below this line is about producing items.
  //
  // Announced rather than handled: registering a face means FontFace and
  // document.fonts, and this module has to stay loadable without a browser -
  // see tests/imports.test.js. ui/fonts.js is listening.
  const fonts = files.filter(f => FONT_EXTS.has(extOf(f.name)));
  if (fonts.length) {
    bus.emit('fonts:add', fonts);
    files = files.filter(f => !FONT_EXTS.has(extOf(f.name)));
    if (!files.length) return [];
  }

  let trimmed = false;
  if (files.length > MAX_FILES) {
    files = files.slice(0, MAX_FILES);
    trimmed = true;
  }

  // Prepared several at a time, in order.
  //
  // This was a plain sequential loop, and every file in it waits on two slow
  // things: hashing its bytes and measuring it. Measurement is the bad one - a
  // video the browser cannot read sits on the two-second timeout in
  // measureSize() before giving up, so a folder of 500 of them took something
  // like a thousand seconds before a single item appeared on the board, with
  // nothing on screen to suggest anything was happening.
  //
  // Bounded rather than unbounded: each of these holds a whole file in memory
  // while it works, so Promise.all over the lot would turn a folder of video
  // into a folder of video decoded all at once. Six is enough to keep the
  // timeouts overlapping without that.
  //
  // Results land by index, so the order the arrangement sees is the order the
  // files arrived in rather than the order they happened to finish.
  const prepared = new Array(files.length).fill(null);
  const failed = [];
  let next = 0;
  const worker = async () => {
    for (;;) {
      const i = next++;
      if (i >= files.length) return;
      const file = files[i];
      try {
        prepared[i] = await prepareFile(file);
      } catch (err) {
        console.error('[mbrd] import failed for', file.name, err);
        failed.push(file.name);
      }
    }
  };
  await Promise.all(
    Array.from({ length: Math.min(IMPORT_WORKERS, files.length) }, worker)
  );
  const drafts = prepared.filter(Boolean);

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

  // Announced rather than acted on, and that is a layering constraint rather
  // than a preference: ui/appearance.js reaches for `document` at import time,
  // and tests/imports.test.js holds this file to loading without a browser -
  // which is what keeps the import pipeline testable in node at all. So this
  // says what happened and ui/ decides what that is worth.
  //
  // Its own event rather than riding on 'items', which fires for a drag, an
  // undo and a delete as well: "an import happened, and this is what it
  // brought" is a thing worth being able to hear on its own. The palette no
  // longer listens for it - a delete changes the board's colours as surely as
  // an import does, so ui/appearance.js watches 'items' and compares the
  // pictures itself - but the announcement stands on its own terms.
  bus.emit('imported', added);
  return added;
}

/** One file, classified, measured, hashed and turned into a draft item. */
async function prepareFile(file) {
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
  // An audio file usually carries its own picture, and the card has a slot for
  // one already - see setItemCover() in state.js. Registered as an ordinary
  // asset, so an album's twelve tracks embedding the identical cover cost one
  // copy of it. Tried before the item exists rather than after it mounts, so
  // the card is never briefly the plain one; null is the common answer and
  // costs a single 16-byte read.
  const cover = type === 'audio' && mayHaveArt(file.name)
    ? await coverArt(file).then(art => art && addFile(art)).catch(() => null)
    : null;
  return {
    type,
    name: file.name,
    w: size.w,
    h: size.h,
    asset: { hash, embedded: true },
    meta: {
      ...(cover ? { cover } : {}),
      mime: file.type || '',
      ext: extOf(file.name),
      size: file.size,
      mtime: file.lastModified || 0,
      // The name the file arrived under, kept even after it is renamed,
      // because clearing a name is meant to give this back - see
      // state.js/renameItem.
      //
      // On the item rather than only in the asset registry, which is where
      // it used to live alone. The registry is rebuilt from the archive on
      // every open and the archive carries no filenames, so after a save
      // and a reopen "clear the name" fell back to the *renamed* value and
      // the original was gone. Here it travels inside board.json.
      origName: file.name,
      // Tells adoptAspect() the size is already right; only unmeasurable
      // media leaves this off and gets resized once it loads.
      sized: !!size.measured,
    },
  };
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

/**
 * Several links at once, cascaded from where they landed.
 *
 * Not run through the arrangement engine like a file drop is. That engine
 * reserves a cell per item and lays the whole set out from a centre, which is
 * right for a folder of photos arriving at once and wrong for two or three
 * links dropped at a spot you chose: a cascade keeps the first one exactly
 * where the pointer was, and a dropped link should land under the pointer.
 */
export function addLinks(at, urls) {
  if (!urls.length) return [];
  const drafts = urls.map((url, i) => ({
    ...linkDraft(url),
    x: at.x + i * LINK_STEP.x,
    y: at.y + i * LINK_STEP.y,
  }));
  const made = addItems(drafts, drafts.length > 1 ? `Add ${drafts.length} links` : 'Add link');
  select(made.map(i => i.id));
  return made;
}

/** Enough that each card's corner and title clear the one beneath it. */
const LINK_STEP = { x: 26, y: -26 };

// --- drag payload helpers --------------------------------------------------

function hasFiles(dt) {
  return !!dt && [...(dt.types || [])].includes('Files');
}

/**
 * Whether a drag is carrying a link - a tab, a bookmark, or an anchor dragged
 * off a page.
 *
 * Only `text/uri-list` counts, and the narrowness is the point. A drag's data
 * cannot be read during dragenter/dragover - only the list of types is exposed,
 * deliberately, so a page cannot read what is passing over it - which means the
 * overlay has to commit to accepting the drop before it can see what it is. Any
 * dragged text at all sets `text/plain`, so gating on that would raise the
 * overlay for every stray selection dragged across the window and then quietly
 * drop most of them. `text/uri-list` is set only when the source says the thing
 * being dragged *is* a link.
 */
function hasLink(dt) {
  return !!dt && [...(dt.types || [])].includes('text/uri-list');
}

/**
 * The URLs in a dropped payload.
 *
 * text/uri-list is a real format rather than a bare string: it may hold several
 * URLs, one per line, and lines beginning with '#' are comments. Falls back to
 * text/plain because a few sources announce uri-list and then put the address
 * only in the plain text. Everything goes through linkURL(), so whatever is in
 * there is held to exactly the same standard as a pasted address.
 */
function urlsFrom(dt) {
  const raw = (dt.getData('text/uri-list') || dt.getData('text/plain') || '');
  return raw.split(/[\r\n]+/)
    .filter(line => line && !line.startsWith('#'))
    .map(linkURL)
    .filter(Boolean);
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
