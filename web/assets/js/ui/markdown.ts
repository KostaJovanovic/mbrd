// Hand-written Markdown renderer. CommonMark's common half, GitHub's tables
// and task lists, and Obsidian's own: wikilinks and embeds, ==highlights==,
// callouts, tags, footnotes, comments, math, properties and a handful of
// inline HTML tags. Every scrap of text goes in as a text node, never markup -
// no innerHTML, no escaping to get right. Only href reaches an attribute,
// checked via linkURL.

import { linkURL } from '../canvas/renderers.ts';

/**
 * What one document says about itself away from where it is used: its link
 * definitions, its footnotes, and the order the footnotes were first cited
 * in. Set for the length of one renderMarkdown() and read by inline(), which
 * is several calls deep by then and has no other way to reach it.
 */
type Context = {
  refs: Map<string, string>,
  notes: Map<string, string>,
  /** Footnote ids in the order first cited, an inline one under a key no file can write. */
  cited: string[],
};
let ctx: Context | null = null;

/**
 * Markdown source as a DocumentFragment. The whole document at once - no
 * streaming, no incremental parse, since the caller already has the text and
 * a README is kilobytes.
 */
export function renderMarkdown(src: unknown): DocumentFragment {
  const frag = document.createDocumentFragment();
  const all = String(src ?? '').replace(/\r\n?/g, '\n').split('\n');
  const front = frontmatter(all);
  const lines = front ? all.slice(front.end) : all;
  const was = ctx;
  ctx = { refs: new Map(), notes: new Map(), cited: [] };
  try {
    const body = definitions(lines, ctx);
    if (front) frag.append(properties(front.lines));
    for (const node of blocks(body)) frag.append(node);
    const notes = footnotes(ctx);
    if (notes) frag.append(notes);
  } finally {
    ctx = was;
  }
  return frag;
}

// ---------------------------------------------------------------------------
// The document's own furniture: properties, definitions, footnotes
// ---------------------------------------------------------------------------

export const FRONT = /^---\s*$/;
export const FRONT_END = /^(---|\.\.\.)\s*$/;

/** YAML frontmatter at the very top: its lines, and the line after it. */
function frontmatter(lines: string[]): { lines: string[], end: number } | null {
  if (!FRONT.test(lines[0] ?? '')) return null;
  const close = lines.findIndex((l, j) => j > 0 && FRONT_END.test(l));
  return close > 0 ? { lines: lines.slice(1, close), end: close + 1 } : null;
}

/**
 * Obsidian's properties, as a list of names and values. Read as the plain
 * YAML people write there - `key: value`, and a list under a key - and never
 * as YAML at large: anything else shows as the line it is.
 */
function properties(lines: string[]): HTMLElement {
  const dl = document.createElement('dl');
  dl.className = 'md-props';
  let dd: HTMLElement | null = null;
  let items: string[] = [];
  const flush = () => {
    if (dd && items.length) dd.textContent = items.join(', ');
    items = [];
  };
  for (const line of lines) {
    if (!line.trim() || line.trimStart().startsWith('#')) continue;
    const item = /^\s+-\s+(.*)$/.exec(line) ?? /^-\s+(.*)$/.exec(line);
    if (item && dd) { items.push(unquote(item[1])); continue; }
    const pair = /^([^\s:][^:]*):\s*(.*)$/.exec(line);
    flush();
    const dt = document.createElement('dt');
    dt.textContent = pair ? pair[1].trim() : line.trim();
    dd = document.createElement('dd');
    // An inline list, `[a, b]`, as the same words a dashed one gives.
    const value = pair ? pair[2].trim() : '';
    dd.textContent = /^\[.*\]$/.test(value) ? value.slice(1, -1).split(',').map(unquote).join(', ') : unquote(value);
    dl.append(dt, dd);
  }
  flush();
  return dl;
}

const unquote = (s: string) => s.trim().replace(/^(["'])(.*)\1$/, '$2');

export const LINK_DEF = /^ {0,3}\[([^\]^][^\]]*)\]:\s*<?([^\s>]+)>?(?:\s+(?:"[^"]*"|'[^']*'|\([^)]*\)))?\s*$/;
export const NOTE_DEF = /^ {0,3}\[\^([^\]\s]+)\]:\s?(.*)$/;

/**
 * The lines with every link definition and footnote taken out into `into`,
 * since both are said once and used elsewhere. A footnote runs on through its
 * indented lines. Inside a fence nothing is a definition.
 */
function definitions(lines: string[], into: Context): string[] {
  const out: string[] = [];
  let fence = '';
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const f = FENCE.exec(line);
    if (fence) {
      if (line.trimStart().startsWith(fence)) fence = '';
      out.push(line);
      continue;
    }
    if (f) { fence = f[1][0].repeat(3); out.push(line); continue; }
    const note = NOTE_DEF.exec(line);
    if (note) {
      const body = [note[2]];
      while (i + 1 < lines.length && (/^( {2,}|\t)\S/.test(lines[i + 1])
        || (!lines[i + 1].trim() && /^( {2,}|\t)\S/.test(lines[i + 2] ?? '')))) body.push(lines[++i].trim());
      if (!into.notes.has(note[1])) into.notes.set(note[1], body.join('\n').trim());
      continue;
    }
    const def = LINK_DEF.exec(line);
    if (def) {
      const key = refKey(def[1]);
      if (!into.refs.has(key)) into.refs.set(key, def[2]);
      continue;
    }
    out.push(line);
  }
  return out;
}

/** A link label as a definition matches it: case and runs of space set aside. */
const refKey = (s: string) => s.trim().replace(/\s+/g, ' ').toLowerCase();

/** The footnotes cited, in order, under a rule at the end - or nothing, if none were. */
function footnotes(c: Context): HTMLElement | null {
  if (!c.cited.length) return null;
  const section = document.createElement('section');
  section.className = 'md-footnotes';
  const ol = document.createElement('ol');
  // A footnote can cite another, which lands on the end of `cited` while this runs.
  for (let n = 0; n < c.cited.length; n++) {
    const li = document.createElement('li');
    li.append(inline(c.notes.get(c.cited[n]) ?? ''));
    ol.append(li);
  }
  section.append(document.createElement('hr'), ol);
  return section;
}

/** The number a footnote shows, citing it if this is its first time. Null for one never written. */
function cite(id: string): number | null {
  if (!ctx || !ctx.notes.has(id)) return null;
  let n = ctx.cited.indexOf(id);
  if (n < 0) n = ctx.cited.push(id) - 1;
  return n + 1;
}

// ---------------------------------------------------------------------------
// Blocks
// ---------------------------------------------------------------------------

export const RULE = /^ {0,3}((\*\s*){3,}|(-\s*){3,}|(_\s*){3,})$/;
// A closing run of #s needs a space before it, so `# C#` keeps its sharp.
export const ATX = /^ {0,3}(#{1,6})\s+(.*?)(?:\s+#+)?\s*$/;
export const FENCE = /^ {0,3}(```+|~~~+)\s*(\S*)/;
export const QUOTE = /^ {0,3}> ?(.*)$/;
export const BULLET = /^( *)([-*+])\s+(.*)$/;
export const ORDERED = /^( *)(\d{1,9})[.)]\s+(.*)$/;
// Any one character in the box, as Obsidian takes it: `[-]`, `[/]`, `[>]` are
// tasks too, and every one but a space is ticked.
export const TASK = /^\[([^\]])\]\s+(.*)$/;
/** A display-math block's opening line: `$$`, and maybe its first words. */
export const MATH = /^ {0,3}\$\$/;
/** A callout's first line, inside the quote: its type, whether it folds, and its title. */
export const CALLOUT = /^\[!([\w-]+)\]([+-]?)\s*(.*)$/;
export const SETEXT = /^ {0,3}(=+|-+)\s*$/;
export const TABLE_RULE = /^ *\|?[ :|-]+\|[ :|-]*$/;

/**
 * The deepest a blockquote may nest.
 *
 * blocks() recurses once per `>` on a quoted line, and 50,000 of them
 * overflowed the stack - the viewer's `.catch` turned that into a blank
 * document with nothing saying why. Sixty-four is past anything anybody
 * quotes; beyond it the rest is kept as text.
 */
const MAX_QUOTE_DEPTH = 64;

/**
 * One pass over the lines, emitting block nodes. Hand-rolled rather than a
 * two-phase block/inline parse, since every block here is decided by its
 * first line and closed by a blank one or a marker. `i` moves forward only,
 * which is what keeps a malformed document from looping.
 */
function blocks(lines: string[], depth = 0): HTMLElement[] {
  const out: HTMLElement[] = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];

    if (!line.trim()) { i++; continue; }

    if (RULE.test(line)) { out.push(document.createElement('hr')); i++; continue; }

    const fence = line.match(FENCE);
    if (fence) {
      const close = fence[1][0].repeat(3);
      const body: string[] = [];
      i++;
      // An unclosed fence runs to the end of the document - the only
      // non-destructive reading, and what every implementation does.
      while (i < lines.length && !lines[i].trimStart().startsWith(close)) body.push(lines[i++]);
      if (i < lines.length) i++;
      out.push(codeBlock(body.join('\n'), fence[2]));
      continue;
    }

    // A comment that is whole lines: from `%%` to the `%%` that closes it, gone.
    // One that shares its lines with words is the inline kind (inlineTokens).
    const comment = commentEnd(lines, i);
    if (comment >= 0) { i = comment + 1; continue; }

    const math = mathEnd(lines, i);
    if (math >= 0) {
      const tex = lines.slice(i, math + 1).join('\n').trim().replace(/^\$\$/, '').replace(/\$\$$/, '');
      out.push(mathNode(tex.trim(), true));
      i = math + 1;
      continue;
    }

    const atx = line.match(ATX);
    if (atx) {
      const h = document.createElement('h' + atx[1].length);
      h.append(inline(atx[2]));
      out.push(h);
      i++;
      continue;
    }

    if (QUOTE.test(line) && depth < MAX_QUOTE_DEPTH) {
      const inner: string[] = [];
      while (i < lines.length && (QUOTE.test(lines[i]) || (inner.length && lines[i].trim()))) {
        inner.push(lines[i].match(QUOTE)?.[1] ?? lines[i]);
        i++;
      }
      const call = CALLOUT.exec(inner[0] ?? '');
      out.push(call ? callout(call, inner.slice(1), depth) : quote(inner, depth));
      continue;
    }

    // A table is a header row, a delimiter row of dashes and colons, then
    // body rows to a blank line. The delimiter row is what makes it a table -
    // without it the pipes are just characters in a paragraph.
    if (line.includes('|') && TABLE_RULE.test(lines[i + 1] || '')) {
      const align = cells(lines[i + 1]).map(c =>
        (c.startsWith(':') && c.endsWith(':') ? 'center'
          : c.endsWith(':') ? 'right'
          : c.startsWith(':') ? 'left' : ''));
      const head = cells(line);
      i += 2;
      const body: string[][] = [];
      while (i < lines.length && lines[i].trim() && lines[i].includes('|')) body.push(cells(lines[i++]));
      out.push(table(head, body, align));
      continue;
    }

    if (BULLET.test(line) || ORDERED.test(line)) {
      const [list, next] = listAt(lines, i);
      out.push(list);
      i = next;
      continue;
    }

    // Four spaces of indent is a code block, unless continuing a list - hence
    // tested last of the block openers.
    if (/^ {4}/.test(line)) {
      const body: string[] = [];
      while (i < lines.length && (/^ {4}/.test(lines[i]) || !lines[i].trim())) body.push(lines[i++].slice(4));
      out.push(codeBlock(body.join('\n').replace(/\n+$/, ''), ''));
      continue;
    }

    // A paragraph runs to the next blank line or block opener. A setext
    // underline turns it into a heading; `---` is already caught above as a
    // thematic break.
    const para: string[] = [];
    while (i < lines.length && lines[i].trim()
           && !opensBlock(lines[i]) && !SETEXT.test(lines[i])) para.push(lines[i++]);
    if (i < lines.length && SETEXT.test(lines[i]) && para.length) {
      const h = document.createElement(lines[i].trim()[0] === '=' ? 'h1' : 'h2');
      h.append(inline(para.join(' ')));
      out.push(h);
      i++;
      continue;
    }
    if (!para.length) { i++; continue; }   // a line that only opens a block it did not
    const p = document.createElement('p');
    p.append(inline(para.join('\n')));
    out.push(p);
  }
  return out;
}

/** Does this line start a block, so a paragraph above it has to stop? */
export function opensBlock(line: string) {
  return RULE.test(line) || ATX.test(line) || FENCE.test(line) || QUOTE.test(line)
      || BULLET.test(line) || ORDERED.test(line) || MATH.test(line);
}

/**
 * The last line of a comment that starts the line at `i` and ends a line, or
 * -1. Unclosed, it is not a comment at all - the words show, as Obsidian
 * shows them - rather than hiding the rest of the file.
 */
export function commentEnd(lines: string[], i: number): number {
  const first = lines[i].trimStart();
  if (!first.startsWith('%%')) return -1;
  let from = 2;
  for (let j = i; j < lines.length; j++) {
    const line = j === i ? first : lines[j];
    const at = line.indexOf('%%', from);
    from = 0;
    if (at < 0) continue;
    return line.slice(at + 2).trim() ? -1 : j;
  }
  return -1;
}

/** The last line of a `$$` block starting at `i`, or -1 if it is not one or never closes. */
export function mathEnd(lines: string[], i: number): number {
  if (!MATH.test(lines[i])) return -1;
  const first = lines[i].trim();
  if (first.length > 4 && first.endsWith('$$')) return i;
  for (let j = i + 1; j < lines.length; j++) if (lines[j].trim().endsWith('$$')) return j;
  return -1;
}

/**
 * Math, as the TeX it was written in. There is no typesetter here - KaTeX is
 * a quarter of a megabyte and its fonts - so the source is shown in its own
 * face, set apart, which is what a reader can still follow.
 */
function mathNode(tex: string, display: boolean) {
  const el = document.createElement(display ? 'div' : 'span');
  el.className = display ? 'md-math md-math-block' : 'md-math';
  el.textContent = tex;
  return el;
}

function quote(inner: string[], depth: number) {
  const q = document.createElement('blockquote');
  for (const node of blocks(inner, depth + 1)) q.append(node);
  return q;
}

/**
 * Obsidian's types, each with the names it also answers to. The stylesheets
 * colour by the first; a type nobody listed is a note, as Obsidian draws it.
 */
const CALLOUTS: Record<string, string[]> = {
  note: [],
  abstract: ['summary', 'tldr'],
  info: [],
  todo: [],
  tip: ['hint', 'important'],
  success: ['check', 'done'],
  question: ['help', 'faq'],
  warning: ['caution', 'attention'],
  failure: ['fail', 'missing'],
  danger: ['error'],
  bug: [],
  example: [],
  quote: ['cite'],
};
const calloutKind = (type: string) =>
  Object.keys(CALLOUTS).find(k => k === type || CALLOUTS[k].includes(type)) ?? 'note';

/**
 * A callout: `> [!type] Title`, then its body. A `+` or `-` after the type
 * makes it fold, open or shut, which is a <details> - the browser's own
 * disclosure, so it opens from the keyboard with nothing wired here.
 */
function callout(head: RegExpExecArray, body: string[], depth: number) {
  const type = head[1].toLowerCase();
  const folds = !!head[2];
  const box = document.createElement(folds ? 'details' : 'div');
  box.className = 'md-callout';
  box.dataset.callout = calloutKind(type);
  if (folds && head[2] === '+') {
    // SAFETY: `folds` chose <details> above, so inside this branch the box is one.
    (box as HTMLDetailsElement).open = true;
  }
  const title = document.createElement(folds ? 'summary' : 'div');
  title.className = 'md-callout-title';
  title.append(head[3].trim() ? inline(head[3].trim()) : plain(type[0].toUpperCase() + type.slice(1)));
  box.append(title);
  if (body.some(l => l.trim())) {
    const content = document.createElement('div');
    content.className = 'md-callout-body';
    for (const node of blocks(body, depth + 1)) content.append(node);
    box.append(content);
  }
  return box;
}

/**
 * One list and everything nested inside it. Nesting is by indent alone: a
 * marker indented further opens a child list, one indented less closes back
 * out - the rule people actually write to, whatever CommonMark says.
 */
function listAt(lines: string[], start: number): [HTMLElement, number] {
  // Only called on a line that matched one of the two - see blocks().
  const first = (lines[start].match(BULLET) || lines[start].match(ORDERED))!;
  const indent = first[1].length;
  const ordered = !lines[start].match(BULLET);
  const list = document.createElement(ordered ? 'ol' : 'ul');
  if (ordered && first[2] !== '1') {
    // SAFETY: `ordered` is the same flag that chose <ol> above, so inside
    // this branch the element is that one.
    (list as HTMLOListElement).start = Number(first[2]);
  }
  let i = start;
  let li: HTMLElement | null = null;
  while (i < lines.length) {
    const line = lines[i];
    if (!line.trim()) {
      // A blank line inside a list is a paragraph break, not the end of it -
      // unless nothing follows that belongs to the list.
      const next = lines[i + 1];
      if (!next || !(BULLET.test(next) || ORDERED.test(next) || /^ {2,}/.test(next))) break;
      i++;
      continue;
    }
    const bullet = line.match(BULLET);
    const m = bullet || line.match(ORDERED);
    // A numbered list after a bulleted one is a second list, not more of the
    // first - otherwise the two run together and numbers come out as bullets.
    if (m && !!bullet === ordered && m[1].length === indent) break;
    if (!m) {
      // A continuation line: more of the item above.
      if (!li) break;
      li.append(document.createTextNode(' '), inline(line.trim()));
      i++;
      continue;
    }
    const at = m[1].length;
    if (at < indent) break;
    if (at > indent) {
      const [child, next] = listAt(lines, i);
      (li || list).append(child);
      i = next;
      continue;
    }
    li = document.createElement('li');
    const rest = m[3];
    const task = rest.match(TASK);
    if (task) {
      // A checkbox that cannot be pressed: this renders a file, it does not
      // edit one, and a clickable box that changes nothing on disk would lie.
      const box = document.createElement('input');
      box.type = 'checkbox';
      box.checked = task[1] !== ' ';
      box.disabled = true;
      li.className = 'md-task';
      li.append(box, inline(task[2]));
    } else {
      li.append(inline(rest));
    }
    list.append(li);
    i++;
  }
  return [list, i];
}

function codeBlock(text: string, lang: string) {
  const pre = document.createElement('pre');
  const code = document.createElement('code');
  if (lang) code.dataset.lang = lang;
  code.textContent = text;
  pre.append(code);
  return pre;
}

/**
 * A table row split on unescaped pipes, with the outer pair dropped.
 *
 * Scanned rather than split on a lookbehind regex: **WebKit did not support
 * lookbehind until Safari 16.4**, and an unsupported regex literal is an
 * *early* SyntaxError - the engine refuses to parse the whole file, before
 * any of it runs. Since esbuild concatenates the tree into one bundle, that
 * one expression would fail the entire app to parse on every iOS below
 * 16.4: no board, no error, a splash screen that never lifts. That is also
 * what made 16.4 the actual floor - every other graceful-degradation path
 * never got the chance to run.
 */
function cells(line: string) {
  const trimmed = line.trim().replace(/^\|/, '').replace(/\|$/, '');
  const out: string[] = [];
  let cur = '';
  for (let i = 0; i < trimmed.length; i++) {
    const ch = trimmed[i];
    if (ch === '\\' && trimmed[i + 1] === '|') { cur += '|'; i++; continue; }
    if (ch === '|') { out.push(cur.trim()); cur = ''; continue; }
    cur += ch;
  }
  out.push(cur.trim());
  return out;
}

function table(head: string[], body: string[][], align: string[]) {
  const t = document.createElement('table');
  const thead = document.createElement('thead');
  const hr = document.createElement('tr');
  head.forEach((c, n) => {
    const th = document.createElement('th');
    if (align[n]) th.style.textAlign = align[n];
    th.append(inline(c));
    hr.append(th);
  });
  thead.append(hr);
  const tbody = document.createElement('tbody');
  for (const row of body) {
    const tr = document.createElement('tr');
    // Padded and clipped to the header's width, so a ragged row does not
    // shift every cell after it into the wrong column.
    for (let n = 0; n < head.length; n++) {
      const td = document.createElement('td');
      if (align[n]) td.style.textAlign = align[n];
      td.append(inline(row[n] || ''));
      tr.append(td);
    }
    tbody.append(tr);
  }
  t.append(thead, tbody);
  return t;
}

// ---------------------------------------------------------------------------
// Inline
// ---------------------------------------------------------------------------

// One alternation over every inline construct, tried left to right. Code
// first, because a backtick span suspends everything else inside it -
// `**not bold**` is four asterisks and two words.

/**
 * The longest an inline code span may be.
 *
 * Half of the fix for the one measured hang in this module: the lazy
 * backtick-span pattern backtracks quadratically when there is no closing
 * run of matching length, expanding to the end of the paragraph. A `.md`
 * starting with `x` and 200,000 backticks **blocked the main thread for 13.7
 * seconds** (measured on node 22); 50,000 chars took 0.8s, clean quadratic.
 * Ten thousand is far past any inline span anybody writes - a long listing is
 * a fenced block - and it turns the per-start cost into a constant. See
 * runsCanPair() for the other half.
 */
const CODE_SPAN_MAX = 10_000;

/**
 * Whether any two runs of backticks in this text are the same length.
 *
 * A code span needs an opening and closing run of exactly equal length, so if
 * no length recurs there is no code span at all, and the regex alternative
 * can be skipped entirely rather than tried and failed at every backtick.
 * One left-to-right pass turns the pathological input above into a single
 * run with no partner.
 *
 * A cheap sufficient condition, not a proof of linearity - text that does
 * have pairable runs still goes through the regex, bounded by CODE_SPAN_MAX.
 */
function runsCanPair(text: string): boolean {
  const seen = new Set<number>();
  for (let i = 0; i < text.length; i++) {
    if (text[i] !== '`') continue;
    let n = 1;
    while (text[i + n] === '`') n++;
    if (seen.has(n)) return true;
    seen.add(n);
    i += n - 1;
  }
  return false;
}

// A *source* string, not a RegExp: a global regex carries `lastIndex` on the
// object, and the callers recurse, so one shared instance would let an inner
// call reset the outer loop's cursor and never finish. A fresh instance per
// call is cheap and cannot do that.
// `%CODE%` is a guard the caller fills in: empty when a code span is
// possible, or the always-failing `(?!)` once runsCanPair() has ruled it
// out - written as a guard rather than by deleting the alternative, because
// the backreferences below are absolute across the whole pattern and
// removing groups would silently repoint them.
// The words inside a mark: an escaped character is one unit, so `\*` or `\_`
// can never be the closing delimiter, and the last unit is not a space.
const BODY = '((?:\\\\[\\s\\S]|[^\\\\])*?(?:\\\\[\\s\\S]|[^\\s\\\\]))';
const INLINE_SRC = [
  '%CODE%(`+)([\\s\\S]{0,' + CODE_SPAN_MAX + '}?)\\1',  // 1,2  code
  '!\\[([^\\]]*)\\]\\(([^()\\s]+)[^)]*\\)',    // 3,4  image
  // A label holds brackets only escaped, as CommonMark asks of unbalanced ones.
  '\\[((?:\\\\[\\s\\S]|[^\\\\\\[\\]])*)\\]\\(([^()\\s]+)[^)]*\\)', // 5,6  link
  '<((?:https?|mailto):[^>\\s]+)>',            // 7    autolink
  // The backreferences are absolute across the whole pattern, not relative to
  // their own alternative - \8 and \10, not \1 twice. Written as \1 they
  // pointed at the code fence's (undefined) group, and an undefined
  // backreference matches empty: **bold** rendered as one letter.
  // Not closed by the first two of a longer run: `**a *b***` is bold round
  // italic, and the lazy match alone would stop one star early.
  '(\\*\\*|__)(?=\\S)' + BODY + '\\8(?!\\*)',  // 8,9  strong
  '(\\*|_)(?=\\S)' + BODY + '\\10',            // 10,11 emphasis
  '~~(?=\\S)' + BODY + '~~',                   // 12   strikethrough
  '\\\\([!-/:-@[-`{-~])',                      // 13   backslash escape
  // Obsidian's, after CommonMark's so every group number above stays put.
  '==(?=[^\\s=])' + BODY + '==',               // 14   highlight
  '(!?)\\[\\[([^\\[\\]|\\n]+?)(?:\\|([^\\[\\]\\n]*))?\\]\\]', // 15,16,17 wikilink, embed
  '\\[\\^([^\\]\\s]+)\\]',                     // 18   footnote
  '\\^\\[((?:\\\\[\\s\\S]|[^\\\\\\[\\]])+)\\]', // 19  inline footnote
  // Bounded as the code span is, and for its reason: an opener with no closer
  // would otherwise be tried to the end of the paragraph from every one of them.
  '(%%[\\s\\S]{0,' + CODE_SPAN_MAX + '}?%%|<!--[\\s\\S]{0,' + CODE_SPAN_MAX + '}?-->)', // 20 comment
  '\\$\\$([\\s\\S]{1,' + CODE_SPAN_MAX + '}?)\\$\\$', // 21 display math
  // Not `$5 and $10`: no space inside either dollar, and no digit after the last.
  '\\$(?=[^\\s$])((?:\\\\[\\s\\S]|[^\\\\$\\n])*?[^\\s\\\\$])\\$(?!\\d)', // 22 math
  // A tag's characters: anything but space and punctuation, `-`, `/` and `_` aside.
  '#([^\\s!-,.:-@\\[-^`{-~]+)',                // 23   tag
  '[ \\t]\\^([A-Za-z0-9-]+)(?=\\n|$)',         // 24   block id
  // A bare address, without the full stop or bracket a sentence puts after it.
  '(https?:\\/\\/[^\\s<>]*[^\\s<>.,;:!?\'")\\]*_~])', // 25 url
  '<(u|sub|sup|kbd|mark|ins|del|small|b|i|s|em|strong)>([\\s\\S]{0,' + CODE_SPAN_MAX + '}?)<\\/\\26>', // 26,27 html
  '(<br\\s*\\/?>)',                            // 28   line break
  '\\[((?:\\\\[\\s\\S]|[^\\\\\\[\\]])*)\\]\\[([^\\[\\]]*)\\]', // 29,30 reference link
  '\\[((?:\\\\[\\s\\S]|[^\\\\\\[\\]])+)\\](?![(\\[:])', // 31 shortcut reference
].join('|');

/**
 * One piece of a line of inline Markdown. `src` is the exact source a token
 * came from, for a reader that has to write it back unchanged (ui/editor/).
 */
export type InlineToken =
  | { kind: 'text', text: string }
  | { kind: 'code', text: string, src: string }
  | { kind: 'image', alt: string, url: string, src: string }
  | { kind: 'link', label: string, url: string, src: string }
  | { kind: 'autolink', url: string, src: string }
  | { kind: 'strong' | 'em' | 'strike' | 'highlight', inner: string, src: string }
  | { kind: 'wikilink', target: string, alias: string, embed: boolean, src: string }
  | { kind: 'footnote', id: string, src: string }
  | { kind: 'note', inner: string, src: string }
  | { kind: 'comment', src: string }
  | { kind: 'math', tex: string, display: boolean, src: string }
  | { kind: 'tag', tag: string, src: string }
  | { kind: 'blockid', id: string, src: string }
  | { kind: 'url', url: string, src: string }
  | { kind: 'html', tag: string, inner: string, src: string }
  | { kind: 'reflink', label: string, ref: string, src: string };

const WORD_CHAR = /[\p{L}\p{N}]/u;

/**
 * The tokens of one run of inline Markdown, shared by this renderer and the
 * editor (ui/editor/markdown.ts) so the two can never read a file two ways.
 * Nested constructs come back as `inner` source for the caller to recurse on.
 *
 * Rules the regex cannot say without lookbehind (see cells() for why there is
 * none): an underscore inside a word is a character, not emphasis -
 * `snake_case_name` - a tag starts a word, so `page#part` is not one, and an
 * escaped character is itself.
 *
 * `refs` is the document's link definitions. Without it - the editor, which
 * keeps a reference as the words it is - every `[label][ref]` is a reflink and
 * a bare `[label]` is text.
 */
export function inlineTokens(src: unknown, refs?: ReadonlyMap<string, string>): InlineToken[] {
  const out: InlineToken[] = [];
  const text = String(src ?? '');
  const re = new RegExp(INLINE_SRC.replace('%CODE%', runsCanPair(text) ? '' : '(?!)'), 'g');
  let last = 0;
  let m: RegExpExecArray | null;
  const push = (s: string) => {
    if (!s) return;
    const prev = out[out.length - 1];
    if (prev?.kind === 'text') prev.text += s;
    else out.push({ kind: 'text', text: s });
  };
  while ((m = re.exec(text))) {
    const delim = m[8] || m[10] || '';
    const end = m.index + m[0].length;
    if (delim[0] === '_'
        && (WORD_CHAR.test(text[m.index - 1] || '') || WORD_CHAR.test(text[end] || ''))) {
      // Intraword: the underscores are letters of the word. Resume just past
      // them, so a real emphasis later in the run is still found.
      re.lastIndex = m.index + delim.length;
      continue;
    }
    // Not a tag mid-word, nor one that is only a number (`#1` is an issue, not a tag).
    const notTag = m[23] !== undefined
      && (/^\d+$/.test(m[23]) || (m.index > 0 && !/\s/.test(text[m.index - 1])));
    // A reference only where the document defines it; otherwise the brackets are words.
    const notRef = (m[31] !== undefined && !refs?.has(refKey(m[31])))
      || (m[29] !== undefined && !!refs && !refs.has(refKey(m[30] || m[29])));
    if (notTag || notRef) {
      re.lastIndex = m.index + 1;
      continue;
    }
    push(text.slice(last, m.index));
    last = end;
    if (m[1]) {
      // One space each side is padding when both are there, as CommonMark says.
      const body = m[2];
      const trimmed = body.length > 2 && body.startsWith(' ') && body.endsWith(' ') && body.trim()
        ? body.slice(1, -1) : body;
      out.push({ kind: 'code', text: trimmed, src: m[0] });
    } else if (m[4] !== undefined) out.push({ kind: 'image', alt: m[3], url: m[4], src: m[0] });
    else if (m[6] !== undefined) out.push({ kind: 'link', label: m[5], url: m[6], src: m[0] });
    else if (m[7]) out.push({ kind: 'autolink', url: m[7], src: m[0] });
    else if (m[9] !== undefined) out.push({ kind: 'strong', inner: m[9], src: m[0] });
    else if (m[11] !== undefined) out.push({ kind: 'em', inner: m[11], src: m[0] });
    else if (m[12] !== undefined) out.push({ kind: 'strike', inner: m[12], src: m[0] });
    else if (m[13] !== undefined) push(m[13]);
    else if (m[14] !== undefined) out.push({ kind: 'highlight', inner: m[14], src: m[0] });
    else if (m[16] !== undefined) {
      out.push({ kind: 'wikilink', target: m[16].trim(), alias: (m[17] ?? '').trim(), embed: m[15] === '!', src: m[0] });
    } else if (m[18] !== undefined) out.push({ kind: 'footnote', id: m[18], src: m[0] });
    else if (m[19] !== undefined) out.push({ kind: 'note', inner: m[19], src: m[0] });
    else if (m[20] !== undefined) out.push({ kind: 'comment', src: m[0] });
    else if (m[21] !== undefined) out.push({ kind: 'math', tex: m[21].trim(), display: true, src: m[0] });
    else if (m[22] !== undefined) out.push({ kind: 'math', tex: m[22], display: false, src: m[0] });
    else if (m[23] !== undefined) out.push({ kind: 'tag', tag: m[23], src: m[0] });
    else if (m[24] !== undefined) out.push({ kind: 'blockid', id: m[24], src: m[0] });
    else if (m[25] !== undefined) out.push({ kind: 'url', url: m[25], src: m[0] });
    else if (m[26] !== undefined) out.push({ kind: 'html', tag: m[26], inner: m[27], src: m[0] });
    else if (m[28] !== undefined) out.push({ kind: 'html', tag: 'br', inner: '', src: m[0] });
    else if (m[29] !== undefined) out.push({ kind: 'reflink', label: m[29], ref: m[30] || m[29], src: m[0] });
    else if (m[31] !== undefined) out.push({ kind: 'reflink', label: m[31], ref: m[31], src: m[0] });
    else push(m[0]);
    // A zero-length match would leave the cursor in place and loop forever.
    // None of the alternatives above can match empty today; this guards a
    // future one that does.
    if (!m[0].length) re.lastIndex++;
  }
  push(text.slice(last));
  return out;
}

/**
 * A run of text with its inline markup, as a DocumentFragment. Everything not
 * a construct lands as a text node; every construct's content recurses through
 * this same function, so nested constructs work without knowing about each other.
 */
function inline(src: unknown) {
  const frag = document.createDocumentFragment();
  for (const t of inlineTokens(src, ctx?.refs)) frag.append(inlineNode(t));
  return frag;
}

/** Picture files, for an embed: shown as their name, as an image is (see 'image' below). */
const PICTURE = /\.(png|jpe?g|gif|webp|avif|bmp|svg|heic|tiff?)$/i;

function inlineNode(t: InlineToken): Node {
  switch (t.kind) {
    case 'highlight': return wrap('mark', t.inner);
    case 'wikilink': {
      // A link to another note, or a note or picture pulled in - by name, into
      // a vault this app does not have. Shown as the name, and set apart, so
      // it reads as a link without pretending to go anywhere.
      const span = document.createElement('span');
      const picture = t.embed && PICTURE.test(t.target.split('#')[0]);
      span.className = picture ? 'md-image' : t.embed ? 'md-embed' : 'md-wikilink';
      span.title = t.target;
      // A picture's alias is its size (`|300`, `|300x200`), not words to show.
      const alias = picture && /^\d+(x\d+)?$/.test(t.alias) ? '' : t.alias;
      span.textContent = alias || t.target.replace(/#\^?/g, ' > ').replace(/^ > /, '');
      return span;
    }
    case 'footnote': {
      const n = cite(t.id);
      return n === null ? plain(t.src) : footnoteMark(n);
    }
    case 'note': {
      if (!ctx) return plain(t.src);
      // Under a key no `[^id]` can spell, so two inline notes are never one.
      const key = `\0${ctx.notes.size}`;
      ctx.notes.set(key, t.inner);
      return footnoteMark(cite(key) ?? 0);
    }
    case 'comment':
    case 'blockid':
      return document.createDocumentFragment();
    case 'math': return mathNode(t.tex, t.display);
    case 'tag': {
      const span = document.createElement('span');
      span.className = 'md-tag';
      span.textContent = '#' + t.tag;
      return span;
    }
    case 'url': return linking ? plain(t.src) : anchor(t.url, t.url);
    case 'html': {
      // A short allow-list of tags with no attributes, each built as itself:
      // nothing of the file's ever reaches markup.
      const el = document.createElement(t.tag);
      if (t.inner) el.append(inline(t.inner));
      return el;
    }
    case 'reflink': {
      const url = ctx?.refs.get(refKey(t.ref));
      return url === undefined ? plain(t.src) : anchor(url, t.label || t.ref);
    }
    case 'text': return plain(t.text);
    case 'code': {
      const code = document.createElement('code');
      code.textContent = t.text.trim();
      return code;
    }
    case 'image': {
      // An image points at a path on somebody else's disk, or a URL - neither
      // resolves here, since fetching it would be this app making a network
      // request about a file somebody opened. Drawn as its own alt text instead.
      const span = document.createElement('span');
      span.className = 'md-image';
      span.textContent = t.alt || t.url;
      return span;
    }
    case 'link': return anchor(t.url, t.label || t.url);
    case 'autolink': return anchor(t.url, t.url);
    case 'strong': return wrap('strong', t.inner);
    case 'em': return wrap('em', t.inner);
    case 'strike': return wrap('s', t.inner);
  }
}

function wrap(tag: string, content: string) {
  const el = document.createElement(tag);
  el.append(inline(content));
  return el;
}

/**
 * A link, or the text of one that is not safe to make live. linkURL() refuses
 * anything not http(s), so a `javascript:` or `data:` URL in a file the app
 * did not write comes out as the literal characters someone typed.
 */
function anchor(href: string, label: string) {
  const u = linkURL(href);
  if (!u) {
    const span = document.createElement('span');
    span.textContent = label;
    return span;
  }
  const a = document.createElement('a');
  a.href = u.href;
  a.target = '_blank';
  a.rel = 'noopener noreferrer';
  // A bare address inside a label is the label's words: read as a link of its
  // own, it nested one <a> in another, and an address as its own label recursed
  // until the stack gave out.
  linking++;
  try {
    a.append(inline(label));
  } finally {
    linking--;
  }
  return a;
}
/** How many links the words being read are inside. */
let linking = 0;

/** A footnote's number where it is cited. Not a link: a fragment would resolve against index.html's <base>. */
function footnoteMark(n: number) {
  const sup = document.createElement('sup');
  sup.className = 'md-fnref';
  sup.textContent = String(n);
  return sup;
}

/**
 * Text nodes, and the reason this file never needs to escape anything. A
 * newline inside a paragraph is a line break, as Obsidian draws one with its
 * strict line breaks off, which is how it ships.
 */
function plain(s: string): Node {
  if (!s.includes('\n')) return document.createTextNode(s);
  const frag = document.createDocumentFragment();
  s.split('\n').forEach((line, n) => {
    if (n) frag.append(document.createElement('br'));
    if (line) frag.append(document.createTextNode(line));
  });
  return frag;
}
