// Getting things onto the board: drag-and-drop, clipboard paste, the "Add
// files" picker, and dropping a .mbrd to open it.
//
// Every path funnels into importFiles(), which hashes the bytes, classifies
// each file, and asks the arrangement engine where to put them - so a drop of
// forty photos lands as a spiral around the cursor rather than a stack.

import { extOf } from '../util.ts';
import { toast, busy } from '../notify.ts';
import {
  board, bus, addItems, select, setItemCover, NOTE_MAX, baseStep, startSettling,
} from '../state.ts';
import { addFile } from '../storage/assets.ts';
import { makeByteBudget, overPixelBudget } from './budget.ts';
import {
  classify, defaultSize, measureSize, fitToBox, linkURL, linkDraft, videoFrame,
  swatchHex, SWATCH_DEFAULT,
} from '../canvas/renderers.ts';
import { iframeURL, embedFor } from '../canvas/embed.ts';
import { arrange, mobileOrder } from '../arrange/arrangements.ts';
import { coverArt, mayHaveArt } from './artwork.ts';
import { embeddedPreview } from './preview.ts';
// Statically, unlike import/pdf.js below it: this one reaches storage/zip.js and
// nothing else, and the zip reader is already in memory - it is what opens every
// .mbrd. There is no dependency to defer and so no reason to defer it.
import { hasBakedPreview, bakedPreview } from './document.ts';
import { makeThumb } from '../optimize/picture.ts';
import { looksLikeMbrd } from '../storage/mbrd.ts';
import { openOrMergeFile } from '../storage/storage.ts';
import { stickerShape, stickerTint, DEFAULT_SHAPE } from '../stickers/catalogue.ts';
import { tilePictures } from '../style-tile.ts';
import type { Point } from '../arrange/arrangements.ts';
import type { Size } from '../canvas/renderers.ts';
import type { Item, ItemMeta } from '../board-model.ts';

/**
 * A card on its way onto the board: everything makeItem() needs and nothing it
 * does not. `x` and `y` are a placeholder until the arrangement answers - see
 * importFiles(), which fills both before addItems() is ever called, and coord()
 * in board-model.ts, which reads an absent one as the same zero.
 */
type Draft = {
  type: string;
  name: string;
  x: number;
  y: number;
  w: number;
  h: number;
  asset: { hash: string, embedded: boolean };
  meta: ItemMeta;
};

/**
 * What prepareFile() settles on for a card's box.
 *
 * Wider than renderers.ts's MeasuredSize because two of the branches answer
 * with a bare defaultSize(), which says nothing about decodability or about
 * where the numbers came from - and the reads below are written for exactly
 * that: an absent `decodable` is the falsy answer they already took.
 */
type DraftSize = Size & { decodable?: boolean, measured?: boolean, natural?: Size };

/**
 * What a dropped entry is, said as a narrowing.
 *
 * `isFile` and `isDirectory` are plain booleans on FileSystemEntry, so neither
 * tells the checker which of the two subtypes it is holding - and the two
 * subtypes are where `file()` and `createReader()` live. The pair is exhaustive
 * by spec: every entry is one or the other.
 */
const isFileEntry = (e: FileSystemEntry): e is FileSystemFileEntry => e.isFile;
const isDirEntry = (e: FileSystemEntry): e is FileSystemDirectoryEntry => e.isDirectory;

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
export const MAX_FILES = 500;

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

/**
 * The half of the Viewport this module asks for: a screen point turned into a
 * world one, and where the middle of the view is for a paste with no cursor.
 * Structural for the reason commands/view.ts gives: naming a whole Viewport
 * would be asserting a shape this file never touches, and this module is held
 * to loading without a browser at all (tests/imports.test.js).
 */
export interface DropViewport {
  toWorld(x: number, y: number): Point;
  cursor?: Point | null;
  left: number;
  top: number;
  cx: number;
  cy: number;
}

export function initDrop(vp: DropViewport) {
  // Both ids below are declared in index.html; an absent one is a broken build
  // rather than a state to recover from, which is what the rest of the app says
  // about its own markup too.
  const overlay = document.getElementById('drop-overlay')!;
  let depth = 0;                       // dragenter/dragleave fire per element
  let lastPoint: Point | null = null;

  const show = () => { overlay.hidden = false; };
  const hide = () => { depth = 0; overlay.hidden = true; };

  // Files or a link. Both are "something from outside landing on the board",
  // and the overlay says the same thing for either.
  // A predicate rather than a boolean, so the handlers below can read the
  // payload they have just agreed to take without asking again whether it is
  // there. "Carries something" and "is not null" are the same sentence here.
  const takes = (dt: DataTransfer | null): dt is DataTransfer => hasFiles(dt) || hasLink(dt);

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
      const incoming = await filesFrom(e.dataTransfer);
      await importFiles(incoming.files, at, {
        avoidOverlap: incoming.fromFolder,
        truncated: incoming.truncated,
      });
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
    // Under the cursor when there is one (a mouse has moved over the board),
    // the centre of the view otherwise - a touch device, or a paste before the
    // pointer has been anywhere. vp.cursor is screen space, set by input.js.
    const centre = vp.cursor
      ? vp.toWorld(vp.cursor.x, vp.cursor.y)
      : vp.toWorld(vp.left + vp.cx, vp.top + vp.cy);
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
      if (url) { addLink(centre, url); return; }
      // An `<iframe>` block is the second shape of text that means a link and
      // nothing else. YouTube and Spotify both hand out markup rather than an
      // address from their Share menus, so pasting that block is a thing people
      // do - and landing it as a sticky note full of angle brackets is the app
      // refusing to understand something it plainly understands. See
      // iframeURL(): the pasted string is never parsed as HTML, only searched.
      //
      // Canonicalised here and *only* here. A pasted address is left exactly as
      // written, on linkURL()'s principle that guessing at what somebody meant
      // silently rewrites it - a `?t=90` on a YouTube link is the timestamp
      // they wanted. An embed URL is different: nobody typed it, it is the
      // machine-facing half of a share block, and a card whose address reads
      // open.spotify.com/embed/track/… is showing plumbing.
      const framed = iframeURL(text, linkURL);
      if (framed) addLink(centre, embedPage(framed));
      else addNote(centre, text.trim());
    }
  });

  // The "Add files" button and the picker fallback share one hidden input.
  const input = document.getElementById('file-input') as HTMLInputElement;
  input.addEventListener('change', async () => {
    const mode = input.dataset.mode;
    // Not ours. Either nobody set one, or storage.js has it open for a .mbrd and
    // said so - both are the same answer here, and asking positively means a
    // future third owner is refused rather than mistaken for content.
    if (mode !== 'content' && mode !== 'cover') return;
    const files = [...(input.files || [])];
    input.value = '';
    delete input.dataset.mode;
    // Back to the defaults the content picker wants, so the next opening of it
    // is not still filtered to images or limited to one.
    input.accept = '';
    input.multiple = true;
    if (mode === 'cover') {
      const id = coverFor;
      coverFor = null;
      // `id` is set by pickCover() at the same moment the mode is, so a change
      // in cover mode has one; the check is what says so rather than a claim.
      if (id && files[0]) await applyCover(id, files[0]);
      return;
    }
    if (files.length) await importFiles(files, vp.toWorld(vp.left + vp.cx, vp.top + vp.cy));
  });
}

/**
 * Open the OS file picker for content (not for .mbrd - that's storage.js).
 *
 * Every attribute the pickers disagree about is written here rather than
 * assumed, and the reason is the one path with no event at the end of it: a
 * cancelled picker never fires `change`, so the reset in the change handler
 * never runs. Leaving the last opening's `accept` on the shared input would
 * mean that cancelling "Choose a picture" once made "Add files" a picture
 * button for the rest of the session.
 */
export function pickFiles() {
  const input = document.getElementById('file-input') as HTMLInputElement;
  input.accept = '';
  input.multiple = true;
  input.dataset.mode = 'content';
  // With accept and multiple, and for the reason above: `mode` was the one
  // attribute the reset in the change handler owned alone, so a cancelled cover
  // picker left mode='cover' and coverFor pointing at a card - and the *next*
  // Add files then handed its first file to that card as a cover and dropped the
  // rest. Cleared at open time here, which is the only moment every path passes
  // through.
  coverFor = null;
  input.click();
}

/**
 * The item waiting for a picture, between opening the picker and it answering.
 *
 * Module state rather than a closure because the one hidden input is shared
 * three ways - content here, .mbrd in storage.js, and this - and `mode` on
 * the element is how they stay out of each other's way.
 *
 * Cleared when it is read, *and* at the head of pickFiles(). Only the first was
 * ever true, which left the arming to survive a cancel: a cancelled picker fires
 * no `change`, so the card stayed armed until something opened the picker again
 * - and the next Add files gave that card its first file as a cover.
 */
let coverFor: string | null = null;

/** Choose a picture for one card. See setItemCover() in state.js. */
export function pickCover(id: string) {
  const input = document.getElementById('file-input') as HTMLInputElement;
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
async function applyCover(id: string, file: File) {
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
export async function importFiles(
  files: File[],
  centre: Point,
  { avoidOverlap = false, truncated = false }: { avoidOverlap?: boolean, truncated?: boolean } = {},
) {
  files = [...files].filter(f => f && (f.size > 0 || f.type));
  if (!files.length) return [];

  // A board file is not a thing to put on a board, it is a board. Two things can
  // be meant by dropping one, and which is meant depends entirely on what is
  // already here - so it is asked rather than guessed.
  //
  // On an empty board there is no question: merging into nothing and opening are
  // the same result, and a dialog offering two words for one outcome is a dialog
  // that teaches people to stop reading them. So the question is only asked when
  // there is something to lose the sense of.
  //
  // Asked here rather than offered as a button in the panel, and that is the
  // whole placement of the feature: "open or merge" only ever comes up when a
  // file arrives, and a Merge button would have to open a picker to ask again
  // what the drop already knows.
  if (files.length === 1 && looksLikeMbrd(files[0])) {
    await openOrMergeFile(files[0]);
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

  // Seeded from what the walk reported, because by the time the list arrives
  // here the cut has already happened: filesFrom() stops *at* MAX_FILES, so the
  // comparison below can only ever fire for a caller that did not cap - the
  // picker, and the paste path.
  let trimmed = truncated;
  if (files.length > MAX_FILES) {
    files = files.slice(0, MAX_FILES);
    trimmed = true;
  }

  // Byte budget, applied in file order so the cut is deterministic. The 500-file
  // cap above is a UX guard, not a memory boundary - five files can be five 4K
  // videos. Files past the budget are dropped rather than failing the whole
  // import, so a folder with one giant video still brings the rest in. See
  // import/budget.js and AUD-05.
  const budget = makeByteBudget();
  let overBudget = 0;
  files = files.filter(f => {
    if (budget.take(f.size || 0)) return true;
    overBudget++;
    return false;
  });
  if (!files.length) {
    toast('Those files are too large to import', 'error');
    return [];
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
  const prepared: (Draft | null)[] = new Array(files.length).fill(null);
  const failed: string[] = [];
  // Photos this browser cannot decode that had no embedded preview to fall back on,
  // so they came in as named cards rather than pictures - counted to say so once at
  // the end rather than per file (prepareFile fills it).
  const stats = { undecodable: 0 };
  let firstError: unknown = null;
  let next = 0;
  // Counted rather than indexed: six of these run at once and finish out of
  // order, so `next` is how many have been *started* and says nothing about how
  // many are done.
  let settled = 0;
  // A big drop (a folder of videos, each able to sit on the 2 s measureSize timeout)
  // is otherwise minutes of unstoppable work. The cancel button on the busy strip
  // aborts this: no new file is started, whatever finished is kept and laid out.
  const control = new AbortController();
  let cancelled = false;
  const job = busy(files.length > 1 ? `Reading ${files.length} files` : 'Reading',
    files.length > 1 ? { onCancel: () => { cancelled = true; control.abort(); } } : {});
  const worker = async () => {
    for (;;) {
      if (control.signal.aborted) return;
      const i = next++;
      if (i >= files.length) return;
      const file = files[i];
      try {
        prepared[i] = await prepareFile(file, stats);
      } catch (err) {
        console.error('[mbrd] import failed for', file.name, err);
        firstError ??= err;
        failed.push(file.name);
      }
      job.step(++settled, files.length);
    }
  };
  try {
    await Promise.all(
      Array.from({ length: Math.min(IMPORT_WORKERS, files.length) }, worker)
    );
  } finally {
    // In a finally, and every busy() in this app is: a throw that skipped it
    // would leave the strip up over a board that is doing nothing, for the rest
    // of the session, with no way to take it down.
    job.end();
  }
  const drafts = prepared.filter((d): d is Draft => !!d);

  if (cancelled && !drafts.length) {
    toast('Import stopped');
    return [];
  }
  if (!drafts.length) {
    // When every single file failed the same way it is almost never the files,
    // and the bare sentence sent people looking at their photos. It is worth
    // the console: one of these was `crypto.subtle` missing on a page served
    // over plain http, which broke every import on a phone and said nothing at
    // all about why. Truncated because a toast is a line, not a stack.
    const why = String((firstError instanceof Error && firstError.message) || '').slice(0, 80);
    toast(why ? `Nothing could be imported - ${why}` : 'Nothing could be imported', 'error');
    return [];
  }

  const desktop = board.layoutMode !== 'mobile';
  if (!desktop) {
    // Mobile lays nothing out here. placeMobileItems() below packs the column
    // and the arrangement's whole remaining job is the sequence it packs in, so
    // running a 2D layout first only to sort its output away was work thrown
    // out - and, once the two catalogues split, work done under a name that no
    // longer names a shape. No seed: a drop is reproducible, and Shuffle
    // unseeded is the order the files arrived in.
    // The cast is safe because mobileOrder() mints nothing: it returns the very
    // objects it was handed, in another order (see ORDERS in arrangements.ts),
    // so every element here is one of the drafts that went in.
    const ordered = mobileOrder(drafts, { name: board.arrangement }) as Draft[];
    drafts.length = 0;
    drafts.push(...ordered);
  }
  // "Free" preserves existing positions, but fresh imports have none - so a
  // drop under Free falls back to the grid instead of stacking at one point.
  const name = board.arrangement === 'free' ? 'grid' : board.arrangement;
  if (desktop) {
    const spots = arrange(drafts, {
      name,
      center: centre,
      spacing: board.settings.spacing,
      // A snapped Desktop drop is snapped item-by-item on the way in (onLattice
      // in state.js), so the layout has to reserve whole cells or the same
      // rounding that overlaps a tight Rearrange overlaps a tight drop - see
      // arrange().
      cellStep: board.settings.snap ? baseStep() : 0,
      // A folder dropped onto a Desktop board flows around what is already there
      // rather than landing on top of it. The Mobile board packs around existing
      // items itself (placeMobileItems), so this is Desktop's half of the same
      // promise; a paste or a bare-file drop still stacks at the cursor as before.
      obstacles: avoidOverlap
        ? board.items.map(it => ({ x: it.x, y: it.y, w: it.w, h: it.h }))
        : undefined,
    });
    drafts.forEach((d, i) => { d.x = spots[i].x; d.y = spots[i].y; });
  }

  const added = addItems(
    drafts,
    drafts.length > 1 ? `Add ${drafts.length} items` : 'Add item',
    { avoidOverlap: avoidOverlap || board.layoutMode === 'mobile' }
  );
  select(added.map((i: Item) => i.id));

  let msg = `${cancelled ? 'Stopped — kept' : 'Added'} ${added.length} item${added.length === 1 ? '' : 's'}`;
  if (trimmed) msg += ` (capped at ${MAX_FILES})`;
  if (overBudget) msg += `, ${overBudget} too large`;
  if (failed.length) msg += `, ${failed.length} failed`;
  // The undecodable photos still came in - as named cards - so this rides the
  // ordinary receipt, not the error tone, and only when nothing worse happened.
  if (stats.undecodable && !failed.length) {
    msg += `, ${stats.undecodable} shown as cards (this browser can’t decode ${stats.undecodable === 1 ? 'it' : 'them'})`;
  }
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

/**
 * A picture's thumbnail, registered as an asset, or null.
 *
 * The import module is held to loading without a browser (tests/imports.test.js)
 * and makeThumb() reaches for OffscreenCanvas - which is fine, because it does
 * so inside the call rather than at module scope. Same bargain the rest of this
 * file makes with `document`.
 */
export async function thumbFor(blob: Blob, naturalWidth = 0) {
  const small = await makeThumb(blob, naturalWidth);
  if (!small) return null;
  const hash = await addFile(new File([small.blob], 'thumb.webp', { type: 'image/webp' }));
  // `cutout` rides back with the hash because it was measured on the way past.
  // It is the thumbnail pass that has a decoded picture in hand, so asking the
  // question anywhere else would mean decoding the file a second time to learn
  // something this one already knows.
  return { hash, cutout: small.cutout };
}

/**
 * A still out of a clip, registered as an asset. Two routes, one answer.
 *
 * Every video gets one, not only the unplayable ones. That used to be the rule
 * and it left the common case looking broken: a phone shows a video card with
 * no source attached at all until it is tapped - the decoder ceiling makes that
 * necessary, see the video renderer - so a perfectly playable clip sat on a
 * mobile board as an empty black box. Desktop hid the problem by loading
 * metadata at `#t=0.1` and painting the frame it got. A poster is what gives
 * the phone the same picture without holding a decoder open for it.
 *
 * The browser's own decoder is tried first and answers for almost everything,
 * at the cost of one seek. Only a clip it cannot open at all falls through to
 * ffmpeg - H.265 is the case - and that route is dynamically imported for a
 * reason: the core is thirty megabytes off a CDN, most boards never need it,
 * and a machine without it answers "no" from a HEAD request before anything is
 * loaded. An import of ordinary MP4s never touches it.
 *
 * Everything about this is allowed to fail. No decoder, no frame, a format the
 * encoder will not write - all of them come back null, and null means the clip
 * is exactly what it was before: a video card with nothing to show yet.
 */
async function posterFor(file: File, decodable: boolean | undefined) {
  if (decodable) {
    try {
      const frame = await videoFrame(file);
      if (frame) {
        const named = new File([frame.blob], 'poster.webp', { type: 'image/webp' });
        // The file comes back beside the hash so the caller can cut a thumbnail
        // from it without going to the asset store for bytes it just handed over.
        return { hash: await addFile(named), w: frame.w, h: frame.h, file: named };
      }
    } catch { /* fall through - a clip with no poster is what it was before */ }
    // Deliberately not falling through to ffmpeg. The browser opened this clip,
    // so thirty megabytes would be spent to answer a question it can already
    // answer; that it declined to hand over a frame is a decoder quirk, not a
    // format this app cannot read.
    return null;
  }
  try {
    const { firstFrame } = await import('../optimize/media.ts');
    const frame = await firstFrame(file, msg => toast(msg));
    if (!frame) return null;
    const named = new File([frame], 'poster.' + (frame.type === 'image/png' ? 'png' : 'jpg'),
                           { type: frame.type });
    // Measured as a picture, which it now is, and hashed like any other asset -
    // so two copies of the same clip share one poster.
    const [shape, hash] = await Promise.all([measureSize('image', named), addFile(named)]);
    return {
      hash,
      w: shape.measured ? shape.w : 0,
      h: shape.measured ? shape.h : 0,
      file: named,
    };
  } catch {
    return null;
  }
}

/**
 * A PDF, by its declared type or its extension.
 *
 * `.ai` is in here, and it is not a mistake. Every Illustrator file written this
 * century is a PDF - Adobe stopped using its own container and started writing a
 * PDF with the editable artwork tucked inside it as private data, which is why
 * a browser, a printer and every viewer on a phone will open one. So an .ai gets
 * page one rendered like any other PDF, and a design file that used to land as a
 * grey named card now lands showing its own artwork.
 *
 * The pre-2000 EPS-based .ai is not a PDF and pdf.js declines it; that comes back
 * null and the card is what it always was.
 */
const isPdf = (file: File) => file.type === 'application/pdf'
  || PDF_EXTS.has(extOf(file.name));

const PDF_EXTS = new Set(['pdf', 'ai']);

/** One file, classified, measured, hashed and turned into a draft item. `stats`
 *  collects soft outcomes worth reporting once for the whole drop (see importFiles). */
async function prepareFile(file: File, stats = { undecodable: 0 }): Promise<Draft> {
  let type = classify(file);
  let size: DraftSize | undefined;
  // A decodable stand-in pulled out of a picture the browser cannot draw (HEIC,
  // RAW), and the file it came from. Both stay null for everything else. See the
  // undecodable branch below and import/preview.js.
  let previewHash: string | null = null;
  let previewFile: File | null = null;
  // A PDF is the same shape of problem as an undecodable photo: the app cannot
  // draw it, but it can produce a picture of its first page (import/pdf.js, which
  // fetches pdf.js on demand). Handled exactly like the embedded-preview path -
  // the original PDF stays asset.hash and is still what a click opens, while the
  // rendered page becomes meta.preview and is what the card shows. Any failure -
  // offline, CDN down, a parse error - leaves size unset, so it falls through to
  // the named card it would otherwise have been. This is the app's second
  // outside-code dependency; see the header of import/pdf.js.
  if (isPdf(file)) {
    const { firstPageRaster } = await import('./pdf.ts');
    const page = await firstPageRaster(file).catch(() => null);
    if (page?.blob) {
      previewFile = new File([page.blob], 'page.webp', { type: page.blob.type || 'image/webp' });
      previewHash = await addFile(previewFile);
      type = 'image';
      size = { ...fitToBox('image', page.w, page.h), measured: true, decodable: true };
    }
  }
  // And the same trade for every other document that carries a picture of
  // itself. A Word file, a spreadsheet, a Krita painting, a Procreate canvas, a
  // Keynote deck and a PSD all ship a rendered thumbnail their own application
  // wrote for the file browser, at a known path inside a zip or in a known
  // record near the front of the file - so this costs a container read and no
  // renderer, no library and no network. See import/document.js.
  //
  // After the PDF branch and gated on `size` for the reason it is: a hit here
  // has already decided what the card is, and nothing below should measure it a
  // second time. A miss is silent and leaves the card exactly as it was.
  if (!size && hasBakedPreview(file)) {
    const baked = await bakedPreview(file).catch(() => null);
    const shot = baked && await measureSize('image', baked);
    // `baked` again rather than only `shot`: without a preview there is no
    // measurement either, so the two are one condition said twice.
    if (baked && shot?.decodable) {
      previewFile = baked;
      previewHash = await addFile(baked);
      type = 'image';
      size = shot;
    }
  }
  // A decode bomb - a small file that declares enormous dimensions - is caught
  // from its header before measureSize() hands it to createImageBitmap(), which
  // would otherwise allocate gigabytes. Over budget it becomes a named card, the
  // same fallback an undecodable image gets below. See import/budget.js.
  if (size) {
    // Already decided - the PDF branch above rendered a page and measured it.
  } else if (type === 'image' && await overPixelBudget(file)) {
    type = 'generic';
    size = defaultSize('generic');
  } else {
    // Measured before the layout runs, so the arrangement reserves the cell
    // the item will actually occupy (see renderers.measureSize).
    size = await measureSize(type, file);
    // A photo this browser can't decode - HEIC, JPEG XL, camera RAW - would
    // mount as a broken <img>. Before falling back to a named card, look inside
    // it for the copy the camera already made (import/preview.js): most of these
    // formats carry a full-size or thumbnail JPEG the browser *will* draw. Found
    // and itself decodable, the card stays an image and draws that preview,
    // while asset.hash below still names the untouched original - so it costs the
    // original nothing and upgrades itself for free the day a real decoder lands.
    // Not found, it is a named card, exactly as before.
    if (type === 'image' && !size.decodable) {
      const preview = await embeddedPreview(file).catch(() => null);
      const shot = preview && await measureSize('image', preview);
      if (preview && shot?.decodable) {
        previewFile = preview;
        previewHash = await addFile(preview);
        size = shot;
      } else {
        type = 'generic';
        size = defaultSize('generic');
        stats.undecodable++;
      }
    }
  }
  const hash = await addFile(file);
  // Every clip gets a still pulled out of it, because a video card has nothing
  // to show until it is played - on a phone, where the source is held back
  // entirely, that is a black rectangle. See posterFor() below.
  const poster = type === 'video' ? await posterFor(file, size.decodable) : null;
  // The frame knows the shape of the clip, which is the one thing a failed
  // measurement could not find out. Without this an upright phone video would
  // sit on the board as a landscape box with an upright picture letterboxed
  // inside it. Only when the measurement failed: a clip the browser opened has
  // already been measured from the file itself, and the frame would only
  // recompute the identical box.
  if (poster && !size.measured && poster.w && poster.h) {
    size = { ...size, ...fitToBox('video', poster.w, poster.h), measured: true };
  }
  // An audio file usually carries its own picture, and the card has a slot for
  // one already - see setItemCover() in state.js. Registered as an ordinary
  // asset, so an album's twelve tracks embedding the identical cover cost one
  // copy of it. Tried before the item exists rather than after it mounts, so
  // the card is never briefly the plain one; null is the common answer and
  // costs a single 16-byte read.
  const cover = type === 'audio' && mayHaveArt(file.name)
    ? await coverArt(file).then(art => art && addFile(art)).catch(() => null)
    : null;
  // The hundred-pixel copy the board shows once it is zoomed out past the
  // detail rung - see makeThumb() for why a hundred, and canvas/stills.js for
  // the swap, which this reuses wholesale rather than inventing a second one.
  //
  // Here, at import, rather than lazily on the first far-out view: it is one
  // decode of bytes that are already in hand and already decoded once for the
  // measurement above, and doing it later means doing it for a whole board at
  // the exact moment somebody has just asked to see the whole board.
  //
  // Its own asset, deduplicated by content like everything else, so the same
  // photograph dropped twice has one thumbnail. Failure is silent and total:
  // no thumbnail simply means the card keeps drawing its full-size picture,
  // which is what it did before any of this existed.
  // From the preview when there is one: the original is undecodable, so a
  // thumbnail of it could never be made, and the preview is what the card draws
  // anyway.
  //
  // And from the poster for a clip, which was the gap. The rule was "images get
  // thumbnails" and everything else drew its full-size picture at every zoom -
  // so a board of video, which is the heaviest thing a board can hold, was the
  // one board that never got the cheap copy. A poster is a picture like any
  // other by the time it is here; the only reason it was not thumbed is that the
  // condition was written before posters existed.
  const thumbSource = type === 'image' ? (previewFile || file)
    : type === 'video' ? poster?.file || null
    : null;
  // The width is handed over so the decoder can be asked for a hundred-wide
  // bitmap rather than the whole picture - see makeThumb(). It is only ever a
  // hint: measurement can fail, and a preview or a poster is a different file
  // from the one `size` describes, so those pass nothing and take the old path.
  const thumbWidth = type === 'image' && !previewFile ? size.natural?.w || 0 : 0;
  const thumb = thumbSource ? await thumbFor(thumbSource, thumbWidth).catch(() => null) : null;
  return {
    type,
    name: file.name,
    // Placeholders: the arrangement fills both before this draft is handed to
    // addItems(), and an absent coordinate reads as the same zero anyway.
    x: 0,
    y: 0,
    w: size.w,
    h: size.h,
    asset: { hash, embedded: true },
    meta: {
      // One slot, two sources. An audio card wears the picture out of its own
      // tags; a video that cannot be played wears a frame out of itself. Both
      // are "the picture this item shows", and the renderers already know what
      // to do with one - a card draws it in the corner, a video makes it the
      // poster.
      ...(cover ? { cover } : poster?.hash ? { cover: poster.hash } : {}),
      ...(thumb ? { thumb: thumb.hash } : {}),
      // A guess, and only a guess: a picture whose outer ring is mostly
      // transparent is a shape rather than a photograph, so it lands with no
      // card round it. The menu row ("No card") is what makes it a default
      // rather than a verdict - whatever is chosen there wins and is what gets
      // saved. Only for an image that is its own thumbnail source: a preview
      // pulled out of a HEIC or a frame grabbed from a clip is a different
      // picture from the one being imported, and neither is ever a cut-out.
      ...(type === 'image' && !previewFile && thumb?.cutout ? { bare: true } : {}),
      // The decodable stand-in for a picture the browser won't draw. asset.hash
      // above is still the untouched original; the image renderer draws this
      // when it is present. Preserved and packed like any other content id - see
      // META_HASHES in board-model.js and itemHashes() in util.js.
      ...(previewHash ? { preview: previewHash } : {}),
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
export const NOTE_TINTS = 4;

/**
 * A text card with no source file - the one item type born on the board.
 *
 * `want` is a sheet asked for by number, 1..NOTE_TINTS, and it arrives from one
 * place: the Note button's hover flyout, which draws the pad and lets you take
 * a colour off it. Anything else - every drop, every paste, every plain press
 * of the button - passes nothing and gets the cycle, which is the behaviour
 * this had before there was any way to choose.
 */
export function addNote(centre: Point, text = '', want = 0) {
  text = text.slice(0, NOTE_MAX);
  const size = defaultSize('note');
  // Cycled rather than random, so a run of notes comes off the pad in order
  // and you never get three of the same colour in a row. Stored on the item,
  // so a note keeps its colour across a save.
  //
  // A number out of range is treated as no answer rather than clamped: the
  // tints are a set of four sheets, not a scale, so there is no nearest one to
  // round a 9 to, and falling back to the cycle is the only reading that leaves
  // the board with a colour it actually has.
  const asked = Number.isInteger(want) && want >= 1 && want <= NOTE_TINTS ? want : 0;
  const tint = asked
    || board.items.filter(i => i.type === 'note').length % NOTE_TINTS + 1;
  const [item] = addItems([{
    type: 'note',
    name: text ? text.split('\n')[0].slice(0, 40) : 'Note',
    x: centre.x, y: centre.y, w: size.w, h: size.h,
    meta: { text, tint },
  }], 'Add note');
  // A note written onto a card is a note that has just been let go, so it gets
  // the same ten seconds a dropped one does before it sets - see the settling
  // block in sticky.js. Without this a note added over a photograph would be
  // pinned from the first keystroke, and the editor you are typing into would
  // be attached to something you could no longer move.
  startSettling([item.id]);
  select([item.id]);
  return item;
}

/**
 * How far off square a sticker lands, in degrees either way.
 *
 * Small. This is the difference between a sticker and a diagram element, and
 * eight degrees is about as far as a thumb pressing something down actually
 * takes it - past that it stops reading as hand-placed and starts reading as
 * broken.
 */
const STICKER_TILT = 8;

/**
 * A shape pressed onto the board. The third item type with no file behind it.
 *
 * **The tilt is re-rolled here rather than kept**, which is the one decision in
 * this function. A sticker gets a fresh angle every time it lands somewhere,
 * because that is what peeling one off and pressing it down again looks like -
 * and it has to happen on the *drop* rather than per frame, or the shape would
 * shimmer while you dragged it. Undo gets it for free: `rot` goes into the same
 * geometry snapshot as x and y (GEOM_KEYS in layout.js), so stepping back puts
 * the old angle back along with the old position.
 *
 * The one part of that worth revisiting once it is in the hand: a sticker you
 * have deliberately turned to 45 degrees is re-rolled too if you move it to
 * another card. The fix, if it grates, is to re-roll only while `rot` is still
 * the angle it was born with - cheap, but it means remembering that angle.
 *
 * The colour comes off the catalogue rather than out of a cycle, unlike
 * addNote's pad above. A sticker comes out of the window looking the way it
 * looked *in* the window - the heart red, the star gold - so the tint belongs
 * to the shape and the palette is an override rather than a lottery.
 */
export function addSticker(shape: string, centre: Point, tint?: string) {
  // Non-null on the fallback: DEFAULT_SHAPE is the first catalogue entry's own
  // id, which is what makes it the default - it always resolves.
  const entry = stickerShape(shape) || stickerShape(DEFAULT_SHAPE)!;
  const size = defaultSize('sticker');
  const [item] = addItems([{
    type: 'sticker',
    // What the trash, Find and the accessible name show. There is nothing else
    // it could be called: a sticker has no filename and no text of its own.
    name: entry.name,
    x: centre.x, y: centre.y, w: size.w, h: size.h,
    rot: (Math.random() * 2 - 1) * STICKER_TILT,
    meta: { shape: entry.id, tint: stickerTint(tint, entry.id) },
  }], 'Add sticker');
  // Just pressed down, so it lies where it landed for ten seconds before it
  // sets - the same window a drag gives, and the one that lets you nudge a
  // star you placed a hair off centre. See addNote above and sticky.js.
  startSettling([item.id]);
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
/**
 * The page an embed URL is the embed of, when a provider recognises it.
 *
 * Falls through to the URL itself for everything else, including a provider URL
 * that is already a page - so callers can hand it anything.
 */
function embedPage(url: URL) {
  const spec = embedFor(url);
  if (!spec) return url;
  try { return new URL(spec.page); } catch { return url; }
}

/**
 * A colour with nothing behind it. The third item type born on the board.
 *
 * Here rather than anywhere else because this file is where the two other
 * fileless types are minted, and "getting things onto the board" is what it is
 * for - the drag-and-drop half at the top is one of the doors, not the subject.
 *
 * The hex is the name as well as the content, for the reason setSwatchHex()
 * gives: a swatch has no other name it could have, and this is what makes one
 * findable and what a copy of one says on the system clipboard.
 */
export function addSwatch(centre: Point, hex: string = SWATCH_DEFAULT) {
  const value = swatchHex(hex);
  const size = defaultSize('swatch');
  const [item] = addItems([{
    type: 'swatch',
    name: value.toUpperCase(),
    x: centre.x, y: centre.y, w: size.w, h: size.h,
    meta: { hex: value },
  }], 'Add swatch');
  select([item.id]);
  return item;
}

/**
 * The board's own look, as a card on it. The fourth fileless type.
 *
 * Beside the swatch for the same reason the swatch is here: this file is where
 * the types born on the board are minted, and a style tile has no file behind
 * it either.
 *
 * The pictures are chosen *now* and written down - see the style-tile renderer
 * for why the card records them rather than re-picking on every draw. The
 * palette and the faces are deliberately not written down: those follow the
 * board, and a tile that froze them would be a photograph of the look rather
 * than a reading of it.
 *
 * The name is what the trash and Find have to show, and it is fixed rather than
 * dated - two tiles on one board are told apart by what is drawn on them, and a
 * timestamp in the name would be the one part of the card that could disagree
 * with the rest of it after a palette change.
 */
export function addStyleTile(centre: Point, selected: Set<string> | null = null) {
  const size = defaultSize('style-tile');
  const [item] = addItems([{
    type: 'style-tile',
    name: 'Style tile',
    x: centre.x, y: centre.y, w: size.w, h: size.h,
    meta: { shots: tilePictures(selected).map(it => it.id) },
  }], 'Add style tile');
  select([item.id]);
  return item;
}

export function addLink(centre: Point, url: URL) {
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
function addLinks(at: Point, urls: URL[]) {
  if (!urls.length) return [];
  const drafts = urls.map((url: URL, i: number) => ({
    ...linkDraft(url),
    x: at.x + i * LINK_STEP.x,
    y: at.y + i * LINK_STEP.y,
  }));
  const made = addItems(
    drafts,
    drafts.length > 1 ? `Add ${drafts.length} links` : 'Add link',
    { avoidOverlap: board.layoutMode === 'mobile' },
  );
  select(made.map((i: Item) => i.id));
  return made;
}

/** Enough that each card's corner and title clear the one beneath it. */
const LINK_STEP = { x: 26, y: -26 };

// --- drag payload helpers --------------------------------------------------

function hasFiles(dt: DataTransfer | null): dt is DataTransfer {
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
function hasLink(dt: DataTransfer | null): dt is DataTransfer {
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
function urlsFrom(dt: DataTransfer) {
  const raw = (dt.getData('text/uri-list') || dt.getData('text/plain') || '');
  return raw.split(/[\r\n]+/)
    .filter(line => line && !line.startsWith('#'))
    .map(linkURL)
    .filter((url): url is URL => !!url);
}

/**
 * Files out of a DataTransfer, walking into dropped folders when the browser
 * exposes the entries API. Falls back to the flat file list elsewhere.
 *
 * Returns `{ files, fromFolder, truncated }`. Exported for the sake of the last
 * of those: the cap is applied here and reported here, and a test that had to go
 * through the whole import to see it would be testing the toast.
 */
export async function filesFrom(dt: DataTransfer) {
  const items = [...(dt.items || [])];
  // Captured up front: DataTransfer.files is only reliably populated during the
  // synchronous part of the drop event, and the entries walk below awaits. A
  // fallback reading dt.files after those awaits would usually find it emptied,
  // so the "walk yielded nothing" safety net could recover nothing.
  const flat = [...dt.files];
  const canWalk = items.length && typeof items[0].webkitGetAsEntry === 'function';
  if (!canWalk) {
    return { files: flat, fromFolder: flat.some(file => !!file.webkitRelativePath), truncated: false };
  }

  const entries = items.map(i => i.webkitGetAsEntry())
    .filter((entry): entry is FileSystemEntry => !!entry);
  const fromFolder = entries.some(entry => entry.isDirectory);
  const out: File[] = [];
  for (const entry of entries) {
    await walkEntry(entry, out);
    if (out.length >= MAX_FILES) break;
  }
  // Reported rather than left to be inferred. The walk stops *at* MAX_FILES, so
  // importFiles()'s `files.length > MAX_FILES` was unreachable from a drop and a
  // folder of a thousand photographs brought in five hundred while saying it had
  // brought in everything. Inferring it there with >= would be one character and
  // wrong for the picker, where five hundred chosen files really are five hundred
  // files and nothing was cut.
  return { files: out.length ? out : flat, fromFolder, truncated: out.length >= MAX_FILES };
}

async function walkEntry(entry: FileSystemEntry, out: File[]) {
  if (out.length >= MAX_FILES) return;
  if (isFileEntry(entry)) {
    const file = await new Promise<File | null>(res => entry.file(res, () => res(null)));
    if (file) out.push(file);
    return;
  }
  if (!isDirEntry(entry)) return;
  const reader = entry.createReader();
  // readEntries returns at most ~100 per call and must be drained in a loop.
  for (;;) {
    const batch = await new Promise<FileSystemEntry[]>(res => reader.readEntries(res, () => res([])));
    if (!batch.length) break;
    for (const child of batch) await walkEntry(child, out);
    if (out.length >= MAX_FILES) break;
  }
}
