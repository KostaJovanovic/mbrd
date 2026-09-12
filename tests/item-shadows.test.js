import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { appCss } from './helpers.js';

const root = new URL('../', import.meta.url);

test('board item shadows are mirrored into one layer below every item', async () => {
  const [html, items] = await Promise.all([
    readFile(new URL('web/index.html', root), 'utf8'),
    readFile(new URL('web/assets/js/canvas/items.ts', root), 'utf8'),
  ]);
  const css = appCss();

  assert.match(html, /<div id="item-shadows" aria-hidden="true"><\/div>/);
  assert.match(css, /#item-shadows\s*\{[^}]*z-index:\s*-1;/s);
  assert.match(css, /#web\s*\{[^}]*z-index:\s*-2;/s);
  assert.match(css, /\.item-shadow\s*\{[^}]*box-shadow:\s*var\(--item-shadow\);/s);
  assert.match(css, /\.item\s*\{[^}]*box-shadow:\s*none;/s);
  // Built, placed and filed under the item's own id - three steps since
  // canvas/item-dom.ts hands the twin back unplaced. The middle one (placeBox)
  // is the part that would otherwise go missing silently, leaving a shadow at
  // the origin.
  assert.match(items, /const twin = buildShadow\(item,\s*tilt\)/);
  assert.match(items, /placeBox\(twin,\s*item\)/);
  assert.match(items, /shadows\.set\(item\.id,\s*twin\)/);
  assert.match(items, /if \(shadow && item\) placeBox\(shadow,\s*item\)/);
});

test('the fence band is sunk below the underlay its cards cast onto', async () => {
  // A fence left in the item stack painted out the shadow of every card
  // inside it, since the shadow underlay sits below the item layer so no card
  // casts across another. Ground goes under the shadows; both underlays
  // refuse the pointer so passing beneath them is free.
  const items = await readFile(new URL('web/assets/js/canvas/items.ts', root), 'utf8');
  const css = appCss();
  assert.match(css, /#web\s*\{[^}]*pointer-events:\s*none;/s);
  assert.match(css, /#item-shadows\s*\{[^}]*pointer-events:\s*none;/s);
  assert.match(items, /const UNDERLAY_Z = -2;/);
  assert.match(items, /index < fences \? index - fences \+ UNDERLAY_Z : index/);
});
