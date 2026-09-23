// Markdown to the editor's document and back. Round trip is the contract:
// every block remembers the lines it was read from, and a block no edit has
// replaced is written back as exactly those lines - so a file opened and closed
// untouched keeps its bytes, and an edit rewrites only the blocks it touched.
// Block rules follow ui/markdown.ts and inline reading is its inlineTokens(),
// so the editor and the card never read one file two ways. DOM-free.

import {
  inlineTokens, ATX, RULE, FENCE, QUOTE, BULLET, SETEXT, TABLE_RULE, TASK, opensBlock,
} from '../markdown.ts';
import { oversize } from '../../consent.ts';
import { para, runsLen, runsText, blockText, tidy } from './model.ts';
import type { Block, Doc, ListItem, ListKind, Marks, Pos, Run } from './model.ts';

/** The lines each block was read from. Absent for a block an edit made. */
const SOURCE = new WeakMap<Block, string[]>();
/** The block that stood before each one in its file, so a moved block is known to have moved. */
const PREV = new WeakMap<Block, Block | null>();
/** The first line of each block in its file, for putting a caret at a place in the source. */
const LINE = new WeakMap<Block, number>();

/**
 * The largest file the editor opens without asking, in bytes: the viewer's
 * own read limit (TEXT_MAX in ui/viewer.ts). Editing a part of a file would
 * throw the rest away on save, so past this the choice is the whole file or
 * reading only - see measureForEdit().
 */
export const EDIT_MAX = 200_000;

/** A file of `bytes` checked against EDIT_MAX. Throws Oversize, never a plain Error. */
export function measureForEdit(bytes: number, lifted = false) {
  if (!lifted && bytes > EDIT_MAX) {
    throw oversize('text-edit', `This file is ${Math.round(bytes / 1024)} KB, and the editor opens `
      + `${Math.round(EDIT_MAX / 1024)} KB without asking.`);
  }
}

/** ORDERED from ui/markdown.ts, with the delimiter captured, which a writer needs and a renderer does not. */
const NUMBERED = /^( *)(\d{1,9})([.)])\s+(.*)$/;
const FRONT = /^---\s*$/;
const FRONT_END = /^(---|\.\.\.)\s*$/;
const HTML_BLOCK = /^ {0,3}<[A-Za-z!?/]/;
const DEFINITION = /^ {0,3}\[[^\]]+\]:/;

/** A byte-order mark and one consistent line ending, taken off and noted so they go back on. */
function unwrap(src: string) {
  const bom = src.startsWith('﻿');
  let text = bom ? src.slice(1) : src;
  const lf = text.split('\n').length - 1;
  const crlf = text.split('\r\n').length - 1;
  // Only a file that is CRLF throughout is read as CRLF. A mixed one keeps its
  // stray \r as characters, which is the reading that writes back unchanged.
  const eol = lf > 0 && lf === crlf ? '\r\n' : '\n';
  if (eol === '\r\n') text = text.replaceAll('\r\n', '\n');
  return { text, eol, bom };
}

// ---------------------------------------------------------------------------
// Reading
// ---------------------------------------------------------------------------

/** Inline Markdown as runs. A link with a title, an image, an autolink: kept as raw source. */
export function inlineRuns(src: string, marks: Marks = {}): Run[] {
  const out: Run[] = [];
  for (const t of inlineTokens(src)) {
    switch (t.kind) {
      case 'text': out.push({ ...marks, text: t.text }); break;
      case 'code': out.push({ ...marks, text: t.text, code: true }); break;
      case 'image':
      case 'autolink': out.push({ ...marks, text: t.src, raw: true }); break;
      case 'link':
        if (t.label && t.src === `[${t.label}](${t.url})`) out.push(...inlineRuns(t.label, { ...marks, href: t.url }));
        else out.push({ ...marks, text: t.src, raw: true });
        break;
      case 'strong': out.push(...inlineRuns(t.inner, { ...marks, b: true })); break;
      case 'em': out.push(...inlineRuns(t.inner, { ...marks, i: true })); break;
      case 'strike': out.push(...inlineRuns(t.inner, { ...marks, s: true })); break;
    }
  }
  return tidy(out);
}

/** A Markdown file as a document. Anything not modelled becomes a raw block, kept byte for byte. */
export function parseMarkdown(src: string): Doc {
  const { text, eol, bom } = unwrap(src);
  const lines = text.split('\n');
  const n = lines.length;
  const blocks: Block[] = [];
  let before: string[] = [];
  let prev: Block | null = null;
  // The indent of each open level of the list being read.
  let levels: number[] = [];
  const raw = (from: number, to: number): Block => ({ kind: 'raw', before, text: lines.slice(from, to).join('\n') });
  /** Lines from `from` up to the next blank one. */
  const toBlank = (from: number) => {
    let j = from + 1;
    while (j < n && lines[j].trim()) j++;
    return j;
  };

  let i = 0;
  while (i < n) {
    const line = lines[i];
    if (!line.trim()) { before.push(line); i++; continue; }
    let block: Block;
    let end = i + 1;
    const fence = FENCE.exec(line);
    const atx = ATX.exec(line);
    const bullet = BULLET.exec(line);
    const numbered = NUMBERED.exec(line);
    const front = i === 0 && FRONT.test(line) ? lines.findIndex((l, j) => j > 0 && FRONT_END.test(l)) : -1;
    if (front > 0) {
      block = raw(0, front + 1);
      end = front + 1;
    } else if (RULE.test(line)) {
      block = { kind: 'rule', before };
    } else if (fence) {
      const close = fence[1][0].repeat(3);
      let j = i + 1;
      while (j < n && !lines[j].trimStart().startsWith(close)) j++;
      if (j < n) {
        block = { kind: 'code', before, fence: fence[1], lang: fence[2], text: lines.slice(i + 1, j).join('\n') };
        end = j + 1;
      } else {
        // Unclosed: the rest of the file, as the renderer reads it too.
        block = raw(i, n);
        end = n;
      }
    } else if (atx) {
      const n = atx[1].length;
      const level = n === 1 ? 1 : n === 2 ? 2 : 3;
      block = n <= 3 ? { kind: 'h', before, level, runs: inlineRuns(atx[2]) } : raw(i, i + 1);
    } else if (QUOTE.test(line)) {
      const inner: string[] = [];
      let j = i;
      while (j < n && (QUOTE.test(lines[j]) || (inner.length && lines[j].trim()))) {
        inner.push(QUOTE.exec(lines[j])?.[1] ?? lines[j]);
        j++;
      }
      end = j;
      // One paragraph of quoted words is a quote; a quote holding blocks is kept as written.
      block = inner.every(l => l.trim() && !opensBlock(l))
        ? { kind: 'quote', before, runs: inlineRuns(inner.join('\n')) }
        : raw(i, j);
    } else if (line.includes('|') && TABLE_RULE.test(lines[i + 1] ?? '')) {
      let j = i + 2;
      while (j < n && lines[j].trim() && lines[j].includes('|')) j++;
      block = raw(i, j);
      end = j;
    } else if (HTML_BLOCK.test(line) || DEFINITION.test(line)) {
      end = toBlank(i);
      block = raw(i, end);
    } else if (bullet || numbered) {
      const m = (bullet ?? numbered)!;
      const indent = m[1].length;
      if (prev?.kind !== 'li') levels = [];
      while (levels.length && levels[levels.length - 1] > indent) levels.pop();
      if (!levels.length || indent > levels[levels.length - 1]) levels.push(indent);
      const words = bullet ? bullet[3] : numbered![4];
      // More of the item: any line that is neither blank nor another item, as the renderer reads it.
      let j = i + 1;
      while (j < n && lines[j].trim() && !BULLET.test(lines[j]) && !NUMBERED.test(lines[j])) j++;
      end = j;
      const task = bullet ? TASK.exec(words) : null;
      const list: ListKind = task ? 'task' : bullet ? 'bullet' : 'number';
      block = {
        kind: 'li', before, list,
        depth: levels.length - 1,
        checked: !!task && task[1] !== ' ',
        bullet: bullet ? bullet[2] : '-',
        delim: numbered ? numbered[3] : '.',
        start: numbered ? Number(numbered[2]) : 1,
        runs: inlineRuns([task ? task[2] : words, ...lines.slice(i + 1, j).map(l => l.trim())].join('\n')),
      };
    } else if (/^ {4}/.test(line) && prev?.kind !== 'li') {
      let j = i + 1;
      while (j < n && (/^ {4}/.test(lines[j]) || !lines[j].trim())) j++;
      while (j > i + 1 && !lines[j - 1].trim()) j--;
      block = raw(i, j);
      end = j;
    } else {
      const words: string[] = [];
      let j = i;
      while (j < n && lines[j].trim() && !opensBlock(lines[j]) && !SETEXT.test(lines[j])) words.push(lines[j++].trimStart());
      if (!words.length) {
        block = raw(i, i + 1);
      } else if (j < n && SETEXT.test(lines[j])) {
        block = { kind: 'h', before, level: lines[j].trim()[0] === '=' ? 1 : 2, runs: inlineRuns(words.join(' ')) };
        end = j + 1;
      } else {
        block = { kind: 'p', before, runs: inlineRuns(words.join('\n')) };
        end = j;
      }
    }
    before = [];
    if (block.kind !== 'li') levels = [];
    SOURCE.set(block, lines.slice(i, end));
    PREV.set(block, prev);
    LINE.set(block, i);
    blocks.push(block);
    prev = block;
    i = end;
  }
  if (!blocks.length) blocks.push(para([], []));
  return { blocks, tail: before, eol, bom, plain: false };
}

/** A .txt file: every line one paragraph, nothing read into it. */
export function parsePlain(src: string): Doc {
  const { text, eol, bom } = unwrap(src);
  const blocks = text.split('\n').map(l => para(l ? [{ text: l }] : [], []));
  return { blocks, tail: [], eol, bom, plain: true };
}

// ---------------------------------------------------------------------------
// Writing
// ---------------------------------------------------------------------------

/** Where one level of a list sits: its indent, the marker's width, and the last number. */
type Level = { indent: number, width: number, num: number, list: ListKind };

/** The document as text: kept blocks as their own lines, edited ones in the plainest spelling. */
export function serializeDoc(doc: Doc): string {
  const bom = doc.bom ? '﻿' : '';
  if (doc.plain) return bom + doc.blocks.map(blockText).join(doc.eol);
  const out: string[] = [];
  const lists: Level[] = [];
  let prev: Block | null = null;
  for (const b of doc.blocks) {
    const src = SOURCE.get(b);
    // An emptied paragraph is not a thing Markdown can hold.
    if (!src && b.kind === 'p' && !runsLen(b.runs)) continue;
    let lines: string[];
    if (b.kind === 'li') lines = itemLines(b, src, lists);
    else {
      lists.length = 0;
      lines = src ?? blockLines(b);
    }
    const inPlace = !!src && PREV.get(b) === prev && (!prev || SOURCE.has(prev));
    let before = b.before;
    if (!prev) before = inPlace ? before : [];
    else if (!inPlace && !before.length && needsBlank(prev, b)) before = [''];
    out.push(...before, ...lines);
    prev = b;
  }
  out.push(...doc.tail);
  return bom + out.join(doc.eol);
}

/** Whether two blocks written with no blank line between them would read back as one. */
const needsBlank = (prev: Block, next: Block) =>
  !(prev.kind === 'li' && next.kind === 'li') && prev.kind !== 'h' && prev.kind !== 'rule' && prev.kind !== 'code';

function blockLines(b: Exclude<Block, ListItem>): string[] {
  switch (b.kind) {
    case 'p': return serializeRuns(b.runs).split('\n').map(escapeLineStart);
    case 'h': {
      // A trailing # would be read as the heading's closing sequence.
      const words = serializeRuns(b.runs).replaceAll('\n', ' ').replace(/#$/, '\\#');
      return ['#'.repeat(b.level) + ' ' + words];
    }
    case 'quote': return serializeRuns(b.runs).split('\n').map(l => (l ? '> ' + escapeLineStart(l) : '>'));
    case 'code': {
      let fence = b.fence || '```';
      // A fence inside the code as long as ours would close it early.
      for (const l of b.text.split('\n')) {
        const m = /^ {0,3}(`{3,}|~{3,})/.exec(l);
        if (m && m[1][0] === fence[0] && m[1].length >= fence.length) fence = fence[0].repeat(m[1].length + 1);
      }
      return [fence + b.lang, ...(b.text ? b.text.split('\n') : []), fence];
    }
    case 'rule': return ['---'];
    case 'raw': return b.text.split('\n');
  }
}

/** One list item, and where its level stands for the items after it. */
function itemLines(b: ListItem, src: string[] | undefined, lists: Level[]): string[] {
  const record = (level: Level) => {
    lists[b.depth] = level;
    lists.length = b.depth + 1;
  };
  const first = src?.[0] ?? '';
  const m = src ? BULLET.exec(first) ?? NUMBERED.exec(first) : null;
  if (src && m) {
    const words = m[m.length - 1];
    const indent = m[1].length;
    record({ indent, width: first.length - words.length - indent, num: Number(m[2]) || 0, list: b.list });
    return src;
  }
  const parent = lists[Math.min(b.depth, lists.length) - 1];
  const indent = parent ? parent.indent + parent.width : 0;
  const same = lists[b.depth];
  const num = b.list === 'number' ? (same?.list === 'number' && lists.length > b.depth ? same.num + 1 : b.start) : 0;
  const marker = b.list === 'number' ? `${num}${b.delim}` : b.bullet;
  const task = b.list === 'task' ? `[${b.checked ? 'x' : ' '}] ` : '';
  record({ indent, width: marker.length + 1, num, list: b.list });
  const [head, ...rest] = serializeRuns(b.runs).split('\n');
  // Words that start like a task box would read back as one.
  const lead = !task && TASK.test(head + ' ') ? '\\' + head : head;
  const pad = ' '.repeat(indent + marker.length + 1);
  return [' '.repeat(indent) + marker + ' ' + task + lead, ...rest.map(l => pad + escapeLineStart(l))];
}

/** A line of words that would otherwise read as the start of a block, made to read as words. */
function escapeLineStart(line: string): string {
  const cut = line.replace(/^ {4,}/, '   ');
  const lead = /^ */.exec(cut)![0];
  const rest = cut.slice(lead.length);
  if (/^\d{1,9}[.)](\s|$)/.test(rest)) return lead + rest.replace(/^(\d+)/, '$1\\');
  if (/^(#{1,6}(\s|$)|>|[-+*](\s|$)|```|~~~|=+\s*$)/.test(rest) || RULE.test(rest)) return lead + '\\' + rest;
  return cut;
}

// ---------------------------------------------------------------------------
// Writing runs
// ---------------------------------------------------------------------------

/** A piece of a line being written: words to escape, source to keep, or a mark opening or closing. */
type Tok =
  | { t: 'text', s: string }
  | { t: 'lit', s: string }
  | { t: 'open' | 'close', m: string, s: string };

const STYLE_KEYS = ['b', 'i', 's'] as const;
/** A mark as a stack entry. A link is one per address: two links side by side are two links. */
const marksList = (r: Run) => [...(r.href ? ['a' + r.href] : []), ...STYLE_KEYS.filter(k => r[k])];

const isWord = (c: string | undefined) => !!c && /[\p{L}\p{N}]/u.test(c);
const isSpace = (c: string | undefined) => !c || /\s/.test(c);
const PUNCT = /[!-/:-@[-`{-~]/;

/** A code span, its fence one backtick longer than any run of them inside. */
function codeSpan(text: string): string {
  const longest = Math.max(0, ...(text.match(/`+/g) ?? []).map(s => s.length));
  const fence = '`'.repeat(longest + 1);
  const pad = /^`|`$/.test(text) || (/^ .* $/.test(text) && text.trim()) ? ' ' : '';
  return fence + pad + text + pad + fence;
}

/**
 * Runs as inline Markdown. Marks nest, the longest-lasting outermost, so a
 * bold sentence with one italic word is one bold span around one italic one.
 * Space at the edge of a mark moves outside it, where Markdown needs it, and
 * italic is `_` between words and `*` inside one, the one spelling each place
 * reads back as italic.
 */
export function serializeRuns(input: Run[]): string {
  const runs = tidy(input);
  const toks: Tok[] = [];
  let stack: string[] = [];
  runs.forEach((r, k) => {
    const want = new Set(marksList(r));
    let keep = 0;
    while (keep < stack.length && want.has(stack[keep])) keep++;
    for (let j = stack.length - 1; j >= keep; j--) toks.push({ t: 'close', m: stack[j], s: '' });
    stack = stack.slice(0, keep);
    // How many runs from here on carry each mark: the longer, the further out.
    const reach = (m: string) => {
      let n = 0;
      while (runs[k + n] && marksList(runs[k + n]).includes(m)) n++;
      return n;
    };
    const opening = [...want].filter(m => !stack.includes(m)).sort((x, y) => reach(y) - reach(x));
    for (const m of opening) toks.push({ t: 'open', m, s: '' });
    stack.push(...opening);
    toks.push(r.code ? { t: 'lit', s: codeSpan(r.text) } : r.raw ? { t: 'lit', s: r.text } : { t: 'text', s: r.text });
  });
  for (let j = stack.length - 1; j >= 0; j--) toks.push({ t: 'close', m: stack[j], s: '' });

  // Space at the edges of a mark, moved outside it.
  for (let k = 0; k < toks.length; k++) {
    const tk = toks[k];
    if (tk.t !== 'text') continue;
    let j = k;
    while (j > 0 && toks[j - 1].t === 'open') j--;
    const lead = j < k ? /^\s+/.exec(tk.s)?.[0] : undefined;
    if (lead) {
      tk.s = tk.s.slice(lead.length);
      toks.splice(j, 0, { t: 'text', s: lead });
      k++;
    }
    let e = k;
    while (e + 1 < toks.length && toks[e + 1].t === 'close') e++;
    const trail = e > k ? /\s+$/.exec(tk.s)?.[0] : undefined;
    if (trail) {
      tk.s = tk.s.slice(0, -trail.length);
      toks.splice(e + 1, 0, { t: 'text', s: trail });
    }
  }
  // A mark left around nothing is dropped, not written as `****`.
  const clean = toks.filter(tk => tk.t !== 'text' || tk.s);
  for (let k = 0; k + 1 < clean.length; k++) {
    const a = clean[k], z = clean[k + 1];
    if (a.t === 'open' && z.t === 'close' && a.m === z.m) {
      clean.splice(k, 2);
      k = Math.max(-1, k - 2);
    }
  }

  // Delimiters. Italic is decided by the characters around the pair.
  const firstChar = (k: number) => {
    for (let j = k; j < clean.length; j++) {
      const tk = clean[j];
      if (tk.t === 'text' || tk.t === 'lit') return tk.s[0];
      if (tk.m[0] === 'a') return '[';
      if (tk.m !== 'i') return tk.m === 's' ? '~' : '*';
    }
    return undefined;
  };
  const opens: number[] = [];
  const text = (k: number) => {
    const tk = clean[k];
    return tk.t === 'text' || tk.t === 'lit' ? tk.s : '';
  };
  clean.forEach((tk, k) => {
    if (tk.t === 'open') {
      tk.s = tk.m === 'b' ? '**' : tk.m === 's' ? '~~' : tk.m === 'i' ? '' : '[';
      opens.push(k);
    } else if (tk.t === 'close') {
      const at = opens.pop()!;
      if (tk.m === 'b') tk.s = '**';
      else if (tk.m === 's') tk.s = '~~';
      else if (tk.m[0] === 'a') tk.s = '](' + tk.m.slice(1) + ')';
      else {
        const before = clean.slice(0, at).map((t, j) => text(j) || t.s).join('').slice(-1);
        const after = firstChar(k + 1);
        const d = isWord(before) || isWord(after) ? '*' : '_';
        clean[at].s = d;
        tk.s = d;
      }
    }
  });

  // Words, escaped against the characters actually around them.
  let out = '';
  clean.forEach((tk, k) => {
    if (tk.t !== 'text') { out += tk.s; return; }
    const next = clean[k + 1];
    let s = escapeText(tk.s, out.slice(-1) || undefined, next?.s[0]);
    // `!` before a link would make it an image.
    if (s.endsWith('!') && next?.t === 'open' && next.m[0] === 'a') s = s.slice(0, -1) + '\\!';
    out += s;
  });
  return out;
}

/** Plain words made safe to write as Markdown, escaping only what would otherwise be read as markup. */
function escapeText(s: string, prev: string | undefined, next: string | undefined): string {
  let out = '';
  for (let k = 0; k < s.length; k++) {
    const c = s[k];
    const p = k ? s[k - 1] : prev;
    const n = k + 1 < s.length ? s[k + 1] : next;
    switch (c) {
      case '\\': out += n && PUNCT.test(n) ? '\\\\' : '\\'; break;
      case '*': out += isSpace(p) && isSpace(n) ? '*' : '\\*'; break;
      case '_': out += isWord(p) && isWord(n) ? '_' : '\\_'; break;
      case '`': out += '\\`'; break;
      case '~': out += p === '~' || n === '~' ? '\\~' : '~'; break;
      case '[': out += /^[^\]]*\]\(/.test(s.slice(k + 1)) ? '\\[' : '['; break;
      default: out += c;
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Both kinds
// ---------------------------------------------------------------------------

/** A file's text as a document, read the way its extension says. */
export const parseDoc = (text: string, plain: boolean) => (plain ? parsePlain(text) : parseMarkdown(text));

/**
 * The document position for a place in the source it was read from: `line`
 * and `col` in the file. Exact for paragraphs and headings, which is what a
 * sticky turned document holds; the end of the document for anything else.
 */
export function posAtSource(doc: Doc, line: number, col: number): Pos {
  const end = { b: doc.blocks.length - 1, o: blockText(doc.blocks[doc.blocks.length - 1]).length };
  if (doc.plain) {
    const b = doc.blocks[line];
    return b ? { b: line, o: Math.min(col, blockText(b).length) } : end;
  }
  for (let n = doc.blocks.length - 1; n >= 0; n--) {
    const b = doc.blocks[n];
    const start = LINE.get(b);
    const src = SOURCE.get(b);
    if (start === undefined || !src || start > line) continue;
    if (line >= start + src.length || (b.kind !== 'p' && b.kind !== 'h')) return end;
    const words = runsText(b.runs).split('\n');
    const row = b.kind === 'h' ? 0 : line - start;
    const lead = b.kind === 'h' ? src[0].length - src[0].replace(/^ {0,3}#{1,6}\s+/, '').length : src[row].length - src[row].trimStart().length;
    let o = 0;
    for (let r = 0; r < row && r < words.length; r++) o += words[r].length + 1;
    return { b: n, o: Math.min(runsLen(b.runs), o + Math.max(0, col - lead)) };
  }
  return end;
}
