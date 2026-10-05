// The LaTeX reader (ui/latex.ts) over the documents a computer-science class
// writes: numbering, references, theorems, pseudocode, tables, exams, code.
// DOM stubbed with what the reader calls - tag, class, children, text, dataset,
// one style property - and math stays its source, since enableMath() is unset.

import { test } from 'node:test';
import assert from 'node:assert/strict';

class FakeNode {
  constructor(tag) {
    this.tagName = tag.toUpperCase();
    this.children = [];
    this.dataset = {};
    this.attrs = {};
    this.props = {};
    const classes = new Set();
    this.classes = classes;
    this.classList = { add: (...c) => c.forEach(x => classes.add(x)), contains: c => classes.has(c) };
    this.style = { setProperty: (k, v) => { this.props[k] = v; } };
  }

  set className(v) { this.classes.clear(); for (const c of String(v).split(/\s+/)) if (c) this.classes.add(c); }
  get className() { return [...this.classes].join(' '); }
  get childNodes() { return this.children; }
  append(...kids) { for (const k of kids) this.children.push(...(k.tagName === '#FRAG' ? k.children : [k])); }
  appendChild(k) { this.append(k); return k; }
  prepend(...kids) { this.children.unshift(...kids); }
  setAttribute(k, v) { this.attrs[k] = String(v); }
  set textContent(v) { this.children = [{ text: String(v) }]; }
  get textContent() {
    return this.children.map(c => (c.text !== undefined ? c.text : c.textContent)).join('');
  }
}

/** Every element under `node`, depth first. */
function* walk(node) {
  for (const c of node.children ?? []) {
    if (c.text !== undefined) continue;
    yield c;
    yield* walk(c);
  }
}

const all = (root, cls) => [...walk(root)].filter(n => n.classes.has(cls));
const text = (root, cls) => all(root, cls).map(n => n.textContent.trim());

async function render(src, opts = { today: '6 October 2026' }) {
  globalThis.document = {
    createElement: tag => new FakeNode(tag),
    createDocumentFragment: () => new FakeNode('#frag'),
    createTextNode: t => ({ text: t }),
  };
  try {
    const { renderLatex } = await import('../web/assets/js/ui/latex.ts');
    return renderLatex(src, opts);
  } finally {
    delete globalThis.document;
  }
}

const doc = body => `\\documentclass{article}\n\\begin{document}\n${body}\n\\end{document}\n`;

test('sections number themselves and a reference reads the number', async () => {
  const f = await render(doc([
    '\\section{Intro}\\label{sec:a}',
    '\\subsection{Detail}\\label{sec:b}',
    '\\section*{Unnumbered}',
    '\\section{Next}',
    'See Section~\\ref{sec:b} and \\autoref{sec:a}.',
  ].join('\n')));
  assert.deepEqual(text(f, 'tex-num'), ['1', '1.1', '2']);
  assert.deepEqual(text(f, 'tex-ref'), ['1.1', 'Section 1']);
});

test('the preamble title, author and date become the title block', async () => {
  const f = await render('\\title{Problem Set 3}\\author{Ada \\and Alan}\\date{\\today}\n\\begin{document}\\maketitle\\end{document}');
  const all = f.textContent;
  assert.match(all, /Problem Set 3/);
  assert.match(all, /Ada/);
  assert.match(all, /Alan/);
  assert.match(all, /6 October 2026/);
});

test('equations count, and \\eqref puts the number in brackets', async () => {
  const f = await render(doc([
    '\\begin{equation}\\label{eq:one} a = b \\end{equation}',
    '\\begin{equation*} c \\end{equation*}',
    '\\begin{equation}\\label{eq:two} d \\end{equation}',
    'By \\eqref{eq:two} and \\ref{eq:one}.',
  ].join('\n')));
  assert.deepEqual(text(f, 'tex-ref'), ['(2)', '1']);
});

test('theorems share or keep counters as \\newtheorem says, and a proof ends in its square', async () => {
  const f = await render([
    '\\newtheorem{theorem}{Theorem}',
    '\\newtheorem{lemma}[theorem]{Lemma}',
    '\\begin{document}',
    '\\begin{theorem}[Master]\\label{t} A \\end{theorem}',
    '\\begin{lemma} B \\end{lemma}',
    '\\begin{proof} Trivially. \\end{proof}',
    'By Theorem~\\ref{t}.',
    '\\end{document}',
  ].join('\n'));
  assert.deepEqual(text(f, 'tex-thm-head'), ['Theorem 1', 'Lemma 2']);
  assert.match(f.textContent, /Master/);
  assert.match(f.textContent, /∎/);
  assert.deepEqual(text(f, 'tex-ref'), ['1']);
});

test('pseudocode numbers its lines and indents its blocks', async () => {
  const f = await render(doc([
    '\\begin{algorithmic}[1]',
    '\\Function{Search}{$A, t$}',
    '  \\While{$lo \\le hi$}',
    '    \\State \\Return $mid$ \\Comment{found}',
    '  \\EndWhile',
    '\\EndFunction',
    '\\end{algorithmic}',
  ].join('\n')));
  const nums = text(f, 'tex-algo-num');
  assert.deepEqual(nums, ['1:', '2:', '3:', '4:', '5:']);
  const indents = all(f, 'tex-algo-body').map(n => Number(n.props['--indent'] ?? 0));
  assert.deepEqual(indents, [0, 1, 2, 1, 0]);
  // \Return is a word on its line, not the start of another.
  const third = all(f, 'tex-algo-body')[2].textContent;
  assert.match(third, /return/);
  assert.match(third, /found/);
});

test('a tabular is a table with its rows, cells and spans', async () => {
  const f = await render(doc([
    '\\begin{tabular}{|l|c|r|}',
    '\\hline',
    'A & B & C \\\\',
    '\\hline',
    '\\multicolumn{2}{c}{wide} & x \\\\',
    '\\hline',
    '\\end{tabular}',
  ].join('\n')));
  const table = [...walk(f)].find(n => n.tagName === 'TABLE');
  assert.ok(table, 'no table');
  assert.ok(table.classes.has('is-ruled'));
  const rows = [...walk(table)].filter(n => n.tagName === 'TR');
  assert.equal(rows.length, 2);
  const cells = [...walk(rows[1])].filter(n => n.tagName === 'TD');
  assert.equal(cells.length, 2);
  assert.equal(cells[0].colSpan, 2);
});

test('exam questions carry their points, parts and the marked choice', async () => {
  const f = await render([
    '\\documentclass{exam}',
    '\\begin{document}',
    '\\begin{questions}',
    '\\question[5] First?',
    '\\begin{parts}\\part One \\part Two\\end{parts}',
    '\\question[1] Second?',
    '\\begin{choices}\\choice No \\CorrectChoice Yes\\end{choices}',
    '\\end{questions}',
    '\\end{document}',
  ].join('\n'));
  assert.deepEqual(text(f, 'tex-points'), ['(5 points)', '(1 point)']);
  assert.match(f.textContent, /One/);
  assert.match(f.textContent, /Yes/);
});

test('code keeps its % and braces, and a comment outside it is gone', async () => {
  const f = await render(doc([
    'Shown % hidden remark',
    '\\begin{lstlisting}[language=Python, caption={Merge}]',
    'x = 100 % 7  # {not a group}',
    '\\end{lstlisting}',
    'and \\verb|a % b| inline, 50\\% off.',
  ].join('\n')));
  const all = f.textContent;
  assert.match(all, /Shown/);
  assert.doesNotMatch(all, /hidden remark/);
  assert.match(all, /x = 100 % 7 {2}# \{not a group\}/);
  assert.match(all, /a % b/);
  assert.match(all, /50% off/);
  assert.match(all, /Merge/);
});

test('a citation reads its number in the bibliography', async () => {
  const f = await render(doc([
    'As shown~\\cite{b, a}.',
    '\\begin{thebibliography}{9}',
    '\\bibitem{a} First.',
    '\\bibitem{b} Second.',
    '\\end{thebibliography}',
  ].join('\n')));
  assert.deepEqual(text(f, 'tex-cite'), ['[2, 1]']);
});

test('a user macro expands in text, with its argument', async () => {
  const f = await render('\\newcommand{\\course}[1]{CS #1}\n\\begin{document}Welcome to \\course{161}.\\end{document}');
  assert.match(f.textContent, /Welcome to CS 161\./);
});

test('nested lists count 1, a, i', async () => {
  const f = await render(doc([
    '\\begin{enumerate}\\item A',
    '\\begin{enumerate}\\item B',
    '\\begin{enumerate}\\item C\\end{enumerate}',
    '\\end{enumerate}\\end{enumerate}',
  ].join('\n')));
  const types = [...walk(f)].filter(n => n.tagName === 'OL').map(n => n.type ?? n.attrs.type ?? '1');
  assert.deepEqual(types, ['1', 'a', 'i']);
});

test('an unknown environment shows the words inside it', async () => {
  const f = await render(doc('\\begin{mystery}still here\\end{mystery}'));
  assert.match(f.textContent, /still here/);
});

test('a macro that expands itself ends, and so does nesting past the limit', async () => {
  const { LATEX_LIMITS } = await import('../web/assets/js/ui/latex.ts');
  const loop = await render('\\def\\a{\\a\\a}\n\\begin{document}x \\a y\\end{document}');
  assert.match(loop.textContent, /x/);
  const deep = '{'.repeat(LATEX_LIMITS.MAX_DEPTH * 3) + 'deep' + '}'.repeat(LATEX_LIMITS.MAX_DEPTH * 3);
  const nested = await render(doc(deep));
  assert.match(nested.textContent, /deep/);
  const envs = '\\begin{center}'.repeat(LATEX_LIMITS.MAX_DEPTH * 2) + 'inner' + '\\end{center}'.repeat(LATEX_LIMITS.MAX_DEPTH * 2);
  assert.match((await render(doc(envs))).textContent, /inner/);
});

test('a link goes live only to http(s), and nothing else becomes an anchor', async () => {
  const f = await render(doc('\\href{https://example.com}{site} \\href{javascript:alert(1)}{bad} \\url{https://a.b/c}'));
  const hrefs = [...walk(f)].filter(n => n.tagName === 'A').map(n => n.href);
  assert.equal(hrefs.length, 2);
  for (const h of hrefs) assert.match(h, /^https:\/\//);
  assert.match(f.textContent, /bad/);
});

test('a picture comes from the board when the option finds it, and is named when not', async () => {
  const src = doc('\\includegraphics[width=5cm]{plot.png}\n\n\\includegraphics{missing}');
  const f = await render(src, { picture: name => (name === 'plot.png' ? 'blob:plot' : null) });
  const imgs = [...walk(f)].filter(n => n.tagName === 'IMG');
  assert.equal(imgs.length, 1);
  assert.equal(imgs[0].src, 'blob:plot');
  assert.match(f.textContent, /missing/);
});

test('anything at all reads without throwing', async () => {
  for (const src of [undefined, null, 42, '', '\\', '{', '}', '\\begin{', '\\end{document}', '$', '$$', '\\[', '\\verb', '\\begin{tabular}', '%'.repeat(10), '\\newcommand', '\\def\\x']) {
    await render(src);
  }
});
