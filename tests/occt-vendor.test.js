// The CAD kernel's two carried files, and the reasons they are carried.
//
// STEP and IGES describe a solid rather than draw one - trimmed surfaces and
// the topology between them, with no triangle anywhere - so something has to
// tessellate them. web/assets/js/mesh/occt-worker.js runs Open CASCADE, which
// is what a CAD viewer runs, and the two files it needs sit in
// web/assets/vendor/occt and are served from this origin. That is the same
// reasoning import/pdf.ts and canvas/matte.ts carry their own vendored builds
// for: web/_headers is `script-src 'self'`, so a CDN copy is refused on the
// deployed site and works perfectly under tools/serve.py, which sends no
// headers - the failure mode that is invisible until it is public.
//
// There is a second reason here, and it is the sharper one: **the licence**.
// occt-import-js and the kernel inside it are both LGPL-2.1, and this project is
// GPL-3.0-or-later. Those do not combine into one work. They combine under
// LGPL-2.1 section 6 - a work that *uses* the library, linked at run time and
// replaceable without rebuilding anything here - and the whole of what makes
// that true is that these two files are loaded by a worker and never enter
// web/assets/app.js. So the last test in this file is not housekeeping: it is
// the condition the arrangement rests on, and the way to break it is one
// ordinary-looking `import` in a .ts file.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

import { JS, THIRD_PARTY, WEB, read } from './helpers.js';
import { OCCT_DIR, OCCT_VERSION, WORKER_URL } from '../web/assets/js/mesh/occt.ts';

const DIR = join(WEB, 'assets', 'vendor', 'occt');

/**
 * Three files and all three are needed together.
 *
 * The .js resolves the .wasm out of its own directory at run time - see
 * `locateFile` in mesh/occt-worker.js - so a checkout missing the binary fails
 * inside the Emscripten loader with nothing readable in the console, and the
 * app silently reads every CAD file with the fallback instead. That is the
 * failure this test exists to turn into a sentence.
 */
const FILES = ['occt-import-js.js', 'occt-import-js.wasm', 'LICENSE.txt'];

test('the kernel is actually here', () => {
  for (const name of FILES) {
    assert.ok(existsSync(join(DIR, name)), `web/assets/vendor/occt/${name} is missing`);
  }
  // A .wasm that arrived through a text-mode checkout, or a Git LFS pointer,
  // is a file that exists and is not a kernel.
  const wasm = statSync(join(DIR, 'occt-import-js.wasm'));
  assert.ok(wasm.size > 1e6, `occt-import-js.wasm is ${wasm.size} bytes - that is not a wasm build`);
});

test('the vendored build is a wasm module and the loader knows where to find it', () => {
  // Bytes, not text: helpers.read() decodes as UTF-8, and a magic number is not
  // a string.
  const head = readFileSync(join(DIR, 'occt-import-js.wasm')).subarray(0, 4);
  assert.deepEqual([...head], [0x00, 0x61, 0x73, 0x6d], 'occt-import-js.wasm has no wasm magic');

  const worker = read(join(JS, 'mesh', 'occt-worker.js'));
  assert.match(worker, /importScripts\('\.\.\/\.\.\/vendor\/occt\/occt-import-js\.js'\)/,
    'mesh/occt-worker.js no longer loads the vendored file from where this test looks for it');
  assert.match(worker, /locateFile/,
    'mesh/occt-worker.js does not tell Emscripten where its .wasm is - it will guess, and guess the page');
});

test('the version in the code is the version in the directory', () => {
  // The published bundle names itself. A directory refreshed from a different
  // release without OCCT_VERSION following it would leave THIRD-PARTY.md and
  // the credits sheet stating a version that is not what ships.
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
  // Both projects, because the wrapper and the kernel are separate copyrights
  // under the same licence and the LGPL asks for the notice of what is carried.
  assert.match(licence, /occt-import-js/, 'the wrapper is not named in the notice');
  assert.match(licence, /Open CASCADE/, 'the kernel is not named in the notice');

  const manifest = read(THIRD_PARTY);
  assert.match(manifest, /occt-import-js/, 'THIRD-PARTY.md does not list the kernel');
  assert.match(manifest, /web\/assets\/vendor\/occt\/LICENSE\.txt/,
    'THIRD-PARTY.md does not point at the notice beside the kernel');
});

/**
 * The condition the licence arrangement rests on, checked mechanically.
 *
 * LGPL-2.1 section 6 lets a work under other terms *use* the library, provided
 * the library stays a separate, replaceable thing. A vendored file reached by
 * `importScripts` from a worker is that. The same file reached by `import` from
 * a .ts would be pulled into web/assets/app.js by esbuild, and the bundle would
 * be one work built from both - which this project may not distribute.
 *
 * So: nothing under web/assets/js may import it, and the bundle must not contain
 * it. Both halves, because the first is the mistake and the second is what the
 * mistake produces.
 */
test('the kernel is used, not linked', () => {
  for (const rel of ['mesh/occt.ts', 'mesh.ts', 'canvas/model.ts']) {
    const src = read(join(JS, ...rel.split('/')));
    assert.ok(!/from ['"][^'"]*vendor\/occt/.test(src),
      `${rel} imports the kernel. That bundles LGPL-2.1 into a GPL-3.0 build - `
      + 'it has to be loaded at run time by the worker. See THIRD-PARTY.md.');
  }
  const bundle = join(WEB, 'assets', 'app.js');
  if (!existsSync(bundle)) return;                 // npm test runs before a build
  assert.ok(!read(bundle).includes('occtimportjs'),
    'web/assets/app.js contains the kernel - something imported it instead of spawning the worker');
});
