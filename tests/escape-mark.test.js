// Android's Back sends the page an Escape and asks util.ts's wasClosed() whether
// anything answered (main.ts). A module that closes something on Escape and does
// not call markClosed() leaves Back going to the home screen over an open layer,
// and nothing else would notice. Text, like tests/icons.test.js: nothing to install.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';

import { JS, walk, read } from './helpers.js';

/** Modules whose Escape closes nothing, each with why. */
const CLOSES_NOTHING = new Map([
  // The sidebar's board-name field: Escape puts the old name back in the box,
  // and the global handler that then blurs it is what answers Back. Its inline
  // editor's Escape goes through util.ts's editInline(), which marks.
  ['ui/board-title.ts', 'restores a field, closes no layer'],
]);

test('every module that handles Escape marks the press it closed something on', () => {
  // main.ts sends the Escape, and handles none.
  const handlers = walk(JS, ['.ts'], JS)
    .map(file => file.replaceAll('\\', '/'))
    .filter(file => file !== 'main.ts' && !CLOSES_NOTHING.has(file) && read(join(JS, file)).includes("'Escape'"));
  // Twelve on 2026-09-13 (research/old/apps-tasks-2026-09-13.md, M3). Eleven from
  // 2026-09-14, when the Timeline docked and stopped closing on Escape.
  assert.ok(handlers.length >= 11, `only ${handlers.length} modules handle Escape - has the key moved?`);
  const unmarked = handlers.filter(file => !read(join(JS, file)).includes('markClosed('));
  assert.deepEqual(unmarked, [], `these close something on Escape without markClosed(): ${unmarked.join(', ')}`);
});

test('Back reads the mark, and closes a menu before a dialog', () => {
  const main = read(join(JS, 'main.ts'));
  assert.match(main, /platform\.lifecycle\.onBack\(/, 'main.ts no longer registers the Back handler');
  assert.match(main, /wasClosed\(esc\)/, 'the Back handler no longer reads the Escape mark');
  assert.match(main, /!isMenuOpen\(\)/, 'the Back handler no longer lets a menu close before a dialog');
});
