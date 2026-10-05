// What the viewer and the editor need to treat a .tex file as LaTeX: which
// extensions are, the preview they draw (ui/latex.ts) with its pictures
// found among the board's own cards, and the pieces the editor's Insert menu
// offers - the ones a class handout, a problem set or an exam is made of.

import { board } from '../state.ts';
import { shownHash } from '../board-model.ts';
import { assetURL } from '../storage/assets.ts';
import { baseName } from '../util.ts';
import { renderLatex } from './latex.ts';

export const LATEX = new Set(['tex', 'latex', 'ltx']);

/**
 * The picture \includegraphics names, if a card on this board is that file:
 * `plots/run1.png`, `run1.png` or `run1` all find a card named run1.png. A
 * name and nothing else, so a file cannot reach anything the board does not hold.
 */
function pictureOnBoard(name: string): string | null {
  const want = name.split('/').pop()!.toLowerCase();
  const bare = want.replace(/\.[a-z0-9]+$/, '');
  const card = board.items.find(i => i.type === 'image' && !!i.name
    && (i.name.toLowerCase() === want || baseName(i.name).toLowerCase() === bare));
  const hash = card ? shownHash(card) : null;
  return hash ? assetURL(hash) : null;
}

/** The preview of a LaTeX source, in the class the stylesheets dress (viewer.css, .tex-doc). */
export function latexPreview(text: string): HTMLElement {
  const doc = document.createElement('div');
  doc.className = 'tex-doc';
  doc.append(renderLatex(text, { picture: pictureOnBoard }));
  return doc;
}

/** The Insert menu: each piece as LaTeX writes it, `|` where the caret lands. */
export const LATEX_SNIPPETS: { label: string, text: string }[] = [
  { label: 'Section', text: '\\section{|}\n' },
  { label: 'Subsection', text: '\\subsection{|}\n' },
  { label: 'Bulleted list', text: '\\begin{itemize}\n  \\item |\n  \\item \n\\end{itemize}\n' },
  { label: 'Numbered list', text: '\\begin{enumerate}\n  \\item |\n  \\item \n\\end{enumerate}\n' },
  { label: 'Equation', text: '\\begin{equation}\n  |\n  \\label{eq:}\n\\end{equation}\n' },
  { label: 'Aligned equations', text: '\\begin{align}\n  a &= | \\\\\n  b &= \n\\end{align}\n' },
  { label: 'Cases', text: 'f(x) = \\begin{cases}\n  | & \\text{if } x \\ge 0 \\\\\n  & \\text{otherwise}\n\\end{cases}' },
  { label: 'Matrix', text: '\\begin{pmatrix}\n  | & 0 \\\\\n  0 & 1\n\\end{pmatrix}' },
  { label: 'Theorem', text: '\\begin{theorem}\n  |\n\\end{theorem}\n' },
  { label: 'Definition', text: '\\begin{definition}\n  |\n\\end{definition}\n' },
  { label: 'Proof', text: '\\begin{proof}\n  |\n\\end{proof}\n' },
  { label: 'Table', text: '\\begin{table}[h]\n  \\centering\n  \\begin{tabular}{l|c|r}\n    \\hline\n    |A & B & C \\\\\n    \\hline\n    1 & 2 & 3 \\\\\n    \\hline\n  \\end{tabular}\n  \\caption{}\n  \\label{tab:}\n\\end{table}\n' },
  { label: 'Figure', text: '\\begin{figure}[h]\n  \\centering\n  \\includegraphics[width=0.6\\textwidth]{|}\n  \\caption{}\n  \\label{fig:}\n\\end{figure}\n' },
  { label: 'Code listing', text: '\\begin{lstlisting}[language=Python, caption={}]\n|\n\\end{lstlisting}\n' },
  { label: 'Pseudocode', text: '\\begin{algorithm}\n  \\caption{|}\n  \\begin{algorithmic}[1]\n    \\Require \n    \\Ensure \n    \\State \n    \\For{$i \\gets 1$ to $n$}\n      \\State \n    \\EndFor\n    \\State \\Return \n  \\end{algorithmic}\n\\end{algorithm}\n' },
  { label: 'Exam questions', text: '\\begin{questions}\n  \\question[5] |\n  \\begin{parts}\n    \\part \n    \\part \n  \\end{parts}\n  \\begin{solution}\n    \n  \\end{solution}\n\\end{questions}\n' },
  { label: 'Multiple choice', text: '\\begin{choices}\n  \\choice |\n  \\CorrectChoice \n  \\choice \n\\end{choices}\n' },
  { label: 'Slide (beamer frame)', text: '\\begin{frame}{|}\n  \\begin{itemize}\n    \\item \n  \\end{itemize}\n\\end{frame}\n' },
];

/** A new LaTeX file's first words: an article with what a problem set needs, ready to fill in. */
export const LATEX_STARTER = [
  '\\documentclass{article}',
  '\\usepackage{amsmath, amssymb, amsthm}',
  '\\usepackage{listings}',
  '\\usepackage{algorithm, algpseudocode}',
  '',
  '\\newtheorem{theorem}{Theorem}',
  '\\newcommand{\\R}{\\mathbb{R}}',
  '',
  '\\title{Untitled}',
  '\\author{}',
  '',
  '\\begin{document}',
  '\\maketitle',
  '',
  '\\section{Introduction}',
  '',
  '',
  '',
  '\\end{document}',
  '',
].join('\n');
