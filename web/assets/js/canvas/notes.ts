// Editing a sticky note, and keeping it big enough to hold what it says.
//
// A note is a short run of formatted blocks - a heading, a subheading,
// paragraphs - each a line with its own alignment, over a note-level font, size
// and vertical placement. The blocks live in `meta.rich`; `meta.text` is the
// Markdown-flavoured plaintext they flatten to, kept for search, linkify and
// older readers. canvas/renderers.js owns that model (normalizeNoteRich /
// flattenNoteRich / buildNoteLine); this file is the editor over it.
//
// Editing turns the `.note-rich` column into a plaintext-only contenteditable
// whose children are the block lines, and floats a small toolbar above the note
// for the things typing cannot say: alignment, vertical placement, font and
// size. Kind is set from the toolbar too, or by typing `# `/`## ` at the head of
// a line. The whole edit commits once, on the way out.
//
// Two rules keep the text and the box agreed with each other:
//
//   the text can never be longer than NOTE_MAX
//   the box can never be shorter than the text needs
//
// The second is enforced from both directions - the note grows as you type, and
// a resize drag stops at the height the text requires - so there is no state in
// which a note is hiding something.
//
// Both rules are the *box* giving way, never the text. A note's type is a fixed
// size the user sets on the note (A- and A+, --note-scale); the sheet is what
// changes shape around it. Resizing a note therefore rewraps what it says and
// rescales nothing, which is also what makes the single measurement in
// noteHeight() below an answer rather than the first step of an iteration. See
// the block over --note-half in cards.css for what that replaced.
//
// One note stops being a note. If what it says turns out to be an address and
// nothing else, it becomes a link item as the edit closes - see linkify() below.

import {
  byId, bus, markDirty, setNoteContent, retypeItem, board, NOTE_MAX,
  lastCommand, takeBack, removeItems,
} from '../state.ts';
import { nodeFor, onViewChange, screenBoxOf, viewportClientRect } from './items.ts';
import { makeEditable } from '../util.ts';
import { linkURL, linkDraft } from './renderers.ts';
// The model, from the model. This module is the note *editor*; reaching through
// the renderer for the shape both of them read was an arrow pointing the wrong
// way, and the split is what let it be straightened.
import {
  normalizeNoteRich, flattenNoteRich, buildNoteLine,
  NOTE_TAGS, NOTE_ALIGNS, NOTE_FONTS, NOTE_FONT_KEYS, NOTE_MARKER, NOTE_WASHES,
  NOTE_SIZE_MIN, NOTE_SIZE_MAX, NOTE_SIZE_STEP,
} from './note-model.ts';
import type { NoteTag, NoteAlign, NoteValign, NoteFont, NoteWash } from './note-model.ts';
import type { Item } from '../board-model.ts';

/**
 * How the toolbar opens a menu, handed in rather than imported.
 *
 * The face control is a button that opens the app's own menu, and ui/menu.ts is
 * a tier above this one - a `canvas/` module importing `ui/` is a layering
 * inversion tests/layers.test.js fails on, and its DEBT map is empty and may
 * only shrink. So this is the same injection shape the codebase already uses in
 * three places: setAssetNameLookup(), setPrompt() and setOverlays(). main.ts
 * hands the implementation down; unwired, the control is simply inert, which is
 * what keeps this module loadable in a test with no browser.
 *
 * Deliberately not the whole of ui/menu.ts's surface. It is one verb - *offer
 * these, tick that one, tell me which* - so nothing here can grow a dependency
 * on how a menu is drawn.
 */
export type NoteMenu = (
  /** The control the menu hangs off. Its box, and its identity for the toggle. */
  anchor: HTMLElement,
  /**
   * `swatch` is a CSS colour, drawn in the row's icon column. Absent is not the
   * same as a colour that happens to be transparent: the marker's off row has
   * no chip at all, which is the empty column saying so.
   */
  rows: { value: string, label: string, swatch?: string }[],
  current: string,
  pick: (value: string) => void,
) => void;

let openMenu: NoteMenu | null = null;
export function setNoteMenu(fn: NoteMenu | null) { openMenu = fn; }

/**
 * The document's selection, which the editor has always dereferenced directly.
 *
 * `getSelection()` is typed nullable and answers null only for a document with
 * no browsing context - a detached iframe, never the one an editor is open in.
 * Said once here instead of at each of the seven places that read it.
 */
const selectionNow = () => getSelection()!;

/**
 * The text inside a block-line.
 *
 * `textContent` is typed nullable because it is declared on Node, where the
 * document and a doctype answer null. Every node this module reads it off is an
 * element, and an element's is always a string. Said once, for the same reason.
 */
const textOf = (el: Element): string => el.textContent!;

/**
 * Height this note needs, in world px, for its text at `width`.
 *
 * Wrapping depends on the width, so a resize has to ask about the width it is
 * *proposing*, not the one on screen. The measurement is destructive-then-
 * restored: the column is normally a flex child stretched to fill the card and
 * placed by justify-content, and a stretched element reports its box rather than
 * its content - so it is briefly released to its natural height, pinned to the
 * top, to be measured.
 *
 * One answer, never an iteration, and that is a fact about cards.css rather
 * than about this function: the sticky's type is a fixed size and its margins
 * are a share of the *width*, so nothing the caller does with the height it is
 * given can change what was just measured. While the margins came off
 * min(w, h) they could - a taller note had wider margins, so a note grown by a
 * line came back needing another one - and the loop had no exit written for it
 * because it was never visible on the square notes the ramp was drawn for.
 */
function noteHeight(id: string, width?: number | null): number {
  const el = nodeFor(id);
  const card = el?.querySelector<HTMLElement>('.card');
  const wrap = card?.querySelector<HTMLElement>('.note-rich');
  // `!el` is the same test as `!card` said in the form the type understands:
  // the card was reached through it, so one is missing only if the other is.
  if (!el || !card || !wrap) return 0;

  const prevWidth = el.style.width;
  // --half-w with it, and not as a nicety: it is w / 2, placeBox() writes it
  // from the item's *committed* width, and the sheet's padding is a clamp on
  // it. Setting the one and not the other measures the proposed width's
  // wrapping inside the old width's margins, which is wrong in the direction
  // that hides text - a note dragged wider has more room than the floor
  // measured it with.
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
  // offsetHeight is a rounded integer, so it can sit a fraction under the real
  // height; ceil plus a pixel keeps a descender off the edge.
  const need = Math.ceil(padding + wrap.offsetHeight) + 1;

  wrap.style.flex = prevFlex;
  wrap.style.height = prevHeight;
  wrap.style.justifyContent = prevJustify;
  if (width != null) {
    el.style.width = prevWidth;
    // setProperty with '' is a removal, which is the right restore for the one
    // caller that can reach here before placeBox() has written the property:
    // measuring a card built this frame would otherwise leave it pinned to the
    // measured width for good.
    el.style.setProperty('--half-w', prevHalfW);
  }
  return need;
}

/**
 * The card is standing in for itself somewhere else, at a size that is not its
 * own. Set by the composer while it holds the note; see openComposer().
 *
 * It exists so that growing a note stays *one* call from *one* place. Every
 * route that changes what a note says or how it is set - a keystroke, a paste,
 * an alignment, a font, A+ - ends at afterEdit(), and afterEdit() calls
 * growNote(). A second grower wired up beside it for the dialog would be a
 * second thing to remember to call, and the one it was forgotten on would clip
 * its text silently.
 */
let standIn: { id: string; fit: () => void } | null = null;

/**
 * Grow a note to fit its text. Never shrinks: a note you deliberately made
 * roomy should stay roomy when you delete a line, and the resize floor below
 * already stops you from making one too small by hand.
 *
 * Not undoable, on purpose - the same reasoning as adoptAspect() in
 * renderers.js. It is part of the text arriving, not an edit of its own, and an
 * undo entry per keystroke would bury the edit it belongs to.
 *
 * A note the composer is showing grows *there* and not here. The card in the
 * dialog is drawn at a standard size rather than at its own, so what it needs
 * at that size is not a fact about the note - writing it to the item would
 * resize a note on the board to fit a box it is not in. The board note is
 * re-fitted once, on the way home.
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

// A block-line is only ever read for its classes, its text and its position, so
// `Element` is the honest parameter here and it is also the wider one: the
// sibling walks in the editor below hand over an Element without knowing more.
const lineTag = (line: Element): NoteTag =>
  NOTE_TAGS.find(t => line.classList.contains('note-' + t)) || 'p';
const lineAlign = (line: Element): NoteAlign =>
  NOTE_ALIGNS.find(a => line.classList.contains('al-' + a)) || 'left';
// The odd one out, and only because the model is: an unmarked line has no wash
// at all rather than a wash of 'none', so this answers undefined where the two
// above answer a default. Read back through the allowlist all the same - the
// attribute is on an element the user has been typing into.
//
// SAFETY: every caller walks in from `.note-line`, which is an HTMLElement -
// only an HTMLElement carries a `dataset` at all, and one without it would
// throw here rather than read as unwashed.
const lineWash = (line: Element): NoteWash | undefined =>
  NOTE_WASHES.find(w => (line as HTMLElement).dataset.wash === w);

function setLineTag(line: Element, tag: NoteTag) {
  for (const t of NOTE_TAGS) line.classList.toggle('note-' + t, t === tag);
}
function setLineAlign(line: Element, align: NoteAlign) {
  for (const a of NOTE_ALIGNS) line.classList.toggle('al-' + a, a === align);
}
function setLineWash(line: Element, wash: NoteWash | null) {
  // SAFETY: the same fact lineWash() states above - a note line is an
  // HTMLElement, because that is what buildLine() made and what the editor's
  // own markup holds. `dataset` exists on nothing narrower.
  const el = line as HTMLElement;
  if (wash) el.dataset.wash = wash;
  else delete el.dataset.wash;
}

/** The block-line the caret is in, if any. */
function currentLine(wrap: HTMLElement): HTMLElement | null {
  const sel = selectionNow();
  const node = sel.anchorNode;
  if (!node || !wrap.contains(node)) return null;
  // SAFETY: two assertions, both about what a selection anchor can be: it is an
  // element or a text node and nothing else, and a text node the line above
  // found inside `wrap` has a parent element by definition. Neither can fire.
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
  // SAFETY: nodeType 3 is a text node, which is the only kind that has a
  // `length` to clamp against - that check is the cast.
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
    // undefined on an unmarked line, and normalizeNoteRich drops the key rather
    // than storing it - the whole of what keeps an unmarked note's blocks the
    // shape they were before there was a marker. See NoteWash.
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
 * The little formatting bar over a note being edited. Its controls must not
 * steal focus from the editor - a blur would commit the note out from under the
 * click - so every one of them cancels the mousedown that would move focus.
 *
 * **There is no exception to that any more.** There used to be one, for the
 * font <select>: a native dropdown has to take focus to open, so the rule was
 * written with a hole in it and the focusout guard had to let one tag name
 * through. The face is a button opening the app's own menu now, so the rule is
 * whole - see the note over it.
 */
type NoteToolbarApi = {
  setTag(tag: NoteTag): void;
  setAlign(align: NoteAlign): void;
  setValign(v: NoteValign): void;
  /**
   * The lines the caret is on right now, for a control that is about to open a
   * menu over them. See setWash().
   */
  linesNow(): Element[];
  /**
   * `lines` is which lines to mark, and it is not optional by accident: the
   * marker is the one control in this bar that acts on a *selection* rather
   * than on the sheet, and it is also the one that opens a menu.
   *
   * The menu takes focus (it is opened with `focus: true`, which is right - it
   * was opened by a press), and ui/menu.ts closes the panel *before* running a
   * row's action, with close() handing focus back to the contenteditable. So a
   * setWash that resolved the selection when the row was pressed resolved it
   * against whatever caret that hand-back had left: select three lines, press
   * the marker, pick Amber, and the mark landed on one line or none. The lines
   * are read when the button is pressed, which is when the person still has
   * them selected.
   */
  setWash(wash: NoteWash | null, lines: Element[]): void;
  setFont(key: string): void;
  bumpSize(delta: number): void;
};

function buildToolbar(api: NoteToolbarApi) {
  const bar = document.createElement('div');
  bar.className = 'note-toolbar';
  // The bar lives inside the .item, so a press on it would otherwise reach the
  // canvas and start dragging the note. Stop the press at the bar; the buttons
  // still get their click.
  //
  // This used to have a second job, and it is worth recording that it is done:
  // the font <select>'s native dropdown swallowed the pointerup that would have
  // ended the drag, so a note stayed stuck to the pointer after choosing a face.
  // That was never fixable from here - the window that ate the event was not
  // this page's - and it went with the control.
  bar.addEventListener('pointerdown', e => e.stopPropagation());
  // Keep focus in the editor. Every control in this bar, without exception -
  // see the note over this function for the one there used to be.
  bar.addEventListener('mousedown', e => { e.stopPropagation(); e.preventDefault(); });

  const groups: Record<string, HTMLDivElement> = {};
  const group = (name: string) => {
    const g = document.createElement('div');
    g.className = 'ntb-group';
    bar.append(g);
    groups[name] = g;
    return g;
  };
  // A button carrying either text (the headings) or a CSS-drawn icon (the
  // alignment and vertical-placement controls, whose glyphs no font can be
  // trusted to have). `icon` is a class suffix; the shape is painted in the CSS.
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
      // The two are alternatives: every caller passing no `icon` passes a
      // `text`, which is the branch this is.
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
  // It is also the one dropdown in the app where the list is four short words.
  // The settings panel's are not - see the note in ui/settings-schema.ts for why
  // those stay native.
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
    // Both held in a closure rather than read back off their controls, which is
    // what a <select> gave for free and a button does not: each menu is built
    // fresh on every press and needs to know which row to tick.
    font = fontKey;
    sel.textContent = LABEL[fontKey] || fontKey;
    wash = washKey || null;
    // The marker button lights up like every other control in the bar when the
    // line under the caret carries a mark. The loop above only walks
    // `.ntb-btn[data-key]` - the tag, alignment and placement glyphs - and
    // neither this button nor the face carries one, so cards.css's
    // `.ntb-btn.is-active .ntb-chip` rule could never match and the marker gave
    // no pressed state at all beyond the colour in its chip.
    washBtn.classList.toggle('is-active', !!wash);
    // The chip carries the name and cards.css turns it into the colour, which is
    // the same rule the line on the sheet is painted by. Removed rather than set
    // to anything when there is no mark - the empty outline is a rule keyed on
    // the attribute being absent.
    if (wash) washChip.dataset.wash = wash;
    else delete washChip.dataset.wash;
  };

  return { el: bar, reflect };
}

// ---------------------------------------------------------------------------
// The editor
// ---------------------------------------------------------------------------

/**
 * The card and the column an edit needs, or null if this is not an editable
 * note on screen.
 *
 * Spelled out rather than left to nodeFor(): this module is the note editor and
 * what it needs of the card is an element it can measure and make editable,
 * which is a statement about this file rather than about that one.
 *
 * Its own function because openComposer() has to ask the same question *before*
 * it moves the card into the dialog. It used to call showModal() and then hand
 * the id to editNote(), which answers a no-op `finish` on exactly these
 * conditions - so a non-note id (reachable from the console handle:
 * `mbrd.cmds.editNote(<id>)`) opened a modal whose Save, Cancel and Escape were
 * all dead, with the card stranded in #compose and the geometry restore never
 * run. One check, asked in both places.
 */
function editableNote(id: string): { found: HTMLElement; rich: HTMLElement } | null {
  const item = byId(id);
  const found: HTMLElement | undefined = nodeFor(id);
  const rich = found?.querySelector('.card')?.querySelector<HTMLElement>('.note-rich');
  if (!item || item.type !== 'note' || !found || !rich) return null;
  return { found, rich };
}

/**
 * Turn a note into an editable column of blocks until focus leaves it.
 *
 * The note commits on focusout, not on blur, and the guard lets focus move
 * anywhere inside the item - between lines, and onto the toolbar's <select> -
 * without ending the edit. Only leaving the item entirely finishes it.
 *
 * `surface` is the one option, and it exists for composeNote() below: an
 * element that counts as part of this edit. Given one, the toolbar is mounted
 * inside it rather than floated over the board, and a press or a focus landing
 * anywhere in it - on the bar, on the dialog's own buttons, on the padding
 * between them - does not end the edit. Everything else about the editor is
 * the same code either way, which is the point.
 *
 * `onDone` is called once the edit is over, with the note's flattened text, or
 * with null if it was discarded. Returns `{ finish }`, and `finish(true)` is
 * the discard: it tears the editor down and commits nothing, which is a thing
 * only a caller that owns the item can sensibly ask for.
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

  // Close any editor already open - including a stale one on this very note -
  // before starting, so an edit is never begun on top of another. Without this a
  // second open leaks the first's listeners and leaves its note contentEditable,
  // which then takes a plain click as an edit for the rest of the session.
  if (editing) editing.finish();

  node.classList.add('is-editing');
  makeEditable(wrap);

  // How much room is left, shown only while the note is being written. A limit
  // you cannot see is indistinguishable from a broken keyboard.
  const counter = document.createElement('div');
  counter.className = 'note-count';
  // In the composer it belongs to the dialog rather than to the sheet, and that
  // is not tidiness. Hung off the card it is a child of a box drawn at twice
  // life size and leaning a degree off square, so "just under the right-hand
  // corner" resolves against a scaled, rotated box and lands somewhere over the
  // note at whatever size the scale left it - which is how a counter reading
  // "475 left" came out twenty-one pixels wide behind the sheet.
  //
  // The dialog's button row is flat, at one scale, and already carries a gap
  // that pushes Cancel and Save to the right. That gap is the one piece of the
  // dialog nothing else wants, and it puts the number at the opposite end of
  // the same line from the buttons - which is where a form puts one.
  //
  // No slot of its own in index.html, deliberately: an element that exists to
  // be filled by one caller is a slot, and .ask-gap already *is* that shape.
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
    // Alignment is a property of the note, not of one line: a sticky reads as one
    // sheet, so every line takes the alignment at once whatever the caret is in.
    setAlign(align) { for (const l of wrap.querySelectorAll<HTMLElement>('.note-line')) setLineAlign(l, align); afterEdit(); },
    setValign(v) { wrap.dataset.valign = v; afterEdit(); },
    // A line at a time, like the headings and unlike the alignment. A marker is
    // drawn over the words you meant, and a note whose every line is
    // highlighted has said nothing about any of them - at which point the tint
    // of the sheet is the control that was wanted.
    linesNow: () => selectedLines(wrap),
    setWash(w, lines) {
      // Only the ones still on the sheet: an edit can have removed a line
      // between the press and the pick.
      for (const l of lines) if (wrap.contains(l)) setLineWash(l, w);
      afterEdit();
    },
    setFont(key) {
      // SAFETY: NOTE_FONT_KEYS is Object.keys(NOTE_FONTS) and so answers `true`
      // only for a NoteFont; 'sheet' is one as well. The cast is that pair of
      // facts, which Object.keys() cannot say for itself.
      const font = (NOTE_FONT_KEYS.includes(key) ? key : 'sheet') as NoteFont;
      wrap.style.fontFamily = NOTE_FONTS[font];
      wrap.dataset.font = font;
      afterEdit();
    },
    bumpSize(delta) {
      let s = (parseFloat(wrap.style.getPropertyValue('--note-scale')) || 1) + delta;
      s = Math.min(NOTE_SIZE_MAX, Math.max(NOTE_SIZE_MIN, Math.round(s * 100) / 100));
      // String() for the same reason applyNoteStyle() gives: setProperty takes a
      // string, and the binding layer was doing this conversion unsaid.
      wrap.style.setProperty('--note-scale', String(s));
      afterEdit();
    },
  };

  const toolbar = buildToolbar(api);
  // The bar always lives in screen space (in #viewport), never in the item, so
  // it is never scaled by zoom and never clipped by the item box. Mobile pins it
  // to the top of a narrow board; desktop floats it just above the note and
  // clamps it to the viewport so an edge note's bar cannot fall off screen.
  const viewportEl = document.getElementById('viewport');
  // Pin the bar to the top of the screen on the Mobile board, and on any screen
  // too narrow to hold the floating bar without it running off an edge - which
  // is a phone showing a *Desktop* board, where layoutMode is still 'desktop'
  // but the viewport is a phone's. The float is a fixed run of five control
  // groups; below roughly a phone's width it cannot fit, so it takes the top
  // strip the same way the Mobile board's does. matchMedia is read here, in the
  // handler, never at module load - see tests/imports.test.js.
  const narrow = typeof matchMedia === 'function' && matchMedia('(max-width: 640px)').matches;
  // A surface is neither of the two: the bar is a row of the dialog, sitting
  // above the sheet in ordinary flow, so there is nothing to pin and nothing to
  // follow. It cannot take the mobile treatment either - that one clears the
  // foot of the *board*, and the board is not what is being written on.
  const mobile = !surface && (board.layoutMode === 'mobile' || narrow);
  if (surface) {
    toolbar.el.classList.add('is-inline');
  } else if (mobile) {
    toolbar.el.classList.add('is-mobile');
    // The bar takes the foot of the screen for the duration of the edit, in
    // place of the add bar and the bin/undo/redo strip; the root class hides
    // those so the two never stack. Removed in finish().
    document.documentElement.classList.add('note-edit-mobile');
  } else {
    toolbar.el.classList.add('is-float');
  }
  (surface || viewportEl || node).append(toolbar.el);

  // The bar's own size, measured once instead of on every frame.
  //
  // This runs on every view change for the whole length of an edit, so the four
  // measurements it used to take - the viewport's rect, the note's rect, and the
  // bar's width and height - were four reads landing immediately after the view
  // wrote #world's transform, which is a forced synchronous layout of the whole
  // page per frame of every pan. Three of the four are now computed from what
  // the viewport already knows (see screenBoxOf / viewportClientRect); this is
  // the fourth, and it is the only one that genuinely needs the DOM.
  //
  // It is also the one that holds still. The bar is a fixed run of five control
  // groups whose <select>s are sized by their widest option, so nothing a person
  // can do mid-edit changes its box - only a window resize can, by way of the
  // root font size, and that is where it is re-measured.
  let barW = 0, barH = 0;
  const measureBar = () => { barW = toolbar.el.offsetWidth; barH = toolbar.el.offsetHeight; };

  // Keep the bar over the note and inside the viewport, flipping below the note
  // when there is no room above. Desktop floats a compact bar centred on the
  // note; mobile spans the whole board width, a wrapped strip above the note.
  const placeToolbar = () => {
    // Mobile pins to the foot of the screen by CSS, and an inline bar is placed
    // by the flow it is in - nothing to compute for either.
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

  // beforeinput, not a check after the fact: refusing the keystroke leaves the
  // caret where it was, where truncating afterwards would move it and quietly
  // eat whatever the paste was meant to add.
  const onBeforeInput = (e: InputEvent) => {
    if (e.inputType.startsWith('delete') || e.inputType === 'historyUndo') return;
    if (e.inputType === 'insertFromPaste') return;         // handled by onPaste
    const adding = (e.data ?? '').length || 1;
    const selected = String(selectionNow()).length;
    if (flatLength(wrap) - selected + adding > NOTE_MAX) e.preventDefault();
  };

  // Typing `# ` or `## ` at the head of a line promotes it and swallows the
  // marker, the way a Markdown editor does - a shortcut for the toolbar's H1/H2.
  const autoformat = () => {
    const line = currentLine(wrap);
    if (!line) return;
    const text = textOf(line);
    let strip = 0, tag: NoteTag | null = null;
    if (text.startsWith('## ')) { tag = 'h2'; strip = 3; }
    else if (text.startsWith('# ')) { tag = 'h1'; strip = 2; }
    // Strip whenever a marker is present, even if the line is already that kind:
    // the default first line is a title, and typing "# " on it should promote-
    // and-swallow like anywhere else rather than leaving a literal "# ".
    if (!tag) return;
    const off = caretOffset(line);
    setLineTag(line, tag);
    line.textContent = text.slice(strip);
    caretTo(line, Math.max(0, off - strip));
  };

  // Some edits - select-all then type, a few paste paths - leave raw text or a
  // bare <div>/<br> straight in the column, outside any line, where readRich
  // cannot see it. Fold every stray node back into a paragraph line so the
  // content is never lost, and there is always at least one line to type in.
  const normalizeStructure = () => {
    let changed = false;
    for (const node of [...wrap.childNodes]) {
      // SAFETY: nodeType 1 is an element, which is the whole of what the cast
      // says, and the && makes the test happen first.
      if (node.nodeType === 1 && (node as Element).classList.contains('note-line')) continue;
      if (node.nodeName === 'BR' || (node.nodeType === 3 && node.textContent === '')) {
        node.remove();
        changed = true;
        continue;
      }
      // A stray node arrives with no formatting of its own, so it takes the
      // formatting of the line it landed beside rather than the model's
      // defaults. Folding it into a hard `{p, left}` was how a marked,
      // right-aligned paragraph lost both the moment an engine dropped a bare
      // text node into the wrapper - which is what this function exists to
      // tidy up after, not an edit anybody made.
      // A ChildNode has no *Element sibling; walk the two neighbours by hand
      // and take whichever of them is a line.
      //
      // SAFETY: nodeType 1 again, tested in the same expression that casts.
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
      // The mark travels with the alignment. It did not, so pressing Enter in
      // the middle of a marked line left the second half unmarked - a mark
      // somebody drew across a sentence came apart at the point they typed.
      // `wash` is absent rather than falsy on an unmarked line, which is what
      // buildNoteLine() reads, so passing undefined through is right.
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
        // Whose mark the merged line carries. A block carries one, so one of
        // the two has to go, and the rule is the one every editor uses: the
        // line being merged *into* keeps its formatting.
        //
        // The exception is the case that rule gets wrong, and it was the whole
        // of the damage. Backspacing at the top of a marked line to close up a
        // blank line above it merged into an *empty* line - which carries no
        // mark and had none to lose - and the mark went with it. An empty line
        // has no formatting anybody chose, so it takes the arriving line's.
        if (!at) setLineWash(prev, lineWash(line) ?? null);
        prev.textContent = textOf(prev) + textOf(line);
        line.remove();
        caretTo(prev, at);
        afterEdit();
      }
    }
  };

  // Plaintext paste, split into block lines on its own newlines so a pasted
  // paragraph does not smuggle unaddressable lines into one block.
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
        // Marked like the line being pasted into, for the reason Enter gives
        // above: the paste is happening inside a marked sentence, and the
        // continuation of it is part of the same mark.
        tag: 'p', align: lineAlign(line), wash: lineWash(line),
        text: last ? parts[i] + tail : parts[i],
      }));
    }
    if (parts.length === 1) caretTo(line, head.length + parts[0].length);
    else caretTo(cur, parts[parts.length - 1].length);
    afterEdit();
  };

  /**
   * The toolbar's own menu, which is not inside the toolbar.
   *
   * ui/menu.ts mounts its panel on <body> - it has to, because a menu pinned to
   * the window cannot live inside a card that pans and zooms. So the face menu,
   * which the bar opens and which is as much a part of the bar as any button on
   * it, lands *outside* both tests below. Without this, choosing a face is a
   * press outside the note: the note commits, the editor tears down, and the
   * menu is left standing over a card that is no longer being edited.
   *
   * Looked up on each press rather than captured, because the panel is built
   * fresh every time it opens and there is none between times.
   */
  const inMenu = (n: Node | null) => !!n && !!document.getElementById('ctx-menu')?.contains(n);

  // focusout fires before the new element takes focus, so relatedTarget is where
  // focus is *going* - the one moment we can tell "moved within the note" from
  // "left it entirely". The toolbar counts as inside, wherever it is mounted: on
  // Mobile it lives in the viewport rather than the item, so a control on it
  // would otherwise read as leaving and commit the note out from under the tap.
  // SAFETY: the casts on both handlers say the same thing: where focus is
  // going, and what a press landed on, are nodes in this document or nothing at
  // all. `relatedTarget` and `target` are typed EventTarget because an event may
  // come off a worker or a socket; these two are pointer and focus events out of
  // the DOM, and `contains()` takes the null either way.
  const onFocusOut = (e: FocusEvent) => {
    // SAFETY: see above - a focus event out of this document goes to a Node or
    // to nothing.
    const to = e.relatedTarget as Node | null;
    if (node.contains(to) || toolbar.el.contains(to)) return;
    if (surface?.contains(to) || inMenu(to)) return;
    finish();
  };

  // A press anywhere outside the note and its toolbar commits and closes. This is
  // the reliable close: focusout does not fire when the press lands on something
  // the canvas refuses focus to (an empty spot, another card), which would leave
  // the note editable. Capture phase, so it runs before the canvas eats the press.
  //
  // SAFETY: `target` on a pointer event out of this document is a Node or
  // nothing - see the paragraph above onFocusOut.
  const onDocPointerDown = (e: PointerEvent) => {
    // SAFETY: as above - a pointer event in this document landed on a Node.
    const on = e.target as Node | null;
    if (node.contains(on) || toolbar.el.contains(on) || inMenu(on)) return;
    // A press on the surface is a press on the thing the note is being written
    // in, which includes its Cancel button - and a Cancel that had already
    // committed the note by the time it was released would not be one.
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
    // linkify retires this item and mints a link in its place, so there is
    // nothing left here to write to - but the edit is still over, and whoever
    // asked for it still has to hear so.
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

/**
 * Write a new note in front of the board, and drop it there.
 *
 * The note is made first and is a real item from the start - which is what
 * makes this the note editor and not a second one. The card the canvas built
 * for it is lifted out of the world layer into #compose for as long as it is
 * being written, and put back where it came from afterwards; everything
 * between those two moves is editNote() doing exactly what it does on the
 * board. The pad colour, the heading, the alignment, the font, the size, the
 * character count, a note that turns out to be nothing but a URL becoming a
 * link - all of it is the same code, because it is the same note.
 *
 * `make` is how the note is made rather than the note itself, and that is the
 * whole of why this owns the making: cancelling has to take back the add, and
 * to take back a command you have to be holding it. The command is captured
 * either side of the call, so a `make` that commits nothing is noticed rather
 * than assumed about. See takeBack() in history.js - this used to reason "the
 * add must still be the top of the stack", which was true and stayed true only
 * as long as three unrelated functions went on not committing.
 *
 * A maker rather than an import, because canvas/ may not reach into import/ for
 * anything but the format catalog, and addNote() lives there.
 *
 * Without the dialog - an older shell, a page stripped of it - the note is
 * still written, just on the board, which is where the context menu writes one
 * anyway.
 */
/**
 * The composer, opened on a note that is already on the board.
 *
 * Editing a sticky used to be the floating bar over the card, and composing a
 * new one the dialog - two surfaces for one act, and the smaller of the two got
 * the harder job. The bar is around 700px of controls for a note 130 wide: it
 * cannot sit beside what it edits, so it sits over the cards behind it, and at
 * the right-hand edge of the board it runs out of room to sit anywhere. The
 * dialog has the space the controls actually need, dims everything that is not
 * this note, and gives the words a sheet of a sensible size to be written on
 * whatever size the note itself is.
 *
 * No `added` to hand on, and that is the whole difference between the two ways
 * in - see onDone in openComposer(), where it is the one thing an empty note is
 * read against. No animation frame either: composeNote() waits one because the
 * card it is about was made a moment ago and the canvas has not built it yet,
 * and a card already on the board has no such wait to do.
 */
export function editNoteInComposer(id: string) {
  openComposer(id, null);
}

export function composeNote(make: () => Item | null | undefined) {
  const before = lastCommand();
  const item = make();
  if (!item) return;
  // Null when `make` committed nothing, which is the case takeBack() must not
  // be handed: the top of the stack would then be somebody else's command.
  const added = lastCommand() === before ? null : lastCommand();
  // A frame, so the canvas has built the card before it is asked for.
  requestAnimationFrame(() => openComposer(item.id, added));
}

/** `added` is whatever lastCommand() answered - the entry composeNote() made. */
function openComposer(id: string, added: ReturnType<typeof lastCommand>) {
  // SAFETY: #compose is a <dialog> in index.html, and the showModal() test
  // below is the runtime half of that claim: a page stripped of it, or one that
  // renamed the id, takes the other branch rather than calling into nothing.
  const dlg = document.getElementById('compose') as HTMLDialogElement | null;
  const mount = document.getElementById('compose-mount');
  const node: HTMLElement | undefined = nodeFor(id);
  if (!node || !mount || typeof dlg?.showModal !== 'function') { editNote(id); return; }
  // And the check editNote() makes for itself, asked here because everything
  // below this line moves the card, resizes it and opens a modal round it -
  // and editNote()'s way of declining is a `finish` that does nothing, which
  // would leave all three of the dialog's buttons dead over a card stranded in
  // #compose. See editableNote().
  if (!editableNote(id)) { editNote(id); return; }

  // The dialog draws every note on the same sheet, whatever the note's own box
  // is, and this is the whole of what it is for: it is where the words are
  // written, and nowhere else in the app is the size of the paper a thing you
  // are asked about while you are choosing them.
  //
  // It showed the note at its own size for a while, magnified, on the argument
  // that a writer should see what they are making. What that produced was a
  // dialog whose shape was somebody else's earlier decision - a note dragged
  // out into a banner opened as a letterbox two lines deep and half the screen
  // wide, one dragged narrow opened as a chimney, and the sheet jumped a step
  // wider or taller as the note grew under the caret. None of that is about the
  // sentence being written. The board is where a note has a shape; here it has
  // a column to write down.
  //
  // So: EDIT_W across, at least EDIT_W down, growing downwards to hold what is
  // typed and never sideways. Everything about how the words are *set* is still
  // true here - the type is a fixed size (see cards.css), so the line breaks
  // fall where they fall on a note this wide and the sheet is legible without
  // being magnified. What is not true here is the note's own width, and the
  // wrapping that follows from it; the board is one refresh away.
  const prevWidth = node.style.width;
  const prevHeight = node.style.height;
  const prevHalfW = node.style.getPropertyValue('--half-w');

  // Where the canvas had it, to the sibling: the world layer is in z-order and
  // handing the card back at the end of the row would put it in front of things
  // it belongs behind until the next repaint.
  const home = node.parentElement;
  const after = node.nextSibling;
  mount.append(node);

  // EDIT_W, or what the window can hold, whichever is less. The dialog is
  // allowed the viewport less 32px (#compose in dialog.css) and the sheet has to
  // sit inside that with room to look like it was put there - on a narrow phone
  // the full sheet would hang off both sides of a dialog that had already given
  // it everything it had. Read once, here: a modal is not a thing you resize the
  // window behind.
  // The floor is a floor and not an override. `Math.max(200, ...)` wins outright
  // below an innerWidth of 248, and the dialog is capped at the viewport less
  // 32px (#compose in dialog.css) - so on anything narrower the sheet was drawn
  // wider than the dialog it sits inside and hung off both edges. Clamped to
  // what the dialog can actually hold, with the 200 applying only where there is
  // room for it.
  const sheetW = Math.min(Math.max(200, Math.min(EDIT_W, innerWidth - 48)), innerWidth - 32);
  node.style.width = sheetW + 'px';
  // The margins are a share of the width (--note-half in cards.css), so the
  // stand-in width has to bring its own half or the sheet is drawn at this size
  // in the margins of whatever size it is on the board.
  node.style.setProperty('--half-w', (sheetW / 2) + 'px');
  // Measured at the width just set - noteHeight() with no width of its own
  // reads the card as it stands. Never below its own width, so a note of two
  // words is a sheet and not a strip, and the vertical placement the toolbar
  // sets has somewhere to place things.
  //
  // Written after the mount and not before: the world layer culls what is off
  // screen, and a note reached from the menu rather than from a double-click
  // can be measured while it is still in there. A card no browser is laying
  // out answers 0 to every measurement.
  const fit = () => { node.style.height = Math.max(sheetW, noteHeight(id)) + 'px'; };
  // Registered before editNote(), which grows the note as part of starting.
  standIn = { id, fit };
  fit();

  // The card's own transform comes off while it is out of the world layer, and
  // this is not tidiness. canvas/items.js writes `transform` *inline* on every
  // item (placeBox) and the string is almost never empty: deviceSnap() returns a
  // sub-pixel correction at any zoom and any device pixel ratio, and a rotated
  // note carries a rotate() instead. A sheet nudged a third of a pixel sideways
  // for a board zoom this dialog is not at, or stood on its corner at the angle
  // it was pinned to the board at, is the board's arrangement of the note
  // showing up in the one place that is deliberately not about it.
  //
  // Stashed rather than recomputed, and put back below: what it was is a fact
  // about the board's zoom at the moment the dialog opened, and placeBox() is
  // not called again on the way home. resnap() would rewrite it on the next view
  // change anyway - it is barred from doing so while the node is out of the
  // world layer, which is the other half of the same fix.
  const worldTransform = node.style.transform;
  node.style.transform = '';

  // Both live inside #compose in index.html, which the guard above has already
  // found and called showModal() a method of - so a page carrying the dialog
  // carries its two buttons.
  const go = document.getElementById('compose-go')!;
  const cancel = document.getElementById('compose-cancel')!;
  // The same dialog says two different things depending on which way in it was
  // opened, and the words are the whole of the difference. "Add" on a note that
  // does not exist yet is a promise the button keeps; on one that has been on
  // the board for a week it is the button offering to make a second copy, which
  // is not what it does. Written on every open rather than restored on close -
  // the markup's own "Add" is the state a fresh page is in, and one of the two
  // branches below always runs before it is seen.
  go.textContent = added ? 'Add' : 'Save';
  dlg.setAttribute('aria-label', added ? 'Write a note' : 'Edit note');

  const handle = editNote(id, {
    surface: dlg,
    onDone: text => {
      go.removeEventListener('click', onGo);
      cancel.removeEventListener('click', onCancel);
      dlg.removeEventListener('cancel', onEscape);
      // Everything the dialog wrote onto the card, off. placeBox() will write
      // all three again the next time the item's geometry changes - which is
      // exactly the event that might not come, since a note whose text did not
      // grow it never moves. Restored to what was stashed rather than cleared,
      // for the same reason.
      //
      // Before the node goes home in every case, so it is never drawn in the
      // world layer at the dialog's size or without the snap it was mounted
      // with. See the stashes above.
      standIn = null;
      node.style.width = prevWidth;
      node.style.height = prevHeight;
      node.style.setProperty('--half-w', prevHalfW);
      node.style.transform = worldTransform;
      dlg.close();
      // `after` was captured before the dialog opened; culling can detach that
      // sibling while the note is being edited, and insertBefore(node, detached)
      // throws NotFoundError and strands the card. Append when it is gone.
      if (home) {
        if (after && after.parentNode === home) home.insertBefore(node, after);
        else home.appendChild(node);
      } else node.remove();
      if (text?.trim()) {
        // The one grow the board note gets out of this sitting, now the card is
        // back at its own width and can be measured at it. Every grow while the
        // dialog was up went to the sheet in it (see standIn above), so without
        // this line a note written past the bottom of its box would keep the box
        // it had - which is the one state the second of this file's two rules
        // exists to rule out.
        growNote(id);
        // It landed. The card is already where the note lives - it was made at
        // the middle of the view, which is where the dialog was - so this is
        // the last of the movement rather than a journey.
        node.classList.add('is-landing');
        node.addEventListener('animationend', () => node.classList.remove('is-landing'), { once: true });
        return;
      }
      // Nothing was written. What that means depends entirely on whether this
      // sitting made the note: a blank note nobody has seen was never a note,
      // and a note that has been on the board and was emptied is a note
      // somebody emptied. Deleting the second would be the editor answering
      // "clear this" with "throw it away", and the undo it filed would be for
      // the wrong act.
      if (!added) return;
      // takeBack() answers false if anything has been committed since the add,
      // which cannot happen while a modal is up and is not worth being wrong
      // about: an ordinary delete is the fallback, and that one is undoable
      // like any other.
      if (!takeBack(added)) removeItems([id], 'Discard note');
    },
  });

  // The caret goes on the sheet after the dialog opens, and after is the whole
  // point of the line below. A modal's own focusing steps do not run inside
  // showModal() - they are flushed at the next rendering opportunity - so the
  // focus editNote() just set is taken away again a frame later and put on the
  // first button in the dialog, which is Cancel. The first keystroke then
  // pressed it: typing a note discarded it. Animation frame callbacks run after
  // that flush in the same rendering pass, which is the one place the caret can
  // be put back and stay put.
  // editNote() above found this same column under this same node and refused to
  // start without it, so by here it is there.
  const sheet = node.querySelector<HTMLElement>('.note-rich')!;
  dlg.showModal();
  requestAnimationFrame(() => {
    // Unless the whole thing is already over - a second press, an Escape landing
    // in the same frame - in which case the sheet is back on the board and
    // putting a caret in it is the one thing nobody asked for.
    if (!dlg.open || !mount.contains(sheet)) return;
    sheet.focus();
    const lines = sheet.querySelectorAll<HTMLElement>('.note-line');
    const last = lines[lines.length - 1];
    if (last) caretTo(last, textOf(last).length);
  });

  const onGo = () => handle.finish();
  const onCancel = () => handle.finish(true);
  // Escape reaches the dialog as a close request whatever the editor did with
  // the keystroke, and closing this one means the note was never written.
  // preventDefault so the discard closes it, rather than it closing and the
  // discard arriving at an already-shut dialog.
  const onEscape = (e: Event) => { e.preventDefault(); handle.finish(true); };

  go.addEventListener('click', onGo);
  cancel.addEventListener('click', onCancel);
  dlg.addEventListener('cancel', onEscape);
}

/**
 * The width of the sheet in the composer, and its smallest height - on any
 * window with room for it; see the clamp in openComposer(), which is also where
 * the argument for it being one number for every note is written.
 *
 * Life size, not magnified. The type is a fixed size now and 16px is 16px in a
 * dialog; while the sheet was the note's own box the magnification was there to
 * make a 120px stamp readable, and a stamp is what this number replaced.
 * Wide enough for the toolbar above it not to be a bar over a postage stamp,
 * and near enough the widest a note is usually dragged to that the line breaks
 * here are not a surprise on the board.
 */
const EDIT_W = 320;

/** Insert `el` after `ref` and return it. */
function insertAfter<T extends Element>(ref: Element, el: T): T {
  ref.after(el);
  return el;
}

/**
 * The note currently being edited, if any, so it can be closed from outside.
 *
 * There is only ever one: opening an editor moves focus, which fires focusout on
 * any other and finishes it.
 */
let editing: { id: string; finish: (discard?: boolean) => void } | null = null;

/**
 * Commit any note being edited right now, and say whether there was one.
 *
 * Until this existed, a note's text lived only in contenteditable DOM between
 * the first keystroke and the blur that ended the edit. Everything else about
 * the note was already state - typing calls growNote(), which changes the item's
 * height, which schedules a snapshot - so an autosave taken mid-edit recorded the
 * *new* height with the *old* text. And a teardown that never delivers a usable
 * focusout (a closed tab, a crash, a phone reclaiming the page) lost the edit
 * outright.
 *
 * Synchronous, so it can be called from pagehide, where nothing may await.
 */
export function flushNoteEdit() {
  if (!editing) return false;
  editing.finish();
  return true;
}

/**
 * A note written down to nothing but a URL is a link, and this is where it
 * becomes one. Returns whether it did.
 *
 * *When* matters more than what. The check runs from finish() - once, as the
 * edit is put away - and never from the input handler, because watching a note
 * dissolve into a link card as you type the last character of an address would
 * be the app taking the pen out of your hand mid-sentence. Waiting until you
 * have stepped away from the note makes the conversion something you finished
 * rather than something that happened to you, and one Ctrl+Z puts the sticky
 * back exactly as it was.
 *
 * It fires nowhere else, either. A note that already held nothing but a URL -
 * loaded from a .mbrd saved before links existed, or restored from the bin - is
 * left alone, because rewriting somebody's saved file on the way in is the same
 * surprise arriving at a worse moment. Only an edit you just made can convert the
 * thing you just edited.
 *
 * The typed text is never committed on its way past. One edit, one undo entry:
 * undoing the conversion gives back the note as it stood before the edit
 * started, not a half-way note that only ever existed in the DOM.
 *
 * The link takes the note's place, its position and its place in the stack - but
 * the link's own default size, because a sticky is square in order to hold a
 * paragraph and this holds two lines.
 *
 * Stickiness is read from live geometry rather than stored, so it needs no
 * repair: notes stuck *to* this one are stuck to a link now and go on travelling
 * with it, since a host may be anything. What does end is the other direction -
 * only notes stick, so a note that was riding on a photo stops riding on it the
 * moment it becomes a link. That is the honest outcome and not an oversight: it
 * is no longer a sticky, and a link card lying on a photo is a card lying on a
 * photo.
 */
function linkify(id: string, text: string): boolean {
  const url = linkURL(text);
  if (!url) return false;
  retypeItem(id, linkDraft(url), 'Turn note into link');
  return true;
}
