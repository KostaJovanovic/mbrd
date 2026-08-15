// The one library this app carries, and the reasons it is carried rather than
// fetched.
//
// import/pdf.ts used to load pdf.js from cdn.jsdelivr.net. web/_headers carries
// `script-src 'self'` plus hashes and `worker-src 'self'`, so on the deployed
// site the import was refused and the worker was refused again -
// firstPageRaster()'s catch swallowed both, and every PDF became a grey named
// card. It worked perfectly under tools/serve.py, which sends no headers, so
// the feature was dead exactly where anybody else would see it and alive
// exactly where it was written. Nothing caught it: tests/csp.test.js greps
// optimize/media.ts for a host and nothing else.
//
// So the library is in the repository now, and this file is what keeps that
// arrangement honest - the files present, the pin true, the licence shipped,
// and no path back to a CDN.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, statSync } from 'node:fs';
import { join } from 'node:path';

import { WEB, read } from './helpers.js';
import { PDF_VERSION } from '../web/assets/js/import/pdf.ts';

const DIR = join(WEB, 'assets', 'vendor', 'pdfjs');
const FILES = ['pdf.min.mjs', 'pdf.worker.min.mjs', 'LICENSE.txt'];

test('the library and its worker are actually here', () => {
  for (const name of FILES) {
    assert.ok(existsSync(join(DIR, name)), `web/assets/vendor/pdfjs/${name} is missing`);
  }
  // The worker is the big half and the half a partial checkout loses first; a
  // truncated one fails at render time with nothing readable in the console.
  assert.ok(statSync(join(DIR, 'pdf.worker.min.mjs')).size > 500_000, 'the worker is too small to be one');
  assert.ok(statSync(join(DIR, 'pdf.min.mjs')).size > 100_000, 'the library is too small to be one');
});

test('the pin in the source is the build on disk', () => {
  assert.match(PDF_VERSION, /^\d+\.\d+\.\d+$/);
  for (const name of ['pdf.min.mjs', 'pdf.worker.min.mjs']) {
    assert.ok(read(join(DIR, name)).includes(PDF_VERSION),
      `${name} does not carry ${PDF_VERSION} - the constant and the bytes have drifted`);
  }
});

test('the licence travels with the code', () => {
  // pdf.js is Apache-2.0. The same rule the fonts and the stickers are held to
  // by tests/fonts-license.test.js and tests/stickers-license.test.js: what
  // ships carries its notice.
  const licence = read(join(DIR, 'LICENSE.txt'));
  assert.match(licence, /Apache License/);
  assert.match(licence, /Version 2\.0/);
});

test('nothing in the module reaches for a CDN any more', () => {
  const src = read(join(WEB, 'assets', 'js', 'import', 'pdf.ts'))
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^[ \t]*\/\/.*$/gm, '');
  assert.doesNotMatch(src, /['"`]https?:\/\//,
    'import/pdf.ts names a remote host again - the deploy will refuse it');
});

test('the shipped bundle carries the local path and not the old one', () => {
  // web/assets/app.js is committed and is what visitors get, so the check that
  // matters is against the built file rather than against the source.
  const bundle = read(join(WEB, 'assets', 'app.js'));
  assert.ok(bundle.includes('assets/vendor/pdfjs/'), 'the bundle does not name the vendored copy');
  assert.ok(!bundle.includes('pdfjs-dist'), 'the bundle still names the CDN package');
});

test('the vendored library is deliberately not precached', () => {
  // 1.7 MB on every install, for a feature most boards never touch, is a worse
  // trade than a first PDF that needs the network - after which the service
  // worker has it like any other asset. Asserted so that adding it to SHELL is
  // a decision somebody makes on purpose rather than a line that slips in.
  const sw = read(join(WEB, 'sw.js'));
  const shell = sw.slice(sw.indexOf('SHELL'), sw.indexOf(']', sw.indexOf('SHELL')));
  assert.ok(!shell.includes('vendor/pdfjs'),
    'pdf.js is in SHELL - if that is intended, say so here and change this test');
});
