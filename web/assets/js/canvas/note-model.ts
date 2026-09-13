// Sticky-note formatting model — pure, DOM-free (except the two builders at end).
// Shared by the renderer, editor (canvas/notes.ts), and tests.

import { NOTE_MAX } from '../state.ts';
import { isRecord } from '../util.ts';

// ---------------------------------------------------------------------------
// Formatted blocks: heading / subheading / paragraph, with alignment, font,
// size, vertical placement. meta.rich is the truth; meta.text is the Markdown
// plaintext fallback for search and older readers.
// ---------------------------------------------------------------------------

export type NoteTag = 'h1' | 'h2' | 'p';
export type NoteAlign = 'left' | 'center' | 'right';
export type NoteValign = 'top' | 'middle' | 'bottom';
export type NoteFont = 'sheet' | 'sans' | 'serif' | 'mono';
// Absent means unmarked — no 'none' value, to keep the block shape unchanged.
export type NoteWash = 'amber' | 'terracotta' | 'olive' | 'graphite';

export type NoteBlock = {
  tag: NoteTag;
  align: NoteAlign;
  text: string;
  wash?: NoteWash;
};

export type NoteRich = {
  font: NoteFont;
  size: number;
  valign: NoteValign;
  blocks: NoteBlock[];
};

export type NoteRichInput = { [key: string]: unknown } | null | undefined;

export const NOTE_TAGS: NoteTag[] = ['h1', 'h2', 'p'];
export const NOTE_ALIGNS: NoteAlign[] = ['left', 'center', 'right'];
export const NOTE_VALIGNS: NoteValign[] = ['top', 'middle', 'bottom'];
// Names map to --note-wash-<name> tokens in tokens.css.
export const NOTE_WASHES: NoteWash[] = ['amber', 'terracotta', 'olive', 'graphite'];

export const NOTE_TINTS = 4;

// Tint sheet number (1–4), or 0 if absent. Accepts string or number from disk.
export function noteTint(raw: unknown): number {
  const n = typeof raw === 'string' ? Number(raw) : raw;
  return typeof n === 'number' && Number.isInteger(n) && n >= 1 && n <= NOTE_TINTS ? n : 0;
}

// SAFETY: a widening to readonly string[], only so includes() takes a string.
const isTag = (v: unknown): v is NoteTag =>
  typeof v === 'string' && (NOTE_TAGS as readonly string[]).includes(v);
// SAFETY: a widening to readonly string[], only so includes() takes a string.
const isAlign = (v: unknown): v is NoteAlign =>
  typeof v === 'string' && (NOTE_ALIGNS as readonly string[]).includes(v);
// SAFETY: a widening to readonly string[], only so includes() takes a string.
const isValign = (v: unknown): v is NoteValign =>
  typeof v === 'string' && (NOTE_VALIGNS as readonly string[]).includes(v);
// SAFETY: a widening to readonly string[], only so includes() takes a string.
const isWash = (v: unknown): v is NoteWash =>
  typeof v === 'string' && (NOTE_WASHES as readonly string[]).includes(v);

// Allowlisted font families — value goes straight to font-family in the DOM.
export const NOTE_FONTS = {
  sheet: 'var(--font-display)',
  sans: 'system-ui, sans-serif',
  serif: 'Georgia, "Times New Roman", serif',
  mono: 'ui-monospace, "Cascadia Code", Consolas, monospace',
} satisfies Record<NoteFont, string>;
export const NOTE_FONT_KEYS = Object.keys(NOTE_FONTS);

const isFont = (v: unknown): v is NoteFont =>
  typeof v === 'string' && NOTE_FONT_KEYS.includes(v);

export const NOTE_SIZE_MIN = 0.7;
export const NOTE_SIZE_MAX = 1.8;
export const NOTE_SIZE_STEP = 0.1;

const clampSize = (n: unknown) =>
  Math.min(NOTE_SIZE_MAX, Math.max(NOTE_SIZE_MIN, Number.isFinite(Number(n)) ? Number(n) : 1));

export const NOTE_MARKER = { h1: '# ', h2: '## ', p: '' } satisfies Record<NoteTag, string>;

function lineToBlock(line: string, index: number): NoteBlock {
  if (line.startsWith('## ')) return { tag: 'h2', align: 'left', text: line.slice(3) };
  if (line.startsWith('# ')) return { tag: 'h1', align: 'left', text: line.slice(2) };
  // First line without marker becomes h1 for legacy notes.
  return { tag: index === 0 ? 'h1' : 'p', align: 'left', text: line };
}

export function parseNoteText(text: unknown): NoteBlock[] {
  const lines = String(text ?? '').split('\n');
  return lines.map(lineToBlock);
}

function normalizeBlock(raw: unknown): NoteBlock | null {
  if (!raw || typeof raw !== 'object') return null;
  const tag = 'tag' in raw ? raw.tag : undefined;
  const align = 'align' in raw ? raw.align : undefined;
  const text = 'text' in raw ? raw.text : undefined;
  const wash = 'wash' in raw ? raw.wash : undefined;
  const block: NoteBlock = {
    tag: isTag(tag) ? tag : 'p',
    align: isAlign(align) ? align : 'left',
    text: typeof text === 'string' ? text.replace(/\n/g, ' ') : '',
  };
  if (isWash(wash)) block.wash = wash;
  return block;
}

// Normalize meta.rich (or fall back to meta.text). Always returns >= 1 block.
export function normalizeNoteRich(rich: NoteRichInput, text: unknown = ''): NoteRich {
  let blocks: NoteBlock[] = Array.isArray(rich?.blocks)
    ? rich.blocks.map(normalizeBlock).filter((b): b is NoteBlock => Boolean(b))
    : parseNoteText(text);
  if (!blocks.length) blocks = [{ tag: 'h1', align: 'left', text: '' }];
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

// Flatten rich model to Markdown plaintext for meta.text.
export function flattenNoteRich(rich: NoteRichInput): string {
  return normalizeNoteRich(rich).blocks
    .map(b => NOTE_MARKER[b.tag] + b.text)
    .join('\n');
}

// A note's display text — strips Markdown markers, unlike flattenNoteRich().
export function noteWords(meta: unknown): string {
  if (!isRecord(meta)) return '';
  const rich = meta.rich;
  const blocks = isRecord(rich) ? rich.blocks : null;
  if (Array.isArray(blocks) && blocks.length) {
    // SAFETY: blocks is an array only when isRecord(rich) held, and a record is a NoteRichInput.
    return normalizeNoteRich(rich as NoteRichInput).blocks.map(b => b.text).join('\n');
  }
  const text = typeof meta.text === 'string' ? meta.text : '';
  return text ? parseNoteText(text).map(b => b.text).join('\n') : '';
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
 * a --note-wash colour, which the toolbar's own chip reads through the same
 * rule. A class would have needed the mapping written twice.
 *
 * The property was `--wash`, which tokens.css has owned since long before as
 * the whimsy ornament multiplier. See the block in cards.css for what that
 * collision cost.
 */
export function buildNoteLine(block: NoteBlock): HTMLDivElement {
  const line = document.createElement('div');
  line.className = `note-line note-${block.tag} al-${block.align}`;
  if (block.wash) line.dataset.wash = block.wash;
  line.textContent = block.text;
  return line;
}
