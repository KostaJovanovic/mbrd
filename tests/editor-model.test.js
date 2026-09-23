// The text editor's model and its Markdown round trip (ui/editor/). The
// contract the plan names: a file opened and closed untouched keeps its bytes,
// raw blocks survive an edit elsewhere byte for byte, and every edit is a pure
// function a test can call without a browser.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  insertText, deleteRange, splitBlock, joinBackward, joinForward, toggleMark, setHeading,
  toggleList, indent, toggleTask, blockShortcut, fenceShortcut, inlineShortcut, findAll,
  replaceAll, replaceMatch, wordCount, blockText, marksAt, emptyDoc, insertBlocks, sliceDoc, withRoom,
} from '../web/assets/js/ui/editor/model.ts';
import {
  parseMarkdown, parsePlain, serializeDoc, serializeRuns, inlineRuns, posAtSource,
} from '../web/assets/js/ui/editor/markdown.ts';

const at = (b, o) => ({ b, o });
const md = text => parseMarkdown(text);
const out = doc => serializeDoc(doc);

// ---------------------------------------------------------------------------
// Round trip
// ---------------------------------------------------------------------------

const CORPUS = [
  '',
  'one line',
  'one line\n',
  '\n\n# Title\n\nWords **bold** and _it_ and `code`.\n',
  '# Title #\n\nSetext\n======\n\nAnother\n---\n',
  '- a\n- b\n  - c\n    - d\n- e\n\n1. one\n2. two\n10) ten\n',
  '* star\n+ plus\n\n- [ ] todo\n- [x] done\n',
  '> quoted\n> more\n\n> a\n>\n> b\n',
  '```js title="x"\nconst a = 1;\n\n```\n',
  '~~~~\n```\n~~~~\n',
  '| a | b |\n|---|---|\n| 1 | 2 |\n',
  '---\ntitle: front\n---\n\ntext\n',
  '<div>\n  html\n</div>\n\n[ref]: https://example.com\n[^1]: a note\n',
  '    indented code\n\n    more\n\nafter\n',
  '#### deep heading\n\n***\n\n___\n',
  'Image ![alt](pic.png) and <https://x.com> and [t](https://x.com "title").\n',
  'Trailing spaces  \nhard break\n',
  'CRLF\r\nfile\r\n\r\n- a\r\n',
  'mixed\r\nlines\nhere\n',
  '﻿bom first\n',
  'unclosed\n\n```\ncode forever\n',
  '- item\ncontinued lazily\n\n  indented para\n',
  '===\n',
  'snake_case_word and 2*3*4\n',
  'a\n\n\n\nb\n\n\n',
];

test('every document in the corpus writes back byte for byte', () => {
  for (const text of CORPUS) assert.equal(out(md(text)), text, JSON.stringify(text));
});

test('the room the editor adds around raw blocks writes as nothing', () => {
  for (const text of CORPUS) assert.equal(out(withRoom(md(text))), text, JSON.stringify(text));
  const doc = withRoom(md('| a | b |\n|---|---|\n'));
  assert.deepEqual(doc.blocks.map(b => b.kind), ['p', 'raw', 'p']);
});

test('a .txt writes back byte for byte, line endings and all', () => {
  for (const text of ['', 'a', 'a\n', 'a\r\nb\r\n', '# not a heading\n- nor a list', '﻿x\n\n']) {
    assert.equal(out(parsePlain(text)), text, JSON.stringify(text));
  }
});

test('an edit rewrites only the block it touched', () => {
  const text = '| a | b |\n|---|---|\n| 1 | 2 |\n\npara  **x**\n\n<div>raw</div>\n';
  const doc = md(text);
  const para = doc.blocks.findIndex(b => b.kind === 'p');
  const e = insertText(doc, at(para, 0), at(para, 0), 'New ');
  assert.equal(out(e.doc), '| a | b |\n|---|---|\n| 1 | 2 |\n\nNew para  **x**\n\n<div>raw</div>\n');
});

test('raw blocks are read as raw', () => {
  const kinds = md(CORPUS[10] + '\n' + CORPUS[12]).blocks.map(b => b.kind);
  assert.deepEqual(kinds, ['raw', 'raw', 'raw']);
});

test('blocks are read as the renderer reads them', () => {
  const doc = md(CORPUS[5]);
  assert.deepEqual(doc.blocks.map(b => [b.kind, b.list, b.depth]), [
    ['li', 'bullet', 0], ['li', 'bullet', 0], ['li', 'bullet', 1], ['li', 'bullet', 2], ['li', 'bullet', 0],
    ['li', 'number', 0], ['li', 'number', 0], ['li', 'number', 0],
  ]);
  const tasks = md(CORPUS[6]).blocks.filter(b => b.list === 'task');
  assert.deepEqual(tasks.map(b => [blockText(b), b.checked]), [['todo', false], ['done', true]]);
  const h = md('# C#\n').blocks[0];
  assert.equal(blockText(h), 'C#', 'a closing sequence needs a space before it');
});

// ---------------------------------------------------------------------------
// Inline
// ---------------------------------------------------------------------------

const RUN_CASES = [
  [{ text: 'plain' }],
  [{ text: 'bold', b: true }],
  [{ text: 'a ' }, { text: 'bold', b: true }, { text: ' b' }],
  [{ text: 'bold ', b: true }, { text: 'both', b: true, i: true }],
  [{ text: 'both', b: true, i: true }, { text: ' bold', b: true }],
  [{ text: 'a', b: true }, { text: 'b', i: true }],
  [{ text: 'un' }, { text: 'believ', i: true }, { text: 'able' }],
  [{ text: 'x', i: true }, { text: 'y', b: true, i: true }, { text: 'z', i: true }],
  [{ text: 'gone', s: true }],
  [{ text: 'a `tick` inside', code: true }],
  [{ text: 'see ' }, { text: 'here', href: 'https://x.com' }],
  [{ text: 'bold link', href: 'https://x.com', b: true }, { text: ' after' }],
  [{ text: 'stars * and ** and _under_ and snake_case and [brackets](not) and \\ back' }],
  [{ text: 'wow!' }, { text: 'link', href: 'https://x.com' }],
  [{ text: 'soft\nbreak' }],
  [{ text: '~~not strike~~ and ~ tilde' }],
];

test('runs written as Markdown read back as the same runs', () => {
  for (const runs of RUN_CASES) {
    const text = serializeRuns(runs);
    assert.deepEqual(inlineRuns(text), runs, `${JSON.stringify(runs)} → ${JSON.stringify(text)}`);
  }
});

/** A file opened, typed into at the end of its first block, written and read again. */
const typedAtEnd = (src, words) => {
  const doc = md(src);
  const end = blockText(doc.blocks[0]).length;
  return md(out(insertText(doc, at(0, end), at(0, end), words).doc));
};

test('italic holding an underscore reads back as italic after an edit', () => {
  const back = typedAtEnd('*config_file.yaml* here\n', '!');
  assert.deepEqual(back.blocks[0].runs, [{ text: 'config_file.yaml', i: true }, { text: ' here!' }]);
  for (const words of ['__init__', 'x_', '_x', 'a_b_c']) {
    const runs = [{ text: 'a ' }, { text: words, i: true }, { text: ' b' }];
    assert.deepEqual(inlineRuns(serializeRuns(runs)), runs, words);
  }
});

test('an escaped delimiter inside a mark does not close it', () => {
  assert.deepEqual(inlineRuns('_x\\__ b'), [{ text: 'x_', i: true }, { text: ' b' }]);
  assert.deepEqual(inlineRuns('*a\\*b*'), [{ text: 'a*b', i: true }]);
  assert.deepEqual(inlineRuns('~~a\\~~b~~'), [{ text: 'a~~b', s: true }]);
});

test('brackets in a link label, and a bracket before a link, read back as written', () => {
  for (const runs of [
    [{ text: '[1]', href: 'https://u' }],
    [{ text: 'a]b', href: 'https://u' }],
    [{ text: '[x ' }, { text: 'y', href: 'https://u' }],
    [{ text: 'a [b] ' }, { text: 'c', href: 'https://u' }],
  ]) assert.deepEqual(inlineRuns(serializeRuns(runs)), runs, JSON.stringify(runs));
  const back = typedAtEnd('[\\[1\\]](https://u)\n', '!');
  assert.deepEqual(back.blocks[0].runs, [{ text: '[1]', href: 'https://u' }, { text: '!' }]);
});

test('a paragraph that starts like HTML or a link definition stays a paragraph', () => {
  for (const src of ['\\<b> x\n', '\\<https://a.b> x\n', '\\[x]: y\n']) {
    const back = typedAtEnd(src, '!');
    assert.deepEqual(back.blocks.map(b => b.kind), ['p'], src);
    assert.equal(blockText(back.blocks[0]), src.slice(1, -1) + '!', src);
  }
  // Only the first line can open such a block, so a later one is left alone.
  assert.equal(out(typedAtEnd('a\n<b> c\n', '!')), 'a\n<b> c!\n');
});

test('space at the edge of a mark moves outside it', () => {
  assert.equal(serializeRuns([{ text: 'a' }, { text: ' bold ', b: true }, { text: 'b' }]), 'a **bold** b');
});

test('a paragraph that starts like a block is escaped', () => {
  for (const words of ['# not', '- not', '1. not', '> not', '```not', '---', '===']) {
    const doc = insertText(emptyDoc(), at(0, 0), at(0, 0), words).doc;
    const back = md(out(doc));
    assert.equal(back.blocks[0].kind, 'p', words);
    assert.equal(blockText(back.blocks[0]), words, words);
  }
});

// ---------------------------------------------------------------------------
// Edits
// ---------------------------------------------------------------------------

test('Enter splits a paragraph into two paragraphs', () => {
  const e = splitBlock(md('hello world\n'), at(0, 5), at(0, 5));
  assert.equal(out(e.doc), 'hello\n\n world\n');
  assert.deepEqual(e.from, at(1, 0));
});

test('Enter at the end of a heading starts a paragraph, and after an item another item', () => {
  let e = splitBlock(md('# Head\n'), at(0, 4), at(0, 4));
  assert.equal(e.doc.blocks[1].kind, 'p');
  e = splitBlock(md('- a\n- b\n'), at(0, 1), at(0, 1));
  assert.deepEqual(e.doc.blocks.map(b => b.kind), ['li', 'li', 'li']);
  e = insertText(e.doc, e.from, e.to, 'x');
  assert.equal(out(e.doc), '- a\n- x\n- b\n');
});

test('Enter on an empty item steps out of the list', () => {
  const doc = md('- a\n  - \n');
  let e = splitBlock(doc, at(1, 0), at(1, 0));
  assert.equal(e.doc.blocks[1].depth, 0);
  e = splitBlock(e.doc, at(1, 0), at(1, 0));
  assert.equal(e.doc.blocks[1].kind, 'p');
});

test('Enter twice at the end of code leaves it', () => {
  const doc = fenceShortcut(type('```js').doc, at(0, 5)).doc;
  assert.equal(doc.blocks[0].kind, 'code');
  let e = insertText(doc, at(0, 0), at(0, 0), 'x = 1');
  e = splitBlock(e.doc, e.from, e.to);
  e = splitBlock(e.doc, e.from, e.to);
  assert.deepEqual(e.doc.blocks.map(b => b.kind), ['code', 'p']);
  e = insertText(e.doc, e.from, e.to, 'after');
  assert.equal(out(e.doc), '```js\nx = 1\n```\n\nafter\n');
});

test('Backspace at a block start: a heading becomes text, then text joins the block above', () => {
  const doc = md('one\n\n## two\n');
  let e = joinBackward(doc, at(1, 0));
  assert.equal(e.doc.blocks[1].kind, 'p');
  e = joinBackward(e.doc, at(1, 0));
  assert.equal(blockText(e.doc.blocks[0]), 'onetwo');
  assert.deepEqual(e.from, at(0, 3));
  assert.equal(joinBackward(e.doc, at(0, 0)), null);
});

test('Delete at a block end joins the block below', () => {
  const e = joinForward(md('a\n\nb\n'), at(0, 1));
  assert.equal(out(e.doc), 'ab\n');
});

test('a range across blocks deletes to one block', () => {
  const e = deleteRange(md('first\n\n# mid\n\nlast\n'), at(0, 2), at(2, 2));
  assert.equal(out(e.doc), 'fist\n');
});

test('bold toggles on, then off, over a selection', () => {
  let e = toggleMark(md('hello world\n'), at(0, 0), at(0, 5), 'b');
  assert.equal(out(e.doc), '**hello** world\n');
  e = toggleMark(e.doc, at(0, 0), at(0, 5), 'b');
  assert.equal(out(e.doc), 'hello world\n');
});

test('typing takes the look before the caret, but leaves a link at its end', () => {
  const doc = md('**bold** [link](https://x.com)\n');
  assert.deepEqual(marksAt(doc.blocks[0].runs, 4), { b: true });
  assert.deepEqual(marksAt(doc.blocks[0].runs, 9), {});
  assert.deepEqual(marksAt(doc.blocks[0].runs, 7), { href: 'https://x.com' });
});

test('headings and lists toggle, and back', () => {
  const doc = md('a\n\nb\n');
  let e = setHeading(doc, at(0, 0), at(0, 0), 2);
  assert.equal(out(e.doc), '## a\n\nb\n');
  e = setHeading(e.doc, at(0, 0), at(0, 0), 2);
  assert.equal(out(e.doc), 'a\n\nb\n');
  e = toggleList(doc, at(0, 0), at(1, 1), 'number');
  assert.equal(out(e.doc), '1. a\n2. b\n');
  e = toggleList(e.doc, at(0, 0), at(1, 1), 'number');
  assert.deepEqual(e.doc.blocks.map(b => b.kind), ['p', 'p']);
});

test('Tab nests an item at most one level under the one above', () => {
  const doc = md('- a\n- b\n');
  assert.equal(indent(doc, at(0, 0), at(0, 0), 1), null, 'the first item cannot nest');
  const e = indent(doc, at(1, 0), at(1, 0), 1);
  assert.equal(out(e.doc), '- a\n  - b\n');
  assert.equal(indent(e.doc, at(1, 0), at(1, 0), 1), null);
  assert.equal(out(indent(e.doc, at(1, 0), at(1, 0), -1).doc), '- a\n- b\n');
});

test('a task ticks', () => {
  const doc = toggleTask(md('- [ ] a\n'), 0);
  assert.equal(out(doc), '- [x] a\n');
});

// ---------------------------------------------------------------------------
// Shortcuts
// ---------------------------------------------------------------------------

/** Type `text` one character at a time into block 0 of an empty doc, asking for shortcuts as the view does. */
function type(text, doc = emptyDoc()) {
  let e = { doc, from: at(0, 0), to: at(0, 0) };
  for (const ch of text) {
    e = insertText(e.doc, e.from, e.to, ch);
    if (ch === ' ') e = blockShortcut(e.doc, e.from) ?? e;
    e = inlineShortcut(e.doc, e.from) ?? e;
  }
  return e;
}

test('block markers typed at a line start become what they mean', () => {
  const cases = [['# x', 'h'], ['### x', 'h'], ['- x', 'li'], ['1. x', 'li'], ['[ ] x', 'li'], ['- [ ] x', 'li'], ['> x', 'quote']];
  for (const [text, kind] of cases) {
    const e = type(text);
    assert.equal(e.doc.blocks[0].kind, kind, text);
    assert.equal(blockText(e.doc.blocks[0]), 'x', text);
  }
  assert.equal(type('#### x').doc.blocks[0].kind, 'p', 'only three heading levels');
  assert.equal(type('a # x').doc.blocks[0].kind, 'p', 'only at the start');
});

test('inline markers typed out become the look', () => {
  assert.equal(out(type('a **bold** b').doc), 'a **bold** b\n');
  assert.deepEqual(type('a **bold**').doc.blocks[0].runs, [{ text: 'a ' }, { text: 'bold', b: true }]);
  assert.deepEqual(type('*it*').doc.blocks[0].runs, [{ text: 'it', i: true }]);
  assert.deepEqual(type('`c`').doc.blocks[0].runs, [{ text: 'c', code: true }]);
  assert.deepEqual(type('~~s~~').doc.blocks[0].runs, [{ text: 's', s: true }]);
  assert.deepEqual(type('2*3*').doc.blocks[0].runs, [{ text: '2*3*' }], 'not inside a word');
});

test('a .txt takes no shortcuts and no marks', () => {
  const e = type('# x **y**', parsePlain(''));
  assert.equal(out(e.doc), '# x **y**');
});

// ---------------------------------------------------------------------------
// Paste and copy
// ---------------------------------------------------------------------------

test('one pasted paragraph goes in as words, keeping the block it lands in', () => {
  const doc = md('# Head line\n');
  const e = insertBlocks(doc, at(0, 5), at(0, 5), md('**big** ').blocks);
  assert.equal(out(e.doc), '# Head **big** line\n');
});

test('several pasted blocks split the block and join its halves', () => {
  const e = insertBlocks(md('start end\n'), at(0, 6), at(0, 6), md('one\n\n- two\n\nthree').blocks);
  assert.equal(out(e.doc), 'start one\n\n- two\n\nthreeend\n');
  assert.deepEqual(e.from, at(2, 5));
});

test('a copy is the selection as Markdown, whole blocks as written', () => {
  const doc = md('a **bold** word\n\n| t | u |\n|---|---|\n\nlast line\n');
  assert.equal(out(sliceDoc(doc, at(0, 2), at(2, 4))), '**bold** word\n\n| t | u |\n|---|---|\n\nlast');
});

// ---------------------------------------------------------------------------
// Find, replace, count
// ---------------------------------------------------------------------------

test('find is case-blind unless asked, and never matches inside raw source', () => {
  const doc = md('Cat cat ![cat](cat.png)\n\n```\ncat\n```\n');
  assert.equal(findAll(doc, 'cat').length, 3);
  assert.equal(findAll(doc, 'cat', true).length, 2);
});

test('replace all keeps the look of what it replaces', () => {
  const { doc, count } = replaceAll(md('a **cat** and a cat\n'), 'cat', 'dog');
  assert.equal(count, 2);
  assert.equal(out(doc), 'a **dog** and a dog\n');
  const one = replaceMatch(md('x y x\n'), { b: 0, from: 4, to: 5 }, 'z');
  assert.equal(out(one.doc), 'x y z\n');
});

test('a case-blind find keeps its offsets where lower case is longer', () => {
  // 'İ'.toLowerCase() is two units, which moved every match after it by one.
  const doc = md('İstanbul foo bar\n');
  assert.deepEqual(findAll(doc, 'FOO'), [{ b: 0, from: 9, to: 12 }]);
  assert.equal(out(replaceAll(doc, 'foo', 'X').doc), 'İstanbul X bar\n');
});

test('words are counted', () => {
  assert.equal(wordCount(md('# One two\n\nthree-four, five’s\n\n| six |\n')), 5);
});

test('a place in the source finds its place in the document', () => {
  const doc = md('# Title\nline one\nline two\n');
  assert.deepEqual(posAtSource(doc, 0, 4), at(0, 2));
  assert.deepEqual(posAtSource(doc, 2, 3), at(1, 12));
});
