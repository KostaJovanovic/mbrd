// The background remover's two carried files, and the reasons they are carried.
//
// canvas/matte.ts runs a neural network to decide which pixels of a photograph
// are the subject. That needs two things this repository does not otherwise
// have: a model, and something to execute it. Both sit in web/assets/vendor and
// are served from this origin, for the reason import/pdf.ts carries pdf.js -
// web/_headers is `script-src 'self'` and `connect-src 'self' blob:` plus one
// host, so a CDN would be refused on the deployed site and work perfectly under
// tools/serve.py, which sends no headers. That is the failure mode this whole
// arrangement exists to avoid, and tests/pdf-vendor.test.js is the sibling of
// this file for exactly the same reason.
//
// There is a second reason here that pdf.js did not have: **licences**. The
// obvious models are not redistributable. RMBG-1.4 and RMBG-2.0 are CC BY-NC,
// and both ISNet-ONNX and @imgly/background-removal are AGPL; this project is
// GPL-3.0-or-later and publicly deployed, so none of the three could ship. What
// did ship is u2netp (Apache-2.0) under an MIT runtime, and the two licence
// tests below are what stop a future "just swap in a better model" from quietly
// making the deploy unlicensed.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

import { WEB, read } from './helpers.js';
import { ORT_VERSION, MODEL_NAME } from '../web/assets/js/canvas/matte.ts';

const MODEL_DIR = join(WEB, 'assets', 'vendor', 'u2netp');
const ORT_DIR = join(WEB, 'assets', 'vendor', 'onnxruntime');

/**
 * The runtime is three files and all three are needed together.
 *
 * The entry resolves the other two at run time out of the same directory - see
 * `ort.env.wasm.wasmPaths` in canvas/matte-worker.js - so a checkout missing the
 * binary fails inside the wasm loader with nothing readable in the console,
 * which is the failure this test exists to turn into a sentence.
 */
const ORT_FILES = ['ort.wasm.min.mjs', 'ort-wasm-simd-threaded.mjs', 'ort-wasm-simd-threaded.wasm'];

test('the model and the runtime are actually here', () => {
  assert.ok(existsSync(join(MODEL_DIR, `${MODEL_NAME}.onnx`)),
    `web/assets/vendor/u2netp/${MODEL_NAME}.onnx is missing`);
  for (const name of ORT_FILES) {
    assert.ok(existsSync(join(ORT_DIR, name)), `web/assets/vendor/onnxruntime/${name} is missing`);
  }
  // The two big ones are what a partial checkout or a mangled LFS pull loses
  // first, and a truncated one fails at session build.
  assert.ok(statSync(join(MODEL_DIR, `${MODEL_NAME}.onnx`)).size > 4_000_000,
    'the model is too small to be one');
  assert.ok(statSync(join(ORT_DIR, 'ort-wasm-simd-threaded.wasm')).size > 10_000_000,
    'the runtime binary is too small to be one');
});

test('the runtime binary is actually WebAssembly', () => {
  // \0asm, the four bytes every wasm module starts with. The usual way a large
  // file arrives wrong is an HTML error page saved under the right name.
  const head = readFileSync(join(ORT_DIR, 'ort-wasm-simd-threaded.wasm')).subarray(0, 4);
  assert.deepEqual([...head], [0x00, 0x61, 0x73, 0x6d],
    'the runtime binary does not begin with the wasm magic number');
});

test('the model is an ONNX file and not something renamed', () => {
  // A protobuf, so there is no magic number to check. The producer string is
  // written into the first bytes of every export torch makes, which is enough
  // to tell a model from an HTML error page saved under the wrong name - the
  // usual way a large file arrives wrong.
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
  // U^2-Net is Apache-2.0 and ONNX Runtime is MIT. The same rule the fonts, the
  // stickers and pdf.js are held to: what ships carries its notice.
  const model = read(join(MODEL_DIR, 'LICENSE.txt'));
  assert.match(model, /Apache License/);
  assert.match(model, /Version 2\.0/);

  const ort = read(join(ORT_DIR, 'LICENSE.txt'));
  assert.match(ort, /MIT License/);
  assert.match(ort, /Microsoft/);
});

test('neither licence is one this project could not ship', () => {
  // The check that matters, written as a refusal rather than as a note. A
  // non-commercial or AGPL model dropped in here would be legally wrong on a
  // GPL-3.0-or-later deploy and would look exactly like an upgrade in a diff.
  for (const dir of [MODEL_DIR, ORT_DIR]) {
    const licence = read(join(dir, 'LICENSE.txt'));
    assert.doesNotMatch(licence, /NonCommercial|non-commercial/i,
      `${dir} carries a non-commercial licence - it cannot ship in this project`);
    assert.doesNotMatch(licence, /GNU AFFERO/i,
      `${dir} carries the AGPL - shipping it would relicense the combined work`);
  }
});

test('neither the module nor its worker reaches for a CDN', () => {
  // The runtime resolves its own .wasm against `wasmPaths`, and the default when
  // that is unset is a jsdelivr URL - which web/_headers does not name in
  // connect-src and which would take the feature offline-hostile. The worker
  // sets it; this is what stops that line being deleted as noise.
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
  // web/assets/app.js is committed and is what visitors get, so the check that
  // matters is against the built file rather than against the source. The model
  // and the runtime are named by the worker, which is served raw and is not in
  // the bundle at all - so this only looks for the one path the bundle owns.
  const bundle = read(join(WEB, 'assets', 'app.js'));
  assert.ok(bundle.includes('assets/js/canvas/matte-worker.js'),
    'the bundle does not name the worker');
});

test('the worker is served raw and so must stay plain JavaScript', () => {
  // esbuild never sees it - `new Worker()` takes a runtime URL - so what is on
  // disk is what the browser parses. A .ts file here would 404 in production and
  // work perfectly under tools/serve.py, which is the shape of bug this whole
  // vendoring arrangement exists to avoid.
  assert.ok(existsSync(join(WEB, 'assets', 'js', 'canvas', 'matte-worker.js')),
    'canvas/matte-worker.js is missing - the feature will spawn a worker that 404s');
  const wk = read(join(WEB, 'assets', 'js', 'canvas', 'matte-worker.js'));
  assert.doesNotMatch(wk, /:\s*(string|number|boolean)\b/,
    'matte-worker.js carries type annotations - it is served raw and the browser will not strip them');
});

test('the runtime is the wasm build, and the WebGL one has not come back', () => {
  // The WebGL backend was tried first and does not work: every operator u2netp
  // uses is supported at opset 11, but the backend has no int64 and the model
  // computes all 38 of its Resize targets as int64 at run time. Asserted so the
  // cheap path is not re-attempted by somebody reading only the operator table.
  assert.ok(!existsSync(join(ORT_DIR, 'ort.webgl.min.mjs')),
    'the WebGL runtime is back - it cannot run this model; see the header of canvas/matte.ts');
  const wk = read(join(WEB, 'assets', 'js', 'canvas', 'matte-worker.js'));
  assert.ok(wk.includes("executionProviders: ['wasm']"),
    'matte-worker.js no longer asks for the wasm provider');
});

test('the model is deliberately not precached', () => {
  // 4.4 MB on every install, for a feature most boards never touch, is a worse
  // trade than a first cut-out that needs the network - after which the service
  // worker has it like any other same-origin asset. Asserted so that adding it
  // to SHELL is a decision somebody makes on purpose rather than a line that
  // slips in. Same rule tests/pdf-vendor.test.js holds pdf.js to.
  const sw = read(join(WEB, 'sw.js'));
  const shell = sw.slice(sw.indexOf('SHELL'), sw.indexOf(']', sw.indexOf('SHELL')));
  assert.ok(!shell.includes('vendor/u2netp'),
    'the model is in SHELL - if that is intended, say so here and change this test');
  assert.ok(!shell.includes('vendor/onnxruntime'),
    'the runtime is in SHELL - if that is intended, say so here and change this test');
});
