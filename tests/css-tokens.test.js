// The stylesheets' named scales, and the literals each one keeps from growing
// back: the type scale, the spacing rhythm, the stacking ladder, and the one
// font token no rule reads. Every failure here is silent on screen - a size
// that moves with nothing, a gap nobody chose, a menu behind the board - so
// each scale is held by what reads it rather than by a comment.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { JS, WEB, appCss } from './helpers.js';

const CSS = join(WEB, 'assets', 'css');
const sheets = () => readdirSync(CSS).filter(f => f.endsWith('.css')).sort();
const sheet = name => readFileSync(join(CSS, name), 'utf8');

/** Every line of every stylesheet, as [name, 1-based line number, text]. */
function* lines() {
  for (const name of sheets()) {
    const all = sheet(name).split('\n');
    for (let i = 0; i < all.length; i++) yield [name, i + 1, all[i]];
  }
}

// ---------------------------------------------------------------------------
// The type scale
// ---------------------------------------------------------------------------
// tokens.css declares five steps, three moving with the whimsy axis; a
// bare-pixel font-size moves with nothing, invisible at the middle tier and
// obvious at both ends. **A ratchet, not a ban**: a new literal is not a bug,
// but an undecided one is. The count is pinned, and raising it needs a written
// reason in the same commit, the tests/ts-debt.test.js bargain.

/** Bare pixels only: em, rem, % and clamp() are relative by construction.
 *  Counting those too gives 55 rather than 24, sweeping in exactly the values
 *  deliberately off the scale. */
const fontLiterals = () =>
  [...lines()].filter(([, , text]) => /font-size:\s*[0-9.]+px/.test(text)).map(([n, i]) => `${n}:${i}`);

// Raise this only with the reason written at the site, in the same commit.
const FONT_CEILING = 24;

test('no font-size literal arrives without a decision', () => {
  const found = fontLiterals();
  assert.ok(found.length <= FONT_CEILING,
    `${found.length} bare-pixel font-size values, but the ceiling is ${FONT_CEILING}.\n`
    + 'A new one is a size nobody chose. Either use a --t-* step, or write down at\n'
    + 'the site why this one is off the scale and raise FONT_CEILING here.\n\n'
    + found.join('\n'));
});

test('the font-size ceiling is not left standing above the real count', () => {
  // Convert four without lowering it and the number stops describing the tree.
  const found = fontLiterals();
  assert.ok(FONT_CEILING - found.length < 4,
    `FONT_CEILING is ${FONT_CEILING} but only ${found.length} literals are left - lower it.`);
});

test('the five steps of the type scale are all declared', () => {
  const tokens = sheet('tokens.css');
  for (const step of ['display', 'title', 'body', 'small', 'tiny']) {
    assert.match(tokens, new RegExp(`--t-${step}:\\s*[0-9.]+px`), `--t-${step} is no longer declared`);
  }
});

test('the world-space rule is written down where it applies', () => {
  // The largest pile is type on a card: off the chrome scale because a card
  // zooms and --t-* does not. ghosts.css states it once for the whole set;
  // lose that and eight numbers look like oversights again.
  const ghosts = sheet('ghosts.css');
  assert.match(ghosts, /off the type scale on purpose/i, 'ghosts.css no longer says why its sizes are literals');
  assert.match(ghosts, /world space|world-space/i,
    'ghosts.css no longer gives the reason - that its type zooms with the board');
});

// ---------------------------------------------------------------------------
// The spacing rhythm
// ---------------------------------------------------------------------------
// Every pixel gap is 2, 4, 6, 8 or 12; thirteen values were in use before.
// A 1px gap is a seam, not spacing: the hairline between waveform bars.

const RHYTHM = new Set([0, 1, 2, 4, 6, 8, 12]);

/** Every bare-pixel gap, row-gap and column-gap value. A declaration is
 *  checked only when every part is a plain length; var() and calc() scale. */
function gaps() {
  const out = [];
  for (const [name, i, text] of lines()) {
    for (const decl of text.matchAll(/(?:^|[\s;{])(?:row-|column-)?gap\s*:\s*([^;}]+)/g)) {
      const parts = decl[1].trim().split(/\s+/);
      if (!parts.every(p => /^\d+(\.\d+)?(px)?$/.test(p))) continue;
      for (const p of parts) out.push({ at: `${name}:${i}`, px: parseFloat(p) });
    }
  }
  return out;
}

test('every pixel gap is on the rhythm', () => {
  const found = gaps();
  // A regex that stopped matching would pass with nothing in it.
  assert.ok(found.length > 100, `only ${found.length} gaps found - has the pattern stopped matching?`);
  assert.deepEqual(found.filter(g => !RHYTHM.has(g.px)).map(g => `${g.at} ${g.px}px`), [],
    'A gap off 2/4/6/8/12. Pick the nearest step, and look at it on screen.');
});

// ---------------------------------------------------------------------------
// The stacking ladder
// ---------------------------------------------------------------------------
// Named in base.css, not tokens.css: tokens.css's names are settable from a
// saved board (tests/appearance.test.js), right for a colour and wrong for a
// stacking order, where `--z-menu: -1` would drop a menu behind the board.

/** The one place a bare integer is still right. A selected title card lifts
 *  clear of every other item inside #world, its own containing block, so it is
 *  never compared with --z-chrome; the selection rings sit one rung over it. */
const Z_EXEMPT = [
  /#world:not\(\.zoom-far\) \.item\[data-type="title"\]\.is-selected/,
  /z-index: 1000000; \/\* #item-rings \*\//,
];

test('nothing above the board writes its own z-index', () => {
  const stray = [];
  for (const [name, i, text] of lines()) {
    const m = /z-index:\s*(-?\d+)/.exec(text);
    if (!m || Number(m[1]) < 20 || Z_EXEMPT.some(re => re.test(text))) continue;
    stray.push(`${name}:${i}  ${text.trim()}`);
  }
  assert.deepEqual(stray, [],
    'a z-index of 20 or more belongs to the ladder in base.css - use a --z-* token,\n'
    + 'or calc() off one when a surface genuinely sits a rung over its own');
});

test('every rung the ladder declares is a rung something stands on', () => {
  const declared = [...sheet('base.css').matchAll(/^\s*(--z-[a-z-]+)\s*:/gm)].map(m => m[1]);
  assert.ok(declared.length >= 9, 'the ladder should still be in base.css');
  // A declaration never contains `var(`, which tells a use from a definition.
  const all = sheets().map(sheet).join('\n');
  assert.deepEqual(declared.filter(t => !all.includes(`var(${t})`)).sort(), [],
    'declared in the ladder and read by no stylesheet');
});

test('the ladder is not a look a board file can set', () => {
  const strays = [...sheet('tokens.css').matchAll(/^\s*(--z-[a-z-]+)\s*:/gm)].map(m => m[1]);
  assert.deepEqual(strays, [],
    'declared in tokens.css, which makes it something a .mbrd file may set - the\n'
    + 'ladder belongs in base.css. See the stacking section of this file.');
});

// ---------------------------------------------------------------------------
// --font-serif-display
// ---------------------------------------------------------------------------
// Declared and read by no rule, so any dead-CSS tool offers to delete it,
// wrongly: boards store per-token overrides, the font menus offer Playfair by
// name, and a face offered by name is one a board can sit on for years. The
// reasoning is executable here so a coverage pass cannot trust tooling over prose.

test('--font-serif-display is declared, and kept by the font menus rather than a rule', () => {
  assert.match(sheet('tokens.css'), /--font-serif-display:/,
    'the token is gone. If that was deliberate, Playfair has to leave both font menus with it');
  assert.equal([...appCss().matchAll(/var\(--font-serif-display/g)].length, 0,
    'a rule now reads this token, so it defends itself and this test can be simplified');

  // Comments stripped: a paragraph about a deleted row must not pass.
  const appearance = readFileSync(join(JS, 'ui', 'appearance.ts'), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '').replace(/^[ \t]*\/\/.*$/gm, '');
  assert.match(appearance, /Playfair/, 'Playfair is no longer offered in the appearance menu');
  assert.match(readFileSync(join(JS, 'ui', 'fonts.ts'), 'utf8'), /label: 'Playfair'/,
    'Playfair is no longer offered in the font menu - if it is gone from both, --font-serif-display may go too');
});

test('a face offered by name is a face that ships', () => {
  // A menu may only offer what an @font-face loads, or picking it falls back.
  assert.match(sheet('fonts.css'), /font-family:\s*["']?Playfair/i,
    'Playfair is offered in the menus but no @font-face loads it');
});
