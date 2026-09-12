// The one library this app carries rather than fetches. import/pdf.ts used
// to load pdf.js from cdn.jsdelivr.net, but web/_headers refuses both the
// import and its worker on the deployed site - firstPageRaster()'s catch
// swallowed both, turning every PDF into a grey named card, dead exactly
// where anybody would see it and alive only under tools/serve.py. This
// file keeps the vendored arrangement honest: files present, pin true,
// licence shipped, no path back to a CDN.

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
  // The worker is the big half a partial checkout loses first; a
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
  // pdf.js is Apache-2.0 - the same rule fonts and stickers are held to:
  // what ships carries its notice.
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
  // web/assets/app.js is committed and is what visitors get, so this
  // checks the built file, not the source.
  const bundle = read(join(WEB, 'assets', 'app.js'));
  assert.ok(bundle.includes('assets/vendor/pdfjs/'), 'the bundle does not name the vendored copy');
  assert.ok(!bundle.includes('pdfjs-dist'), 'the bundle still names the CDN package');
});

test('the vendored library is deliberately not precached', () => {
  // 1.7MB on every install for a rarely-used feature is a worse trade than
  // a first PDF needing the network. Guards against adding it to SHELL by
  // accident.
  const sw = read(join(WEB, 'sw.js'));
  const shell = sw.slice(sw.indexOf('SHELL'), sw.indexOf(']', sw.indexOf('SHELL')));
  assert.ok(!shell.includes('vendor/pdfjs'),
    'pdf.js is in SHELL - if that is intended, say so here and change this test');
});
