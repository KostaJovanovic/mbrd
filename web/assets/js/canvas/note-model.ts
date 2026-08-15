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

/**
 * The four vocabularies a note is written in. They are unions of string
 * literals rather than anything richer because every one of them also has to
 * survive a round trip through a file somebody else wrote - the arrays below
 * are the runtime half of the same statement, and the `is*` guards are how an
 * unknown value out of `meta.rich` gets to be one of these.
 */
export type NoteTag = 'h1' | 'h2' | 'p';
export type NoteAlign = 'left' | 'center' | 'right';
export type NoteValign = 'top' | 'middle' | 'bottom';
export type NoteFont = 'sheet' | 'sans' | 'serif' | 'mono';
/**
 * The marker a line can be drawn over with, and the one of these vocabularies
 * with no "off" member in it.
 *
 * An unmarked line is a block with no `wash` key, not a block with `wash:
 * 'none'`, and the difference is worth the sentence. Every other field here
 * describes something every line has - a level, an alignment - and a note is
 * mostly unmarked lines, so a fifth key repeating "no" on each of them is a
 * fifth of the file saying nothing. It also keeps the shape of an ordinary
 * block exactly what it was before this existed, which is what a reader written
 * against the older format still expects to find.
 */
export type NoteWash = 'amber' | 'terracotta' | 'olive' | 'graphite';

/** One line of a note: its block level, its alignment and its single line. */
export type NoteBlock = {
  tag: NoteTag;
  align: NoteAlign;
  text: string;
  /** absent, not 'none' - see NoteWash */
  wash?: NoteWash;
};

/** A whole note's formatting model, after normalizeNoteRich() has had it. */
export type NoteRich = {
  font: NoteFont;
  size: number;
  valign: NoteValign;
  blocks: NoteBlock[];
};

/**
 * What a *caller* may hand in: anything at all. `meta.rich` comes off disk, so
 * every field is unknown until a guard has looked at it.
 */
export type NoteRichInput = { [key: string]: unknown } | null | undefined;

export const NOTE_TAGS: NoteTag[] = ['h1', 'h2', 'p'];
export const NOTE_ALIGNS: NoteAlign[] = ['left', 'center', 'right'];
export const NOTE_VALIGNS: NoteValign[] = ['top', 'middle', 'bottom'];
/**
 * The four markers, in the order the menu offers them. Names and not numbers,
 * unlike the four sheets a note is cut from (`meta.tint`, 1..4): a tint is one
 * of a pack and you take the next one off it, where a mark is chosen for being
 * that colour.
 *
 * Each name is also the tail of its token - `--note-wash-amber` in tokens.css,
 * where the colours actually live - so the toolbar can build a swatch out of a
 * stored word and there is no second copy of the palette in here to drift. This
 * list is the allowlist that makes that safe, the same rule NOTE_FONTS keeps
 * below and for the same reason: `meta.rich` comes off disk.
 */
export const NOTE_WASHES: NoteWash[] = ['amber', 'terracotta', 'olive', 'graphite'];

// The widening to `readonly string[]` is only so `.includes()` will take an
// arbitrary string: a NoteTag[] *is* a readonly string[], so nothing is claimed
// here that is not already true.
const isTag = (v: unknown): v is NoteTag =>
  typeof v === 'string' && (NOTE_TAGS as readonly string[]).includes(v);
const isAlign = (v: unknown): v is NoteAlign =>
  typeof v === 'string' && (NOTE_ALIGNS as readonly string[]).includes(v);
const isValign = (v: unknown): v is NoteValign =>
  typeof v === 'string' && (NOTE_VALIGNS as readonly string[]).includes(v);
const isWash = (v: unknown): v is NoteWash =>
  typeof v === 'string' && (NOTE_WASHES as readonly string[]).includes(v);

/**
 * The font families a note may wear, as an allowlist. The value reaches the DOM
 * as a `font-family` string, so it is only ever chosen from this table and never
 * taken from a file - the same rule the token allowlist keeps for the board.
 */
export const NOTE_FONTS: Record<NoteFont, string> = {
  sheet: 'var(--font-display)',
  sans: 'system-ui, sans-serif',
  serif: 'Georgia, "Times New Roman", serif',
  mono: 'ui-monospace, "Cascadia Code", Consolas, monospace',
};
export const NOTE_FONT_KEYS = Object.keys(NOTE_FONTS);

const isFont = (v: unknown): v is NoteFont =>
  typeof v === 'string' && NOTE_FONT_KEYS.includes(v);

/** Size is a multiplier on the note's own zoom-scaled type, not an absolute. */
export const NOTE_SIZE_MIN = 0.7;
export const NOTE_SIZE_MAX = 1.8;
export const NOTE_SIZE_STEP = 0.1;

const clampSize = (n: unknown) =>
  Math.min(NOTE_SIZE_MAX, Math.max(NOTE_SIZE_MIN, Number.isFinite(Number(n)) ? Number(n) : 1));

/** The Markdown marker a tag writes at the head of its line. */
export const NOTE_MARKER: Record<NoteTag, string> = { h1: '# ', h2: '## ', p: '' };

/** The block a single line of Markdown-ish text describes, given its position. */
function lineToBlock(line: string, index: number): NoteBlock {
  if (line.startsWith('## ')) return { tag: 'h2', align: 'left', text: line.slice(3) };
  if (line.startsWith('# ')) return { tag: 'h1', align: 'left', text: line.slice(2) };
  // No marker: the first line is the note's title, as it always was, so a note
  // written before meta.rich existed still reads titled. The rest is body.
  return { tag: index === 0 ? 'h1' : 'p', align: 'left', text: line };
}

/** Blocks from the plaintext fallback - a legacy note, or an older reader's file. */
export function parseNoteText(text: unknown): NoteBlock[] {
  const lines = String(text ?? '').split('\n');
  return lines.map(lineToBlock);
}

/** One clean block, or null to drop it. */
function normalizeBlock(raw: unknown): NoteBlock | null {
  if (!raw || typeof raw !== 'object') return null;
  const tag = 'tag' in raw ? raw.tag : undefined;
  const align = 'align' in raw ? raw.align : undefined;
  const text = 'text' in raw ? raw.text : undefined;
  const wash = 'wash' in raw ? raw.wash : undefined;
  const block: NoteBlock = {
    tag: isTag(tag) ? tag : 'p',
    align: isAlign(align) ? align : 'left',
    // One line per block: a stray newline in stored text would otherwise smuggle
    // a second, unstyled line into a block the editor cannot address.
    text: typeof text === 'string' ? text.replace(/\n/g, ' ') : '',
  };
  // Written on rather than declared above, so an unmarked block is the same
  // three keys it has always been - see NoteWash. An unknown colour is dropped
  // and not repaired, which is the one place this differs from the two fields
  // over it: there is no nearest marker to round a stranger's name to, and no
  // mark is the honest reading of a mark nobody here can draw.
  if (isWash(wash)) block.wash = wash;
  return block;
}

/**
 * The formatting model for a note: `meta.rich` when it is well-formed, otherwise
 * parsed back from `meta.text`. Always returns a usable object with at least one
 * block, so the renderer and the editor never have to branch on absence. The
 * total text is held to NOTE_MAX here as well as in the editor, so a hand-edited
 * file cannot get a novel onto a sticky.
 */
export function normalizeNoteRich(rich: NoteRichInput, text: unknown = ''): NoteRich {
  let blocks: NoteBlock[] = Array.isArray(rich?.blocks)
    ? rich.blocks.map(normalizeBlock).filter((b): b is NoteBlock => Boolean(b))
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
  const font = rich?.font;
  const valign = rich?.valign;
  return {
    font: isFont(font) ? font : 'sheet',
    size: clampSize(rich?.size),
    valign: isValign(valign) ? valign : 'top',
    blocks,
  };
}

/**
 * The plaintext a rich model flattens to - the Markdown that lands in meta.text.
 * Font, size, alignment, vertical placement and the marker have no plaintext
 * form and are simply absent from it; that is the deal meta.text makes to stay
 * portable.
 */
export function flattenNoteRich(rich: NoteRichInput): string {
  return normalizeNoteRich(rich).blocks
    .map(b => NOTE_MARKER[b.tag] + b.text)
    .join('\n');
}

/** Write a note's board-wide look onto its rich wrapper (font, size, vAlign). */
export function applyNoteStyle(wrap: HTMLElement, rich: NoteRich): void {
  wrap.style.fontFamily = NOTE_FONTS[rich.font];
  // setProperty takes a string; the number was being converted by the binding
  // layer on the way in, and String() is that same conversion said out loud.
  wrap.style.setProperty('--note-scale', String(rich.size));
  wrap.dataset.font = rich.font;
  wrap.dataset.valign = rich.valign;
}

/**
 * One block as an editable line element.
 *
 * The marker is an attribute where the level and the alignment are classes, and
 * that is not inconsistency: a class is a set a line is in, and the wash is a
 * value the line *carries* into the stylesheet - cards.css turns data-wash into
 * a --wash colour, which the toolbar's own chip reads through the same rule. A
 * class would have needed the mapping written twice.
 */
export function buildNoteLine(block: NoteBlock): HTMLDivElement {
  const line = document.createElement('div');
  line.className = `note-line note-${block.tag} al-${block.align}`;
  if (block.wash) line.dataset.wash = block.wash;
  line.textContent = block.text;
  return line;
}
