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
  canReadDocument, parseDelimited, resolveFrom, colIndex, slideNo,
} from '../web/assets/js/ui/documents.js';

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
