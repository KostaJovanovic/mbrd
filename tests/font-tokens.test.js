// Why --font-serif-display is still declared, asserted rather than argued.
//
// tokens.css declares --font-serif-display but no rule reads it, so any
// dead-CSS tool will offer to delete it - wrongly. It's what a saved board
// may be carrying: boards store per-token overrides, the font menus offer
// Playfair by name, and a face offered by name is one a board can sit on
// for years. A comment saying so is the wrong tool, since a coverage pass
// would trust the tooling over the prose - so the reasoning is executable
// here instead, and fails if Playfair ever stops being offered.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';

import { WEB, JS, read, appCss } from './helpers.js';

const tokens = read(join(WEB, 'assets', 'css', 'tokens.css'));
const fonts = read(join(WEB, 'assets', 'css', 'fonts.css'));
const appearance = read(join(JS, 'ui', 'appearance.ts'));
const fontMenu = read(join(JS, 'ui', 'fonts.ts'));

test('--font-serif-display is declared, and stays declared', () => {
  assert.match(tokens, /--font-serif-display:/,
    'the token is gone. If that was deliberate, the test below explains what else had to go with it');
});

test('the token is kept by the font menus, not by a stylesheet rule', () => {
  // Nothing in the CSS reads it - not rot, but the reason this test exists.
  // Searched across the whole cascade, not just tokens.css: a rule using it
  // would live in cards.css or chrome.css like everything else, and this
  // used to say "nothing reads it" without looking there.
  const readers = [...appCss().matchAll(/var\(--font-serif-display/g)];
  assert.equal(readers.length, 0,
    'a rule now reads this token, so it defends itself and this file can be simplified');

  // What genuinely keeps it: Playfair is offered by name in both font
  // menus, so a board can carry it as a saved override.
  //
  // Comments stripped first - the old check matched 'Playfair' anywhere in
  // appearance.ts, so deleting the row and leaving a paragraph about it passed.
  const code = appearance.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^[ \t]*\/\/.*$/gm, '');
  assert.match(code, /Playfair/,
    'Playfair is no longer offered in the appearance menu');
  assert.match(fontMenu, /label: 'Playfair'/,
    'Playfair is no longer offered in the font menu - if it is gone from both, --font-serif-display may go too');
});

test('a face offered by name is a face that ships', () => {
  // The rule underneath it all: a menu may only offer what an @font-face
  // actually loads, or picking it silently falls back.
  assert.match(fonts, /font-family:\s*["']?Playfair/i,
    'Playfair is offered in the menus but no @font-face loads it');
});
