// The background remover's model and runtime, vendored under
// web/assets/vendor and served from this origin, since the CSP would
// refuse a CDN on deploy while working fine locally (see pdf-vendor.test.js
// for the sibling case). Licences matter too: the obvious models
// (RMBG-1.4/2.0, ISNet-ONNX, @imgly/background-removal) are CC BY-NC or
// AGPL and can't ship on this GPL-3.0-or-later deploy. What shipped is
// u2netp (Apache-2.0) under an MIT runtime.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

import { WEB, read } from './helpers.js';
import { ORT_VERSION, MODEL_NAME } from '../web/assets/js/canvas/matte.ts';

const MODEL_DIR = join(WEB, 'assets', 'vendor', 'u2netp');
const ORT_DIR = join(WEB, 'assets', 'vendor', 'onnxruntime');

/**
 * The runtime is three files and all three are needed together - the entry
 * resolves the other two at run time from the same directory (see
 * `ort.env.wasm.wasmPaths` in canvas/matte-worker.js), so a missing binary
 * fails inside the wasm loader with nothing readable in the console.
 */
const ORT_FILES = ['ort.wasm.min.mjs', 'ort-wasm-simd-threaded.mjs', 'ort-wasm-simd-threaded.wasm'];

test('the model and the runtime are actually here', () => {
  assert.ok(existsSync(join(MODEL_DIR, `${MODEL_NAME}.onnx`)),
    `web/assets/vendor/u2netp/${MODEL_NAME}.onnx is missing`);
  for (const name of ORT_FILES) {
    assert.ok(existsSync(join(ORT_DIR, name)), `web/assets/vendor/onnxruntime/${name} is missing`);
  }
  // The two big ones are what a partial checkout or mangled LFS pull loses first.
  assert.ok(statSync(join(MODEL_DIR, `${MODEL_NAME}.onnx`)).size > 4_000_000,
    'the model is too small to be one');
  assert.ok(statSync(join(ORT_DIR, 'ort-wasm-simd-threaded.wasm')).size > 10_000_000,
    'the runtime binary is too small to be one');
});

test('the runtime binary is actually WebAssembly', () => {
  // \0asm, the four bytes every wasm module starts with - guards against an
  // HTML error page saved under the right name.
  const head = readFileSync(join(ORT_DIR, 'ort-wasm-simd-threaded.wasm')).subarray(0, 4);
  assert.deepEqual([...head], [0x00, 0x61, 0x73, 0x6d],
    'the runtime binary does not begin with the wasm magic number');
});

test('the model is an ONNX file and not something renamed', () => {
  // A protobuf, so there's no magic number - the producer string torch
  // writes into every export's first bytes is enough to tell a model from
  // an HTML error page saved under the wrong name.
  const head = read(join(MODEL_DIR, `${MODEL_NAME}.onnx`)).slice(0, 64);
  assert.ok(head.includes('pytorch'),
    'the model does not begin like a torch ONNX export - check what was downloaded');
});

test('the pin in the source is the build on disk', () => {
  assert.match(ORT_VERSION, /^\d+\.\d+\.\d+$/);
  assert.ok(read(join(ORT_DIR, 'ort.wasm.min.mjs')).includes(ORT_VERSION),
    `ort.wasm.min.mjs does not carry ${ORT_VERSION} - the constant and the bytes have drifted`);
});

test('both licences travel with what they cover', () => {
  // U^2-Net is Apache-2.0, ONNX Runtime is MIT - the same rule fonts,
  // stickers and pdf.js are held to.
  const model = read(join(MODEL_DIR, 'LICENSE.txt'));
  assert.match(model, /Apache License/);
  assert.match(model, /Version 2\.0/);

  const ort = read(join(ORT_DIR, 'LICENSE.txt'));
  assert.match(ort, /MIT License/);
  assert.match(ort, /Microsoft/);
});

test('neither licence is one this project could not ship', () => {
  // A non-commercial or AGPL model dropped in here would be legally wrong
  // on this GPL-3.0-or-later deploy, and would look like an upgrade in a diff.
  for (const dir of [MODEL_DIR, ORT_DIR]) {
    const licence = read(join(dir, 'LICENSE.txt'));
    assert.doesNotMatch(licence, /NonCommercial|non-commercial/i,
      `${dir} carries a non-commercial licence - it cannot ship in this project`);
    assert.doesNotMatch(licence, /GNU AFFERO/i,
      `${dir} carries the AGPL - shipping it would relicense the combined work`);
  }
});

test('neither the module nor its worker reaches for a CDN', () => {
  // Unset, `wasmPaths` defaults to a jsdelivr URL that connect-src refuses
  // and that breaks offline use. The worker sets it; guards against that
  // line being deleted as noise.
  const wk = read(join(WEB, 'assets', 'js', 'canvas', 'matte-worker.js'));
  assert.ok(wk.includes('ort.env.wasm.wasmPaths'),
    'matte-worker.js no longer pins wasmPaths - the runtime will fetch its binary from a CDN');
  assert.ok(wk.includes('ort.env.wasm.numThreads = 1'),
    'matte-worker.js no longer pins numThreads - threads need SharedArrayBuffer, which needs COOP/COEP, '
    + 'which would break the embeds');

  for (const file of [['canvas', 'matte.ts'], ['canvas', 'matte-worker.js']]) {
    const src = read(join(WEB, 'assets', 'js', ...file))
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/^[ \t]*\/\/.*$/gm, '');
    assert.doesNotMatch(src, /['"`]https?:\/\//,
      `${file.join('/')} names a remote host - the deploy will refuse it, and the model would stop working offline`);
  }
});

test('the shipped bundle carries the local worker path', () => {
  // web/assets/app.js is committed and is what visitors get, so this checks
  // the built file, not the source. The worker itself is served raw and
  // outside the bundle, so only its path is checked here.
  const bundle = read(join(WEB, 'assets', 'app.js'));
  assert.ok(bundle.includes('assets/js/canvas/matte-worker.js'),
    'the bundle does not name the worker');
});

test('the worker is served raw and so must stay plain JavaScript', () => {
  // esbuild never sees it - `new Worker()` takes a runtime URL - so what's
  // on disk is what the browser parses. A .ts file here would 404 in
  // production while working fine under tools/serve.py.
  assert.ok(existsSync(join(WEB, 'assets', 'js', 'canvas', 'matte-worker.js')),
    'canvas/matte-worker.js is missing - the feature will spawn a worker that 404s');
  const wk = read(join(WEB, 'assets', 'js', 'canvas', 'matte-worker.js'));
  assert.doesNotMatch(wk, /:\s*(string|number|boolean)\b/,
    'matte-worker.js carries type annotations - it is served raw and the browser will not strip them');
});

test('the runtime is the wasm build, and the WebGL one has not come back', () => {
  // WebGL was tried first and doesn't work: it lacks int64, and the model
  // computes all 38 of its Resize targets as int64 at run time, despite
  // every operator being supported at opset 11.
  assert.ok(!existsSync(join(ORT_DIR, 'ort.webgl.min.mjs')),
    'the WebGL runtime is back - it cannot run this model; see the header of canvas/matte.ts');
  const wk = read(join(WEB, 'assets', 'js', 'canvas', 'matte-worker.js'));
  assert.ok(wk.includes("executionProviders: ['wasm']"),
    'matte-worker.js no longer asks for the wasm provider');
});

test('the model is deliberately not precached', () => {
  // 4.4 MB on every install for a rarely-used feature is a worse trade than
  // a first cut-out needing the network. Guards against adding it to SHELL
  // by accident. Same rule pdf-vendor.test.js holds pdf.js to.
  const sw = read(join(WEB, 'sw.js'));
  const shell = sw.slice(sw.indexOf('SHELL'), sw.indexOf(']', sw.indexOf('SHELL')));
  assert.ok(!shell.includes('vendor/u2netp'),
    'the model is in SHELL - if that is intended, say so here and change this test');
  assert.ok(!shell.includes('vendor/onnxruntime'),
    'the runtime is in SHELL - if that is intended, say so here and change this test');
});
