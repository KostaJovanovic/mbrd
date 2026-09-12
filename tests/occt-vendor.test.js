// The CAD kernel's two carried files. STEP and IGES describe a solid
// rather than draw one, so something has to tessellate them -
// occt-worker.js runs Open CASCADE, vendored under web/assets/vendor/occt
// and served from this origin since a CDN copy is refused by the deployed
// CSP but works fine under tools/serve.py, invisible until it's public.
//
// The sharper reason: **the licence**. occt-import-js and its kernel are
// LGPL-2.1, this project GPL-3.0-or-later - they combine under LGPL-2.1
// section 6 only because the two files are loaded by a worker and never
// enter web/assets/app.js. The last test here is the condition that rests
// on, broken by one ordinary-looking `import`.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

import { JS, THIRD_PARTY, WEB, read } from './helpers.js';
import { OCCT_DIR, OCCT_VERSION, WORKER_URL } from '../web/assets/js/mesh/occt.ts';

const DIR = join(WEB, 'assets', 'vendor', 'occt');

/**
 * Three files, all needed together. The .js resolves the .wasm out of its
 * own directory at run time (see `locateFile` in occt-worker.js), so a
 * checkout missing the binary fails inside the Emscripten loader with
 * nothing readable in the console.
 */
const FILES = ['occt-import-js.js', 'occt-import-js.wasm', 'LICENSE.txt'];

test('the kernel is actually here', () => {
  for (const name of FILES) {
    assert.ok(existsSync(join(DIR, name)), `web/assets/vendor/occt/${name} is missing`);
  }
  // A .wasm from a text-mode checkout, or a Git LFS pointer, exists but
  // isn't a kernel.
  const wasm = statSync(join(DIR, 'occt-import-js.wasm'));
  assert.ok(wasm.size > 1e6, `occt-import-js.wasm is ${wasm.size} bytes - that is not a wasm build`);
});

test('the vendored build is a wasm module and the loader knows where to find it', () => {
  // Bytes, not text: helpers.read() decodes as UTF-8, and a magic number
  // isn't a string.
  const head = readFileSync(join(DIR, 'occt-import-js.wasm')).subarray(0, 4);
  assert.deepEqual([...head], [0x00, 0x61, 0x73, 0x6d], 'occt-import-js.wasm has no wasm magic');

  const worker = read(join(JS, 'mesh', 'occt-worker.js'));
  assert.match(worker, /importScripts\('\.\.\/\.\.\/vendor\/occt\/occt-import-js\.js'\)/,
    'mesh/occt-worker.js no longer loads the vendored file from where this test looks for it');
  assert.match(worker, /locateFile/,
    'mesh/occt-worker.js does not tell Emscripten where its .wasm is - it will guess, and guess the page');
});

test('the version in the code is the version in the directory', () => {
  // A directory refreshed from a different release without OCCT_VERSION
  // following it would leave THIRD-PARTY.md stating a version that
  // doesn't ship.
  assert.match(OCCT_VERSION, /^\d+\.\d+\.\d+$/, 'OCCT_VERSION is not a version');
  assert.equal(OCCT_DIR, '/assets/vendor/occt/', 'OCCT_DIR no longer points at the vendor directory');
  assert.equal(WORKER_URL, '/assets/js/mesh/occt-worker.js',
    'the worker moved - web/_headers drops the policy on the old path');
});

test('the licence the kernel ships under is the one the manifest claims', () => {
  const licence = read(join(DIR, 'LICENSE.txt'));
  assert.match(licence, /GNU LESSER GENERAL PUBLIC LICENSE/,
    'the notice beside the kernel is not the LGPL - a swap to another build changed the terms');
  assert.match(licence, /Version 2\.1/, 'the notice is not LGPL-2.1');
  // Both projects: the wrapper and kernel are separate copyrights under
  // the same licence, and the LGPL asks for notice of what's carried.
  assert.match(licence, /occt-import-js/, 'the wrapper is not named in the notice');
  assert.match(licence, /Open CASCADE/, 'the kernel is not named in the notice');

  const manifest = read(THIRD_PARTY);
  assert.match(manifest, /occt-import-js/, 'THIRD-PARTY.md does not list the kernel');
  assert.match(manifest, /web\/assets\/vendor\/occt\/LICENSE\.txt/,
    'THIRD-PARTY.md does not point at the notice beside the kernel');
});

/**
 * The condition the licence arrangement rests on, checked mechanically.
 * LGPL-2.1 section 6 lets other terms *use* the library, provided it
 * stays separate and replaceable - true of `importScripts` from a worker,
 * false of `import` from a .ts, which esbuild would pull into
 * web/assets/app.js as one undistributable work. So: nothing under
 * web/assets/js may import it, and the bundle must not contain it.
 */
test('the kernel is used, not linked', () => {
  for (const rel of ['mesh/occt.ts', 'mesh.ts', 'canvas/model.ts']) {
    const src = read(join(JS, ...rel.split('/')));
    assert.ok(!/from ['"][^'"]*vendor\/occt/.test(src),
      `${rel} imports the kernel. That bundles LGPL-2.1 into a GPL-3.0 build - `
      + 'it has to be loaded at run time by the worker. See THIRD-PARTY.md.');
  }
  const bundle = join(WEB, 'assets', 'app.js');
  if (!existsSync(bundle)) return;                 // npm test can run before a build
  assert.ok(!read(bundle).includes('occtimportjs'),
    'web/assets/app.js contains the kernel - something imported it instead of spawning the worker');
});
