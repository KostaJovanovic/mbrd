// The Markdown renderer, which parses files this app did not write.
//
// Two reasons it is tested and the other renderers are not. It is the only place
// in the app that turns somebody else's text into a document tree, so the safety
// rule - everything becomes a text node, nothing becomes markup - is a property
// worth asserting rather than reading. And it is a parser: three of the four
// bugs found while writing it were the kind that only show on input nobody
// thought to try by hand, including one that did not terminate.
//
// The DOM is stubbed for the length of each call, the way tests/hud.test.js and
// tests/trash.test.js stub it. The stub records structure rather than pretending
// to be a browser: a tag, a class, children, and text. That is enough to assert
// everything below, and a real DOM would be a dependency for one file.

import { test } from 'node:test';
import assert from 'node:assert/strict';

class FakeNode {
  constructor(tag) {
    this.tag = tag;
    this.children = [];
    this.style = {};
    this.dataset = {};
    this.attrs = {};
  }

  append(...kids) { for (const k of kids) this.children.push(k); }
  set textContent(v) { this.children = [{ text: String(v) }]; }
  get textContent() {
    return this.children.map(c => (c.text !== undefined ? c.text : c.textContent)).join('');
  }
}

/**
 * The tree as a string, tags and all.
 *
 * A text node prints as its own characters, which is what makes the escaping
 * assertions below readable: raw HTML in the source has to come out as a text
 * node, and a text node here is indistinguishable from any other run of text.
 * The `isText` flag is how the assertions tell them apart when it matters.
 */
function show(node) {
  if (node.text !== undefined) return node.text;
  const inner = node.children.map(show).join('');
  if (node.tag === '#frag') return inner;
  const cls = node.attrs.class ? ` class="${node.attrs.class}"` : '';
  const href = node.attrs.href ? ` href="${node.attrs.href}"` : '';
  return `<${node.tag}${cls}${href}>${inner}</${node.tag}>`;
}

/** Render `src` with the DOM stubbed, and hand back the tree and its string. */
async function render(src) {
  globalThis.document = {
    createElement(tag) {
      const el = new FakeNode(tag);
      // className and href are plain properties on a real element too; recording
      // them under attrs is only so show() can print them.
      Object.defineProperty(el, 'className', {
        set(v) { el.attrs.class = v; }, get() { return el.attrs.class; },
      });
      Object.defineProperty(el, 'href', {
        set(v) { el.attrs.href = v; }, get() { return el.attrs.href; },
      });
      return el;
    },
    createDocumentFragment: () => new FakeNode('#frag'),
    createTextNode: text => ({ text, isText: true }),
  };
  try {
    const { renderMarkdown } = await import('../web/assets/js/ui/markdown.js');
    const tree = renderMarkdown(src);
    return { tree, html: show(tree) };
  } finally {
    delete globalThis.document;
  }
}

/** Every node in the tree, depth first. */
function walk(node, out = []) {
  out.push(node);
  for (const kid of node.children || []) walk(kid, out);
  return out;
}

// ---------------------------------------------------------------------------
// Blocks
// ---------------------------------------------------------------------------

test('headings, both spellings', async () => {
  const { html } = await render('# One\n\n## Two\n\nSetext\n======\n\nUnder\n---\n');
  assert.match(html, /<h1>One<\/h1>/);
  assert.match(html, /<h2>Two<\/h2>/);
  // A setext underline belongs to the paragraph above it. Absorbed as another
  // line of prose - which is what happened before the paragraph loop learned to
  // stop at one - both the heading and the underline are lost.
  assert.match(html, /<h1>Setext<\/h1>/);
  assert.match(html, /<h2>Under<\/h2>/);
});

test('a bare rule is a rule and not a heading', async () => {
  // `---` is both a thematic break and a setext underline, and which it is
  // depends on whether a paragraph is open above it.
  const { html } = await render('one\n\n---\n\ntwo\n');
  assert.match(html, /<hr><\/hr>/);
  assert.match(html, /<p>one<\/p>/);
});

test('a numbered list after a bulleted one is a second list', async () => {
  const { html } = await render('- a\n- b\n\n1. one\n2. two\n');
  assert.match(html, /<ul><li>a<\/li><li>b<\/li><\/ul>/);
  assert.match(html, /<ol><li>one<\/li><li>two<\/li><\/ol>/);
});

test('lists nest by indent', async () => {
  const { html } = await render('- a\n  - b\n- c\n');
  assert.match(html, /<ul><li>a<ul><li>b<\/li><\/ul><\/li><li>c<\/li><\/ul>/);
});

test('a task list is a disabled checkbox and its words', async () => {
  const { tree, html } = await render('- [x] done\n- [ ] not\n');
  assert.match(html, /class="md-task"/);
  const boxes = walk(tree).filter(n => n.tag === 'input');
  assert.equal(boxes.length, 2);
  assert.deepEqual(boxes.map(b => b.checked), [true, false]);
  // Not editable, because this is a rendering of a file and not an editor for
  // one: a box that took a click and changed nothing on disk would be a lie.
  assert.deepEqual(boxes.map(b => b.disabled), [true, true]);
});

test('a fenced block keeps its text and its language', async () => {
  const { tree, html } = await render('```js\nconst x = 1;\n```\n');
  assert.match(html, /<pre><code>const x = 1;<\/code><\/pre>/);
  assert.equal(walk(tree).find(n => n.tag === 'code').dataset.lang, 'js');
});

test('an unclosed fence runs to the end rather than swallowing the parser', async () => {
  const { html } = await render('```\nnever closed\nmore\n');
  assert.match(html, /never closed\nmore/);
});

test('a table needs its delimiter row', async () => {
  const withRule = await render('| a | b |\n|---|---|\n| 1 | 2 |\n');
  assert.match(withRule.html, /<thead><tr><th>a<\/th><th>b<\/th><\/tr><\/thead>/);
  assert.match(withRule.html, /<tbody><tr><td>1<\/td><td>2<\/td><\/tr><\/tbody>/);
  // Without one the pipes are characters in a sentence, which is what keeps a
  // line of prose containing a pipe from becoming a one-row table.
  const without = await render('a | b is not a table\n');
  assert.doesNotMatch(without.html, /<table>/);
});

test('a ragged table row is padded to the header rather than shifting', async () => {
  const { html } = await render('| a | b | c |\n|---|---|---|\n| 1 |\n');
  assert.match(html, /<tr><td>1<\/td><td><\/td><td><\/td><\/tr>/);
});

test('a blockquote holds blocks, not just words', async () => {
  const { html } = await render('> # inside\n');
  assert.match(html, /<blockquote><h1>inside<\/h1><\/blockquote>/);
});

// ---------------------------------------------------------------------------
// Inline
// ---------------------------------------------------------------------------

test('emphasis, strong and strikethrough take their whole span', async () => {
  // The bug this is written for: the backreferences in the alternation are
  // absolute across the pattern, so the two emphasis rules said \1 and pointed
  // at the code fence's group. An undefined backreference matches the empty
  // string, and **bold** came out as a <strong> holding one letter.
  const { html } = await render('**bold** and *em* and ~~gone~~\n');
  assert.match(html, /<strong>bold<\/strong>/);
  assert.match(html, /<em>em<\/em>/);
  assert.match(html, /<s>gone<\/s>/);
});

test('underscores are the other spelling of both', async () => {
  const { html } = await render('__bold__ and _em_\n');
  assert.match(html, /<strong>bold<\/strong>/);
  assert.match(html, /<em>em<\/em>/);
});

test('code spans suspend everything inside them', async () => {
  const { html } = await render('`**not bold**`\n');
  assert.match(html, /<code>\*\*not bold\*\*<\/code>/);
  assert.doesNotMatch(html, /<strong>/);
});

test('emphasis inside a link works, and neither knows about the other', async () => {
  const { html } = await render('[a **b**](https://example.com)\n');
  assert.match(html, /<a href="https:\/\/example\.com\/">a <strong>b<\/strong><\/a>/);
});

test('inline recursion does not restart the outer scan', async () => {
  // The first bug found: one shared global regex, and inline() recurses through
  // a link's label - so the inner call reset the outer call's lastIndex to zero
  // and the outer loop matched the same text again, forever. It did not fail,
  // it ran out of memory.
  const { html } = await render('[one](https://a.test) then [two](https://b.test) end\n');
  assert.equal((html.match(/<a /g) || []).length, 2);
  assert.match(html, /end/);
});

// ---------------------------------------------------------------------------
// Safety
// ---------------------------------------------------------------------------

test('raw HTML is text, not markup', async () => {
  // The rule the whole module is built around: these are files the app did not
  // write. Nothing here ever touches innerHTML, so the assertion is that the
  // angle brackets arrive as a text node - which in a real DOM is escaped by
  // construction and cannot execute.
  const { tree } = await render('<script>alert(1)</script>\n');
  const text = walk(tree).filter(n => n.isText).map(n => n.text).join('');
  assert.match(text, /<script>alert\(1\)<\/script>/);
  assert.equal(walk(tree).some(n => n.tag === 'script'), false);
});

test('a javascript: link is inert text', async () => {
  const { html } = await render('[x](javascript:alert(1))\n');
  assert.doesNotMatch(html, /<a /);
  assert.match(html, /<span>x<\/span>/);
});

test('an image is its alt text and fetches nothing', async () => {
  // A path in a Markdown file points at somebody else's disk and a URL points at
  // the network. Neither resolves here, and going to the network about a file
  // somebody opened is not something this app does.
  const { html } = await render('![a picture](secret.png)\n');
  assert.match(html, /<span class="md-image">a picture<\/span>/);
  assert.doesNotMatch(html, /<img/);
});

test('an autolink is a link and anything else in angle brackets is not', async () => {
  const good = await render('<https://example.com>\n');
  assert.match(good.html, /<a href="https:\/\/example\.com\/">/);
  const bad = await render('<file:///etc/passwd>\n');
  assert.doesNotMatch(bad.html, /<a /);
});

// ---------------------------------------------------------------------------
// Degenerate input
// ---------------------------------------------------------------------------

test('empty and whitespace-only input render nothing', async () => {
  for (const src of ['', '\n\n\n', '   \n  \n']) {
    const { html } = await render(src);
    assert.equal(html, '');
  }
});

test('a document of markers terminates', async () => {
  // Every parser bug in this file so far has been a loop that did not advance,
  // so the assertion that matters here is that the call returns at all.
  const src = '*'.repeat(200) + '\n' + '_'.repeat(200) + '\n' + '#'.repeat(200)
    + '\n> > > >\n- - - -\n|||||\n```\n';
  const { html } = await render(src);
  assert.equal(typeof html, 'string');
});

test('CRLF is read the same as LF', async () => {
  const { html } = await render('# One\r\n\r\n- a\r\n- b\r\n');
  assert.match(html, /<h1>One<\/h1>/);
  assert.match(html, /<ul><li>a<\/li><li>b<\/li><\/ul>/);
});
