// The text editor's document: blocks holding inline runs, and every edit as a
// pure function from a document to a new one. DOM-free, so node --test reaches
// it. Blocks are never mutated - an edit copies the blocks it changes - which
// is what lets markdown.ts tell an untouched block by identity and write its
// bytes back exactly. The view (view.ts) renders this and reads typing back.

/** A stretch of text with one look. `raw` is source the editor does not
 *  model - an image, an autolink - shown and written back verbatim, never edited. */
export type Run = {
  text: string,
  b?: boolean,
  i?: boolean,
  s?: boolean,
  code?: boolean,
  /** Obsidian's ==highlight==. */
  hl?: boolean,
  href?: string,
  raw?: boolean,
};

/** The look of a run without its words. */
export type Marks = Pick<Run, 'b' | 'i' | 's' | 'code' | 'hl' | 'href'>;
/** The four marks the toolbar toggles, plus code, which Markdown's backticks give. */
export type MarkKey = 'b' | 'i' | 's' | 'hl' | 'code';
export const MARK_KEYS: readonly MarkKey[] = ['b', 'i', 's', 'hl', 'code'];

export type ListKind = 'bullet' | 'number' | 'task';
/** Markdown's six. The ribbon and its keys offer the first three; the rest are typed or read. */
export type Level = 1 | 2 | 3 | 4 | 5 | 6;
/** A count of `#` as a heading level, held to the six there are. */
export const toLevel = (n: number): Level => (n <= 1 ? 1 : n >= 6 ? 6 : n === 2 ? 2 : n === 3 ? 3 : n === 4 ? 4 : 5);

/** `before` is the blank lines above a block in its file, kept so an untouched stretch keeps its spacing. */
type Base = { before: string[] };
export type Para = Base & { kind: 'p', runs: Run[] };
export type Heading = Base & { kind: 'h', level: Level, runs: Run[] };
export type ListItem = Base & {
  kind: 'li', list: ListKind, depth: number, checked: boolean,
  /** The marker a file used: `-`, `*` or `+`, and `.` or `)` after a number. */
  bullet: string, delim: string, start: number, runs: Run[],
};
export type Quote = Base & { kind: 'quote', runs: Run[] };
/** A screenplay's elements (fountain.ts). A page break is a rule. */
export type SceneEl = 'scene' | 'action' | 'character' | 'paren' | 'dialogue' | 'transition'
  | 'centered' | 'lyric' | 'section' | 'synopsis' | 'note';
/** One line of a screenplay. `dual` is a character speaking beside the one before; `level` a section's depth. */
export type Screen = Base & { kind: 'sp', el: SceneEl, dual: boolean, level: number, runs: Run[] };
export type TextBlock = Para | Heading | ListItem | Quote | Screen;
export type CodeBlock = Base & { kind: 'code', fence: string, lang: string, text: string };
export type Rule = Base & { kind: 'rule' };
export type Raw = Base & { kind: 'raw', text: string };
export type Block = TextBlock | CodeBlock | Rule | Raw;

/**
 * A whole document. `tail` is the blank lines after the last block (a final
 * newline is one), `eol` the line ending the file used, `plain` a .txt file:
 * every line one paragraph, no marks, no shortcuts.
 */
export type Doc = { blocks: Block[], tail: string[], eol: string, bom: boolean, plain: boolean };

/** A place in the document: block index, and characters into that block's text. */
export type Pos = { b: number, o: number };
/** What an edit hands back: the new document and the selection to put back. */
export type Edit = { doc: Doc, from: Pos, to: Pos };

export const isText = (b: Block | undefined): b is TextBlock => !!b && 'runs' in b;
/** A block the caret cannot enter: a rule or source the editor does not model. */
export const isAtom = (b: Block | undefined): b is Rule | Raw => !!b && (b.kind === 'rule' || b.kind === 'raw');

export const runsLen = (runs: Run[]) => runs.reduce((n, r) => n + r.text.length, 0);
export const runsText = (runs: Run[]) => runs.map(r => r.text).join('');

/** The editable words of a block. An atom has none. */
export function blockText(b: Block): string {
  if (isText(b)) return runsText(b.runs);
  if (b.kind === 'code') return b.text;
  return '';
}
export const blockLen = (b: Block) => blockText(b).length;

export const cmpPos = (a: Pos, z: Pos) => a.b - z.b || a.o - z.o;
export const samePos = (a: Pos, z: Pos) => a.b === z.b && a.o === z.o;
/** The two ends of a selection, first one first. */
export const ordered = (a: Pos, z: Pos): [Pos, Pos] => (cmpPos(a, z) <= 0 ? [a, z] : [z, a]);

/** A position moved inside the document and inside its block. */
export function clampPos(doc: Doc, p: Pos): Pos {
  const b = Math.max(0, Math.min(doc.blocks.length - 1, p.b));
  const block = doc.blocks[b];
  return { b, o: block ? Math.max(0, Math.min(blockLen(block), p.o)) : 0 };
}

const caret = (doc: Doc, at: Pos): Edit => ({ doc, from: at, to: at });
const withBlocks = (doc: Doc, blocks: Block[]): Doc => ({ ...doc, blocks });
/** `doc` with `count` blocks from `at` replaced by `put`. */
function splice(doc: Doc, at: number, count: number, ...put: Block[]): Doc {
  const blocks = doc.blocks.slice();
  blocks.splice(at, count, ...put);
  return withBlocks(doc, blocks);
}

export const para = (runs: Run[] = [], before: string[] = ['']): Para => ({ kind: 'p', before, runs });

/**
 * Somewhere to put the caret before a document that opens with a block it
 * cannot enter, and after one that ends with one - a table, a rule, code. An
 * empty paragraph is written as nothing (markdown.ts), so the file is unchanged.
 */
export function withRoom(doc: Doc): Doc {
  if (doc.plain) return doc;
  const first = doc.blocks[0], last = doc.blocks[doc.blocks.length - 1];
  const blocks = doc.blocks.slice();
  if (isAtom(first)) blocks.unshift(para([], []));
  if (isAtom(last) || last?.kind === 'code') blocks.push(para());
  return blocks.length === doc.blocks.length ? doc : withBlocks(doc, blocks);
}

/** A document with nothing in it, as a new file starts. */
export const emptyDoc = (plain = false): Doc =>
  ({ blocks: [para([], [])], tail: [''], eol: '\n', bom: false, plain });

// ---------------------------------------------------------------------------
// Runs
// ---------------------------------------------------------------------------

export function marksOf(r: Marks): Marks {
  const m: Marks = {};
  for (const k of MARK_KEYS) if (r[k]) m[k] = true;
  if (r.href) m.href = r.href;
  return m;
}

export const sameMarks = (a: Marks, z: Marks) =>
  MARK_KEYS.every(k => !!a[k] === !!z[k]) && (a.href || '') === (z.href || '');

/**
 * Runs as the rest of this module expects them: no empty ones, neighbours with
 * one look joined, and no bold, italic or strike on a run of nothing but space,
 * which Markdown has no way to write down.
 */
export function tidy(runs: Run[]): Run[] {
  const out: Run[] = [];
  for (const r of runs) {
    if (!r.text) continue;
    let run: Run = { text: r.text, ...marksOf(r) };
    if (r.raw) run.raw = true;
    if (!run.raw && !run.code && !run.text.trim()) {
      run = { text: run.text };
      if (r.href) run.href = r.href;
    }
    const last = out[out.length - 1];
    if (last && !last.raw && !run.raw && sameMarks(last, run)) out[out.length - 1] = { ...last, text: last.text + run.text };
    else out.push(run);
  }
  return out;
}

/**
 * Runs cut at `o`. A raw run is never cut - the cut moves to whichever of
 * its ends is nearer - since half of an image's source is not an image.
 */
export function cutRuns(runs: Run[], o: number): [Run[], Run[]] {
  const left: Run[] = [], right: Run[] = [];
  let p = o;
  for (const r of runs) {
    const n = r.text.length;
    if (p >= n && p > 0) { left.push(r); p -= n; continue; }
    if (p <= 0) { right.push(r); continue; }
    if (r.raw) {
      (p * 2 < n ? right : left).push(r);
      p = 0;
      continue;
    }
    left.push({ ...r, text: r.text.slice(0, p) });
    right.push({ ...r, text: r.text.slice(p) });
    p = 0;
  }
  return [left, right];
}

export function sliceRuns(runs: Run[], from: number, to: number): Run[] {
  return cutRuns(cutRuns(runs, to)[0], from)[1];
}

/** Every run between `from` and `to` passed through `fn`, the rest as they were. */
function mapRange(runs: Run[], from: number, to: number, fn: (r: Run) => Run): Run[] {
  const [head, rest] = cutRuns(runs, from);
  const [mid, tail] = cutRuns(rest, to - from);
  return tidy([...head, ...mid.map(fn), ...tail]);
}

/**
 * The look a character typed at `o` takes: the one before it, or at a block's
 * start the one after. A link and a code span are continued only from inside
 * them - typing on past the end of either leaves it, as it does elsewhere.
 */
export function marksAt(runs: Run[], o: number): Marks {
  const [left, right] = cutRuns(runs, o);
  const before = [...left].reverse().find(r => !r.raw);
  const after = right.find(r => !r.raw);
  const m = marksOf(before ?? after ?? { });
  if (before) {
    if (m.href && after?.href !== m.href) delete m.href;
    if (m.code && !after?.code) delete m.code;
  }
  return m;
}

// ---------------------------------------------------------------------------
// Blocks
// ---------------------------------------------------------------------------

/** What a text block can be turned into. An item's unsaid fields carry over or default. */
type Spec =
  | { kind: 'p' }
  | { kind: 'quote' }
  | { kind: 'h', level: Level }
  | { kind: 'li', list: ListKind, checked?: boolean, start?: number };

/** A text block turned into another kind, keeping its words and its place. */
function retype(b: TextBlock, spec: Spec): TextBlock {
  const base = { before: b.before, runs: b.runs };
  switch (spec.kind) {
    case 'p': return { kind: 'p', ...base };
    case 'quote': return { kind: 'quote', ...base };
    case 'h': return { kind: 'h', level: spec.level, ...base };
    case 'li': {
      const was = b.kind === 'li' ? b : null;
      return {
        kind: 'li', ...base,
        list: spec.list,
        depth: was?.depth ?? 0,
        checked: spec.checked ?? false,
        bullet: was?.bullet ?? '-',
        delim: was?.delim ?? '.',
        start: spec.start ?? was?.start ?? 1,
      };
    }
  }
}

/** A text block's words replaced, everything else about it kept. */
const withRuns = <T extends TextBlock>(b: T, runs: Run[]): T => ({ ...b, runs: tidy(runs) });

/** The same block holding different words: runs for a text block, a string for code. */
function withContent(b: TextBlock | CodeBlock, runs: Run[]): TextBlock | CodeBlock {
  return isText(b) ? withRuns(b, runs) : { ...b, text: runsText(runs) };
}

/** A block's words as runs - code comes out as plain text. */
const contentOf = (b: Block): Run[] => (isText(b) ? b.runs : b.kind === 'code' && b.text ? [{ text: b.text }] : []);

/** Whether a paragraph written straight after `prev` needs a blank line between them. */
const beforeAfter = (prev: Block | undefined, next: Block): string[] =>
  (prev?.kind === 'li' && next.kind === 'li') ? [] : [''];

// ---------------------------------------------------------------------------
// Typing
// ---------------------------------------------------------------------------

/**
 * `text` typed over the selection. In a .txt a newline starts a new line; in
 * Markdown it is a soft break inside the block, which Shift+Enter types.
 */
export function insertText(doc: Doc, from: Pos, to: Pos, text: string, marks?: Marks): Edit {
  if (doc.plain && text.includes('\n')) {
    let e = deleteRange(doc, from, to);
    const lines = text.split('\n');
    lines.forEach((line, n) => {
      if (n) e = splitBlock(e.doc, e.from, e.from);
      if (line) e = insertText(e.doc, e.from, e.from, line);
    });
    return e;
  }
  const cut = deleteRange(doc, from, to);
  const at = cut.from;
  const b = cut.doc.blocks[at.b];
  if (!text || !b) return cut;
  if (b.kind === 'code') {
    const next = { ...b, text: b.text.slice(0, at.o) + text + b.text.slice(at.o) };
    return caret(splice(cut.doc, at.b, 1, next), { b: at.b, o: at.o + text.length });
  }
  if (!isText(b)) {
    // Typed onto something the caret cannot enter: a new paragraph after it.
    const p = para([{ text, ...marks }], ['']);
    return caret(splice(cut.doc, at.b + 1, 0, p), { b: at.b + 1, o: text.length });
  }
  const look = doc.plain ? {} : marks ?? marksAt(b.runs, at.o);
  const [left, right] = cutRuns(b.runs, at.o);
  const next = withRuns(b, [...left, { text, ...look }, ...right]);
  return caret(splice(cut.doc, at.b, 1, next), { b: at.b, o: at.o + text.length });
}

/** Everything between two positions removed. Blocks the range swallows whole go. */
export function deleteRange(doc: Doc, p: Pos, q: Pos): Edit {
  const [a, z] = ordered(p, q);
  if (samePos(a, z)) return caret(doc, a);
  const A = doc.blocks[a.b], Z = doc.blocks[z.b];
  if (!A || !Z) return caret(doc, a);
  if (a.b === z.b) {
    if (isAtom(A)) return caret(doc, a);
    const [head] = cutRuns(contentOf(A), a.o);
    const [, tail] = cutRuns(contentOf(A), z.o);
    const next = A.kind === 'code' ? { ...A, text: A.text.slice(0, a.o) + A.text.slice(z.o) } : withRuns(A, [...head, ...tail]);
    return caret(splice(doc, a.b, 1, next), a);
  }
  // Across blocks: the first block's head joined to the last block's tail.
  const head = isAtom(A) ? null : A;
  const tail = isAtom(Z) ? null : Z;
  let merged: Block;
  let at = a;
  if (head && tail) {
    const kept = cutRuns(contentOf(head), a.o)[0];
    const rest = cutRuns(contentOf(tail), z.o)[1];
    merged = head.kind === 'code'
      ? { ...head, text: head.text.slice(0, a.o) + runsText(rest) }
      : withRuns(head, [...kept, ...rest]);
  } else if (head) {
    merged = head.kind === 'code' ? { ...head, text: head.text.slice(0, a.o) } : withRuns(head, cutRuns(head.runs, a.o)[0]);
  } else if (tail) {
    merged = withContent(tail, cutRuns(contentOf(tail), z.o)[1]);
    merged = { ...merged, before: A.before };
    at = { b: a.b, o: 0 };
  } else {
    merged = para([], A.before);
    at = { b: a.b, o: 0 };
  }
  return caret(splice(doc, a.b, z.b - a.b + 1, merged), at);
}

/**
 * Enter. A block splits at the caret, and the new one is what a writer
 * expects next: text after a heading, another item after an item. An empty
 * item or quote is where a list or a quote ends, so Enter there steps out of it.
 */
export function splitBlock(doc: Doc, from: Pos, to: Pos): Edit {
  const cut = deleteRange(doc, from, to);
  const at = cut.from;
  const d = cut.doc;
  const b = d.blocks[at.b];
  if (!b) return cut;
  if (isAtom(b)) return caret(splice(d, at.b + 1, 0, para()), { b: at.b + 1, o: 0 });
  if (b.kind === 'code') {
    // A blank last line and Enter again: out of the code, as every editor does it.
    if (at.o === b.text.length && (b.text.endsWith('\n') || !b.text)) {
      const code = { ...b, text: b.text.replace(/\n$/, '') };
      return caret(splice(d, at.b, 1, code, para()), { b: at.b + 1, o: 0 });
    }
    return insertText(d, at, at, '\n');
  }
  const empty = !runsLen(b.runs);
  if (!doc.plain && empty && b.kind === 'li') {
    const next = b.depth > 0 ? { ...b, depth: b.depth - 1 } : retype(b, { kind: 'p' });
    return caret(splice(d, at.b, 1, next), at);
  }
  if (!doc.plain && empty && b.kind === 'quote') return caret(splice(d, at.b, 1, retype(b, { kind: 'p' })), at);
  const [left, right] = cutRuns(b.runs, at.o);
  const first = withRuns(b, left);
  let second: TextBlock;
  if (b.kind === 'h' && at.o >= runsLen(b.runs)) second = para();
  else if (b.kind === 'li') second = { ...b, checked: false, runs: [] };
  else second = { ...b, runs: [] };
  second = withRuns({ ...second, before: doc.plain ? [] : beforeAfter(first, second) }, right);
  // Split at the very start: the words move down, and the line left above is
  // a plain one - Enter before a heading pushes the heading down, not a copy of it.
  if (!left.length && b.kind === 'h') return caret(splice(d, at.b, 1, { ...para([], b.before) }, { ...b, before: [''] }), { b: at.b + 1, o: 0 });
  return caret(splice(d, at.b, 1, first, second), { b: at.b + 1, o: 0 });
}

/**
 * Backspace with the caret at the start of a block. A heading, item or quote
 * becomes a paragraph first; a paragraph joins the block above. Null when
 * there is nothing to do - the start of the document.
 */
export function joinBackward(doc: Doc, at: Pos): Edit | null {
  const b = doc.blocks[at.b];
  if (!b || at.o !== 0) return null;
  if (!doc.plain && isText(b) && b.kind !== 'p') return caret(splice(doc, at.b, 1, retype(b, { kind: 'p' })), at);
  if (b.kind === 'code' && !b.text) return caret(splice(doc, at.b, 1, para([], b.before)), at);
  if (b.kind === 'code') return null;
  const prev = doc.blocks[at.b - 1];
  if (!prev) return null;
  if (isAtom(prev)) {
    const next = at.b - 1 === 0 && isText(b) ? { ...b, before: prev.before } : b;
    return caret(splice(doc, at.b - 1, 2, next), { b: at.b - 1, o: 0 });
  }
  const len = blockLen(prev);
  const merged = withContent(prev, [...contentOf(prev), ...contentOf(b)]);
  return caret(splice(doc, at.b - 1, 2, merged), { b: at.b - 1, o: len });
}

/** Delete with the caret at the end of a block: the block below joins it. */
export function joinForward(doc: Doc, at: Pos): Edit | null {
  const b = doc.blocks[at.b];
  const next = doc.blocks[at.b + 1];
  if (!b || !next || isAtom(b) || at.o !== blockLen(b)) return null;
  if (isAtom(next)) return caret(splice(doc, at.b + 1, 1), at);
  const merged = withContent(b, [...contentOf(b), ...contentOf(next)]);
  return caret(splice(doc, at.b, 2, merged), at);
}

/**
 * Blocks pasted over the selection. One paragraph goes in at the caret as
 * words; several split the block there and go between its halves, the first
 * and last joining the halves when they are paragraphs, as a paste of prose
 * into the middle of a line should read.
 */
export function insertBlocks(doc: Doc, from: Pos, to: Pos, piece: Block[]): Edit {
  const cut = deleteRange(doc, from, to);
  const at = cut.from;
  const d = cut.doc;
  const b = d.blocks[at.b];
  if (!piece.length || !b) return cut;
  if (b.kind === 'code') return insertText(d, at, at, piece.map(blockText).join('\n'));
  const first = piece[0];
  if (piece.length === 1 && first.kind === 'p' && isText(b)) {
    const [l, r] = cutRuns(b.runs, at.o);
    return caret(splice(d, at.b, 1, withRuns(b, [...l, ...first.runs, ...r])), { b: at.b, o: at.o + runsLen(first.runs) });
  }
  const [l, r] = isText(b) ? cutRuns(b.runs, at.o) : [[], []];
  const mid = piece.slice();
  const out: Block[] = [];
  const lead = mid[0];
  if (isAtom(b)) out.push(b);
  else if (l.length && lead.kind === 'p') {
    out.push(withRuns(b, [...l, ...lead.runs]));
    mid.shift();
  } else if (l.length) out.push(withRuns(b, l));
  out.push(...mid);
  const last = out[out.length - 1];
  const end = { b: at.b + out.length - 1, o: blockLen(last) };
  if (r.length && isText(b)) {
    if (last.kind === 'p' && !isAtom(b)) out[out.length - 1] = withRuns(last, [...last.runs, ...r]);
    else out.push({ ...b, before: [''], runs: tidy(r) });
  }
  return caret(splice(d, at.b, 1, ...out), end);
}

/**
 * The selection as a document of its own, for the clipboard. Blocks taken
 * whole keep their source lines, so copying a table copies the table as written.
 */
export function sliceDoc(doc: Doc, from: Pos, to: Pos): Doc {
  const [a, z] = ordered(from, to);
  const blocks: Block[] = [];
  for (const n of blocksIn(a, z)) {
    const b = doc.blocks[n];
    const start = n === a.b ? a.o : 0;
    const end = n === z.b ? z.o : blockLen(b);
    if (isAtom(b) || (start === 0 && end === blockLen(b))) blocks.push(b);
    else blocks.push(withContent(b, sliceRuns(contentOf(b), start, end)));
  }
  return { ...doc, blocks, tail: [], bom: false };
}

// ---------------------------------------------------------------------------
// Formatting
// ---------------------------------------------------------------------------

/** Indices of the blocks a selection touches. */
const blocksIn = (a: Pos, z: Pos) => Array.from({ length: z.b - a.b + 1 }, (_, n) => a.b + n);

/** Whether every character in the selection already carries `key`. Raw runs do not count. */
export function hasMark(doc: Doc, from: Pos, to: Pos, key: MarkKey): boolean {
  const [a, z] = ordered(from, to);
  let any = false;
  for (const n of blocksIn(a, z)) {
    const b = doc.blocks[n];
    if (!isText(b)) continue;
    const start = n === a.b ? a.o : 0;
    const end = n === z.b ? z.o : runsLen(b.runs);
    for (const r of sliceRuns(b.runs, start, end)) {
      if (r.raw || !r.text) continue;
      any = true;
      if (!r[key]) return false;
    }
  }
  return any;
}

/** Bold, italic, strike or code over the selection: off if all of it has it, otherwise on. */
export function toggleMark(doc: Doc, from: Pos, to: Pos, key: MarkKey): Edit {
  const [a, z] = ordered(from, to);
  if (doc.plain || samePos(a, z)) return { doc, from, to };
  const on = !hasMark(doc, a, z, key);
  const blocks = doc.blocks.slice();
  for (const n of blocksIn(a, z)) {
    const b = blocks[n];
    if (!isText(b)) continue;
    const start = n === a.b ? a.o : 0;
    const end = n === z.b ? z.o : runsLen(b.runs);
    blocks[n] = withRuns(b, mapRange(b.runs, start, end, r => {
      if (r.raw) return r;
      const next = { ...r };
      if (on) next[key] = true;
      else delete next[key];
      return next;
    }));
  }
  return { doc: withBlocks(doc, blocks), from, to };
}

/** Every text block in the selection passed through `fn`. */
function mapBlocks(doc: Doc, from: Pos, to: Pos, fn: (b: TextBlock) => TextBlock): Edit {
  const [a, z] = ordered(from, to);
  const blocks = doc.blocks.slice();
  for (const n of blocksIn(a, z)) {
    const b = blocks[n];
    if (isText(b)) blocks[n] = fn(b);
  }
  return { doc: withBlocks(doc, blocks), from, to };
}

const textBlocksIn = (doc: Doc, from: Pos, to: Pos) => {
  const [a, z] = ordered(from, to);
  return blocksIn(a, z).map(n => doc.blocks[n]).filter(isText);
};

/** A heading of `level`, or back to a paragraph if every block is one already. */
export function setHeading(doc: Doc, from: Pos, to: Pos, level: Level): Edit {
  if (doc.plain) return { doc, from, to };
  const all = textBlocksIn(doc, from, to).every(b => b.kind === 'h' && b.level === level);
  return mapBlocks(doc, from, to, b => retype(b, all ? { kind: 'p' } : { kind: 'h', level }));
}

/** A list of `list`, or back to paragraphs if every block is one already. */
export function toggleList(doc: Doc, from: Pos, to: Pos, list: ListKind): Edit {
  if (doc.plain) return { doc, from, to };
  const all = textBlocksIn(doc, from, to).every(b => b.kind === 'li' && b.list === list);
  const out = mapBlocks(doc, from, to, b => retype(b, all ? { kind: 'p' } : { kind: 'li', list }));
  const [a, z] = ordered(from, to);
  return { ...out, doc: tightenLists(out.doc, a.b, z.b + 1) };
}

/**
 * Items that have just come to sit next to each other, from block `first` to
 * `last`, lose the blank line between them - paragraphs made into a list are
 * one list. Only there: a list the file wrote loose elsewhere stays loose.
 */
function tightenLists(doc: Doc, first: number, last: number): Doc {
  const blocks = doc.blocks.slice();
  for (let n = Math.max(1, first); n <= Math.min(last, blocks.length - 1); n++) {
    const b = blocks[n];
    if (b.kind === 'li' && blocks[n - 1].kind === 'li' && b.before.length) blocks[n] = { ...b, before: [] };
  }
  return withBlocks(doc, blocks);
}

/**
 * Tab and Shift+Tab over list items: one level in or out. An item can be at
 * most one level deeper than the item above it, which is all Markdown can say.
 */
export function indent(doc: Doc, from: Pos, to: Pos, delta: 1 | -1): Edit | null {
  const [a, z] = ordered(from, to);
  let moved = false;
  const blocks = doc.blocks.slice();
  for (const n of blocksIn(a, z)) {
    const b = blocks[n];
    if (b?.kind !== 'li') continue;
    const prev = blocks[n - 1];
    const ceiling = prev?.kind === 'li' ? prev.depth + 1 : 0;
    const depth = Math.max(0, Math.min(ceiling, b.depth + delta));
    if (depth === b.depth) continue;
    blocks[n] = { ...b, depth };
    moved = true;
  }
  return moved ? { doc: withBlocks(doc, blocks), from, to } : null;
}

/** A task ticked or unticked. */
export function toggleTask(doc: Doc, n: number): Doc {
  const b = doc.blocks[n];
  if (b?.kind !== 'li' || b.list !== 'task') return doc;
  return splice(doc, n, 1, { ...b, checked: !b.checked });
}

// ---------------------------------------------------------------------------
// Shortcuts: Markdown typed becomes what it means
// ---------------------------------------------------------------------------

/**
 * A marker typed at the start of a paragraph, just after its space: `# ` to
 * `### `, `- `, `1. `, `[ ] `, `> `. Asked after every space; null if the
 * words before the caret are not one.
 */
export function blockShortcut(doc: Doc, at: Pos): Edit | null {
  const b = doc.blocks[at.b];
  if (doc.plain || !isText(b)) return null;
  const head = runsText(b.runs).slice(0, at.o);
  const rest = cutRuns(b.runs, at.o)[1];
  const to = (spec: Spec) => {
    const next = withRuns(retype(b, spec), rest);
    const out = splice(doc, at.b, 1, next);
    return caret(next.kind === 'li' ? tightenLists(out, at.b, at.b + 1) : out, { b: at.b, o: 0 });
  };
  if (b.kind === 'li' && b.list === 'bullet') {
    const task = /^\[([ xX])\] $/.exec(head);
    return task ? to({ kind: 'li', list: 'task', checked: task[1] !== ' ' }) : null;
  }
  if (b.kind !== 'p') return null;
  const h = /^(#{1,6}) $/.exec(head);
  if (h) return to({ kind: 'h', level: toLevel(h[1].length) });
  if (/^[-*+] $/.test(head)) return to({ kind: 'li', list: 'bullet' });
  const num = /^(\d{1,9})[.)] $/.exec(head);
  if (num) return to({ kind: 'li', list: 'number', start: Number(num[1]) });
  const task = /^(?:[-*+] )?\[([ xX])\] $/.exec(head);
  if (task) return to({ kind: 'li', list: 'task', checked: task[1] !== ' ' });
  if (head === '> ') return to({ kind: 'quote' });
  return null;
}

/** Enter on a paragraph that is only a fence, ```` ``` ```` or ```` ```js ````: a code block. */
export function fenceShortcut(doc: Doc, at: Pos): Edit | null {
  const b = doc.blocks[at.b];
  if (doc.plain || b?.kind !== 'p') return null;
  const m = /^(```+|~~~+)([^`\s]*)$/.exec(runsText(b.runs));
  if (!m || at.o !== runsLen(b.runs)) return null;
  const code: CodeBlock = { kind: 'code', before: b.before, fence: m[1], lang: m[2], text: '' };
  return caret(splice(doc, at.b, 1, code), { b: at.b, o: 0 });
}

/** The inline spellings, closing marker last: its mark and the pattern ending at the caret. */
const INLINE_SHORTCUTS: [MarkKey, RegExp][] = [
  ['b', /(\*\*|__)([^*_\s](?:[^*_]*[^*_\s])?)\1$/],
  ['s', /~~([^~\s](?:[^~]*[^~\s])?)~~$/],
  ['hl', /==([^=\s](?:[^=]*[^=\s])?)==$/],
  ['code', /`([^`]+)`$/],
  ['i', /(?:^|[^*\w])(\*)([^*\s](?:[^*]*[^*\s])?)\*$/],
  ['i', /(?:^|[^_\w])(_)([^_\s](?:[^_]*[^_\s])?)_$/],
];

/**
 * `**word**`, `*word*`, `~~word~~`, `==word==` and `` `word` `` typed out: the markers go
 * and the word takes the look, the moment the closing marker is typed. Only
 * over plain words - never across a raw run or inside code. `exit` is the mark
 * the caret leaves, so what is typed next is not in it.
 */
export function inlineShortcut(doc: Doc, at: Pos): (Edit & { exit: MarkKey }) | null {
  const b = doc.blocks[at.b];
  if (doc.plain || !isText(b)) return null;
  const head = runsText(b.runs).slice(0, at.o);
  for (const [key, re] of INLINE_SHORTCUTS) {
    const m = re.exec(head);
    if (!m) continue;
    const inner = m[m.length - 1];
    const marker = key === 'code' ? 1 : key === 'i' ? 1 : 2;
    const end = at.o;
    const start = end - inner.length - marker * 2;
    if (touches(b.runs, start, end, r => !!(r.raw || r.code))) return null;
    const runs = [
      ...cutRuns(b.runs, start)[0],
      ...mapRange(sliceRuns(b.runs, start + marker, end - marker), 0, inner.length, r => ({ ...r, [key]: true })),
      ...cutRuns(b.runs, end)[1],
    ];
    const next = withRuns(b, runs);
    const o = end - marker * 2;
    return { ...caret(splice(doc, at.b, 1, next), { b: at.b, o }), exit: key };
  }
  return null;
}

// ---------------------------------------------------------------------------
// Find and replace, and counting
// ---------------------------------------------------------------------------

export type Match = { b: number, from: number, to: number };

/** More than this and the bar says so rather than counting on. */
export const MATCH_MAX = 10000;

/** Whether a run `is` overlaps `from`..`to` - measured, since cutRuns() will not split a raw one. */
function touches(runs: Run[], from: number, to: number, is: (r: Run) => boolean = r => !!r.raw): boolean {
  let p = 0;
  for (const r of runs) {
    const end = p + r.text.length;
    if (is(r) && p < to && end > from) return true;
    p = end;
  }
  return false;
}

/**
 * Lower case that keeps every offset: a character whose lower case is longer
 * (`İ` is two units) stays as it is, since a match's offsets index the text.
 */
const fold = (s: string) => Array.from(s, ch => {
  const l = ch.toLowerCase();
  return l.length === ch.length ? l : ch;
}).join('');

/** Every place `query` occurs, in reading order. Never inside a raw run. */
export function findAll(doc: Doc, query: string, matchCase = false): Match[] {
  const out: Match[] = [];
  if (!query) return out;
  const needle = matchCase ? query : fold(query);
  doc.blocks.forEach((b, n) => {
    if (isAtom(b) || out.length >= MATCH_MAX) return;
    const hay = matchCase ? blockText(b) : fold(blockText(b));
    let at = hay.indexOf(needle);
    while (at >= 0 && out.length < MATCH_MAX) {
      if (!isText(b) || !touches(b.runs, at, at + needle.length)) out.push({ b: n, from: at, to: at + needle.length });
      at = hay.indexOf(needle, at + Math.max(1, needle.length));
    }
  });
  return out;
}

/** One match replaced, in the look of its first character. */
export function replaceMatch(doc: Doc, m: Match, text: string): Edit {
  const b = doc.blocks[m.b];
  const look = isText(b) ? marksOf(sliceRuns(b.runs, m.from, m.to)[0] ?? {}) : undefined;
  return insertText(doc, { b: m.b, o: m.from }, { b: m.b, o: m.to }, text, look);
}

/** Every match replaced, last first so the earlier offsets stay true. */
export function replaceAll(doc: Doc, query: string, text: string, matchCase = false): { doc: Doc, count: number } {
  const all = findAll(doc, query, matchCase);
  let next = doc;
  for (let n = all.length - 1; n >= 0; n--) next = replaceMatch(next, all[n], text).doc;
  return { doc: next, count: all.length };
}

/** A word: letters and digits, with an apostrophe or hyphen allowed between them. */
const WORD = /[\p{L}\p{N}]+(?:['’-][\p{L}\p{N}]+)*/gu;

/** One entry of the outline: a heading, a screenplay's scene, or its section. */
export type OutlineEntry = { b: number, kind: 'h' | 'scene' | 'section', level: number, text: string };

/**
 * The document's outline: headings in Markdown; sections and scenes in a
 * screenplay, a scene one level under the section it sits in.
 */
export function outlineOf(doc: Doc): OutlineEntry[] {
  const out: OutlineEntry[] = [];
  let depth = 0;
  doc.blocks.forEach((b, n) => {
    const text = isText(b) ? runsText(b.runs).trim() : '';
    if (b.kind === 'h') out.push({ b: n, kind: 'h', level: b.level, text });
    else if (b.kind === 'sp' && b.el === 'section') {
      depth = Math.max(1, b.level);
      out.push({ b: n, kind: 'section', level: depth, text });
    } else if (b.kind === 'sp' && b.el === 'scene') out.push({ b: n, kind: 'scene', level: depth + 1, text });
  });
  return out;
}

/** How many words the document holds, raw source included - a table's words are words. */
export function wordCount(doc: Doc): number {
  let n = 0;
  for (const b of doc.blocks) {
    const text = b.kind === 'raw' ? b.text : blockText(b);
    n += text.match(WORD)?.length ?? 0;
  }
  return n;
}
