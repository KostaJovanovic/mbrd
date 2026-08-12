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
  // Built, placed and filed under the item's own id. Three lines rather than
  // one since the builder moved to canvas/item-dom.ts, which hands the twin back
  // unplaced - placeBox() is arithmetic against the viewport and stayed in
  // items.ts. Asserted as three because the middle one is the part that would
  // otherwise go missing silently: an unplaced twin is a shadow at the origin.
  assert.match(items, /const twin = buildShadow\(item,\s*tilt\)/);
  assert.match(items, /placeBox\(twin,\s*item\)/);
  assert.match(items, /shadows\.set\(item\.id,\s*twin\)/);
  assert.match(items, /if \(shadow && item\) placeBox\(shadow,\s*item\)/);
});

test('the fence band is sunk below the underlay its cards cast onto', async () => {
  // A fence has a face like any other item (.item carries the paper), and the
  // shadow underlay is below the item layer so that no card casts across another
  // - so a fence left in the item stack painted out the shadow of every card
  // inside it, and the region read as a page with its cards printed flat on it.
  // Ground goes under the shadows. Both underlays refuse the pointer, which is
  // what makes passing beneath them free.
  const items = await readFile(new URL('web/assets/js/canvas/items.ts', root), 'utf8');
  const css = appCss();
  assert.match(css, /#web\s*\{[^}]*pointer-events:\s*none;/s);
  assert.match(css, /#item-shadows\s*\{[^}]*pointer-events:\s*none;/s);
  assert.match(items, /const UNDERLAY_Z = -2;/);
  assert.match(items, /index < fences \? index - fences \+ UNDERLAY_Z : index/);
});
