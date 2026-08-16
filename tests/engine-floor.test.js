// The oldest engine this code may be written for, enforced.
//
// research/docs/browser-support.md names a compatibility floor. Nothing checked
// it, and the cost of that was not a missing nicety - it was one regular
// expression.
//
// `ui/markdown.ts` split a table row on `/(?<!\\)\|/`. WebKit gained lookbehind
// assertions in Safari 16.4, and an unsupported regex literal is an **early**
// SyntaxError: the engine refuses to parse the file containing it before a line
// of it runs. That module is imported by ui/feed.ts and ui/viewer.ts, both of
// which main.ts imports, and esbuild concatenates the whole tree into one
// assets/app.js. So a single expression meant the entire application failed to
// parse on every iOS below 16.4 - no board, no error, a splash screen that
// never lifted. Every graceful degradation written for older engines (the
// capability toast in main.ts, the guarded OffscreenCanvas paths, the
// uncompressed-ZIP write path) was unreachable, because nothing ever got as far
// as running.
//
// The lesson is the shape of the failure rather than the feature. A guarded API
// degrades; a syntax the parser does not know takes the whole bundle with it,
// and it does so silently on the one engine nobody has open. So the constructs
// below are checked as text, in the source, on every run.
//
// ── Adding to the table ──
//
// Put the Safari version beside it. If a construct here becomes safe because
// the floor moved, move the floor in browser-support.md and delete the row -
// those two edits belong in one commit, which is the whole point of naming the
// floor here rather than describing it.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

/** The oldest Safari the source may assume. Keep in step with browser-support.md. */
const FLOOR = 15.0;

/**
 * Constructs that need a newer Safari than the floor, as text.
 *
 * `parse` marks the ones that take the whole bundle down rather than throwing
 * where they are used - the distinction this file exists to draw. A runtime
 * built-in can be feature-detected and worked around at the call site; a syntax
 * error cannot be worked around at all.
 */
const BANNED = [
  { safari: 16.4, parse: true, name: 'regex lookbehind', re: /\(\?<[=!]/ },
  { safari: 17.4, parse: false, name: 'Promise.withResolvers', re: /\bPromise\s*\.\s*withResolvers\b/ },
  { safari: 16.4, parse: true, name: 'class static block', re: /\bstatic\s*\{/ },
  { safari: 15.4, parse: false, name: 'Object.hasOwn', re: /\bObject\s*\.\s*hasOwn\s*\(/ },
  { safari: 15.4, parse: false, name: 'Array.prototype.at', re: /\.\s*at\s*\(\s*-/ },
  { safari: 16.4, parse: false, name: 'Array.prototype.findLast', re: /\.\s*findLast(Index)?\s*\(/ },
  { safari: 16.0, parse: false, name: 'Array.prototype.toSorted/toReversed/with', re: /\.\s*(toSorted|toReversed|toSpliced)\s*\(/ },
  { safari: 17.4, parse: false, name: 'Object.groupBy', re: /\bObject\s*\.\s*groupBy\b/ },
  { safari: 16.4, parse: false, name: 'Array.fromAsync', re: /\bArray\s*\.\s*fromAsync\b/ },
];

/**
 * The source with its prose taken out.
 *
 * Every module in this codebase argues its own design at the top, and several
 * of those arguments are *about* the constructs above - this file included. A
 * scan that read comments would fail on the note explaining why the thing it is
 * looking for is not there.
 *
 * Block comments go wholesale. Line comments only where one starts the line,
 * which is this codebase's style throughout and is the reading that cannot
 * swallow the `//` in a URL sitting inside a string.
 */
const code = (text) => text
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .replace(/^[ \t]*\/\/.*$/gm, '');

/** Every .ts under web/assets/js, which is every module that reaches the bundle. */
function modules(dir, out = []) {
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) modules(path, out);
    else if (name.endsWith('.ts') && !name.endsWith('.d.ts')) out.push(path);
  }
  return out;
}

const SRC = 'web/assets/js';

test('no module uses a construct newer than the stated floor', () => {
  const found = [];
  for (const path of modules(SRC)) {
    const text = code(readFileSync(path, 'utf8'));
    for (const { safari, parse, name, re } of BANNED) {
      if (safari <= FLOOR) continue;
      const at = text.split('\n').findIndex(line => re.test(line));
      if (at >= 0) {
        found.push(`${path}:${at + 1} — ${name} (Safari ${safari}${parse ? ', PARSE ERROR: takes the whole bundle' : ''})`);
      }
    }
  }
  assert.deepEqual(found, [], `constructs above the Safari ${FLOOR} floor:\n${found.join('\n')}`);
});

// The bundle is committed and is what visitors are actually served (wrangler
// serves ./web statically), so it is worth checking on its own terms rather
// than trusting that it was rebuilt. Minification removes the comments, so this
// needs none of the stripping above - and a hit here means the committed bytes
// are broken even if the source has been fixed.
test('the committed bundle carries nothing above the floor either', () => {
  const bundle = readFileSync('web/assets/app.js', 'utf8');
  const found = BANNED
    .filter(({ safari }) => safari > FLOOR)
    .filter(({ re }) => re.test(bundle))
    .map(({ name, safari }) => `${name} (Safari ${safari})`);
  assert.deepEqual(found, [], `web/assets/app.js is stale or broken: ${found.join(', ')}`);
});
