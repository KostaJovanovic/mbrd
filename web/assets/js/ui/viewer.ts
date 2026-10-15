// Viewer: one item at full size in a showModal() <dialog>. VIEWS table keyed
// by item type (same shape as RENDERERS). Teardown is load-bearing: mounted
// videos keep their decoder, blob URLs must be revoked, parsed PDFs hold the
// whole file, and an open document is saved. A .md, .txt, .fountain or .tex
// opened to edit goes to the text editor (ui/editor/) - a .tex with its preview
// beside it (ui/latex-doc.ts); opened plainly, it is read.
// No document reach at import time (tests/imports.test.js).

import {
  board, bus, byId, select, itemAdjust, itemCrop, itemRotate, itemMatte, flipTransform, setItemText,
  setItemAscii, renameItem, takeBack,
} from '../state.ts';
import type { Command } from '../state.ts';
import { copyItems } from '../clipboard.ts';
import { openAnchored, justDismissed } from './menu.ts';
import type { MenuEntry } from './menu.ts';
import { openExternal } from './leaving.ts';
import { displayURLReady, ensureDisplay } from '../canvas/display.ts';
import { travelMs, fastMs, baseMs } from '../canvas/viewport.ts';
// The card a picture closes back into, measured live: the board may have moved since it opened.
import { nodeFor } from '../canvas/items.ts';
import { addFile, assetURL, getAsset, readText } from '../storage/assets.ts';
import { fileKey, lift } from '../consent.ts';
import { mountEditor } from './editor/view.ts';
import type { Editor, EditorOptions } from './editor/view.ts';
import { measureForEdit } from './editor/markdown.ts';
import { baseName, copyText, formatBytes, icon, markClosed, wasClosed } from '../util.ts';
import { linkURL, MARKDOWN, enrichEmbedCard } from '../canvas/renderers.ts';
import { embedFor, frameFor } from '../canvas/embed.ts';
import { noteTint } from '../canvas/note-model.ts';
import type { NoteEntrance } from '../canvas/notes.ts';
import { kindName } from '../canvas/item-dom.ts';
import { renderMarkdown } from './markdown.ts';
import { LATEX, LATEX_SNIPPETS, latexPreview } from './latex-doc.ts';
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
const EDITABLE = new Set([...MARKDOWN, ...LATEX, 'txt', 'text', 'fountain']);

/** A pause in typing this long saves the document. */
const IDLE_SAVE_MS = 1500;

/**
 * Where to put the caret, and where a sticky that became this document was on
 * screen and in what colour. `held` is the typing done while it became one.
 */
type OpenOptions = {
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
type HeldTyping ={ take: () => string, into: (host: HTMLElement) => void };

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
/** The box the picture on show grew out of, kept for a close that cannot find its card again. */
let shownFrom: { id: string, rect: DOMRect } | null = null;

/** The one camera command the right-click needs. Injected: commands.ts imports this module. */
interface ViewerCommands {
  zoomToSelection: () => void;
  /** The ids the arrows step through, in order - see step(). */
  viewOrder: () => string[];
  canSaveItemFile: (id: string) => boolean;
  saveItemFile: (id: string) => void;
  canSendItemFile: (id: string) => boolean;
  sendItemFile: (id: string) => void;
  canEditPicture: (id: string) => boolean;
  editPicture: (id: string) => void;
  /** Bin one card, with the receipt Delete gives. */
  binItem: (id: string) => void;
}
let cmds: ViewerCommands | null = null;

/** The press-and-hold that opens the menu on touch, as the Feed's does. */
const HOLD_MS = 500;
const HOLD_SLOP = 10;
let hold: { id: number, x: number, y: number, timer: number } | null = null;
/** The hold opened the menu: the tap that would follow is the hold's, not a zoom. */
let heldOpen = false;
const cancelHold = () => { if (hold) clearTimeout(hold.timer); hold = null; };

/** Open these N: the cards the arrows and swipes are held to for this viewing, or null for all. */
let among: Set<string> | null = null;

/**
 * Open the first of `ids` in reading order, with the steps held to them until
 * the viewer closes - a selection looked through on its own.
 */
export function openViewerAmong(ids: Iterable<string>, thumbOf: (id: string) => DOMRect | null) {
  const set = new Set(ids);
  const first = cmds?.viewOrder().find(id => set.has(id) && canView(id));
  if (!first) return false;
  openViewer(first, { thumb: thumbOf(first) });
  among = set;
  paintSteps();
  return true;
}

/** Show in Feed, injected: the Feed imports this module. See setRevealInFeed(). */
let revealInFeed: ((id: string) => boolean) | null = null;
export function setRevealInFeed(fn: (id: string) => boolean) { revealInFeed = fn; }

/** The menu, at a point or under a button. */
function openViewerMenu(rect: { left: number, right: number, top: number, bottom: number }, owner?: Element) {
  if (!shownId) return;
  openAnchored(rect, viewerEntries(shownId), { label: 'Viewer', owner, focus: !!owner });
}

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
    // The engines whose long press arrives as this event, before the timer.
    cancelHold();
    if (heldOpen) return;
    openViewerMenu({ left: e.clientX, right: e.clientX, top: e.clientY, bottom: e.clientY });
  });
  // The same menu, for a finger: the ⋯ in the head, and a press held still.
  const more = document.getElementById('viewer-more');
  more?.addEventListener('click', () => {
    // The press that closed this menu must not open it again (CLAUDE.md).
    if (justDismissed(more)) return;
    openViewerMenu(more.getBoundingClientRect(), more);
  });
  dlg.addEventListener('pointerdown', e => {
    heldOpen = false;
    cancelHold();
    if (e.pointerType !== 'touch' || !e.isPrimary || editing) return;
    if (!(e.target instanceof Element) || !e.target.closest('#viewer-body')) return;
    const x = e.clientX, y = e.clientY;
    hold = { id: e.pointerId, x, y, timer: setTimeout(() => {
      hold = null;
      heldOpen = true;
      openViewerMenu({ left: x, right: x, top: y, bottom: y });
    }, HOLD_MS) };
  });
  dlg.addEventListener('pointermove', e => {
    if (hold && (e.pointerId !== hold.id || Math.hypot(e.clientX - hold.x, e.clientY - hold.y) > HOLD_SLOP)) cancelHold();
  });
  dlg.addEventListener('pointerup', cancelHold);
  dlg.addEventListener('pointercancel', cancelHold);
  // The click a hold leaves behind would zoom the picture under the menu.
  dlg.addEventListener('click', e => {
    if (!heldOpen) return;
    heldOpen = false;
    e.stopPropagation();
    e.preventDefault();
  }, true);
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
  // Open these N lasts one viewing.
  dlg.addEventListener('close', () => { among = null; });
  // However it shut, a close still animating is over, and its held frames go with it.
  dlg.addEventListener('close', () => { if (closing) finishClose(); });
  // A press while a picture shrinks home is somebody already back at the board.
  dlg.addEventListener('pointerdown', () => { if (closing) finishClose(); }, true);
  // In a document, Escape (and Android's Back, which sends this) closes the
  // find bar before it closes the document.
  // A document otherwise goes the way it came, the paper dropping away (leave()).
  // Taken at the keydown, in the bubble phase so the find bar and the name
  // field have had their Escape first: a cancel event may only be refused
  // after a user activation, so refusing it there is not enough on its own.
  // A picture is taken here too, so Escape shrinks it home rather than cutting.
  dlg.addEventListener('keydown', e => {
    if (e.key !== 'Escape' || e.defaultPrevented || wasClosed(e)) return;
    if (!editing && !('media' in dlg!.dataset)) return;
    e.preventDefault();
    markClosed(e);
    closeViewer();
  });
  dlg.addEventListener('cancel', e => {
    if (editing?.editor.closeFind()) { e.preventDefault(); return; }
    if (editing) { e.preventDefault(); closeViewer(); }
  });
  wireSteps(dlg);
  // Counted before the close below, so a save the close starts knows the board is gone.
  bus.on('board:load', () => { boardGen++; });
  // A board swap takes the viewing with it, as it takes the sticker window: the
  // item it shows, and the blob URLs behind it, belonged to the board that left.
  // At once - no paper drops away over a board that has already changed.
  bus.on('board:load', () => closeViewer(true));
}

// ---------------------------------------------------------------------------
// Stepping: the previous and next thing on the board, without closing
// ---------------------------------------------------------------------------

/** The two edge buttons, built by wireSteps(). */
let stepBtns: HTMLButtonElement[] = [];

/** How far a finger has to travel sideways, in screen pixels, to be a swipe. */
const SWIPE_MIN = 60;

/**
 * Left and Right, two quiet buttons at the edges, and a sideways swipe on a
 * picture that is not zoomed: the previous and the next viewable item, in the
 * order cmds.viewOrder() gives. Looking through forty photographs was close,
 * find, double-click, forty times.
 *
 * Never while a document is being written: there the arrows move the caret,
 * and a step would tear down the editing under it. Nor from inside a field or a
 * clip's own controls, where the arrows already mean something.
 */
function wireSteps(d: HTMLDialogElement) {
  stepBtns = [-1, 1].map(dir => {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'viewer-step';
    b.dataset.step = String(dir);
    const label = dir < 0 ? 'Previous' : 'Next';
    b.setAttribute('aria-label', label);
    b.title = `${label}  ${dir < 0 ? '←' : '→'}`;
    b.append(icon(dir < 0 ? 'i-chevron-left' : 'i-chevron-right'));
    b.addEventListener('click', () => step(dir));
    d.append(b);
    return b;
  });
  d.addEventListener('keydown', e => {
    if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
    if (editing || e.defaultPrevented || e.altKey || e.ctrlKey || e.metaKey) return;
    const t = e.target;
    if (t instanceof HTMLElement && (t.isContentEditable || t.closest('input, textarea, select, video, audio'))) return;
    if (step(e.key === 'ArrowLeft' ? -1 : 1)) e.preventDefault();
  });
  // `on` once the finger has gone sideways and the picture follows it; `shown`
  // is where it was put, `v` the finger's speed in px/ms.
  let swipe: Swipe | null = null;
  const pictureOf = () => {
    const pic = bodyEl?.querySelector<HTMLImageElement>('img.viewer-media');
    return pic && !pic.classList.contains('is-zoomed') ? pic : null;
  };
  d.addEventListener('pointerdown', e => {
    // A second finger is a pinch: the picture goes back to the middle first.
    if (swipe?.on) swipeBack(pictureOf());
    swipe = e.pointerType === 'touch' && e.isPrimary
      ? { id: e.pointerId, x: e.clientX, y: e.clientY, on: false, dead: false, shown: 0, dx: 0, v: 0, t: e.timeStamp, prev: null, next: null }
      : null;
  });
  d.addEventListener('pointermove', e => {
    const s = swipe;
    if (!s || s.id !== e.pointerId || s.dead || editing || closing) return;
    const pic = pictureOf();
    if (!pic) return;
    const dx = e.clientX - s.x, dy = e.clientY - s.y;
    if (!s.on) {
      if (Math.hypot(dx, dy) < DRAG_SLOP) return;
      if (Math.abs(dx) < 2 * Math.abs(dy)) { s.dead = true; return; }
      s.on = true;
      s.prev = neighbour(-1);
      s.next = neighbour(1);
      // Caught mid-slide: from where it is, not from where it was going.
      const at = parseFloat(getComputedStyle(pic).translate) || 0;
      for (const a of pic.getAnimations()) a.cancel();
      s.x -= at;
      s.dx = dx + at;
      s.shown = at;
      s.t = e.timeStamp;
      pic.style.translate = `${at}px 0`;
      return;
    }
    const now = e.clientX - s.x;
    const dt = e.timeStamp - s.t;
    if (dt > 0) s.v = 0.8 * ((now - s.dx) / dt) + 0.2 * s.v;
    s.dx = now;
    s.t = e.timeStamp;
    // Nothing that way: it gives, and says the row ends here.
    s.shown = (now > 0 ? s.prev : s.next) ? now : give(now, innerWidth);
    pic.style.translate = `${s.shown}px 0`;
  });
  d.addEventListener('pointercancel', e => {
    if (swipe?.id !== e.pointerId) return;
    if (swipe.on) swipeBack(pictureOf());
    swipe = null;
  });
  d.addEventListener('pointerup', e => {
    const s = swipe;
    swipe = null;
    if (!s || s.id !== e.pointerId || editing) return;
    const pic = pictureOf();
    if (s.on && pic) {
      const dir = s.dx > 0 ? -1 : 1;
      // A flick counts if the finger was still moving, and the same way, as it lifted.
      const flick = Math.abs(s.v) > SWIPE_FLICK && Math.sign(s.v) === Math.sign(s.dx) && e.timeStamp - s.t < 80;
      if ((Math.abs(s.dx) >= SWIPE_MIN || flick) && (dir < 0 ? s.prev : s.next)) slide(dir, pic, s.shown);
      else swipeBack(pic);
      return;
    }
    // A zoomed picture's drag is its pan (attachZoomPan), never a step.
    if (s.on || bodyEl?.querySelector('.viewer-media.is-zoomed')) return;
    const dx = e.clientX - s.x, dy = e.clientY - s.y;
    if (Math.abs(dx) < SWIPE_MIN || Math.abs(dx) < 2 * Math.abs(dy)) return;
    step(dx > 0 ? -1 : 1);
  });
}

type Swipe = {
  id: number, x: number, y: number, on: boolean, dead: boolean, shown: number,
  dx: number, v: number, t: number, prev: string | null, next: string | null,
};

/** A lift faster than this, in px/ms, steps however short the swipe. */
const SWIPE_FLICK = 0.5;

/**
 * How far something follows a finger that has gone `over` past where it can
 * go: diminishing, never stopping dead and never keeping up. The board's own
 * curve (canvas/viewport.ts), copied rather than exported, since it is two lines.
 */
const RUBBER_K = 0.55;
const give = (over: number, dim: number) => (over * dim * RUBBER_K) / (dim + RUBBER_K * Math.abs(over));

/** A swipe that did not go far enough, the picture eased back to the middle. */
function swipeBack(pic: HTMLElement | null) {
  if (!pic) return;
  const from = pic.style.translate || '0px 0';
  pic.style.translate = '';
  const ms = travelMs() > 0 ? baseMs() : 0;
  if (ms > 0 && typeof pic.animate === 'function') {
    pic.animate([{ translate: from }, { translate: '0px 0' }], { duration: ms, easing: cssEase() });
  }
}

/**
 * The swipe carried through: the picture under the finger carries on out of
 * the stage and the next one comes in behind it, the two edge to edge, as a
 * strip of photographs. The old <img> is kept for the one animation, laid
 * over the stage where it was; step() has already put the rest of it down.
 */
function slide(dir: number, old: HTMLImageElement, shown: number) {
  const box = dlg!.getBoundingClientRect();
  const r = old.getBoundingClientRect();
  if (!step(dir)) return void swipeBack(old);
  const ms = travelMs() > 0 ? baseMs() : 0;
  const next = bodyEl!.firstElementChild;
  if (!(ms > 0) || typeof old.animate !== 'function' || !('media' in dlg!.dataset) || !(next instanceof HTMLElement)) return;
  const opts = { duration: ms, easing: cssEase() };
  old.className = 'viewer-slide';
  Object.assign(old.style, {
    left: `${r.left - shown - box.left}px`, top: `${r.top - box.top}px`,
    width: `${r.width}px`, height: `${r.height}px`,
  });
  dlg!.append(old);
  old.animate([{ translate: `${shown}px 0` }, { translate: `${-dir * box.width}px 0` }], { ...opts, fill: 'forwards' })
    .finished.then(() => old.remove(), () => old.remove());
  next.animate([{ translate: `${shown + dir * box.width}px 0` }, { translate: '0px 0' }], opts);
}

/** The nearest viewable item from the one on show, going `dir`, or null. */
function neighbour(dir: number): string | null {
  if (!shownId || !cmds) return null;
  const order = among ? cmds.viewOrder().filter(id => among!.has(id)) : cmds.viewOrder();
  const at = order.indexOf(shownId);
  if (at < 0) return null;
  for (let i = at + dir; i >= 0 && i < order.length; i += dir) {
    if (canView(order[i])) return order[i];
  }
  return null;
}

/**
 * Show the next item in the same viewing. The one on show is put down
 * properly first - teardown() is what stops a clip's decoder and lets a PDF go -
 * and openViewer() then fills the dialog it finds open. Answers whether it
 * stepped, so a key at either end falls through.
 */
function step(dir: number): boolean {
  if (editing || closing) return false;
  const next = neighbour(dir);
  if (!next) return false;
  teardown();
  openViewer(next);
  return true;
}

/** Each edge button only where there is somewhere to go. */
function paintSteps() {
  for (const b of stepBtns) b.hidden = !neighbour(Number(b.dataset.step));
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
  shownFrom = open.thumb ? { id, rect: open.thumb } : null;
  view(item, bodyEl!, open);
  // The picture, once mounted - a clip is left out deliberately: wheel/drag
  // over its controls should press them, not zoom.
  const pic = bodyEl!.querySelector<HTMLImageElement>('img.viewer-media');
  if (pic) detachZoom = attachZoomPan(pic, bodyEl!);
  // Open already when this is a step from the last item - see step().
  if (!dlg.open) dlg.showModal();
  paintSteps();
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
  // The mirror rides along underneath, or a flipped picture would turn over as it lands.
  const base = pic.style.transform;
  pic.animate([
    { transform: `translate(${dx}px, ${dy}px) scale(${s}) ${base}`.trimEnd() },
    { transform: base || 'none' },
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
  else if (!now && 'media' in dlg.dataset) shrinkPicture(shut);
  else shut();
}

/**
 * Where the item on show is now, on the board or in the Feed: its card if
 * that is laid out, else its tile. Asked at close, not kept from the open,
 * since the board may have moved underneath.
 */
function thumbOf(id: string): DOMRect | null {
  const tile = document.querySelector<HTMLElement>(`.feed-tile[data-id="${CSS.escape(id)}"]`);
  const card = nodeFor(id);
  // On a phone the Feed is what is showing, whatever the board has laid out underneath.
  for (const el of board.layoutMode === 'mobile' ? [tile, card] : [card, tile]) {
    const r = el?.isConnected ? el.getBoundingClientRect() : null;
    if (r?.width && r.height) return r;
  }
  return shownFrom?.id === id ? shownFrom.rect : null;
}

const onScreen = (r: DOMRect) => r.right > 0 && r.bottom > 0 && r.left < innerWidth && r.top < innerHeight;

/**
 * A picture going back the way it came: the open's grow (growPicture) played
 * the other way, from wherever the zoom has it into the card's box, while the
 * stage and the head fade from around it. A card off screen has nowhere to be
 * flown to, and the viewing fades instead, as it does with motion reduced.
 * Not shielded from presses: one during the close finishes it (initViewer).
 */
function shrinkPicture(done: () => void) {
  const d = dlg!;
  if (typeof d.animate !== 'function') return done();
  const ms = travelMs();
  const pic = bodyEl?.querySelector<HTMLImageElement>('img.viewer-media');
  const to = shownId ? thumbOf(shownId) : null;
  const hold = { fill: 'forwards' as const, easing: 'ease-out' };
  // The dimmed board behind goes with it; an engine that cannot animate a pseudo-element just cuts it at the end.
  const backdrop = (duration: number) => {
    try { return [d.animate([{ opacity: 1 }, { opacity: 0 }], { ...hold, duration, pseudoElement: '::backdrop' })]; }
    catch { return []; }
  };
  let anims: Animation[];
  if (pic && to && ms > 0 && onScreen(to)) {
    const long = ms * 0.6;
    // Where the zoom has it now, and where it sits unzoomed: the flight starts at one and is measured from the other.
    const live = getComputedStyle(pic).transform;
    const was = pic.style.transform;
    const item = shownId ? byId(shownId) : null;
    const base = (item && flipTransform(item)) || '';
    pic.style.transition = '';
    pic.style.transform = base;
    const r = pic.getBoundingClientRect();
    pic.style.transform = was;
    if (!r.width || !r.height) return done();
    const s = Math.max(to.width / r.width, to.height / r.height);
    const dx = (to.left + to.width / 2) - (r.left + r.width / 2);
    const dy = (to.top + to.height / 2) - (r.top + r.height / 2);
    anims = [
      pic.animate([
        { transform: live },
        { transform: `translate(${dx}px, ${dy}px) scale(${s}) ${base}`.trimEnd() },
      ], { ...hold, duration: long, easing: cssEase() }),
      // Out over the last stretch, so the photograph hands over to the card rather than covering it.
      pic.animate([{ opacity: 1 }, { opacity: 1, offset: 0.75 }, { opacity: 0 }], { ...hold, duration: long }),
      d.animate([
        { backgroundColor: getComputedStyle(d).backgroundColor, boxShadow: getComputedStyle(d).boxShadow },
        { backgroundColor: 'transparent', boxShadow: 'none' },
      ], { ...hold, duration: long * 0.8 }),
      ...[...d.querySelectorAll<HTMLElement>('#viewer-head, .viewer-step')].map(part =>
        part.animate([{ opacity: 1 }, { opacity: 0 }], { ...hold, duration: long * 0.4 })),
      ...backdrop(long),
    ];
  } else {
    const fast = fastMs();
    if (!(fast > 1)) return done();
    anims = [d.animate([{ opacity: 1 }, { opacity: 0 }], { ...hold, duration: fast }), ...backdrop(fast)];
  }
  closing = { anims, done };
  anims[0].finished.then(() => { if (closing?.anims === anims) finishClose(); }, () => {});
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
    // The Feed's way back to the tile: its wall scrolled there and the tile lit,
    // as Find does it.
    {
      label: 'Show in Feed',
      icon: 'i-zoom-to',
      hidden: !revealInFeed || board.layoutMode !== 'mobile',
      action: () => {
        closeViewer(true);
        revealInFeed?.(id);
      },
    },
    // A document being read turns to writing where it is: the same viewing, reopened to edit.
    { label: 'Edit', icon: 'i-edit-text', hidden: !canEdit(id) || !!editing, action: () => openViewer(id, { edit: true }) },
    // The darkroom is a dialog of its own; the viewing is put down first.
    { label: 'Edit picture…', icon: 'i-crop', hidden: !cmds?.canEditPicture(id),
      action: () => { closeViewer(true); cmds?.editPicture(id); } },
    { label: 'Fit to the window', hidden: !zoomed, action: () => zoomReset?.() },
    { label: 'Open in the browser', icon: 'i-link', hidden: !url, action: () => { if (url) void openExternal(url.href); } },
    // The file on show, as it arrived - the card menu's two rows, here too.
    { label: 'Save the file', icon: 'i-download', hidden: !cmds?.canSaveItemFile(id),
      action: () => cmds?.saveItemFile(id) },
    { label: 'Send the file', icon: 'i-share', hidden: !cmds?.canSendItemFile(id),
      action: () => cmds?.sendItemFile(id) },
    {
      label: 'Copy',
      action: () => {
        const text = copyItems([id]);
        if (text) void copyText(text);
      },
    },
    { sep: true },
    // Bins the card and shows the next one, so a run of photographs can be
    // culled from here. The bin and the toast's Undo bring a mistake back.
    { label: 'Delete', icon: 'i-delete', danger: true, hidden: !cmds || !!editing,
      action: () => {
        const next = neighbour(1) ?? neighbour(-1);
        cmds?.binItem(id);
        if (next) { teardown(); openViewer(next); } else closeViewer(true);
      } },
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
  shownFrom = null;
  bodyEl?.replaceChildren();
  // Typing held for a document that never opened goes with the viewing.
  dlg!.querySelector('.viewer-hold')?.remove();
  dlg!.querySelector('.viewer-grow')?.remove();
  for (const ghost of dlg!.querySelectorAll('.viewer-slide')) ghost.remove();
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
/** The thrown pan's decay, its least throw and its stop, in seconds and px/s: the board's glide (canvas/viewport.ts). */
const GLIDE_TAU = 0.34;
const GLIDE_MIN = 120;
const GLIDE_STOP = 8;

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
 * they're fighting you. **The pan is bounded, not free**: half the scaled
 * picture past the window edge plus a margin, so a fling can't lose it
 * off-screen. A finger may pull past that bound against a rubber band, and
 * the picture settles back when let go. Returns its own detach, since two of
 * the listeners aren't on the picture and would outlive it.
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

  // A click's zoom and fit are a step the eye has to follow, so they travel
  // for one paint; wheel, pinch and drag stay 1:1, as on the board.
  const eased = (move: () => void) => {
    const ms = travelMs() * 0.5;
    if (ms > 0) img.style.transition = `transform ${ms}ms ${cssEase()}`;
    move();
  };
  const still = () => { img.style.transition = ''; };
  const onSettled = (e: TransitionEvent) => { if (e.target === img && e.propertyName === 'transform') still(); };
  zoomReset = () => eased(reset);

  // The furthest the pan may sit from the middle, either way.
  const bounds = () => {
    // offsetWidth is the laid-out (fitted) size - the transform doesn't
    // touch it, which is what keeps this stable while scale changes.
    const w = img.offsetWidth || 1;
    const h = img.offsetHeight || 1;
    return {
      x: Math.max(0, (w * scale - innerWidth) / 2) + 40,
      y: Math.max(0, (h * scale - innerHeight) / 2) + 40,
    };
  };
  const clampPan = () => {
    const m = bounds();
    tx = Math.min(m.x, Math.max(-m.x, tx));
    ty = Math.min(m.y, Math.max(-m.y, ty));
  };
  /** A pan past its edge, given way to rather than stopped dead. */
  const band = (v: number, max: number, dim: number) =>
    (Math.abs(v) <= max ? v : Math.sign(v) * (max + give(Math.abs(v) - max, dim)));

  // The throw after a pan: the release speed decaying the way the board's
  // glide does, stopped at the edges rather than carried past them.
  let glide = 0;
  const stopGlide = () => { cancelAnimationFrame(glide); glide = 0; };
  const throwPan = (vx: number, vy: number) => {
    let last = performance.now();
    const tick = (now: number) => {
      const dt = Math.min(0.05, (now - last) / 1000);
      last = now;
      const decay = Math.exp(-dt / GLIDE_TAU);
      tx += vx * dt;
      ty += vy * dt;
      vx *= decay;
      vy *= decay;
      const m = bounds();
      if (Math.abs(tx) > m.x) vx = 0;
      if (Math.abs(ty) > m.y) vy = 0;
      clampPan();
      paint();
      glide = Math.hypot(vx, vy) > GLIDE_STOP ? requestAnimationFrame(tick) : 0;
    };
    glide = requestAnimationFrame(tick);
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
    still();
    stopGlide();
    zoomTo(scale * Math.exp(-e.deltaY * 0.0015), e.clientX, e.clientY);
  };

  // pointerId -> where it is now. Two of these is a pinch; one is a drag.
  const points = new Map<number, { x: number, y: number }>();
  let pinchFrom = 0, pinchScale = 1, lastX = 0, lastY = 0;
  let downX = 0, downY = 0, dragging = false, moved = false;
  // The pan the finger asked for, before the edges gave, and its speed in px/ms.
  let rx = 0, ry = 0, vx = 0, vy = 0, lastT = 0;

  const onDown = (e: PointerEvent) => {
    // Caught: whatever was travelling stops where it is, under the finger.
    still();
    stopGlide();
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
      rx = tx;
      ry = ty;
      vx = vy = 0;
      lastT = e.timeStamp;
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
    const ddx = e.clientX - lastX, ddy = e.clientY - lastY;
    rx += ddx;
    ry += ddy;
    const dt = e.timeStamp - lastT;
    if (dt > 0) {
      vx = 0.8 * (ddx / dt) + 0.2 * vx;
      vy = 0.8 * (ddy / dt) + 0.2 * vy;
    }
    lastX = e.clientX;
    lastY = e.clientY;
    lastT = e.timeStamp;
    const m = bounds();
    tx = band(rx, m.x, innerWidth);
    ty = band(ry, m.y, innerHeight);
    paint();
  };

  const onUp = (e: PointerEvent) => {
    points.delete(e.pointerId);
    if (points.size < 2) pinchFrom = 0;
    if (points.size) return;
    const panned = dragging;
    dragging = false;
    img.classList.remove('is-panning');
    if (!panned || scale <= 1) return;
    const m = bounds();
    // Let go past an edge: back inside, eased. A finger that had stopped throws nothing.
    if (Math.abs(tx) > m.x || Math.abs(ty) > m.y) eased(() => { clampPan(); paint(); });
    else if (travelMs() > 0 && e.timeStamp - lastT < 80 && Math.hypot(vx, vy) * 1000 > GLIDE_MIN) throwPan(vx * 1000, vy * 1000);
  };

  // A plain click zooms in to the pointer, or back out - guarded by `moved`,
  // or the lift at the end of every pan would toggle it.
  const onClick = (e: MouseEvent) => {
    if (moved) { moved = false; return; }
    eased(() => {
      if (scale > 1) reset();
      else zoomTo(ZOOM_CLICK, e.clientX, e.clientY);
    });
  };

  // The ground around the picture is the way out - only the stage itself; a
  // press that reached the picture is handled above and never arrives here.
  const onStageClick = (e: MouseEvent) => { if (e.target === stage) closeViewer(); };

  // A resized window re-fits the picture under a transform computed against
  // the old one; resetting is the one answer that can't be subtly wrong.
  const onResize = () => { stopGlide(); if (scale !== 1) reset(); };

  // The browser's own drag of an image, which cancels the pointer the pan is
  // following. viewer.css's -webkit-user-drag says the same, to Chromium only.
  const onDragStart = (e: DragEvent) => e.preventDefault();

  img.addEventListener('wheel', onWheel, { passive: false });
  img.addEventListener('dragstart', onDragStart);
  img.addEventListener('pointerdown', onDown);
  img.addEventListener('pointermove', onMove);
  img.addEventListener('pointerup', onUp);
  img.addEventListener('pointercancel', onUp);
  img.addEventListener('click', onClick);
  img.addEventListener('transitionend', onSettled);
  img.addEventListener('transitioncancel', onSettled);
  stage.addEventListener('click', onStageClick);
  addEventListener('resize', onResize);

  return () => {
    stopGlide();
    still();
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
      // The player is asking the provider now, so the card may as well learn its title.
      enrichEmbedCard(item);
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
  const ext = str(item.meta?.ext);
  const md = MARKDOWN.has(ext);
  const tex = LATEX.has(ext);
  const holder = document.createElement(md || tex ? 'div' : 'pre');
  holder.className = md ? 'viewer-md' : tex ? 'viewer-md viewer-tex' : 'viewer-text';
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
    else if (tex) holder.append(latexPreview(text));
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
    // LaTeX: its source on the left and the page it makes on the right, and
    // the pieces of one on a menu. ASCII art is not a question it asks.
    ...(LATEX.has(ext)
      ? { preview: latexPreview, previewLabel: 'LaTeX', snippets: LATEX_SNIPPETS }
      : { ascii: item.meta?.ascii === true, onAscii: (on: boolean) => setItemAscii(item.id, on) }),
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
    mime: asset.mime || (MARKDOWN.has(ext) ? 'text/markdown' : LATEX.has(ext) ? 'application/x-tex' : 'text/plain'),
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
