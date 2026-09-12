// Note editor. Turns .note-rich into a contenteditable with a floating toolbar
// for alignment, font, size, kind. Blocks live in meta.rich; meta.text is the
// plaintext kept for search. The box grows to fit (never hides text). A note
// whose content is just a URL becomes a link item on close — see linkify().

import {
  byId, bus, markDirty, setNoteContent, retypeItem, board, NOTE_MAX,
  lastCommand, takeBack, removeItems,
} from '../state.ts';
import { nodeFor, onViewChange, screenBoxOf, viewportClientRect } from './items.ts';
import { makeEditable } from '../util.ts';
import { linkURL, linkDraft } from './renderers.ts';
import {
  normalizeNoteRich, flattenNoteRich, buildNoteLine,
  NOTE_TAGS, NOTE_ALIGNS, NOTE_FONTS, NOTE_FONT_KEYS, NOTE_MARKER, NOTE_WASHES,
  NOTE_SIZE_MIN, NOTE_SIZE_MAX, NOTE_SIZE_STEP,
} from './note-model.ts';
import type { NoteTag, NoteAlign, NoteValign, NoteFont, NoteWash } from './note-model.ts';
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

/** getSelection() non-null — null only for detached documents, never an active editor. */
const selectionNow = () => getSelection()!;

/** Element textContent, always a string (only Document/Doctype return null). */
const textOf = (el: Element): string => el.textContent!;

/**
 * Height this note needs, in world px, for its text at `width`. Briefly
 * releases the flex child to natural height for measurement. No iteration —
 * margins are width-based, so the measured height is stable.
 */
function noteHeight(id: string, width?: number | null): number {
  const el = nodeFor(id);
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
// Line helpers - the block model, read off the DOM
// ---------------------------------------------------------------------------

// Element, not HTMLElement — sibling walks hand over Element.
const lineTag = (line: Element): NoteTag =>
  NOTE_TAGS.find(t => line.classList.contains('note-' + t)) || 'p';
const lineAlign = (line: Element): NoteAlign =>
  NOTE_ALIGNS.find(a => line.classList.contains('al-' + a)) || 'left';
// Returns undefined (not 'none') for unmarked lines. Validated through the
// allowlist — the attribute is user-editable. Callers always pass HTMLElement.
const lineWash = (line: Element): NoteWash | undefined =>
  NOTE_WASHES.find(w => (line as HTMLElement).dataset.wash === w);

function setLineTag(line: Element, tag: NoteTag) {
  for (const t of NOTE_TAGS) line.classList.toggle('note-' + t, t === tag);
}
function setLineAlign(line: Element, align: NoteAlign) {
  for (const a of NOTE_ALIGNS) line.classList.toggle('al-' + a, a === align);
}
function setLineWash(line: Element, wash: NoteWash | null) {
  // note-line is always HTMLElement (built by buildLine).
  const el = line as HTMLElement;
  if (wash) el.dataset.wash = wash;
  else delete el.dataset.wash;
}

/** The block-line the caret is in, if any. */
function currentLine(wrap: HTMLElement): HTMLElement | null {
  const sel = selectionNow();
  const node = sel.anchorNode;
  if (!node || !wrap.contains(node)) return null;
  // Anchor is element or text node; text inside wrap always has a parentElement.
  const el = node.nodeType === 3 ? node.parentElement! : (node as Element);
  return el.closest<HTMLElement>('.note-line');
}

/** All block-lines the selection touches; the current one when it is collapsed. */
function selectedLines(wrap: HTMLElement): HTMLElement[] {
  const sel = selectionNow();
  const lines = [...wrap.querySelectorAll<HTMLElement>('.note-line')];
  if (!sel.rangeCount) { const l = currentLine(wrap); return l ? [l] : []; }
  const range = sel.getRangeAt(0);
  if (range.collapsed) { const l = currentLine(wrap); return l ? [l] : []; }
  const hit = lines.filter(line => range.intersectsNode(line));
  if (hit.length) return hit;
  const l = currentLine(wrap);
  return l ? [l] : [];
}

/** How far into its line the caret sits, in characters. */
function caretOffset(line: Element): number {
  const sel = selectionNow();
  if (!sel.rangeCount) return 0;
  const r = sel.getRangeAt(0);
  const pre = document.createRange();
  pre.selectNodeContents(line);
  pre.setEnd(r.endContainer, r.endOffset);
  return pre.toString().length;
}

function caretTo(line: Element, offset: number) {
  const sel = selectionNow();
  const range = document.createRange();
  const first = line.firstChild;
  // nodeType 3 = Text node; cast is safe because the check precedes it.
  const t = first && first.nodeType === 3 ? (first as Text) : null;
  if (t) range.setStart(t, Math.min(offset, t.length));
  else range.setStart(line, 0);
  range.collapse(true);
  sel.removeAllRanges();
  sel.addRange(range);
}

/** The flattened length right now - what would land in meta.text. */
function flatLength(wrap: HTMLElement): number {
  const lines = [...wrap.querySelectorAll<HTMLElement>('.note-line')];
  return lines.reduce((n, line, i) =>
    n + NOTE_MARKER[lineTag(line)].length + textOf(line).length + (i ? 1 : 0), 0);
}

/** The rich model as the DOM currently stands, sanitised and capped. */
function readRich(wrap: HTMLElement) {
  const blocks = [...wrap.querySelectorAll<HTMLElement>('.note-line')].map(line => ({
    tag: lineTag(line),
    align: lineAlign(line),
    text: textOf(line).replace(/\n/g, ' '),
    // undefined for unmarked lines; normalizeNoteRich drops the key.
    wash: lineWash(line),
  }));
  return normalizeNoteRich({
    font: wrap.dataset.font,
    size: parseFloat(wrap.style.getPropertyValue('--note-scale')) || 1,
    valign: wrap.dataset.valign,
    blocks,
  });
}

// ---------------------------------------------------------------------------
// The toolbar
// ---------------------------------------------------------------------------

/**
 * Formatting bar over a note being edited. Every control cancels mousedown
 * to keep focus in the editor — a blur would commit the note mid-click.
 */
type NoteToolbarApi = {
  setTag(tag: NoteTag): void;
  setAlign(align: NoteAlign): void;
  setValign(v: NoteValign): void;
  /** Lines the caret is on now — read before the menu takes focus. See setWash. */
  linesNow(): Element[];
  /**
   * `lines` is required: the menu takes focus and the selection shifts before
   * the row action fires, so lines must be captured on button press.
   */
  setWash(wash: NoteWash | null, lines: Element[]): void;
  setFont(key: string): void;
  bumpSize(delta: number): void;
};

function buildToolbar(api: NoteToolbarApi) {
  const bar = document.createElement('div');
  bar.className = 'note-toolbar';
  // Stop pointer from reaching the canvas (would start dragging the note).
  bar.addEventListener('pointerdown', e => e.stopPropagation());
  // Keep focus in the editor — no control may steal it.
  bar.addEventListener('mousedown', e => { e.stopPropagation(); e.preventDefault(); });

  const groups: Record<string, HTMLDivElement> = {};
  const group = (name: string) => {
    const g = document.createElement('div');
    g.className = 'ntb-group';
    bar.append(g);
    groups[name] = g;
    return g;
  };
  // Text (headings) or CSS-drawn icon (alignment/valign). `icon` is a class suffix.
  const btn = (
    g: HTMLElement,
    { text, icon, title, fn, key }: {
      text?: string; icon?: string; title: string; fn: () => void; key?: string;
    },
  ) => {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'ntb-btn' + (icon ? ' ntb-icon' : '');
    if (icon) {
      const span = document.createElement('span');
      span.className = 'ntb-ico ntb-ico-' + icon;
      b.append(span);
    } else {
      // No icon → text is always provided.
      b.textContent = text!;
    }
    b.title = title;
    b.setAttribute('aria-label', title);
    if (key) b.dataset.key = key;
    b.addEventListener('click', fn);
    g.append(b);
    return b;
  };

  const gTag = group('tag');
  btn(gTag, { text: 'H1', title: 'Title', fn: () => api.setTag('h1'), key: 'tag:h1' });
  btn(gTag, { text: 'H2', title: 'Heading', fn: () => api.setTag('h2'), key: 'tag:h2' });
  btn(gTag, { text: '¶', title: 'Paragraph', fn: () => api.setTag('p'), key: 'tag:p' });

  const gAlign = group('align');
  btn(gAlign, { icon: 'al-left', title: 'Align left', fn: () => api.setAlign('left'), key: 'align:left' });
  btn(gAlign, { icon: 'al-center', title: 'Align centre', fn: () => api.setAlign('center'), key: 'align:center' });
  btn(gAlign, { icon: 'al-right', title: 'Align right', fn: () => api.setAlign('right'), key: 'align:right' });

  const gV = group('valign');
  btn(gV, { icon: 'va-top', title: 'Top', fn: () => api.setValign('top'), key: 'valign:top' });
  btn(gV, { icon: 'va-middle', title: 'Middle', fn: () => api.setValign('middle'), key: 'valign:middle' });
  btn(gV, { icon: 'va-bottom', title: 'Bottom', fn: () => api.setValign('bottom'), key: 'valign:bottom' });

  // The marker. A button whose face is the colour it will draw with, opening
  // the same menu the font does.
  //
  // A chip and not a glyph, and it is the same argument the menu's own swatch
  // rows are built on: an icon of a highlighter is a drawing of the tool, where
  // what anybody needs off this button is which colour is on the line the caret
  // is in. Unmarked, the chip is an empty outline - the absence drawn, rather
  // than a fifth colour meaning "none".
  //
  // Beside the placement controls rather than with the font: this sets one
  // line, like the headings and unlike the face, which is the whole sheet.
  const gWash = group('wash');
  let wash: NoteWash | null = null;
  const washBtn = document.createElement('button');
  washBtn.type = 'button';
  // `ntb-btn` alone. It carried an `ntb-wash` beside it that no stylesheet
  // defines - a class that looks like a hook and is not one, which is worse
  // than none: the next person styling the marker writes a rule against it and
  // finds it already there, doing nothing.
  washBtn.className = 'ntb-btn';
  washBtn.title = 'Highlight';
  washBtn.setAttribute('aria-label', 'Highlight');
  washBtn.setAttribute('aria-haspopup', 'menu');
  const washChip = document.createElement('span');
  washChip.className = 'ntb-chip';
  washBtn.append(washChip);
  washBtn.addEventListener('click', () => {
    // Read here, before a menu that takes focus is anywhere near the caret -
    // see setWash() in NoteToolbarApi for the whole of why.
    const lines = api.linesNow();
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
      // is the only way a string becomes a NoteWash. A key from anywhere else -
      // an older build's stored value, a hand-edited file - takes the null.
      key => api.setWash(
        (NOTE_WASHES as readonly string[]).includes(key) ? key as NoteWash : null, lines),
    );
  });
  gWash.append(washBtn);

  // The face, as a button that opens the app's own menu.
  //
  // **This was a <select>, and replacing it deleted three workarounds rather
  // than adding one.** A native dropdown is a piece of the operating system: it
  // takes focus, which the paragraph over this function says nothing in this bar
  // may do; it opens a window of its own, which swallowed the pointerup that
  // would have ended a drag and left the note being dragged by a click that had
  // already finished; and it had to be let through the focusout guard by tag
  // name, in a bar whose whole rule is that focus never leaves the editor. Each
  // of those was a special case written *around* the control. The button has
  // none of them: it cancels its mousedown like every other button here, the
  // menu is an element in this page, and the caret never moves.
  //
  // Four short words — fine as a menu, unlike the longer settings panel selects.
  const gFont = group('font');
  const LABEL: Record<string, string> = { sheet: 'Sheet', sans: 'Sans', serif: 'Serif', mono: 'Mono' };
  let font = NOTE_FONT_KEYS[0];
  const sel = document.createElement('button');
  sel.type = 'button';
  sel.className = 'ntb-btn ntb-select';
  sel.title = 'Font';
  sel.setAttribute('aria-label', 'Font');
  sel.setAttribute('aria-haspopup', 'menu');
  sel.addEventListener('click', () => {
    openMenu?.(
      sel,
      NOTE_FONT_KEYS.map(key => ({ value: key, label: LABEL[key] || key })),
      font,
      key => api.setFont(key),
    );
  });
  gFont.append(sel);

  const gSize = group('size');
  btn(gSize, { text: 'A−', title: 'Smaller', fn: () => api.bumpSize(-NOTE_SIZE_STEP), key: 'size:down' });
  btn(gSize, { text: 'A+', title: 'Larger', fn: () => api.bumpSize(NOTE_SIZE_STEP), key: 'size:up' });

  /** Light up the controls that match the line the caret is in. */
  const reflect = (
    tag: NoteTag, align: NoteAlign, valign: string, fontKey: string,
    washKey: NoteWash | undefined,
  ) => {
    for (const b of bar.querySelectorAll<HTMLElement>('.ntb-btn[data-key]')) {
      // The selector is what makes the attribute present.
      const [k, v] = b.dataset.key!.split(':');
      b.classList.toggle('is-active',
        (k === 'tag' && v === tag) || (k === 'align' && v === align) ||
        (k === 'valign' && v === valign));
    }
    // Closure state — menus are built fresh each press and need the current value.
    font = fontKey;
    sel.textContent = LABEL[fontKey] || fontKey;
    wash = washKey || null;
    // Marker button active state — not covered by the data-key loop above.
    washBtn.classList.toggle('is-active', !!wash);
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
 * the composer dialog). `onDone(text|null)`: called on commit or discard.
 * `finish(true)` tears down without committing.
 */
export type NoteEdit = { finish: (discard?: boolean) => void };

export function editNote(
  id: string,
  { surface = null, onDone = null }: {
    surface?: HTMLElement | null;
    onDone?: ((text: string | null) => void) | null;
  } = {},
): NoteEdit {
  const parts = editableNote(id);
  if (!parts) return { finish: () => {} };
  const { found, rich } = parts;
  // Bound again now they are known present. finish() below is a hoisted
  // declaration and the handlers close over both, and TypeScript will not carry
  // a guard into a function it cannot order against - so the guard is spent here
  // once, on two names that are elements from this line down.
  const node: HTMLElement = found;
  const wrap: HTMLElement = rich;

  // Close any already-open editor to avoid leaked listeners / stuck editable.
  if (editing) editing.finish();

  node.classList.add('is-editing');
  makeEditable(wrap);

  // Character count — invisible limit feels like a broken keyboard.
  const counter = document.createElement('div');
  counter.className = 'note-count';
  // In the composer, placed in the dialog's .ask-gap — on the card itself the
  // counter inherits the card's scale/rotation and lands in the wrong spot.
  const slot = surface?.querySelector<HTMLElement>('.ask-gap');
  (slot || node).append(counter);
  const refreshCount = () => {
    const left = NOTE_MAX - flatLength(wrap);
    counter.textContent = left + ' left';
    counter.classList.toggle('is-low', left <= 40);
  };

  const reflectNow = () => {
    const line = currentLine(wrap);
    toolbar.reflect(
      line ? lineTag(line) : 'p',
      line ? lineAlign(line) : 'left',
      wrap.dataset.valign || 'top',
      wrap.dataset.font || 'sheet',
      line ? lineWash(line) : undefined);
  };

  const afterEdit = () => { growNote(id); refreshCount(); reflectNow(); placeToolbar(); };

  const api: NoteToolbarApi = {
    setTag(tag) { for (const l of selectedLines(wrap)) setLineTag(l, tag); afterEdit(); },
    // Alignment applies to all lines at once — a sticky reads as one sheet.
    setAlign(align) { for (const l of wrap.querySelectorAll<HTMLElement>('.note-line')) setLineAlign(l, align); afterEdit(); },
    setValign(v) { wrap.dataset.valign = v; afterEdit(); },
    // Per-line, not per-sheet — highlighting everything says nothing.
    linesNow: () => selectedLines(wrap),
    setWash(w, lines) {
      // A line may have been removed between press and pick.
      for (const l of lines) if (wrap.contains(l)) setLineWash(l, w);
      afterEdit();
    },
    setFont(key) {
      // Object.keys() returns string[]; validated against NOTE_FONT_KEYS so the cast is safe.
      const font = (NOTE_FONT_KEYS.includes(key) ? key : 'sheet') as NoteFont;
      wrap.style.fontFamily = NOTE_FONTS[font];
      wrap.dataset.font = font;
      afterEdit();
    },
    bumpSize(delta) {
      let s = (parseFloat(wrap.style.getPropertyValue('--note-scale')) || 1) + delta;
      s = Math.min(NOTE_SIZE_MAX, Math.max(NOTE_SIZE_MIN, Math.round(s * 100) / 100));
      // setProperty requires a string.
      wrap.style.setProperty('--note-scale', String(s));
      afterEdit();
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

  // beforeinput: refusing the keystroke keeps the caret in place (truncating after would not).
  const onBeforeInput = (e: InputEvent) => {
    if (e.inputType.startsWith('delete') || e.inputType === 'historyUndo') return;
    if (e.inputType === 'insertFromPaste') return;         // handled by onPaste
    const adding = (e.data ?? '').length || 1;
    const selected = String(selectionNow()).length;
    if (flatLength(wrap) - selected + adding > NOTE_MAX) e.preventDefault();
  };

  // Markdown-style `# ` / `## ` at line start → promote to H1/H2.
  const autoformat = () => {
    const line = currentLine(wrap);
    if (!line) return;
    const text = textOf(line);
    let strip = 0, tag: NoteTag | null = null;
    if (text.startsWith('## ')) { tag = 'h2'; strip = 3; }
    else if (text.startsWith('# ')) { tag = 'h1'; strip = 2; }
    // Strip even if already that tag — default H1 + "# " should not leave literal "# ".
    if (!tag) return;
    const off = caretOffset(line);
    setLineTag(line, tag);
    line.textContent = text.slice(strip);
    caretTo(line, Math.max(0, off - strip));
  };

  // Some edits leave stray nodes outside .note-line — fold them back into
  // paragraph lines so readRich sees them. Ensures at least one line exists.
  const normalizeStructure = () => {
    let changed = false;
    for (const node of [...wrap.childNodes]) {
      // nodeType 1 = Element; tested before the cast.
      if (node.nodeType === 1 && (node as Element).classList.contains('note-line')) continue;
      if (node.nodeName === 'BR' || (node.nodeType === 3 && node.textContent === '')) {
        node.remove();
        changed = true;
        continue;
      }
      // Inherit formatting from the nearest sibling line, not model defaults.
      const near = [node.previousSibling, node.nextSibling]
        .find((n): n is Element => !!n && n.nodeType === 1
          && (n as Element).classList.contains('note-line'));
      const beside = near ?? null;
      const line = buildNoteLine({
        tag: 'p',
        align: beside ? lineAlign(beside) : 'left',
        wash: beside ? lineWash(beside) : undefined,
        text: node.textContent || '',
      });
      wrap.replaceChild(line, node);
      changed = true;
    }
    if (!wrap.querySelector('.note-line')) {
      wrap.append(buildNoteLine({ tag: 'h1', align: 'left', text: '' }));
      changed = true;
    }
    if (changed) {
      const lines = wrap.querySelectorAll<HTMLElement>('.note-line');
      const last = lines[lines.length - 1];
      caretTo(last, textOf(last).length);
    }
  };

  const onInput = () => { normalizeStructure(); autoformat(); afterEdit(); };

  const onKey = (e: KeyboardEvent) => {
    e.stopPropagation();                  // the canvas must not see Delete/space
    // Escape ends the edit on the board. In a dialog it is the dialog's word,
    // not the editor's - there it means "I did not mean to open this", and the
    // surface answers it by discarding rather than by committing.
    if (e.key === 'Escape') { if (!surface) finish(); return; }
    if (e.key === 'Enter') {
      e.preventDefault();
      const line = currentLine(wrap);
      if (!line) return;
      if (flatLength(wrap) + 1 > NOTE_MAX) return;   // a new line is a newline char
      const off = caretOffset(line);
      const full = textOf(line);
      line.textContent = full.slice(0, off);
      // New line inherits wash — a mark across a sentence must not split on Enter.
      const next = buildNoteLine({
        tag: 'p', align: lineAlign(line), wash: lineWash(line), text: full.slice(off),
      });
      line.after(next);
      caretTo(next, 0);
      afterEdit();
      return;
    }
    if (e.key === 'Backspace') {
      const line = currentLine(wrap);
      const prev = line?.previousElementSibling;
      // Only intercept the join: a Backspace anywhere else is ordinary deletion.
      if (line && prev?.classList.contains('note-line') && caretOffset(line) === 0 &&
          selectionNow().isCollapsed) {
        e.preventDefault();
        const at = textOf(prev).length;
        // Merged-into line keeps its mark — unless it is empty, in which case
        // it takes the arriving line's.
        if (!at) setLineWash(prev, lineWash(line) ?? null);
        prev.textContent = textOf(prev) + textOf(line);
        line.remove();
        caretTo(prev, at);
        afterEdit();
      }
    }
  };

  // Plaintext paste, split on newlines into block lines.
  const onPaste = (e: ClipboardEvent) => {
    e.preventDefault();
    let text = e.clipboardData?.getData('text/plain') ?? '';
    const room = NOTE_MAX - flatLength(wrap) + String(selectionNow()).length;
    if (room <= 0) return;
    text = text.slice(0, room);
    const sel = selectionNow();
    if (sel.rangeCount && !sel.isCollapsed) sel.getRangeAt(0).deleteContents();
    const line = currentLine(wrap);
    if (!line) return;
    const parts = text.split('\n');
    const off = caretOffset(line);
    const full = textOf(line);
    const head = full.slice(0, off), tail = full.slice(off);
    line.textContent = head + parts[0];
    let cur = line;
    for (let i = 1; i < parts.length; i++) {
      const last = i === parts.length - 1;
      cur = insertAfter(cur, buildNoteLine({
        // Inherits wash from the paste target line.
        tag: 'p', align: lineAlign(line), wash: lineWash(line),
        text: last ? parts[i] + tail : parts[i],
      }));
    }
    if (parts.length === 1) caretTo(line, head.length + parts[0].length);
    else caretTo(cur, parts[parts.length - 1].length);
    afterEdit();
  };

  // The font menu is mounted on <body> (outside the note), so it must be
  // checked explicitly to avoid committing the edit when a menu row is picked.
  const inMenu = (n: Node | null) => !!n && !!document.getElementById('ctx-menu')?.contains(n);

  // focusout: relatedTarget is where focus is going. Toolbar/surface/menu
  // count as "inside" — only truly leaving finishes the edit.
  const onFocusOut = (e: FocusEvent) => {
    // SAFETY: see above - a focus event out of this document goes to a Node or
    // to nothing.
    const to = e.relatedTarget as Node | null;
    if (node.contains(to) || toolbar.el.contains(to)) return;
    if (surface?.contains(to) || inMenu(to)) return;
    finish();
  };

  // Reliable close: focusout does not fire for unfocusable targets (empty canvas).
  // Capture phase — runs before the canvas eats the press.
  const onDocPointerDown = (e: PointerEvent) => {
    // target is Node | null in this document.
    const on = e.target as Node | null;
    if (node.contains(on) || toolbar.el.contains(on) || inMenu(on)) return;
    // Surface includes Cancel — must not commit before Cancel can fire.
    if (surface?.contains(on)) return;
    finish();
  };

  const onSelect = () => reflectNow();

  let done = false;
  function finish(discard = false) {
    if (done) return;
    done = true;
    if (editing?.finish === finish) editing = null;
    wrap.removeEventListener('beforeinput', onBeforeInput);
    wrap.removeEventListener('input', onInput);
    wrap.removeEventListener('keydown', onKey);
    wrap.removeEventListener('paste', onPaste);
    wrap.removeEventListener('focusout', onFocusOut);
    document.removeEventListener('pointerdown', onDocPointerDown, true);
    document.removeEventListener('selectionchange', onSelect);
    document.documentElement.classList.remove('note-edit-mobile');
    offView?.();
    removeEventListener('resize', onResize);
    wrap.contentEditable = 'false';
    counter.remove();
    toolbar.el.remove();
    node.classList.remove('is-editing');
    if (discard) { onDone?.(null); return; }
    const rich = readRich(wrap);
    const text = flattenNoteRich(rich);
    // linkify replaces the item — nothing left to write, but onDone still fires.
    if (linkify(id, text)) { onDone?.(text); return; }
    setNoteContent(id, rich, text);
    growNote(id);
    onDone?.(text);
  }

  wrap.addEventListener('beforeinput', onBeforeInput);
  wrap.addEventListener('input', onInput);
  wrap.addEventListener('keydown', onKey);
  wrap.addEventListener('paste', onPaste);
  wrap.addEventListener('focusout', onFocusOut);
  document.addEventListener('pointerdown', onDocPointerDown, true);
  document.addEventListener('selectionchange', onSelect);
  editing = { id, finish };
  refreshCount();
  // Caret at the end of the last line, ready to keep writing.
  const lines = wrap.querySelectorAll<HTMLElement>('.note-line');
  const last = lines[lines.length - 1];
  if (last) { last.focus?.(); caretTo(last, textOf(last).length); }
  wrap.focus();
  reflectNow();
  return { finish };
}

/** Open the composer dialog on an existing board note. No `added` entry — the
 * note already exists, so there is nothing to take back on cancel. */
export function editNoteInComposer(id: string) {
  openComposer(id, null);
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

/** `added` is whatever lastCommand() answered - the entry composeNote() made. */
function openComposer(id: string, added: ReturnType<typeof lastCommand>) {
  // Falls back to inline editNote() when the dialog is absent.
  const dlg = document.getElementById('compose') as HTMLDialogElement | null;
  const mount = document.getElementById('compose-mount');
  const node: HTMLElement | undefined = nodeFor(id);
  if (!node || !mount || typeof dlg?.showModal !== 'function') { editNote(id); return; }
  // Must check editability before moving the card into the dialog.
  if (!editableNote(id)) { editNote(id); return; }

  // Draw the note at a standard width (EDIT_W), not its own board size — the
  // dialog is for writing, not for layout.
  const prevWidth = node.style.width;
  const prevHeight = node.style.height;
  const prevHalfW = node.style.getPropertyValue('--half-w');

  // Bookmark the card's position in the world layer for restoration.
  const home = node.parentElement;
  const after = node.nextSibling;
  mount.append(node);

  // Clamp sheet width to what the dialog viewport can hold (innerWidth − 48/32).
  const sheetW = Math.min(Math.max(200, Math.min(EDIT_W, innerWidth - 48)), innerWidth - 32);
  node.style.width = sheetW + 'px';
  // --half-w must match — margins are width-dependent (cards.css).
  node.style.setProperty('--half-w', (sheetW / 2) + 'px');
  // Min height = sheetW so short notes are a square sheet, not a strip.
  // Measured after mount — a culled card in the world layer answers 0.
  const fit = () => { node.style.height = Math.max(sheetW, noteHeight(id)) + 'px'; };
  // Registered before editNote(), which grows the note as part of starting.
  standIn = { id, fit };
  fit();

  // Remove the board's inline transform (sub-pixel snap / rotation) while in
  // the dialog. Stashed and restored — placeBox() does not rerun on return.
  const worldTransform = node.style.transform;
  node.style.transform = '';

  // Both buttons live inside #compose in index.html.
  const go = document.getElementById('compose-go')!;
  const cancel = document.getElementById('compose-cancel')!;
  // "Add" for new notes, "Save" for existing ones.
  go.textContent = added ? 'Add' : 'Save';
  dlg.setAttribute('aria-label', added ? 'Write a note' : 'Edit note');

  const handle = editNote(id, {
    surface: dlg,
    onDone: text => {
      go.removeEventListener('click', onGo);
      cancel.removeEventListener('click', onCancel);
      dlg.removeEventListener('cancel', onEscape);
      // Restore stashed styles before returning the card to the world layer.
      standIn = null;
      node.style.width = prevWidth;
      node.style.height = prevHeight;
      node.style.setProperty('--half-w', prevHalfW);
      node.style.transform = worldTransform;
      dlg.close();
      // Sibling may have been detached by culling — append as fallback.
      if (home) {
        if (after && after.parentNode === home) home.insertBefore(node, after);
        else home.appendChild(node);
      } else node.remove();
      if (text?.trim()) {
        // Re-grow at board width — dialog grows went to the stand-in.
        growNote(id);
        // Landing animation.
        node.classList.add('is-landing');
        node.addEventListener('animationend', () => node.classList.remove('is-landing'), { once: true });
        return;
      }
      // Empty note: if we just created it (`added`), take it back; existing
      // empty notes are left alone — emptying is not deleting.
      if (!added) return;
      // Falls back to removeItems if takeBack fails (something else committed).
      if (!takeBack(added)) removeItems([id], 'Discard note');
    },
  });

  // Refocus the sheet after showModal()'s own focus flush — otherwise the first
  // keystroke hits Cancel. rAF runs after the flush in the same frame.
  const sheet = node.querySelector<HTMLElement>('.note-rich')!;
  dlg.showModal();
  requestAnimationFrame(() => {
    // Guard: dialog may have already closed (double-press, Escape in same frame).
    if (!dlg.open || !mount.contains(sheet)) return;
    sheet.focus();
    const lines = sheet.querySelectorAll<HTMLElement>('.note-line');
    const last = lines[lines.length - 1];
    if (last) caretTo(last, textOf(last).length);
  });

  const onGo = () => handle.finish();
  const onCancel = () => handle.finish(true);
  // preventDefault: let handle.finish(true) close the dialog, not the native cancel.
  const onEscape = (e: Event) => { e.preventDefault(); handle.finish(true); };

  go.addEventListener('click', onGo);
  cancel.addEventListener('click', onCancel);
  dlg.addEventListener('cancel', onEscape);
}

/** Composer sheet width. Life-size, not magnified — close to a typical note width. */
const EDIT_W = 320;

/** Insert `el` after `ref` and return it. */
function insertAfter<T extends Element>(ref: Element, el: T): T {
  ref.after(el);
  return el;
}

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
