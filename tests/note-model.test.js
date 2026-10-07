// The note's formatting model - and the marker colours (`wash`, the
// highlighter) in particular. canvas/note-model.ts is pure and DOM-free,
// but was untested until this file. research/docs/mbrd-format.md promises
// two things: an unmarked block stays byte-for-byte what it was before
// markers existed, and an unknown colour is dropped rather than rounded to
// the nearest one. Both were one-line properties of normalizeBlock(),
// undefended until now.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  normalizeNoteRich, flattenNoteRich, parseNoteText,
  NOTE_WASHES, NOTE_TAGS, NOTE_ALIGNS, NOTE_MARKER,
  richLines, linesRich, linesLength, linesMarkdown, styleAt, sliceLines, deleteRange,
  insertLines, restyle, withPending, tidyRuns, cutRuns, cyrillicLang, markLang,
} from '../web/assets/js/canvas/note-model.ts';

test('a note in Serbian or Macedonian Cyrillic is marked so its italic draws their forms', () => {
  assert.equal(cyrillicLang('Ћао, ђаче'), 'sr', 'a letter only Serbian has');
  assert.equal(cyrillicLang('Ѓорѓи'), 'mk', 'and only Macedonian');
  // Common letters alone say nothing - unless the browser is Serbian.
  assert.equal(cyrillicLang('Добар дан'), '');
  assert.equal(cyrillicLang('Добар дан', 'sr-RS'), 'sr');
  assert.equal(cyrillicLang('Добар дан', 'sr'), 'sr');
  // Russian on a Serbian machine stays Russian: Serbian has no й or ы.
  assert.equal(cyrillicLang('Добрый день', 'sr-RS'), '');
  // Latin is never marked, whatever the locale: the Latin faces have no locl to switch.
  assert.equal(cyrillicLang('Dobar dan', 'sr-Latn-RS'), '');
  assert.equal(cyrillicLang('Добар дан', 'srb'), '', 'a locale that only starts with sr');
});

test('markLang marks a name and takes the mark back off when the name changes', () => {
  const node = { lang: '', removeAttribute(name) { if (name === 'lang') this.lang = ''; } };
  markLang(node, 'Ћирилица');
  assert.equal(node.lang, 'sr');
  markLang(node, 'Latin');
  assert.equal(node.lang, '', 'a rename to Latin leaves no stale mark behind');
});

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
  // Not `wash: null`, not `wash: undefined` - absent. An old board re-saved
  // by a new build must be the same bytes.
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
  // The trip a .mbrd actually makes: serialised into board.json and read
  // back by normalizeNoteRich on the way in.
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
  // The deal meta.text makes to stay portable, so "the marker is missing
  // from the export" is a known answer, not a bug report.
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
  // There is a nearest paragraph and a nearest alignment, but no nearest colour.
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
  // A stray newline would otherwise smuggle a second, unstyled line into a
  // block the editor can't address.
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
  // The renderer and editor never branch on absence, which holds only if this does.
  const out = normalizeNoteRich(rich([null, 'nonsense', 7]));
  assert.equal(out.blocks.length, 1);
  assert.equal(out.blocks[0].text, '');
});

test('the plaintext parser and the marker table agree', () => {
  // Read on the *second* line: an unmarked first line is deliberately h1
  // (so a note from before meta.rich still reads titled), and
  // NOTE_MARKER.p is empty. Line 0 would test that legacy rule, not this one.
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

// ---------------------------------------------------------------------------
// Runs: a line as styled stretches, what the editor restyles
// ---------------------------------------------------------------------------

const TXT = { title: false, font: 'sheet', size: 1 };
const TTL = { ...TXT, title: true };
const run = (text, style = TXT) => ({ ...style, text });
const words = lines => lines.map(l => l.map(r => r.text).join('')).join('\n');

test('a legacy note reads as runs off its tags, and a sub-heading is a smaller title', () => {
  const lines = richLines(normalizeNoteRich(undefined, '# Head\n## Sub\nbody'));
  assert.deepEqual(lines.map(l => l[0].title), [true, true, false]);
  assert.ok(lines[1][0].size < lines[0][0].size, 'the old h2 lost its step down');
  assert.equal(words(lines), 'Head\nSub\nbody');
});

test('runs round-trip through the stored model, and the old fields follow them', () => {
  const lines = [[run('Big', TTL), run(' and small', { ...TXT, wash: 'amber', font: 'serif' })], [run('all title', TTL)]];
  const rich = linesRich(lines, 'center');
  const back = richLines(normalizeNoteRich(JSON.parse(JSON.stringify(rich))));
  assert.deepEqual(back, lines);
  // What an older reader sees: the words, a title where the line is all title.
  assert.deepEqual(rich.blocks.map(b => b.text), ['Big and small', 'all title']);
  assert.deepEqual(rich.blocks.map(b => b.tag), ['p', 'h1']);
  assert.equal(rich.valign, 'top', 'vertical placement is gone from the editor');
  assert.equal(flattenNoteRich(rich), 'Big and small\n# all title');
});

test('a run out of a file is held to the allowlists like a block', () => {
  const rich = normalizeNoteRich({ blocks: [{ runs: [
    { text: 'a\nb', title: 'yes', font: 'comic', size: 99, wash: 'puce' },
  ] }] });
  const [r] = rich.blocks[0].runs;
  assert.deepEqual(r, { text: 'a b', title: false, font: 'sheet', size: 1.8 });
});

test('the cap on a stored note cuts runs as well as text', () => {
  const rich = normalizeNoteRich({ blocks: [{ runs: [run('x'.repeat(400), TTL), run('y'.repeat(400))] }] });
  assert.ok(flattenNoteRich(rich).length <= 512);
  assert.equal(rich.blocks[0].runs.map(r => r.text).join(''), rich.blocks[0].text);
});

test('a selection restyled takes only the characters inside it', () => {
  const lines = [[run('hello world')]];
  const out = restyle(lines, 6, 11, s => ({ ...s, title: true }));
  assert.deepEqual(out, [[run('hello '), run('world', TTL)]]);
  // Across lines, and back again merges into one run.
  const two = restyle([[run('ab')], [run('cd')]], 1, 4, s => ({ ...s, wash: 'olive' }));
  assert.deepEqual(two.map(l => l.map(r => r.wash ?? '-')), [['-', 'olive'], ['olive', '-']]);
  assert.deepEqual(restyle(out, 0, 11, s => ({ ...s, title: false })), [[run('hello world')]]);
});

test('a bare caret sets the look of what is typed next', () => {
  const p = withPending([[run('ab')]], 1, TTL);
  assert.deepEqual(p.lines[0], [run('a'), run('', TTL), run('b')]);
  assert.equal(p.ri, 1);
  // On an empty line the line's own run takes the look.
  const empty = withPending([[run('')]], 0, TTL);
  assert.deepEqual(empty.lines, [[run('', TTL)]]);
  // Left untyped, tidying takes it away again.
  assert.deepEqual(tidyRuns(p.lines[0]), [run('ab')]);
});

test('a marked line keeps its mark through a split and a paste', () => {
  // Enter in the middle of marked words, and plain text pasted into them:
  // a mark drawn across a sentence must not come apart where it was typed.
  const marked = { ...TXT, wash: 'amber' };
  const [left, right] = cutRuns([run('marked words', marked)], 6);
  assert.equal(left[0].wash, 'amber');
  assert.equal(right[0].wash, 'amber');
  const lines = [[run('marked words', marked)]];
  const piece = [[run('x', styleAt(lines, 6))], [run('y', styleAt(lines, 6))]];
  const done = insertLines(lines, 6, piece);
  assert.deepEqual(done.lines.map(l => l.every(r => r.wash === 'amber')), [true, true]);
  assert.equal(words(done.lines), 'markedx\ny words');
  assert.equal(done.end, 9);
});

test('select-all and paste replaces every line', () => {
  // The bug: Ctrl+A then Ctrl+V deleted the lines and then had no line left
  // to paste into.
  const lines = [[run('one', TTL)], [run('two')], [run('three')]];
  const cut = deleteRange(lines, 0, linesLength(lines));
  assert.equal(cut.length, 1);
  assert.equal(linesLength(cut), 0);
  const done = insertLines(cut, 0, [[run('pasted')], [run('text')]]);
  assert.equal(words(done.lines), 'pasted\ntext');
  assert.equal(done.end, linesLength(done.lines));
});

test('deleting across lines joins them, and positions count a newline as one', () => {
  const lines = [[run('ab')], [run('cd', TTL)], [run('ef')]];
  assert.equal(linesLength(lines), 8);
  assert.deepEqual(deleteRange(lines, 1, 7), [[run('af')]]);
  // A Backspace at a line's start is a delete of the newline before it.
  assert.equal(words(deleteRange(lines, 2, 3)), 'abcd\nef');
});

test('a copy keeps its looks, and the look at a caret is the character before it', () => {
  const lines = [[run('plain '), run('bold', TTL)]];
  assert.deepEqual(sliceLines(lines, 4, 8), [[run('n '), run('bo', TTL)]]);
  assert.equal(styleAt(lines, 6).title, false, 'at the seam the caret carries the look before it');
  assert.equal(styleAt(lines, 7).title, true);
  assert.equal(styleAt(lines, 6, true).title, true, 'a selection starting there takes the look after');
});

test('the Markdown a note becomes marks only whole-title lines', () => {
  assert.equal(linesMarkdown([[run('Head', TTL)], [run('mixed '), run('bit', TTL)], [run('', TTL)]]),
    '# Head\nmixed bit\n');
});

test('a hand-edited file cannot get a novel onto a sticky', () => {
  const long = Array.from({ length: 400 }, (_, i) => block({ text: 'x'.repeat(80) + i }));
  const out = normalizeNoteRich(rich(long));
  assert.ok(flattenNoteRich(out).length <= 4000,
    `the note flattened to ${flattenNoteRich(out).length} characters`);
  assert.ok(out.blocks.length >= 1, 'and it kept at least one block');
});
