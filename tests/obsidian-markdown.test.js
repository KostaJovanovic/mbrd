// Obsidian's Markdown, on both sides: the renderer (ui/markdown.ts) draws each
// construct as its own element, and the editor (ui/editor/) keeps every one of
// them through an untouched save and an edit beside it. DOM stubbed as in
// markdown.test.js: tag, class, children and text are all a renderer writes.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { parseMarkdown, serializeDoc, inlineRuns } from '../web/assets/js/ui/editor/markdown.ts';
import { insertText, toggleMark } from '../web/assets/js/ui/editor/model.ts';

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

function show(node) {
  if (node.text !== undefined) return node.text;
  const inner = node.children.map(show).join('');
  if (node.tag === '#frag') return inner;
  const cls = node.attrs.class ? ` class="${node.attrs.class}"` : '';
  const type = node.dataset.callout ? ` data-callout="${node.dataset.callout}"` : '';
  const href = node.attrs.href ? ` href="${node.attrs.href}"` : '';
  const open = node.open ? ' open' : '';
  return `<${node.tag}${cls}${type}${href}${open}>${inner}</${node.tag}>`;
}

async function render(src) {
  globalThis.document = {
    createElement(tag) {
      const el = new FakeNode(tag);
      Object.defineProperty(el, 'className', { set(v) { el.attrs.class = v; }, get() { return el.attrs.class; } });
      Object.defineProperty(el, 'href', { set(v) { el.attrs.href = v; }, get() { return el.attrs.href; } });
      return el;
    },
    createDocumentFragment: () => new FakeNode('#frag'),
    createTextNode: text => ({ text, isText: true }),
  };
  try {
    const { renderMarkdown } = await import('../web/assets/js/ui/markdown.ts');
    return show(renderMarkdown(src));
  } finally {
    delete globalThis.document;
  }
}

/** Every element's tag in what `src` draws, text nodes left out. */
async function tags(src) {
  const seen = [];
  const html = await render(src);
  // show() prints a text node and an element alike, so the elements are
  // counted on a second render, as they are made.
  globalThis.document = {
    createElement(tag) { seen.push(tag); return new FakeNode(tag); },
    createDocumentFragment: () => new FakeNode('#frag'),
    createTextNode: text => ({ text }),
  };
  try {
    const { renderMarkdown } = await import('../web/assets/js/ui/markdown.ts');
    renderMarkdown(src);
  } finally {
    delete globalThis.document;
  }
  return { html, seen };
}

// ---------------------------------------------------------------------------
// Drawing
// ---------------------------------------------------------------------------

test('a highlight is a mark, and nests with the other marks', async () => {
  assert.match(await render('some ==bright **bold** words== here\n'), /<mark>bright <strong>bold<\/strong> words<\/mark>/);
});

test('wikilinks show their alias or their name, and embeds their name', async () => {
  const html = await render('See [[Other note]], [[Other note|that one]], [[Note#Part]] and ![[pic.png|300]] and ![[Doc]].\n');
  assert.match(html, /<span class="md-wikilink">Other note<\/span>/);
  assert.match(html, /<span class="md-wikilink">that one<\/span>/);
  assert.match(html, /<span class="md-wikilink">Note > Part<\/span>/);
  // A picture's alias is its size, so the name shows instead.
  assert.match(html, /<span class="md-image">pic.png<\/span>/);
  assert.match(html, /<span class="md-embed">Doc<\/span>/);
});

test('a callout is a panel with its type and title, and folds with + or -', async () => {
  const html = await render('> [!warning] Mind the gap\n> body words\n\n> [!faq]- Shut\n> inside\n\n> [!tip]+\n> open\n');
  assert.match(html, /<div class="md-callout" data-callout="warning"><div class="md-callout-title">Mind the gap<\/div><div class="md-callout-body"><p>body words<\/p><\/div><\/div>/);
  // `faq` is one of question's names; `-` is a <details> left shut.
  assert.match(html, /<details class="md-callout" data-callout="question"><summary class="md-callout-title">Shut<\/summary>/);
  assert.match(html, /<details class="md-callout" data-callout="tip" open><summary class="md-callout-title">Tip<\/summary>/);
});

test('tags start a word and are more than a number', async () => {
  const html = await render('#idea and #nested/tag but not page#part nor #123\n');
  assert.match(html, /<span class="md-tag">#idea<\/span>/);
  assert.match(html, /<span class="md-tag">#nested\/tag<\/span>/);
  assert.match(html, /page#part/);
  assert.match(html, /nor #123/);
});

test('footnotes are numbered where cited and listed at the end, inline ones too', async () => {
  const html = await render('First[^a] and second^[said inline] and first again[^a].\n\n[^a]: The note.\n');
  assert.match(html, /First<sup class="md-fnref">1<\/sup> and second<sup class="md-fnref">2<\/sup> and first again<sup class="md-fnref">1<\/sup>/);
  assert.match(html, /<section class="md-footnotes"><hr><\/hr><ol><li>The note.<\/li><li>said inline<\/li><\/ol><\/section>/);
  // The definition is not also drawn as a paragraph.
  assert.doesNotMatch(html, /<p>\[\^a\]/);
});

test('comments, block ids and HTML comments draw nothing', async () => {
  const html = await render('Seen %%unseen%% seen <!-- gone --> too ^block-1\n\n%%\nwhole\nlines\n%%\n\nafter\n');
  assert.match(html, /<p>Seen  seen  too<\/p>/);
  assert.doesNotMatch(html, /unseen|whole|gone|block-1/);
  assert.match(html, /<p>after<\/p>/);
});

test('math is shown as its TeX, inline and as a block, and dollars in prose are dollars', async () => {
  const html = await render('Euler $e^{i\\pi}+1=0$ costs $5 and $10.\n\n$$\n\\int_0^1 x\\,dx\n$$\n');
  assert.match(html, /<span class="md-math">e\^\{i\\pi\}\+1=0<\/span>/);
  assert.match(html, /costs \$5 and \$10\./);
  assert.match(html, /<div class="md-math md-math-block">\\int_0\^1 x\\,dx<\/div>/);
});

test('properties are a list of names and values, not a rule and a heading', async () => {
  const html = await render('---\ntitle: My note\ntags:\n  - one\n  - two\naliases: [a, "b"]\n---\n# Body\n');
  assert.match(html, /<dl class="md-props"><dt>title<\/dt><dd>My note<\/dd><dt>tags<\/dt><dd>one, two<\/dd><dt>aliases<\/dt><dd>a, b<\/dd><\/dl>/);
  assert.match(html, /<h1>Body<\/h1>/);
  assert.doesNotMatch(html, /<hr>/);
});

test('reference links resolve against their definitions, case aside', async () => {
  const html = await render('Read [the docs][Ref] or [ref] or [unknown].\n\n[ref]: https://example.com\n');
  assert.equal((html.match(/href="https:\/\/example.com\/"/g) ?? []).length, 2);
  assert.match(html, /\[unknown\]/);
});

test('bare addresses are links, without the sentence\'s full stop', async () => {
  const html = await render('Go to https://example.com/a_b. Then [https://x.com](https://x.com).\n');
  assert.match(html, /<a href="https:\/\/example.com\/a_b">https:\/\/example.com\/a_b<\/a>\./);
  // An address as a link's own label is its words, not a link inside a link.
  assert.match(html, /<a href="https:\/\/x.com\/">https:\/\/x.com<\/a>/);
});

test('a few inline HTML tags are themselves, built rather than parsed', async () => {
  const { html, seen } = await tags('<u>under</u> H<sub>2</sub>O <kbd>Ctrl</kbd> line<br>break <script>x</script> <u onclick="y">z</u>\n');
  assert.match(html, /<u>under<\/u> H<sub>2<\/sub>O <kbd>Ctrl<\/kbd> line<br><\/br>break/);
  // <script> is not on the list, and a tag with attributes is not the bare
  // tag: both stay their own characters, in text nodes.
  assert.ok(!seen.includes('script'));
  assert.equal(seen.filter(t => t === 'u').length, 1);
});

test('any character in a task box is a task, and only a space leaves it open', async () => {
  const html = await render('- [-] dropped\n- [/] half\n- [ ] open\n');
  assert.equal((html.match(/class="md-task"/g) ?? []).length, 3);
});

test('a newline inside a paragraph is a line break, as Obsidian draws it', async () => {
  assert.match(await render('one\ntwo\n'), /<p>one<br><\/br>two<\/p>/);
});

test('an opener with no closer does not hang the reader', async () => {
  const started = Date.now();
  await render('x' + ' %% $$ <u> =='.repeat(20_000) + '\n');
  assert.ok(Date.now() - started < 4000, `took ${Date.now() - started}ms`);
});

// ---------------------------------------------------------------------------
// Editing
// ---------------------------------------------------------------------------

const VAULT_NOTE = [
  '---',
  'tags: [a]',
  '---',
  '# Title',
  '',
  'Links [[Other|alias]] and ![[pic.png]] and #tag and ==bright== and $x_1 + y_2$ and[^1] ^[inline].',
  '',
  '> [!note] Callout',
  '> body',
  '',
  '%%',
  'hidden',
  '%%',
  '',
  '$$',
  'a_b_c',
  '$$',
  '',
  '##### Deep',
  '',
  '- [-] cancelled',
  '',
  'end ^id-1',
  '',
  '[^1]: the note',
  '',
].join('\n');

test('an Obsidian note opened and saved untouched keeps every byte', () => {
  assert.equal(serializeDoc(parseMarkdown(VAULT_NOTE)), VAULT_NOTE);
});

test('an edit beside Obsidian syntax leaves it as written', () => {
  const doc = parseMarkdown(VAULT_NOTE);
  const p = doc.blocks.findIndex(b => b.kind === 'p');
  const e = insertText(doc, { b: p, o: 0 }, { b: p, o: 0 }, 'New. ');
  assert.equal(serializeDoc(e.doc), VAULT_NOTE.replace('Links [[', 'New. Links [['));
});

test('a highlight is an editable mark, and a fresh one is written ==like this==', () => {
  assert.deepEqual(inlineRuns('a ==b== c'), [{ text: 'a ' }, { text: 'b', hl: true }, { text: ' c' }]);
  const doc = parseMarkdown('make this bright\n');
  const e = toggleMark(doc, { b: 0, o: 10 }, { b: 0, o: 16 }, 'hl');
  assert.equal(serializeDoc(e.doc), 'make this ==bright==\n');
});

test('a formula and a wikilink are kept whole rather than read as marks', () => {
  const runs = inlineRuns('$a_b_c$ and [[x_y_z]]');
  assert.deepEqual(runs.filter(r => r.raw).map(r => r.text), ['$a_b_c$', '[[x_y_z]]']);
  assert.ok(!runs.some(r => r.i));
});

test('two equals signs typed as words are escaped, so they stay words', () => {
  const doc = parseMarkdown('x\n');
  const e = insertText(doc, { b: 0, o: 1 }, { b: 0, o: 1 }, ' == y');
  assert.equal(serializeDoc(e.doc), 'x \\=\\= y\n');
});

test('headings four to six are headings in the editor', () => {
  const doc = parseMarkdown('#### four\n\n###### six\n');
  assert.deepEqual(doc.blocks.map(b => [b.kind, b.level]), [['h', 4], ['h', 6]]);
});
