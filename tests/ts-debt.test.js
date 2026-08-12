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
 * commit that renamed the tree.
 */
const CEILING = 103;

const unchecked = walk(JS, ['.ts'])
  .filter(rel => read(join(WEB, rel)).startsWith('// @ts-nocheck'));

test('the unchecked list is no longer than it was', () => {
  assert.ok(unchecked.length <= CEILING,
    `${unchecked.length} modules carry @ts-nocheck but CEILING is ${CEILING}.\n` +
    'A new one is new debt. Type the module instead, or argue for the raise here.');
});

test('the ceiling is not left standing above the real count', () => {
  // The other direction, and the half that makes this a ratchet rather than a
  // limit: convert five modules without lowering CEILING and the number stops
  // describing anything. Kept as a range rather than an equality so that
  // converting a module is one edit and not two - but a gap this wide means the
  // ledger has drifted.
  assert.ok(CEILING - unchecked.length < 5,
    `CEILING is ${CEILING} but only ${unchecked.length} modules are unchecked - ` +
    `lower it to ${unchecked.length} in the commit that converted them.`);
});

test('nothing claims the pragma without being a module', () => {
  // Guards the walk: a filter that matched nothing would let the count fall to
  // zero and pass both tests above while proving nothing at all.
  assert.ok(walk(JS, ['.ts']).length > 90, 'the module walk found almost nothing');
  for (const rel of unchecked) {
    assert.ok(rel.endsWith('.ts'), `${rel} is not a TypeScript module`);
  }
});
