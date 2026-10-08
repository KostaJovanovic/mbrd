// Placeholder copy on the pages a visitor reads: lorem ipsum, "[INSERT ...]".
//
// Nothing else would notice one shipping, since the page renders fine with it.
// The credits sheet's holes are filled, so a new one fails the suite.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';

import { WEB, read } from './helpers.js';

const PAGES = ['index.html', 'privacy.html'];

/** Copy that looks like a hole and is somebody's choice. Omar's quote in the
 *  credits sheet is his, as he wrote it. */
const KEPT = ['[INSERT FUNNY QUIP HERE]'];

/** What placeholder copy looks like. Comments are stripped first, so a note to
 *  the author about a hole is not itself a hole. */
const HOLES = [
  /\blorem\b/i,
  /\bipsum\b/i,
  /\[\s*insert\b[^\]]*\]/i,
  /\[\s*(todo|tbd|tk|placeholder|xxx)\b[^\]]*\]/i,
];

/** Every hole on one page, as "page: the match". */
function holes(page) {
  let text = read(join(WEB, page)).replace(/<!--[\s\S]*?-->/g, '');
  for (const kept of KEPT) text = text.replaceAll(kept, '');
  const found = [];
  for (const pattern of HOLES) {
    const m = text.match(pattern);
    if (m) found.push(`${page}: ${m[0]}`);
  }
  return found;
}

test('no page a visitor reads carries placeholder copy', () => {
  const found = PAGES.flatMap(holes);
  assert.deepEqual(found, [], `placeholder copy:\n  ${found.join('\n  ')}`);
});

test('the placeholder patterns catch what they are for', () => {
  // Guards the guard: a pattern that matches nothing makes the test above vacuous.
  const caught = s => HOLES.some(p => p.test(s));
  assert.ok(caught('Lorem ipsum dolor sit amet'));
  assert.ok(caught('[INSERT FUNNY QUIP HERE]'));
  assert.ok(caught('[TODO: a sentence]'));
  assert.ok(!caught('Insert a picture by dropping it'), 'an ordinary sentence is not a hole');
  assert.ok(!caught('[Enter]'), 'a key name in brackets is not a hole');
});
