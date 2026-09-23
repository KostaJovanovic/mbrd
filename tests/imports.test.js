// Every module must be loadable without a browser - the rule that keeps the
// rest of the suite possible. Before it existed, util.ts read
// `location.hostname` at module scope and broke every import outside one.
// Not "no browser globals" but "none at import time": reading `document`
// inside a function passes, reading it while the module body runs does not.

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
const CLASSIC_WORKERS = [
  'optimize/media-worker.js', 'import/tiff-worker.js', 'mesh/occt-worker.js',
  // The HEIC decoder. Classic for the reason the other three are - it
  // importScripts a vendored build that assigns itself to `self` - and it
  // shims `self.window` and `self.document` in its body, because heic2any was
  // written for a page and checks for both before it will run. So it is a
  // module that touches the DOM at import by construction, which is the whole
  // reason this list exists.
  'import/heif-worker.js',
];

/** Workers that are ES modules but are still workers, and so still not units. */
const MODULE_WORKERS = ['canvas/matte-worker.js'];

/** The seven documented exceptions — main.ts, ui/appearance.ts (both touch the
 *  DOM at import), and the five workers (classic or ES-module). Anything else
 *  appearing here is a regression. */
const DOM_ENTRY_POINTS = new Set([
  'main.ts', 'ui/appearance.ts', ...CLASSIC_WORKERS, ...MODULE_WORKERS,
]);

const modules = walk(JS, ['.js', '.ts'], JS)
  .filter(m => m !== 'import/formats.ts');       // generated

test('every module is listed as testable or as a DOM entry point', () => {
  assert.ok(modules.length > 20, `only found ${modules.length} modules - is the walk right?`);
  for (const m of DOM_ENTRY_POINTS) {
    assert.ok(modules.includes(m), `${m} is listed as an entry point but does not exist`);
  }
  // The list is the rule's only escape hatch, so its size is part of the
  // rule - otherwise a new name here quietly exempts a module from the thing
  // that makes the suite possible.
  assert.equal(DOM_ENTRY_POINTS.size, 7,
    'there are seven documented DOM entry points; an eighth needs the argument '
    + 'for it written into the comment above, not just the name added');
});

/**
 * Browser globals that Node also defines - navigator, crypto, performance,
 * Blob, File. A plain import throwing on `document` was the whole test once,
 * but Node defines these too, so a module reading `navigator.userAgent` at
 * module scope imported cleanly while doing exactly what the rule forbids.
 *
 * Recorded rather than thrown from: a getter that throws leaves the module
 * half-evaluated and reports the symptom two frames from the cause.
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
  // Classic workers can't be imported, so without this the only syntax check
  // was CI's parse leg, which reports after the deploy has already started.
  const { Script } = await import('node:vm');
  const { readFileSync } = await import('node:fs');
  for (const rel of CLASSIC_WORKERS) {
    const src = readFileSync(join(JS, ...rel.split('/')), 'utf8');
    assert.doesNotThrow(() => new Script(src, { filename: rel }), rel);
  }
});

test('the module workers parse, though the import loop skips them', async () => {
  // A module worker is exempt from the loop above, so it was in no parse test
  // at all. `node --check` parses without running: importing one would load
  // its wasm runtime. package.json's "type": "module" makes it a module parse.
  const { spawnSync } = await import('node:child_process');
  assert.ok(MODULE_WORKERS.length > 0, 'no module workers listed');
  for (const rel of MODULE_WORKERS) {
    const run = spawnSync(process.execPath, ['--check', join(JS, ...rel.split('/'))], { encoding: 'utf8' });
    assert.equal(run.status, 0, `${rel} does not parse:\n${run.stderr}`);
  }
});
