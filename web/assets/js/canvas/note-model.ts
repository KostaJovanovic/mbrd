// Sticky-note formatting model — pure, DOM-free (except the builders at end).
// Shared by the renderer, editor (canvas/notes.ts), and tests. A line is a
// list of styled runs (title, font, size, wash per run); the older block
// fields are still written beside them so an older reader keeps the words.

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

/** How one stretch of a line looks. Every field explicit once normalised. */
export type NoteStyle = {
  title: boolean;
  font: NoteFont;
  size: number;
  wash?: NoteWash;
};

/** One styled stretch of a line. */
type NoteRun =NoteStyle & { text: string };

/**
 * One line. `runs`, when present, is the truth and the other fields are
 * derived from it on normalisation: `text` their words, `tag` h1 when every
 * run is a title, `wash` when every run shares one. Absent on a line written
 * before runs existed, which reads its runs off `tag` and `wash` (blockRuns).
 */
export type NoteBlock = {
  tag: NoteTag;
  align: NoteAlign;
  text: string;
  wash?: NoteWash;
  runs?: NoteRun[];
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

/**
 * One run from anything - a file, the clipboard, the editor's own DOM. Unknown
 * values fall back to `base` (the note's sheet look) rather than failing; an
 * unknown wash is dropped, as on a block.
 */
export function normalizeRun(raw: unknown, base: Omit<NoteStyle, 'wash'>): NoteRun {
  const r = isRecord(raw) ? raw : {};
  const run: NoteRun = {
    text: typeof r.text === 'string' ? r.text.replace(/\n/g, ' ') : '',
    title: r.title === true,
    font: isFont(r.font) ? r.font : base.font,
    size: r.size == null ? base.size : clampSize(r.size),
  };
  if (isWash(r.wash)) run.wash = r.wash;
  return run;
}

/** Whether two runs look the same - what decides that they merge. */
const sameStyle =(a: NoteStyle, b: NoteStyle) =>
  a.title === b.title && a.font === b.font && a.size === b.size && a.wash === b.wash;

/** A run's look alone, with no words. */
export function styleOf(r: NoteStyle): NoteStyle {
  const s: NoteStyle = { title: r.title, font: r.font, size: r.size };
  if (r.wash) s.wash = r.wash;
  return s;
}

/**
 * Merge neighbours that look alike and drop empty runs - except a line's last
 * one when it has nothing else, which is what remembers how an empty line
 * types. Never returns an empty line.
 */
export function tidyRuns(runs: NoteRun[], fallback?: NoteStyle): NoteRun[] {
  const out: NoteRun[] = [];
  for (const r of runs) {
    if (!r.text) continue;
    const prev = out[out.length - 1];
    if (prev && sameStyle(prev, r)) prev.text += r.text;
    else out.push({ ...r });
  }
  if (out.length) return out;
  const last = runs[runs.length - 1] ?? fallback;
  return last ? [{ ...styleOf(last), text: '' }] : [{ title: false, font: 'sheet', size: 1, text: '' }];
}

function normalizeBlock(raw: unknown, base: Omit<NoteStyle, 'wash'>): NoteBlock | null {
  if (!raw || typeof raw !== 'object') return null;
  const tag = 'tag' in raw ? raw.tag : undefined;
  const align = 'align' in raw ? raw.align : undefined;
  const text = 'text' in raw ? raw.text : undefined;
  const wash = 'wash' in raw ? raw.wash : undefined;
  const runs = 'runs' in raw ? raw.runs : undefined;
  const block: NoteBlock = {
    tag: isTag(tag) ? tag : 'p',
    align: isAlign(align) ? align : 'left',
    text: typeof text === 'string' ? text.replace(/\n/g, ' ') : '',
  };
  if (isWash(wash)) block.wash = wash;
  if (Array.isArray(runs) && runs.length) return withRuns(block, tidyRuns(runs.map(r => normalizeRun(r, base))));
  return block;
}

/** A block carrying `runs`, its older fields re-derived from them. */
function withRuns(block: NoteBlock, runs: NoteRun[]): NoteBlock {
  const out: NoteBlock = {
    tag: runs.every(r => r.title) ? 'h1' : 'p',
    align: block.align,
    text: runs.map(r => r.text).join(''),
  };
  const wash = runs[0].wash;
  if (wash && runs.every(r => r.wash === wash)) out.wash = wash;
  out.runs = runs;
  return out;
}

/**
 * A line's runs. A line written before runs existed has one, read off its
 * tag and wash: a heading of either level is a title (a sub-heading a size
 * smaller), and face and size are the note's own.
 */
export function blockRuns(block: NoteBlock, rich: Pick<NoteRich, 'font' | 'size'>): NoteRun[] {
  if (block.runs?.length) return block.runs;
  const run: NoteRun = {
    text: block.text,
    title: block.tag !== 'p',
    font: rich.font,
    size: block.tag === 'h2' ? clampSize(Math.round(rich.size * 85) / 100) : rich.size,
  };
  if (block.wash) run.wash = block.wash;
  return [run];
}

// Normalize meta.rich (or fall back to meta.text). Always returns >= 1 block.
export function normalizeNoteRich(rich: NoteRichInput, text: unknown = ''): NoteRich {
  const font = rich?.font;
  const valign = rich?.valign;
  const base = { title: false, font: isFont(font) ? font : 'sheet', size: clampSize(rich?.size) };
  let blocks: NoteBlock[] = Array.isArray(rich?.blocks)
    ? rich.blocks.map(b => normalizeBlock(b, base)).filter((b): b is NoteBlock => Boolean(b))
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
    const at = blocks.length - 1;
    const last = blocks[at];
    const keep = Math.max(0, last.text.length + budget);
    if (last.runs) blocks[at] = withRuns(last, tidyRuns(cutRuns(last.runs, keep)[0], last.runs[0]));
    else last.text = last.text.slice(0, keep);
  }
  return {
    font: base.font,
    size: base.size,
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

// ---------------------------------------------------------------------------
// Lines of runs: what the editor edits. A position is a character offset
// into the note with lines joined by one newline, so the same number means
// the same place before and after a restyle.
// ---------------------------------------------------------------------------

export type NoteLines = NoteRun[][];

const lineLength = (runs: NoteRun[]) => runs.reduce((n, r) => n + r.text.length, 0);

/** Characters in the note, a newline counted as one - what the sheet limit counts. */
export const linesLength = (lines: NoteLines) =>
  lines.reduce((n, l, i) => n + lineLength(l) + (i ? 1 : 0), 0);

/** The note's lines of runs. */
export const richLines = (rich: NoteRich): NoteLines => rich.blocks.map(b => blockRuns(b, rich));

/**
 * Lines of runs back into the stored model, every line at `align`. The sheet
 * face and size are the first run's - what an older reader, which knows only
 * those, gets closest with. Vertical placement is always top: a note is sized
 * to its words, so there is never room to place them in.
 */
export function linesRich(lines: NoteLines, align: NoteAlign): NoteRich {
  const first = lines[0]?.[0];
  return normalizeNoteRich({
    font: first?.font ?? 'sheet',
    size: first?.size ?? 1,
    valign: 'top',
    blocks: lines.map(runs => ({ align, runs })),
  });
}

/** The note as Markdown, uncapped: a line that is all title gets `# `. */
export const linesMarkdown = (lines: NoteLines) =>
  lines.map(l => (l.every(r => r.title) && lineLength(l) ? '# ' : '') + l.map(r => r.text).join('')).join('\n');

/** Where `pos` falls: which line, and how far into it. Clamped to the note. */
export function locate(lines: NoteLines, pos: number): { li: number, off: number } {
  let p = Math.max(0, pos);
  for (let li = 0; li < lines.length; li++) {
    const len = lineLength(lines[li]);
    if (p <= len || li === lines.length - 1) return { li, off: Math.min(p, len) };
    p -= len + 1;
  }
  return { li: 0, off: 0 };
}

/** Split a line's runs at `off`, copying so neither half aliases the input. */
export function cutRuns(runs: NoteRun[], off: number): [NoteRun[], NoteRun[]] {
  const left: NoteRun[] = [], right: NoteRun[] = [];
  let p = off;
  for (const r of runs) {
    if (p >= r.text.length && p > 0) { left.push({ ...r }); p -= r.text.length; continue; }
    if (p <= 0) { right.push({ ...r }); continue; }
    left.push({ ...r, text: r.text.slice(0, p) });
    right.push({ ...r, text: r.text.slice(p) });
    p = 0;
  }
  return [left, right];
}

/**
 * The look the next character typed at `pos` takes: the character before it,
 * or at a line's start the line's first run. `after` reads the character at
 * `pos` instead - what replaces a selection.
 */
export function styleAt(lines: NoteLines, pos: number, after = false): NoteStyle {
  const { li, off } = locate(lines, pos);
  const runs = lines[li];
  let p = after ? off + 1 : off;
  for (const r of runs) {
    if (p <= r.text.length && (p > 0 || !r.text)) return styleOf(r);
    p -= r.text.length;
  }
  return styleOf(after ? runs[runs.length - 1] : runs[0]);
}

/** The lines between two positions, as a piece to paste elsewhere. */
export function sliceLines(lines: NoteLines, start: number, end: number): NoteLines {
  const a = locate(lines, start), b = locate(lines, end);
  const out: NoteLines = [];
  for (let li = a.li; li <= b.li; li++) {
    const from = li === a.li ? a.off : 0;
    const to = li === b.li ? b.off : lineLength(lines[li]);
    out.push(cutRuns(cutRuns(lines[li], from)[1], to - from)[0]);
  }
  return out.map(l => tidyRuns(l, styleAt(lines, start, true)));
}

/** Everything between two positions gone, the lines either side joined. */
export function deleteRange(lines: NoteLines, start: number, end: number): NoteLines {
  const a = locate(lines, Math.min(start, end)), b = locate(lines, Math.max(start, end));
  const keep = styleAt(lines, Math.min(start, end), true);
  const joined = [...cutRuns(lines[a.li], a.off)[0], ...cutRuns(lines[b.li], b.off)[1]];
  return [...lines.slice(0, a.li), tidyRuns(joined, keep), ...lines.slice(b.li + 1)];
}

/** `piece` put in at `pos`. Returns the lines and the position after it. */
export function insertLines(lines: NoteLines, pos: number, piece: NoteLines): { lines: NoteLines, end: number } {
  if (!piece.length) return { lines, end: pos };
  const { li, off } = locate(lines, pos);
  const [left, right] = cutRuns(lines[li], off);
  const fall = styleAt(lines, pos);
  const made: NoteLines = piece.length === 1
    ? [[...left, ...piece[0], ...right]]
    : [[...left, ...piece[0]], ...piece.slice(1, -1), [...piece[piece.length - 1], ...right]];
  return {
    lines: [...lines.slice(0, li), ...made.map(l => tidyRuns(l, fall)), ...lines.slice(li + 1)],
    end: pos + linesLength(piece),
  };
}

/** Restyle everything between two positions. An empty line in range is restyled too. */
export function restyle(
  lines: NoteLines, start: number, end: number, fn: (s: NoteStyle) => NoteStyle,
): NoteLines {
  const a = locate(lines, start), b = locate(lines, end);
  const paint = (r: NoteRun): NoteRun => ({ ...fn(styleOf(r)), text: r.text });
  return lines.map((runs, li) => {
    if (li < a.li || li > b.li) return runs;
    if (!lineLength(runs)) return runs.map(paint);
    const from = li === a.li ? a.off : 0;
    const to = li === b.li ? b.off : lineLength(runs);
    const [pre, rest] = cutRuns(runs, from);
    const [mid, post] = cutRuns(rest, to - from);
    return tidyRuns([...pre, ...mid.map(paint), ...post]);
  });
}

/**
 * An empty run at `pos` in `style`, so the next character typed there takes
 * it - the pending look of a button pressed with nothing selected. On an empty
 * line the line's own run is restyled instead. Returns where the run sits.
 */
export function withPending(
  lines: NoteLines, pos: number, style: NoteStyle,
): { lines: NoteLines, li: number, ri: number } {
  const { li, off } = locate(lines, pos);
  const runs = lines[li];
  const out = lines.slice();
  if (!lineLength(runs)) {
    out[li] = [{ ...style, text: '' }];
    return { lines: out, li, ri: 0 };
  }
  const [left, right] = cutRuns(runs, off);
  out[li] = [...left, { ...style, text: '' }, ...right];
  return { lines: out, li, ri: left.length };
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

/**
 * The language a note's Cyrillic is in, when the letters say so, or ''.
 *
 * It matters for the italic: Serbian and Macedonian draw б г д п т differently
 * from Russian, and the bundled Cyrillic faces carry both, switched by `lang`.
 * A letter only one alphabet has decides it; failing that, a Cyrillic note
 * with none of the letters Serbian lacks, written by somebody whose browser is
 * set to Serbian, is taken as Serbian. Anything else is left unmarked, which
 * draws the common forms.
 */
export function cyrillicLang(text: string, locale = ''): string {
  if (/[ЃЌЅѓќѕ]/.test(text)) return 'mk';
  if (/[ЂЋђћ]/.test(text)) return 'sr';
  if (/[Ѐ-ӿ]/.test(text) && !/[ЙЩЪЫЬЭЮЯЁЄІЇҐЎйщъыьэюяёєіїґў]/.test(text)
    && /^sr\b/i.test(locale)) return 'sr';
  return '';
}

/** Mark an element with the language of the text it shows, or unmark it. For
 *  every user-written name on screen: a note, a caption, the board title. */
export function markLang(node: HTMLElement, text: string): void {
  const lang = cyrillicLang(text, globalThis.navigator?.language);
  if (lang) node.lang = lang;
  else node.removeAttribute('lang');
}

/** Write a note's board-wide look onto its rich wrapper (font, size, vAlign). */
export function applyNoteStyle(wrap: HTMLElement, rich: NoteRich): void {
  markLang(wrap, rich.blocks.map(b => b.text).join('\n'));
  wrap.style.fontFamily = NOTE_FONTS[rich.font];
  // setProperty takes a string; the number was being converted by the binding
  // layer on the way in, and String() is that same conversion said out loud.
  wrap.style.setProperty('--note-scale', String(rich.size));
  wrap.dataset.font = rich.font;
  wrap.dataset.valign = rich.valign;
}

/**
 * Stands in for the words of an empty run, so the run has a text node the
 * caret can sit in and a line with no words keeps its height. Never read back:
 * the editor strips it, and nothing else reads the DOM.
 */
export const NOTE_BLANK = '​';

/**
 * One run as a span. Its look is carried as data attributes, which the editor
 * reads back, and applied by cards.css - except the face, which is written
 * inline from the allowlist the way applyNoteStyle() writes the sheet's.
 *
 * The marker is data-wash rather than a class: cards.css turns it into a
 * --note-wash colour, which the toolbar's own chip reads through the same rule.
 * The property was `--wash`, which tokens.css has owned since long before as
 * the whimsy ornament multiplier. See the block in cards.css for what that
 * collision cost.
 */
function buildNoteRun(run: NoteRun): HTMLSpanElement {
  const span = document.createElement('span');
  span.className = 'note-run';
  if (run.title) span.dataset.title = '1';
  span.dataset.font = run.font;
  span.dataset.size = String(run.size);
  if (run.wash) span.dataset.wash = run.wash;
  span.style.fontFamily = NOTE_FONTS[run.font];
  span.style.setProperty('--run-scale', String(run.size));
  span.textContent = run.text || NOTE_BLANK;
  return span;
}

/** One line of runs as a line element. note-h1 when it is all title, for its line height. */
export function buildNoteLine(runs: NoteRun[], align: NoteAlign): HTMLDivElement {
  const line = document.createElement('div');
  line.className = `note-line note-${runs.every(r => r.title) ? 'h1' : 'p'} al-${align}`;
  line.append(...runs.map(buildNoteRun));
  return line;
}
