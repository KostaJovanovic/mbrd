// Note editor. Turns .note-rich into a contenteditable with a floating toolbar:
// title or text, face and marker per run, alignment for the whole sheet. A
// run's size is kept and drawn (older notes set one) but no longer offered.
// A button pressed on a selection restyles it; pressed on a caret it sets the
// look of what is typed next. Lines of runs live in meta.rich; meta.text is the
// plaintext kept for search. The box grows to fit (never hides text). A note
// whose content is just a URL becomes a link item on close — see linkify() —
// and one written past NOTE_SHEET_MAX becomes a .md document — see setNoteOverflow() —
// and a sticky again if written back down to fit in that editing (unfileNote()).

import {
  byId, bus, markDirty, setNoteContent, retypeItem, board, NOTE_SHEET_MAX,
  lastCommand, takeBack, removeItems,
} from '../state.ts';
import { nodeFor, onViewChange, refreshRings, screenBoxOf, viewportClientRect } from './items.ts';
import { travelMs } from './viewport.ts';
import { makeEditable, markClosed, readToken } from '../util.ts';
import { rotatedExtents } from '../geometry.ts';
import { linkURL, linkDraft } from './renderers.ts';
import {
  flattenNoteRich, buildNoteLine, normalizeRun, tidyRuns, styleOf, styleAt, locate, cutRuns,
  sliceLines, deleteRange, insertLines, restyle, withPending, linesLength, linesRich, linesMarkdown,
  normalizeNoteRich, NOTE_ALIGNS, NOTE_FONT_KEYS, NOTE_WASHES, NOTE_BLANK,
} from './note-model.ts';
import type { NoteAlign, NoteFont, NoteWash, NoteStyle, NoteLines, NoteRichInput } from './note-model.ts';
import type { Item } from '../board-model.ts';

/**
 * Injected menu opener — avoids importing ui/menu.ts (layering). main.ts wires
 * it; unwired, the control is inert.
 */
export type NoteMenu = (
  /** The control the menu hangs off. Its box, and its identity for the toggle. */
  anchor: HTMLElement,
  /** `swatch`: CSS colour chip in the row. Absent = no chip (marker "off" row). */
  rows: { value: string, label: string, swatch?: string }[],
  current: string,
  pick: (value: string) => void,
) => void;

let openMenu: NoteMenu | null = null;
export function setNoteMenu(fn: NoteMenu | null) { openMenu = fn; }

/**
 * Injected: replace note `id` with a .md document holding `markdown`, as one
 * undoable step. Resolves false if it could not. Injected because making a
 * document means hashing a file, which is import/'s job (layering). Unwired, a
 * note over the limit is cut to what a stored note may hold instead.
 *
 * `open` is given when the note outgrew itself mid-sentence: the document then
 * opens in the editor, the caret at `caret` (a line and column of `markdown`),
 * growing out of the note's box on screen, `from`.
 */
type NoteOpen = {
  caret: { line: number, col: number }, from: DOMRect | null, paper?: string,
  /** Typed again in the editor: space ending a title, which a Markdown heading does not keep. */
  typed?: string,
  /** The composer the note was written in, when it was, still on screen. */
  stay?: NoteStay,
};

/**
 * The composer a note outgrew itself in, left up with a still copy of the
 * sheet until the document is there to grow out of it. Closed at once, the
 * board showed for the frames the file takes to hash - the note small, at its
 * own place on the board - and the grow then started from somewhere else.
 * `host` is where typing is held meanwhile, since nothing outside a modal can
 * take focus; `go` takes the composer away, and only the first call counts.
 */
type NoteStay = { host: HTMLElement, go: () => void };

/**
 * How the composer comes up over what was on screen - a document going back
 * into its sticky. Called once: with where the sheet is and its colour, the
 * composer open and unseen until `show` brings it in; or with null, when there
 * is no composer to go into.
 */
export type NoteEntrance = (into: { sheet: DOMRect, paper: string, show: () => Promise<void> } | null) => void;
type NoteOverflow =(id: string, markdown: string, open?: NoteOpen) => Promise<boolean>;

let overflow: NoteOverflow | null = null;
export function setNoteOverflow(fn: NoteOverflow | null) { overflow = fn; }

/**
 * Height this note needs, in world px, for its text at `width`. Briefly
 * releases the flex child to natural height for measurement. No iteration —
 * margins are width-based, so the measured height is stable. `el` is the card
 * to measure, when the caller holds it - the composer's, which is out of the
 * world layer and not necessarily the one the board's map would name.
 */
function noteHeight(id: string, width?: number | null, el: HTMLElement | undefined = nodeFor(id)): number {
  const card = el?.querySelector<HTMLElement>('.card');
  const wrap = card?.querySelector<HTMLElement>('.note-rich');
  // If el is null, card is too — reached through it.
  if (!el || !card || !wrap) return 0;

  const prevWidth = el.style.width;
  // Must set --half-w alongside width — padding clamps on it, so measuring
  // one without the other gives wrong wrapping.
  const prevHalfW = el.style.getPropertyValue('--half-w');
  if (width != null) {
    el.style.width = width.toFixed(2) + 'px';
    el.style.setProperty('--half-w', (width / 2).toFixed(2) + 'px');
  }
  const prevFlex = wrap.style.flex;
  const prevHeight = wrap.style.height;
  const prevJustify = wrap.style.justifyContent;
  wrap.style.flex = '0 0 auto';
  wrap.style.height = 'auto';
  wrap.style.justifyContent = 'flex-start';

  const cs = getComputedStyle(card);
  const padding = parseFloat(cs.paddingTop) + parseFloat(cs.paddingBottom);
  // offsetHeight rounds down — ceil + 1px keeps descenders off the edge.
  const need = Math.ceil(padding + wrap.offsetHeight) + 1;

  wrap.style.flex = prevFlex;
  wrap.style.height = prevHeight;
  wrap.style.justifyContent = prevJustify;
  if (width != null) {
    el.style.width = prevWidth;
    // '' removes the property — correct restore when placeBox() has not set it yet.
    el.style.setProperty('--half-w', prevHalfW);
  }
  return need;
}

/**
 * Composer stand-in: when a note is open in the dialog at a different size,
 * growNote() calls this instead — keeps one growth path for all edits.
 */
let standIn: { id: string; fit: () => void } | null = null;

/**
 * Grow a note to fit its text. Never shrinks — a roomy note stays roomy. Not
 * undoable (part of the text arriving, not a separate edit). Composer notes
 * grow via standIn — their dialog size is not the board size.
 */
export function growNote(id: string) {
  if (standIn?.id === id) { standIn.fit(); return; }
  const it = byId(id);
  if (!it || it.type !== 'note') return;
  const need = noteHeight(id, it.w);
  if (!need || need <= it.h) return;
  it.h = need;
  bus.emit('geom', [id]);
  markDirty();
}

/** The shortest a note may be dragged at `width` - the height its text needs. */
export const noteFloor = (id: string, width?: number | null) => noteHeight(id, width);

// ---------------------------------------------------------------------------
// The DOM and the model. The editor reads the column back into lines of runs
// after the browser has typed into it, and writes lines of runs into it after
// anything the editor does itself - Enter, a join, a paste, a restyle.
// ---------------------------------------------------------------------------

/** A place in the DOM, as a selection names one. */
type Point = [Node, number];

/** A run's words as the DOM holds them, the blank stand-in taken out. */
const words = (el: Node) => (el.textContent ?? '').replaceAll(NOTE_BLANK, '');

/** The look a run's span carries, off its data attributes, through the model's allowlists. */
function spanStyle(span: HTMLElement, fallback: NoteStyle): NoteStyle {
  const d = span.dataset;
  return styleOf(normalizeRun({
    title: d.title === '1',
    font: d.font,
    size: d.size == null ? undefined : Number(d.size),
    wash: d.wash,
  }, fallback));
}

/**
 * The column as lines of runs, and where each of `points` falls in it as a
 * model position. `canon` is false when the DOM is not the shape
 * buildNoteLine() makes - a stray text node, a <br>, a blank beside words, a
 * run the browser split - which is the editor's cue to write it back clean.
 * Empty runs are kept: one is either a line's only run or the pending look at
 * the caret, and tidyRuns() is what decides which.
 */
function scan(wrap: HTMLElement, points: Point[], fallback: NoteStyle) {
  const lines: NoteLines = [];
  const at = points.map(() => -1);
  let canon = true;
  let base = 0;
  let cur: NoteLines[number] = [];
  let curLen = 0;
  const hit = (node: Node, off: number) => {
    points.forEach(([n, o], i) => { if (at[i] < 0 && n === node && o === off) at[i] = base + curLen; });
  };
  const text = (t: Text, style: NoteStyle) => {
    const raw = t.data;
    points.forEach(([n, o], i) => {
      if (at[i] < 0 && n === t) at[i] = base + curLen + raw.slice(0, o).replaceAll(NOTE_BLANK, '').length;
    });
    const said = raw.replaceAll(NOTE_BLANK, '').replace(/\n/g, ' ');
    if ((raw.includes(NOTE_BLANK) && said) || raw.includes('\n')) canon = false;
    cur.push({ ...style, text: said });
    curLen += said.length;
  };
  // depth 0 is the line itself, 1 inside a run, deeper is markup the browser made.
  const inline = (el: Node, style: NoteStyle, depth: number) => {
    const kids = el.childNodes;
    for (let k = 0; k < kids.length; k++) {
      hit(el, k);
      const c = kids[k];
      if (c instanceof Text) {
        if (depth === 0) canon = false;
        text(c, depth === 0 && cur.length ? styleOf(cur[cur.length - 1]) : style);
      } else if (c instanceof HTMLElement && depth === 0 && c.classList.contains('note-run')) {
        if (c.childNodes.length !== 1 || !(c.firstChild instanceof Text)) canon = false;
        inline(c, spanStyle(c, style), 1);
      } else {
        canon = false;
        if (c.nodeName !== 'BR') inline(c, style, depth + 1);
      }
    }
    hit(el, kids.length);
  };
  const flush = () => {
    lines.push(cur.length ? cur : [{ ...fallback, text: '' }]);
    base += curLen + 1;
    cur = [];
    curLen = 0;
  };
  const kids = wrap.childNodes;
  for (let k = 0; k < kids.length; k++) {
    hit(wrap, k);
    const c = kids[k];
    if (c instanceof HTMLElement && c.classList.contains('note-line')) {
      if (!c.firstChild) canon = false;
      inline(c, fallback, 0);
      flush();
    } else if (c.nodeName === 'BR' || (c instanceof Text && !c.data)) {
      canon = false;
    } else {
      // Something the browser put beside the lines: a line of its own.
      canon = false;
      if (c instanceof Text) text(c, fallback);
      else inline(c, fallback, 1);
      flush();
    }
  }
  // Past the last line is its end, not the start of a line that is not there.
  points.forEach(([n, o], i) => {
    if (at[i] < 0 && n === wrap && o === kids.length) at[i] = Math.max(0, base - 1);
  });
  if (!lines.length) { canon = false; lines.push([{ ...fallback, text: '' }]); }
  return { lines, canon, at };
}

/**
 * The DOM place for model position `pos`, in a column buildNoteLine() just
 * wrote. At the seam between two runs it takes the end of the first, so typing
 * carries on in the look of the character before the caret; in an empty run it
 * takes the place after the blank, so typing lands inside the run.
 */
function pointAt(wrap: HTMLElement, pos: number): Point {
  let p = Math.max(0, pos);
  const lines = [...wrap.children];
  for (let li = 0; li < lines.length; li++) {
    const spans = [...lines[li].children];
    const len = spans.reduce((n, s) => n + words(s).length, 0);
    if (p > len && li < lines.length - 1) { p -= len + 1; continue; }
    for (const s of spans) {
      const t = s.firstChild;
      if (!(t instanceof Text)) continue;
      const w = words(t).length;
      if (!w) { if (p === 0) return [t, t.length]; continue; }
      if (p <= w) return [t, p];
      p -= w;
    }
    return [lines[li], lines[li].childNodes.length];
  }
  return [wrap, wrap.childNodes.length];
}

/** Custom clipboard type: the runs of a copy, so a paste into another note keeps its look. */
const NOTE_CLIP = 'application/x-mbrd-note';

/**
 * What a paste puts in. The editor's own copy keeps its runs, each through the
 * model's allowlists - the clipboard is anybody's to write. Anything else is
 * plain text, set in `style`, the look at the caret.
 */
function pieceFrom(data: DataTransfer | null, style: NoteStyle): NoteLines | null {
  if (!data) return null;
  const own = data.getData(NOTE_CLIP);
  if (own) {
    try {
      const raw: unknown = JSON.parse(own);
      if (Array.isArray(raw) && raw.length) {
        return raw.map(line => tidyRuns(
          Array.isArray(line) ? line.map(r => normalizeRun(r, style)) : [], style));
      }
    } catch { /* not a copy of ours after all - fall through to its words */ }
  }
  const text = data.getData('text/plain');
  if (!text) return null;
  return text.replace(/\r\n?/g, '\n').split('\n')
    .map(w => [{ ...style, text: w.replace(/\t/g, ' ') }]);
}

/**
 * The look of the run the character at `pos` is in, when that character is
 * all the run holds and the line holds more - a run a delete would empty.
 */
function loneRun(lines: NoteLines, pos: number): NoteStyle | null {
  const { li, off } = locate(lines, pos);
  const runs = lines[li];
  let p = off;
  for (const r of runs) {
    if (p < r.text.length) return r.text.length === 1 && runs.length > 1 ? styleOf(r) : null;
    p -= r.text.length;
  }
  return null;
}

// ---------------------------------------------------------------------------
// The toolbar
// ---------------------------------------------------------------------------

/** Where the selection was and the look at it - read when a control is pressed. */
type Grab = { start: number, end: number, style: NoteStyle };

/**
 * Formatting bar over a note being edited. Every control cancels mousedown
 * to keep focus in the editor — a blur would commit the note mid-click.
 */
type NoteToolbarApi = {
  setTitle(on: boolean): void;
  setAlign(align: NoteAlign): void;
  /** The selection and the look at it now — read before a menu takes focus. See setWash. */
  grab(): Grab | null;
  /**
   * `at` is required: the menu takes focus and the selection shifts before
   * the row action fires, so the selection must be captured on button press.
   */
  setWash(wash: NoteWash | null, at: Grab | null): void;
  setFont(key: string, at: Grab | null): void;
};

function buildToolbar(api: NoteToolbarApi) {
  const bar = document.createElement('div');
  bar.className = 'note-toolbar';
  // Stop pointer from reaching the canvas (would start dragging the note).
  bar.addEventListener('pointerdown', e => e.stopPropagation());
  // Keep focus in the editor — no control may steal it.
  bar.addEventListener('mousedown', e => { e.stopPropagation(); e.preventDefault(); });

  const group = () => {
    const g = document.createElement('div');
    g.className = 'ntb-group';
    bar.append(g);
    return g;
  };
  // Text, a CSS-drawn icon (`icon`, a class suffix) or a sprite icon (`sprite`,
  // the whole href, written out where it is used so tests/icons.test.js sees it).
  const btn = (
    g: HTMLElement,
    { text, icon, sprite, title, fn, key }: {
      text?: string; icon?: string; sprite?: string; title: string; fn: () => void; key?: string;
    },
  ) => {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'ntb-btn' + (icon || sprite ? ' ntb-icon' : '');
    if (sprite) {
      const NS = 'http://www.w3.org/2000/svg';
      const svg = document.createElementNS(NS, 'svg');
      svg.setAttribute('class', 'ico');
      svg.setAttribute('aria-hidden', 'true');
      const use = document.createElementNS(NS, 'use');
      use.setAttribute('href', sprite);
      svg.append(use);
      b.append(svg);
    } else if (icon) {
      const span = document.createElement('span');
      span.className = 'ntb-ico ntb-ico-' + icon;
      b.append(span);
    } else {
      b.textContent = text ?? '';
    }
    b.title = title;
    b.setAttribute('aria-label', title);
    if (key) b.dataset.key = key;
    b.addEventListener('click', fn);
    g.append(b);
    return b;
  };

  // Two kinds, and a title is a look like any other: it can be one word in a
  // line. The big T and the small one say which is which without a letter
  // code - H1 and a pilcrow were the editor's words, not the writer's.
  const gKind = group();
  btn(gKind, { sprite: 'assets/icons.svg#i-note-title', title: 'Title (Ctrl+B)', fn: () => api.setTitle(true), key: 'kind:title' });
  btn(gKind, { sprite: 'assets/icons.svg#i-note-text', title: 'Text', fn: () => api.setTitle(false), key: 'kind:text' });

  const gAlign = group();
  btn(gAlign, { icon: 'al-left', title: 'Align left', fn: () => api.setAlign('left'), key: 'align:left' });
  btn(gAlign, { icon: 'al-center', title: 'Align centre', fn: () => api.setAlign('center'), key: 'align:center' });
  btn(gAlign, { icon: 'al-right', title: 'Align right', fn: () => api.setAlign('right'), key: 'align:right' });

  // The marker. A highlighter pen with the colour it will draw with as a bar
  // under it, the way word processors show it: the pen says what the button
  // is, the bar says which colour is at the caret. Unmarked, the bar is an
  // empty outline - the absence drawn, rather than a fifth colour meaning "none".
  const gWash = group();
  let wash: NoteWash | null = null;
  const washBtn = btn(gWash, {
    sprite: 'assets/icons.svg#i-note-marker', title: 'Highlight', fn: () => pickWash(),
  });
  washBtn.classList.add('ntb-marker');
  washBtn.setAttribute('aria-haspopup', 'menu');
  const washChip = document.createElement('span');
  washChip.className = 'ntb-chip';
  washBtn.append(washChip);
  function pickWash() {
    // Read here, before a menu that takes focus is anywhere near the caret -
    // see setWash() in NoteToolbarApi for the whole of why.
    const at = api.grab();
    openMenu?.(
      washBtn,
      // The off row first, which is where a row that undoes the other four
      // belongs, and the only one with no swatch: an empty icon column is the
      // absence said again.
      [{ value: '', label: 'No mark' }, ...NOTE_WASHES.map(w => ({
        value: w,
        // The name with a capital on it. The four are words rather than codes
        // precisely so this needs no table - see NOTE_WASHES.
        label: w[0].toUpperCase() + w.slice(1),
        // Built from the name, which is why the tokens are named after the
        // washes. The interpolation is safe because `w` came out of the
        // allowlist two lines up and cannot be anything else.
        swatch: `var(--note-wash-${w})`,
      }))],
      wash || '',
      // SAFETY: two assertions and the includes() between them is what makes
      // both hold. The first widens NOTE_WASHES so a plain string can be looked
      // for in it at all; the second is that lookup having answered yes, which
      // is the only way a string becomes a NoteWash.
      key => api.setWash(
        (NOTE_WASHES as readonly string[]).includes(key) ? key as NoteWash : null, at),
    );
  }

  // The face, as a button that opens the app's own menu rather than a <select>:
  // a native dropdown takes focus, which nothing in this bar may do, and opens
  // a window of its own that swallowed the pointerup ending a drag.
  const gFont = group();
  const LABEL: Record<string, string> = { sheet: 'Sheet', sans: 'Sans', serif: 'Serif', mono: 'Mono' };
  let font = NOTE_FONT_KEYS[0];
  const sel = document.createElement('button');
  sel.type = 'button';
  sel.className = 'ntb-btn ntb-select';
  sel.title = 'Font';
  sel.setAttribute('aria-label', 'Font');
  sel.setAttribute('aria-haspopup', 'menu');
  sel.addEventListener('click', () => {
    const at = api.grab();
    openMenu?.(
      sel,
      NOTE_FONT_KEYS.map(key => ({ value: key, label: LABEL[key] || key })),
      font,
      key => api.setFont(key, at),
    );
  });
  gFont.append(sel);

  /**
   * Light up the controls that match the look at the caret. `kind` is null
   * for a selection holding both titles and text, which lights neither.
   */
  const reflect = (style: NoteStyle, align: NoteAlign, kind: 'title' | 'text' | null) => {
    for (const b of bar.querySelectorAll<HTMLElement>('.ntb-btn[data-key]')) {
      const [k, v] = (b.dataset.key ?? '').split(':');
      b.classList.toggle('is-active', (k === 'kind' && v === kind) || (k === 'align' && v === align));
    }
    // Closure state — menus are built fresh each press and need the current value.
    font = style.font;
    sel.textContent = 'Font: ' + (LABEL[style.font] || style.font);
    wash = style.wash ?? null;
    // No accent fill when marked: the bar is the state, and a colour bar on the
    // accent is one warm colour laid on another.
    // Chip colour via data-wash; absent attribute = empty outline in CSS.
    if (wash) washChip.dataset.wash = wash;
    else delete washChip.dataset.wash;
  };

  return { el: bar, reflect };
}

// ---------------------------------------------------------------------------
// The editor
// ---------------------------------------------------------------------------

/** The card and .note-rich column, or null if this id is not an editable note on screen. */
function editableNote(id: string): { found: HTMLElement; rich: HTMLElement } | null {
  const item = byId(id);
  const found: HTMLElement | undefined = nodeFor(id);
  const rich = found?.querySelector('.card')?.querySelector<HTMLElement>('.note-rich');
  if (!item || item.type !== 'note' || !found || !rich) return null;
  return { found, rich };
}

/**
 * Turn a note into an editable column until focus leaves it. Commits on
 * focusout. `surface`: extra element that counts as "inside" the edit (used by
 * the composer dialog). `onDone(text|null, becameFile)`: called on commit or
 * discard. `finish(true)` tears down without committing.
 */
export type NoteEdit = { finish: (discard?: boolean) => void; caretToEnd: () => void; caretTo: (pos?: number) => void };

export function editNote(
  id: string,
  { surface = null, onDone = null }: {
    surface?: HTMLElement | null;
    /** `opening`: the document it became opens in the editor, and may be grown out of what is on screen. */
    onDone?: ((text: string | null, becameFile?: boolean, opening?: boolean) => NoteStay | void) | null;
  } = {},
): NoteEdit {
  const parts = editableNote(id);
  if (!parts) return { finish: () => {}, caretToEnd: () => {}, caretTo: () => {} };
  // Bound again now they are known present. finish() below is a hoisted
  // declaration and the handlers close over both, and TypeScript will not carry
  // a guard into a function it cannot order against - so the guard is spent here
  // once, on two names that are elements from this line down.
  const node: HTMLElement = parts.found;
  const wrap: HTMLElement = parts.rich;

  // Close any already-open editor to avoid leaked listeners / stuck editable.
  if (editing) editing.finish();

  node.classList.add('is-editing');
  makeEditable(wrap);

  // The sheet's alignment, off its first line - one for every line.
  const firstLine = wrap.querySelector('.note-line');
  let align: NoteAlign = NOTE_ALIGNS.find(a => firstLine?.classList.contains('al-' + a)) ?? 'left';
  // The look at the caret when it was last read: what a character takes when
  // the browser has typed it somewhere with no run around it.
  let lastStyle: NoteStyle = { title: false, font: 'sheet', size: 1 };
  // An IME is mid-word. The DOM is the IME's until it ends, so nothing rewrites it.
  let composing = false;

  /** The column as lines, whether it is clean, and the selection in model positions. */
  const read = () => {
    const s = getSelection();
    const inside = !!s && s.rangeCount > 0 && !!s.anchorNode && !!s.focusNode
      && wrap.contains(s.anchorNode) && wrap.contains(s.focusNode);
    const points: Point[] = s && inside && s.anchorNode && s.focusNode
      ? [[s.anchorNode, s.anchorOffset], [s.focusNode, s.focusOffset]] : [];
    const { lines, canon, at } = scan(wrap, points, lastStyle);
    const sel = points.length && at[0] >= 0 && at[1] >= 0
      ? { start: Math.min(at[0], at[1]), end: Math.max(at[0], at[1]) } : null;
    return { lines, canon, sel };
  };

  const render = (lines: NoteLines) => {
    wrap.replaceChildren(...lines.map(l => buildNoteLine(l, align)));
  };
  const place = (start: number, end = start) => {
    const a = pointAt(wrap, start), b = pointAt(wrap, end);
    getSelection()?.setBaseAndExtent(a[0], a[1], b[0], b[1]);
  };
  /** The caret into run `ri` of line `li`, after its blank - an empty run's only place. */
  const placeIn = (li: number, ri: number) => {
    const t = wrap.children[li]?.children[ri]?.firstChild;
    if (t instanceof Text) getSelection()?.setBaseAndExtent(t, t.length, t, t.length);
  };
  const commit = (lines: NoteLines, start: number, end = start) => {
    render(lines);
    place(start, end);
    afterEdit();
  };

  /**
   * The look at the selection: an empty run the caret sits in (a pending look,
   * or an empty line's), else the character before a caret, else the first
   * character of a selection.
   */
  const styleNow = (lines: NoteLines, sel: { start: number, end: number } | null): NoteStyle => {
    if (!sel) return lastStyle;
    const anchor = getSelection()?.anchorNode;
    const el = anchor instanceof Element ? anchor : anchor?.parentElement;
    const span = el?.closest('.note-run');
    if (sel.start === sel.end && span instanceof HTMLElement && wrap.contains(span) && !words(span)) {
      return spanStyle(span, lastStyle);
    }
    return sel.start === sel.end ? styleAt(lines, sel.start) : styleAt(lines, sel.start, true);
  };

  const grab = (): Grab | null => {
    const { lines, sel } = read();
    return sel ? { ...sel, style: styleNow(lines, sel) } : null;
  };

  /**
   * Restyle what was selected, or with a bare caret set the look the next
   * character is typed in - an empty run at the caret in that look.
   */
  const applyStyle = (fn: (s: NoteStyle) => NoteStyle, at: Grab | null = grab()) => {
    if (!at) return;
    // A menu may have had focus; the selection is written back below.
    wrap.focus();
    const lines = read().lines.map(l => tidyRuns(l));
    if (at.start !== at.end) { commit(restyle(lines, at.start, at.end, fn), at.start, at.end); return; }
    const p = withPending(lines, at.start, fn(at.style));
    render(p.lines);
    placeIn(p.li, p.ri);
    afterEdit();
  };

  /** Title on or off: off when all of it is title already, otherwise on. */
  const toggleTitle = () => {
    const at = grab();
    if (!at) return;
    const on = at.start === at.end
      ? !at.style.title
      : !sliceLines(read().lines, at.start, at.end).every(l => l.every(r => r.title));
    applyStyle(s => ({ ...s, title: on }), at);
  };

  // Character count — an invisible limit would turn a note into a file by surprise.
  const counter = document.createElement('div');
  counter.className = 'note-count';
  // On the sheet, in its bottom padding — board and composer alike. A sibling
  // of .note-rich, never inside it: that column is the contenteditable.
  wrap.parentElement?.append(counter);
  const refreshCount = () => {
    const left = NOTE_SHEET_MAX - linesLength(read().lines);
    // Past the limit nothing is refused: the counter says what closing will do.
    counter.textContent = left < 0 ? 'becomes a .md file' : left + ' left';
    // Only near the end, and red when it is there: a count running the whole
    // way down is a number watched instead of words written.
    counter.hidden = left > 10;
    counter.classList.toggle('is-low', left <= 10);
  };

  const reflectNow = () => {
    const { lines, sel } = read();
    const style = styleNow(lines, sel);
    if (sel) lastStyle = style;
    let kind: 'title' | 'text' | null = style.title ? 'title' : 'text';
    if (sel && sel.start !== sel.end) {
      const runs = sliceLines(lines, sel.start, sel.end).flat().filter(r => r.text);
      if (runs.some(r => r.title) && runs.some(r => !r.title)) kind = null;
    }
    toolbar.reflect(style, align, kind);
  };

  /** A line's kind (its strut) follows its runs after the browser has typed or deleted in it. */
  const syncKinds = () => {
    for (const l of wrap.querySelectorAll('.note-line')) {
      const title = [...l.children].every(s => s instanceof HTMLElement && s.dataset.title === '1');
      l.classList.toggle('note-h1', title);
      l.classList.toggle('note-p', !title);
    }
  };

  const afterEdit = () => {
    syncKinds(); growNote(id); refreshCount(); reflectNow(); placeToolbar();
    outgrown();
  };

  /**
   * The character that takes a note past NOTE_SHEET_MAX turns it into a
   * document there and then, and the editor takes over with the caret where
   * it was - writing never stops, the note grows into a page under it. Not
   * mid-word in an IME, and not for an old note merely opened over the limit.
   */
  const outgrown = () => {
    if (!overflow || composing || done) return;
    const { lines, sel } = read();
    if (linesLength(lines) <= NOTE_SHEET_MAX || linesMarkdown(lines) === openedAs) return;
    const { li, off } = locate(lines, sel?.end ?? linesLength(lines));
    // linesMarkdown() writes a line all in title as `# ` and the line.
    const said = lines[li].map(r => r.text).join('');
    const title = lines[li].every(r => r.title) && !!said;
    // The space that tipped a title over: gone from the heading, so typed again.
    const lost = title && off === said.length ? (/\s*$/.exec(said)?.[0] ?? '') : '';
    const sheet = node.querySelector('.card') ?? node;
    finish(false, {
      caret: { line: li, col: off - lost.length + (title ? 2 : 0) },
      from: shownBox(node),
      paper: getComputedStyle(sheet).backgroundColor,
      typed: ' '.repeat(lost.length),
    });
  };

  const api: NoteToolbarApi = {
    setTitle(on) { applyStyle(s => ({ ...s, title: on })); },
    // Alignment applies to all lines at once — a sticky reads as one sheet.
    setAlign(a) {
      align = a;
      for (const l of wrap.querySelectorAll('.note-line')) {
        for (const x of NOTE_ALIGNS) l.classList.toggle('al-' + x, x === a);
      }
      afterEdit();
    },
    grab,
    setWash(w, at) {
      applyStyle(s => {
        const next = styleOf(s);
        if (w) next.wash = w;
        else delete next.wash;
        return next;
      }, at);
    },
    setFont(key, at) {
      // SAFETY: `key` is checked against NOTE_FONT_KEYS, which is Object.keys(NOTE_FONTS),
      // and NOTE_FONTS satisfies Record<NoteFont, string>.
      const face = (NOTE_FONT_KEYS.includes(key) ? key : 'sheet') as NoteFont;
      applyStyle(s => ({ ...s, font: face }), at);
    },
  };

  const toolbar = buildToolbar(api);
  // Bar in screen space (#viewport) — never scaled by zoom or clipped by the item.
  const viewportEl = document.getElementById('viewport');
  // Narrow viewport (phone showing Desktop board) uses mobile pinning too.
  // matchMedia read here, not at module load (tests/imports.test.js).
  const narrow = typeof matchMedia === 'function' && matchMedia('(max-width: 640px)').matches;
  // Composer dialog: bar is inline in the dialog flow, not pinned or floating.
  const mobile = !surface && (board.layoutMode === 'mobile' || narrow);
  if (surface) {
    toolbar.el.classList.add('is-inline');
  } else if (mobile) {
    toolbar.el.classList.add('is-mobile');
    // Root class hides add bar / bin strip so they do not stack. Removed in finish().
    document.documentElement.classList.add('note-edit-mobile');
  } else {
    toolbar.el.classList.add('is-float');
  }
  (surface || viewportEl || node).append(toolbar.el);

  // Bar size: measured once (only a window resize changes it), avoiding forced
  // layout on every pan frame.
  let barW = 0, barH = 0;
  const measureBar = () => { barW = toolbar.el.offsetWidth; barH = toolbar.el.offsetHeight; };

  // Position the floating bar above the note, flipping below when no room.
  const placeToolbar = () => {
    // Mobile/inline bars are placed by CSS — nothing to compute.
    if (surface || mobile || !viewportEl) return;
    const vpRect = viewportClientRect();
    const nRect = screenBoxOf(byId(id));
    if (!vpRect || !nRect) return;
    if (!barW) measureBar();
    const bar = toolbar.el;
    const gap = 12, pad = 8;
    let cx = nRect.cx;
    const minX = vpRect.left + pad + barW / 2;
    const maxX = vpRect.right - pad - barW / 2;
    cx = Math.min(maxX, Math.max(minX, cx));
    let top = nRect.top - gap - barH;           // above the note
    if (top < vpRect.top + pad) top = nRect.bottom + gap;   // no room -> below
    top = Math.min(vpRect.bottom - pad - barH, Math.max(vpRect.top + pad, top));
    bar.style.left = cx + 'px';
    bar.style.top = top + 'px';
  };
  measureBar();
  placeToolbar();
  const offView = onViewChange(placeToolbar);
  const onResize = () => { measureBar(); placeToolbar(); };
  addEventListener('resize', onResize);

  /** Enter: the line split at the caret. A new line after a title is text - a title is a line, not a mode. */
  const splitLine = (lines: NoteLines, sel: { start: number, end: number }) => {
    const style = styleNow(lines, sel);
    const cut = sel.start !== sel.end ? deleteRange(lines, sel.start, sel.end) : lines;
    const { li, off } = locate(cut, sel.start);
    const [left, right] = cutRuns(cut[li], off);
    const next = right.some(r => r.text) ? right : [{ ...style, title: false, text: '' }];
    commit([...cut.slice(0, li), tidyRuns(left, style), tidyRuns(next, style), ...cut.slice(li + 1)],
      sel.start + 1);
  };

  // Ordinary typing into a run is the browser's: it is the only path an IME
  // and a phone keyboard take. Everything that changes the shape of the lines
  // is done here on the model instead - a split, a join, a selection replaced
  // or deleted - because the browser's version of each leaves markup behind.
  const onBeforeInput = (e: InputEvent) => {
    const t = e.inputType;
    // No bold/italic of the browser's own; a drag-drop into the sheet is not a paste.
    if (t.startsWith('format') || t === 'insertFromDrop' || t === 'deleteByDrag') { e.preventDefault(); return; }
    if (e.isComposing || composing) return;
    const { lines, sel } = read();
    if (!sel) return;
    const ranged = sel.start !== sel.end;
    if (t === 'insertParagraph' || t === 'insertLineBreak') {
      e.preventDefault();
      splitLine(lines, sel);
      return;
    }
    if (t === 'insertText' && ranged) {
      // Typing over a selection takes the look of its first character.
      e.preventDefault();
      const style = styleAt(lines, sel.start, true);
      const piece = (e.data ?? '').split('\n').map(w => [{ ...style, text: w }]);
      const done = insertLines(deleteRange(lines, sel.start, sel.end), sel.start, piece);
      commit(done.lines, done.end);
      return;
    }
    if (!t.startsWith('delete')) return;
    if (ranged) {
      e.preventDefault();
      commit(deleteRange(lines, sel.start, sel.end), sel.start);
      return;
    }
    const { li, off } = locate(lines, sel.start);
    const len = lines[li].reduce((n, r) => n + r.text.length, 0);
    const back = t.includes('Backward');
    // The last character of a run: the browser would take the run with it and
    // the next character typed would fall into the run before. Its look stays
    // pending at the caret instead, as it does in any word processor.
    const gone = back ? sel.start - 1 : sel.start;
    const only = (t === 'deleteContentBackward' || t === 'deleteContentForward')
      && (back ? off > 0 : off < len) ? loneRun(lines, gone) : null;
    if (only) {
      e.preventDefault();
      const p = withPending(deleteRange(lines, gone, gone + 1).map(l => tidyRuns(l)), gone, only);
      render(p.lines);
      placeIn(p.li, p.ri);
      afterEdit();
    } else if (back && off === 0 && li > 0) {
      e.preventDefault();
      commit(deleteRange(lines, sel.start - 1, sel.start), sel.start - 1);
    } else if (!back && off === len && li < lines.length - 1) {
      e.preventDefault();
      commit(deleteRange(lines, sel.start, sel.start + 1), sel.start);
    }
  };

  /**
   * After the browser has typed: write the column back clean if it has left
   * it untidy, and turn `# ` at a line's start into a title line.
   */
  const settle = () => {
    const { lines, canon, sel } = read();
    let next = lines;
    let pos = sel?.start ?? linesLength(lines);
    let changed = !canon;
    if (sel && sel.start === sel.end) {
      const { li, off } = locate(next, pos);
      const said = next[li].map(r => r.text).join('');
      const mark = said.startsWith('## ') ? 3 : said.startsWith('# ') ? 2 : 0;
      if (mark && off >= mark) {
        const start = pos - off;
        next = restyle(deleteRange(next, start, start + mark), start, start + said.length - mark,
          s => ({ ...s, title: true }));
        pos -= mark;
        changed = true;
      }
    }
    if (changed) {
      render(next.map(l => tidyRuns(l, lastStyle)));
      place(pos);
    }
    afterEdit();
  };

  const onInput = (e: Event) => {
    // Mid-word in an IME the column is the IME's, but the sheet still grows
    // under it: a word wrapping onto a new line would otherwise scroll it.
    if (composing || (e instanceof InputEvent && e.isComposing)) { growNote(id); return; }
    settle();
  };
  const onCompStart = () => { composing = true; };
  const onCompEnd = () => { composing = false; settle(); };

  const onKey = (e: KeyboardEvent) => {
    e.stopPropagation();                  // the canvas must not see Delete/space
    // Escape ends the edit on the board. In a dialog it is the dialog's word,
    // not the editor's - there it means "I did not mean to open this", and the
    // surface answers it by discarding rather than by committing.
    if (e.key === 'Escape') { if (!surface) { markClosed(e); finish(); } return; }
    if (!(e.ctrlKey || e.metaKey) || e.altKey) return;
    if (e.key.toLowerCase() === 'b' && !e.shiftKey) { e.preventDefault(); toggleTitle(); }
  };

  // Every paste goes through the model: over a selection it replaces it, and
  // over the whole note (Ctrl+A) that is every line.
  const onPaste = (e: ClipboardEvent) => {
    e.preventDefault();
    const { lines, sel } = read();
    if (!sel) return;
    const piece = pieceFrom(e.clipboardData, styleNow(lines, sel));
    if (!piece) return;
    const cut = sel.start !== sel.end ? deleteRange(lines, sel.start, sel.end) : lines;
    const done = insertLines(cut.map(l => tidyRuns(l)), sel.start, piece);
    commit(done.lines, done.end);
  };

  const copyOut = (e: ClipboardEvent, cut: boolean) => {
    const { lines, sel } = read();
    if (!sel || sel.start === sel.end || !e.clipboardData) return;
    e.preventDefault();
    const piece = sliceLines(lines, sel.start, sel.end);
    e.clipboardData.setData('text/plain', piece.map(l => l.map(r => r.text).join('')).join('\n'));
    e.clipboardData.setData(NOTE_CLIP, JSON.stringify(piece));
    if (cut) commit(deleteRange(lines, sel.start, sel.end), sel.start);
  };
  const onCopy = (e: ClipboardEvent) => copyOut(e, false);
  const onCut = (e: ClipboardEvent) => copyOut(e, true);

  // The font menu is mounted on <body> (outside the note), so it must be
  // checked explicitly to avoid committing the edit when a menu row is picked.
  const inMenu = (n: Node | null) => !!n && !!document.getElementById('ctx-menu')?.contains(n);

  // focusout: relatedTarget is where focus is going. Toolbar/surface/menu
  // count as "inside" — only truly leaving finishes the edit.
  const onFocusOut = (e: FocusEvent) => {
    // The window losing focus - another app, alt-tab - is not leaving the note:
    // the browser hands focus back to the sheet when the window returns.
    if (!document.hasFocus()) return;
    // SAFETY: a focus event out of this document goes to a Node or to nothing.
    const to = e.relatedTarget as Node | null;
    if (node.contains(to) || toolbar.el.contains(to)) return;
    if (surface?.contains(to) || inMenu(to)) return;
    finish();
  };

  // Reliable close: focusout does not fire for unfocusable targets (empty canvas).
  // Capture phase — runs before the canvas eats the press.
  const onDocPointerDown = (e: PointerEvent) => {
    // SAFETY: the listener is on document, so the target is document or a node in it.
    const on = e.target as Node | null;
    if (node.contains(on) || toolbar.el.contains(on) || inMenu(on)) return;
    // Surface includes Cancel — must not commit before Cancel can fire.
    if (surface?.contains(on)) return;
    finish();
  };

  /**
   * An empty run the caret has left is a look nobody typed in: gone, unless it
   * is its line's only run. Skipped while the selection is outside the sheet -
   * a menu has it, and the pending look is what that menu is about to change.
   */
  const onSelect = () => {
    if (composing) return;
    const s = getSelection();
    if (!s?.anchorNode || !wrap.contains(s.anchorNode)) return;
    for (const span of wrap.querySelectorAll<HTMLElement>('.note-line > .note-run')) {
      if (words(span) || (span.parentElement?.children.length ?? 0) < 2) continue;
      if (span.contains(s.anchorNode) || span.contains(s.focusNode)) continue;
      span.remove();
    }
    reflectNow();
  };

  const regrow = () => { if (!done) growNote(id); };

  let done = false;
  function finish(discard = false, open?: NoteOpen) {
    if (done) return;
    done = true;
    if (editing?.finish === finish) editing = null;
    wrap.removeEventListener('beforeinput', onBeforeInput);
    wrap.removeEventListener('input', onInput);
    wrap.removeEventListener('compositionstart', onCompStart);
    wrap.removeEventListener('compositionend', onCompEnd);
    wrap.removeEventListener('keydown', onKey);
    wrap.removeEventListener('paste', onPaste);
    wrap.removeEventListener('copy', onCopy);
    wrap.removeEventListener('cut', onCut);
    wrap.removeEventListener('focusout', onFocusOut);
    document.removeEventListener('pointerdown', onDocPointerDown, true);
    document.removeEventListener('selectionchange', onSelect);
    document.fonts?.removeEventListener('loadingdone', regrow);
    document.documentElement.classList.remove('note-edit-mobile');
    offView?.();
    removeEventListener('resize', onResize);
    wrap.contentEditable = 'false';
    counter.remove();
    toolbar.el.remove();
    node.classList.remove('is-editing');
    if (discard) { onDone?.(null); return; }
    const lines = read().lines.map(l => tidyRuns(l));
    const rich = linesRich(lines, align);
    const text = flattenNoteRich(rich);
    // linkify replaces the item — nothing left to write, but onDone still fires.
    if (linkify(id, text)) { onDone?.(text); return; }
    const markdown = linesMarkdown(lines);
    if (overflow && linesLength(lines) > NOTE_SHEET_MAX && markdown !== openedAs) {
      // The composer is done with the note first. Going on into the editor it
      // stays up until the document arrives (NoteStay); otherwise it closes.
      const stay = onDone?.(markdown, true, !!open) ?? undefined;
      // Asynchronous (the file is hashed). The note keeps its old words until
      // the document replaces it; if that fails, the note keeps what fits.
      void overflow(id, markdown, open ? { ...open, stay } : undefined).then(ok => {
        if (!ok) { stay?.go(); setNoteContent(id, rich, text); growNote(id); }
      });
      return;
    }
    setNoteContent(id, rich, text);
    growNote(id);
    onDone?.(text, false);
  }

  wrap.addEventListener('beforeinput', onBeforeInput);
  wrap.addEventListener('input', onInput);
  wrap.addEventListener('compositionstart', onCompStart);
  wrap.addEventListener('compositionend', onCompEnd);
  wrap.addEventListener('keydown', onKey);
  wrap.addEventListener('paste', onPaste);
  wrap.addEventListener('copy', onCopy);
  wrap.addEventListener('cut', onCut);
  wrap.addEventListener('focusout', onFocusOut);
  document.addEventListener('pointerdown', onDocPointerDown, true);
  document.addEventListener('selectionchange', onSelect);
  editing = { id, finish };

  // What the note said when opened. Only an edit converts: an old note already
  // over the sheet limit, opened and closed unchanged, stays a note.
  const opened = read().lines;
  const openedAs = linesMarkdown(opened);
  lastStyle = styleAt(opened, linesLength(opened));
  /** Caret at the end of the last line, ready to keep writing. */
  /** The caret to `pos` (a model position), or the end; clamped to the note. */
  const caretTo = (pos = Infinity) => {
    wrap.focus();
    place(Math.min(pos, linesLength(read().lines)));
  };
  const caretToEnd = () => caretTo();
  caretToEnd();
  refreshCount();
  reflectNow();
  // Measured again a frame on, once the sheet is laid out where it is being
  // written, and whenever a face finishes loading: a first reading taken
  // before either left the sheet short, with a scrollbar on the words.
  requestAnimationFrame(regrow);
  document.fonts?.addEventListener('loadingdone', regrow);
  return { finish, caretToEnd, caretTo };
}

/** Open the composer dialog on an existing board note. No `added` entry — the
 * note already exists, so there is nothing to take back on cancel. `caret` is
 * a model position; absent, the caret goes to the end. */
export function editNoteInComposer(id: string, caret?: number) {
  openComposer(id, null, caret);
}

/**
 * A document's Markdown as a sticky's lines: a heading line is a title, the
 * rest plain, both in the note's own face and size. Other Markdown stays as
 * the characters it is written in, as the note had it before it outgrew itself.
 */
function markdownLines(markdown: string, base: Omit<NoteStyle, 'wash' | 'title'>): NoteLines {
  return markdown.split('\n').map(line => {
    const head = /^#{1,6} /.exec(line);
    // The editor escapes punctuation that would read as markup - `\*`, `\_`, `1\.` -
    // which the note never had and does not count.
    const words = (head ? line.slice(head[0].length) : line).replace(/\\([!-/:-@[-`{-~])/g, '$1');
    return [{ text: words, title: !!head, font: base.font, size: base.size }];
  });
}

/** Whether a document's Markdown fits on a sticky again. */
export function fitsNote(markdown: string): boolean {
  // Cheap first: headings' marks only make the source longer than the note.
  if (markdown.length > NOTE_SHEET_MAX + 7 * (markdown.split('\n').length)) return false;
  return linesLength(markdownLines(markdown, { font: 'sheet', size: 1 })) <= NOTE_SHEET_MAX;
}

/**
 * The document a sticky outgrew into, a sticky again, written down to fit, and
 * open for writing with the caret where the change was. The conversion is taken
 * back when nothing has been committed since (`turned`, the step that made the
 * document), so the undo history reads as if the note never left; otherwise
 * the document is swapped back as a step of its own. `note` is the sticky as
 * it was replaced, for its colour, size and face. `was` is the Markdown before
 * the change, which finds the caret. `into` is how the composer comes up.
 */
export function unfileNote(
  docId: string, note: Item, turned: ReturnType<typeof lastCommand>, markdown: string, was: string,
  into?: NoteEntrance,
): boolean {
  const raw = note.meta?.rich;
  // SAFETY: the typeof is the check; normalizeNoteRich() validates what is inside block by block.
  const rich0 = normalizeNoteRich(raw && typeof raw === 'object' ? raw as NoteRichInput : null, note.meta?.text);
  const lines = markdownLines(markdown, { font: rich0.font, size: rich0.size });
  const rich = linesRich(lines, rich0.blocks[0]?.align ?? 'left');
  const text = flattenNoteRich(rich);
  let id = note.id;
  if (!takeBack(turned)) {
    const { id: _id, ...rest } = note;
    const back = retypeItem(docId, rest, 'Turn file back into note');
    if (!back) {
      into?.(null);
      return false;
    }
    id = back.id;
  }
  setNoteContent(id, rich, text);
  growNote(id);
  // The first character that differs is where the change was; each heading's
  // mark before it is not a character of the note.
  let at = 0;
  while (at < markdown.length && markdown[at] === was[at]) at++;
  let pos = 0;
  for (const line of markdown.slice(0, at).split('\n').map((l, i, all) => (i < all.length - 1 ? l + '\n' : l))) {
    const mark = /^#{1,6} /.exec(line)?.[0].length ?? 0;
    pos += Math.max(0, line.length - mark);
  }
  // A frame, so the canvas has built the card before the composer asks for it.
  requestAnimationFrame(() => openComposer(id, null, pos, into));
  return true;
}

/**
 * Create a note via `make()` and open it in the composer dialog. `make` is a
 * callback (not an import) because canvas/ cannot import addNote(). The command
 * is captured so cancel can takeBack() the add. Falls back to inline editing
 * when the dialog is absent.
 */
export function composeNote(make: () => Item | null | undefined) {
  const before = lastCommand();
  const item = make();
  if (!item) return;
  // Null if make() committed nothing — takeBack must not receive another command.
  const added = lastCommand() === before ? null : lastCommand();
  // A frame, so the canvas has built the card before it is asked for.
  requestAnimationFrame(() => openComposer(item.id, added));
}

/** `added` is whatever lastCommand() answered - the entry composeNote() made. `into`: see NoteEntrance. */
function openComposer(id: string, added: ReturnType<typeof lastCommand>, caret?: number, into?: NoteEntrance) {
  // The last note still flying home lands now: the dialog is about to be this one.
  landing?.();
  // SAFETY: #compose is a <dialog> in index.html. If not, the showModal test below falls back
  // to inline editNote().
  const dlg = document.getElementById('compose') as HTMLDialogElement | null;
  const mount = document.getElementById('compose-mount');
  const node: HTMLElement | undefined = nodeFor(id);
  // Must check editability before moving the card into the dialog.
  if (!node || !mount || typeof dlg?.showModal !== 'function' || !editableNote(id)) {
    into?.(null);
    editNote(id);
    return;
  }

  // The note laid out at its own board width and magnified, not re-laid at a
  // dialog width: the words wrap in the composer exactly where they will wrap
  // on the board, so what is written is what lands. Magnified up to EDIT_W,
  // never shrunk below life size, and held inside the window.
  const prevWidth = node.style.width;
  const prevHeight = node.style.height;
  const prevHalfW = node.style.getPropertyValue('--half-w');
  const boardW = byId(id)?.w || EDIT_W;
  const zoom = Math.min(Math.max(EDIT_W / boardW, 1), EDIT_ZOOM_MAX, (innerWidth - 48) / boardW);

  // Where the card is on the board, for the composer to grow out of. Read
  // before it leaves: a sticky becoming a document back has its own entrance.
  const from = into ? null : cardOnScreen(id);

  // Bookmark the card's position in the world layer for restoration.
  const home = node.parentElement;
  const after = node.nextSibling;
  mount.append(node);
  // Its selection ring stays on the board, outlining a hole, unless told.
  refreshRings();

  node.style.width = boardW + 'px';
  // --half-w must match — margins are width-dependent (cards.css).
  node.style.setProperty('--half-w', (boardW / 2) + 'px');
  // Min height = the width so short notes are a square sheet, not a strip.
  // Measured after mount — a culled card in the world layer answers 0 — and
  // after showModal() below, since a closed dialog is display:none and answers
  // 0 too: this first fit is only the square. The mount takes the magnified
  // box, since a transform does not move layout.
  const fit = () => {
    const h = Math.max(boardW, noteHeight(id, null, node));
    node.style.height = h + 'px';
    // As tall as the note, until that would run it off the window: then as
    // tall as there is room for, and the mount scrolls it. The mount and not
    // the sheet, so the scrollbar is outside the column and the words wrap
    // where they will on the board, and is not magnified with it.
    const room = composerRoom(dlg, mount);
    const scrolls = room > 0 && h * zoom > room;
    mount.classList.toggle('is-scrolling', scrolls);
    mount.style.height = (scrolls ? room : h * zoom) + 'px';
    mount.style.width = boardW * zoom + (scrolls ? mount.offsetWidth - mount.clientWidth : 0) + 'px';
  };
  // Registered before editNote(), whose growth comes here.
  standIn = { id, fit };
  fit();

  // The board's inline transform (sub-pixel snap / rotation) swapped for the
  // magnification while in the dialog. Stashed and restored — placeBox() does
  // not rerun on return.
  const worldTransform = node.style.transform;
  node.style.transform = `scale(${zoom})`;
  // Item chrome (the ring) is sized in --iz so it holds its size under the
  // board's zoom; the magnification is a zoom too.
  mount.style.setProperty('--iz', String(1 / zoom));

  // Both buttons live inside #compose in index.html.
  const go = document.getElementById('compose-go')!;
  const cancel = document.getElementById('compose-cancel')!;
  // "Add" for new notes, "Save" for existing ones.
  go.textContent = added ? 'Add' : 'Save';
  dlg.setAttribute('aria-label', added ? 'Write a note' : 'Edit note');

  /** The note's toolbar, which editNote() puts in the dialog. */
  let bar: HTMLElement | null = null;
  const handle = editNote(id, {
    surface: dlg,
    onDone: (text, becameFile, opening) => {
      removeEventListener('resize', fit);
      globalThis.visualViewport?.removeEventListener('resize', fit);
      go.removeEventListener('click', onGo);
      cancel.removeEventListener('click', onCancel);
      dlg.removeEventListener('cancel', onEscape);
      // Going on into the editor, a still copy of the sheet as it is now stays
      // in the mount (NoteStay) - taken before the styles below go back.
      const still = becameFile && opening ? stillOf(node) : null;
      // Going back onto the board, saved or cancelled, the same copy flies
      // home in the mount while the card itself is put straight back under it.
      // Not a new note cancelled, which is taken away rather than put back.
      const goesBack = !becameFile && (text ? !!text.trim() : text === null && !added);
      const flying = goesBack && travelMs() > 0 ? stillOf(node) : null;
      // Restore stashed styles before returning the card to the world layer.
      standIn = null;
      node.style.width = prevWidth;
      node.style.height = prevHeight;
      node.style.setProperty('--half-w', prevHalfW);
      node.style.transform = worldTransform;
      const close = () => {
        mount.style.width = '';
        mount.style.height = '';
        mount.style.removeProperty('--iz');
        mount.classList.remove('is-scrolling');
        // Closed before an entrance showed it: the next opening is seen.
        dlg.classList.remove('is-arriving');
        dlg.close();
      };
      if (still) {
        mount.append(still);
        // The bar the edit took away goes back unseen, or the dialog would
        // re-centre on what is left and the sheet jump up out of place.
        if (bar) {
          bar.style.visibility = 'hidden';
          bar.inert = true;
          dlg.append(bar);
        }
      } else if (!flying) close();
      // Sibling may have been detached by culling — append as fallback.
      if (home) {
        if (after && after.parentNode === home) home.insertBefore(node, after);
        else home.appendChild(node);
      } else node.remove();
      refreshRings();
      // Outgrown: a document is replacing this note, so it is not grown or
      // landed - the document's own card arrives instead.
      if (becameFile) return still ? { host: dlg, go: fadeComposer(dlg, () => { still.remove(); bar?.remove(); close(); }) } : undefined;
      if (text?.trim()) {
        // Re-grow at board width — dialog grows went to the stand-in.
        growNote(id);
        // Back into its own box on the board, the way it came out; with
        // nowhere on screen to go, it lands from above where it is instead.
        if (flying) {
          if (flyHome(dlg, mount, flying, bar, id, close)) return;
          close();
        }
        node.classList.add('is-landing');
        node.addEventListener('animationend', () => { node.classList.remove('is-landing'); refreshRings(); }, { once: true });
        // The ring takes the class too, so the card drops into it rather than through it.
        refreshRings();
        return;
      }
      if (flying) {
        if (flyHome(dlg, mount, flying, bar, id, close)) return;
        close();
      }
      // Empty note: if we just created it (`added`), take it back; existing
      // empty notes are left alone — emptying is not deleting.
      if (!added) return;
      // Falls back to removeItems if takeBack fails (something else committed).
      if (!takeBack(added)) removeItems([id], 'Discard note');
    },
  });
  bar = dlg.querySelector<HTMLElement>('.note-toolbar');

  // Refocus the sheet after showModal()'s own focus flush — otherwise the first
  // keystroke hits Cancel. rAF runs after the flush in the same frame.
  const sheet = node.querySelector<HTMLElement>('.note-rich')!;
  // Unseen till what was on screen has turned into it. Before showModal(),
  // which computes the backdrop: after, the dim is drawn at full and then
  // fades out under its own transition, only to fade back in.
  if (into) dlg.classList.add('is-arriving');
  // Growing out of the card, the dim comes up with it rather than being there first.
  const grows = !!from && travelMs() > 0;
  if (grows) dlg.classList.add('is-leaving');
  dlg.showModal();
  // Open, the sheet can be measured: a note longer than a square is that tall from its first frame.
  fit();
  if (from && grows) growOut(dlg, mount, from);
  // The room it has is the window's: a resize, or a phone keyboard, changes it.
  addEventListener('resize', fit);
  globalThis.visualViewport?.addEventListener('resize', fit);
  if (into) {
    // Without its own pop-in, which would be scaling the sheet as it is measured.
    for (const a of dlg.getAnimations()) a.cancel();
    into({
      sheet: shownBox(node),
      paper: getComputedStyle(node.querySelector('.card') ?? node).backgroundColor,
      show: () => showComposer(dlg),
    });
  }
  requestAnimationFrame(() => {
    // Guard: dialog may have already closed (double-press, Escape in same frame).
    if (!dlg.open || !mount.contains(sheet)) return;
    handle.caretTo(caret);
  });

  const onGo = () => handle.finish();
  const onCancel = () => handle.finish(true);
  // preventDefault: let handle.finish(true) close the dialog, not the native cancel.
  const onEscape = (e: Event) => { e.preventDefault(); handle.finish(true); };

  go.addEventListener('click', onGo);
  cancel.addEventListener('click', onCancel);
  dlg.addEventListener('cancel', onEscape);
}

/**
 * The most of the window the composer's sheet may take: the window, less the
 * dialog's margin, its bar, its buttons and the gaps between. 0 while closed,
 * when nothing in it can be measured.
 */
function composerRoom(dlg: HTMLDialogElement, mount: HTMLElement): number {
  if (!dlg.open) return 0;
  const win = globalThis.visualViewport?.height ?? innerHeight;
  const gap = parseFloat(getComputedStyle(dlg).rowGap) || 0;
  let rest = 0;
  for (const el of dlg.children) {
    if (el === mount || !(el instanceof HTMLElement) || !el.offsetHeight) continue;
    if (getComputedStyle(el).position === 'fixed') continue;
    rest += el.offsetHeight + gap;
  }
  return Math.floor(win - rest - 32);
}

/** A card's box on screen, less what the composer's mount scrolls out of view. */
function shownBox(node: HTMLElement): DOMRect {
  const r = node.getBoundingClientRect();
  const clip = node.closest('#compose-mount.is-scrolling')?.getBoundingClientRect();
  if (!clip) return r;
  const top = Math.max(r.top, clip.top);
  const bottom = Math.min(r.bottom, clip.bottom);
  return new DOMRect(r.left, top, r.width, Math.max(0, bottom - top));
}

/** A still copy of a sheet in the composer: no id, so nothing takes it for the note. */
function stillOf(node: HTMLElement): HTMLElement {
  // SAFETY: a deep clone of an HTMLElement is an HTMLElement.
  const copy = node.cloneNode(true) as HTMLElement;
  copy.removeAttribute('data-id');
  copy.inert = true;
  return copy;
}

/**
 * A NoteStay's `go`: the composer fading as the document grows out over it -
 * the sheet's copy, the buttons and the dimmed board together - then closed.
 * With motion reduced, closed at once.
 */
function fadeComposer(dlg: HTMLDialogElement, close: () => void): () => void {
  let gone = false;
  return () => {
    if (gone) return;
    gone = true;
    const ms = travelMs() / 2;
    if (!dlg.open || !(ms > 0) || typeof dlg.animate !== 'function') return close();
    // The backdrop is a pseudo-element, which only the stylesheet reaches (dialog.css).
    dlg.classList.add('is-leaving');
    const fade = dlg.animate([{ opacity: 1 }, { opacity: 0 }], { duration: ms, easing: 'ease-out', fill: 'forwards' });
    const end = () => { close(); fade.cancel(); dlg.classList.remove('is-leaving'); };
    fade.finished.then(end, end);
  };
}

/**
 * The composer brought in over an entrance that has landed (NoteEntrance).
 * The sheet at once, since it lands exactly on the card it replaces; only its
 * words, the bar, the buttons and the dim fade in. Faded as a whole, the dim
 * came up over the card while the sheet was still half there, and the note
 * went darker and then light again.
 */
function showComposer(dlg: HTMLDialogElement): Promise<void> {
  // The backdrop follows by its transition (dialog.css).
  dlg.classList.remove('is-arriving');
  const ms = travelMs() / 2;
  if (!dlg.open || !(ms > 0) || typeof dlg.animate !== 'function') return Promise.resolve();
  const parts = dlg.querySelectorAll<HTMLElement>('.note-toolbar, .ask-row, .note-rich, .note-count');
  return Promise.all([...parts].map(el => el.animate([{ opacity: 0 }, { opacity: 1 }], { duration: ms, easing: 'ease-out' })
    .finished.catch(() => {}))).then(() => {});
}

/** A card on screen: its centre and its unturned width, in client pixels. */
type CardBox = { cx: number, cy: number, w: number };

/**
 * Where a card is on screen, from the item and the camera, so it is known
 * while the node is in the composer too. Null when it is not on screen to fly
 * to or from, or the board is not what is showing (the Feed).
 */
function cardOnScreen(id: string): CardBox | null {
  const item = byId(id);
  const box = screenBoxOf(item);
  const view = viewportClientRect();
  if (!item || !box || !view || board.layoutMode === 'mobile') return null;
  if (box.right < view.left || box.left > view.right || box.bottom < view.top || box.top > view.bottom) return null;
  const { hw } = rotatedExtents(item);
  if (!(hw > 0)) return null;
  return { cx: box.cx, cy: box.cy, w: item.w * (box.right - box.left) / (2 * hw) };
}

const ease = () => readToken('--ease') || 'ease-out';

/**
 * The composer growing out of the note: the mount flown from the card's box
 * on the board to its own, by `translate` and `scale` so it composes with the
 * tilt the soft tier puts on `transform`. The bar and buttons fade in behind
 * it and the dim comes up by its transition (dialog.css, is-leaving).
 */
function growOut(dlg: HTMLDialogElement, mount: HTMLElement, from: CardBox) {
  // The dim's start committed, so taking the class away fades it in.
  void getComputedStyle(dlg, '::backdrop').opacity;
  dlg.classList.remove('is-leaving');
  const ms = travelMs() * 0.6;
  if (!(ms > 0) || typeof mount.animate !== 'function' || !mount.offsetWidth) return;
  // The grow is the entrance: ask-in would be scaling the dialog under it.
  for (const a of dlg.getAnimations()) a.cancel();
  const to = mount.getBoundingClientRect();
  const dx = from.cx - (to.left + to.width / 2);
  const dy = from.cy - (to.top + to.height / 2);
  mount.animate([
    { translate: `${dx}px ${dy}px`, scale: `${from.w / mount.offsetWidth}` },
    { translate: '0px 0px', scale: '1' },
  ], { duration: ms, easing: ease() });
  for (const el of dlg.querySelectorAll<HTMLElement>('.note-toolbar, .ask-row')) {
    el.animate([{ opacity: 0 }, { opacity: 0, offset: 0.4 }, { opacity: 1 }], { duration: ms, easing: 'ease-out' });
  }
}

/** A note flying home (flyHome), brought to its end at once. */
let landing: (() => void) | null = null;

/**
 * The composer going back into the card: `copy`, a still of the sheet, flies
 * from the mount to the card's box on the board, where the card itself has
 * already been put back, and gives way to it over the last stretch. The bar
 * and buttons go first and the dim with it. `close` shuts the dialog after.
 * False, having done nothing, when the card is not on screen to go to.
 */
function flyHome(dlg: HTMLDialogElement, mount: HTMLElement, copy: HTMLElement, bar: HTMLElement | null, id: string, close: () => void): boolean {
  const to = cardOnScreen(id);
  const ms = travelMs() * 0.6;
  if (!to || !dlg.open || !(ms > 0) || typeof mount.animate !== 'function') return false;
  // Caught mid-grow, it goes back from where it is.
  const live = getComputedStyle(mount);
  const at = { translate: live.translate === 'none' ? '0px 0px' : live.translate, scale: live.scale === 'none' ? '1' : live.scale };
  for (const a of mount.getAnimations()) a.cancel();
  mount.append(copy);
  // Back in, unseen and inert, or the dialog would re-centre without it and the sheet jump.
  if (bar) {
    bar.inert = true;
    dlg.append(bar);
  }
  if (!mount.offsetWidth) {
    copy.remove();
    bar?.remove();
    return false;
  }
  const r = mount.getBoundingClientRect();
  const dx = to.cx - (r.left + r.width / 2);
  const dy = to.cy - (r.top + r.height / 2);
  const hold = { fill: 'forwards' as const, duration: ms };
  // The dim goes by its transition (dialog.css).
  dlg.classList.add('is-leaving');
  const anims = [
    mount.animate([at, { translate: `${dx}px ${dy}px`, scale: `${to.w / mount.offsetWidth}` }], { ...hold, easing: ease() }),
    mount.animate([{ opacity: 1 }, { opacity: 1, offset: 0.75 }, { opacity: 0 }], hold),
    ...[...dlg.querySelectorAll<HTMLElement>('.note-toolbar, .ask-row')].map(el =>
      el.animate([{ opacity: 1 }, { opacity: 0 }], { ...hold, duration: ms * 0.4, easing: 'ease-out' })),
  ];
  const end = () => {
    if (landing !== end) return;
    landing = null;
    dlg.removeEventListener('close', end);
    copy.remove();
    bar?.remove();
    close();
    for (const a of anims) a.cancel();
    dlg.classList.remove('is-leaving');
  };
  landing = end;
  // Shut some other way (Escape still reaches the dialog), it is over too.
  dlg.addEventListener('close', end);
  anims[0].finished.then(end, end);
  return true;
}

/** Composer sheet width a note is magnified up to: a default note at 2x. */
const EDIT_W = 320;
/** The most the composer magnifies - a note resized small is not blown up to a poster. */
const EDIT_ZOOM_MAX = 2.25;

/** The open editor, if any. Only one at a time — opening another fires focusout. */
let editing: { id: string; finish: (discard?: boolean) => void } | null = null;

/**
 * Commit any open note edit synchronously. Called from pagehide — an autosave
 * without this would record new height with old text. Returns whether there was one.
 */
export function flushNoteEdit() {
  if (!editing) return false;
  editing.finish();
  return true;
}

/**
 * Convert a note whose only content is a URL into a link item. Only runs on
 * finish() — never mid-typing. One edit, one undo entry; Ctrl+Z restores the
 * original note. Existing URL-only notes (from old saves) are left alone.
 */
function linkify(id: string, text: string): boolean {
  const url = linkURL(text);
  if (!url) return false;
  retypeItem(id, linkDraft(url), 'Turn note into link');
  return true;
}
