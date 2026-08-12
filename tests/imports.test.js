// Every module must be loadable without a browser.
//
// This is the test that keeps the rest of the suite possible. Before it existed
// `util.js` computed IS_DEV from `location.hostname` at module scope, and since
// almost everything imports util.js, importing almost anything outside a
// browser threw - which is why a codebase this size had no tests at all.
//
// The rule is not "no browser globals". It is "no browser globals *at import
// time*": reach for `document` inside a function and this passes, reach for it
// while the module body runs and it does not.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { pathToFileURL } from 'node:url';
import { join } from 'node:path';

import { JS, walk } from './helpers.js';

/**
 * The three documented exceptions, none of which is a unit.
 *
 *   main.js                     constructs the Viewport against real elements
 *   ui/appearance.js            holds :root and the theme-colour <meta> at
 *                               module scope
 *   optimize/media-worker.js    is not a module at all. It is a *classic*
 *                               worker, because the vendored ffmpeg core is an
 *                               Emscripten bundle that wants importScripts and
 *                               a global factory - so it installs `self.onmessage`
 *                               at the top level and cannot be imported by
 *                               anything, in a browser or out of one.
 *
 * Anything else appearing here is a regression, not a new exception.
 */
const DOM_ENTRY_POINTS = new Set([
  'main.ts', 'ui/appearance.ts', 'optimize/media-worker.js',
]);

const modules = walk(JS, ['.js', '.ts'], JS)
  .filter(m => m !== 'import/formats.ts');       // generated, 358 lines of data

test('every module is listed as testable or as a DOM entry point', () => {
  assert.ok(modules.length > 20, `only found ${modules.length} modules - is the walk right?`);
  for (const m of DOM_ENTRY_POINTS) {
    assert.ok(modules.includes(m), `${m} is listed as an entry point but does not exist`);
  }
});

for (const mod of modules) {
  if (DOM_ENTRY_POINTS.has(mod)) continue;
  test(`${mod} imports without a browser`, async () => {
    await import(pathToFileURL(join(JS, mod)).href);
  });
}
