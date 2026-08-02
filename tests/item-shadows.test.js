import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { appCss } from './helpers.js';

const root = new URL('../', import.meta.url);

test('board item shadows are mirrored into one layer below every item', async () => {
  const [html, items] = await Promise.all([
    readFile(new URL('web/index.html', root), 'utf8'),
    readFile(new URL('web/assets/js/canvas/items.js', root), 'utf8'),
  ]);
  const css = appCss();

  assert.match(html, /<div id="item-shadows" aria-hidden="true"><\/div>/);
  assert.match(css, /#item-shadows\s*\{[^}]*z-index:\s*-1;/s);
  assert.match(css, /#web\s*\{[^}]*z-index:\s*-2;/s);
  assert.match(css, /\.item-shadow\s*\{[^}]*box-shadow:\s*var\(--item-shadow\);/s);
  assert.match(css, /\.item\s*\{[^}]*box-shadow:\s*none;/s);
  assert.match(items, /shadows\.set\(item\.id,\s*buildShadow\(item,\s*tilt\)\)/);
  assert.match(items, /if \(shadow && item\) placeBox\(shadow,\s*item\)/);
});
