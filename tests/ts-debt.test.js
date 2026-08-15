// The TypeScript migration debt, as a number that may only fall.
//
// The tree was renamed from .js to .ts in one mechanical step: 104 modules, no
// annotations, 4,935 errors under `strict`. Fixing all of that before committing
// would have meant one enormous unreviewable change, and leaving `npm run
// typecheck` red would have meant a check nobody reads - which is worse than no
// check, because it looks like one.
//
// So every module that has not been annotated yet carries `// @ts-nocheck` and
// is skipped, and this file counts them. That makes the typecheck green and
// honest at the same time: what it says is "everything not on this list is
// clean under strict", which is true, useful, and gets truer as the list
// shrinks.
//
// Converting a module means deleting its pragma block and fixing what tsc then
// says. Lower CEILING in the same commit. It is the same idiom as the DEBT map
// in tests/layers.test.js and it has the same one rule: the list can only
// shrink. If you are adding a NEW module, write it typed - a new pragma is a
// new debt, and this test is where that argument has to be had rather than
// where it can be skipped.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { JS, WEB, read, walk } from './helpers.js';
import { join } from 'node:path';

/**
 * How many modules are still carried unchecked.
 *
 * This number may be lowered and never raised. It started at 103 of 105 on the
 * commit that renamed the tree and it is 0: every module in web/assets/js is
 * checked under strict, so `npm run typecheck` now means what it says about all
 * of them rather than about everything except a list.
 *
 * Zero is the interesting value, because from here this file stops being a
 * ratchet and becomes a plain guard. The first test below now reads "no module
 * may carry @ts-nocheck" with no number left to argue about, so a pragma cannot
 * be added quietly to get a change through - it fails the suite. That is what
 * the counting was for.
 */
const CEILING = 0;

/**
 * The file's leading trivia: every comment and blank line before the first
 * thing tsc would call code.
 *
 * This used to be `read(...).startsWith('// @ts-nocheck')`, which only ever saw
 * the pragma on byte 0 - and tsc honours it anywhere in a file's leading
 * comments. Every module in this codebase opens with a header comment arguing
 * its own design, so the house style was itself the bypass: put the pragma on
 * line two and the module is excused from strict while staying invisible to
 * both ratchets below.
 *
 * Matched the way tsc matches it - the pragma has to *open* the comment text,
 * so `// @ts-nocheck` counts and `// under @ts-nocheck, which hides the errors`
 * does not. Three module headers here discuss the pragma in prose; a plain
 * substring search would call all three unchecked and the guard would be
 * shouting about files that are fine.
 */
const leadingTrivia = src => {
  let i = 0;
  for (;;) {
    while (i < src.length && /\s/.test(src[i])) i++;
    if (src.startsWith('//', i)) {
      const nl = src.indexOf('\n', i);
      i = nl === -1 ? src.length : nl + 1;
    } else if (src.startsWith('/*', i)) {
      const end = src.indexOf('*/', i + 2);
      if (end === -1) return src;
      i = end + 2;
    } else return src.slice(0, i);
  }
};

const PRAGMA = /^[ \t]*(?:\/\/\/?|\/\*+|\*)?[ \t]*@ts-nocheck\b/m;

const unchecked = walk(JS, ['.ts'])
  .filter(rel => PRAGMA.test(leadingTrivia(read(join(WEB, rel)))));

test('the unchecked list is no longer than it was', () => {
  assert.ok(unchecked.length <= CEILING,
    `${unchecked.length} modules carry @ts-nocheck but CEILING is ${CEILING}.\n` +
    'A new one is new debt. Type the module instead, or argue for the raise here.');
});

test('the ceiling is not left standing above the real count', () => {
  // The other direction, and the half that makes this a ratchet rather than a
  // limit.
  //
  // It read `CEILING - unchecked.length < 5` while the migration was running,
  // which stopped meaning anything the moment CEILING reached 0: the test above
  // already forces the count to 0, so `0 - 0 < 5` could not fail. At zero the
  // ratchet is finished and the only thing left to guard is the number itself,
  // so that is what this asserts - a raise has to be argued for in the header
  // above rather than typed into the constant.
  assert.equal(CEILING, 0,
    `CEILING is ${CEILING}. Every module in web/assets/js is checked under `
    + 'strict; raising this is new debt, and the header above is where the case '
    + 'for it goes.');
  assert.equal(unchecked.length, CEILING,
    `${unchecked.length} modules are unchecked but CEILING is ${CEILING}.`);
});

test('nothing claims the pragma without being a module', () => {
  // Guards the walk: a filter that matched nothing would let the count fall to
  // zero and pass both tests above while proving nothing at all.
  assert.ok(walk(JS, ['.ts']).length > 90, 'the module walk found almost nothing');
  for (const rel of unchecked) {
    assert.ok(rel.endsWith('.ts'), `${rel} is not a TypeScript module`);
  }
});
