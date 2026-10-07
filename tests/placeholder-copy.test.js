// Placeholder copy on the pages a visitor reads: lorem ipsum, "[INSERT ...]".
//
// The credits sheet carries two such holes for the maintainer's own words.
// Nothing else would notice one shipping, since the page renders fine with
// it. Until 1.0 is crowned (RELEASE_COMMITS in version.js) the test is a todo,
// listed in every run but not failing it; from 1.0 on, a hole fails the suite.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';

import { WEB, read } from './helpers.js';
import { RELEASE_COMMITS } from '../web/assets/js/version.js';

const PAGES = ['index.html', 'privacy.html'];

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
  const text = read(join(WEB, page)).replace(/<!--[\s\S]*?-->/g, '');
  const found = [];
  for (const pattern of HOLES) {
    const m = text.match(pattern);
    if (m) found.push(`${page}: ${m[0]}`);
  }
  return found;
}

const crowned = RELEASE_COMMITS.length > 0;

test('no page a visitor reads carries placeholder copy',
  crowned ? {} : { todo: 'the about line and the quip in the credits sheet are still placeholders' },
  () => {
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
