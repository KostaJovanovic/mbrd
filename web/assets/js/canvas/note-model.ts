// @ts-nocheck - TypeScript migration debt, not a judgement about this file.
//
// The tree was renamed from .js to .ts mechanically, which moved 104 modules in
// one step and annotated none of them. This module is carried unchecked so that
// npm run typecheck stays green and keeps meaning something, rather than going
// red and being ignored. Converting this module IS deleting this block and
// fixing what tsc then says - tests/ts-debt.test.js holds the count and lets it
// only fall.
// The sticky-note formatting model.
//
// Lifted out of canvas/renderers.js, and the move fixes a backwards arrow as
// much as a long file: canvas/notes.js is the *editor*, and it was reaching
// through the renderer to get at the model both of them read. Neither owns it.
//
// Everything here is pure and free of the DOM on purpose, barring the two
// element builders at the end - the renderer, the editor and the tests all read
// the one model through these functions.

import { NOTE_MAX } from '../state.ts';

// ---------------------------------------------------------------------------
// Sticky-note formatting model
//
// A note used to be a title and a body split on the first newline. It is now a
// short run of formatted blocks - a heading, a subheading, paragraphs - each
// with its own alignment, over a note-level font, size and vertical placement.
//
// The structured form lives in `meta.rich`; `meta.text` stays the one plaintext
// value, Markdown-flavoured (`# ` heading, `## ` subheading), so search, linkify
// and older readers keep working and a note round-trips through a reader that
// has never heard of `meta.rich`. When both are present `meta.rich` is the truth
// and `meta.text` is what it flattens to.
//
// Everything here is pure and free of the DOM on purpose (barring the two
// element builders at the end): the renderer, the editor (canvas/notes.js) and
// the tests all read the one model through these functions.
// ---------------------------------------------------------------------------

export const NOTE_TAGS = ['h1', 'h2', 'p'];
export const NOTE_ALIGNS = ['left', 'center', 'right'];
export const NOTE_VALIGNS = ['top', 'middle', 'bottom'];

/**
 * The font families a note may wear, as an allowlist. The value reaches the DOM
 * as a `font-family` string, so it is only ever chosen from this table and never
 * taken from a file - the same rule the token allowlist keeps for the board.
 */
export const NOTE_FONTS = {
  sheet: 'var(--font-display)',
  sans: 'system-ui, sans-serif',
  serif: 'Georgia, "Times New Roman", serif',
  mono: 'ui-monospace, "Cascadia Code", Consolas, monospace',
};
export const NOTE_FONT_KEYS = Object.keys(NOTE_FONTS);

/** Size is a multiplier on the note's own zoom-scaled type, not an absolute. */
export const NOTE_SIZE_MIN = 0.7;
export const NOTE_SIZE_MAX = 1.8;
export const NOTE_SIZE_STEP = 0.1;

const clampSize = n =>
  Math.min(NOTE_SIZE_MAX, Math.max(NOTE_SIZE_MIN, Number.isFinite(+n) ? +n : 1));

/** The Markdown marker a tag writes at the head of its line. */
export const NOTE_MARKER = { h1: '# ', h2: '## ', p: '' };

/** The block a single line of Markdown-ish text describes, given its position. */
function lineToBlock(line, index) {
  if (line.startsWith('## ')) return { tag: 'h2', align: 'left', text: line.slice(3) };
  if (line.startsWith('# ')) return { tag: 'h1', align: 'left', text: line.slice(2) };
  // No marker: the first line is the note's title, as it always was, so a note
  // written before meta.rich existed still reads titled. The rest is body.
  return { tag: index === 0 ? 'h1' : 'p', align: 'left', text: line };
}

/** Blocks from the plaintext fallback - a legacy note, or an older reader's file. */
export function parseNoteText(text) {
  const lines = String(text ?? '').split('\n');
  return lines.map(lineToBlock);
}

/** One clean block, or null to drop it. */
function normalizeBlock(raw) {
  if (!raw || typeof raw !== 'object') return null;
  return {
    tag: NOTE_TAGS.includes(raw.tag) ? raw.tag : 'p',
    align: NOTE_ALIGNS.includes(raw.align) ? raw.align : 'left',
    // One line per block: a stray newline in stored text would otherwise smuggle
    // a second, unstyled line into a block the editor cannot address.
    text: typeof raw.text === 'string' ? raw.text.replace(/\n/g, ' ') : '',
  };
}

/**
 * The formatting model for a note: `meta.rich` when it is well-formed, otherwise
 * parsed back from `meta.text`. Always returns a usable object with at least one
 * block, so the renderer and the editor never have to branch on absence. The
 * total text is held to NOTE_MAX here as well as in the editor, so a hand-edited
 * file cannot get a novel onto a sticky.
 */
export function normalizeNoteRich(rich, text = '') {
  let blocks = Array.isArray(rich?.blocks)
    ? rich.blocks.map(normalizeBlock).filter(Boolean)
    : parseNoteText(text);
  if (!blocks.length) blocks = [{ tag: 'h1', align: 'left', text: '' }];
  // Trim from the end until the flattened text fits, keeping at least one block.
  let budget = NOTE_MAX;
  blocks = blocks.filter((b, i) => {
    const cost = NOTE_MARKER[b.tag].length + b.text.length + (i ? 1 : 0);
    if (budget <= 0 && i) return false;
    budget -= cost;
    return true;
  });
  if (budget < 0) {
    const last = blocks[blocks.length - 1];
    last.text = last.text.slice(0, Math.max(0, last.text.length + budget));
  }
  return {
    font: NOTE_FONT_KEYS.includes(rich?.font) ? rich.font : 'sheet',
    size: clampSize(rich?.size),
    valign: NOTE_VALIGNS.includes(rich?.valign) ? rich.valign : 'top',
    blocks,
  };
}

/**
 * The plaintext a rich model flattens to - the Markdown that lands in meta.text.
 * Font, size, alignment and vertical placement have no plaintext form and are
 * simply absent from it; that is the deal meta.text makes to stay portable.
 */
export function flattenNoteRich(rich) {
  return normalizeNoteRich(rich).blocks
    .map(b => NOTE_MARKER[b.tag] + b.text)
    .join('\n');
}

/** Write a note's board-wide look onto its rich wrapper (font, size, vAlign). */
export function applyNoteStyle(wrap, rich) {
  wrap.style.fontFamily = NOTE_FONTS[rich.font];
  wrap.style.setProperty('--note-scale', rich.size);
  wrap.dataset.font = rich.font;
  wrap.dataset.valign = rich.valign;
}

/** One block as an editable line element. */
export function buildNoteLine(block) {
  const line = document.createElement('div');
  line.className = `note-line note-${block.tag} al-${block.align}`;
  line.textContent = block.text;
  return line;
}
