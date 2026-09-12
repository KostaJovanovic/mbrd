// Hand-written Markdown renderer. CommonMark's common half plus GitHub
// tables and task lists. Every scrap of text goes in as a text node,
// never markup — no innerHTML, no escaping to get right. Only href
// reaches an attribute, checked via linkURL.

import { linkURL } from '../canvas/renderers.ts';

/**
 * Markdown source as a DocumentFragment. The whole document at once - no
 * streaming, no incremental parse, since the caller already has the text and
 * a README is kilobytes.
 */
export function renderMarkdown(src: unknown): DocumentFragment {
  const frag = document.createDocumentFragment();
  for (const node of blocks(String(src ?? '').replace(/\r\n?/g, '\n').split('\n'))) {
    frag.append(node);
  }
  return frag;
}

// ---------------------------------------------------------------------------
// Blocks
// ---------------------------------------------------------------------------

const RULE = /^ {0,3}((\*\s*){3,}|(-\s*){3,}|(_\s*){3,})$/;
const ATX = /^ {0,3}(#{1,6})\s+(.*?)\s*#*\s*$/;
const FENCE = /^ {0,3}(```+|~~~+)\s*(\S*)/;
const QUOTE = /^ {0,3}> ?(.*)$/;
const BULLET = /^( *)([-*+])\s+(.*)$/;
const ORDERED = /^( *)(\d{1,9})[.)]\s+(.*)$/;
const TASK = /^\[([ xX])\]\s+(.*)$/;
const SETEXT = /^ {0,3}(=+|-+)\s*$/;
const TABLE_RULE = /^ *\|?[ :|-]+\|[ :|-]*$/;

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
      const q = document.createElement('blockquote');
      for (const node of blocks(inner, depth + 1)) q.append(node);
      out.push(q);
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
function opensBlock(line: string) {
  return RULE.test(line) || ATX.test(line) || FENCE.test(line) || QUOTE.test(line)
      || BULLET.test(line) || ORDERED.test(line);
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
// object, and inline() recurses, so one shared instance would let an inner
// call reset the outer loop's cursor and never finish. A fresh instance per
// call is cheap and cannot do that.
// `%CODE%` is a guard the caller fills in: empty when a code span is
// possible, or the always-failing `(?!)` once runsCanPair() has ruled it
// out - written as a guard rather than by deleting the alternative, because
// the backreferences below are absolute across the whole pattern and
// removing groups would silently repoint them.
const INLINE_SRC = [
  '%CODE%(`+)([\\s\\S]{0,' + CODE_SPAN_MAX + '}?)\\1',  // 1,2  code
  '!\\[([^\\]]*)\\]\\(([^()\\s]+)[^)]*\\)',    // 3,4  image
  '\\[([^\\]]*)\\]\\(([^()\\s]+)[^)]*\\)',     // 5,6  link
  '<((?:https?|mailto):[^>\\s]+)>',            // 7    autolink
  // The backreferences are absolute across the whole pattern, not relative to
  // their own alternative - \8 and \10, not \1 twice. Written as \1 they
  // pointed at the code fence's (undefined) group, and an undefined
  // backreference matches empty: **bold** rendered as one letter.
  '(\\*\\*|__)(?=\\S)([\\s\\S]*?\\S)\\8',      // 8,9  strong
  '(\\*|_)(?=\\S)([\\s\\S]*?\\S)\\10',         // 10,11 emphasis
  '~~(?=\\S)([\\s\\S]*?\\S)~~',                // 12   strikethrough
].join('|');

/**
 * A run of text with its inline markup, as a DocumentFragment. Everything not
 * a match lands as a text node; every match's content recurses through this
 * same function, so nested constructs work without knowing about each other.
 */
function inline(src: unknown) {
  const frag = document.createDocumentFragment();
  const text = String(src ?? '');
  const re = new RegExp(INLINE_SRC.replace('%CODE%', runsCanPair(text) ? '' : '(?!)'), 'g');
  let last = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text))) {
    if (m.index > last) frag.append(plain(text.slice(last, m.index)));
    last = m.index + m[0].length;
    frag.append(inlineNode(m));
    // A zero-length match would leave the cursor in place and loop forever.
    // None of the alternatives above can match empty today; this guards a
    // future seventh that does.
    if (!m[0].length) re.lastIndex++;
  }
  if (last < text.length) frag.append(plain(text.slice(last)));
  return frag;
}

function inlineNode(m: RegExpExecArray) {
  if (m[1]) {
    const code = document.createElement('code');
    code.textContent = m[2].trim();
    return code;
  }
  if (m[4] !== undefined) {
    // An image points at a path on somebody else's disk, or a URL - neither
    // resolves here, since fetching it would be this app making a network
    // request about a file somebody opened. Drawn as its own alt text instead.
    const span = document.createElement('span');
    span.className = 'md-image';
    span.textContent = m[3] || m[4];
    return span;
  }
  if (m[6] !== undefined) return anchor(m[6], m[5] || m[6]);
  if (m[7]) return anchor(m[7], m[7]);
  if (m[9] !== undefined) return wrap('strong', m[9]);
  if (m[11] !== undefined) return wrap('em', m[11]);
  if (m[12] !== undefined) return wrap('s', m[12]);
  return plain(m[0]);
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
  a.append(inline(label));
  return a;
}

/** A text node, and the reason this file never needs to escape anything. */
const plain = (s: string) => document.createTextNode(s);
