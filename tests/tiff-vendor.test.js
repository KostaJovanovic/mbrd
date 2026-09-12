// The TIFF decoder this app carries, and the arrangement that keeps it
// honest. Same checklist tests/pdf-vendor.test.js applies to the other
// vendored library - failure modes invisible until somebody drops the one
// file that needs them: missing from a partial checkout, a pin drifted from
// the bytes, a licence that did not travel, a CDN path the deploy's
// `script-src 'self'` refuses, a precache bloating every install. This
// decoder's own rule: the pixel ceiling exists twice (worker and module),
// and a ceiling meaning two numbers is a dialog that lies.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, statSync } from 'node:fs';
import { join } from 'node:path';

import { WEB, read } from './helpers.js';

const VENDOR = join(WEB, 'assets', 'vendor');
const WORKER = join(WEB, 'assets', 'js', 'import', 'tiff-worker.js');
const MODULE = join(WEB, 'assets', 'js', 'import', 'tiff.ts');

test('the decoder and its inflate are actually here', () => {
  const files = [
    ['utif', 'UTIF.js'],
    ['utif', 'LICENSE.txt'],
    ['pako', 'pako_inflate.min.js'],
    ['pako', 'LICENSE.txt'],
  ];
  for (const [dir, name] of files) {
    assert.ok(existsSync(join(VENDOR, dir, name)), `web/assets/vendor/${dir}/${name} is missing`);
  }
  // Size, not a hash: a truncated copy is what a partial checkout or a
  // mangled line-ending pass actually produces, failing at decode time with
  // nothing readable in the console.
  assert.ok(statSync(join(VENDOR, 'utif', 'UTIF.js')).size > 40_000, 'UTIF.js is too small to be it');
  assert.ok(statSync(join(VENDOR, 'pako', 'pako_inflate.min.js')).size > 15_000, 'pako is too small to be it');
});

test('the two files still speak the contract the worker expects', () => {
  // UTIF assigns itself to `self.UTIF` and reads `self.pako` back out - why
  // the worker is classic and importScripts is the only way in. An ES
  // module build would import cleanly and then be undefined at first use.
  const utif = read(join(VENDOR, 'utif', 'UTIF.js'));
  assert.match(utif, /self\.UTIF\s*=/, 'UTIF no longer publishes itself as a global');
  assert.match(utif, /self\.pako/, 'UTIF no longer takes pako from a global');
  const pako = read(join(VENDOR, 'pako', 'pako_inflate.min.js'));
  assert.ok(/pako/.test(pako), 'the inflate build does not name itself');
});

test('the licences travel with the code', () => {
  // The same rule fonts, stickers and pdf.js are held to: what ships
  // carries its notice. Both MIT (pako is MIT and Zlib; its file says so).
  assert.match(read(join(VENDOR, 'utif', 'LICENSE.txt')), /MIT License/);
  assert.match(read(join(VENDOR, 'utif', 'LICENSE.txt')), /Photopea/);
  assert.match(read(join(VENDOR, 'pako', 'LICENSE.txt')), /MIT License/i);
});

test('the worker loads both, from this origin', () => {
  const src = read(WORKER);
  assert.match(src, /importScripts\(/, 'the worker does not import the library at all');
  assert.ok(src.includes('vendor/pako/pako_inflate.min.js'), 'the worker does not load pako');
  assert.ok(src.includes('vendor/utif/UTIF.js'), 'the worker does not load UTIF');
  // A remote host is refused outright on the deployed site but works fine
  // on tools/serve.py - how pdf.js came to be dead in production for a
  // while. Comments are stripped first so this one may say it.
  const bare = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^[ \t]*\/\/.*$/gm, '');
  assert.doesNotMatch(bare, /['"`]https?:\/\//, 'the worker names a remote host - the deploy will refuse it');
});

test('the ceiling means the same number in both files', () => {
  // The worker refuses a page past it; the module puts it in the sentence
  // somebody answers. Two constants since a classic worker cannot import a
  // module - this keeps them one number.
  const inWorker = read(WORKER).match(/const MAX_PIXELS = ([^;]+);/)?.[1]?.trim();
  const inModule = read(MODULE).match(/const MAX_PIXELS = ([^;]+);/)?.[1]?.trim();
  assert.ok(inWorker, 'the worker has no MAX_PIXELS');
  assert.ok(inModule, 'the module has no MAX_PIXELS');
  assert.equal(inModule, inWorker, 'the decode ceiling is two different numbers');
});

test('the decoder is deliberately not precached', () => {
  // Read only when a TIFF is imported; the service worker keeps it after
  // that like any other same-origin asset. Asserted so adding it to SHELL
  // is a decision made on purpose.
  const sw = read(join(WEB, 'sw.js'));
  const shell = sw.slice(sw.indexOf('SHELL'), sw.indexOf(']', sw.indexOf('SHELL')));
  assert.ok(!shell.includes('vendor/utif') && !shell.includes('vendor/pako'),
    'the TIFF decoder is in SHELL - if that is intended, say so here and change this test');
});

test('the vendored decoder is not in the bundle either', () => {
  // Loaded by URL inside a worker, keeping 79 kB out of every visitor's
  // download. A bundler that started inlining it would not fail anything else.
  const bundle = read(join(WEB, 'assets', 'app.js'));
  assert.ok(bundle.includes('tiff-worker.js'), 'the bundle does not name the worker');
  assert.ok(!bundle.includes('UTIF.decodeImage'), 'UTIF has been bundled into app.js');
});
