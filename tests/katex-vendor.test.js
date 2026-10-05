// KaTeX, carried in web/assets/vendor/katex rather than fetched, for the reason
// pdf.js is: script-src and font-src are 'self' on the deployed site. This
// keeps the arrangement honest - files present, pin true, licence shipped, the
// fonts its sheet names on disk, and kept out of the precache.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, statSync } from 'node:fs';
import { join } from 'node:path';

import { WEB, THIRD_PARTY, read } from './helpers.js';
import { KATEX_VERSION } from '../web/assets/js/ui/math.ts';

const DIR = join(WEB, 'assets', 'vendor', 'katex');

test('the library and its stylesheet are actually here', () => {
  for (const name of ['katex.mjs', 'katex.min.css', 'LICENSE.txt']) {
    assert.ok(existsSync(join(DIR, name)), `web/assets/vendor/katex/${name} is missing`);
  }
  assert.ok(statSync(join(DIR, 'katex.mjs')).size > 100_000, 'the library is too small to be one');
});

test('the pin in the source is the build on disk, and the one THIRD-PARTY.md names', () => {
  assert.match(KATEX_VERSION, /^\d+\.\d+\.\d+$/);
  assert.ok(read(join(DIR, 'katex.mjs')).includes(`"${KATEX_VERSION}"`),
    `katex.mjs does not carry ${KATEX_VERSION} - the constant and the bytes have drifted`);
  assert.ok(read(THIRD_PARTY).includes(`KaTeX ${KATEX_VERSION}`),
    'THIRD-PARTY.md names another version than ui/math.ts pins');
});

test('every woff2 the stylesheet asks for ships', () => {
  // A missing face draws a formula in the fallback serif, with nothing in the console.
  const css = read(join(DIR, 'katex.min.css'));
  const fonts = [...new Set([...css.matchAll(/url\((fonts\/[^)]+\.woff2)\)/g)].map(m => m[1]))];
  assert.ok(fonts.length >= 10, `only ${fonts.length} woff2 faces named - has the sheet changed?`);
  for (const f of fonts) assert.ok(existsSync(join(DIR, f)), `${f} is named and missing`);
});

test('the licence travels with the code', () => {
  assert.match(read(join(DIR, 'LICENSE.txt')), /MIT License|Permission is hereby granted/);
});

test('the vendored library is deliberately not precached', () => {
  // Most boards never show a formula; the first one may need the network.
  const sw = read(join(WEB, 'sw.js'));
  const shell = sw.slice(sw.indexOf('SHELL'), sw.indexOf(']', sw.indexOf('SHELL')));
  assert.ok(!shell.includes('vendor/katex'),
    'KaTeX is in SHELL - if that is intended, say so here and change this test');
});
