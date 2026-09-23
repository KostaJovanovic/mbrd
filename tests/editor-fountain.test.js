// Fountain screenplays in the editor (ui/editor/fountain.ts): the round trip
// that keeps an untouched file's bytes, the forcing marks written only where an
// element would not be recognised without one, and the rules a screenplay is
// typed by - all as pure functions, no browser.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { insertText, deleteRange, outlineOf, wordCount } from '../web/assets/js/ui/editor/model.ts';
import {
  parseFountain, serializeFountain, screenEnter, screenShortcut, setElement, toggleDual, cycleElement,
  nextElement, screenStats, sp,
} from '../web/assets/js/ui/editor/fountain.ts';
import { keepsLocked } from '../web/assets/js/ui/editor/vomit.ts';

const at = (b, o) => ({ b, o });
const els = doc => doc.blocks.map(b => (b.kind === 'sp' ? b.el : b.kind));
const words = b => b.runs.map(r => r.text).join('');

const SCRIPT = [
  'Title: The Draft',
  'Author: Somebody',
  '',
  'INT. KITCHEN - NIGHT',
  '',
  'A kettle screams. MARA crosses to it.',
  '',
  'MARA',
  '(to herself)',
  'Not again.',
  '',
  'TOM (O.S.)',
  'Is it on?',
  '',
  'CUT TO:',
  '',
  '.flashback',
  '',
  '!SHOUTED ACTION',
  '',
  '@McCLANE',
  'Yippee.',
  '',
  'BRICK ^',
  'Me too.',
  '',
  '> THE END <',
  '',
  '# Act two',
  '',
  '= The turn.',
  '',
  '===',
  '',
  '/* an old',
  'scene */',
  '',
  '[[a note]]',
  '',
  '~Sing a song',
  '',
].join('\n');

test('fountain: a script opened and written untouched keeps its bytes', () => {
  for (const src of [SCRIPT, '', 'Just action.', 'Just action.\n', SCRIPT.replaceAll('\n', '\r\n'), '﻿' + SCRIPT]) {
    assert.equal(serializeFountain(parseFountain(src)), src, JSON.stringify(src.slice(0, 40)));
  }
});

test('fountain: every element is read, forcing marks taken off', () => {
  const doc = parseFountain(SCRIPT);
  assert.deepEqual(els(doc), [
    'raw', 'scene', 'action', 'character', 'paren', 'dialogue', 'character', 'dialogue', 'transition',
    'scene', 'action', 'character', 'dialogue', 'character', 'dialogue', 'centered', 'section', 'synopsis',
    'rule', 'raw', 'note', 'lyric',
  ]);
  const b = doc.blocks;
  assert.equal(words(b[10]), 'SHOUTED ACTION');
  assert.equal(words(b[11]), 'McCLANE');
  assert.equal(b[13].dual, true);
  assert.equal(words(b[13]), 'BRICK');
  assert.equal(words(b[15]), 'THE END');
  assert.equal(b[16].level, 1);
  assert.equal(words(b[16]), 'Act two');
});

test('fountain: an edited line gets a forcing mark only where it needs one', () => {
  const write = (...blocks) => serializeFountain({ blocks, tail: [], eol: '\n', bom: false, plain: true });
  assert.equal(write(sp('scene', 'INT. HALL', [])), 'INT. HALL');
  assert.equal(write(sp('scene', 'the moon', [])), '.the moon');
  assert.equal(write(sp('action', 'INT. is a word', [])), '!INT. is a word');
  assert.equal(write(sp('action', 'CUT TO:', [])), '!CUT TO:');
  assert.equal(write(sp('action', 'BANG', []), sp('action', 'It goes off.', [])), '!BANG\nIt goes off.');
  assert.equal(write(sp('character', 'MARA', []), sp('dialogue', 'Hi.', [])), 'MARA\nHi.');
  assert.equal(write(sp('character', 'McCLANE', []), sp('dialogue', 'Hi.', [])), '@McCLANE\nHi.');
  assert.equal(write(sp('character', 'BRICK', [], { dual: true }), sp('dialogue', 'Me.', [])), 'BRICK ^\nMe.');
  assert.equal(write(sp('transition', 'CUT TO:', [])), 'CUT TO:');
  assert.equal(write(sp('transition', 'Fade out.', [])), '> Fade out.');
  assert.equal(write(sp('paren', 'quietly', [])), '(quietly)');
  assert.equal(write(sp('section', 'Act one', [], { level: 2 })), '## Act one');
  // What is written reads back as the same elements.
  const doc = { blocks: [sp('scene', 'the moon', []), sp('action', 'CUT TO:'), sp('character', 'McCLANE'), sp('dialogue', 'Hi.', [])], tail: [], eol: '\n', bom: false, plain: true };
  assert.deepEqual(els(parseFountain(serializeFountain(doc))), ['scene', 'action', 'character', 'dialogue']);
});

test('fountain: an edit rewrites only the line it touched', () => {
  const doc = parseFountain(SCRIPT);
  const e = insertText(doc, at(5, 10), at(5, 10), ' again');
  const out = serializeFountain(e.doc);
  assert.equal(out, SCRIPT.replace('Not again.', 'Not again. again'));
});

test('fountain: Enter opens the element that comes next', () => {
  let doc = parseFountain('INT. HALL\n\nMARA');
  // A line of capitals ended with Enter is a name, and dialogue follows it, joined.
  let e = screenEnter(doc, at(1, 4), at(1, 4), false);
  assert.deepEqual(els(e.doc), ['scene', 'character', 'dialogue']);
  assert.deepEqual(e.doc.blocks[2].before, []);
  doc = insertText(e.doc, e.from, e.from, 'Hello.').doc;
  // Dialogue then Enter: action, a blank line above it.
  e = screenEnter(doc, at(2, 6), at(2, 6), false);
  assert.deepEqual(els(e.doc), ['scene', 'character', 'dialogue', 'action']);
  assert.deepEqual(e.doc.blocks[3].before, ['']);
  assert.equal(serializeFountain(insertText(e.doc, e.from, e.from, 'She leaves.').doc), 'INT. HALL\n\nMARA\nHello.\n\nShe leaves.');
  // Enter on an empty character steps out to action.
  const empty = { ...doc, blocks: [...doc.blocks, sp('character', '')] };
  assert.equal(screenEnter(empty, at(3, 0), at(3, 0), false).doc.blocks[3].el, 'action');
  assert.equal(nextElement('transition'), 'scene');
});

test('fountain: typing formats itself - a scene heading, a parenthetical', () => {
  let doc = parseFountain('');
  doc = insertText(doc, at(0, 0), at(0, 0), 'int. ').doc;
  const scene = screenShortcut(doc, at(0, 5));
  assert.equal(scene.doc.blocks[0].el, 'scene');
  assert.equal(words(scene.doc.blocks[0]), 'INT. ');
  let speech = { ...doc, blocks: [sp('character', 'MARA', []), sp('dialogue', '(', [])] };
  speech = screenShortcut(speech, at(1, 1));
  assert.equal(speech.doc.blocks[1].el, 'paren');
  assert.equal(words(speech.doc.blocks[1]), '()');
  assert.deepEqual(speech.from, at(1, 1));
});

test('fountain: Tab cycles the element, and a line made a name is capitalised', () => {
  assert.equal(cycleElement('action', false), 'character');
  assert.equal(cycleElement('character', true), 'action');
  assert.equal(cycleElement('dialogue', false), 'paren');
  const doc = parseFountain('INT. HALL\n\nmara');
  const e = setElement(doc, at(1, 2), at(1, 2), 'character');
  assert.equal(words(e.doc.blocks[1]), 'MARA');
  const p = setElement(doc, at(1, 0), at(1, 0), 'paren');
  assert.equal(words(p.doc.blocks[1]), '(mara)');
  assert.deepEqual(p.from, at(1, 1));
});

test('fountain: Ctrl+D sets a speech beside the one before it', () => {
  const doc = parseFountain('A\n\nMARA\nHi.\n\nTOM\nHey.');
  const dual = toggleDual(doc, at(4, 2));
  assert.equal(dual.blocks[3].dual, true);
  assert.match(serializeFountain(dual), /TOM \^\nHey\./);
  assert.equal(toggleDual(dual, at(3, 0)).blocks[3].dual, false);
});

test('fountain: the outline holds sections and scenes, and the count estimates pages', () => {
  const doc = parseFountain(SCRIPT);
  assert.deepEqual(outlineOf(doc).map(o => [o.kind, o.level, o.text]), [
    ['scene', 1, 'INT. KITCHEN - NIGHT'], ['scene', 1, 'flashback'], ['section', 1, 'Act two'],
  ]);
  const stats = screenStats(doc);
  assert.equal(stats.scenes, 2);
  // A page break starts a new page.
  assert.equal(stats.pages, 2);
  const long = parseFountain(Array.from({ length: 60 }, (_, n) => `Line ${n}.`).join('\n\n'));
  assert.equal(screenStats(long).pages, 3);
  assert.ok(wordCount(doc) > 20);
});

test('fountain: the Vomit Mode lock holds in a screenplay too', () => {
  const doc = parseFountain('MARA\nHello there.');
  const lock = at(1, 6);
  assert.equal(keepsLocked(doc, setElement(doc, at(0, 0), at(0, 0), 'action').doc, lock), false);
  assert.equal(keepsLocked(doc, deleteRange(doc, at(1, 2), at(1, 4)).doc, lock), false);
  assert.ok(keepsLocked(doc, insertText(doc, at(1, 12), at(1, 12), '!').doc, lock));
});
