// The app's name, set in the app's face, wherever it is said.
//
// The sidebar's mark and the splash have always been set in the display face.
// Everywhere else the name appeared it was a five-letter word in whatever the
// sentence around it was set in - and a tester reading "Reload mbrd" on a
// button parsed it as a technical verb, guessing the app was offering to reload
// some kind of cache. That is the whole bug: the name has to look like a name,
// or it reads as jargon.
//
// This is the seam that fixes it once instead of at each site. The strings
// themselves stay plain strings - `label: 'Reload mbrd'` is still that, and
// nobody writing a new one has to remember anything - and the *render* sites
// hand their text through here instead of assigning it. So a message written
// next year gets the treatment by having been displayed, which is the only
// version of this that stays true.
//
// Element by element, never a string of markup. There is no user data in these
// strings today, but "this particular text is ours" is exactly the assumption
// that stops being true the first time somebody interpolates a board title into
// a dialog - and the codebase's rule is that nothing builds a tree from a
// string, so there is no escaping to get right. See ui/markdown.ts, which
// argues it at length for foreign documents.

/**
 * The name, and the shape it is allowed to take in prose.
 *
 * The trailing stop is part of the mark - the sidebar reads `mbrd.` and so does
 * the splash - so it is taken when it is there and not required when it is not.
 *
 * `\b` at the front keeps it out of the middle of longer words. The other
 * exclusion - a *file extension*, where "a .mbrd file" names a format rather
 * than the app - is done by hand in markName() below rather than in the pattern,
 * and that is not a style choice: a lookbehind would say it in one character and
 * is a **parse error** on Safari 15, which does not fail politely. It takes the
 * whole bundle with it, so the app would not boot at all on a browser inside the
 * stated support floor. tests/engine-floor.test.js is what caught it; see
 * research/docs/browser-support.md for the floor itself.
 *
 * The console handle (`mbrd.cmds`, `mbrd.perf`) needs no exclusion because none
 * of it is ever displayed - it is typed.
 */
const NAME = /\bmbrd\b\.?/g;

/** A run of `text`, and whether it is the name or the prose around it. */
export type Segment = { text: string, mark: boolean };

/**
 * `text` cut into marked and unmarked runs, in order.
 *
 * The deciding half of this module, split out from the building half so it can
 * be tested without a document - the exclusions above are the part that can be
 * quietly wrong, and "a .mbrd file did not get the treatment" is not something
 * anybody will notice by looking. Joining every `text` back together always
 * reproduces the input exactly, which is the property the test leans on.
 *
 * `matchAll` rather than `replace`, because the whole point is to come out the
 * other side with nodes rather than markup - and producing markup is what this
 * module exists not to do.
 */
export function segments(text: string): Segment[] {
  const out: Segment[] = [];
  let last = 0;
  for (const m of text.matchAll(NAME)) {
    const at = m.index;
    // The extension case the pattern deliberately does not carry - see NAME.
    // Left in the run of plain text rather than skipped over: `last` is not
    // moved, so the ".mbrd" is emitted by whichever run comes next.
    if (at > 0 && text[at - 1] === '.') continue;
    if (at > last) out.push({ text: text.slice(last, at), mark: false });
    out.push({ text: m[0], mark: true });
    last = at + m[0].length;
  }
  if (last < text.length) out.push({ text: text.slice(last), mark: false });
  return out;
}

/**
 * `text`, as nodes, with every occurrence of the name wrapped for the stylesheet.
 *
 * A fragment rather than an element, so a caller can drop it into whatever it
 * already has without an extra wrapper appearing in the middle of a sentence.
 * A string with no occurrence comes back as a single text node, which is the
 * same thing `textContent` would have made.
 */
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

/**
 * Put `text` in `el`, marked - the drop-in for `el.textContent = text`.
 *
 * replaceChildren() and not an append, so this is the assignment it replaces in
 * every respect: whatever was in there is gone, and calling it twice leaves one
 * copy of the text rather than two. That equivalence is the reason the call
 * sites can be changed one line at a time without reading their surroundings.
 */
export function setMarked(el: Element, text: string) {
  el.replaceChildren(markName(text));
}
