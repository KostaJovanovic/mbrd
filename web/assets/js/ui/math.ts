// Math typeset by KaTeX, carried in web/assets/vendor/katex and loaded the
// first time a page has a formula on it. Markdown's $…$ and the LaTeX reader
// both hand their formulas here; until main.ts calls enableMath() - in a test,
// on the patch page - a formula stays the TeX it was written in, which is
// what the readers draw first anyway. Nothing touches the document at import.

/** Exported for tests/vendor.test.js, which holds it to the bytes on disk. */
export const KATEX_VERSION = '0.19.0';
const KATEX_DIR = './assets/vendor/katex/';

/** The one call this module makes, typed here since there is no package to read it from. */
type Katex = {
  render(tex: string, into: HTMLElement, opts: Record<string, unknown>): void,
};

/** User macros, `\name` to its body, as the LaTeX reader collects them from a preamble. */
export type Macros = Record<string, string>;

let enabled = false;
let lib: Promise<Katex | null> | null = null;

/** Called once by main.ts. Without it every formula is shown as its source. */
export function enableMath() { enabled = true; }

const katexURL = (file: string) => new URL(KATEX_DIR + file, document.baseURI).href;

/** KaTeX and its stylesheet, once. A failure is remembered as null: the TeX stays. */
function load(): Promise<Katex | null> {
  if (!lib) {
    // The sheet before the script, so the first formula does not draw unstyled.
    // A <link> rather than a line in index.html: most boards never show a formula.
    const sheet = document.createElement('link');
    sheet.rel = 'stylesheet';
    sheet.href = katexURL('katex.min.css');
    document.head.append(sheet);
    lib = import(/* @vite-ignore */ katexURL('katex.mjs'))
      .then(mod => (mod.default && typeof mod.default.render === 'function' ? mod.default : mod))
      .catch(() => null);
  }
  return lib;
}

/**
 * Typeset `tex` into `el`, which already shows it as source - so a page that
 * never gets KaTeX, or a formula KaTeX refuses, still reads.
 *
 * The options are the safety: the TeX is from a file this app did not write.
 * `trust: false` refuses \href, \url, \includegraphics and the class and style
 * commands. `maxExpand` and `maxSize` cap a macro loop and a 10,000em rule.
 * HTML output only, because KaTeX's MathML half writes a `style` attribute in
 * three places and web/_headers allows none; HTML is built through
 * `element.style`, which a CSP does not police. `throwOnError` so a mistake
 * comes back here rather than as KaTeX's own red span, which is another style
 * attribute.
 */
export function typeset(el: HTMLElement, tex: string, display: boolean, macros: Macros = {}) {
  if (!enabled || typeof document === 'undefined') return;
  void load().then(katex => {
    if (!katex) return;
    const into = document.createElement(display ? 'div' : 'span');
    try {
      katex.render(tex, into, {
        displayMode: display,
        output: 'html',
        throwOnError: true,
        trust: false,
        strict: 'ignore',
        maxExpand: 1000,
        maxSize: 50,
        // A copy: KaTeX writes \gdef definitions back into the object it is given.
        macros: { ...macros },
      });
    } catch (err) {
      el.classList.add('is-wrong');
      el.title = err instanceof Error ? err.message : 'This formula did not typeset';
      return;
    }
    el.replaceChildren(...into.childNodes);
    el.classList.add('is-typeset');
    // Read aloud as what was written, which is all a screen reader gets from HTML math.
    el.setAttribute('aria-label', tex);
  });
}
