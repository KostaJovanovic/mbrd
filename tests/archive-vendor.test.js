// The 7z and RAR reader this app carries (libarchive.js), and the arrangement
// that keeps it honest - the checklist tests/tiff-vendor.test.js applies to the
// TIFF decoder: the files are here and whole, the pin matches them, the licence
// travels, it loads from this origin, and it is neither precached nor bundled.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, statSync } from 'node:fs';
import { join } from 'node:path';

import { WEB, JS, read } from './helpers.js';
import { LIBARCHIVE_VERSION } from '../web/assets/js/import/archive.ts';

const DIR = join(WEB, 'assets', 'vendor', 'libarchive');
const MODULE = join(JS, 'import', 'archive.ts');

test('the library, its worker and its wasm are actually here', () => {
  for (const name of ['libarchive.js', 'worker-bundle.js', 'libarchive.wasm', 'LICENSE.txt']) {
    assert.ok(existsSync(join(DIR, name)), `web/assets/vendor/libarchive/${name} is missing`);
  }
  // Size, not a hash: a truncated copy is what a partial checkout produces.
  assert.ok(statSync(join(DIR, 'libarchive.wasm')).size > 900_000, 'libarchive.wasm is too small to be it');
  assert.ok(statSync(join(DIR, 'worker-bundle.js')).size > 40_000, 'worker-bundle.js is too small to be it');
});

test('the files still speak the contract the module expects', () => {
  // Archive.init({ workerUrl }) and a worker that finds its wasm beside itself.
  assert.match(read(join(DIR, 'libarchive.js')), /workerUrl/, 'the library no longer takes a worker URL');
  assert.ok(read(join(DIR, 'worker-bundle.js')).includes('libarchive.wasm'), 'the worker no longer loads libarchive.wasm');
  // The flat list the module reads instead of the tree (see readLibarchive()).
  assert.match(read(join(DIR, 'worker-bundle.js')), /listFiles/, 'the worker no longer lists entries');
});

test('the pin is the version in THIRD-PARTY.md', () => {
  assert.match(LIBARCHIVE_VERSION, /^\d+\.\d+\.\d+$/);
  assert.ok(read(join(WEB, '..', '.github', 'THIRD-PARTY.md')).includes(`libarchive.js ${LIBARCHIVE_VERSION}`),
    'THIRD-PARTY.md names another version than import/archive.ts pins');
});

test('the licence travels with the code', () => {
  assert.match(read(join(DIR, 'LICENSE.txt')), /MIT License/);
});

test('the module loads it from this origin', () => {
  const src = read(MODULE).replace(/\/\*[\s\S]*?\*\//g, '').replace(/^[ \t]*\/\/.*$/gm, '');
  assert.ok(src.includes('./assets/vendor/libarchive/'), 'import/archive.ts does not load the vendored copy');
  assert.doesNotMatch(src, /['"`]https?:\/\//, 'import/archive.ts names a remote host - the deploy will refuse it');
});

test('it is deliberately not precached, and not in the bundle', () => {
  const sw = read(join(WEB, 'sw.js'));
  const shell = sw.slice(sw.indexOf('SHELL'), sw.indexOf(']', sw.indexOf('SHELL')));
  assert.ok(!shell.includes('vendor/libarchive'), 'libarchive is in SHELL - if that is intended, say so here');
  const bundle = read(join(WEB, 'assets', 'app.js'));
  assert.ok(!bundle.includes('getEntrySize'), 'libarchive has been bundled into app.js');
});
