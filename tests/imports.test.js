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
 * The workers that are not modules, listed once because two tests want them:
 * they are exempt from the import loop below and they are what the parse test
 * at the foot of this file reads.
 */
const CLASSIC_WORKERS = ['optimize/media-worker.js', 'import/tiff-worker.js'];

/**
 * The four documented exceptions, none of which is a unit.
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
 *   import/tiff-worker.js       the same, for the same reason: UTIF.js assigns
 *                               itself to `self.UTIF` and reads `self.pako`
 *                               back out, which is importScripts' contract and
 *                               not a module's.
 *
 * Anything else appearing here is a regression, not a new exception.
 */
const DOM_ENTRY_POINTS = new Set([
  'main.ts', 'ui/appearance.ts', ...CLASSIC_WORKERS,
]);

const modules = walk(JS, ['.js', '.ts'], JS)
  .filter(m => m !== 'import/formats.ts');       // generated, 358 lines of data

test('every module is listed as testable or as a DOM entry point', () => {
  assert.ok(modules.length > 20, `only found ${modules.length} modules - is the walk right?`);
  for (const m of DOM_ENTRY_POINTS) {
    assert.ok(modules.includes(m), `${m} is listed as an entry point but does not exist`);
  }
  // The list is the rule's only escape hatch, so its length is part of the rule.
  // Without this, the way to get an import-time `document` past this file is to
  // add a fourth name here - a one-line edit that reads like housekeeping and
  // silently exempts a module from the thing that makes the suite possible.
  assert.equal(DOM_ENTRY_POINTS.size, 4,
    'there are four documented DOM entry points; a fifth needs the argument '
    + 'for it written into the comment above, not just the name added');
});

/**
 * Browser globals that Node also defines.
 *
 * The import below used to be the whole test: a module that read `document` at
 * import time threw, and that was the check. But the rule is about the *shape*
 * of a module, not about which globals this particular runtime happens to lack,
 * and Node 22 defines `navigator`, `crypto`, `performance`, `Blob` and `File`.
 * So a module doing `const IS_SAFARI = /safari/i.test(navigator.userAgent)` at
 * module scope imported perfectly cleanly here while being exactly the thing
 * the header above forbids - and would then bake a wrong answer into a worker,
 * or read a stale one after a runtime swap.
 *
 * These are recorded rather than thrown from. A getter that throws leaves the
 * module half-evaluated and reports the symptom two frames from the cause; a
 * getter that notes the name lets the module finish and names it directly.
 */
const NODE_PROVIDES = ['navigator', 'crypto', 'performance', 'Blob', 'File'];

function watchGlobals(touched) {
  const saved = [];
  for (const name of NODE_PROVIDES) {
    const desc = Object.getOwnPropertyDescriptor(globalThis, name);
    if (!desc || !desc.configurable) continue;
    saved.push([name, desc]);
    Object.defineProperty(globalThis, name, {
      configurable: true,
      enumerable: desc.enumerable,
      get() {
        touched.add(name);
        return desc.get ? desc.get.call(globalThis) : desc.value;
      },
    });
  }
  return () => { for (const [name, desc] of saved) Object.defineProperty(globalThis, name, desc); };
}

for (const mod of modules) {
  if (DOM_ENTRY_POINTS.has(mod)) continue;
  test(`${mod} imports without a browser`, async () => {
    const touched = new Set();
    const restore = watchGlobals(touched);
    try {
      await import(pathToFileURL(join(JS, mod)).href);
    } finally {
      restore();
    }
    assert.deepEqual([...touched], [],
      `${mod} reads ${[...touched].join(', ')} while its body runs. Node defines `
      + 'these, so the import succeeds and the module is still browser-only at '
      + 'load. Move the read into a function or an init*().');
  });
}

test('the workers parse, though nothing can import them', async () => {
  // Both are skipped by the loop above because a classic worker cannot be
  // imported at all, and both are excluded from the bundle - so until this the
  // only thing that ever looked at their syntax was CI's parse leg, which
  // reports after the push and after the deploy has started. Parsing them here
  // costs a millisecond and moves that to `npm test`.
  const { Script } = await import('node:vm');
  const { readFileSync } = await import('node:fs');
  for (const rel of CLASSIC_WORKERS) {
    const src = readFileSync(join(JS, ...rel.split('/')), 'utf8');
    assert.doesNotThrow(() => new Script(src, { filename: rel }), rel);
  }
});
