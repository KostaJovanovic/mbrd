// Viewer: one item at full size in a showModal() <dialog>. VIEWS table keyed
// by item type (same shape as RENDERERS). Teardown is load-bearing: mounted
// videos keep their decoder, blob URLs must be revoked, parsed PDFs hold the
// whole file, and an open document is saved. A .md, .txt or .fountain opened
// to edit goes to the text editor (ui/editor/); opened plainly, it is read.
// No document reach at import time (tests/imports.test.js).

import {
  board, bus, byId, select, itemAdjust, itemCrop, itemRotate, itemMatte, flipTransform, setItemText,
  setItemAscii, renameItem, takeBack,
} from '../state.ts';
import type { Command } from '../state.ts';
import { copyItems } from '../clipboard.ts';
import { openAnchored } from './menu.ts';
import type { MenuEntry } from './menu.ts';
import { openExternal } from './leaving.ts';
import { displayURLReady, ensureDisplay } from '../canvas/display.ts';
import { travelMs, fastMs } from '../canvas/viewport.ts';
import { addFile, assetURL, getAsset, readText } from '../storage/assets.ts';
import { fileKey, lift } from '../consent.ts';
import { mountEditor } from './editor/view.ts';
import type { Editor, EditorOptions } from './editor/view.ts';
import { measureForEdit } from './editor/markdown.ts';
import { baseName, formatBytes, markClosed, wasClosed } from '../util.ts';
import { linkURL, MARKDOWN } from '../canvas/renderers.ts';
import { embedFor, frameFor } from '../canvas/embed.ts';
import { noteTint } from '../canvas/note-model.ts';
import type { NoteEntrance } from '../canvas/notes.ts';
import { kindName } from '../canvas/item-dom.ts';
import { renderMarkdown } from './markdown.ts';
// Statically: the only import the reader needs is storage/zip.ts, already in
// memory (it opens every .mbrd), plus the browser's DOMParser - nothing to defer.
import { canReadDocument, readDocument } from './documents.ts';
import type { Item } from '../board-model.ts';

/**
 * `meta` is open by design (board-model.ts), so the three keys read out of
 * it here are narrowed rather than trusted. A non-string value reads as missing.
 */
const str = (v: unknown): string => (typeof v === 'string' ? v : '');
/** The object URL for a hash out of `meta`, or null for anything that is not one. */
const urlOf = (hash: unknown): string | null => (typeof hash === 'string' ? assetURL(hash) : null);

/**
 * How much of a text file the viewer reads - ten times the card's preview,
 * five times the Feed tile's, since this is where the whole file belongs.
 * Still capped: a 40MB log dropped on a board should not lock the tab.
 */
const TEXT_MAX = 200000;

/** The text files that open in the editor. Every other text file is read, as before. */
const EDITABLE = new Set([...MARKDOWN, 'txt', 'text', 'fountain']);

/** A pause in typing this long saves the document. */
const IDLE_SAVE_MS = 1500;

/**
 * Where to put the caret, and where a sticky that became this document was on
 * screen and in what colour. `held` is the typing done while it became one.
 */
export type OpenOptions = {
  /** Open a text file in the editor. Without it every file is opened to read. */
  edit?: boolean,
  caret?: EditorOptions['caret'], from?: DOMRect | null, paper?: string, held?: HeldTyping | null,
  /** Typed at the caret once the editor opens, before anything held. */
  typed?: string,
  /** The card or tile a picture was opened from, on screen, for it to grow out of. */
  thumb?: DOMRect | null,
  /**
   * The sticky this document grew out of, for as long as this editing lasts:
   * `fits` is asked after each change, and once the text fits a sticky again
   * `back` turns it into one (`was` is the text before the change), and the
   * editor goes into it by `into`. Wired by main.ts, since the note is canvas/'s.
   */
  note?: { fits: (markdown: string) => boolean, back: (markdown: string, was: string, into: NoteEntrance) => void },
  /** What is on screen under the viewing until it arrives - the composer the sticky was written in - and its taking away. */
  over?: () => void,
};

/** Typing caught between a sticky closing and its document opening. `into` moves the catcher inside a modal. */
export type HeldTyping = { take: () => string, into: (host: HTMLElement) => void };

/**
 * Catch what is typed while a sticky becomes a document: the note has closed
 * and the editor is not open yet, since the file is hashed in between. A
 * hidden field takes focus meanwhile, so the keys land somewhere - and on a
 * phone, so the keyboard stays up rather than dropping and coming back.
 * `host` is a modal still open, the one place a field can take focus.
 */
export function holdTyping(host: HTMLElement = document.body): HeldTyping {
  const box = document.createElement('textarea');
  box.className = 'viewer-hold';
  box.tabIndex = -1;
  box.setAttribute('aria-hidden', 'true');
  host.append(box);
  box.focus({ preventScroll: true });
  return {
    take: () => {
      const typed = box.value;
      box.remove();
      return typed;
    },
    into: host => {
      host.append(box);
      box.focus({ preventScroll: true });
    },
  };
}

/**
 * The document open in the editor. `saved` is the text last written, so a
 * close with nothing changed writes nothing; `step` is the undo entry this
 * opening made, which every later save folds into; `gen` is the board it was
 * opened on, so a save that lands after a board swap goes nowhere.
 */
type EditSession = {
  editor: Editor, id: string, name: string, mime: string,
  saved: string | null, step: Command | null, gen: number, timer: number, chain: Promise<void>,
  /** Stops following the phone keyboard. */
  release: () => void,
};
let editing: EditSession | null = null;
/** Counts board swaps. See EditSession. */
let boardGen = 0;

/** Write the document if it changed. Saves run one after another, so the last word is the last written. */
function saveEdit(s: EditSession): Promise<void> {
  clearTimeout(s.timer);
  s.chain = s.chain.then(async () => {
    const text = s.editor.text();
    if (text === s.saved) return;
    s.saved = text;
    try {
      const hash = await addFile(new File([text], s.name, { type: s.mime }));
      if (s.gen !== boardGen) return;
      s.step = setItemText(s.id, hash, s.step);
    } catch (err) {
      // Left for the next save, which tries the whole text again - null, since
      // any text, the empty one too, could be what failed.
      s.saved = null;
      console.error('[mbrd] the document could not be saved', err);
    }
  });
  return s.chain;
}

/** Save the open document now. Called before the page goes, as notes are flushed. */
export function flushEditor(): Promise<void> {
  return editing ? saveEdit(editing) : Promise.resolve();
}

// The dialog and its three slots, taken once in initViewer(). Read past that
// guard with `!`: initViewer() returns early without the dialog, and
// openViewer() refuses before touching any of them.
let dlg: HTMLDialogElement | null = null;
let titleEl: HTMLElement | null = null;
let metaEl: HTMLElement | null = null;
let bodyEl: HTMLElement | null = null;

/** The blob URLs the open document minted, if this viewing is showing one. */
let releaseDoc: (() => void) | null = null;
/** The open PDF, if this viewing is one. Parsed documents are not small. */
let pdfDoc: { destroy: () => void } | null = null;

/** The item this viewing shows, or null. What the right-click acts on. */
let shownId: string | null = null;

/** The one camera command the right-click needs. Injected: commands.ts imports this module. */
export interface ViewerCommands {
  zoomToSelection: () => void;
}
let cmds: ViewerCommands | null = null;

export function initViewer(commands?: ViewerCommands) {
  cmds = commands ?? null;
  // SAFETY: #viewer is the <dialog> in index.html; the showModal test in
  // openViewer() is the real guard and covers engines without dialog support too.
  dlg = document.getElementById('viewer') as HTMLDialogElement | null;
  if (!dlg) return;
  // Right-click: what can be done with the thing on show. Text keeps the
  // browser's menu once some of it is selected, and a field always does -
  // copying words out of a document is the browser's job, not this menu's.
  dlg.addEventListener('contextmenu', e => {
    if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement) return;
    // A document being written has its own menu (ui/editor/view.ts).
    if (e.target instanceof Element && e.target.closest('.ed')) return;
    if (getSelection()?.isCollapsed === false) return;
    e.preventDefault();
    if (!shownId) return;
    openAnchored({ left: e.clientX, right: e.clientX, top: e.clientY, bottom: e.clientY },
      viewerEntries(shownId), { label: 'Viewer' });
  });
  titleEl = document.getElementById('viewer-title');
  metaEl = document.getElementById('viewer-meta');
  bodyEl = document.getElementById('viewer-body');
  document.getElementById('viewer-close')?.addEventListener('click', () => closeViewer());
  // A press on the backdrop closes, like every other overlay. A <dialog>
  // fills the top layer, so the press lands on the dialog itself and the
  // only way to tell backdrop from sheet is where it landed.
  dlg.addEventListener('click', e => {
    if (e.target !== dlg) return;
    const r = dlg!.getBoundingClientRect();
    const inside = e.clientX >= r.left && e.clientX <= r.right
                && e.clientY >= r.top && e.clientY <= r.bottom;
    if (!inside) closeViewer();
  });
  // Escape reaches the dialog as a close request whatever had focus; the
  // teardown must run too, or the next viewing inherits a video still playing.
  dlg.addEventListener('close', teardown);
  // In a document, Escape (and Android's Back, which sends this) closes the
  // find bar before it closes the document.
  // A document otherwise goes the way it came, the paper dropping away (leave()).
  // Taken at the keydown, in the bubble phase so the find bar and the name
  // field have had their Escape first: a cancel event may only be refused
  // after a user activation, so refusing it there is not enough on its own.
  dlg.addEventListener('keydown', e => {
    if (e.key !== 'Escape' || !editing || e.defaultPrevented || wasClosed(e)) return;
    e.preventDefault();
    markClosed(e);
    closeViewer();
  });
  dlg.addEventListener('cancel', e => {
    if (editing?.editor.closeFind()) { e.preventDefault(); return; }
    if (editing) { e.preventDefault(); closeViewer(); }
  });
  // Counted before the close below, so a save the close starts knows the board is gone.
  bus.on('board:load', () => { boardGen++; });
  // A board swap takes the viewing with it, as it takes the sticker window: the
  // item it shows, and the blob URLs behind it, belonged to the board that left.
  // At once - no paper drops away over a board that has already changed.
  bus.on('board:load', () => closeViewer(true));
}

/**
 * Is there anything worth showing this item full size? Asked by callers
 * rather than answered with an empty dialog - a tap that opens "nothing to
 * show" costs a second press to undo.
 */
export function canView(id: string) {
  const item = byId(id);
  if (!item) return false;
  return !!viewFor(item);
}

/** Does this item open in the text editor? A text file of a kind it writes, with its bytes in the board. */
export function canEdit(id: string) {
  const item = byId(id);
  return !!item?.asset?.hash && viewFor(item) === VIEWS.text && EDITABLE.has(str(item.meta?.ext));
}

/**
 * Which view opens this item. Documents are asked about *first*, by
 * extension rather than type, since a document has no type of its own on
 * this board - a .docx with a baked thumbnail imported as `image`, one
 * without imported as `generic`, and both should open as a document. The
 * type table is the fallback for everything the board draws natively.
 */
function viewFor(item: Item): View | null {
  if (!item.asset?.hash) return VIEWS[item.type] || null;
  if (PDF_EXTS.has(str(item.meta?.ext))) return pdfView;
  if (canReadDocument(item.meta?.ext)) return documentView;
  return VIEWS[item.type] || null;
}

/** The two extensions the PDF renderer opens. See isPdf() in import/drop.ts. */
const PDF_EXTS = new Set(['pdf', 'ai']);

export function openViewer(id: string, open: OpenOptions = {}) {
  const item = byId(id);
  const view = item && viewFor(item);
  if (!dlg || typeof dlg.showModal !== 'function' || !item || !view) return void open.over?.();
  // A close still animating is finished first: this viewing replaces it.
  if (closing) finishClose();
  // A document already open is saved and put down before another replaces it.
  if (editing) teardown();

  // A document with no name opens under what it is - e.g. "Word document" -
  // rather than its import type, which for the unrecognized is `generic`.
  titleEl!.textContent = baseName(item.name) || item.name || kindName(item);
  metaEl!.textContent = describe(item);
  bodyEl!.replaceChildren();
  dlg.dataset.type = item.type;
  // Which of the two shapes this viewing is - a lightbox or a page - tested
  // on the view *dispatched to*, not the item's type: a .docx that imported
  // as `image` (baked preview) still opens as a document, and reading it on
  // a black ground with no page would be unreadable. viewFor() already
  // answered this; this just writes it down.
  if (view === VIEWS.image || view === VIEWS.video) dlg.dataset.media = '';
  else delete dlg.dataset.media;
  // A text read is a page: readOnlyText() says so. Every other viewing keeps its own shape.
  delete dlg.dataset.page;
  shownId = id;
  view(item, bodyEl!, open);
  // The picture, once mounted - a clip is left out deliberately: wheel/drag
  // over its controls should press them, not zoom.
  const pic = bodyEl!.querySelector<HTMLImageElement>('img.viewer-media');
  if (pic) detachZoom = attachZoomPan(pic, bodyEl!);
  dlg.showModal();
  // A sticky grows into the sheet, and a document opened to edit rises into
  // it; the sheet exists only once the editor has mounted, so till then the
  // viewing waits unseen, and editDocument() calls arrive().
  if (open.from || open.edit) {
    arriving?.over?.();
    arriving = { from: open.from ?? null, paper: open.paper, over: open.over };
    if ('edit' in dlg.dataset) dlg.classList.add('is-arriving');
    else arrive();
  } else {
    open.over?.();
    if (pic && open.thumb) growPicture(dlg, pic, open.thumb);
  }
  // The body, not the close button - scrolling with the keyboard is the
  // first thing anybody does, and a focused button swallows Space. Unless
  // typing is being held for a document still opening: the catcher keeps it.
  if (open.held) open.held.into(dlg);
  else bodyEl!.focus?.();
}

/**
 * A picture opened from its card or tile grows out of it, rather than the
 * lightbox swelling from the middle of the window: the photograph flies from
 * the thumbnail's box to its own, while the dark ground and the head fade in
 * around it. Only when the picture already has a size - a file still loading
 * has none to fly to, and keeps the plain entrance (viewer.css's ask-in).
 * Uniform scale about matching centres, so a cropped tile does not stretch it.
 */
function growPicture(dlg: HTMLDialogElement, pic: HTMLImageElement, from: DOMRect) {
  const ms = travelMs();
  if (!(ms > 0) || typeof pic.animate !== 'function' || !from.width || !from.height) return;
  const to = pic.getBoundingClientRect();
  if (!to.width || !to.height) return;
  for (const a of dlg.getAnimations()) a.cancel();
  const s = Math.max(from.width / to.width, from.height / to.height);
  const dx = (from.left + from.width / 2) - (to.left + to.width / 2);
  const dy = (from.top + from.height / 2) - (to.top + to.height / 2);
  const long = ms * 0.8;
  pic.animate([
    { transform: `translate(${dx}px, ${dy}px) scale(${s})` },
    { transform: 'none' },
  ], { duration: long, easing: cssEase() });
  dlg.animate([{ backgroundColor: 'transparent' }, { backgroundColor: getComputedStyle(dlg).backgroundColor }],
    { duration: long, easing: 'ease-out' });
  for (const part of dlg.querySelectorAll<HTMLElement>('#viewer-head')) {
    part.animate([{ opacity: 0 }, { opacity: 0, offset: 0.4 }, { opacity: 1 }], { duration: long, easing: 'ease-out' });
  }
}

/** The entrance a document is waiting on: from a sticky, or (no `from`) up from below. See openViewer() and arrive(). */
let arriving: { from: DOMRect | null, paper?: string, over?: () => void } | null = null;

/** Shows the waiting viewing: grown or risen into `page`, or plainly faded in when there is no sheet. Once. */
function arrive(page: HTMLElement | null = null) {
  const a = arriving;
  arriving = null;
  if (!a || !dlg) return;
  dlg.classList.remove('is-arriving');
  if (a.from) growFrom(dlg, a.from, a.paper, page);
  else riseIn(dlg, page);
  a.over?.();
}

/** What stands around the sheet and fades with it: the head, the ribbon, the grain and the status bar. */
const EDITOR_PARTS = '#viewer-head, .ed-bar, .ed-grain, .ed-status';
/** The paper's curve: quick off the mark, a long settle - a sheet slid onto a desk. */
const SETTLE = 'cubic-bezier(0.16, 1, 0.3, 1)';

/**
 * The page slid up onto the desk from below the window, turning straight as
 * it settles, while the desk, the ribbon and the name fade in around it. The
 * scroller is held still for it: a sheet moved by a transform is scrollable
 * overflow, and a scrollbar would flicker in for the length of the rise.
 */
function riseIn(dlg: HTMLDialogElement, sheet: HTMLElement | null) {
  if (typeof dlg.animate !== 'function') return;
  const ms = travelMs();
  if (!sheet || !(ms > 0)) return void dlg.animate([{ opacity: 0 }, { opacity: 1 }], { duration: fastMs(), easing: 'ease-out' });
  for (const a of dlg.getAnimations()) a.cancel();
  const box = dlg.getBoundingClientRect();
  const r = sheet.getBoundingClientRect();
  const long = ms * 1.1;
  const hold = holdScroll(sheet);
  sheet.animate([
    { transform: `translateY(${box.bottom - r.top + 24}px) rotate(-2deg)` },
    { transform: 'none' },
  ], { duration: long, easing: SETTLE }).finished.then(hold, hold);
  dlg.animate([{ backgroundColor: 'transparent' }, { backgroundColor: getComputedStyle(dlg).backgroundColor }], { duration: long * 0.6, easing: 'ease-out' });
  for (const part of dlg.querySelectorAll<HTMLElement>(EDITOR_PARTS)) {
    // Each part comes in from the edge it lives on, a few pixels, as it fades.
    const low = part.getBoundingClientRect().top > box.top + box.height / 2;
    part.animate([
      { opacity: 0, transform: `translateY(${low ? 10 : -10}px)` },
      { opacity: 0, transform: `translateY(${low ? 10 : -10}px)`, offset: 0.2 },
      { opacity: 1, transform: 'none' },
    ], { duration: long * 0.8, easing: 'ease-out' });
  }
}

/** The sheet's scroller held from scrolling while the sheet moves. Returns the release. */
function holdScroll(sheet: HTMLElement): () => void {
  const scroller = sheet.parentElement;
  if (!scroller) return () => {};
  scroller.style.overflow = 'hidden';
  return () => { scroller.style.overflow = ''; };
}

/** A close under way: its animations, and the close they end in. */
let closing: { anims: Animation[], done: () => void } | null = null;

/**
 * The editor going the way it came: the page dropping away off the bottom of
 * the window, tipping as it goes, the rest fading ahead of it, and the board
 * showing through the desk. Off the mark at once and quick - the user asked
 * to be back on the board, so the first frames are the ones that must move.
 * `done` closes the dialog when it has gone.
 */
function leave(done: () => void) {
  const sheet = dlg?.querySelector<HTMLElement>('.ed-sheet');
  const ms = travelMs();
  if (!dlg || !sheet || typeof dlg.animate !== 'function' || !(ms > 0)) return done();
  const box = dlg.getBoundingClientRect();
  const r = sheet.getBoundingClientRect();
  const long = ms * 0.7;
  const opts = { duration: long, easing: cssEase(), fill: 'forwards' as const };
  holdScroll(sheet);
  dlg.style.pointerEvents = 'none';
  const anims = [
    sheet.animate([{ transform: 'none' }, { transform: `translateY(${box.bottom - r.top + 24}px) rotate(1.5deg)` }], opts),
    dlg.animate([{ backgroundColor: getComputedStyle(dlg).backgroundColor }, { backgroundColor: 'transparent' }], { ...opts, easing: 'ease-out' }),
    ...[...dlg.querySelectorAll<HTMLElement>(EDITOR_PARTS)].map(part =>
      part.animate([{ opacity: 1 }, { opacity: 0 }], { ...opts, duration: long * 0.6, easing: 'ease-out' })),
  ];
  closing = { anims, done };
  anims[0].finished.then(() => { if (closing?.anims === anims) finishClose(); }, () => {});
}

/** The close brought to its end now: the dialog shut, then every held animation let go, the dialog's own last. */
function finishClose() {
  const c = closing;
  closing = null;
  if (!c) return;
  c.done();
  for (const a of c.anims) a.cancel();
  if (dlg) dlg.style.pointerEvents = '';
}

/**
 * A sticky that has just become a document, growing into the sheet: a card in
 * the note's colour flies from where the note was to where the page is and
 * turns to paper, the text shows through as it lands, and the desk, the name
 * and the bar fade in around it. Transform, opacity and colour only, at the
 * whimsy dial's travel speed; with motion reduced, a plain fade.
 */
function growFrom(dlg: HTMLDialogElement, from: DOMRect, paper: string | undefined, page: HTMLElement | null) {
  if (typeof dlg.animate !== 'function') return;
  const ms = travelMs();
  const fade = () => void dlg.animate([{ opacity: 0 }, { opacity: 1 }], { duration: fastMs(), easing: 'ease-out' });
  if (!page || !(ms > 0) || !from.width || !from.height) return fade();
  // The grow is the entrance: viewer.css's own (ask-in) would still be scaling
  // the dialog as the sheet is measured, and the card would land short of it.
  for (const a of dlg.getAnimations()) a.cancel();
  const to = seenOf(page);
  if (!to) return fade();
  const box = dlg.getBoundingClientRect();
  const ease = cssEase();
  const white = getComputedStyle(page).backgroundColor;
  const desk = getComputedStyle(dlg).backgroundColor;
  const long = ms * 1.35;
  const landed = ms / long;

  const card = paperCard(dlg, box, to, white);
  card.animate([
    { transformOrigin: '0 0', transform: `translate(${from.left - to.left}px, ${from.top - to.top}px) scale(${from.width / to.width}, ${from.height / to.height})` },
    { transformOrigin: '0 0', transform: 'none' },
  ], { duration: ms, easing: ease });
  // The note's colour held for the first stretch of the flight, so it reads as the note.
  card.animate([{ backgroundColor: paper || white }, { backgroundColor: paper || white, offset: 0.3 }, { backgroundColor: white }], { duration: ms, easing: 'linear' });
  card.animate([{ opacity: 1 }, { opacity: 1, offset: landed }, { opacity: 0 }], { duration: long, easing: 'linear' })
    .finished.then(() => card.remove(), () => card.remove());
  page.animate([{ opacity: 0 }, { opacity: 0, offset: landed * 0.85 }, { opacity: 1 }], { duration: long, easing: 'ease-out' });
  dlg.animate([{ backgroundColor: 'transparent' }, { backgroundColor: 'transparent', offset: 0.25 }, { backgroundColor: desk }], { duration: long, easing: 'ease-out' });
  for (const part of dlg.querySelectorAll<HTMLElement>(EDITOR_PARTS)) {
    part.animate([{ opacity: 0 }, { opacity: 0, offset: 0.35 }, { opacity: 1 }], { duration: long, easing: 'ease-out' });
  }
}

/** The part of the sheet on screen - a page is taller than the window - or null if none of it is. */
function seenOf(page: HTMLElement) {
  const sheet = page.getBoundingClientRect();
  const seen = (page.parentElement ?? page).getBoundingClientRect();
  const top = Math.max(sheet.top, seen.top);
  const r = { left: sheet.left, top, width: sheet.width, height: Math.min(sheet.bottom, seen.bottom) - top };
  return r.width > 0 && r.height > 0 ? r : null;
}

/** The app's own curve, read off the tokens. */
const cssEase = () => getComputedStyle(document.documentElement).getPropertyValue('--ease').trim() || 'ease-out';

/** The blank card a sticky and its page turn into each other as, laid over `at` in the dialog. */
function paperCard(dlg: HTMLDialogElement, box: DOMRect, at: { left: number, top: number, width: number, height: number }, colour: string) {
  const card = document.createElement('div');
  card.className = 'viewer-grow';
  Object.assign(card.style, {
    background: colour,
    left: `${at.left - box.left}px`, top: `${at.top - box.top}px`,
    width: `${at.width}px`, height: `${at.height}px`,
  });
  dlg.append(card);
  return card;
}

/**
 * A document written back down to fit, going back into its sticky. Not the
 * grow played backwards, which starts on a long still crossfade and lands at
 * full speed: the page lifts off as a blank card at once, flies to where the
 * composer has put the note on the same settling curve as the grow, turning
 * to the note's colour on the way while the desk, the name and the bar go,
 * and the composer fades in over it as it lands. This viewing closes under
 * the composer after. With nowhere to go, or motion reduced, straight over.
 */
const shrinkInto: NoteEntrance = into => {
  const end = (anims: Animation[] = []) => {
    closeViewer(true);
    for (const a of anims) a.cancel();
  };
  if (!into) return end();
  const page = dlg?.querySelector<HTMLElement>('.ed-sheet');
  const ms = travelMs();
  const from = page && seenOf(page);
  const to = into.sheet;
  if (!dlg || typeof dlg.animate !== 'function' || !page || !from || !(ms > 0) || !to.width || !to.height) {
    return void into.show().then(() => end(), () => end());
  }
  const box = dlg.getBoundingClientRect();
  const white = getComputedStyle(page).backgroundColor;
  const desk = getComputedStyle(dlg).backgroundColor;
  // The lift: long enough that the words fade rather than blink, short enough to read as one move.
  const lift = ms * 0.2;
  const hold = { fill: 'both' as const };
  const card = paperCard(dlg, box, from, white);
  const anims = [
    card.animate([{ opacity: 0 }, { opacity: 1 }], { ...hold, duration: lift, easing: 'ease-out' }),
    // Gone from under the card once it is opaque, or the page would be left behind as it flies.
    page.animate([{ opacity: 1 }, { opacity: 1, offset: 0.99 }, { opacity: 0 }], { ...hold, duration: lift }),
    card.animate([
      { transformOrigin: '0 0', transform: 'none' },
      { transformOrigin: '0 0', transform: `translate(${to.left - from.left}px, ${to.top - from.top}px) scale(${to.width / from.width}, ${to.height / from.height})` },
    ], { ...hold, duration: ms, delay: lift, easing: cssEase() }),
    // The note's colour arrives mid-flight, so it lands as the note rather than turning into one there.
    card.animate([{ backgroundColor: white }, { backgroundColor: white, offset: 0.15 }, { backgroundColor: into.paper || white, offset: 0.7 }, { backgroundColor: into.paper || white }],
      { ...hold, duration: ms, delay: lift, easing: 'linear' }),
    dlg.animate([{ backgroundColor: desk }, { backgroundColor: 'transparent' }], { ...hold, duration: lift + ms * 0.6, easing: 'ease-out' }),
    ...[...dlg.querySelectorAll<HTMLElement>(EDITOR_PARTS)].map(part =>
      part.animate([{ opacity: 1 }, { opacity: 0 }], { ...hold, duration: lift + ms * 0.3, easing: 'ease-out' })),
  ];
  // The composer over the card for the last stretch of the flight, the words coming back as it settles.
  const shown = new Promise<void>(res => setTimeout(res, lift + ms * 0.7)).then(into.show);
  void Promise.all([shown, ...anims.map(a => a.finished.catch(() => {}))]).then(() => end(anims), () => end(anims));
};

/** Close the viewing - a document with its paper dropping away first, unless `now`. */
function closeViewer(now = false) {
  if (!dlg?.open) return;
  if (closing) { if (now) finishClose(); return; }
  const shut = () => { if (dlg?.open) dlg.close(); };   // 'close' runs teardown
  if (editing && !now) leave(shut);
  else shut();
}

/**
 * The right-click rows. Show on board is the way from here back to the card,
 * and is absent on the Feed, which has no camera to fly. Fit is there only
 * while the picture is zoomed, and the link row only on a link.
 */
function viewerEntries(id: string): MenuEntry[] {
  const item = byId(id);
  const url = item?.type === 'link' ? linkURL(item.meta?.url) : null;
  const zoomed = !!bodyEl?.querySelector('.viewer-media.is-zoomed');
  return [
    {
      label: 'Show on board',
      icon: 'i-zoom-to',
      hidden: !cmds || board.layoutMode === 'mobile',
      action: () => {
        closeViewer();
        select([id]);
        cmds?.zoomToSelection();
      },
    },
    // A document being read turns to writing where it is: the same viewing, reopened to edit.
    { label: 'Edit', icon: 'i-edit-text', hidden: !canEdit(id) || !!editing, action: () => openViewer(id, { edit: true }) },
    { label: 'Fit to the window', hidden: !zoomed, action: () => zoomReset?.() },
    { label: 'Open in the browser', icon: 'i-link', hidden: !url, action: () => { if (url) void openExternal(url.href); } },
    {
      label: 'Copy',
      action: () => {
        const text = copyItems([id]);
        if (text) navigator.clipboard?.writeText(text).catch(() => {});
      },
    },
    { sep: true },
    { label: 'Close', icon: 'i-close', action: closeViewer },
  ];
}

/**
 * Everything this viewing was holding, put down.
 *
 * A <video> left in a detached subtree keeps its decoder (and, on some
 * engines, keeps playing), so it's stopped and emptied by hand. Nothing else
 * needs releasing: every other URL comes from assetURL(), which mints one
 * per asset for the board's life and revokes them all on close.
 */
function teardown() {
  for (const el of bodyEl?.querySelectorAll?.<HTMLMediaElement>('video, audio') || []) {
    try { el.pause(); } catch { /* already gone */ }
    el.removeAttribute('src');
    el.load?.();
  }
  // A document's pictures come out of its own container as blob URLs this
  // app minted outside the asset store - nothing else will ever revoke them.
  releaseDoc?.();
  releaseDoc = null;
  // The parsed PDF holds the whole file plus its object graph. Body is
  // emptied below too, which also stops a render batch still in flight.
  pdfDoc?.destroy();
  pdfDoc = null;
  // The zoom's listeners are mostly on the picture (about to be discarded),
  // but the resize and stage-click listeners are not - this removes those,
  // and must run before the body is emptied.
  detachZoom?.();
  detachZoom = null;
  zoomReset = null;
  // The document is saved on the way out. Its text lives in the editor's model,
  // not in the page, so emptying the body below does not take it with it.
  if (editing) {
    const s = editing;
    editing = null;
    s.editor.destroy();
    s.release();
    void saveEdit(s);
  }
  shownId = null;
  bodyEl?.replaceChildren();
  // Typing held for a document that never opened goes with the viewing.
  dlg!.querySelector('.viewer-hold')?.remove();
  dlg!.querySelector('.viewer-grow')?.remove();
  arriving?.over?.();
  arriving = null;
  dlg!.classList.remove('is-arriving');
  delete dlg!.dataset.type;
  delete dlg!.dataset.media;
  delete dlg!.dataset.edit;
}

// ---------------------------------------------------------------------------
// Zoom and pan, for the one view that is looked at rather than read
// ---------------------------------------------------------------------------

/** Torn down with the viewing. See teardown(). */
let detachZoom: (() => void) | null = null;
/** Back to fitted, for the right-click's Fit row. Torn down with the zoom. */
let zoomReset: (() => void) | null = null;

/** How far in a picture goes. Past this a photograph is pixels, not detail. */
const ZOOM_MAX = 8;
/** What one plain click asks for, which is a look rather than an inspection. */
const ZOOM_CLICK = 2.5;
/** Movement past this, in screen pixels, makes a press a drag and not a click. */
const DRAG_SLOP = 6;

/**
 * Wheel, pinch and drag over an open picture. Fitting to the window handles
 * "too small to see" only partly - a 6000px scan fitted to a laptop is
 * still a tenth its own detail.
 *
 * **One transform on the picture itself**, no wrapper - `translate(...)
 * scale(...)` on the element's own style, cheapest for the compositor and
 * survives the picture being swapped underneath (crop's display copy
 * replaces `src`, not the node).
 *
 * **The zoom goes to the pointer, not the middle** - keeps the point under
 * the cursor fixed; zooming to centre is what makes other viewers feel like
 * they're fighting you. **The pan is clamped, not free**: half the scaled
 * picture past the window edge plus a margin, so a fling can't lose it
 * off-screen. Returns its own detach, since two of the four listeners
 * aren't on the picture and would outlive it.
 */
function attachZoomPan(img: HTMLElement, stage: HTMLElement): () => void {
  let scale = 1, tx = 0, ty = 0;
  // Whatever the view already wrote (the mirror, see the image view above),
  // read once and kept underneath - so this knows nothing about flips and
  // any future base transform composes the same way.
  //
  // Last in the list, so it applies *first* (CSS transform lists apply
  // right to left): turn in the picture's own space, then pan/zoom in the
  // window's - the only order where a drag on a mirrored photo still
  // follows the hand.
  const base = img.style.transform;

  const paint = () => {
    img.style.transform =
      scale === 1 ? base : `translate(${tx}px, ${ty}px) scale(${scale}) ${base}`.trimEnd();
    img.classList.toggle('is-zoomed', scale > 1);
  };
  const reset = () => { scale = 1; tx = 0; ty = 0; paint(); };
  zoomReset = reset;

  const clampPan = () => {
    // offsetWidth is the laid-out (fitted) size - the transform doesn't
    // touch it, which is what keeps this stable while scale changes.
    const w = img.offsetWidth || 1;
    const h = img.offsetHeight || 1;
    const maxX = Math.max(0, (w * scale - innerWidth) / 2) + 40;
    const maxY = Math.max(0, (h * scale - innerHeight) / 2) + 40;
    tx = Math.min(maxX, Math.max(-maxX, tx));
    ty = Math.min(maxY, Math.max(-maxY, ty));
  };

  const zoomTo = (next: number, cx: number, cy: number) => {
    const ns = Math.min(ZOOM_MAX, Math.max(1, next));
    if (ns === scale) return;
    const r = img.getBoundingClientRect();
    const dx = cx - (r.left + r.width / 2);
    const dy = cy - (r.top + r.height / 2);
    tx += dx * (1 - ns / scale);
    ty += dy * (1 - ns / scale);
    scale = ns;
    // All the way out is all the way back - an offset picture at scale 1 is
    // sitting somewhere nobody put it.
    if (scale === 1) { tx = 0; ty = 0; }
    clampPan();
    paint();
  };

  const onWheel = (e: WheelEvent) => {
    e.preventDefault();
    zoomTo(scale * Math.exp(-e.deltaY * 0.0015), e.clientX, e.clientY);
  };

  // pointerId -> where it is now. Two of these is a pinch; one is a drag.
  const points = new Map<number, { x: number, y: number }>();
  let pinchFrom = 0, pinchScale = 1, lastX = 0, lastY = 0;
  let downX = 0, downY = 0, dragging = false, moved = false;

  const onDown = (e: PointerEvent) => {
    img.setPointerCapture(e.pointerId);
    points.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (points.size === 1) { downX = e.clientX; downY = e.clientY; moved = false; }
    if (points.size === 2) {
      const [a, b] = [...points.values()];
      pinchFrom = Math.hypot(a.x - b.x, a.y - b.y);
      pinchScale = scale;
      dragging = false;
      // A pinch that ended where it started is still a pinch, never a click.
      moved = true;
    } else if (scale > 1) {
      dragging = true;
      lastX = e.clientX;
      lastY = e.clientY;
      img.classList.add('is-panning');
    }
  };

  const onMove = (e: PointerEvent) => {
    if (!points.has(e.pointerId)) return;
    points.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (Math.hypot(e.clientX - downX, e.clientY - downY) > DRAG_SLOP) moved = true;
    if (points.size === 2 && pinchFrom) {
      const [a, b] = [...points.values()];
      const now = Math.hypot(a.x - b.x, a.y - b.y);
      zoomTo(pinchScale * (now / pinchFrom), (a.x + b.x) / 2, (a.y + b.y) / 2);
      return;
    }
    if (!dragging) return;
    tx += e.clientX - lastX;
    ty += e.clientY - lastY;
    lastX = e.clientX;
    lastY = e.clientY;
    clampPan();
    paint();
  };

  const onUp = (e: PointerEvent) => {
    points.delete(e.pointerId);
    if (points.size < 2) pinchFrom = 0;
    if (!points.size) {
      dragging = false;
      img.classList.remove('is-panning');
    }
  };

  // A plain click zooms in to the pointer, or back out - guarded by `moved`,
  // or the lift at the end of every pan would toggle it.
  const onClick = (e: MouseEvent) => {
    if (moved) { moved = false; return; }
    if (scale > 1) reset();
    else zoomTo(ZOOM_CLICK, e.clientX, e.clientY);
  };

  // The ground around the picture is the way out - only the stage itself; a
  // press that reached the picture is handled above and never arrives here.
  const onStageClick = (e: MouseEvent) => { if (e.target === stage) closeViewer(); };

  // A resized window re-fits the picture under a transform computed against
  // the old one; resetting is the one answer that can't be subtly wrong.
  const onResize = () => { if (scale !== 1) reset(); };

  img.addEventListener('wheel', onWheel, { passive: false });
  img.addEventListener('pointerdown', onDown);
  img.addEventListener('pointermove', onMove);
  img.addEventListener('pointerup', onUp);
  img.addEventListener('pointercancel', onUp);
  img.addEventListener('click', onClick);
  stage.addEventListener('click', onStageClick);
  addEventListener('resize', onResize);

  return () => {
    stage.removeEventListener('click', onStageClick);
    removeEventListener('resize', onResize);
    // Back to the base, not to nothing - this may already be a mirrored
    // picture, and detaching the zoom isn't an undo of the flip.
    img.style.transform = base;
  };
}

/** The line under the name: what the file is and how big. */
function describe(item: Item) {
  const asset = item.asset?.hash ? getAsset(item.asset.hash) : null;
  const ext = str(item.meta?.ext).toUpperCase();
  return [ext, asset && formatBytes(asset.size)].filter(Boolean).join(' · ');
}

// ---------------------------------------------------------------------------
// The views
// ---------------------------------------------------------------------------

/** One entry of the table below: an item, and the body it fills. */
type View = (item: Item, host: HTMLElement, open?: OpenOptions) => void;

const VIEWS: Record<string, View> = {
  /**
   * A picture, at its own size or the window's, whichever is smaller.
   *
   * The original asset, not meta.thumb/preview - the one place the full-size
   * file is wanted, since every other surface shows it inside a box. The
   * preview is the fallback, and the only thing that draws for an
   * undecodable original (HEIC, RAW).
   */
  image(item, host) {
    const url = urlOf(item.asset?.hash) || urlOf(item.meta?.preview);
    if (!url) return void host.append(nothing('That picture is not in this board'));
    const img = document.createElement('img');
    img.className = 'viewer-media';
    img.alt = item.name || '';
    img.decoding = 'async';
    // A cropped picture shows cropped, via the display copy canvas/display.ts
    // bakes - the one case where the viewer deliberately doesn't show the
    // original file. Bounded by the quality dial's sharpness, a real
    // resolution loss traded for agreeing with the card. Quarter turn and
    // background removal ride the same pipe, since neither has a CSS
    // spelling over the original the way grade and mirror do below.
    //
    // **An edited picture waits for its copy rather than showing the
    // original first** - full-screen is the worst place to flash a cut-out
    // with its background on and then lose it. A blank instant is the
    // better trade, and usually not even that - the just-clicked card has
    // normally already made the copy.
    const crop = itemCrop(item);
    const rot = itemRotate(item);
    const matte = itemMatte(item);
    const hash = item.asset?.hash;
    const edited = !!(crop || rot || matte) && !!hash;
    const ready = edited && hash ? displayURLReady(hash, crop, rot, matte) : null;
    if (ready) img.src = ready;
    else if (!edited) img.src = url;
    if (edited && hash && !ready) {
      ensureDisplay(hash, crop, rot, matte).then(u => {
        // A copy that couldn't be made falls back to the original - wrong,
        // but still better than an empty viewer over a picture that exists.
        const src = u || url;
        if (img.isConnected || !img.src) img.src = src;
      });
    }
    // The grade is a filter and applies whatever the source, riding on top of either branch.
    const adjust = itemAdjust(item);
    if (adjust) {
      img.style.filter =
        `brightness(${adjust.brightness}) contrast(${adjust.contrast}) saturate(${adjust.saturation})`;
    }
    // The mirror, same reasoning, written before the zoom is attached:
    // attachZoomPan() reads this as the base it composes onto. See flipTransform().
    const flip = flipTransform(item);
    if (flip) img.style.transform = flip;
    host.append(img);
  },

  /**
   * A clip, with the browser's own controls. Its poster is on it so the
   * frame is there before the first byte of video is. Not autoplaying:
   * opening a thing isn't asking it to start.
   */
  video(item, host) {
    const url = urlOf(item.asset?.hash);
    if (!url) return void host.append(nothing('That clip is not in this board'));
    const el = document.createElement('video');
    el.className = 'viewer-media';
    el.controls = true;
    el.playsInline = true;
    el.preload = 'metadata';
    const poster = urlOf(item.meta?.cover || item.meta?.poster);
    if (poster) el.poster = poster;
    el.src = url;
    // The grade, as on the card. A clip can be adjusted, not cropped - see
    // setItemCrop() in state.ts.
    const adjust = itemAdjust(item);
    if (adjust) {
      el.style.filter =
        `brightness(${adjust.brightness}) contrast(${adjust.contrast}) saturate(${adjust.saturation})`;
    }
    host.append(el);
  },

  /** A sound file, with its cover above it when it carries one. */
  audio(item, host) {
    const cover = urlOf(item.meta?.cover);
    if (cover) {
      const art = document.createElement('img');
      art.className = 'viewer-cover';
      art.alt = '';
      art.src = cover;
      host.append(art);
    }
    const url = urlOf(item.asset?.hash);
    if (!url) return void host.append(nothing('That track is not in this board'));
    const el = document.createElement('audio');
    el.className = 'viewer-audio';
    el.controls = true;
    el.preload = 'metadata';
    el.src = url;
    host.append(el);
  },

  /**
   * A text file, whole and scrolling - as prose if Markdown, as source if
   * anything else. Split by extension only: Markdown is the one format
   * meant to be *read*, and rendering the rest (JSON, CSS, a log) would be
   * the viewer second-guessing the reader.
   *
   * Both paths end in text nodes - <pre>/textContent for source, and for
   * Markdown, ui/markdown.ts builds DOM without innerHTML, so raw HTML in
   * the file shows as characters rather than running. Not a nicety: these
   * are files the app did not write.
   *
   * Asked to edit, a .md, .txt or .fountain opens in the editor instead - see
   * editDocument(). Opening is reading; editing is its own row in the menu.
   */
  text(item, host, open) {
    // Every way out of it ends a grow still waiting, the plain way if no page was made.
    if (open?.edit && EDITABLE.has(str(item.meta?.ext)) && item.asset?.hash) return void editDocument(item, host, open).finally(() => arrive());
    readOnlyText(item, host);
  },

  /** A sticky, at reading size rather than at whatever the board shrank it to. */
  note(item, host) {
    const sheet = document.createElement('div');
    sheet.className = 'viewer-note-sheet';
    // The rich body is a note's own structure out of a file, walked as
    // unknown: a blocks array of anything, keeping `text` only where present.
    const rich = item.meta?.rich;
    const blocks = rich && typeof rich === 'object' && 'blocks' in rich
      && Array.isArray(rich.blocks) ? rich.blocks : null;
    sheet.textContent = blocks?.length
      ? blocks.map(b => (b && typeof b === 'object' && 'text' in b ? str(b.text) : '')).join('\n').trim()
      : (str(item.meta?.text) || item.name || '').trim();
    // meta.tint, not meta.color - see noteTint(). `color` is a key nothing
    // in the app has written.
    const tint = noteTint(item.meta?.tint);
    if (tint) sheet.style.background = `var(--note-${tint})`;
    host.append(sheet);
  },

  /** A link: its player where it has one (YouTube, Spotify), else its address
   *  large with a way to follow it. This is where a YouTube link plays now -
   *  off the board, in the popup - reached by the menu's Open (see openLink). */
  link(item, host) {
    const u = linkURL(item.meta?.url);
    if (!u) return void host.append(nothing('That is not an address this app will open'));
    // An embeddable link fills the viewer with its player. frameFor carries the
    // sandbox and referrer policy the board card uses (canvas/embed.ts); the
    // frame stops loading when the body is emptied on close.
    const spec = embedFor(u);
    if (spec) {
      const wrap = document.createElement('div');
      wrap.className = 'viewer-embed';
      wrap.dataset.provider = spec.provider;
      wrap.append(frameFor(spec));
      host.append(wrap);
      return;
    }
    const a = document.createElement('a');
    a.className = 'viewer-link';
    a.href = u.href;
    a.target = '_blank';
    a.rel = 'noopener';
    a.textContent = u.href;
    host.append(a);
  },
};

/** A text file to read: rendered if Markdown, as source otherwise. `why` says why it is not editable. */
function readOnlyText(item: Item, host: HTMLElement, why = '') {
  const md = MARKDOWN.has(str(item.meta?.ext));
  const holder = document.createElement(md ? 'div' : 'pre');
  holder.className = md ? 'viewer-md' : 'viewer-text';
  // Wrapped to the page, unless the editor was told this is ASCII art, whose lines are the picture.
  holder.classList.toggle('is-ascii', item.meta?.ascii === true);
  dlg!.dataset.page = '';
  host.append(holder);
  if (why) holder.before(nothing(why));
  const hash = item.asset?.hash;
  if (!hash) return;
  readText(hash, TEXT_MAX).then(text => {
    if (!holder.isConnected) return;
    if (md) holder.append(renderMarkdown(text));
    else holder.textContent = text;
    if (text.length >= TEXT_MAX) {
      const more = document.createElement('p');
      more.className = 'viewer-note';
      more.textContent = `first ${formatBytes(TEXT_MAX)} shown`;
      holder.after(more);
    }
  }).catch(() => { holder.textContent = ''; });
}

/**
 * A .md or .txt, open to write in. The whole file or nothing: past EDIT_MAX
 * it asks first (a ceiling, consent.ts), and a file that is not clean UTF-8
 * opens to read, since writing it back would change bytes nobody touched.
 */
async function editDocument(item: Item, host: HTMLElement, open: OpenOptions = {}) {
  const asset = getAsset(item.asset?.hash);
  if (!asset) return void host.append(nothing('That file is not in this board'));
  // Full-window before the first await: growFrom() measures the dialog as soon
  // as it opens, and it should grow into the room the page will have.
  dlg!.dataset.edit = '';
  const readOnly = (why: string) => {
    delete dlg!.dataset.edit;
    readOnlyText(item, host, why);
    // No sheet to grow into: a plain fade, rather than a viewing waiting unseen.
    arrive();
  };
  const waiting = nothing('Opening it…');
  host.append(waiting);
  const name = asset.name || item.name || 'document.md';
  try {
    measureForEdit(asset.size);
  } catch (err) {
    const go = await lift(err, fileKey({ name, size: asset.size }), `“${baseName(name) || name}” is large to edit.`, 'Edit');
    if (!waiting.isConnected) return;
    if (!go) {
      waiting.remove();
      return void readOnly('Opened to read. Too large to edit here without asking.');
    }
  }
  const bytes = new Uint8Array(await asset.blob.arrayBuffer());
  if (!waiting.isConnected) return;
  // BOM kept as a character, so it goes back on - see parseMarkdown().
  const text = new TextDecoder('utf-8', { ignoreBOM: true }).decode(bytes);
  const again = new TextEncoder().encode(text);
  if (again.length !== bytes.length || again.some((b, n) => b !== bytes[n])) {
    waiting.remove();
    return void readOnly('Opened to read. This file is not UTF-8 text, and saving it would change it.');
  }
  const ext = str(item.meta?.ext);
  let session: EditSession | null = null;
  // The text as of the last change, which says where the next one was (OpenOptions.note).
  let before = text;
  /**
   * A sticky's document written back down to fit: nothing of this editing is
   * written - a save still hashing lands nowhere and a save made is taken back -
   * and once the editor is out of its own input handler, it closes on a sticky.
   */
  const unfile = (s: EditSession, note: NonNullable<OpenOptions['note']>) => {
    if (s.gen < 0) return true;
    const now = s.editor.text();
    const was = before;
    before = now;
    if (!note.fits(now)) return false;
    clearTimeout(s.timer);
    s.saved = now;
    s.gen = -1;
    takeBack(s.step);
    s.step = null;
    // The viewing stays up to go back into the sticky, and shrinkInto() closes it.
    queueMicrotask(() => note.back(now, was, shrinkInto));
    return true;
  };
  const editor = mountEditor({
    text,
    plain: !MARKDOWN.has(ext),
    screen: ext === 'fountain',
    label: baseName(item.name) || item.name || 'Document',
    caret: open.caret ?? 'start',
    onChange: () => {
      if (!session) return;
      if (open.note && unfile(session, open.note)) return;
      clearTimeout(session.timer);
      session.timer = window.setTimeout(() => { if (session) void saveEdit(session); }, IDLE_SAVE_MS);
    },
    onSave: () => { if (session) void saveEdit(session); },
    ascii: item.meta?.ascii === true,
    onAscii: on => setItemAscii(item.id, on),
    name: shownName(item),
    onRename: typed => {
      // The extension stays on, as the card's name had it: the title is what is typed.
      // Cleared, the document is untitled - its kind is in meta.ext, not the name.
      const was = byId(item.id);
      const tail = ext && was?.name.toLowerCase().endsWith(`.${ext}`) ? was.name.slice(-(ext.length + 1)) : '';
      renameItem(item.id, typed ? typed + tail : '', { blank: true });
      const now = byId(item.id);
      if (now) titleEl!.textContent = shownName(now) || 'Untitled';
      return now ? shownName(now) : typed;
    },
  });
  // A phone keyboard covers the bottom of the window without resizing it, so
  // its height is followed and the dialog ends above it (editor.css, --kb).
  const vv = globalThis.visualViewport;
  const fit = () => {
    if (vv) dlg!.style.setProperty('--kb', `${Math.max(0, Math.round(innerHeight - vv.height - vv.offsetTop))}px`);
  };
  vv?.addEventListener('resize', fit);
  fit();
  session = {
    editor, id: item.id, name,
    mime: asset.mime || (MARKDOWN.has(ext) ? 'text/markdown' : 'text/plain'),
    saved: text, step: null, gen: boardGen, timer: 0, chain: Promise.resolve(),
    release: () => {
      vv?.removeEventListener('resize', fit);
      dlg!.style.removeProperty('--kb');
    },
  };
  editing = session;
  waiting.replaceWith(editor.el);
  editor.focus();
  const held = (open.typed ?? '') + (open.held?.take() ?? '');
  if (held) editor.type(held);
  // Measured last: focusing and typing can scroll the page.
  arrive(editor.el.querySelector<HTMLElement>('.ed-sheet'));
}

/** An item's name as its title: without the extension, as the viewer's head shows it. */
const shownName = (item: Item) => baseName(item.name) || item.name || '';

/**
 * A document, read out of its own container. Asynchronous and slow enough
 * to say so: a .docx has to be unzipped, its XML parsed and pictures
 * decoded, with the dialog already open. A line of text meanwhile beats a
 * blank sheet that looks empty.
 */
function documentView(item: Item, host: HTMLElement) {
  const asset = getAsset(item.asset?.hash);
  if (!asset) return void host.append(nothing('That file is not in this board'));
  const waiting = nothing('Reading it…');
  host.append(waiting);
  readDocument(asset.blob, item.meta?.ext)
    .then(({ node, release }) => {
      if (!waiting.isConnected) { release(); return; }
      releaseDoc = release;
      waiting.replaceWith(node);
    })
    .catch(err => {
      if (!waiting.isConnected) return;
      // The reader's own message where it has one ("that presentation has
      // no slides" says more than "could not be read"), else a plain fallback.
      waiting.textContent = err?.message || 'That file could not be read';
    });
}

/** How many pages of a PDF are rendered before it waits to be asked for more. */
const PDF_BATCH = 5;

/**
 * A PDF, page by page. Rendering a page-description language is an
 * interpreter - the app's first outside-code dependency (import/pdf.ts),
 * vendored and served from this origin, so no third party is reached and it
 * works offline once cached.
 *
 * In batches: a two-hundred-page report rendered eagerly is two hundred
 * canvases and a stalled tab. Five is about a screenful and a half; the
 * button below asks for five more.
 */
function pdfView(item: Item, host: HTMLElement) {
  const asset = getAsset(item.asset?.hash);
  if (!asset) return void host.append(nothing('That file is not in this board'));
  const waiting = nothing('Opening it…');
  host.append(waiting);

  const pages = document.createElement('div');
  pages.className = 'doc-pages';

  import('../import/pdf.ts').then(({ openPdf }) => openPdf(asset.blob)).then(async doc => {
    if (!waiting.isConnected) { doc.destroy(); return; }
    pdfDoc = doc;
    waiting.replaceWith(pages);
    // The width to draw at, from the box it's going into, at device
    // resolution so it's sharp on a phone and a retina display.
    const width = Math.max(320, pages.clientWidth || bodyEl!.clientWidth || 800)
      * Math.min(2, globalThis.devicePixelRatio || 1);
    let shown = 0;
    const more = document.createElement('button');
    more.type = 'button';
    more.className = 'viewer-more';

    const batch = async () => {
      more.disabled = true;
      const to = Math.min(doc.pages, shown + PDF_BATCH);
      for (let n = shown + 1; n <= to; n++) {
        // Checked every page: closing the dialog mid-batch must stop the
        // work rather than finish it into a node nobody sees.
        if (!pages.isConnected) return;
        try {
          const canvas = await doc.render(n, width);
          canvas.className = 'doc-page';
          pages.append(canvas);
        } catch {
          const bad = document.createElement('p');
          bad.className = 'doc-missing';
          bad.textContent = `Page ${n} could not be drawn.`;
          pages.append(bad);
        }
      }
      shown = to;
      more.disabled = false;
      if (shown >= doc.pages) more.remove();
      else {
        more.textContent = `Show more (${shown} of ${doc.pages})`;
        pages.after(more);
      }
    };

    more.addEventListener('click', batch);
    await batch();
  }).catch(err => {
    // Used to blame an offline session, right when the renderer came off a
    // CDN - now it's vendored, so the honest remaining cases are an
    // unparseable file or a first-ever PDF with no connection yet.
    console.warn('[mbrd] pdf: the document would not open', err);
    if (!waiting.isConnected) return;
    waiting.textContent = 'That PDF could not be opened. Either the file is one the page '
      + 'renderer cannot read, or this is the first PDF since installing and the renderer '
      + 'has not been fetched yet.';
  });
}

/** A card is not always openable, and saying so beats an empty sheet. */
function nothing(words: string) {
  const p = document.createElement('p');
  p.className = 'viewer-note';
  p.textContent = words;
  return p;
}
