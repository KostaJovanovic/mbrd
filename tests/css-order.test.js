// The cascade is one list written three times: the <link>s in index.html,
// the stylesheets in SHELL (web/sw.js), and APP_CSS_ORDER (tests/helpers.js).
// Document order is the cascade, and quality.css wins on it. A sheet missing
// from APP_CSS_ORDER is a sheet no CSS test reads; one out of order there tests
// a cascade the browser never builds. Both fail silently, so the three lists
// are compared here, name for name and in order.

import { join } from 'node:path';
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { WEB, APP_CSS_ORDER, read } from './helpers.js';

/** The two sheets outside APP_CSS_ORDER on purpose: the property table and
 * the @font-face set (see the comment on APP_CSS_ORDER). */
const NOT_CASCADE = new Set(['fonts.css', 'tokens.css']);

/** Every stylesheet index.html links, in document order, comments dropped. */
const linked = [...read(join(WEB, 'index.html'))
  .replace(/<!--[\s\S]*?-->/g, '')
  .matchAll(/<link\b[^>]*\brel="stylesheet"[^>]*>/g)]
  .map(([tag]) => (/\bhref="assets\/css\/([^"]+\.css)"/.exec(tag) ?? [])[1])
  .filter(Boolean);

/** Every stylesheet SHELL precaches, in the order it lists them. */
function shellSheets() {
  const block = /const SHELL = \[([\s\S]*?)\];/.exec(read(join(WEB, 'sw.js')));
  assert.ok(block, 'could not find the SHELL array in sw.js');
  return block[1].split('\n')
    .map(line => line.replace(/\/\/.*$/, ''))
    .flatMap(line => [...line.matchAll(/'\.\/assets\/css\/([^']+\.css)'/g)].map(m => m[1]));
}

test('APP_CSS_ORDER is the cascade index.html links, in its order', () => {
  // Guards the guard: a pattern that matched nothing would compare two
  // empty lists and pass.
  assert.ok(linked.length > 20, `only ${linked.length} stylesheet links found in index.html`);
  assert.ok(APP_CSS_ORDER.length > 20, `only ${APP_CSS_ORDER.length} names in APP_CSS_ORDER`);
  for (const name of NOT_CASCADE) {
    assert.ok(linked.includes(name), `index.html no longer links ${name} - is NOT_CASCADE stale?`);
  }
  const cascade = linked.filter(name => !NOT_CASCADE.has(name));
  assert.deepEqual(APP_CSS_ORDER, cascade,
    'APP_CSS_ORDER in tests/helpers.js does not match the <link> order in index.html');
  assert.equal(cascade.at(-1), 'quality.css', 'quality.css must be the last sheet in the cascade');
});

test('SHELL precaches the cascade in the order index.html links it', () => {
  const shell = shellSheets();
  assert.ok(shell.length > 20, `only ${shell.length} stylesheets found in SHELL`);
  const missing = linked.filter(name => !shell.includes(name));
  assert.deepEqual(missing, [], `index.html links these, and SHELL does not precache them: ${missing.join(', ')}`);
  // SHELL also carries the document pages' sheets (patch.css, privacy.css),
  // which are not in the app's cascade, so only the app's sheets are compared.
  const inOrder = shell.filter(name => APP_CSS_ORDER.includes(name));
  assert.deepEqual(inOrder, APP_CSS_ORDER,
    'the stylesheets in SHELL (web/sw.js) are not in the order index.html links them');
});
