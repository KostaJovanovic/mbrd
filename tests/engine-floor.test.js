// The oldest engine this code may be written for, enforced.
//
// research/docs/browser-support.md names a compatibility floor; nothing
// checked it, and the cost was one regex: `ui/markdown.ts` used a lookbehind
// unsupported before Safari 16.4, an early SyntaxError that fails to parse
// the whole bundle before any line runs - no board, no error, every graceful
// degradation unreachable because nothing got as far as running.
//
// A guarded API degrades; a syntax the parser doesn't know takes the whole
// bundle down silently. So the constructs below are checked as text on every run.
//
// Adding a row: put the Safari version beside it. If a construct becomes
// safe because the floor moved, move the floor in browser-support.md and
// delete the row in the same commit.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

/** The oldest Safari the source may assume. Keep in step with browser-support.md. */
const FLOOR = 15.0;

/**
 * Constructs that need a newer Safari than the floor, as text.
 *
 * `parse` marks the ones that take the whole bundle down rather than
 * throwing where used: a runtime built-in can be feature-detected and
 * worked around; a syntax error cannot be worked around at all.
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
 * The source with its prose taken out. Every module argues its own design at
 * the top, sometimes about the very constructs above (this file included),
 * so a scan that read comments could fail on the explanation itself.
 *
 * Block comments go wholesale; line comments only where one starts the
 * line, which can't swallow a `//` inside a string.
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

// The bundle is committed and is what visitors are served (wrangler serves
// ./web statically), so it's worth checking directly rather than trusting a
// rebuild. Minification removes comments, so no stripping needed here - a
// hit means the committed bytes are broken even if the source is fixed.
test('the committed bundle carries nothing above the floor either', () => {
  const bundle = readFileSync('web/assets/app.js', 'utf8');
  const found = BANNED
    .filter(({ safari }) => safari > FLOOR)
    .filter(({ re }) => re.test(bundle))
    .map(({ name, safari }) => `${name} (Safari ${safari})`);
  assert.deepEqual(found, [], `web/assets/app.js is stale or broken: ${found.join(', ')}`);
});
