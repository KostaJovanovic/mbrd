// Getting things onto the board: drop, paste, picker, .mbrd open.
// All paths funnel into importFiles() — hash, classify, arrange, add.

import { extOf } from '../util.ts';
import { platform } from '../platform/platform.ts';
import { toast, busy } from '../notify.ts';
import { cue } from '../cuelume/engine.ts';
import {
  board, bus, addItems, replaceItem, select, setItemCover, NOTE_MAX, baseStep, startSettling,
  timelinePlaying, retypeItem,
} from '../state.ts';
import { cleanPath } from './archive.ts';
import { addFile, derivedFile } from '../storage/assets.ts';
import { makeByteBudget, overPixelBudget, pixelCrossing, IMPORT_LIMITS } from './budget.ts';
import { allow, isAllowed, isOversize, lift, fileKey, mb as consentMb } from '../consent.ts';
import {
  classify, defaultSize, measureSize, fitToBox, linkURL, linkDraft, videoFrame,
  videoDrawsBlank, pictureIsFlat, swatchHex, SWATCH_DEFAULT,
} from '../canvas/renderers.ts';
import { iframeURL, embedFor } from '../canvas/embed.ts';
import { arrange, mobileOrder } from '../arrange/arrangements.ts';
import { coverArt, mayHaveArt } from './artwork.ts';
import { mediaFacts } from './containers.ts';
import { embeddedPreview, NOT_PORTABLE, PORTABLE_MIN_EDGE } from './preview.ts';
import { heifPicture } from './heif.ts';
import { HEIC_EXTS, RAW_EXTS } from './formats.ts';
// Statically, unlike import/pdf.ts below it: this one reaches storage/zip.ts and
// nothing else, and the zip reader is already in memory - it is what opens every
// .mbrd. There is no dependency to defer and so no reason to defer it.
import { hasBakedPreview, bakedPreview } from './document.ts';
import { isDeck, slideOneRaster } from './slide.ts';
import { isWordDoc, pageOneRaster } from './page-one.ts';
import { isTiffFile, tiffRaster } from './tiff.ts';
import { makeThumb, shrinkPicture, DISPLAY_SIDE } from '../optimize/picture.ts';
import { looksLikeMbrd } from '../storage/mbrd.ts';
import { openOrMergeFile } from '../storage/storage.ts';
import { stickerShape, stickerTint, DEFAULT_SHAPE } from '../stickers/catalogue.ts';
import { tilePictures } from '../style-tile.ts';
import { NOTE_TINTS } from '../canvas/note-model.ts';
import type { Point } from '../arrange/arrangements.ts';
import type { Size } from '../canvas/renderers.ts';
import type { Item, ItemMeta } from '../board-model.ts';
import { noteNameOf } from '../board-model.ts';

/** Pre-layout item draft. x/y are placeholders until the arrangement fills them. */
export type Draft = {
  type: string;
  name: string;
  x: number;
  y: number;
  w: number;
  h: number;
  // Absent on a link, which points at an address rather than carrying bytes -
  // the same shape linkDraft() makes for a pasted URL.
  asset?: { hash: string, embedded: boolean };
  meta: ItemMeta;
};

/** One file under a folder dropped from the disk, by its path below that folder. */
type DiskFile = { path: string, file: File };

/** A folder inside a dropped folder: it lands as one folder card holding every file under it. */
export type DiskFolder = { name: string, entries: DiskFile[] };

/** What importFiles() takes: files, cards already made (a folder out of an archive), and disk folders. */
export type Incoming = File | Draft | DiskFolder;

const isFile = (x: Incoming): x is File => x instanceof File;

/** How Unzip and Open land what a card held (import/unpack.ts): as one undo step with its leaving. */
type Replace = { id: string, label: string, verb: string };

/** Wider than MeasuredSize: absent `decodable` is the falsy default the reads below rely on. */
type DraftSize = Size & { decodable?: boolean, measured?: boolean, natural?: Size };

/** Narrow FileSystemEntry to its subtypes (where file()/createReader() live). */
const isFileEntry = (e: FileSystemEntry): e is FileSystemFileEntry => e.isFile;
const isDirEntry = (e: FileSystemEntry): e is FileSystemDirectoryEntry => e.isDirectory;

/** Extensions a browser can turn into a FontFace. Here (not ui/fonts.ts) to avoid a layer edge. */
const FONT_EXTS = new Set(['woff2', 'woff', 'ttf', 'otf']);

/** Internet-shortcut files: Windows .url (INI text), macOS .webloc (plist). */
const SHORTCUT_EXTS = new Set(['url', 'webloc']);

/**
 * The address inside an internet-shortcut file, or null.
 *
 * A Windows .url is INI text with a `URL=` line under [InternetShortcut]; a
 * macOS .webloc is a plist whose one useful value is a `<string>` under the key
 * URL. Both are read as text and pattern-matched - no parser, since a shortcut
 * holds nothing else - and the address goes through linkURL(), so it is held to
 * the same standard as a pasted one. A binary .webloc or any file that names
 * nothing openable returns null, and the caller falls back to a named card.
 */
async function shortcutURL(file: File): Promise<URL | null> {
  const text = await file.text().catch(() => '');
  if (!text) return null;
  const url = text.match(/^\s*URL\s*=\s*(\S.*?)\s*$/im)?.[1]
    ?? text.match(/<key>\s*URL\s*<\/key>\s*<string>([\s\S]*?)<\/string>/i)?.[1]
    ?? text.match(/<string>\s*(https?:\/\/[\s\S]*?)\s*<\/string>/i)?.[1];
  return url ? linkURL(url) : null;
}

/** Guard against someone dropping a whole photo library by accident. */
export const MAX_FILES = 500;

/**
 * Injected confirmation prompt for large imports. Layering seam like
 * setOverlays() — ui/ sits above import/. Unwired it allows everything:
 * unlike storage's setPrompt(), the unanswered question here is a courtesy,
 * not a destructive-action guard.
 */
export type ImportPrompt =
  (opts: { title: string, body: string, go: string, cancel?: string }) => Promise<string>;

let confirmImport: ImportPrompt | null = null;
export function setImportPrompt(fn: ImportPrompt | null | undefined) {
  confirmImport = typeof fn === 'function' ? fn : null;
}

/** Whole megabytes, for a sentence. Nothing here needs the decimal. */
const mb = (bytes: number) => Math.round(bytes / 1024 ** 2) + ' MB';

/**
 * Run a reader; if it throws Oversize, ask and retry with the ceiling lifted.
 * Fails soft: null means the card stays what it was without the picture.
 * Keyed by file, so one document is one question however many ceilings it hits.
 */
async function asking<T>(file: File, read: (lift: boolean) => Promise<T | null>): Promise<T | null> {
  try {
    return await read(false);
  } catch (err) {
    if (!await lift(err, fileKey(file), `${file.name} - ${consentMb(file.size || 0)}`)) return null;
    return await read(true).catch(() => null);
  }
}

/** The shared hidden file input. Three entry points take turns via `dataset.mode`. */
// SAFETY: #file-input is an <input type="file"> in index.html.
const fileInput = () => document.getElementById('file-input') as HTMLInputElement;

/** Concurrency for prepareFile(). Low: each holds a whole file in memory while hashing/measuring. */
const IMPORT_WORKERS = 6;

/** Minimal viewport surface — screen-to-world and view centre. Narrow to stay loadable without a browser. */
export interface DropViewport {
  toWorld(x: number, y: number): Point;
  cursor?: Point | null;
  left: number;
  top: number;
  cx: number;
  cy: number;
}

export function initDrop(vp: DropViewport) {
  // Both ids declared in index.html — absent = broken build.
  const overlay = document.getElementById('drop-overlay')!;
  let depth = 0;                       // dragenter/dragleave fire per child element
  let lastPoint: Point | null = null;

  // The overlay also hides when dragover stops arriving. dragover fires every
  // few hundred ms while a drag is over the window, and a drag that leaves it
  // without a matching dragleave (GTK does this) otherwise left the overlay up
  // for good, since the depth count never came back to zero.
  const DRAG_IDLE_MS = 600;
  let idle = 0;
  const show = () => { overlay.hidden = false; };
  const hide = () => { depth = 0; clearTimeout(idle); overlay.hidden = true; };
  const stillDragging = () => { clearTimeout(idle); idle = window.setTimeout(hide, DRAG_IDLE_MS); };

  // Type-guard predicate: narrows dt so handlers can read the payload they accepted.
  const takes = (dt: DataTransfer | null): dt is DataTransfer => hasFiles(dt) || hasLink(dt);

  addEventListener('dragenter', e => {
    if (!takes(e.dataTransfer)) return;
    e.preventDefault();
    // No overlay while the Timeline plays: nothing lands on the board then.
    if (timelinePlaying()) return;
    depth++;
    show();
    stillDragging();
  });

  addEventListener('dragover', e => {
    if (!takes(e.dataTransfer)) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = timelinePlaying() ? 'none' : 'copy';
    lastPoint = { x: e.clientX, y: e.clientY };
    stillDragging();
  });

  // A drag that ends anywhere, dropped or cancelled, takes the overlay with it.
  addEventListener('dragend', hide);

  addEventListener('dragleave', e => {
    if (!takes(e.dataTransfer)) return;
    if (--depth <= 0) hide();
  });

  addEventListener('drop', async e => {
    if (!takes(e.dataTransfer)) return;
    e.preventDefault();
    hide();
    // Still prevented above, or the browser would open the file in the tab.
    if (timelinePlaying()) { bus.emit('readonly'); return; }
    const pt = lastPoint || { x: e.clientX, y: e.clientY };
    const at = vp.toWorld(pt.x, pt.y);
    // Files first: a drag can carry both files and a URL; files are the intent.
    if (hasFiles(e.dataTransfer)) {
      // The overlay is already down and importFiles() has not started, so a
      // folder walk of any size happens on a screen showing nothing at all.
      const walk = busy('Reading the drop');
      const incoming = await filesFrom(e.dataTransfer).finally(() => walk.end());
      await importFiles([...incoming.files, ...incoming.folders], at, {
        avoidOverlap: incoming.fromFolder,
        truncated: incoming.truncated,
      });
      return;
    }
    const urls = urlsFrom(e.dataTransfer);
    // Overlay already accepted (drag contents unreadable until drop), so toast on empty.
    if (!urls.length) { toast('That link is not one this can open'); return; }
    addLinks(at, urls);
  });

  addEventListener('paste', async e => {
    const target = e.target;
    if (target instanceof HTMLElement && (target.isContentEditable || /INPUT|TEXTAREA/.test(target.tagName))) return;
    // Under cursor if known, otherwise centre of view (touch device or no prior pointer).
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
      // Strict: linkURL() only accepts a bare URL, not a paragraph mentioning one.
      const url = linkURL(text);
      if (url) { addLink(centre, url); return; }
      // Pasted <iframe> embed block (YouTube/Spotify share markup). Canonicalised
      // to its page URL here — an embed address is plumbing, unlike a typed URL
      // which is left as-is.
      const framed = iframeURL(text, linkURL);
      if (framed) addLink(centre, embedPage(framed));
      else await importFiles([pastedFile(text)], centre);
    }
  });

  // Shared hidden input — Add files, picker fallback, and cover picker.
  const input = fileInput();
  input.addEventListener('change', async () => {
    const mode = input.dataset.mode;
    // Not ours — storage.ts uses the same input for .mbrd opens.
    if (mode !== 'content' && mode !== 'cover') return;
    const files = [...(input.files || [])];
    input.value = '';
    delete input.dataset.mode;
    // Reset so the next "Add files" is not still filtered to images.
    input.accept = '';
    input.multiple = true;
    if (mode === 'cover') {
      const id = coverFor;
      coverFor = null;
      // coverFor is set by pickCover() at the same moment as mode.
      if (id && files[0]) await applyCover(id, files[0]);
      return;
    }
    if (files.length) await importFiles(files, vp.toWorld(vp.left + vp.cx, vp.top + vp.cy));
  });
}

/**
 * Pasted text as an .md file. Lands as a document (hashed, archived, viewable),
 * not a sticky note — pasted text is something brought, not something written.
 * Always .md: markdown is plain text, and the extension only decides rendering
 * when markers are present.
 */
function pastedFile(text: string): File {
  // Normalise CRLF on the way in, same as renderMarkdown().
  const body = text.replace(/\r\n?/g, '\n').trim();
  return new File([body], `${pastedName(body)}.md`, { type: 'text/markdown' });
}

/** How much of the first line a pasted document is named after. */
const PASTE_NAME_MAX = 48;

/**
 * First non-fence, non-rule line as a filename-safe title. Strips markdown
 * markers and filesystem-hostile characters. Becomes the zip entry name on save.
 */
function pastedName(text: string): string {
  for (const line of text.split('\n')) {
    if (PASTE_NAME_SKIP.test(line)) continue;
    const title = line
      .replace(/^ {0,3}(#{1,6} +|> ?|[-*+] +|\d{1,9}[.)] +)/, '')
      .replace(/[\p{Cc}/\\:*?"<>|]/gu, ' ')
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, PASTE_NAME_MAX)
      .trim();
    if (title) return title;
  }
  // All punctuation or empty — caller already refused empty pastes.
  return 'Pasted text';
}

/** A fence or a thematic break: a line of Markdown with no words in it. */
const PASTE_NAME_SKIP = /^ {0,3}(```|~~~|((\*\s*){3,}|(-\s*){3,}|(_\s*){3,})$)/;

/**
 * A note written past NOTE_SHEET_MAX, replaced in place by the .md document
 * pasted text would have made - one undo step back to the note. Wired into
 * canvas/notes.ts by main.ts (setNoteOverflow). The document's own x/y are
 * dropped so it lands where the note was.
 */
export async function noteToFile(id: string, markdown: string): Promise<boolean> {
  try {
    const { x: _x, y: _y, ...draft } = await prepareFile(pastedFile(markdown));
    // The note may have been deleted while the file was hashed.
    if (!retypeItem(id, draft, 'Turn note into file')) return false;
    toast(`Too long for a sticky - saved as ${draft.name}`);
    return true;
  } catch (err) {
    console.error('[mbrd] note to file failed', err);
    toast('Could not save the note as a file', 'error');
    return false;
  }
}

/** Open OS file picker for content. Attributes set explicitly: a cancelled picker fires no change. */
export function pickFiles() {
  const input = fileInput();
  input.accept = '';
  input.multiple = true;
  input.dataset.mode = 'content';
  // Also clear coverFor: a cancelled cover picker left it armed, causing the
  // next Add files to route its first file as a cover.
  coverFor = null;
  input.click();
}

/** Item awaiting a cover picture. Cleared on read and in pickFiles() (cancelled pickers fire no change). */
let coverFor: string | null = null;

/** Choose a picture for one card. See setItemCover() in state.ts. */
export function pickCover(id: string) {
  const input = fileInput();
  input.accept = 'image/*';
  input.multiple = false;
  input.dataset.mode = 'cover';
  coverFor = id;
  input.click();
}

/** Attach a chosen picture. Checks decodability — accept="image/*" lets through HEIC/RAW. */
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
  incoming: Incoming[],
  centre: Point,
  { avoidOverlap = false, truncated = false, replace = null }:
    { avoidOverlap?: boolean, truncated?: boolean, replace?: Replace | null } = {},
) {
  let files = incoming.filter(f => f && (!isFile(f) || f.size > 0 || f.type));
  if (!files.length) return [];

  // A .mbrd is a board, not content. openOrMergeFile() asks "open or merge?"
  // when the current board is non-empty. Not out of an archive: Unzip asked
  // for what is inside to land on this board, not for a board to open.
  const sole = files.length === 1 ? files[0] : null;
  if (!replace && sole && isFile(sole) && looksLikeMbrd(sole)) {
    await openOrMergeFile(sole);
    return [];
  }

  // Fonts are board settings, not content. Announced via bus — ui/fonts.ts handles registration.
  const isFont = (f: Incoming): f is File => isFile(f) && FONT_EXTS.has(extOf(f.name));
  const fonts = files.filter(isFont);
  if (fonts.length) {
    bus.emit('fonts:add', fonts);
    files = files.filter(f => !isFont(f));
    if (!files.length) return [];
  }

  // One warning for the whole drop if anything is over warnBytes.
  // After .mbrd and font extraction — those are not imported as content.
  const big = files.filter((f): f is File => isFile(f) && (f.size || 0) > IMPORT_LIMITS.warnBytes);
  // Declined by the user rather than refused by the app. Counted from here
  // because the large-file answer below is the first thing that can skip one.
  let overBudget = 0;
  if (big.length && confirmImport) {
    const rest = files.length - big.length;
    const answer = await confirmImport({
      title: big.length === 1 ? 'Large file' : 'Large files',
      // Name+size for one file, count for several. When there is something else
      // in the drop, say what declining leaves behind — the button skips rather
      // than cancels, and that is not what a Cancel usually means.
      body: (big.length === 1
        ? `${big[0].name} is ${mb(big[0].size)}.`
        : `${big.length} files are over ${mb(IMPORT_LIMITS.warnBytes)}.`)
        + (rest ? ` The other ${rest === 1 ? 'file comes' : rest + ' come'} in either way.` : ''),
      go: 'Import',
      cancel: big.length === 1 ? 'Skip it' : 'Skip them',
    });
    // Declining skips the large files, not the drop: one heavy file in a folder
    // of two hundred must not throw the other hundred and ninety-nine away.
    // Calling off the whole import is the Cancel on the busy strip below.
    if (answer !== 'go') {
      const skip = new Set<Incoming>(big);
      files = files.filter(f => !skip.has(f));
      overBudget += big.length;
    }
  }

  // filesFrom() already capped at MAX_FILES; `truncated` reports whether it did.
  // The user can override and take all of them.
  let trimmed = truncated || files.length > MAX_FILES;
  if (trimmed) {
    const wanted = files.length;
    const keepAll = await allow(
      `count:${wanted}`,
      `${wanted > MAX_FILES ? wanted : 'More than ' + MAX_FILES} files at once.`,
      [{
        ceiling: 'file-count',
        what: `This is ${wanted > MAX_FILES ? wanted : 'more than ' + MAX_FILES} files, past the `
          + `${MAX_FILES} taken at once. Declining brings in the first ${MAX_FILES}.`,
      }],
      'Take all of them',
    );
    if (!keepAll && files.length > MAX_FILES) files = files.slice(0, MAX_FILES);
    if (keepAll) trimmed = false;
  }

  // Byte budget: the memory boundary (the 500-file cap is UX only). Sequential —
  // budget questions must be answered one at a time. See import/budget.ts.
  const budget = makeByteBudget();
  const keep: Incoming[] = [];
  // Cancel button on the busy strip: during the scan it takes the whole import,
  // during the read it stops starting new files and keeps what finished.
  const control = new AbortController();
  let cancelled = false;
  // The strip goes up here rather than at the read below. pixelCrossing() reads
  // 128 KB off each file in turn, so a phone handed a folder of two hundred
  // spends seconds in this loop with nothing on screen, and a screen that does
  // nothing reads as a press that did nothing. Relabelled for the read, not
  // replaced — one strip, one cancel, no gap between the two halves.
  const job = busy(files.length > 1 ? `Checking ${files.length} files` : 'Checking',
    files.length > 1 ? { onCancel: () => { cancelled = true; control.abort(); } } : {});
  let scanned = 0;
  for (const f of files) {
    // Nothing has landed yet, so cancelling here means none of it.
    if (control.signal.aborted) { keep.length = 0; break; }
    job.step(++scanned, files.length);
    // A card already made, or a folder whose files are filed one at a time.
    if (!isFile(f)) { keep.push(f); continue; }
    const reasons = budget.check(f.size || 0);
    // Decode-bomb check from header dimensions, folded into the same question.
    const px = await pixelCrossing(f).catch(() => null);
    if (px) reasons.push(px);
    if (!reasons.length || await allow(fileKey(f), `${f.name} - ${consentMb(f.size || 0)}`, reasons)) {
      budget.charge(f.size || 0);
      keep.push(f);
    } else {
      overBudget++;
    }
  }
  files = keep;
  if (!files.length) {
    job.end();
    budget.release();
    if (cancelled) { toast('Import stopped'); return []; }
    // Not an error — every file was described and the user declined.
    toast(overBudget ? 'Nothing imported' : 'Those files are too large to import', overBudget ? '' : 'error');
    return [];
  }
  // Same strip, second half. step() resets the count so the scan's full bar
  // does not stand there looking finished until the first file is read.
  job.label(files.length > 1 ? `Reading ${files.length} files` : 'Reading');
  job.step(0, files.length);

  // Bounded work pool (IMPORT_WORKERS at a time). Results land by index
  // so the arrangement sees file order, not completion order.
  const prepared: (Draft | null)[] = new Array(files.length).fill(null);
  const failed: string[] = [];
  // Undecodable photos that fell back to named cards — counted for one final toast.
  const stats = { undecodable: 0 };
  let firstError: unknown = null;
  let next = 0;
  // How many started (not finished) — workers finish out of order.
  let settled = 0;
  const worker = async () => {
    for (;;) {
      if (control.signal.aborted) return;
      const i = next++;
      if (i >= files.length) return;
      const file = files[i];
      try {
        prepared[i] = await prepareOne(file, stats);
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
    job.end();
    // Release the byte budget so overlapping imports do not double-count.
    budget.release();
  }
  const drafts = prepared.filter((d): d is Draft => !!d);

  if (cancelled && !drafts.length) {
    toast('Import stopped');
    return [];
  }
  if (!drafts.length) {
    // Show the reason when every file failed the same way (e.g. crypto.subtle
    // missing on plain HTTP).
    const why = String((firstError instanceof Error && firstError.message) || '').slice(0, 80);
    toast(why ? `Nothing could be imported - ${why}` : 'Nothing could be imported', 'error');
    return [];
  }

  const desktop = board.layoutMode !== 'mobile';
  // Unzip keeps the archive's own order on both surfaces.
  if (!desktop && !replace) {
    // Mobile: only reorder, no 2D layout.
    // SAFETY: every ORDERS entry in arrangements.ts returns the items it was handed, so each is a Draft.
    const ordered = mobileOrder(drafts, { name: board.arrangement }) as Draft[];
    drafts.length = 0;
    drafts.push(...ordered);
  }
  // "Free" preserves positions, but fresh imports have none — fall back to grid.
  // Unzip and Open spiral out from the card, from the centre in the archive's
  // own order, whatever the board is arranged by.
  const name = replace ? 'spiral' : board.arrangement === 'free' ? 'grid' : board.arrangement;
  if (desktop) {
    const spots = arrange(drafts, {
      name,
      center: centre,
      spacing: board.settings.spacing,
      // Snapped drops need whole-cell reservations to avoid overlap after rounding.
      cellStep: board.settings.snap ? baseStep() : 0,
      // Folder drops flow around existing items. Mobile does this in placeMobileItems().
      // Ghosts excluded: the hint cards leave the moment content lands, so flowing
      // around them reserves a void where they used to be. Same filter as the
      // Mobile pack's obstacles in layout.ts.
      // What lands from a card flows round everything but the card it replaces.
      obstacles: avoidOverlap || replace
        ? board.items.filter(it => it.type !== 'ghost' && it.id !== replace?.id)
          .map(it => ({ x: it.x, y: it.y, w: it.w, h: it.h }))
        : undefined,
    });
    drafts.forEach((d, i) => { d.x = spots[i].x; d.y = spots[i].y; });
  } else if (replace) {
    // The Feed reads "As placed" top to bottom and left to right, so a row at
    // the card's own spot, in the archive's order, is the card's place in the
    // column. The other orders put each card where they put any card.
    drafts.forEach((d, i) => { d.x = centre.x + i * 0.01; d.y = centre.y; });
  }

  const added = replace
    ? replaceItem(replace.id, drafts, replace.label)
    : addItems(
      drafts,
      drafts.length > 1 ? `Add ${drafts.length} items` : 'Add item',
      { avoidOverlap: avoidOverlap || board.layoutMode === 'mobile' }
    );
  select(added.map((i: Item) => i.id));

  const verb = cancelled ? 'Stopped — kept' : replace ? replace.verb : 'Added';
  let msg = `${verb} ${added.length} item${added.length === 1 ? '' : 's'}`;
  if (trimmed) msg += ` (capped at ${MAX_FILES})`;
  // "Skipped" — these were declined by the user, not refused by the app.
  if (overBudget) msg += `, ${overBudget} skipped`;
  if (failed.length) msg += `, ${failed.length} failed`;
  // Undecodable photos came in as named cards — info tone, not error.
  if (stats.undecodable && !failed.length) {
    msg += `, ${stats.undecodable} shown as cards (this browser can’t decode ${stats.undecodable === 1 ? 'it' : 'them'})`;
  }
  // One cue for the whole import, not per card.
  cue(failed.length ? 'fail' : 'done');
  toast(msg, failed.length ? 'error' : '');

  // Layering: import/ cannot touch document, so it announces and ui/ acts.
  bus.emit('imported', added);
  return added;
}

/** Register a thumbnail asset. Returns hash and cutout flag, or null. */
export async function thumbFor(blob: Blob, naturalWidth = 0) {
  const small = await makeThumb(blob, naturalWidth);
  if (!small) return null;
  const hash = await addFile(derivedFile(small.blob, 'thumb'));
  // cutout is measured while the thumbnail is decoded — avoids a second decode.
  return { hash, cutout: small.cutout };
}

/**
 * Register a baked display copy: the ~1024px WebP a card and a Feed tile mount
 * instead of the full original, carried in the .mbrd (meta.display) so every
 * device it opens on decodes nothing. Null when the original already serves -
 * a picture already inside the ceiling, a vector, or an animation shrinkPicture
 * declines - and the consumer falls back to the asset itself.
 */
export async function displayFor(blob: Blob) {
  const made = await shrinkPicture(blob, { maxSide: DISPLAY_SIDE }).catch(() => null);
  if (!made) return null;
  return { hash: await addFile(derivedFile(made.blob, 'display')) };
}

/**
 * Extract a poster frame from a clip. Every video gets one (mobile holds back
 * the source until tapped). Browser decoder first; falls through to ffmpeg
 * (dynamically imported, 30 MB) for H.265 or engines that draw blank canvases.
 * All failures return null — the card just has no poster.
 */
async function posterFor(file: File, decodable: boolean | undefined) {
  if (decodable) {
    try {
      const frame = await videoFrame(file);
      if (frame) {
        const named = derivedFile(frame.blob, 'poster');
        // The file comes back beside the hash so the caller can cut a thumbnail
        // from it without going to the asset store for bytes it just handed over.
        return { hash: await addFile(named), w: frame.w, h: frame.h, file: named };
      }
    } catch { /* fall through - a clip with no poster is what it was before */ }
    // Fall through to ffmpeg only if the *entire engine* draws blank canvases
    // (videoDrawsBlank()), not just this one clip.
    if (!videoDrawsBlank()) return null;
  }
  try {
    const { firstFrame } = await import('../optimize/media.ts');
    const frame = await firstFrame(file, msg => toast(msg));
    if (!frame) return null;
    // Reject a flat (all-black) poster for decodable clips — storing it would
    // make repair passes skip this card forever.
    if (decodable && await pictureIsFlat(frame)) return null;
    const named = new File([frame], 'poster.' + (frame.type === 'image/png' ? 'png' : 'jpg'),
                           { type: frame.type });
    // Deduplicated like any other asset.
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

/** .ai is a PDF since ~2000 (artwork tucked inside as private data). Pre-2000 EPS-based .ai falls through. */
const isPdf = (file: File) => file.type === 'application/pdf'
  || PDF_EXTS.has(extOf(file.name));

const PDF_EXTS = new Set(['pdf', 'ai']);

/** A file is read and measured, a disk folder has its files filed, and a card already made passes through. */
async function prepareOne(x: Incoming, stats: { undecodable: number }): Promise<Draft> {
  if (isFile(x)) return prepareFile(x, stats);
  if ('entries' in x) return diskFolderDraft(x);
  return x;
}

/** A folder card, before the arrangement places it. See import/unpack.ts for Open. */
export function folderDraft(name: string, meta: ItemMeta): Draft {
  return { type: 'folder', name, x: 0, y: 0, ...defaultSize('folder'), meta };
}

/**
 * A folder card for a folder inside a dropped folder. Its files are filed as
 * assets now, while the drop can still read them, and the card lists each by
 * path and content id. The leftovers an OS writes into folders are skipped,
 * as they are out of an archive (cleanPath()).
 */
async function diskFolderDraft(folder: DiskFolder): Promise<Draft> {
  const files: { path: string, hash: string, size: number }[] = [];
  for (const { path, file } of folder.entries) {
    const clean = cleanPath(path);
    if (clean) files.push({ path: clean, hash: await addFile(file), size: file.size });
  }
  return folderDraft(folder.name, { files, count: files.length });
}

/** Classify, measure, hash one file into a Draft. `stats` accumulates soft outcomes for importFiles. */
async function prepareFile(file: File, stats = { undecodable: 0 }): Promise<Draft> {
  // An internet shortcut is a pointer, not content: open it as the link it names
  // rather than a card holding the .url file. The filename is kept as the card's
  // name - a saved shortcut is titled with the page, which beats the bare host
  // linkDraft() would pick. Falls through to a normal card when nothing parses.
  if (SHORTCUT_EXTS.has(extOf(file.name))) {
    const url = await shortcutURL(file);
    if (url) {
      const draft = linkDraft(url);
      const stem = file.name.replace(/\.[^.]+$/, '').trim();
      return { ...draft, name: stem || draft.name, x: 0, y: 0 };
    }
  }
  let type = classify(file);
  let size: DraftSize | undefined;
  // Decodable stand-in from an undecodable picture (HEIC, RAW). Null otherwise.
  let previewHash: string | null = null;
  let previewFile: File | null = null;
  // PDF: render page one via pdf.js (dynamic import). Original stays asset.hash;
  // rendered page becomes meta.preview. Failure falls through to a named card.
  if (isPdf(file)) {
    const { firstPageRaster } = await import('./pdf.ts');
    const page = await firstPageRaster(file).catch(() => null);
    if (page?.blob) {
      // derivedFile() picks the right extension from the actual blob type.
      previewFile = derivedFile(page.blob, 'page');
      previewHash = await addFile(previewFile);
      type = 'image';
      size = { ...fitToBox('image', page.w, page.h), measured: true, decodable: true };
    }
  }
  // Documents with baked-in thumbnails (OOXML, ODF, Krita, PSD, etc.).
  // Gated on !size so a PDF hit above is not re-measured.
  if (!size && hasBakedPreview(file)) {
    const baked = await asking(file, l => bakedPreview(file, l));
    // Pixel-budget the baked preview too — a crafted thumbnail could be a decode
    // bomb. A prior allow on the file itself carries over.
    const bakedOk = baked && (isAllowed(fileKey(file)) || !(await overPixelBudget(baked)));
    const shot = bakedOk ? await measureSize('image', baked) : null;
    // `baked` again rather than only `shot`: without a preview there is no
    // measurement either, so the two are one condition said twice.
    if (baked && shot?.decodable) {
      previewFile = baked;
      previewHash = await addFile(baked);
      type = 'image';
      size = shot;
    }
  }
  // A deck, when the well above was dry - which for PowerPoint is nearly always.
  // docProps/thumbnail is optional, current PowerPoint does not write it unless
  // somebody turns it on, and the exporters most decks arrive from never write
  // one at all, so the cheap path answers for almost no .pptx and the family was
  // a grey card whatever was inside it. import/slide.ts composites the first
  // slide instead: the pictures at their real positions, the text at its real
  // size, the background behind both.
  //
  // Last of the three because it is the only one that renders. A deck that *did*
  // carry a thumbnail has already been handled above and never reaches this, and
  // the same `!size` gate keeps it that way.
  if (!size && isDeck(extOf(file.name))) {
    const slide = await asking(file, l => slideOneRaster(file, l));
    if (slide?.blob) {
      previewFile = derivedFile(slide.blob, 'slide');
      previewHash = await addFile(previewFile);
      type = 'image';
      size = { ...fitToBox('image', slide.w, slide.h), measured: true, decodable: true };
    }
  }
  // A Word file, for the same reason: Word bakes a thumbnail in only when "Save
  // preview picture" is on. import/page-one.ts sets page one's text and
  // pictures on a page of the document's own size.
  if (!size && isWordDoc(extOf(file.name))) {
    const page = await asking(file, l => pageOneRaster(file, l));
    if (page?.blob) {
      previewFile = derivedFile(page.blob, 'page');
      previewHash = await addFile(previewFile);
      type = 'image';
      size = { ...fitToBox('image', page.w, page.h), measured: true, decodable: true };
    }
  }
  // And a TIFF, which is the same shape of problem as all three above and the
  // one where the picture was simply out of reach: a scan or a print export is
  // a photograph in a container no engine but Safari decodes, with no embedded
  // JPEG for import/preview.ts to find and no thumbnail for import/document.ts
  // to look up. import/tiff.ts decodes it outright, in a worker, through the
  // vendored UTIF - see the head of that file for what that costs and why it is
  // carried rather than fetched.
  //
  // Unconditional rather than gated on this engine failing to draw it, which is
  // deliberate and is NOT_PORTABLE's argument in import/preview.ts: a board made
  // on the one browser that *can* draw a TIFF would otherwise travel to every
  // other browser as a grey card. The original file is untouched either way, and
  // this raster is `meta.preview` like every other stand-in.
  //
  // Through asking() like the three above it, because the ceiling it can stop at
  // is a real question - a 1200-dpi flatbed scan is honestly 400 megapixels -
  // and a no costs nothing but the picture.
  if (!size && isTiffFile(file)) {
    const raster = await asking(file, l => tiffRaster(file, l));
    const shot = raster ? await measureSize('image', raster) : null;
    if (raster && shot?.decodable) {
      previewFile = raster;
      previewHash = await addFile(raster);
      type = 'image';
      size = shot;
    }
  }
  // A decode bomb - a small file that declares enormous dimensions - is caught
  // from its header before measureSize() hands it to createImageBitmap(), which
  // would otherwise allocate gigabytes. Over budget it becomes a named card, the
  // same fallback an undecodable image gets below. See import/budget.ts.
  //
  // Not asked about here, because it already was: importFiles() puts this file's
  // declared dimensions in the one warning it shows for the file, before any of
  // the hashing. What is left for this line is to honour the answer. Without the
  // isAllowed() check the yes would be silently overruled by the branch that
  // asked for it - the picture somebody chose to decode arriving as a grey card
  // with no explanation, which is the worst of both behaviours.
  if (size) {
    // Already decided - the PDF branch above rendered a page and measured it.
  } else if (type === 'image' && !isAllowed(fileKey(file)) && await overPixelBudget(file)) {
    type = 'generic';
    size = defaultSize('generic');
  } else {
    // Measured before the layout runs, so the arrangement reserves the cell
    // the item will actually occupy (see renderers.measureSize).
    size = await measureSize(type, file);
    // A photo this browser can't decode - HEIC, JPEG XL, camera RAW - would
    // mount as a broken <img>. Before falling back to a named card, look inside
    // it for the copy the camera already made (import/preview.ts): most of these
    // formats carry a full-size or thumbnail JPEG the browser *will* draw. Found
    // and itself decodable, the card stays an image and draws that preview,
    // while asset.hash below still names the untouched original - so it costs the
    // original nothing and upgrades itself for free the day a real decoder lands.
    // Not found, it is a named card, exactly as before.
    //
    // And a second reason to look, which is not about this browser at all: a
    // format *this* engine draws and others do not. Safari decodes HEIC, so the
    // test above never fired on an iPhone and the photograph travelled into the
    // .mbrd with nothing any other engine could draw. See NOT_PORTABLE in
    // import/preview.ts, and the note there on why iOS 27 makes this urgent.
    const portable = !NOT_PORTABLE.has(extOf(file.name));
    if (type === 'image' && (!size.decodable || !portable)) {
      // The shell first, and everything below is unchanged.
      //
      // A native decoder reads the *real* picture, where the path below goes
      // looking for whatever preview the camera happened to bake in - which is
      // absent on some files and a postage stamp on others. Both produce the
      // same thing as far as this function is concerned: a decodable stand-in
      // that the card draws while `asset.hash` still names the untouched
      // original, so the .mbrd is byte-identical either way.
      //
      // Unwired, and for every format the shell does not know, this resolves
      // null and the embedded-preview path runs exactly as it always did.
      //
      // Four paths, cheapest first, and each one null for a file it is not
      // for. The two on the ends read the picture itself; the two in the
      // middle look for one somebody already made:
      //
      //   nativePreview   the shell's own decoder, where there is a shell
      //   heifPicture     the HEVC in a .heic, through WebCodecs
      //   embeddedPreview the JPEG the camera baked in, where it baked one
      //   developedRaw    the sensor, demosaiced, for a RAW that baked none
      //
      // The last two are the pair that matters for a photograph taken at
      // night: a Samsung .dng carries no preview at all, and before this ran
      // it became a grey named card - a card isRaw() then refuses, since it
      // asks for an image, so the Demosaic row was absent from exactly the
      // files that needed it.
      const preview = await nativePreview(file)
        ?? await heifPicture(file)
        ?? await asking(file, l => embeddedPreview(file, l))
        ?? await asking(file, l => developedRaw(file, l));
      // Budgeted for the same reason the baked path above now is. preview.ts
      // verifies the lead bytes are FF D8 FF and admits a JPEG up to MAX_JPEG
      // (128 MB) with no dimension check at all - so a .dng whose
      // JPEGInterchangeFormat entry points at a two-kilobyte JPEG declaring
      // 65535x65535 in its SOF0 was handed straight to createImageBitmap().
      const previewOk = preview && !(await overPixelBudget(preview));
      const shot = previewOk ? await measureSize('image', preview) : null;
      // The threshold applies to the portability case only - see
      // PORTABLE_MIN_EDGE. A picture this browser cannot draw takes whatever
      // preview it can get, because the alternative is a grey card; a picture
      // it draws perfectly well only gives way to one big enough that the card
      // looks the same afterwards.
      const bigEnough = !!shot?.natural
        && Math.max(shot.natural.w, shot.natural.h) >= PORTABLE_MIN_EDGE;
      if (preview && shot?.decodable && (!size.decodable || bigEnough)) {
        previewFile = preview;
        previewHash = await addFile(preview);
        // Only when the original had no measurement of its own. A decodable
        // HEIC was already measured from the real thing, and the card's shape
        // is the photograph's rather than its preview's.
        if (!size.decodable) size = shot;
      } else if (!size.decodable) {
        type = 'generic';
        size = defaultSize('generic');
        stats.undecodable++;
      }
    }
  }
  const original = await addFile(file);
  /**
   * A HEIC or a camera RAW, where the decode worked: the picture *is* the
   * card's file, and the file that was dropped is kept beside it under
   * meta.source.
   *
   * Every other undecodable format keeps the older shape - original at
   * asset.hash, stand-in at meta.preview - and boards written before this
   * carry that shape for HEIC and RAW too, so both are still read everywhere.
   * The difference is what the rest of the app sees. A stand-in is a thing
   * each reader has to remember to ask for, through shownHash(), and every one
   * that forgets reaches for asset.hash and gets bytes no browser will draw:
   * Edit picture mounted the .dng itself and showed nothing at all. Making the
   * decoded picture the file deletes that whole class of bug rather than
   * fixing its instances.
   *
   * Only these two because only these two are decoded here. A PSD or a JPEG XL
   * is still whatever preview.ts could find inside it, which may be a
   * thumbnail, and promoting a thumbnail to "the photograph" would be a lie.
   */
  const decodedHere = !!previewFile && !!previewHash
    && (HEIC_EXTS.has(extOf(file.name)) || RAW_EXTS.has(extOf(file.name)));
  const hash = decodedHere && previewHash ? previewHash : original;
  // What the container itself says: how long it runs, and how big its picture
  // is. Read for every clip and every track, because it costs one slice of the
  // header and answers two questions this app otherwise has to ask a decoder -
  // and for the formats no engine here will open (AVI, WMV, AC-3, an .aac's
  // true length) it is the only answer there is. See import/containers.ts.
  const facts = type === 'video' || type === 'audio'
    ? await mediaFacts(file, extOf(file.name)).catch(() => null)
    : null;
  // The shape, where the browser could not measure one. This runs *before*
  // posterFor() below, which would answer the same question by fetching thirty
  // megabytes of ffmpeg - so a .avi now lands the right shape whether or not
  // anybody agrees to that download, and a clip that gets a poster anyway is
  // measured twice to the same box.
  if (type === 'video' && !size.measured && facts?.width && facts.height) {
    size = { ...size, ...fitToBox('video', facts.width, facts.height), measured: true };
  }
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
  // one already - see setItemCover() in state.ts. Registered as an ordinary
  // asset, so an album's twelve tracks embedding the identical cover cost one
  // copy of it. Tried before the item exists rather than after it mounts, so
  // the card is never briefly the plain one; null is the common answer and
  // costs a single 16-byte read.
  const cover = type === 'audio' && mayHaveArt(file.name)
    ? await asking(file, l => coverArt(file, l)).then(art => art && addFile(art)).catch(() => null)
    : null;
  // The hundred-pixel copy the board shows once it is zoomed out past the
  // detail rung - see makeThumb() for why a hundred, and canvas/stills.ts for
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
  // The baked display copy, for photos only - a video shows its poster, which is
  // already small. From the same source the thumbnail used (the file, or the
  // preview pulled out of a HEIC/RAW), so an undecodable original still bakes one.
  const display = type === 'image' && thumbSource
    ? await displayFor(thumbSource).catch(() => null) : null;
  // The four optional keys of the meta, decided before the literal below.
  //
  // Each has to be *absent* rather than present-and-undefined: itemHashes() in
  // util.ts walks meta looking for content ids, the note and image renderers
  // test `'preview' in meta`, and a key holding undefined would put an empty
  // slot into an archive path. They are written by assignment for that reason.
  const meta: ItemMeta = {
    // What the card's own file is, which for a decoded HEIC or RAW is the
    // WebP rather than the thing that was dropped. origName below still says
    // what that was, and meta.source below still holds its bytes.
    mime: decodedHere ? previewFile!.type : (file.type || ''),
    ext: decodedHere ? extOf(previewFile!.name) : extOf(file.name),
    size: decodedHere ? previewFile!.size : file.size,
    mtime: file.lastModified || 0,
    // The name the file arrived under, kept even after it is renamed, because
    // clearing a name is meant to give this back - see state.ts/renameItem.
    //
    // On the item rather than only in the asset registry, which is where it used
    // to live alone. The registry is rebuilt from the archive on every open and
    // the archive carries no filenames, so after a save and a reopen "clear the
    // name" fell back to the *renamed* value and the original was gone. Here it
    // travels inside board.json.
    origName: file.name,
    // Tells adoptAspect() the size is already right; only unmeasurable media
    // leaves this off and gets resized once it loads.
    sized: !!size.measured,
  };
  // One slot, two sources. An audio card wears the picture out of its own tags;
  // a video that cannot be played wears a frame out of itself. Both are "the
  // picture this item shows", and the renderers already know what to do with one
  // - a card draws it in the corner, a video makes it the poster.
  if (cover) meta.cover = cover;
  else if (poster?.hash) meta.cover = poster.hash;
  if (thumb) meta.thumb = thumb.hash;
  if (display) meta.display = display.hash;
  // How long it runs, where the container was willing to say. The playlist used
  // to be the only thing that knew this and it found out by mounting an <audio>
  // per row on the first draw; here it is one header read on a file already in
  // hand, it covers video as well as audio, and it is in the .mbrd - so a board
  // opened on a machine that cannot decode the format at all still shows the
  // times. The estimate is deliberately not taken: see runProbe() in
  // ui/playlist.ts for why that one case belongs to the engine.
  if (facts?.duration && !facts.estimated) meta.duration = facts.duration;
  // A guess, and only a guess: a picture whose outer ring is mostly transparent
  // is a shape rather than a photograph, so it lands with no card round it. The
  // menu row ("No card") is what makes it a default rather than a verdict -
  // whatever is chosen there wins and is what gets saved. Only for an image that
  // is its own thumbnail source: a preview pulled out of a HEIC or a frame
  // grabbed from a clip is a different picture from the one being imported, and
  // neither is ever a cut-out.
  if (type === 'image' && !previewFile && thumb?.cutout) meta.bare = true;
  // Two shapes, one slot each, and never both.
  //
  //   source  - a HEIC or a RAW: asset.hash is the picture, this is the file it
  //             was decoded from. Kept so nothing is lost, and the one thing
  //             the optimiser deliberately throws away.
  //   preview - everything else undecodable: asset.hash is the untouched
  //             original and the image renderer draws this instead.
  //
  // Both are preserved and packed like any other content id - see META_HASHES
  // in board-model.ts and itemHashes() in util.ts.
  if (decodedHere) meta.source = original;
  else if (previewHash !== null) meta.preview = previewHash;
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
    meta,
  };
}

// The pad's size lives beside the note's model now, because three surfaces
// outside this module read a stored tint and only one of them may import from
// here. Re-exported so the flyout and the tests that already name it here keep
// working. See noteTint() in canvas/note-model.ts.
export { NOTE_TINTS };

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
    name: noteNameOf(text || ''),
    x: centre.x, y: centre.y, w: size.w, h: size.h,
    meta: { text, tint },
  }], 'Add note');
  // A note written onto a card is a note that has just been let go, so it gets
  // the same ten seconds a dropped one does before it sets - see the settling
  // block in sticky.ts. Without this a note added over a photograph would be
  // pinned from the first keystroke, and the editor you are typing into would
  // be attached to something you could no longer move.
  startSettling([item.id]);
  select([item.id]);
  return item;
}

/**
 * How far off square a sticker lands, as a multiple of the lean the whimsy axis
 * is currently allowing an ordinary card.
 *
 * A sticker leans further than a card and should: a card is pinned up, and a
 * sticker is pressed down with a thumb. 2.7 puts it at about eight degrees at
 * the scrapbook end of the axis, which is where that number was tuned and is
 * about as far as a thumb actually takes one - past that it stops reading as
 * hand-placed and starts reading as broken. The other two tiers get half of it,
 * because --tilt-max halves there, and the point of the axis is that the whole
 * board straightens up together. It used to be a flat eight degrees at every
 * tier, which left a sticker the one thing on a Harsh board still thrown down
 * at a scrapbook angle.
 */
const STICKER_TILT_X = 2.7;

/**
 * The lean a card may currently rest at, in degrees.
 *
 * Read off --tilt-max rather than tabulated here, because that token is the one
 * place the whimsy axis says how crooked this board is - see canvas.css and the
 * [data-whimsy] blocks in tokens.css - and a copy of those numbers in JS is a
 * copy that goes wrong the first time the axis is retuned.
 *
 * canvas/item-dom.ts reaches the same token, and never has to read it: a card
 * multiplies its dealt factor by --tilt-max *in CSS*, so it re-leans on its own
 * when the dial moves. A sticker cannot do that. Its angle is real geometry -
 * it goes in the file, it is in the undo snapshot, and a deliberate 45 degrees
 * is a thing somebody can have meant - so it is rolled once, against whatever
 * the axis allowed at the moment the sticker was pressed down. Moving one
 * re-rolls it (see addSticker), which is also when it picks up a dial that has
 * moved since.
 *
 * The fallback is the token's own default and is only reached with no document
 * at all, which is a test importing this module rather than anything the app
 * does.
 */
function cardTiltMax(): number {
  if (typeof document === 'undefined') return 1.5;
  const deg = parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--tilt-max'));
  return Number.isFinite(deg) ? deg : 1.5;
}

/**
 * A shape pressed onto the board. The third item type with no file behind it.
 *
 * **The tilt is re-rolled here rather than kept**, which is the one decision in
 * this function. A sticker gets a fresh angle every time it lands somewhere,
 * because that is what peeling one off and pressing it down again looks like -
 * and it has to happen on the *drop* rather than per frame, or the shape would
 * shimmer while you dragged it. Undo gets it for free: `rot` goes into the same
 * geometry snapshot as x and y (GEOM_KEYS in layout.ts), so stepping back puts
 * the old angle back along with the old position.
 *
 * How far it may go is the whimsy axis's to say, the same as a card's lean -
 * see STICKER_TILT_X and cardTiltMax() above. The roll is against the dial as
 * it stands right now, so a sticker put down at one end of the axis keeps that
 * angle until it is moved.
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
    rot: (Math.random() * 2 - 1) * STICKER_TILT_X * cardTiltMax(),
    meta: { shape: entry.id, tint: stickerTint(tint, entry.id) },
  }], 'Add sticker');
  // Just pressed down, so it lies where it landed for ten seconds before it
  // sets - the same window a drag gives, and the one that lets you nudge a
  // star you placed a hair off centre. See addNote above and sticky.ts.
  startSettling([item.id]);
  select([item.id]);
  // Placed, which is a card landing by another route - the same cue a drag
  // gives when it lets go. The other two fileless types say nothing: a note and
  // a swatch are made to be typed into or picked from, so the making of one is
  // the start of the gesture rather than the end of it.
  cue('tap');
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

/**
 * A specimen of a dropped face, as a card on the board.
 *
 * Not a fileless type like the four above: the bytes are real and were hashed
 * by ui/fonts.ts, which mints this the instant a dropped face registers. So the
 * family passed here is the one document.fonts actually carries - uniqueFamily()
 * may have numbered it - and asset.hash is that same face, so the specimen
 * travels in the .mbrd whether or not the menu entry is later removed.
 *
 * asset.family is read straight back by the font renderer; nothing else on the
 * card needs writing, since the letters it shows are fixed.
 */
export function addFontCard(centre: Point, hash: string, family: string) {
  const size = defaultSize('font');
  const [item] = addItems([{
    type: 'font',
    name: family,
    x: centre.x, y: centre.y, w: size.w, h: size.h,
    asset: { hash, family },
  }], 'Add font');
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
  const folders: DiskFolder[] = [];
  const canWalk = items.length && typeof items[0].webkitGetAsEntry === 'function';
  if (!canWalk) {
    return { files: flat, folders, fromFolder: flat.some(file => !!file.webkitRelativePath), truncated: false };
  }

  const entries = items.map(i => i.webkitGetAsEntry())
    .filter((entry): entry is FileSystemEntry => !!entry);
  const fromFolder = entries.some(entry => entry.isDirectory);
  const out: File[] = [];
  const walk: Walk = { count: 0, dirs: 0 };
  for (const entry of entries) {
    // A dropped folder spreads its own files over the board, and each folder
    // inside it lands as one folder card holding everything under it.
    if (isDirEntry(entry)) {
      await spreadFolder(entry, out, folders, walk);
    } else {
      const got: DiskFile[] = [];
      await walkEntry(entry, '', got, walk);
      out.push(...got.map(g => g.file));
    }
    if (walk.count >= MAX_FILES) break;
  }
  // Reported rather than left to be inferred. The walk stops *at* MAX_FILES, so
  // importFiles()'s `files.length > MAX_FILES` was unreachable from a drop and a
  // folder of a thousand photographs brought in five hundred while saying it had
  // brought in everything. Inferring it there with >= would be one character and
  // wrong for the picker, where five hundred chosen files really are five hundred
  // files and nothing was cut.
  const walked = out.length || folders.length;
  return { files: walked ? out : flat, folders, fromFolder, truncated: walk.count >= MAX_FILES };
}

/**
 * How deep a dropped folder may go, and how many directories may be visited.
 *
 * The recursion below had neither, and the MAX_FILES guards are no substitute:
 * they count *files*, so a symlink loop or ten thousand nested empty
 * directories produce none, never trip a guard, and run until the stack blows
 * or the drop simply never finishes. A visited set is not available - a
 * FileSystemEntry has no stable identity to key on - so the bounds are the
 * walk's own shape.
 *
 * Nobody organises photographs thirty-two folders deep, and eight thousand
 * directories is an order of magnitude past MAX_FILES.
 */
const MAX_DEPTH = 32;
const MAX_DIRS = 8192;

/** One drop's walk: files found, across every folder and card, and directories visited. */
type Walk = { count: number, dirs: number };

/** Each child of a directory, in turn, until the walk reaches MAX_FILES. */
async function eachChild(dir: FileSystemDirectoryEntry, walk: Walk, visit: (child: FileSystemEntry) => Promise<void>) {
  const reader = dir.createReader();
  // readEntries returns at most ~100 per call and must be drained in a loop.
  for (;;) {
    const batch = await new Promise<FileSystemEntry[]>(res => reader.readEntries(res, () => res([])));
    if (!batch.length) break;
    for (const child of batch) await visit(child);
    if (walk.count >= MAX_FILES) break;
  }
}

/** Every file under an entry, each with its path below `prefix`. */
async function walkEntry(entry: FileSystemEntry, prefix: string, out: DiskFile[], walk: Walk, depth = 0) {
  if (walk.count >= MAX_FILES) return;
  if (isFileEntry(entry)) {
    const file = await new Promise<File | null>(res => entry.file(res, () => res(null)));
    if (file) {
      out.push({ path: prefix + file.name, file });
      walk.count++;
    }
    return;
  }
  if (!isDirEntry(entry)) return;
  if (depth >= MAX_DEPTH || ++walk.dirs > MAX_DIRS) return;
  const below = `${prefix}${entry.name}/`;
  await eachChild(entry, walk, child => walkEntry(child, below, out, walk, depth + 1));
}

/**
 * A dropped folder: its own files onto `files`, and each folder in it onto
 * `folders` with every file under that one, by path below it.
 */
async function spreadFolder(dir: FileSystemDirectoryEntry, files: File[], folders: DiskFolder[], walk: Walk) {
  if (++walk.dirs > MAX_DIRS) return;
  await eachChild(dir, walk, async child => {
    const got: DiskFile[] = [];
    if (isDirEntry(child)) {
      if (++walk.dirs > MAX_DIRS) return;
      await eachChild(child, walk, inner => walkEntry(inner, '', got, walk, 2));
      if (got.length) folders.push({ name: child.name, entries: got });
    } else {
      await walkEntry(child, '', got, walk, 1);
      files.push(...got.map(g => g.file));
    }
  });
}


/**
 * The picture a native decoder can read, as a File the rest of this path
 * already knows how to handle.
 *
 * A PNG, because that is what desktop/native/decode.ts hands back and because
 * the alternative - a second lossy step on a photograph nobody asked to
 * compress - is the wrong default for the one copy the card will draw. The name
 * carries the original's stem so a card that falls back to a filename still
 * says something recognisable.
 *
 * Null for every failure and on every browser, which is the protocol every
 * native port in this app takes: the caller has a path behind this one.
 */
async function nativePreview(file: File): Promise<File | null> {
  const bitmap = await platform.native.decode(await file.arrayBuffer(), file.name);
  if (!bitmap) return null;
  try {
    // Back to bytes, because everything downstream measures and stores a File.
    // Drawn rather than re-read: the decoder handed back a bitmap, and this is
    // the one place that has a canvas to put it on.
    const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
    const ctx = canvas.getContext('2d');
    if (!ctx) return null;
    ctx.drawImage(bitmap, 0, 0);
    const blob = await canvas.convertToBlob({ type: 'image/png' });
    const stem = file.name.replace(/\.[^.]*$/, '');
    return new File([blob], stem + '.png', { type: 'image/png' });
  } catch {
    return null;
  } finally {
    // The bitmap holds decoded pixels until it is closed, and a board of
    // photographs would otherwise hold every one of them at once.
    bitmap.close();
  }
}

/**
 * A camera RAW developed into a picture - the path of last resort, for the
 * RAWs that carry no preview for the three readers above this one to find.
 * Null for everything that is not a RAW.
 *
 * Half-size on purpose (see demosaic()): a fifth of a second rather than a
 * second and a bit, and still over the display ceiling on any camera. The
 * Demosaic row is unchanged and still develops every pixel - which is the
 * point of importing as an image card rather than a grey one, because that
 * row is only offered on an image.
 *
 * LibRaw is behind a dynamic import for the reason every heavy reader here is:
 * a board with no RAW on it should not fetch a megabyte and a half of wasm.
 */
async function developedRaw(file: File, lift: boolean): Promise<File | null> {
  if (!RAW_EXTS.has(extOf(file.name))) return null;
  try {
    const { demosaic } = await import('../optimize/demosaic.ts');
    const made = await demosaic(file, lift, true);
    const stem = file.name.replace(/\.[^.]*$/, '');
    // The name follows the bytes, never the other way round: demosaic() writes
    // a WebP where the canvas will make one and falls back to a JPEG where it
    // will not, and this File is what the card's mime and ext are read from.
    const ext = made.blob.type === 'image/webp' ? '.webp' : '.jpg';
    return new File([made.blob], stem + ext, { type: made.blob.type || 'image/jpeg' });
  } catch (err) {
    // The sensor ceiling is a question for asking() to put; everything else -
    // a format LibRaw will not open, a wasm that would not load - is this
    // path having nothing to offer, and the caller has a grey card behind it.
    if (isOversize(err)) throw err;
    return null;
  }
}
