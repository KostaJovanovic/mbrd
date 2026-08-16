// Markdown, rendered.
//
// A `.md` classifies as 'text' and until now showed its source - hashes, pipes,
// asterisks and all. That is honest for a config file and wrong for the one text
// format people write *to be read*: a README on a moodboard is there because
// somebody wants to read it, and reading it as source is reading the scaffolding
// instead of the building.
//
// Hand-written, and that is the interesting part. Markdown is the one document
// format in this app that needs no container walked and no binary parsed - it is
// text with punctuation in it - so a parser for the subset people actually write
// is three hundred lines rather than a dependency. What is here is CommonMark's
// common half plus the GitHub table and task-list extensions: ATX and setext
// headings, fenced and indented code, blockquotes, nested ordered and unordered
// lists, task lists, tables, thematic breaks, and inline emphasis, strong,
// strikethrough, code, links, images and autolinks.
//
// What is deliberately not here: raw HTML, reference links, footnotes, and the
// long tail of CommonMark's edge cases. The first of those is a decision and the
// rest are omissions.
//
// The security rule is the whole of the first one and it is not negotiable. This
// app opens files it did not write - a `.md` off somebody's disk, out of a
// board that was mailed around - so **every scrap of text goes into the document
// as a text node**, never as markup. Raw HTML in the source is rendered as the
// characters it is made of. Nothing here ever touches innerHTML, which means
// there is no escaping to get right: the DOM API does it, by construction. The
// one place a string reaches an attribute is a link's href, and that goes
// through the same scheme check the rest of the app uses (linkURL), so a
// `javascript:` URL comes out as inert text.
//
// Builds DOM, so it is called rather than imported for effect: nothing here
// touches `document` until renderMarkdown() runs.

import { linkURL } from '../canvas/renderers.ts';

/**
 * Markdown source as a DocumentFragment.
 *
 * The whole document at once - there is no streaming and no incremental parse,
 * because the caller already has the text in hand and a README is kilobytes.
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
 * One pass over the lines, emitting block nodes.
 *
 * A hand-rolled line walker rather than a two-phase block/inline parse, because
 * every block this supports is decided by its first line and closed by a blank
 * one or by a marker. `i` moves forward only, which is what keeps a malformed
 * document - an unclosed fence, a table with no body - from looping.
 */
/**
 * The deepest a blockquote may nest.
 *
 * blocks() recurses once per `>` on a quoted line, so 50,000 of them overflowed
 * the stack - and the viewer's `.catch` turns that into `holder.textContent =
 * ''`, so the file rendered blank with nothing anywhere saying why. The module
 * header's promise that every count is capped before it is looped on did not
 * cover depth, here or in ui/documents.ts.
 *
 * Sixty-four is past anything anybody quotes and far under any engine's limit.
 * Beyond it the rest is kept as text, which is what an unparseable run of `>`
 * looks like anyway.
 */
const MAX_QUOTE_DEPTH = 64;

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
      // An unclosed fence runs to the end of the document, which is what every
      // Markdown implementation does and is the only non-destructive reading.
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

    // A table is a header row, a delimiter row of dashes and colons, then body
    // rows until a blank line. The delimiter row is what makes it a table -
    // without it the pipes are just characters in a paragraph, which is the
    // GitHub rule and the reason a line of prose containing a pipe is safe.
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

    // Four spaces of indent is a code block, as long as it is not continuing a
    // list - which is why this is tested last of the block openers.
    if (/^ {4}/.test(line)) {
      const body: string[] = [];
      while (i < lines.length && (/^ {4}/.test(lines[i]) || !lines[i].trim())) body.push(lines[i++].slice(4));
      out.push(codeBlock(body.join('\n').replace(/\n+$/, ''), ''));
      continue;
    }

    // A paragraph runs to the next blank line or to the next thing that opens a
    // block of its own. A setext underline turns the whole of it into a heading.
    const para: string[] = [];
    // Stops at a setext underline as well as at anything that opens a block: the
    // underline belongs to the paragraph above it and turns it into a heading,
    // so swallowing it as another line of prose loses both. `---` is caught by
    // the block test already, since it is also a thematic break.
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
 * One list and everything nested inside it.
 *
 * Nesting is by indent, and by indent alone: a marker indented further than the
 * one above it opens a child list, and one indented less closes back out. That
 * is the rule people actually write to, whatever CommonMark says about content
 * columns and lazy continuation.
 */
function listAt(lines: string[], start: number): [HTMLElement, number] {
  // Only called on a line that matched one of the two - see blocks().
  const first = (lines[start].match(BULLET) || lines[start].match(ORDERED))!;
  const indent = first[1].length;
  const ordered = !lines[start].match(BULLET);
  const list = document.createElement(ordered ? 'ol' : 'ul');
  if (ordered && first[2] !== '1') {
    // SAFETY: `ordered` is the flag that chose <ol> two lines above, and it is
    // the same flag tested here - so inside this branch the element is that one.
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
    // first. Without this the two run together and the numbers come out as
    // bullets, which is the list saying something the file did not.
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
      // A checkbox that cannot be pressed: this is a rendering of a file, not an
      // editor for it, and a box that took a click and changed nothing on disk
      // would be a lie about what the app is doing.
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

/** A table row split on unescaped pipes, with the outer pair dropped. */
function cells(line: string) {
  const trimmed = line.trim().replace(/^\|/, '').replace(/\|$/, '');
  return trimmed.split(/(?<!\\)\|/).map(c => c.trim().replace(/\\\|/g, '|'));
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
    // Padded and clipped to the header's width, so a ragged row does not shift
    // every cell after it into the wrong column.
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

// One alternation over every inline construct, tried left to right. Code first,
// because a backtick span suspends everything else inside it - `**not bold**`
// is four asterisks and two words.
//
/**
 * The longest an inline code span may be.
 *
 * Half of the fix for the one measured hang in this module. `(`+)([\s\S]*?)\1`
 * backtracks quadratically: at every backtick the lazy body expands looking for
 * a closing run of the same length, and when there is not one it expands to the
 * end of the paragraph. inline() is handed a whole paragraph up to TEXT_MAX =
 * 200,000 characters, so a `.md` whose first line is `x` followed by 200,000
 * backticks - a leading run of three or more would be caught by FENCE; a run
 * after any other character is not - **blocked the main thread for 13.7
 * seconds, measured on node 22**. 50,000 characters took 0.8s, which is clean
 * quadratic.
 *
 * Ten thousand characters is far past any inline span anybody writes - a long
 * listing is a fenced block, which never reaches this function - and it turns
 * the per-start cost into a constant. See runsCanPair() for the other half.
 */
const CODE_SPAN_MAX = 10_000;

/**
 * Whether any two runs of backticks in this text are the same length.
 *
 * The other half. A code span needs an opening run and a closing run of exactly
 * the same length, so if no length occurs twice there is no code span in this
 * text at all - and the alternative can be dropped rather than tried at every
 * backtick and failed at every backtick. One left-to-right pass, and it turns
 * the pathological input above into a single run with no partner, which is the
 * shape the measurement was taken on.
 *
 * A cheap sufficient condition rather than a proof of linearity: a document
 * that genuinely does have pairable runs still goes through the regex, where
 * CODE_SPAN_MAX is what bounds it. Between the two, the cost is bounded by the
 * text and not by the square of it.
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

// A *source* string, not a RegExp, and that is not a style choice. A global
// regex carries `lastIndex` on the object, and inline() recurses - a link's
// label goes back through it - so one shared instance has the inner call reset
// the outer call's cursor to zero and the outer loop starts the same text over
// from the beginning, forever. A fresh instance per call is a few microseconds
// and cannot do that.
// `%CODE%` is a guard the caller fills in: empty when a code span is possible
// in this text, and the always-failing lookahead `(?!)` when runsCanPair() has
// already proved it is not. An alternative that fails at its first character
// costs one step at each position instead of a scan to the end of the
// paragraph - and it is written as a guard rather than by deleting the
// alternative because the backreferences below are absolute across the whole
// pattern. Dropping two groups would silently repoint \8 and \10, which is the
// bug the comment under them records.
const INLINE_SRC = [
  '%CODE%(`+)([\\s\\S]{0,' + CODE_SPAN_MAX + '}?)\\1',  // 1,2  code
  '!\\[([^\\]]*)\\]\\(([^()\\s]+)[^)]*\\)',    // 3,4  image
  '\\[([^\\]]*)\\]\\(([^()\\s]+)[^)]*\\)',     // 5,6  link
  '<((?:https?|mailto):[^>\\s]+)>',            // 7    autolink
  // The backreferences are absolute across the whole pattern, not relative to
  // the alternative they sit in - so these are \8 and \10 and not \1 twice.
  // Written as \1 they pointed at the code fence's group, which is undefined in
  // an alternative that did not match, and an undefined backreference matches
  // the empty string: **bold** came out as a <strong> containing one letter.
  '(\\*\\*|__)(?=\\S)([\\s\\S]*?\\S)\\8',      // 8,9  strong
  '(\\*|_)(?=\\S)([\\s\\S]*?\\S)\\10',         // 10,11 emphasis
  '~~(?=\\S)([\\s\\S]*?\\S)~~',                // 12   strikethrough
].join('|');

/**
 * A run of text with its inline markup, as a DocumentFragment.
 *
 * Everything that is not a match lands as a text node, and every match's own
 * content is recursed through this same function - so emphasis inside a link
 * inside a table cell works without any of them knowing about each other.
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
    // A zero-length match would leave the cursor where it is and this loop would
    // never end. None of the alternatives above can match empty today; this is
    // the guard that keeps that true when a seventh is added.
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
    // An image in a Markdown file points at a path on somebody else's disk, or
    // at a URL. Neither resolves here: the board holds the .md and nothing
    // beside it, and fetching a remote image would be this app making a request
    // about a file somebody opened. So it is drawn as its own alt text, marked
    // as an image that is not here.
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
 * A link, or the text of one that is not safe to make live.
 *
 * linkURL() is the app's one answer to "is this an address" and it refuses
 * anything that is not http(s) - so a `javascript:` or `data:` URL in a file the
 * app did not write comes out as the characters somebody typed, which is exactly
 * what it should look like.
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
