// The TypeScript migration debt, as a number that fell to zero. The tree
// was renamed .js to .ts in one mechanical step - 104 modules, 4,935
// `strict` errors - too large to fix in one commit, so every unannotated
// module carried `// @ts-nocheck` and this file counted them, keeping
// typecheck green and honest rather than red and ignored. Converting a
// module meant deleting its pragma and lowering CEILING in the same
// commit - same idiom as tests/layers.test.js's DEBT map, same rule: the
// list only shrinks. A new module must be written typed; a new pragma is
// new debt, argued here, not skipped.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { JS, WEB, read, walk } from './helpers.js';
import { join } from 'node:path';

/**
 * How many modules are still carried unchecked. May be lowered, never
 * raised. Started at 103 of 105 and is now 0: every module under
 * web/assets/js is checked under strict. At zero this file stops being a
 * ratchet and becomes a plain guard - "no module may carry @ts-nocheck",
 * with no number left to argue about.
 */
const CEILING = 0;

/**
 * The file's leading trivia: every comment and blank line before the first
 * thing tsc would call code. Used to be
 * `read(...).startsWith('// @ts-nocheck')`, which only saw the pragma on
 * byte 0, though tsc honours it anywhere in the leading comments - and
 * every module here opens with a header, so line two was an invisible
 * bypass. Matched the way tsc matches it: the pragma must *open* the
 * comment text, so a header merely discussing `@ts-nocheck` in prose does
 * not count.
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
  // The other direction, making this a ratchet rather than a limit. Used to
  // read `CEILING - unchecked.length < 5`, which stopped meaning anything
  // once CEILING hit 0 (the test above already forces the count to 0, so
  // `0 - 0 < 5` could not fail). At zero the only thing left to guard is
  // the number itself - a raise must be argued for above, not typed in.
  assert.equal(CEILING, 0,
    `CEILING is ${CEILING}. Every module in web/assets/js is checked under `
    + 'strict; raising this is new debt, and the header above is where the case '
    + 'for it goes.');
  assert.equal(unchecked.length, CEILING,
    `${unchecked.length} modules are unchecked but CEILING is ${CEILING}.`);
});

test('nothing claims the pragma without being a module', () => {
  // Guards the walk: a filter matching nothing would pass both tests above
  // while proving nothing.
  assert.ok(walk(JS, ['.ts']).length > 90, 'the module walk found almost nothing');
  for (const rel of unchecked) {
    assert.ok(rel.endsWith('.ts'), `${rel} is not a TypeScript module`);
  }
});
