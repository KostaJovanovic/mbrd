// The stacking ladder, and the bare integers that are not allowed back.
//
// What is in front of what used to be fourteen numbers written in ten
// stylesheets - 20, 21, 24, 25, 30, 40, 41, 50, 55, 59, 60, 61, 70, 90 - with
// nothing naming the ladder and nothing checking it. That is a fault of the same
// shape as a misspelled icon id or a stylesheet missing from APP_CSS_ORDER: it
// fails silently, and it fails only in the one combination that puts the two
// surfaces on screen together. A menu one rung short of the panel it was opened
// from is correct on every board except the one where somebody opens it there.
//
// base.css declares the ladder now - *not* tokens.css, and that is a decision
// rather than a filing choice. tests/appearance.test.js holds ui/look.ts's
// allowlist to exactly what tokens.css declares, in both directions, so a token
// born in tokens.css is a token a saved board file may set. That is right for a
// colour and wrong for a stacking order: `--z-menu: -1` would drop the
// right-click menu below #viewport, which has no z-index of its own, and it
// would stay gone until another board was opened. base.css's banner says
// "Structure only"; what is in front of what is structure. The third test below
// is what keeps the ladder from drifting back.
//
// This is the pair of checks that keeps the ladder a ladder:
//
// **Nothing above the board writes its own number.** A z-index of 20 or more is
// a claim about the app's furniture and belongs to the ladder. Below that is
// local stacking *inside* one component - a card's pen over its label, a seek
// bar over a waveform - which is the component's own business and is not what
// this file is about.
//
// **Every rung is used.** A name in tokens.css that no stylesheet reads is a
// rung somebody added, moved off, and left behind, and the next reader has to
// work out whether it means anything.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { WEB } from './helpers.js';

const CSS = join(WEB, 'assets', 'css');

const sheets = () => readdirSync(CSS).filter(f => f.endsWith('.css')).sort();
const read = name => readFileSync(join(CSS, name), 'utf8');

/**
 * The one place a bare integer is still right, and it is not a stylesheet
 * failing to use the ladder.
 *
 * A selected title card is lifted clear of every other item *within the world*,
 * which is a different stack from the chrome's: #world is its own containing
 * block, so this number is never compared with --z-chrome. It is written large
 * and !important because it has to beat the per-item z the board hands out from
 * the item order, which is unbounded.
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

  // Every sheet, base.css included - #splash reads --z-splash in the same file
  // that declares it. A declaration never contains `var(`, so looking for the
  // reference form is what tells a use from a definition.
  const all = sheets().map(read).join('\n');
  const unused = declared.filter(t => !all.includes(`var(${t})`)).sort();
  assert.deepEqual(unused, [],
    'declared in the ladder and read by no stylesheet');
});

test('the ladder is not a look a board file can set', () => {
  // The half of the decision that a comment cannot hold. tokens.css is the look
  // vocabulary and tests/appearance.test.js makes every name in it settable by
  // a saved board; a rung that drifted back into that file would become a board
  // file's business silently, and the way it fails is a menu that opens behind
  // the board on somebody else's machine.
  const strays = [...read('tokens.css').matchAll(/^\s*(--z-[a-z-]+)\s*:/gm)].map(m => m[1]);
  assert.deepEqual(strays, [],
    'declared in tokens.css, which makes it something a .mbrd file may set - the\n'
    + 'ladder belongs in base.css. See the head of this file.');
});
