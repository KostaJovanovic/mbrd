// The cascade is written once, as the <link>s in index.html: document order is
// the cascade, and quality.css wins on it. APP_CSS_ORDER (tests/helpers.js)
// reads it from there, and tools/gen-shell.mjs writes it into SHELL (web/sw.js)
// on every save. This holds the one copy that is committed rather than read:
// a commit that went round save.bat leaves SHELL a sheet behind.

import { join } from 'node:path';
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { WEB, APP_CSS_ORDER, read } from './helpers.js';
import { linkedSheets, shellWithSheets } from '../tools/gen-shell.mjs';

const linked = linkedSheets(read(join(WEB, 'index.html')));

test('index.html links the cascade, quality.css last', () => {
  // Guards the guard: a pattern that matched nothing would pass everything below.
  assert.ok(linked.length > 20, `only ${linked.length} stylesheet links found in index.html`);
  for (const name of ['tokens.css', 'fonts.css']) assert.ok(linked.includes(name), `index.html no longer links ${name}`);
  assert.equal(APP_CSS_ORDER.at(-1), 'quality.css', 'quality.css must be the last sheet in the cascade');
});

test('SHELL precaches what index.html links, as tools/gen-shell.mjs writes it', () => {
  const sw = read(join(WEB, 'sw.js'));
  assert.equal(shellWithSheets(sw, linked), sw,
    'the stylesheets in SHELL (web/sw.js) are not the ones index.html links - run node tools/gen-shell.mjs');
});
