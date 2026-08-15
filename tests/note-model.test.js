// The note's formatting model - and the marker colours in particular.
//
// canvas/note-model.ts is pure and DOM-free, and until this file nothing in
// tests/ touched it. That included `wash`, the highlighter, which
// research/docs/mbrd-format.md now promises two things about in writing:
//
//   - an unmarked block is byte-for-byte what it was before markers existed,
//     so an old board re-saved by a new build does not grow a key per line
//   - an unknown colour is dropped rather than rounded to the nearest one,
//     because there is no nearest marker to round a stranger's name to
//
// Both are one-line properties of normalizeBlock() and both were undefended.
// The module's own header argues for them at length, which is exactly the
// arrangement CLAUDE.md warns about: a rule stated in prose and nowhere else.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  normalizeNoteRich, flattenNoteRich, parseNoteText,
  NOTE_WASHES, NOTE_TAGS, NOTE_ALIGNS, NOTE_MARKER,
} from '../web/assets/js/canvas/note-model.ts';

const block = (props = {}) => ({ tag: 'p', align: 'left', text: 'x', ...props });
const rich = (blocks, props = {}) => ({ blocks, ...props });

// ---------------------------------------------------------------------------
// wash
// ---------------------------------------------------------------------------

test('every colour in the catalogue survives normalisation', () => {
  for (const wash of NOTE_WASHES) {
    const out = normalizeNoteRich(rich([block({ wash })]));
    assert.equal(out.blocks[0].wash, wash, `${wash} did not survive`);
  }
});

test('an unmarked block carries no wash key at all', () => {
  // Not `wash: null`, not `wash: undefined` - absent. The promise is that an
  // old board re-saved by a new build is the same bytes, and a key written on
  // every line of every note is a key in every file.
  const out = normalizeNoteRich(rich([block()]));
  assert.equal('wash' in out.blocks[0], false,
    `an unmarked block came back as ${JSON.stringify(out.blocks[0])}`);
  assert.deepEqual(Object.keys(out.blocks[0]).sort(), ['align', 'tag', 'text']);
});

test('an unknown colour is dropped, not rounded to the nearest one', () => {
  for (const junk of ['puce', 'AMBER', '', 0, 1, null, {}, [], true]) {
    const out = normalizeNoteRich(rich([block({ wash: junk })]));
    assert.equal('wash' in out.blocks[0], false,
      `${JSON.stringify(junk)} was accepted as a marker colour`);
  }
});

test('a marked block keeps its mark through a JSON round trip', () => {
  // The trip a .mbrd actually makes: the model is serialised into board.json
  // and read back by normalizeNoteRich on the way in.
  const source = rich([
    block({ tag: 'h1', align: 'center', text: 'Title', wash: 'amber' }),
    block({ tag: 'p', align: 'right', text: 'Body', wash: 'olive' }),
    block({ tag: 'p', text: 'Plain' }),
  ], { font: 'serif', size: 1.2, valign: 'middle' });

  const back = normalizeNoteRich(JSON.parse(JSON.stringify(normalizeNoteRich(source))));
  assert.deepEqual(back.blocks.map(b => b.wash), ['amber', 'olive', undefined]);
  assert.deepEqual(back.blocks.map(b => b.align), ['center', 'right', 'left']);
  assert.deepEqual(back.blocks.map(b => b.tag), ['h1', 'p', 'p']);
  assert.equal(back.font, 'serif');
  assert.equal(back.size, 1.2);
  assert.equal(back.valign, 'middle');
});

test('a mark has no plaintext form, so flattening drops it silently', () => {
  // The deal meta.text makes to stay portable, asserted so that "the marker is
  // missing from the export" is a known answer rather than a bug report.
  const out = flattenNoteRich(rich([
    block({ tag: 'h1', text: 'Title', wash: 'amber' }),
    block({ text: 'Body', wash: 'olive' }),
  ]));
  assert.equal(out, '# Title\nBody');
});

// ---------------------------------------------------------------------------
// The rest of the block model, which was equally untested
// ---------------------------------------------------------------------------

test('an unknown tag or alignment IS rounded, unlike a wash', () => {
  // The asymmetry the module header argues for: there is a nearest paragraph
  // and a nearest alignment, and there is no nearest colour.
  const out = normalizeNoteRich(rich([block({ tag: 'h7', align: 'sideways' })]));
  assert.equal(out.blocks[0].tag, 'p');
  assert.equal(out.blocks[0].align, 'left');
});

test('every tag and alignment in the catalogue is accepted as it stands', () => {
  for (const tag of NOTE_TAGS) {
    assert.equal(normalizeNoteRich(rich([block({ tag })])).blocks[0].tag, tag);
  }
  for (const align of NOTE_ALIGNS) {
    assert.equal(normalizeNoteRich(rich([block({ align })])).blocks[0].align, align);
  }
});

test('a newline inside a block is flattened to a space', () => {
  // A stray newline in stored text would otherwise smuggle a second, unstyled
  // line into a block the editor cannot address.
  const out = normalizeNoteRich(rich([block({ text: 'one\ntwo\nthree' })]));
  assert.equal(out.blocks[0].text, 'one two three');
  assert.equal(out.blocks.length, 1);
});

test('a note with no usable rich model is parsed back from its plaintext', () => {
  for (const junk of [null, undefined, {}, { blocks: 'no' }, { blocks: 3 }]) {
    const out = normalizeNoteRich(junk, '# Head\nbody');
    assert.deepEqual(out.blocks.map(b => b.text), ['Head', 'body']);
    assert.deepEqual(out.blocks.map(b => b.tag), ['h1', 'p']);
  }
});

test('a rich model with no blocks left still yields one', () => {
  // The renderer and the editor never branch on absence, which is only true if
  // this holds.
  const out = normalizeNoteRich(rich([null, 'nonsense', 7]));
  assert.equal(out.blocks.length, 1);
  assert.equal(out.blocks[0].text, '');
});

test('the plaintext parser and the marker table agree', () => {
  // Read on the *second* line, because an unmarked first line is deliberately
  // h1: a note written before meta.rich existed still reads titled, and
  // NOTE_MARKER.p is the empty string. Checking a bare 'words' on line 0 would
  // be checking that legacy rule, not this one.
  for (const tag of NOTE_TAGS) {
    const [, b] = parseNoteText('first\n' + NOTE_MARKER[tag] + 'words');
    assert.equal(b.tag, tag, `"${NOTE_MARKER[tag]}words" did not parse as ${tag}`);
    assert.equal(b.text, 'words', 'the marker was left in the text');
  }
});

test('an unmarked first line is a title and the rest is body', () => {
  const blocks = parseNoteText('shopping\nmilk\neggs');
  assert.deepEqual(blocks.map(b => b.tag), ['h1', 'p', 'p']);
});

test('a hand-edited file cannot get a novel onto a sticky', () => {
  const long = Array.from({ length: 400 }, (_, i) => block({ text: 'x'.repeat(80) + i }));
  const out = normalizeNoteRich(rich(long));
  assert.ok(flattenNoteRich(out).length <= 4000,
    `the note flattened to ${flattenNoteRich(out).length} characters`);
  assert.ok(out.blocks.length >= 1, 'and it kept at least one block');
});
