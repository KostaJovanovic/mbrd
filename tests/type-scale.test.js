// The type scale, and the pile of literals not allowed to grow again.
// tokens.css declares five steps (--t-display/title/body/small/tiny),
// three moving with the whimsy axis; a bare-pixel font-size moves with
// nothing, invisible at the middle tier and obvious at both ends.
// research/old/visual-audit-2026-08-12.md sorted the literals into three piles -
// on-scale (now tokens), deliberately off-scale (reason at the site), and
// never looked at (now empty). **A ratchet, not a ban**: a new literal is
// not a bug, but an undecided one is - the count is pinned, and raising it
// needs a written reason in the same commit, the tests/ts-debt.test.js bargain.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { WEB } from './helpers.js';

const CSS = join(WEB, 'assets', 'css');

/**
 * Every bare-pixel font-size in the stylesheets, as `file:line`. Bare
 * pixels only: an `em`, `rem`, `%` or `clamp()` is relative by construction
 * and not what this is about. Counting those too gives 55 rather than 24,
 * sweeping in exactly the values the second pile protects.
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
  // The half that makes the ratchet mean anything: convert four of these
  // without lowering CEILING and the number stops describing the tree.
  // Same guard tests/ts-debt.test.js carries.
  const found = literals();
  assert.ok(CEILING - found.length < 4,
    `CEILING is ${CEILING} but only ${found.length} literals are left - lower it.`);
});

test('the five steps of the scale are all declared', () => {
  // The ratchet above is only worth anything if a scale exists to convert to.
  const tokens = readFileSync(join(CSS, 'tokens.css'), 'utf8');
  for (const step of ['display', 'title', 'body', 'small', 'tiny']) {
    assert.match(tokens, new RegExp(`--t-${step}:\\s*[0-9.]+px`),
      `--t-${step} is no longer declared`);
  }
});

test('the world-space rule is written down where it applies', () => {
  // The largest pile is "world-space type on a card": off the chrome scale
  // because a card zooms and --t-* does not, agreeing at exactly one zoom
  // level. ghosts.css states it once for the whole set - lose that
  // statement and eight numbers look like oversights again.
  const ghosts = readFileSync(join(CSS, 'ghosts.css'), 'utf8');
  assert.match(ghosts, /off the type scale on purpose/i,
    'ghosts.css no longer says why its sizes are literals');
  assert.match(ghosts, /world space|world-space/i,
    'ghosts.css no longer gives the reason - that its type zooms with the board');
});
