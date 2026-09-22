// The Markdown renderer, which parses files this app did not write. Tested
// because the safety rule - everything becomes a text node, nothing becomes
// markup - is worth asserting, and because most of its bugs only showed on
// input nobody thought to try by hand. DOM is stubbed (tag, class, children,
// text) rather than a real browser, as in hud.test.js and drawer.test.js.

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
 * The tree as a string, tags and all. A text node prints as its own
 * characters, which is what makes the escaping assertions readable - a
 * text node is otherwise indistinguishable from any other run of text.
 * The `isText` flag tells them apart when it matters.
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
      // className and href are plain properties on a real element too;
      // recorded under attrs only so show() can print them.
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
    const { renderMarkdown } = await import('../web/assets/js/ui/markdown.ts');
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
  // A setext underline belongs to the paragraph above it. Before the loop
  // learned to stop there, it got absorbed as prose and the heading was lost.
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
  // Not editable: this renders a file rather than editing one, and a box
  // that took a click and changed nothing on disk would be a lie.
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
  // Without a delimiter row, pipes stay characters in a sentence rather
  // than becoming a one-row table.
  const without = await render('a | b is not a table\n');
  assert.doesNotMatch(without.html, /<table>/);
});

test('a ragged table row is padded to the header rather than shifting', async () => {
  const { html } = await render('| a | b | c |\n|---|---|---|\n| 1 |\n');
  assert.match(html, /<tr><td>1<\/td><td><\/td><td><\/td><\/tr>/);
});

// An escaped pipe is a pipe, not a cell wall. Tested because the deciding
// code changed for a reason unrelated to Markdown: cells() used
// `/(?<!\\)\|/`, and WebKit had no lookbehind before Safari 16.4, so that
// one regex literal stopped the whole bundle parsing on older iOS. Now a
// hand-written scan (see tests/engine-floor.test.js) that must reproduce
// the old behaviour exactly.
test('an escaped pipe is content, not a cell wall', async () => {
  const { html } = await render('| a | b |\n|---|---|\n| x \\| y | z |\n');
  assert.match(html, /<tr><td>x \| y<\/td><td>z<\/td><\/tr>/,
    'one cell holding a literal pipe, and the row is two cells wide');
});

test('a backslash that is not escaping a pipe is left alone', async () => {
  // `\\|` is a backslash character followed by a pipe, and the pipe *is*
  // preceded by a backslash - so it never split there either.
  const { html } = await render('| a | b |\n|---|---|\n| C:\\ | z |\n');
  assert.match(html, /<td>C:\\<\/td>/, 'a trailing backslash survives as itself');
});

test('a blockquote holds blocks, not just words', async () => {
  const { html } = await render('> # inside\n');
  assert.match(html, /<blockquote><h1>inside<\/h1><\/blockquote>/);
});

// ---------------------------------------------------------------------------
// Inline
// ---------------------------------------------------------------------------

test('emphasis, strong and strikethrough take their whole span', async () => {
  // Backreferences in the alternation are absolute across the pattern, so
  // the emphasis rules said \1 and pointed at the code fence's group -
  // an undefined backreference matches empty, and **bold** lost letters.
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

// The editor (ui/editor/) writes Markdown this renderer then reads, so the
// spellings it relies on are held here, on the reader.
test('an underscore inside a word is a letter, not emphasis', async () => {
  const { html } = await render('snake_case_name and _em_\n');
  assert.match(html, /snake_case_name/);
  assert.match(html, /<em>em<\/em>/);
});

test('a backslash escapes the character after it', async () => {
  const { html } = await render('\\*not em\\* and \\\\ one slash\n');
  assert.doesNotMatch(html, /<em>/);
  assert.match(html, /\*not em\* and \\ one slash/);
});

test('bold closes on the last two stars of a run, not the first', async () => {
  const { html } = await render('**a *b***\n');
  assert.match(html, /<strong>a <em>b<\/em><\/strong>/);
});

test('a heading keeps a # that has no space before it', async () => {
  const { html } = await render('# C#\n## Closed ##\n');
  assert.match(html, /<h1>C#<\/h1>/);
  assert.match(html, /<h2>Closed<\/h2>/);
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
  // One shared global regex, and inline() recurses through a link's label -
  // the inner call reset the outer call's lastIndex to zero, so the outer
  // loop matched the same text forever and ran out of memory.
  const { html } = await render('[one](https://a.test) then [two](https://b.test) end\n');
  assert.equal((html.match(/<a /g) || []).length, 2);
  assert.match(html, /end/);
});

// ---------------------------------------------------------------------------
// Safety
// ---------------------------------------------------------------------------

test('raw HTML is text, not markup', async () => {
  // The rule the module is built around: these are files the app didn't
  // write. Nothing touches innerHTML, so angle brackets arrive as a text
  // node, escaped by construction in a real DOM.
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
  // A path points at somebody else's disk, a URL at the network - neither
  // resolves here, since going to the network about an opened file is not
  // something this app does.
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

test('a document of markers terminates', { timeout: 5000 }, async () => {
  // Every parser bug here has been a loop that didn't advance, so what
  // matters is that the call returns at all - hence the timeout, not
  // `typeof html === 'string'`, which held even while the suite hung.
  const src = '*'.repeat(200) + '\n' + '_'.repeat(200) + '\n' + '#'.repeat(200)
    + '\n> > > >\n- - - -\n|||||\n```\n';
  const { html } = await render(src);
  assert.ok(html.length > 0, 'a document of markers rendered to nothing at all');
});

test('CRLF is read the same as LF', async () => {
  const { html } = await render('# One\r\n\r\n- a\r\n- b\r\n');
  assert.match(html, /<h1>One<\/h1>/);
  assert.match(html, /<ul><li>a<\/li><li>b<\/li><\/ul>/);
});

test('a paragraph of backticks does not block the thread', { timeout: 10000 }, async () => {
  // Measured at 13.7 seconds on Node 22 before this: `(`+)([\s\S]*?)\1`
  // backtracks quadratically over a paragraph up to TEXT_MAX = 200,000
  // characters. FENCE catches a leading run of three or more, but not one
  // after another character - hence the leading `x`.
  const src = 'x' + '`'.repeat(200_000);
  const started = process.hrtime.bigint();
  const { html } = await render(src);
  const ms = Number(process.hrtime.bigint() - started) / 1e6;
  assert.ok(typeof html === 'string');
  assert.ok(ms < 2000, `took ${Math.round(ms)}ms - the backtracking is still there`);
});

test('code spans still work, and still suspend the markup inside them', async () => {
  // The guard must not cost the feature: a backtick span still turns
  // everything else off inside it.
  const { html } = await render('a `**not bold**` b');
  assert.match(html, /<code>\*\*not bold\*\*<\/code>/);
  assert.doesNotMatch(html, /<strong>/);
});

test('a doubled backtick fence still pairs with its partner', async () => {
  const { html } = await render('a ``x ` y`` b');
  assert.match(html, /<code>x ` y<\/code>/);
});

test('an unpaired backtick is left as a character', async () => {
  const { html } = await render('50% of `things');
  assert.doesNotMatch(html, /<code>/);
  assert.match(html, /`things/);
});

test('a wall of blockquote markers renders rather than blanking the file', { timeout: 5000 }, async () => {
  // blocks() recursed once per `>`, so 50,000 of them overflowed the stack,
  // and the viewer's catch turned that into a blank document with no error.
  const { html } = await render('>'.repeat(50_000) + ' deep\n');
  assert.ok(html.length > 0, 'the file rendered as nothing at all');
  assert.match(html, /blockquote/);
});
