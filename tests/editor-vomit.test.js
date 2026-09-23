// Vomit Mode's lock (ui/editor/vomit.ts), tested as the plan asks: against the
// pure rules, not against a browser. A change is allowed only if it leaves
// everything before the lock as it was, however it arrived; the lock moves up
// to the caret when a word is finished, and never back.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  insertText, deleteRange, splitBlock, joinBackward, toggleMark, setHeading, toggleTask, blockShortcut,
  insertBlocks, replaceAll,
} from '../web/assets/js/ui/editor/model.ts';
import { parseMarkdown, serializeDoc } from '../web/assets/js/ui/editor/markdown.ts';
import {
  keepsLocked, advance, superLock, lockAtEnd, clampToLock, clock,
} from '../web/assets/js/ui/editor/vomit.ts';

const at = (b, o) => ({ b, o });
const md = text => parseMarkdown(text);

/** Types `text` a character at a time from `caret` as the editor does, the lock following. */
function typeUnder(doc, lock, caret, text) {
  for (const ch of text) {
    const e = ch === '\n' ? splitBlock(doc, caret, caret) : insertText(doc, caret, caret, ch);
    if (!keepsLocked(doc, e.doc, lock)) return { doc, lock, caret, refused: true };
    doc = e.doc;
    caret = e.to;
    lock = advance(doc, lock, caret);
  }
  return { doc, lock, caret, refused: false };
}

test('vomit: a session starts at the end, with everything before it locked', () => {
  const doc = md('# Title\n\nSome words\n');
  assert.deepEqual(lockAtEnd(doc), at(1, 10));
  assert.deepEqual(clampToLock(at(1, 10), at(0, 3)), at(1, 10));
  assert.deepEqual(clampToLock(at(1, 4), at(1, 7)), at(1, 7));
});

test('vomit: typing after the lock is allowed, and a space moves the lock up to it', () => {
  const doc = md('Start\n');
  const s = typeUnder(doc, lockAtEnd(doc), lockAtEnd(doc), ' two words');
  assert.equal(s.refused, false);
  assert.equal(serializeDoc(s.doc), 'Start two words\n');
  // After "two " the lock sat at the start of "words"; mid-word it has not moved on.
  assert.deepEqual(s.lock, at(0, 10));
});

test('vomit: backspace works inside the current word and stops at the lock', () => {
  const doc = md('Start\n');
  let s = typeUnder(doc, at(0, 5), at(0, 5), ' abc');
  assert.deepEqual(s.lock, at(0, 6));
  // Two characters back, inside the word: allowed.
  const back = deleteRange(s.doc, at(0, 7), at(0, 9));
  assert.ok(keepsLocked(s.doc, back.doc, s.lock));
  // One further, onto the space before the word: refused.
  const over = deleteRange(s.doc, at(0, 5), at(0, 6));
  assert.equal(keepsLocked(s.doc, over.doc, s.lock), false);
  // Back to the lock and no further: removing the whole current word is fine.
  s = { ...s, doc: deleteRange(s.doc, at(0, 6), at(0, 9)).doc };
  assert.equal(serializeDoc(s.doc), 'Start \n');
});

test('vomit: Enter moves the lock to the new line, and joining it back is refused', () => {
  const doc = md('Line one\n');
  const s = typeUnder(doc, at(0, 8), at(0, 8), '\n');
  assert.deepEqual(s.lock, at(1, 0));
  const join = joinBackward(s.doc, at(1, 0));
  assert.equal(keepsLocked(s.doc, join.doc, s.lock), false);
});

test('vomit: a paste, a replace-all and a mark reaching behind the lock are refused', () => {
  const doc = md('alpha beta gamma\n');
  const lock = at(0, 11);
  const paste = insertBlocks(doc, at(0, 2), at(0, 4), md('XY').blocks);
  assert.equal(keepsLocked(doc, paste.doc, lock), false);
  assert.equal(keepsLocked(doc, replaceAll(doc, 'beta', 'BETA').doc, lock), false);
  assert.equal(keepsLocked(doc, toggleMark(doc, at(0, 0), at(0, 5), 'b').doc, lock), false);
  // The same mark over unlocked text only is allowed.
  assert.ok(keepsLocked(doc, toggleMark(doc, at(0, 11), at(0, 16), 'b').doc, lock));
});

test('vomit: a locked block cannot change its kind or its tick, but a new line can become a heading', () => {
  const doc = md('- [ ] task\n\nwords\n');
  const lock = at(1, 2);
  assert.equal(keepsLocked(doc, toggleTask(doc, 0), lock), false);
  assert.equal(keepsLocked(doc, setHeading(doc, at(1, 3), at(1, 3), 1).doc, lock), false);
  // After Enter the lock is at a line's start, and `# ` there is still a shortcut.
  const s = typeUnder(doc, at(1, 5), at(1, 5), '\n#');
  const shortcut = blockShortcut(insertText(s.doc, s.caret, s.caret, ' ').doc, at(2, 2));
  assert.ok(shortcut);
  assert.ok(keepsLocked(s.doc, shortcut.doc, s.lock));
  assert.equal(shortcut.doc.blocks[2].kind, 'h');
});

test('vomit: a phone keyboard correction lands with its space and commits', () => {
  // "teh" typed, then the keyboard replaces the word and adds the space at once.
  const doc = md('Once ');
  const s = typeUnder(doc, at(0, 5), at(0, 5), 'teh');
  const fixed = insertText(s.doc, at(0, 5), at(0, 8), 'the ');
  assert.ok(keepsLocked(s.doc, fixed.doc, s.lock));
  const lock = advance(fixed.doc, s.lock, fixed.to);
  assert.deepEqual(lock, at(0, 9));
  // Reverting that correction afterwards reaches behind the lock and is refused.
  const revert = insertText(fixed.doc, at(0, 5), at(0, 9), 'teh ');
  assert.equal(keepsLocked(fixed.doc, revert.doc, lock), false);
});

test('vomit: the lock never moves back, and Super moves it mid-word', () => {
  const doc = md('one two\n');
  assert.deepEqual(advance(doc, at(0, 4), at(0, 2)), at(0, 4));
  assert.deepEqual(advance(doc, at(0, 4), at(0, 6)), at(0, 4));
  assert.deepEqual(superLock(at(0, 4), at(0, 6)), at(0, 6));
  assert.deepEqual(superLock(at(0, 4), at(0, 2)), at(0, 4));
});

test('vomit: nothing changed is always allowed, and the clock reads minutes and seconds', () => {
  const doc = md('words\n');
  assert.ok(keepsLocked(doc, doc, at(0, 5)));
  assert.equal(clock(0), '0:00');
  assert.equal(clock(61_000), '1:01');
  assert.equal(clock(25 * 60_000), '25:00');
  assert.equal(clock(999), '0:01');
});
