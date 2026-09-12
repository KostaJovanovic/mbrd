// The stacking ladder: what is in front of what, once named in base.css
// rather than left as fourteen bare integers scattered across stylesheets.
// Fails silently and only when two surfaces meet on screen, same shape as a
// misspelled icon id.
//
// base.css, not tokens.css, on purpose: tokens.css's names are settable from
// a saved board file (tests/appearance.test.js), right for a colour and wrong
// for a stacking order - `--z-menu: -1` could drop a menu behind the board
// until another board was opened. Two checks guard the ladder: nothing above
// the board (z-index >= 20) writes its own number, and every declared rung
// is actually read by a stylesheet.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { WEB } from './helpers.js';

const CSS = join(WEB, 'assets', 'css');

const sheets = () => readdirSync(CSS).filter(f => f.endsWith('.css')).sort();
const read = name => readFileSync(join(CSS, name), 'utf8');

/**
 * The one place a bare integer is still right. A selected title card lifts
 * clear of every other item *within the world*, a separate stack from the
 * chrome's - #world is its own containing block, so this is never compared
 * with --z-chrome. Large and !important to beat the board's unbounded
 * per-item z.
 */
const EXEMPT = [/#world:not\(\.zoom-tiny\) \.item\[data-type="title"\]\.is-selected/];

test('nothing above the board writes its own z-index', () => {
  const stray = [];
  for (const name of sheets()) {
    read(name).split('\n').forEach((line, i) => {
      const m = /z-index:\s*(-?\d+)/.exec(line);
      if (!m || Number(m[1]) < 20) return;
      if (EXEMPT.some(re => re.test(line))) return;
      stray.push(`${name}:${i + 1}  ${line.trim()}`);
    });
  }
  assert.deepEqual(stray, [],
    'a z-index of 20 or more belongs to the ladder in tokens.css - use a --z-* token,\n'
    + 'or calc() off one when a surface genuinely sits a rung over its own');
});

test('every rung the ladder declares is a rung something stands on', () => {
  const declared = [...read('base.css').matchAll(/^\s*(--z-[a-z-]+)\s*:/gm)].map(m => m[1]);
  assert.ok(declared.length >= 9, 'the ladder should still be in base.css');

  // Every sheet, base.css included - #splash reads --z-splash in the same
  // file that declares it. A declaration never contains `var(`, which is what
  // tells a use from a definition.
  const all = sheets().map(read).join('\n');
  const unused = declared.filter(t => !all.includes(`var(${t})`)).sort();
  assert.deepEqual(unused, [],
    'declared in the ladder and read by no stylesheet');
});

test('the ladder is not a look a board file can set', () => {
  // tokens.css is the look vocabulary, settable by a saved board
  // (tests/appearance.test.js); a rung drifting back into it becomes a board
  // file's business silently, and fails as a menu opening behind the board.
  const strays = [...read('tokens.css').matchAll(/^\s*(--z-[a-z-]+)\s*:/gm)].map(m => m[1]);
  assert.deepEqual(strays, [],
    'declared in tokens.css, which makes it something a .mbrd file may set - the\n'
    + 'ladder belongs in base.css. See the head of this file.');
});
