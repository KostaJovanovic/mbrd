// A LaTeX document, read into ordinary elements for the editor's preview and
// the viewer. Not TeX: no engine, no packages, no page layout. A reader of
// the LaTeX people write for classes - article, report, beamer and exam;
// sections, lists, theorems, code, pseudocode, tables, figures, references -
// with the math handed to KaTeX (ui/math.ts). Anything it does not know is
// shown as the words inside it, never dropped. Built from createElement and
// createTextNode alone, as ui/markdown.ts is: the file is foreign.

import { linkURL } from '../canvas/renderers.ts';
import { typeset } from './math.ts';
import type { Macros } from './math.ts';

type LatexOptions = {
  /** The picture \includegraphics names, as an address to draw, or null to show its name. */
  picture?: (name: string) => string | null,
  /** Today, as \today writes it. A parameter so a test reads the same every day. */
  today?: string,
};

/** How deep groups and environments may nest before the rest is shown as written. */
const MAX_DEPTH = 40;
/** How many user macros one document may expand, so `\def\a{\a\a}` ends. */
const MAX_EXPANSIONS = 5000;

/** Where a \label points: the number it reads as, and what it numbers, for \autoref. */
type Label = { num: string, kind: string };

type State = {
  /** For KaTeX: `\R` to `\mathbb{R}`, from \newcommand and \DeclareMathOperator. */
  macros: Macros,
  /** The same definitions for text: their argument count, default first argument and body. */
  text: Map<string, { n: number, opt: string | null, body: string }>,
  envs: Map<string, { n: number, begin: string, end: string }>,
  /** Theorem-like environments: what each is called and which counter it counts on. */
  theorems: Map<string, { title: string, counter: string, numbered: boolean }>,
  counters: Map<string, number>,
  /** chapter, section, subsection, subsubsection. */
  sec: number[],
  chapters: boolean,
  labels: Map<string, Label>,
  /** What the next \label points at. */
  here: Label,
  refs: { el: HTMLElement, key: string, how: string }[],
  cites: { el: HTMLElement, keys: string[] }[],
  bib: string[],
  notes: DocumentFragment[],
  toc: { level: number, num: string, title: string }[],
  tocSlots: HTMLElement[],
  title: string, author: string, date: string | null,
  cls: string,
  /** Bodies of verbatim environments and \verb, taken out before comments are. */
  verb: { text: string, lang: string, caption: string, inline: boolean }[],
  depth: number,
  expansions: number,
  opts: LatexOptions,
  /** The float being read, for its \caption. */
  float: { kind: string, title: string, num: string } | null,
  /** How many enumerates are open, which says whether this one counts 1, a, i or A. */
  enumDepth: number,
};

/** A LaTeX document, or a part of one, as a DocumentFragment. */
export function renderLatex(src: unknown, opts: LatexOptions = {}): DocumentFragment {
  const st: State = {
    macros: {}, text: new Map(), envs: new Map(), theorems: new Map(), counters: new Map(),
    sec: [0, 0, 0, 0], chapters: false, labels: new Map(), here: { num: '', kind: '' },
    refs: [], cites: [], bib: [], notes: [], toc: [], tocSlots: [],
    title: '', author: '', date: null, cls: 'article', verb: [], depth: 0, expansions: 0, opts, float: null,
    enumDepth: 0,
  };
  defaultTheorems(st);
  const text = stripComments(takeVerbatim(String(src ?? '').replace(/\r\n?/g, '\n'), st));
  const begin = text.indexOf('\\begin{document}');
  const end = text.lastIndexOf('\\end{document}');
  const preamble = begin >= 0 ? text.slice(0, begin) : '';
  const body = begin >= 0 ? text.slice(begin + '\\begin{document}'.length, end > begin ? end : undefined) : text;
  readPreamble(preamble, st);
  st.chapters = /^(report|book)$/.test(st.cls) || /\\chapter\b/.test(body);
  const frag = document.createDocumentFragment();
  frag.append(...blocks(body, st));
  finish(frag, st);
  return frag;
}

// ---------------------------------------------------------------------------
// Before reading: verbatim out, comments off
// ---------------------------------------------------------------------------

const VERBATIM = /\\begin\{(verbatim\*?|Verbatim|lstlisting|minted|comment)\}([\s\S]*?)\\end\{\1\}/g;

/**
 * Every verbatim body swapped for a marker, so a `%` or a `}` in a listing is
 * code and not a comment or a closing brace. The markers are a character no
 * LaTeX file has, then a number.
 */
function takeVerbatim(src: string, st: State): string {
  const out = src.replace(VERBATIM, (_m, env: string, raw: string) => {
    let body = raw;
    let lang = '';
    let caption = '';
    if (env === 'minted') {
      const g = readGroup(body, 0);
      if (g) { lang = g[0].trim(); body = body.slice(g[1]); }
    } else if (env === 'lstlisting') {
      const o = readOptional(body, 0);
      if (o) {
        lang = /language\s*=\s*\{?([\w+#-]+)/i.exec(o[0])?.[1] ?? '';
        const cap = /caption\s*=\s*(?:\{([^}]*)\}|([^,\]]*))/i.exec(o[0]);
        caption = cap?.[1] ?? cap?.[2] ?? '';
        body = body.slice(o[1]);
      }
    }
    if (env === 'comment') return '';
    st.verb.push({ text: body.replace(/^\n/, '').replace(/\n\s*$/, ''), lang, caption: caption.trim(), inline: false });
    return `\u0000V${st.verb.length - 1}\u0000`;
  });
  // \verb|x|, \lstinline|x| or {x}, \mintinline{lang}{x}: inline code, same treatment.
  return out.replace(/\\(?:verb\*?|lstinline(?:\[[^\]]*\])?)([^a-zA-Z\s{])([^\n]*?)\1|\\lstinline(?:\[[^\]]*\])?\{([^}\n]*)\}|\\mintinline\{[^}]*\}\{([^}\n]*)\}/g,
    (_m, _d, a, b, c) => {
      st.verb.push({ text: a ?? b ?? c ?? '', lang: '', caption: '', inline: true });
      return `\u0000v${st.verb.length - 1}\u0000`;
    });
}

/** `%` to the end of the line, and the line break with it, as TeX reads one. `\%` is a percent sign. */
function stripComments(src: string): string {
  let out = '';
  for (let i = 0; i < src.length; i++) {
    const c = src[i];
    if (c === '\\') { out += c + (src[i + 1] ?? ''); i++; continue; }
    if (c !== '%') { out += c; continue; }
    const nl = src.indexOf('\n', i);
    if (nl < 0) break;
    // A comment eats its newline; the next line's indent goes too.
    i = nl;
    while (src[i + 1] === ' ' || src[i + 1] === '\t') i++;
  }
  return out;
}

// ---------------------------------------------------------------------------
// Reading pieces
// ---------------------------------------------------------------------------

/** Spaces and newlines from `i`, as between a command and its arguments. */
function skipSpace(s: string, i: number): number {
  while (i < s.length && /\s/.test(s[i])) i++;
  return i;
}

/** A `{…}` group at `i` (past any space): its inside and the index after it. Braces balance; `\{` is not one. */
function readGroup(s: string, at: number): [string, number] | null {
  const i = skipSpace(s, at);
  if (s[i] !== '{') return null;
  let depth = 0;
  for (let j = i; j < s.length; j++) {
    const c = s[j];
    if (c === '\\') { j++; continue; }
    if (c === '{') depth++;
    else if (c === '}' && --depth === 0) return [s.slice(i + 1, j), j + 1];
  }
  return [s.slice(i + 1), s.length];
}

/** A `[…]` option at `i`, its brackets counted outside braces only. */
function readOptional(s: string, at: number): [string, number] | null {
  const i = skipSpace(s, at);
  if (s[i] !== '[') return null;
  let depth = 0;
  let brace = 0;
  for (let j = i; j < s.length; j++) {
    const c = s[j];
    if (c === '\\') { j++; continue; }
    if (c === '{') brace++;
    else if (c === '}') brace--;
    else if (!brace && c === '[') depth++;
    else if (!brace && c === ']' && --depth === 0) return [s.slice(i + 1, j), j + 1];
  }
  return null;
}

/** An argument: a group, or the one token TeX takes without braces (`\frac12`, `\textbf x`). */
function readArg(s: string, at: number): [string, number] {
  const g = readGroup(s, at);
  if (g) return g;
  const i = skipSpace(s, at);
  if (s[i] === '\\') {
    const [name, next] = readName(s, i);
    return ['\\' + name, next];
  }
  return [s[i] ?? '', Math.min(s.length, i + 1)];
}

/** The command at `i` (a backslash): its name - letters, or one other character - and the index after it. */
function readName(s: string, i: number): [string, number] {
  let j = i + 1;
  if (/[a-zA-Z@]/.test(s[j] ?? '')) {
    while (j < s.length && /[a-zA-Z@]/.test(s[j])) j++;
  } else j++;
  return [s.slice(i + 1, j), j];
}

/** Where `\end{name}` closes the environment whose body starts at `from`, counting any of the same nested inside. */
function findEnd(s: string, from: number, name: string): [number, number] | null {
  const open = `\\begin{${name}}`;
  const close = `\\end{${name}}`;
  let depth = 1;
  let i = from;
  while (i < s.length) {
    const b = s.indexOf(open, i);
    const e = s.indexOf(close, i);
    if (e < 0) return null;
    if (b >= 0 && b < e) { depth++; i = b + open.length; continue; }
    if (--depth === 0) return [e, e + close.length];
    i = e + close.length;
  }
  return null;
}

/**
 * `s` cut wherever one of `names` stands at its top level - outside every
 * group and environment - as `\item` divides a list. Each piece keeps the
 * command that opened it; the words before the first are the head.
 */
function splitTop(s: string, names: readonly string[]): { head: string, parts: { name: string, body: string }[] } {
  const parts: { name: string, body: string }[] = [];
  let head = '';
  let cur: { name: string, body: string } | null = null;
  let brace = 0;
  let env = 0;
  let i = 0;
  const add = (t: string) => { if (cur) cur.body += t; else head += t; };
  while (i < s.length) {
    const c = s[i];
    if (c === '{') { brace++; add(c); i++; continue; }
    if (c === '}') { brace--; add(c); i++; continue; }
    if (c !== '\\') { add(c); i++; continue; }
    const [name, next] = readName(s, i);
    if (name === 'begin') env++;
    else if (name === 'end') env--;
    if (!brace && !env && names.includes(name)) {
      cur = { name, body: '' };
      parts.push(cur);
      i = next;
      continue;
    }
    add(s.slice(i, next));
    i = next;
  }
  return { head, parts };
}

/** `s` cut at its top-level `sep` (a `\\` row break, a `&` cell), never inside a group or environment. */
function splitAt(s: string, sep: '\\\\' | '&'): string[] {
  const out: string[] = [];
  let cur = '';
  let brace = 0;
  let env = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (c === '\\') {
      if (sep === '\\\\' && s[i + 1] === '\\' && !brace && !env) {
        out.push(cur);
        cur = '';
        i++;
        // A row break's spacing, `\\[2pt]`, is not the next row's words.
        const o = readOptional(s, i + 1);
        if (o && /^[\s\d.,a-z-]*$/i.test(o[0])) i = o[1] - 1;
        continue;
      }
      const [name, next] = readName(s, i);
      if (name === 'begin') env++;
      else if (name === 'end') env--;
      cur += s.slice(i, next);
      i = next - 1;
      continue;
    }
    if (c === '{') brace++;
    else if (c === '}') brace--;
    if (sep === '&' && c === '&' && !brace && !env) { out.push(cur); cur = ''; continue; }
    cur += c;
  }
  out.push(cur);
  return out;
}

// ---------------------------------------------------------------------------
// The preamble, and definitions anywhere
// ---------------------------------------------------------------------------

/** The theorem names nearly every class handout uses, defined before a preamble can say otherwise. */
function defaultTheorems(st: State) {
  const shared = ['theorem', 'lemma', 'corollary', 'proposition', 'claim', 'conjecture', 'fact', 'observation'];
  for (const name of shared) st.theorems.set(name, { title: cap(name), counter: 'theorem', numbered: true });
  for (const name of ['definition', 'example', 'exercise', 'problem', 'question', 'remark', 'note', 'notation', 'assumption']) {
    st.theorems.set(name, { title: cap(name), counter: name, numbered: true });
  }
  for (const [abbr, full] of [['thm', 'theorem'], ['lem', 'lemma'], ['cor', 'corollary'], ['prop', 'proposition'], ['defn', 'definition'], ['dfn', 'definition'], ['ex', 'example'], ['rem', 'remark']]) {
    st.theorems.set(abbr, { title: cap(full), counter: abbr === 'defn' || abbr === 'dfn' ? 'definition' : full === 'example' || full === 'remark' ? full : 'theorem', numbered: true });
  }
}

const cap = (s: string) => s[0].toUpperCase() + s.slice(1);

/** The class, the title page's words, and every definition. Anything else up there is layout. */
function readPreamble(s: string, st: State) {
  const cls = /\\documentclass(?:\[[^\]]*\])?\{([^}]*)\}/.exec(s);
  if (cls) st.cls = cls[1].trim();
  let i = 0;
  while (i < s.length) {
    const at = s.indexOf('\\', i);
    if (at < 0) break;
    const [name, next] = readName(s, at);
    const done = define(name, s, next, st);
    i = done ?? next;
  }
}

/**
 * A definition or a title-page line at `next` (just past `\name`): recorded,
 * and the index after it, or undefined when `name` is neither. Read the same in
 * the preamble and in the body, since a fragment file has no preamble.
 */
function define(name: string, s: string, next: number, st: State): number | undefined {
  switch (name) {
    case 'title': case 'author': case 'date': {
      const o = readOptional(s, next);
      const g = readGroup(s, o ? o[1] : next);
      if (!g) return undefined;
      if (name === 'title') st.title = g[0];
      else if (name === 'author') st.author = g[0];
      else st.date = g[0];
      return g[1];
    }
    case 'newcommand': case 'renewcommand': case 'providecommand': case 'DeclareRobustCommand': {
      let i = skipSpace(s, next);
      if (s[i] === '*') i++;
      const [macro, after] = readArg(s, i);
      const count = readOptional(s, after);
      const def = count ? readOptional(s, count[1]) : null;
      const body = readGroup(s, (def ?? count)?.[1] ?? after);
      if (!body || !macro.startsWith('\\')) return undefined;
      const n = Math.min(9, Number(count?.[0]) || 0);
      st.macros[macro] = body[0];
      st.text.set(macro.slice(1), { n, opt: def ? def[0] : null, body: body[0] });
      return body[1];
    }
    case 'def': case 'gdef': case 'edef': {
      const i = skipSpace(s, next);
      if (s[i] !== '\\') return undefined;
      const [macro, after] = readName(s, i);
      const params = /^(#\d)*/.exec(s.slice(after))![0];
      const body = readGroup(s, after + params.length);
      if (!body) return undefined;
      st.macros['\\' + macro] = body[0];
      st.text.set(macro, { n: params.length / 2, opt: null, body: body[0] });
      return body[1];
    }
    case 'DeclareMathOperator': {
      let i = skipSpace(s, next);
      const star = s[i] === '*';
      if (star) i++;
      const [macro, after] = readArg(s, i);
      const body = readGroup(s, after);
      if (!body) return undefined;
      st.macros[macro] = `\\operatorname${star ? '*' : ''}{${body[0]}}`;
      return body[1];
    }
    case 'newtheorem': {
      let i = skipSpace(s, next);
      const star = s[i] === '*';
      if (star) i++;
      const env = readGroup(s, i);
      if (!env) return undefined;
      const shared = readOptional(s, env[1]);
      const title = readGroup(s, (shared ?? env)[1]);
      if (!title) return undefined;
      const within = readOptional(s, title[1]);
      const key = env[0].trim();
      st.theorems.set(key, { title: plainText(title[0]), counter: shared ? shared[0].trim() : key, numbered: !star });
      return (within ?? title)[1];
    }
    case 'newenvironment': case 'renewenvironment': {
      const env = readGroup(s, next);
      if (!env) return undefined;
      const count = readOptional(s, env[1]);
      const def = count ? readOptional(s, count[1]) : null;
      const begin = readGroup(s, (def ?? count ?? env)[1]);
      const end = begin ? readGroup(s, begin[1]) : null;
      if (!begin || !end) return undefined;
      st.envs.set(env[0].trim(), { n: Math.min(9, Number(count?.[0]) || 0), begin: begin[0], end: end[0] });
      return end[1];
    }
  }
  return undefined;
}

/** A title's words without their markup, for a theorem's name and the outline. */
function plainText(s: string): string {
  return s.replace(/\\[a-zA-Z@]+\*?/g, '').replace(/[{}$]/g, '').replace(/\s+/g, ' ').trim();
}

// ---------------------------------------------------------------------------
// Blocks
// ---------------------------------------------------------------------------

const SECTIONS: Record<string, number> = {
  part: -1, chapter: 0, section: 1, subsection: 2, subsubsection: 3, paragraph: 4, subparagraph: 5,
};

/** Commands that take their arguments and draw nothing: layout, packages, counters, slides' furniture. */
const DROP: Record<string, number> = {
  usepackage: 1, documentclass: 1, vspace: 1, 'vspace*': 1, hspace: 1, 'hspace*': 1, setlength: 2,
  addtolength: 2, setcounter: 2, addtocounter: 2, stepcounter: 1, refstepcounter: 1, pagestyle: 1,
  thispagestyle: 1, pagenumbering: 1, bibliographystyle: 1, geometry: 1, hypersetup: 1, definecolor: 3,
  colorlet: 2, newcounter: 1, graphicspath: 1, captionsetup: 1, usetheme: 1, usecolortheme: 1,
  usefonttheme: 1, useinnertheme: 1, useoutertheme: 1, setbeamertemplate: 2, setbeamercolor: 2,
  setbeamerfont: 2, logo: 1, titlegraphic: 1, theoremstyle: 1, lstset: 1, setminted: 1,
  firstpageheader: 3, runningheader: 3, firstpagefooter: 3, runningfooter: 3, lhead: 1, chead: 1,
  rhead: 1, lfoot: 1, cfoot: 1, rfoot: 1, fancyhead: 1, fancyfoot: 1, pointpoints: 2, qformat: 1,
  newgeometry: 1, linespread: 1, renewcommand: 2, numberwithin: 2, crefname: 3, Crefname: 3,
  setstretch: 1, input: 1, include: 1, includeonly: 1, algrenewcommand: 2, algnewcommand: 2,
  institute: 1, subtitle: 1, color: 1, bibliography: 1, addbibresource: 1,
};

/** Declarations that change what follows in the group, and the element that carries it. */
const DECLARE: Record<string, string> = {
  bf: 'strong', bfseries: 'strong', it: 'em', itshape: 'em', em: 'em', sl: 'em', slshape: 'em',
  tt: 'code', ttfamily: 'code', sc: 'tex-sc', scshape: 'tex-sc',
};

/** Declarations that change only spacing or size here, so nothing. */
const QUIET = new Set([
  'centering', 'raggedright', 'raggedleft', 'noindent', 'indent', 'par', 'tiny', 'scriptsize', 'footnotesize',
  'small', 'normalsize', 'large', 'Large', 'LARGE', 'huge', 'Huge', 'normalfont', 'rmfamily', 'sffamily',
  'upshape', 'mdseries', 'newpage', 'clearpage', 'cleardoublepage', 'pagebreak', 'nopagebreak', 'smallskip',
  'medskip', 'bigskip', 'vfill', 'hfill', 'protect', 'relax', 'pause', 'printanswers', 'noprintanswers',
  'addpoints', 'pointsinrightmargin', 'bracketedpoints', 'frenchspacing', 'sloppy', 'appendix', 'onehalfspacing',
  'doublespacing', 'singlespacing', 'maketitle@', 'makeatletter', 'makeatother', 'selectfont', 'null',
  'printbibliography', 'listoffigures', 'listoftables', 'frontmatter', 'mainmatter', 'backmatter', 'and',
]);

/**
 * The blocks of a stretch of LaTeX: paragraphs split at blank lines, and every
 * environment, heading and display formula as its own element. Inline words
 * gather into the paragraph around them and are read by inline() at its end.
 */
function blocks(s: string, st: State): HTMLElement[] {
  if (st.depth > MAX_DEPTH) return [paragraphOf(s)];
  st.depth++;
  try {
    return readBlocks(s, st);
  } finally {
    st.depth--;
  }
}

function readBlocks(s: string, st: State): HTMLElement[] {
  const out: HTMLElement[] = [];
  let para = '';
  const flush = () => {
    if (para.trim()) {
      const p = document.createElement('p');
      p.append(inline(para.trim(), st));
      out.push(p);
    }
    para = '';
  };
  let i = 0;
  while (i < s.length) {
    const c = s[i];
    if (c === '\n') {
      let j = i + 1;
      while (j < s.length && (s[j] === ' ' || s[j] === '\t')) j++;
      if (s[j] === '\n') { flush(); i = j; continue; }
      para += '\n';
      i++;
      continue;
    }
    if (c === '\u0000' && s[i + 1] === 'V') {
      const end = s.indexOf('\u0000', i + 2);
      flush();
      out.push(codeBlock(st.verb[Number(s.slice(i + 2, end))], st));
      i = end + 1;
      continue;
    }
    if (c === '$' && s[i + 1] === '$') {
      const end = s.indexOf('$$', i + 2);
      if (end > 0) {
        flush();
        out.push(displayMath(s.slice(i + 2, end), 'displaymath', st));
        i = end + 2;
        continue;
      }
    }
    if (c !== '\\') { para += c; i++; continue; }
    if (s[i + 1] === '[') {
      const end = s.indexOf('\\]', i + 2);
      if (end > 0) {
        flush();
        out.push(displayMath(s.slice(i + 2, end), 'displaymath', st));
        i = end + 2;
        continue;
      }
    }
    const [name, next] = readName(s, i);
    if (name === 'begin') {
      const g = readGroup(s, next);
      const env = g?.[0].trim() ?? '';
      const end = g ? findEnd(s, g[1], env) : null;
      if (g && end) {
        flush();
        out.push(...environment(env, s.slice(g[1], end[0]), st));
        i = end[1];
        continue;
      }
    }
    if (name in SECTIONS) {
      flush();
      const [node, after] = heading(name, s, next, st);
      if (node) out.push(node);
      i = after;
      continue;
    }
    const block = blockCommand(name, s, next, st);
    if (block) {
      flush();
      out.push(...block.nodes);
      i = block.next;
      continue;
    }
    const defined = define(name, s, next, st);
    if (defined !== undefined) { i = defined; continue; }
    para += s.slice(i, next);
    i = next;
  }
  flush();
  return out;
}

/** Past the limit: the words as written, in one paragraph. */
function paragraphOf(s: string): HTMLElement {
  const p = document.createElement('p');
  p.textContent = s;
  return p;
}

/** A heading, numbered as the class would, recorded for \tableofcontents and \label. */
function heading(name: string, s: string, next: number, st: State): [HTMLElement | null, number] {
  let i = skipSpace(s, next);
  const star = s[i] === '*';
  if (star) i++;
  const short = readOptional(s, i);
  const g = readGroup(s, short ? short[1] : i);
  if (!g) return [null, i];
  const level = SECTIONS[name];
  let num = '';
  if (!star && level >= 0 && level <= 3 && (level > 0 || st.chapters)) {
    st.sec[level]++;
    for (let l = level + 1; l < st.sec.length; l++) st.sec[l] = 0;
    num = st.sec.slice(st.chapters ? 0 : 1, level + 1).join('.');
    st.here = { num, kind: level === 0 ? 'Chapter' : 'Section' };
  }
  const tag = level <= 0 ? 'h1' : level === 1 ? 'h2' : level === 2 ? 'h3' : level === 3 ? 'h4' : 'h5';
  const h = document.createElement(tag);
  h.className = 'tex-h';
  if (num) {
    const n = document.createElement('span');
    n.className = 'tex-num';
    n.textContent = num;
    h.append(n);
  }
  h.append(inline(g[0], st));
  if (level >= 0 && level <= 3) st.toc.push({ level, num, title: plainText(g[0]) });
  return [h, g[1]];
}

/** Commands that stand as blocks of their own. Null for any other. */
function blockCommand(name: string, s: string, next: number, st: State): { nodes: HTMLElement[], next: number } | null {
  switch (name) {
    case 'maketitle': case 'titlepage':
      return { nodes: [titleBlock(st)], next };
    case 'tableofcontents': {
      const nav = document.createElement('nav');
      nav.className = 'tex-toc';
      st.tocSlots.push(nav);
      return { nodes: [nav], next };
    }
    case 'caption': {
      const o = readOptional(s, next);
      const g = readGroup(s, o ? o[1] : next);
      if (!g) return null;
      const cap = document.createElement('figcaption');
      cap.className = 'tex-caption';
      if (st.float) {
        const b = document.createElement('strong');
        b.textContent = `${st.float.title}${st.float.num ? ' ' + st.float.num : ''}: `;
        cap.append(b);
      }
      cap.append(inline(g[0], st));
      return { nodes: [cap], next: g[1] };
    }
    case 'frametitle': case 'framesubtitle': {
      const g = readGroup(s, next);
      if (!g) return null;
      const h = document.createElement(name === 'frametitle' ? 'h3' : 'h4');
      h.className = 'tex-frame-title';
      h.append(inline(g[0], st));
      return { nodes: [h], next: g[1] };
    }
    case 'includegraphics': {
      const o = readOptional(s, skipSpace(s, next) + (s[skipSpace(s, next)] === '*' ? 1 : 0));
      const g = readGroup(s, o ? o[1] : next);
      if (!g) return null;
      return { nodes: [picture(g[0].trim(), o?.[0] ?? '', st)], next: g[1] };
    }
    case 'bibliography': case 'addbibresource': {
      const g = readGroup(s, next);
      if (!g) return null;
      if (st.bib.length) return { nodes: [], next: g[1] };
      const p = document.createElement('p');
      p.className = 'tex-note';
      p.textContent = `References come from ${g[0].trim()}${g[0].trim().endsWith('.bib') ? '' : '.bib'}, which is a separate file.`;
      return { nodes: [p], next: g[1] };
    }
    case 'input': case 'include': case 'lstinputlisting': case 'inputminted': {
      const o = readOptional(s, next);
      let g = readGroup(s, o ? o[1] : next);
      if (g && name === 'inputminted') g = readGroup(s, g[1]);
      if (!g) return null;
      const p = document.createElement('p');
      p.className = 'tex-note';
      p.textContent = `${g[0].trim()} is pulled in here from another file.`;
      return { nodes: [p], next: g[1] };
    }
  }
  return null;
}

/** \maketitle: the title, the authors, the date. */
function titleBlock(st: State): HTMLElement {
  const head = document.createElement('header');
  head.className = 'tex-title';
  if (st.title) {
    const h = document.createElement('h1');
    h.append(inline(st.title, st));
    head.append(h);
  }
  if (st.author) {
    const p = document.createElement('p');
    p.className = 'tex-author';
    p.append(inline(st.author.replace(/\\and\b/g, ' · '), st));
    head.append(p);
  }
  const date = st.date ?? '\\today';
  if (date.trim()) {
    const p = document.createElement('p');
    p.className = 'tex-date';
    p.append(inline(date, st));
    head.append(p);
  }
  return head;
}

// ---------------------------------------------------------------------------
// Environments
// ---------------------------------------------------------------------------

const MATH_ENVS = new Set(['equation', 'align', 'gather', 'multline', 'flalign', 'alignat', 'eqnarray', 'displaymath', 'math', 'split']);
const FLOATS: Record<string, string> = { figure: 'Figure', table: 'Table', algorithm: 'Algorithm', listing: 'Listing', wrapfigure: 'Figure', subfigure: 'Figure', wraptable: 'Table' };

function environment(env: string, raw: string, st: State): HTMLElement[] {
  const base = env.replace(/\*$/, '');
  const starred = env.endsWith('*');
  if (MATH_ENVS.has(base)) return [displayMath(raw, env, st)];
  const user = st.envs.get(env);
  if (user) {
    // Its arguments read off the front of the body, then its begin and end around what is left.
    let body = raw;
    const args: string[] = [];
    for (let n = 0; n < user.n; n++) {
      const g = readGroup(body, 0);
      if (!g) break;
      args.push(g[0]);
      body = body.slice(g[1]);
    }
    if (++st.expansions > MAX_EXPANSIONS) return [paragraphOf(raw)];
    return blocks(fill(user.begin, args) + body + fill(user.end, args), st);
  }
  const thm = st.theorems.get(base);
  if (thm) return [theorem(thm, starred, raw, st)];
  switch (base) {
    case 'document': return blocks(raw, st);
    case 'itemize': case 'enumerate': case 'description': case 'compactitem': case 'compactenum':
      return [list(base, raw, st)];
    case 'abstract': {
      const box = boxed('tex-abstract', 'Abstract', blocks(raw, st), st);
      return [box];
    }
    case 'proof': {
      const o = readOptional(raw, 0);
      const box = document.createElement('div');
      box.className = 'tex-proof';
      const head = document.createElement('em');
      head.className = 'tex-proof-head';
      head.append(o ? inline(o[0], st) : document.createTextNode('Proof'), document.createTextNode('. '));
      const kids = blocks(o ? raw.slice(o[1]) : raw, st);
      lead(kids, head);
      box.append(...kids);
      // The square at the end of the last line, as amsthm sets it, or on its own after a display.
      const qed = document.createElement('span');
      qed.className = 'tex-qed';
      qed.textContent = '∎';
      const last = kids[kids.length - 1];
      if (last?.tagName === 'P') last.append(qed);
      else box.append(qed);
      return [box];
    }
    case 'quote': case 'quotation': case 'verse': {
      const q = document.createElement('blockquote');
      q.append(...blocks(raw, st));
      return [q];
    }
    case 'center': case 'flushleft': case 'flushright': {
      const d = document.createElement('div');
      d.className = `tex-${base}`;
      d.append(...blocks(raw, st));
      return [d];
    }
    case 'minipage': case 'column': case 'multicols': case 'adjustbox': case 'landscape': {
      let body = raw;
      const o = readOptional(body, 0);
      if (o) body = body.slice(o[1]);
      if (base !== 'landscape') {
        const g = readGroup(body, 0);
        if (g) body = body.slice(g[1]);
      }
      const d = document.createElement('div');
      d.className = base === 'column' ? 'tex-column' : 'tex-box';
      d.append(...blocks(body, st));
      return [d];
    }
    case 'columns': {
      const d = document.createElement('div');
      d.className = 'tex-columns';
      const o = readOptional(raw, 0);
      d.append(...blocks(o ? raw.slice(o[1]) : raw, st));
      return [d];
    }
    case 'tabular': case 'tabularx': case 'tabulary': case 'longtable': case 'tabu': case 'array': {
      let body = raw;
      const o = readOptional(body, 0);
      if (o) body = body.slice(o[1]);
      if (base === 'tabularx' || base === 'tabulary') {
        const w = readGroup(body, 0);
        if (w) body = body.slice(w[1]);
      }
      const spec = readGroup(body, 0);
      return [tabular(spec?.[0] ?? '', spec ? body.slice(spec[1]) : body, st)];
    }
    case 'thebibliography': {
      const g = readGroup(raw, 0);
      return [bibliography(g ? raw.slice(g[1]) : raw, st)];
    }
    case 'frame': return [frame(raw, st)];
    case 'block': case 'alertblock': case 'exampleblock': {
      const g = readGroup(raw, 0);
      return [boxed(`tex-block tex-${base}`, g?.[0] ?? '', blocks(g ? raw.slice(g[1]) : raw, st), st)];
    }
    case 'algorithmic': case 'algpseudocode': case 'algorithmicx': return [algorithmic(raw, st)];
    case 'questions': return [questions(raw, 'question', st)];
    case 'parts': return [questions(raw, 'part', st)];
    case 'subparts': return [questions(raw, 'subpart', st)];
    case 'choices': case 'oneparchoices': case 'checkboxes': case 'oneparcheckboxes':
      return [choices(raw, st)];
    case 'solution': case 'solutionorbox': case 'solutionorlines': case 'solutionordottedlines': {
      const o = readOptional(raw, 0);
      return [boxed('tex-solution', 'Solution', blocks(o ? raw.slice(o[1]) : raw, st), st)];
    }
    case 'tikzpicture': case 'pgfpicture': case 'circuitikz': case 'forest': {
      // No TikZ here. The drawing's source, folded, so the page says one was there.
      const d = document.createElement('details');
      d.className = 'tex-tikz';
      const sum = document.createElement('summary');
      sum.textContent = 'A TikZ drawing, which this preview does not draw';
      const pre = document.createElement('pre');
      pre.textContent = raw.trim();
      d.append(sum, pre);
      return [d];
    }
  }
  const float = FLOATS[base];
  if (float) return [floatBox(base, float, raw, st)];
  // An environment nobody listed: its insides, read as anything else is.
  return blocks(raw, st);
}

/** A box with a title over blocks: an abstract, a beamer block, an exam's solution. */
function boxed(cls: string, title: string, kids: HTMLElement[], st: State): HTMLElement {
  const d = document.createElement('div');
  d.className = cls;
  if (title) {
    const t = document.createElement('div');
    t.className = 'tex-box-title';
    t.append(inline(title, st));
    d.append(t);
  }
  d.append(...kids);
  return d;
}

/** Run a lead-in (a theorem's head, a proof's "Proof.") into the first paragraph, as LaTeX sets it. */
function lead(kids: HTMLElement[], head: HTMLElement) {
  const first = kids[0];
  if (first?.tagName === 'P') first.prepend(head);
  else kids.unshift(head);
}

function theorem(thm: { title: string, counter: string, numbered: boolean }, starred: boolean, raw: string, st: State): HTMLElement {
  const o = readOptional(raw, 0);
  let num = '';
  if (thm.numbered && !starred) {
    const n = (st.counters.get(thm.counter) ?? 0) + 1;
    st.counters.set(thm.counter, n);
    num = String(n);
    st.here = { num, kind: thm.title };
  }
  const box = document.createElement('div');
  box.className = 'tex-thm';
  box.dataset.kind = thm.title.toLowerCase();
  const head = document.createElement('strong');
  head.className = 'tex-thm-head';
  head.textContent = `${thm.title}${num ? ' ' + num : ''}`;
  const parts: Node[] = [head];
  if (o) {
    const note = document.createElement('span');
    note.append(document.createTextNode(' ('), inline(o[0], st), document.createTextNode(')'));
    parts.push(note);
  }
  parts.push(document.createTextNode('. '));
  const lead0 = document.createElement('span');
  lead0.append(...parts);
  const kids = blocks(o ? raw.slice(o[1]) : raw, st);
  lead(kids, lead0);
  box.append(...kids);
  return box;
}

const ENUM_TYPES = ['1', 'a', 'i', 'A'];

/** \item lists. An enumerate numbers 1, a, i, A by depth, as LaTeX does, and an item's \label reads its number. */
function list(kind: string, raw: string, st: State): HTMLElement {
  const o = readOptional(raw, 0);
  const { parts } = splitTop(o ? raw.slice(o[1]) : raw, ['item']);
  if (kind === 'description') {
    const dl = document.createElement('dl');
    dl.className = 'tex-desc';
    for (const part of parts) {
      const label = readOptional(part.body, 0);
      const dt = document.createElement('dt');
      if (label) dt.append(inline(label[0], st));
      const dd = document.createElement('dd');
      dd.append(...blocks(label ? part.body.slice(label[1]) : part.body, st));
      dl.append(dt, dd);
    }
    return dl;
  }
  const ordered = kind === 'enumerate' || kind === 'compactenum';
  const el = document.createElement(ordered ? 'ol' : 'ul');
  const level = Math.min(3, st.enumDepth);
  if (ordered) {
    // SAFETY: `ordered` chose <ol> above, so inside this branch the list is one.
    (el as HTMLOListElement).type = ENUM_TYPES[level];
    st.enumDepth++;
  }
  try {
    readItems(parts, ordered, level, el, st);
  } finally {
    if (ordered) st.enumDepth--;
  }
  return el;
}

function readItems(parts: { body: string }[], ordered: boolean, level: number, el: HTMLElement, st: State) {
  let n = 0;
  for (const part of parts) {
    const li = document.createElement('li');
    const label = readOptional(part.body, 0);
    if (ordered) {
      n++;
      st.here = { num: enumLabel(n, ENUM_TYPES[level]), kind: 'item' };
    }
    const kids = blocks(label ? part.body.slice(label[1]) : part.body, st);
    if (label) {
      // `\item[(i)]`: its own mark in place of the list's.
      li.className = 'tex-labelled';
      const mark = document.createElement('span');
      mark.className = 'tex-item-label';
      mark.append(inline(label[0], st));
      lead(kids, mark);
    }
    li.append(...kids);
    el.append(li);
  }
}

/** An item's number as its list shows it: 3, c, iii or C. */
function enumLabel(n: number, type: string): string {
  if (type === 'a' || type === 'A') {
    const s = String.fromCharCode(96 + ((n - 1) % 26) + 1);
    return type === 'A' ? s.toUpperCase() : s;
  }
  if (type === 'i') return roman(n);
  return String(n);
}

function roman(n: number): string {
  const steps: [number, string][] = [[1000, 'm'], [900, 'cm'], [500, 'd'], [400, 'cd'], [100, 'c'], [90, 'xc'], [50, 'l'], [40, 'xl'], [10, 'x'], [9, 'ix'], [5, 'v'], [4, 'iv'], [1, 'i']];
  let out = '';
  for (const [v, s] of steps) while (n >= v) { out += s; n -= v; }
  return out;
}

/** A figure, table or algorithm: numbered before its insides are read, so a \label in there reads its number. */
function floatBox(base: string, title: string, raw: string, st: State): HTMLElement {
  let body = raw;
  const o = readOptional(body, 0);
  if (o) body = body.slice(o[1]);
  if (base === 'wrapfigure' || base === 'wraptable' || base === 'subfigure') {
    const g = readGroup(body, 0);
    if (g) body = body.slice(g[1]);
    if (base !== 'subfigure') {
      const w = readGroup(body, 0);
      if (w) body = body.slice(w[1]);
    }
  }
  const counter = base === 'wrapfigure' || base === 'subfigure' ? 'figure' : base === 'wraptable' ? 'table' : base;
  const n = (st.counters.get(counter) ?? 0) + 1;
  st.counters.set(counter, n);
  const was = st.float;
  st.float = { kind: counter, title, num: String(n) };
  st.here = { num: String(n), kind: title };
  const fig = document.createElement('figure');
  fig.className = `tex-float tex-${counter}`;
  try {
    fig.append(...blocks(body, st));
  } finally {
    st.float = was;
  }
  return fig;
}

// ---------------------------------------------------------------------------
// Math
// ---------------------------------------------------------------------------

/**
 * A display formula. Numbered environments get their numbers here, from this
 * document's own count, as a `\tag` on each row - KaTeX's own numbering is a
 * CSS counter across the whole page, which would count the Markdown beside
 * it too. A `\label` comes out (KaTeX has none) and points at its row.
 */
function displayMath(raw: string, env: string, st: State): HTMLElement {
  const base = env.replace(/\*$/, '');
  const numbered = !env.endsWith('*') && base !== 'displaymath' && base !== 'math' && base !== 'split';
  let args = '';
  let body = raw;
  if (base === 'alignat') {
    const g = readGroup(body, 0);
    if (g) { args = `{${g[0]}}`; body = body.slice(g[1]); }
  }
  const multi = base !== 'equation' && base !== 'displaymath' && base !== 'math';
  const rows = multi ? splitAt(body, '\\\\') : [body];
  const tagged = rows.map(row => {
    let r = row;
    const labels: string[] = [];
    r = r.replace(/\\label\s*\{([^}]*)\}/g, (_m, k: string) => { labels.push(k.trim()); return ''; });
    const off = /\\(nonumber|notag)\b/.test(r) || !r.trim();
    r = r.replace(/\\(nonumber|notag)\b/g, '');
    const own = /\\tag\*?\s*\{([^}]*)\}/.exec(r);
    let num = own ? own[1] : '';
    if (numbered && !off && !own) {
      const n = (st.counters.get('equation') ?? 0) + 1;
      st.counters.set('equation', n);
      num = String(n);
      r += `\\tag{${n}}`;
    }
    for (const k of labels) st.labels.set(k, { num, kind: 'Equation' });
    return r;
  });
  const inner = tagged.join('\\\\');
  // KaTeX's names for the same layouts, and starred, so it adds no numbers of its own.
  const tex = !multi ? inner
    : base === 'multline' ? `\\begin{gather*}${inner}\\end{gather*}`
      : base === 'eqnarray' ? `\\begin{align*}${inner.replace(/&([^&]*)&/g, '&$1')}\\end{align*}`
        : base === 'flalign' ? `\\begin{align*}${inner}\\end{align*}`
          : base === 'split' ? `\\begin{aligned}${inner}\\end{aligned}`
            : `\\begin{${base}*}${args}${inner}\\end{${base}*}`;
  const el = document.createElement('div');
  el.className = 'tex-math tex-display';
  el.textContent = raw.trim();
  typeset(el, tex, true, st.macros);
  return el;
}

function inlineMath(tex: string, st: State): HTMLElement {
  const el = document.createElement('span');
  el.className = 'tex-math';
  const clean = tex.replace(/\\label\s*\{[^}]*\}/g, '');
  el.textContent = clean;
  typeset(el, clean, false, st.macros);
  return el;
}

// ---------------------------------------------------------------------------
// Code, pseudocode, tables, pictures
// ---------------------------------------------------------------------------

function codeBlock(v: { text: string, lang: string, caption: string } | undefined, st: State): HTMLElement {
  const pre = document.createElement('pre');
  pre.className = 'tex-code';
  const code = document.createElement('code');
  code.textContent = v?.text ?? '';
  if (v?.lang) code.dataset.lang = v.lang;
  pre.append(code);
  if (!v?.caption) return pre;
  const n = (st.counters.get('listing') ?? 0) + 1;
  st.counters.set('listing', n);
  const fig = document.createElement('figure');
  fig.className = 'tex-float tex-listing';
  const cap = document.createElement('figcaption');
  cap.className = 'tex-caption';
  const b = document.createElement('strong');
  b.textContent = `Listing ${n}: `;
  cap.append(b, inline(v.caption, st));
  fig.append(cap, pre);
  return fig;
}

/** The line commands of algorithmic and algpseudocode, both spellings lower-cased. */
const ALGO = new Set([
  'state', 'statex', 'if', 'elsif', 'elseif', 'else', 'endif', 'for', 'forall', 'endfor', 'while', 'endwhile',
  'repeat', 'until', 'loop', 'endloop', 'function', 'endfunction', 'procedure', 'endprocedure', 'require',
  'ensure', 'input', 'output', 'return', 'print',
]);

/**
 * Pseudocode, one line per command, indented as its blocks nest: `\If{c}` is
 * "if c then" and what follows goes in a step. `[1]` after the environment
 * numbers every line, as the package does.
 */
function algorithmic(raw: string, st: State): HTMLElement {
  const o = readOptional(raw, 0);
  const numberEvery = o ? Number(o[0]) || 0 : 0;
  const body = o ? raw.slice(o[1]) : raw;
  const names: string[] = [];
  // Both packages' spellings: \If and \IF. Except \Return, which algpseudocode
  // writes inside a line (`\State \Return x`); algorithmic's \RETURN is one.
  for (const m of body.matchAll(/\\([a-zA-Z]+)/g)) {
    if (ALGO.has(m[1].toLowerCase()) && m[1] !== 'Return' && !names.includes(m[1])) names.push(m[1]);
  }
  const { parts } = splitTop(body, names);
  const box = document.createElement('div');
  box.className = 'tex-algo';
  let depth = 0;
  let n = 0;
  const line =(indent: number, ...nodes: Node[]) => {
    const row = document.createElement('div');
    row.className = 'tex-algo-line';
    n++;
    if (numberEvery) {
      const num = document.createElement('span');
      num.className = 'tex-algo-num';
      num.textContent = n % numberEvery === 0 ? `${n}:` : '';
      row.append(num);
    }
    // The words in a box of their own, so the number column stays put while they indent.
    const body = document.createElement('span');
    body.className = 'tex-algo-body';
    body.style.setProperty('--indent', String(Math.max(0, indent)));
    body.append(...nodes);
    row.append(body);
    box.append(row);
  };
  const kw = (word: string) => {
    const b = document.createElement('strong');
    b.textContent = word;
    return b;
  };
  const words = (s: string) => inline(s.trim(), st);
  const sp = () => document.createTextNode(' ');
  for (const { name, body: rest } of parts) {
    const key = name.toLowerCase();
    // An argument, if the command takes one, and the words after it on the line.
    const arg = () => {
      const g = readGroup(rest, 0);
      return g ? [g[0], rest.slice(g[1])] as const : ['', rest] as const;
    };
    switch (key) {
      case 'state': case 'statex': line(depth, words(rest)); break;
      case 'return': line(depth, kw('return'), sp(), words(rest)); break;
      case 'print': line(depth, kw('print'), sp(), words(rest)); break;
      case 'require': case 'input': line(depth, kw(key === 'input' ? 'Input:' : 'Require:'), sp(), words(rest)); break;
      case 'ensure': case 'output': line(depth, kw(key === 'output' ? 'Output:' : 'Ensure:'), sp(), words(rest)); break;
      case 'if': { const [c, r] = arg(); line(depth, kw('if'), sp(), words(c), sp(), kw('then'), sp(), words(r)); depth++; break; }
      case 'elsif': case 'elseif': { const [c, r] = arg(); depth--; line(depth, kw('else if'), sp(), words(c), sp(), kw('then'), sp(), words(r)); depth++; break; }
      case 'else': depth--; line(depth, kw('else'), sp(), words(rest)); depth++; break;
      case 'for': case 'forall': { const [c, r] = arg(); line(depth, kw(key === 'forall' ? 'for all' : 'for'), sp(), words(c), sp(), kw('do'), sp(), words(r)); depth++; break; }
      case 'while': { const [c, r] = arg(); line(depth, kw('while'), sp(), words(c), sp(), kw('do'), sp(), words(r)); depth++; break; }
      case 'loop': line(depth, kw('loop'), sp(), words(rest)); depth++; break;
      case 'repeat': line(depth, kw('repeat'), sp(), words(rest)); depth++; break;
      case 'until': { const [c, r] = arg(); depth--; line(depth, kw('until'), sp(), words(c), sp(), words(r)); break; }
      case 'function': case 'procedure': {
        const [fn, r1] = arg();
        const g = readGroup(r1, 0);
        const sc = document.createElement('span');
        sc.className = 'tex-sc';
        sc.append(inline(fn, st));
        line(depth, kw(key), sp(), sc, document.createTextNode('('), words(g?.[0] ?? ''), document.createTextNode(')'), sp(), words(g ? r1.slice(g[1]) : r1));
        depth++;
        break;
      }
      default: {
        // \EndIf, \EndFor, \ENDWHILE and the rest: a step back out, and the end said.
        depth--;
        line(depth, kw('end ' + key.replace(/^end/, '')), sp(), words(rest));
      }
    }
  }
  return box;
}

/** A tabular: columns aligned as its spec says, rules where \hline and its kin fall, \multicolumn spanning. */
function tabular(spec: string, body: string, st: State): HTMLElement {
  const aligns = columns(spec);
  const table = document.createElement('table');
  table.className = 'tex-table';
  if (spec.includes('|')) table.classList.add('is-ruled');
  const tbody = document.createElement('tbody');
  let ruleAbove = false;
  let last: HTMLTableRowElement | null = null;
  for (const rawRow of splitAt(body, '\\\\')) {
    let row = rawRow;
    // Rules at the front of a row belong above it.
    for (;;) {
      const m = /^\s*\\(hline|toprule|midrule|bottomrule|cline\s*\{[^}]*\}|cmidrule(?:\([^)]*\))?\s*\{[^}]*\}|specialrule\s*\{[^}]*\}\s*\{[^}]*\}\s*\{[^}]*\})/.exec(row);
      if (!m) break;
      ruleAbove = true;
      row = row.slice(m[0].length);
    }
    if (!row.trim()) {
      // A row of only a rule is the rule under the last one.
      if (ruleAbove && last) last.classList.add('rule-below');
      ruleAbove = false;
      continue;
    }
    const tr = document.createElement('tr');
    if (ruleAbove) tr.classList.add('rule-above');
    ruleAbove = false;
    let col = 0;
    for (const cellRaw of splitAt(row, '&')) {
      const td = document.createElement('td');
      let cell = cellRaw.trim();
      const multi = /^\\multicolumn\s*\{(\d+)\}/.exec(cell);
      if (multi) {
        const spanSpec = readGroup(cell, multi[0].length);
        const content = spanSpec ? readGroup(cell, spanSpec[1]) : null;
        td.colSpan = Number(multi[1]);
        td.style.textAlign = columns(spanSpec?.[0] ?? 'l')[0] ?? 'left';
        cell = content?.[0] ?? '';
      } else {
        const multirow = /^\\multirow\s*\{(\d+)\}\s*\{[^}]*\}/.exec(cell);
        if (multirow) {
          const content = readGroup(cell, multirow[0].length);
          td.rowSpan = Number(multirow[1]);
          cell = content?.[0] ?? '';
        }
        td.style.textAlign = aligns[col] ?? 'left';
      }
      td.append(inline(cell, st));
      tr.append(td);
      col += td.colSpan || 1;
    }
    tbody.append(tr);
    last = tr;
  }
  table.append(tbody);
  return table;
}

/** A column spec as one alignment per column: `l`, `c`, `r`, and `p{…}` and its kin as left. */
function columns(spec: string): string[] {
  const out: string[] = [];
  for (let i = 0; i < spec.length; i++) {
    const c = spec[i];
    if (c === '@' || c === '>' || c === '<' || c === '!') {
      const g = readGroup(spec, i + 1);
      if (g) i = g[1] - 1;
      continue;
    }
    if (c === '*') {
      // `*{3}{c}` - three of the same.
      const count = readGroup(spec, i + 1);
      const what = count ? readGroup(spec, count[1]) : null;
      if (count && what) {
        const n = Math.min(64, Number(count[0]) || 0);
        for (let k = 0; k < n; k++) out.push(...columns(what[0]));
        i = what[1] - 1;
      }
      continue;
    }
    if (c === 'l') out.push('left');
    else if (c === 'c') out.push('center');
    else if (c === 'r') out.push('right');
    else if (c === 'p' || c === 'm' || c === 'b' || c === 'X' || c === 'L' || c === 'C' || c === 'R') {
      out.push(c === 'C' ? 'center' : c === 'R' ? 'right' : 'left');
      const g = readGroup(spec, i + 1);
      if (g && c !== 'X') i = g[1] - 1;
    }
  }
  return out;
}

/** \includegraphics: the picture of that name on this board if there is one, else its name, set apart. */
function picture(name: string, options: string, st: State): HTMLElement {
  const url = st.opts.picture?.(name) ?? null;
  if (!url) {
    const span = document.createElement('span');
    span.className = 'md-image';
    span.textContent = name;
    return span;
  }
  const img = document.createElement('img');
  img.className = 'tex-img';
  img.alt = name;
  img.src = url;
  // `width=0.5\textwidth` as half the page; a size in units is left to the page.
  const w = /width\s*=\s*([\d.]+)\s*\\(text|line|column)width/.exec(options);
  if (w) img.style.width = `${Math.min(100, Number(w[1]) * 100)}%`;
  return img;
}

// ---------------------------------------------------------------------------
// Slides, exams, references
// ---------------------------------------------------------------------------

/** A beamer frame: its title from `{…}` or \frametitle, and its insides, as one slide. */
function frame(raw: string, st: State): HTMLElement {
  let body = raw;
  const o = readOptional(body, 0);
  if (o) body = body.slice(o[1]);
  const sec = document.createElement('section');
  sec.className = 'tex-frame';
  const title = /^\s*\{/.test(body) ? readGroup(body, 0) : null;
  if (title) {
    body = body.slice(title[1]);
    const h = document.createElement('h3');
    h.className = 'tex-frame-title';
    h.append(inline(title[0], st));
    sec.append(h);
    const sub = /^\s*\{/.test(body) ? readGroup(body, 0) : null;
    if (sub) {
      body = body.slice(sub[1]);
      const h4 = document.createElement('h4');
      h4.className = 'tex-frame-title';
      h4.append(inline(sub[0], st));
      sec.append(h4);
    }
  }
  sec.append(...blocks(body, st));
  return sec;
}

/** The exam class's questions, parts and subparts, each with its points if it says. */
function questions(raw: string, name: string, st: State): HTMLElement {
  const { parts } = splitTop(raw, [name, 'titledquestion']);
  const ol = document.createElement('ol');
  ol.className = `tex-questions tex-${name}s`;
  if (name === 'part') ol.type = 'a';
  if (name === 'subpart') ol.type = 'i';
  for (const part of parts) {
    const li = document.createElement('li');
    let body = part.body;
    // The title and the points, run into the question's first paragraph.
    const head = document.createElement('span');
    if (part.name === 'titledquestion') {
      const t = readGroup(body, 0);
      if (t) {
        body = body.slice(t[1]);
        const b = document.createElement('strong');
        b.append(inline(t[0], st));
        head.append(b, document.createTextNode(' '));
      }
    }
    const pts = readOptional(body, 0);
    if (pts) {
      body = body.slice(pts[1]);
      const p = document.createElement('span');
      p.className = 'tex-points';
      p.textContent = `(${pts[0].trim()} ${Number(pts[0]) === 1 ? 'point' : 'points'})`;
      head.append(p, document.createTextNode(' '));
    }
    const kids = blocks(body, st);
    if (head.childNodes.length) lead(kids, head);
    li.append(...kids);
    ol.append(li);
  }
  return ol;
}

/** Multiple choice: each \choice, and \CorrectChoice marked, as the exam class prints answers. */
function choices(raw: string, st: State): HTMLElement {
  const { parts } = splitTop(raw, ['choice', 'CorrectChoice', 'correctchoice']);
  const ul = document.createElement('ul');
  ul.className = 'tex-choices';
  for (const part of parts) {
    const li = document.createElement('li');
    if (part.name !== 'choice') li.className = 'is-correct';
    li.append(inline(part.body.trim(), st));
    ul.append(li);
  }
  return ul;
}

/** thebibliography: numbered in the order written, which is the order \cite counts by. */
function bibliography(raw: string, st: State): HTMLElement {
  const sec = document.createElement('section');
  sec.className = 'tex-bib';
  const h = document.createElement('h2');
  h.className = 'tex-h';
  h.textContent = 'References';
  sec.append(h);
  const ol = document.createElement('ol');
  for (const part of splitTop(raw, ['bibitem']).parts) {
    const o = readOptional(part.body, 0);
    const key = readGroup(part.body, o ? o[1] : 0);
    if (!key) continue;
    st.bib.push(key[0].trim());
    const li = document.createElement('li');
    li.append(inline(part.body.slice(key[1]).trim(), st));
    ol.append(li);
  }
  sec.append(ol);
  return sec;
}

// ---------------------------------------------------------------------------
// Inline
// ---------------------------------------------------------------------------

const SYMBOLS: Record<string, string> = {
  LaTeX: 'LaTeX', TeX: 'TeX', LaTeXe: 'LaTeX2ε', ldots: '…', dots: '…', textellipsis: '…', textbackslash: '\\',
  textasciitilde: '~', textasciicircum: '^', textbar: '|', textless: '<', textgreater: '>', textendash: '–',
  textemdash: '—', textquoteleft: '‘', textquoteright: '’', textquotedblleft: '“', textquotedblright: '”',
  S: '§', P: '¶', dag: '†', ddag: '‡', copyright: '©', textcopyright: '©', textregistered: '®',
  texttrademark: '™', pounds: '£', euro: '€', textdegree: '°', textbullet: '•', checkmark: '✓', ss: 'ß',
  ae: 'æ', AE: 'Æ', oe: 'œ', OE: 'Œ', o: 'ø', O: 'Ø', aa: 'å', AA: 'Å', l: 'ł', L: 'Ł', i: 'ı', j: 'ȷ',
  quad: ' ', qquad: '  ', enspace: ' ', thinspace: ' ',
  textunderscore: '_', textdollar: '$', ' ': ' ', ',': ' ', ';': ' ', ':': ' ', '!': '',
  '-': '', '/': '', '@': '', '&': '&', '%': '%', '$': '$', '#': '#', '_': '_', '{': '{', '}': '}', '|': '‖',
};

/** Accents as the combining mark each one adds to the letter after it. */
const ACCENTS: Record<string, string> = {
  "'": '́', '`': '̀', '^': '̂', '"': '̈', '~': '̃', '=': '̄', '.': '̇',
  c: '̧', v: '̌', u: '̆', H: '̋', k: '̨', r: '̊', b: '̱', d: '̣',
};

/** Commands that wrap their argument in an element, and which. */
const WRAP: Record<string, string> = {
  textbf: 'strong', textit: 'em', emph: 'em', textsl: 'em', texttt: 'code', underline: 'u', uline: 'u',
  textsuperscript: 'sup', textsubscript: 'sub', sout: 's', st: 's', textsc: 'tex-sc', alert: 'tex-alert',
  textup: '', textmd: '', textrm: '', textsf: '', textnormal: '', mbox: '', text: '', hbox: '', makebox: '',
  fbox: 'tex-fbox', framebox: 'tex-fbox', textcolor: '', colorbox: '', fcolorbox: '', hl: 'mark',
  highlight: 'mark', textmu: '', boldsymbol: 'strong', Call: '', only: '', uncover: '', visible: '', onslide: '',
  enquote: '', mintinline: 'code', thanks: '',
};

/** Inline LaTeX as a DocumentFragment: words, marks, math, references, notes. */
function inline(s: string, st: State): DocumentFragment {
  const frag = document.createDocumentFragment();
  if (st.depth > MAX_DEPTH) { frag.append(document.createTextNode(s)); return frag; }
  st.depth++;
  try {
    readInline(s, st, frag);
  } finally {
    st.depth--;
  }
  return frag;
}

function readInline(s: string, st: State, into: Node) {
  let text = '';
  const flush = () => {
    if (text) into.appendChild(words(text));
    text = '';
  };
  const put = (n: Node) => { flush(); into.appendChild(n); };
  let i = 0;
  while (i < s.length) {
    const c = s[i];
    if (c === '\u0000' && s[i + 1] === 'v') {
      const end = s.indexOf('\u0000', i + 2);
      const code = document.createElement('code');
      code.textContent = st.verb[Number(s.slice(i + 2, end))]?.text ?? '';
      put(code);
      i = end + 1;
      continue;
    }
    if (c === '$') {
      const display = s[i + 1] === '$';
      const from = i + (display ? 2 : 1);
      const end = closingDollar(s, from, display);
      if (end > 0) {
        put(display ? displayMath(s.slice(from, end), 'displaymath', st) : inlineMath(s.slice(from, end), st));
        i = end + (display ? 2 : 1);
        continue;
      }
    }
    if (c === '{') {
      const g = readGroup(s, i);
      if (g) {
        flush();
        readInline(g[0], st, into);
        i = g[1];
        continue;
      }
    }
    if (c === '}') { i++; continue; }
    if (c === '~') { text += ' '; i++; continue; }
    if (c !== '\\') { text += c; i++; continue; }
    if (s[i + 1] === '(') {
      const end = s.indexOf('\\)', i + 2);
      if (end > 0) { put(inlineMath(s.slice(i + 2, end), st)); i = end + 2; continue; }
    }
    if (s[i + 1] === '[') {
      const end = s.indexOf('\\]', i + 2);
      if (end > 0) { put(displayMath(s.slice(i + 2, end), 'displaymath', st)); i = end + 2; continue; }
    }
    if (s[i + 1] === '\\') {
      // A line break, with its spacing `[2pt]` and star dropped.
      put(document.createElement('br'));
      let j = i + 2;
      if (s[j] === '*') j++;
      const o = readOptional(s, j);
      i = o && /^[\s\d.,a-z-]*$/i.test(o[0]) ? o[1] : j;
      continue;
    }
    const [name, next] = readName(s, i);
    const done = command(name, s, next, st, put, rest => {
      // A declaration: everything after it in this group, in its element.
      const el = elementFor(DECLARE[name]);
      readInline(rest, st, el);
      put(el);
    });
    if (done === null) { text += s.slice(i, next); i = next; continue; }
    i = done;
  }
  flush();
}

/** The `$` that closes the formula opened before `from`, or -1. An escaped `\$` is a dollar inside it. */
function closingDollar(s: string, from: number, display: boolean): number {
  for (let j = from; j < s.length; j++) {
    if (s[j] === '\\') { j++; continue; }
    if (s[j] !== '$') continue;
    if (!display) return j;
    if (s[j + 1] === '$') return j;
  }
  return -1;
}

/** Words as a text node, set as TeX sets them: ``quotes'', dashes, one space for any run of it. */
function words(t: string): Node {
  const out = t
    .replace(/---/g, '—').replace(/--/g, '–')
    .replace(/``/g, '“').replace(/''/g, '”').replace(/`/g, '‘').replace(/'/g, '’')
    .replace(/[ \t]*\n[ \t]*/g, ' ')
    .replace(/ {2,}/g, ' ');
  return document.createTextNode(out);
}

/** An element for a mark: a tag, or a span with a class when the name starts `tex-`. */
function elementFor(kind: string | undefined): HTMLElement {
  if (!kind) return document.createElement('span');
  if (kind.startsWith('tex-')) {
    const el = document.createElement('span');
    el.className = kind;
    return el;
  }
  return document.createElement(kind);
}

/**
 * One inline command at `next` (just past its name): the index after it,
 * having drawn what it means through `put`, or null to show it as written.
 */
function command(
  name: string, s: string, next: number, st: State,
  put: (n: Node) => void, declare: (rest: string) => void,
): number | null {
  const user = st.text.get(name);
  if (user) return expand(user, s, next, st, put);
  if (name in ACCENTS && (name.length === 1 || /^[\s{]/.test(s[next] ?? ''))) {
    const [arg, after] = readArg(s, next);
    const letter = arg === '\\i' ? 'i' : arg === '\\j' ? 'j' : arg;
    put(document.createTextNode((letter.slice(0, 1) + ACCENTS[name] + letter.slice(1)).normalize('NFC')));
    return after;
  }
  if (name in SYMBOLS) {
    // A word command eats the space after it, as TeX does - which is why people write `\LaTeX{} is`.
    let j = next;
    if (/^[a-zA-Z]/.test(name)) j = s.slice(j, j + 2) === '{}' ? j + 2 : skipInlineSpace(s, j);
    put(document.createTextNode(SYMBOLS[name]));
    return j;
  }
  if (name in DECLARE) {
    declare(s.slice(next));
    return s.length;
  }
  if (QUIET.has(name)) return /[a-zA-Z]/.test(name) ? skipInlineSpace(s, next) : next;
  if (name in DROP) {
    let j = next;
    if (s[skipSpace(s, j)] === '*') j = skipSpace(s, j) + 1;
    for (let k = 0; k < DROP[name]; k++) {
      const o = readOptional(s, j);
      if (o) j = o[1];
      const g = readGroup(s, j);
      if (!g) break;
      j = g[1];
    }
    return j;
  }
  switch (name) {
    case 'today': put(document.createTextNode(st.opts.today ?? new Date().toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric' }))); return skipSpace(s, next);
    case 'newline': case 'linebreak': put(document.createElement('br')); return skipSpace(s, next);
    case 'label': {
      // Points at whatever was numbered last: the section, item, theorem or float it sits in.
      const g = readGroup(s, next);
      if (!g) return null;
      st.labels.set(g[0].trim(), { ...st.here });
      return g[1];
    }
    case 'footnote': {
      const o = readOptional(s, next);
      const g = readGroup(s, o ? o[1] : next);
      if (!g) return null;
      const note = document.createDocumentFragment();
      note.append(inline(g[0], st));
      st.notes.push(note);
      const sup = document.createElement('sup');
      sup.className = 'tex-fnref';
      sup.textContent = String(st.notes.length);
      put(sup);
      return g[1];
    }
    case 'url': case 'href': {
      const u = readGroup(s, next);
      if (!u) return null;
      const label = name === 'href' ? readGroup(s, u[1]) : null;
      put(anchor(u[0].trim(), label ? inline(label[0], st) : document.createTextNode(u[0].trim())));
      return (label ?? u)[1];
    }
    case 'cite': case 'citep': case 'citet': case 'parencite': case 'textcite': case 'autocite': case 'nocite': {
      let j = next;
      if (s[skipSpace(s, j)] === '*') j = skipSpace(s, j) + 1;
      const o1 = readOptional(s, j);
      const o2 = o1 ? readOptional(s, o1[1]) : null;
      const g = readGroup(s, (o2 ?? o1)?.[1] ?? j);
      if (!g) return null;
      if (name === 'nocite') return g[1];
      const span = document.createElement('span');
      span.className = 'tex-cite';
      st.cites.push({ el: span, keys: g[0].split(',').map(k => k.trim()).filter(Boolean) });
      put(span);
      const note = (o2 ?? o1)?.[0];
      if (note) span.dataset.note = note;
      return g[1];
    }
    case 'ref': case 'eqref': case 'autoref': case 'cref': case 'Cref': case 'pageref': case 'nameref': case 'vref': {
      const g = readGroup(s, next);
      if (!g) return null;
      const span = document.createElement('span');
      span.className = 'tex-ref';
      span.textContent = '??';
      st.refs.push({ el: span, key: g[0].split(',')[0].trim(), how: name });
      put(span);
      return g[1];
    }
    case 'includegraphics': {
      let j = skipSpace(s, next);
      if (s[j] === '*') j++;
      const o = readOptional(s, j);
      const g = readGroup(s, o ? o[1] : j);
      if (!g) return null;
      put(picture(g[0].trim(), o?.[0] ?? '', st));
      return g[1];
    }
    case 'item': case 'question': case 'part': case 'choice': {
      const o = readOptional(s, next);
      return o ? o[1] : next;
    }
    case 'Return': case 'RETURN': {
      const b = document.createElement('strong');
      b.textContent = 'return';
      put(b);
      return next;
    }
    case 'Comment': case 'COMMENT': {
      const g = readGroup(s, next);
      if (!g) return null;
      const span = document.createElement('span');
      span.className = 'tex-algo-comment';
      span.append(document.createTextNode('▷ '), inline(g[0], st));
      put(span);
      return g[1];
    }
    case 'Call': {
      const fn = readGroup(s, next);
      const args = fn ? readGroup(s, fn[1]) : null;
      if (!fn) return null;
      const sc = document.createElement('span');
      sc.className = 'tex-sc';
      sc.append(inline(fn[0], st));
      put(sc);
      put(document.createTextNode('('));
      if (args) put(inline(args[0], st));
      put(document.createTextNode(')'));
      return (args ?? fn)[1];
    }
    case 'textcolor': case 'colorbox': {
      const o = readOptional(s, next);
      const colour = readGroup(s, o ? o[1] : next);
      const body = colour ? readGroup(s, colour[1]) : null;
      if (!colour || !body) return null;
      const span = document.createElement('span');
      // A named colour only: a model's numbers (`[rgb]{1,0,0}`) are left to the words.
      if (!o && /^[a-zA-Z]+$/.test(colour[0].trim())) {
        if (name === 'textcolor') span.style.color = colour[0].trim();
        else span.style.backgroundColor = colour[0].trim();
      }
      span.append(inline(body[0], st));
      put(span);
      return body[1];
    }
    case 'verb': return null;
  }
  if (name in WRAP) {
    // Their arguments, wrapped: \textbf{x}, \only<2>{x}, \makebox[2cm]{x}, \fcolorbox{a}{b}{x}.
    let j = next;
    if (s[j] === '<') { const close = s.indexOf('>', j); if (close > 0) j = close + 1; }
    const o = readOptional(s, j);
    if (o) j = o[1];
    const extra = name === 'fcolorbox' ? 2 : name === 'colorbox' ? 1 : 0;
    for (let k = 0; k < extra; k++) { const g = readGroup(s, j); if (g) j = g[1]; }
    const [arg, after] = readArg(s, j);
    const el = elementFor(WRAP[name]);
    el.append(inline(arg, st));
    put(el);
    return after;
  }
  if (name === 'begin' || name === 'end') {
    // An environment inside a line - a tabular in a sentence, say - read whole.
    const g = readGroup(s, next);
    if (!g) return null;
    if (name === 'end') return g[1];
    const env = g[0].trim();
    const end = findEnd(s, g[1], env);
    if (!end) return g[1];
    for (const node of environment(env, s.slice(g[1], end[0]), st)) put(node);
    return end[1];
  }
  if (/^[a-zA-Z@]+$/.test(name)) {
    // A command nobody listed: its arguments' words, so nothing in them is lost.
    let j = next;
    const o = readOptional(s, j);
    if (o) j = o[1];
    let any = false;
    for (let k = 0; k < 3; k++) {
      const g = /^\s*\{/.test(s.slice(j)) ? readGroup(s, j) : null;
      if (!g) break;
      put(inline(g[0], st));
      j = g[1];
      any = true;
    }
    return any || o ? j : skipInlineSpace(s, j);
  }
  return null;
}

/** A user's \newcommand, its arguments put in, read again as LaTeX. */
function expand(
  def: { n: number, opt: string | null, body: string }, s: string, next: number, st: State,
  put: (n: Node) => void,
): number {
  if (++st.expansions > MAX_EXPANSIONS) return next;
  const args: string[] = [];
  let j = next;
  if (def.opt !== null) {
    const o = readOptional(s, j);
    args.push(o ? o[0] : def.opt);
    if (o) j = o[1];
  }
  while (args.length < def.n) {
    const [a, after] = readArg(s, j);
    args.push(a);
    j = after;
  }
  put(inline(fill(def.body, args), st));
  // Without arguments it is a control word, and eats the space after it as TeX does.
  return def.n || def.opt !== null ? j : skipInlineSpace(s, j);
}

/** Spaces after a control word, but not a blank line: that is a paragraph, and not this command's to take. */
function skipInlineSpace(s: string, i: number): number {
  let j = i;
  while (s[j] === ' ' || s[j] === '\t') j++;
  if (s[j] === '\n' && !/^\n[ \t]*\n/.test(s.slice(j))) {
    j++;
    while (s[j] === ' ' || s[j] === '\t') j++;
  }
  return j;
}

/** `#1`…`#9` in a body, each its argument. */
const fill = (body: string, args: string[]) => body.replace(/#(\d)/g, (_m, d: string) => args[Number(d) - 1] ?? '');

/** A link that may go live: http(s) only, through linkURL(), and otherwise its words. */
function anchor(href: string, label: Node): Node {
  const u = linkURL(href);
  if (!u) {
    const span = document.createElement('span');
    span.append(label);
    return span;
  }
  const a = document.createElement('a');
  a.href = u.href;
  a.target = '_blank';
  a.rel = 'noopener noreferrer';
  a.append(label);
  return a;
}

// ---------------------------------------------------------------------------
// After the last line: what could only be known at the end
// ---------------------------------------------------------------------------

/** References, citations, the contents and the footnotes, filled in now every number is known. */
function finish(frag: DocumentFragment, st: State) {
  for (const { el, key, how } of st.refs) {
    const to = st.labels.get(key);
    if (!to) continue;
    const kind = to.kind === 'item' ? '' : to.kind;
    el.textContent = how === 'eqref' ? `(${to.num})`
      : (how === 'autoref' || how === 'cref' || how === 'Cref' || how === 'vref') && kind
        ? `${how === 'cref' ? kind.toLowerCase() : kind} ${to.kind === 'Equation' ? `(${to.num})` : to.num}`
        : to.num;
    el.classList.add('is-found');
  }
  for (const { el, keys } of st.cites) {
    const shown = keys.map(k => {
      const n = st.bib.indexOf(k);
      return n >= 0 ? String(n + 1) : k;
    });
    el.textContent = `[${shown.join(', ')}${el.dataset.note ? ', ' + el.dataset.note : ''}]`;
  }
  for (const nav of st.tocSlots) {
    const h = document.createElement('h2');
    h.className = 'tex-h';
    h.textContent = 'Contents';
    const ol = document.createElement('ol');
    for (const entry of st.toc) {
      const li = document.createElement('li');
      li.className = 'tex-toc-entry';
      li.style.setProperty('--level', String(entry.level - (st.chapters ? 0 : 1)));
      li.textContent = `${entry.num ? entry.num + ' ' : ''}${entry.title}`;
      ol.append(li);
    }
    nav.append(h, ol);
  }
  if (st.notes.length) {
    const sec = document.createElement('section');
    sec.className = 'tex-footnotes';
    const ol = document.createElement('ol');
    for (const note of st.notes) {
      const li = document.createElement('li');
      li.append(note);
      ol.append(li);
    }
    sec.append(document.createElement('hr'), ol);
    frag.append(sec);
  }
}

/** The two ceilings, for tests/latex.test.js to feed something past each. */
export const LATEX_LIMITS = { MAX_DEPTH, MAX_EXPANSIONS };
