// What a board is allowed to do to the interface.
//
// `settings.appearance.vars` is the only part of a .mbrd that reaches the
// browser as CSS rather than as content, and a .mbrd is a file that arrives
// from outside. These are the cases that used to get through, plus the parity
// check that keeps the allowlist honest as tokens.css grows.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';

import { TOKENS, safeVars } from '../web/assets/js/ui/look.js';
import { WEB, read } from './helpers.js';

// ---------------------------------------------------------------------------
// The two attacks
// ---------------------------------------------------------------------------

test('a board cannot set an ordinary CSS property', () => {
  // `display: none` on :root is the whole app gone, the moment the file opens,
  // with no script involved and nothing on screen to explain it.
  assert.deepEqual(safeVars({ display: 'none' }), {});
  assert.deepEqual(safeVars({ 'background-image': 'url(https://example.invalid/x)' }), {});
  assert.deepEqual(safeVars({ position: 'fixed', opacity: '0' }), {});
});

test('a board cannot make the app fetch anything', () => {
  // The privacy claim in the README is "nothing is uploaded". A URL in a token
  // that app.css substitutes somewhere is an outbound request that says the
  // board was opened, and when.
  assert.deepEqual(safeVars({ '--paper': 'url(https://example.invalid/opened)' }), {});
  assert.deepEqual(safeVars({ '--item-bg': 'image-set("https://example.invalid/x" 1x)' }), {});
  assert.deepEqual(safeVars({ '--font-body': 'local(x), url(https://example.invalid/f.woff2)' }), {});
});

test('a value cannot end its own declaration', () => {
  assert.deepEqual(safeVars({ '--paper': 'red; background-image: url(https://example.invalid/x)' }), {});
  assert.deepEqual(safeVars({ '--paper': 'red} :root{display:none' }), {});
  assert.deepEqual(safeVars({ '--paper': 'r\\65 d' }), {});
});

// ---------------------------------------------------------------------------
// ...without breaking a real look
// ---------------------------------------------------------------------------

test('the values a look actually carries all survive', () => {
  const look = {
    '--accent': '#8a4b2a',
    '--paper': 'rgb(245, 238, 224)',
    '--ink-2': 'oklch(0.42 0.03 60)',
    '--radius': '13px',
    '--grid-alpha': '0.18',
    '--density': '1.05',
    '--font-body': "'Geist', system-ui, sans-serif",
    '--shadow-1': '0 1px 2px rgba(0, 0, 0, 0.08)',
    '--ease-back': 'cubic-bezier(0.34, 1.56, 0.64, 1)',
    '--sidebar-w': 'clamp(260px, 30%, 460px)',
    '--select': 'color-mix(in srgb, #8a4b2a 60%, transparent)',
  };
  assert.deepEqual(safeVars(look), look);
});

test('one bad token costs the token, not the look', () => {
  const out = safeVars({ '--accent': '#123456', display: 'none', '--radius': '4px' });
  assert.deepEqual(out, { '--accent': '#123456', '--radius': '4px' });
});

test('non-string values are dropped rather than coerced', () => {
  assert.deepEqual(safeVars({ '--radius': 4 }), {});
  assert.deepEqual(safeVars({ '--radius': null }), {});
  assert.deepEqual(safeVars({ '--radius': { toString: () => 'url(x)' } }), {});
});

test('absent or malformed vars give an empty look', () => {
  assert.deepEqual(safeVars(undefined), {});
  assert.deepEqual(safeVars(null), {});
  assert.deepEqual(safeVars('vars'), {});
});

test('a value cannot be a document', () => {
  assert.deepEqual(safeVars({ '--paper': '#aabbcc '.repeat(40) }), {});
});

// ---------------------------------------------------------------------------
// Drift
// ---------------------------------------------------------------------------

test('the allowlist is exactly the tokens tokens.css declares', () => {
  // The same bargain as sw.js's SHELL. A token added to the stylesheet and not
  // here is one the Appearance panel can set but a saved board silently loses
  // on the way back in; a name here that the stylesheet dropped is a rule
  // guarding nothing. Neither shows up anywhere else.
  const css = read(join(WEB, 'assets', 'css', 'tokens.css'));
  const declared = new Set([...css.matchAll(/^\s*(--[a-z0-9-]+)\s*:/gm)].map(m => m[1]));

  const missing = [...declared].filter(t => !TOKENS.has(t)).sort();
  const stale = [...TOKENS].filter(t => !declared.has(t)).sort();

  assert.deepEqual(missing, [], 'declared in tokens.css but not allowed in a look');
  assert.deepEqual(stale, [], 'allowed in a look but no longer in tokens.css');
});

test('the appearance panel no longer builds a density slider', () => {
  const source = read(join(WEB, 'assets', 'js', 'ui', 'appearance.js'));
  assert.ok(!source.includes("label: 'Panel density'"));
  assert.ok(source.includes("label: 'Panel width'"));
});
