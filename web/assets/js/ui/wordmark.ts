// Wrap occurrences of "mbrd" in a <span class="wm"> so the stylesheet can set
// the display face. Render sites call markName()/setMarked() instead of
// textContent — no markup strings, element-by-element only.

/** Match "mbrd" (with optional trailing dot). \b, not lookbehind — lookbehind
 * is a parse error on Safari 15. The ".mbrd" extension case is excluded by
 * hand in segments() to avoid that. */
const NAME = /\bmbrd\b\.?/g;

/** A run of `text`, and whether it is the name or the prose around it. */
export type Segment = { text: string, mark: boolean };

/** Split text into marked (name) and unmarked runs. Testable without a
 * document — joining all segments reproduces the input exactly. */
export function segments(text: string): Segment[] {
  const out: Segment[] = [];
  let last = 0;
  for (const m of text.matchAll(NAME)) {
    const at = m.index;
    // Skip ".mbrd" (file extension) — left in the plain-text run.
    if (at > 0 && text[at - 1] === '.') continue;
    if (at > last) out.push({ text: text.slice(last, at), mark: false });
    out.push({ text: m[0], mark: true });
    last = at + m[0].length;
  }
  if (last < text.length) out.push({ text: text.slice(last), mark: false });
  return out;
}

/** Return a DocumentFragment with name occurrences wrapped in `<span class="wm">`. */
export function markName(text: string): DocumentFragment {
  const frag = document.createDocumentFragment();
  for (const seg of segments(text)) {
    if (!seg.mark) { frag.append(seg.text); continue; }
    const span = document.createElement('span');
    span.className = 'wm';
    span.textContent = seg.text;
    frag.append(span);
  }
  return frag;
}

/** Drop-in for `el.textContent = text` with wordmark wrapping. */
export function setMarked(el: Element, text: string) {
  el.replaceChildren(markName(text));
}
