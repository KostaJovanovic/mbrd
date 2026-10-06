// The dark sheet: tokens.css section 3c and darkSheet() in ui/pigments.ts.
// The blocks are pasted from tools/gen-dark-palettes.mjs and may be tuned by
// eye, so this holds what tuning must not lose - a twin for every palette at
// every tier, and the contrast floors - rather than the bytes. Dynamic and
// hand-picked palettes go through darkSheet() live, so it is held to the same.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';

import { WEB, read } from './helpers.js';
import { contrast, darkSheet, paletteFromAccent, paletteFor } from '../web/assets/js/ui/pigments.ts';
import { oklch } from '../web/assets/js/color.ts';

const css = read(join(WEB, 'assets', 'css', 'tokens.css')).replace(/\/\*[\s\S]*?\*\//g, '');
const palettes = ['', ...[...css.matchAll(/^:root\[data-palette="([a-z0-9-]+)"\]\s*\{/gm)].map(m => m[1])];

/** Every literal a dark block declares, keyed by token, last block winning. */
function dark(tier, name) {
  const sel = `:root[data-scheme="dark"]${tier === 1 ? '' : `[data-whimsy="${tier}"]`}`
    + (name ? `[data-palette="${name}"]` : '');
  const out = {};
  for (const m of css.matchAll(/^(:root[^{]*?)\s*\{([^}]*)\}/gm)) {
    if (m[1].trim() !== sel) continue;
    for (const d of m[2].matchAll(/(--[a-z0-9-]+):\s*(#[0-9a-f]{6})\s*;/gi)) out[d[1]] = d[2];
  }
  return out;
}

const L = hex => oklch(...[1, 3, 5].map(i => parseInt(hex.slice(i, i + 2), 16))).L;

/** The floors a light palette is held to, held the other way. */
function legible(vars, where) {
  assert.ok(contrast(vars['--ink'], vars['--paper']) >= 7, `${where}: --ink under 7:1`);
  assert.ok(contrast(vars['--ink-2'], vars['--paper']) >= 4.5, `${where}: --ink-2 under 4.5:1`);
  assert.ok(contrast(vars['--accent-text'], vars['--paper']) >= 4.5, `${where}: --accent-text unreadable`);
  assert.ok(contrast(vars['--accent'], vars['--accent-fg']) >= 4.5, `${where}: the label on the accent`);
  assert.ok(L(vars['--paper']) < 0.3, `${where}: the sheet is not dark`);
  assert.ok(L(vars['--paper-card']) > L(vars['--paper']), `${where}: a card sinks under the sheet`);
}

test('every palette has a dark twin at every tier, and each one reads', () => {
  assert.ok(palettes.length >= 4, `only ${palettes.length} palettes found - has the block shape moved?`);
  for (const tier of [0, 1, 2]) {
    for (const name of palettes) {
      const where = `${name || 'papyrus'} at ${tier}`;
      const vars = dark(tier, name);
      assert.equal(Object.keys(vars).length, 15, `${where}: the dark block is missing or partial`);
      legible(vars, where);
    }
  }
});

test('a Dynamic or hand-picked palette is dark by the same rules', () => {
  for (const tier of [0, 1, 2]) {
    for (const picked of ['#3355ff', '#d4c21a', '#c2185b', '#00897b']) {
      legible(darkSheet(paletteFromAccent(picked, { tier }), tier), `${picked} at ${tier}`);
    }
    legible(darkSheet(paletteFor([210, 30, 120], { tier }), tier), `three hues at ${tier}`);
  }
});

test('darkSheet() answers only for the colours it was given', () => {
  // A look carrying one pigment must not have the rest of the sheet written over
  // the stylesheet's dark palette; and a value it cannot read is left to it too.
  assert.deepEqual(Object.keys(darkSheet({ '--accent': '#b94900' })), ['--accent']);
  assert.deepEqual(darkSheet({ '--accent-fg': 'var(--ink)' }), {});
});

test('the pre-paint script and the title bar only go dark where color-mix() is', () => {
  // Section 7, the palette without color-mix(), has no dark twin.
  const html = read(join(WEB, 'index.html'));
  const bar = read(join(WEB, '..', 'desktop', 'chrome', 'look.ts'));
  for (const [where, text] of [['index.html', html], ['desktop/chrome/look.ts', bar]]) {
    assert.match(text, /CSS\.supports\('color', 'color-mix\(in srgb, red, blue\)'\)/, `${where} skips the check`);
    assert.ok(text.includes('mbrd.appearance.dark'), `${where} never paints the stored dark pigments`);
  }
});
