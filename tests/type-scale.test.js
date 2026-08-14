// The type scale, and the pile of literals that is not allowed to grow again.
//
// tokens.css declares five steps - --t-display, --t-title, --t-body, --t-small,
// --t-tiny - and three of them move with the whimsy axis. A `font-size` written
// as a bare pixel value does not move with anything, which is invisible at the
// middle tier (where the literal was copied from) and obvious at both ends.
// That asymmetry is the whole of the fault: the interface was designed at the
// middle and only ever checked there.
//
// research/old/visual-audit-2026-08-12.md item 2 asked for the literals to be
// sorted into three piles rather than converted wholesale - on-scale,
// deliberately off-scale, and never looked at - because most of them should
// stay. Three were on-scale and became tokens; the rest are off-scale on
// purpose and each carries the reason where it sits. The "never looked at" pile
// is empty, and this file is what keeps it that way.
//
// **This is a ratchet, not a ban.** A new literal is not a bug - a glyph in a
// fixed box or a document's reading size is a perfectly good reason for one.
// What is a bug is a new literal that nobody decided. So the count is pinned:
// adding one fails this test, and the fix is to write down why and raise the
// number in the same commit, the same bargain tests/ts-debt.test.js used to
// make.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { WEB } from './helpers.js';

const CSS = join(WEB, 'assets', 'css');

/**
 * Every bare-pixel font-size in the stylesheets, as `file:line`.
 *
 * Bare pixels only, which is the counting rule and the one that matters: an
 * `em`, a `rem`, a `%` or a `clamp()` is relative to something by construction
 * and is not what this is about. Counting those as well gives 55 rather than
 * 24, and sweeps in exactly the values the second pile exists to protect - a
 * miscount that has already led to one wrong conclusion about whether the pile
 * was growing.
 */
function literals() {
  const out = [];
  for (const name of readdirSync(CSS).filter(f => f.endsWith('.css')).sort()) {
    const lines = readFileSync(join(CSS, name), 'utf8').split('\n');
    lines.forEach((line, i) => {
      if (/font-size:\s*[0-9.]+px/.test(line)) out.push(`${name}:${i + 1}`);
    });
  }
  return out;
}

// Raise this only with the reason written at the site, in the same commit.
const CEILING = 24;

test('no font-size literal arrives without a decision', () => {
  const found = literals();
  assert.ok(found.length <= CEILING,
    `${found.length} bare-pixel font-size values, but the ceiling is ${CEILING}.\n`
    + 'A new one is a size nobody chose. Either use a --t-* step, or write down at\n'
    + 'the site why this one is off the scale and raise CEILING here.\n\n'
    + found.join('\n'));
});

test('the ceiling is not left standing above the real count', () => {
  // The other half of the ratchet, and the half that makes it mean anything:
  // convert four of these to tokens without lowering CEILING and the number
  // stops describing the tree. Same guard tests/ts-debt.test.js carries.
  const found = literals();
  assert.ok(CEILING - found.length < 4,
    `CEILING is ${CEILING} but only ${found.length} literals are left - lower it.`);
});

test('the five steps of the scale are all declared', () => {
  // The ratchet above is only worth anything if there is a scale to convert to.
  const tokens = readFileSync(join(CSS, 'tokens.css'), 'utf8');
  for (const step of ['display', 'title', 'body', 'small', 'tiny']) {
    assert.match(tokens, new RegExp(`--t-${step}:\\s*[0-9.]+px`),
      `--t-${step} is no longer declared`);
  }
});

test('the world-space rule is written down where it applies', () => {
  // The largest of the three piles is "world-space type on a card", which is
  // off the chrome scale because a card zooms and --t-* does not - the two
  // agree at exactly one zoom level. ghosts.css states it once for the whole
  // set rather than eight times, so the statement itself is load-bearing: lose
  // it and eight numbers in that file look like oversights again.
  const ghosts = readFileSync(join(CSS, 'ghosts.css'), 'utf8');
  assert.match(ghosts, /off the type scale on purpose/i,
    'ghosts.css no longer says why its sizes are literals');
  assert.match(ghosts, /world space|world-space/i,
    'ghosts.css no longer gives the reason - that its type zooms with the board');
});
