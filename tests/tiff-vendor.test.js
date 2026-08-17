// The TIFF decoder this app carries, and the arrangement that keeps it honest.
//
// Written against the same checklist tests/pdf-vendor.test.js applies to the
// other vendored library, because the failure modes are identical and both are
// invisible until somebody drops the one kind of file that needs them: a file
// missing from a partial checkout, a pin that has drifted from the bytes, a
// licence that did not travel, a path that reaches a CDN the deploy's
// `script-src 'self'` will refuse, and a precache that quietly puts the whole
// thing in every install.
//
// One rule here is this decoder's own: the pixel ceiling exists twice, in the
// worker that enforces it and in the module that has to put it in a sentence,
// and a ceiling that means two different numbers is a dialog that lies.

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
  // Size rather than a hash: a truncated copy is the thing a partial checkout
  // or a mangled line-ending pass actually produces, and it fails at decode
  // time with nothing readable in the console.
  assert.ok(statSync(join(VENDOR, 'utif', 'UTIF.js')).size > 40_000, 'UTIF.js is too small to be it');
  assert.ok(statSync(join(VENDOR, 'pako', 'pako_inflate.min.js')).size > 15_000, 'pako is too small to be it');
});

test('the two files still speak the contract the worker expects', () => {
  // UTIF assigns itself to `self.UTIF` and reads `self.pako` back out. That is
  // why the worker is a classic one and why importScripts is the only way in -
  // a build that had become an ES module would import cleanly and then be
  // undefined at the first use.
  const utif = read(join(VENDOR, 'utif', 'UTIF.js'));
  assert.match(utif, /self\.UTIF\s*=/, 'UTIF no longer publishes itself as a global');
  assert.match(utif, /self\.pako/, 'UTIF no longer takes pako from a global');
  const pako = read(join(VENDOR, 'pako', 'pako_inflate.min.js'));
  assert.ok(/pako/.test(pako), 'the inflate build does not name itself');
});

test('the licences travel with the code', () => {
  // The same rule the fonts, the stickers and pdf.js are held to: what ships
  // carries its notice. Both of these are MIT (pako is MIT and Zlib, and its
  // file says so).
  assert.match(read(join(VENDOR, 'utif', 'LICENSE.txt')), /MIT License/);
  assert.match(read(join(VENDOR, 'utif', 'LICENSE.txt')), /Photopea/);
  assert.match(read(join(VENDOR, 'pako', 'LICENSE.txt')), /MIT License/i);
});

test('the worker loads both, from this origin', () => {
  const src = read(WORKER);
  assert.match(src, /importScripts\(/, 'the worker does not import the library at all');
  assert.ok(src.includes('vendor/pako/pako_inflate.min.js'), 'the worker does not load pako');
  assert.ok(src.includes('vendor/utif/UTIF.js'), 'the worker does not load UTIF');
  // A remote host here is refused outright on the deployed site and works
  // perfectly on tools/serve.py, which is exactly how pdf.js came to be dead in
  // production for a while. Comments are stripped first so this one may say it.
  const bare = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^[ \t]*\/\/.*$/gm, '');
  assert.doesNotMatch(bare, /['"`]https?:\/\//, 'the worker names a remote host - the deploy will refuse it');
});

test('the ceiling means the same number in both files', () => {
  // The worker refuses a page past it; the module puts it in the sentence
  // somebody is asked to answer. Two constants, because a classic worker cannot
  // import a module - so this is what keeps them one number.
  const inWorker = read(WORKER).match(/const MAX_PIXELS = ([^;]+);/)?.[1]?.trim();
  const inModule = read(MODULE).match(/const MAX_PIXELS = ([^;]+);/)?.[1]?.trim();
  assert.ok(inWorker, 'the worker has no MAX_PIXELS');
  assert.ok(inModule, 'the module has no MAX_PIXELS');
  assert.equal(inModule, inWorker, 'the decode ceiling is two different numbers');
});

test('the decoder is deliberately not precached', () => {
  // 79 kB is small next to pdf.js, and the argument is the same one anyway: it
  // is read only when a TIFF is imported, and the service worker keeps it after
  // that like any other same-origin asset. Asserted so that adding it to SHELL
  // is a decision somebody makes on purpose.
  const sw = read(join(WEB, 'sw.js'));
  const shell = sw.slice(sw.indexOf('SHELL'), sw.indexOf(']', sw.indexOf('SHELL')));
  assert.ok(!shell.includes('vendor/utif') && !shell.includes('vendor/pako'),
    'the TIFF decoder is in SHELL - if that is intended, say so here and change this test');
});

test('the vendored decoder is not in the bundle either', () => {
  // It is loaded by URL inside a worker, which is what keeps 79 kB out of the
  // 630 kB every visitor downloads. A bundler that started inlining it would
  // not fail anything else.
  const bundle = read(join(WEB, 'assets', 'app.js'));
  assert.ok(bundle.includes('tiff-worker.js'), 'the bundle does not name the worker');
  assert.ok(!bundle.includes('UTIF.decodeImage'), 'UTIF has been bundled into app.js');
});
