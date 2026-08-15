// Why --font-serif-display is still declared, asserted rather than argued.
//
// tokens.css declares --font-serif-display and no rule anywhere reads it. Every
// tool that looks for dead CSS will therefore offer to delete it, and every one
// of them will be wrong - the token is not what keeps Playfair in the app, but
// it is what a saved board may be carrying. A board stores per-token overrides
// (see the pre-paint restore in index.html and safeVars() in ui/look.js), the
// font menus offer Playfair by name, and a face offered by name is a face a
// board can be sitting on years later.
//
// tokens.css already explains this in a comment, and a comment is exactly the
// wrong tool for it: the next person to run a coverage pass over the
// stylesheets will read "no tier reads it", believe the tooling over the prose,
// and take it out. So the reasoning is executable here instead. If Playfair
// ever stops being offered, this test fails and says the token may go - which
// is the other half, and the half a comment could never do.
//
// The audit that asked for this is research/old/visual-audit-2026-08-12.md, item 5
// of its remaining plan: "it wants a test asserting it rather than a comment
// defending it, so the next reader does not delete it."

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
  // The honest statement of the situation: nothing in the CSS reads it. That is
  // not rot, it is the reason the test exists - so assert it, and let the
  // assertion below carry the actual justification.
  // Across the whole cascade, not just tokens.css. Searching the one file the
  // token is *declared* in was the one place a reader could not be: a rule that
  // used it would be in cards.css or chrome.css like every other rule in the
  // app, and this said "nothing reads it" without having looked there.
  const readers = [...appCss().matchAll(/var\(--font-serif-display/g)];
  assert.equal(readers.length, 0,
    'a rule now reads this token, so it defends itself and this file can be simplified');

  // What genuinely keeps it: Playfair is offered by name in both font menus, so
  // a board can be carrying it as a saved override.
  //
  // Comments stripped first. The old check matched 'Playfair' anywhere in
  // appearance.ts, and the module discusses the faces it offers in prose - so
  // deleting the row and leaving the paragraph about it passed.
  const code = appearance.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^[ \t]*\/\/.*$/gm, '');
  assert.match(code, /Playfair/,
    'Playfair is no longer offered in the appearance menu');
  assert.match(fontMenu, /label: 'Playfair'/,
    'Playfair is no longer offered in the font menu - if it is gone from both, --font-serif-display may go too');
});

test('a face offered by name is a face that ships', () => {
  // The rule underneath all of it: a menu may only offer what an @font-face
  // actually loads, or picking it silently falls back and the board is wrong
  // about its own type.
  assert.match(fonts, /font-family:\s*["']?Playfair/i,
    'Playfair is offered in the menus but no @font-face loads it');
});
