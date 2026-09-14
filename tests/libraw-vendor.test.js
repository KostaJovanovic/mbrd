// The camera RAW developer this app carries (libraw-wasm, LibRaw in wasm), and
// the checklist tests/archive-vendor.test.js applies to libarchive: the files
// are here and whole, they speak the contract the module expects, the pin
// matches, the licence travels, it loads from this origin, and it is neither
// precached nor bundled.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, statSync } from 'node:fs';
import { join } from 'node:path';

import { WEB, JS, read } from './helpers.js';
import { LIBRAW_VERSION, WORKER_URL } from '../web/assets/js/optimize/demosaic.ts';

const DIR = join(WEB, 'assets', 'vendor', 'libraw');
const MODULE = join(JS, 'optimize', 'demosaic.ts');

test('the wrapper, its worker and its wasm are actually here', () => {
  for (const name of ['index.js', 'worker.js', 'libraw.js', 'libraw.wasm', 'LICENSE.txt']) {
    assert.ok(existsSync(join(DIR, name)), `web/assets/vendor/libraw/${name} is missing`);
  }
  // Size, not a hash: a truncated copy is what a partial checkout produces.
  assert.ok(statSync(join(DIR, 'libraw.wasm')).size > 1_000_000, 'libraw.wasm is too small to be it');
  assert.ok(statSync(join(DIR, 'worker.js')).size > 40_000, 'worker.js is too small to be it');
});

test('the files still speak the contract the module expects', () => {
  const index = read(join(DIR, 'index.js'));
  // index.js spawns the worker from beside itself, and that path is the one
  // _headers exempts (tests/csp.test.js reads WORKER_URL for it).
  assert.match(index, /new Worker\(new URL\("\.\/worker\.js",import\.meta\.url\),\{type:"module"\}\)/,
    'index.js no longer spawns ./worker.js beside itself as a module worker');
  for (const method of ['open', 'metadata', 'imageData', 'dispose']) {
    assert.match(index, new RegExp(`\\b${method}\\(`), `index.js no longer has ${method}()`);
  }
  const worker = read(join(DIR, 'worker.js'));
  assert.ok(worker.includes('libraw.wasm') && worker.includes('libraw.js'),
    'the worker no longer loads libraw.js and libraw.wasm beside itself');
});

test('WORKER_URL names the file index.js spawns', () => {
  const base = 'https://mbrd.test/';
  const src = read(MODULE);
  const dir = /LIB_DIR = '([^']+)'/.exec(src)?.[1];
  assert.ok(dir, 'optimize/demosaic.ts no longer names LIB_DIR');
  assert.equal(new URL(WORKER_URL, base).href, new URL('./worker.js', new URL(`${dir}index.js`, base)).href,
    'the exempted worker path is not where index.js looks for it');
});

test('the pin is the version in THIRD-PARTY.md', () => {
  assert.match(LIBRAW_VERSION, /^\d+\.\d+\.\d+$/);
  assert.ok(read(join(WEB, '..', '.github', 'THIRD-PARTY.md')).includes(`libraw-wasm ${LIBRAW_VERSION}`),
    'THIRD-PARTY.md names another version than optimize/demosaic.ts pins');
});

test('the licence travels with the code', () => {
  const licence = read(join(DIR, 'LICENSE.txt'));
  assert.match(licence, /GNU LESSER GENERAL PUBLIC LICENSE/);
  assert.match(licence, /LibRaw LLC/);
  assert.match(licence, /ISC/);
});

test('the module loads it from this origin', () => {
  const src = read(MODULE).replace(/\/\*[\s\S]*?\*\//g, '').replace(/^[ \t]*\/\/.*$/gm, '');
  assert.ok(src.includes('./assets/vendor/libraw/'), 'optimize/demosaic.ts does not load the vendored copy');
  assert.doesNotMatch(src, /['"`]https?:\/\//, 'optimize/demosaic.ts names a remote host - the deploy will refuse it');
});

test('it is deliberately not precached, and not in the bundle', () => {
  const sw = read(join(WEB, 'sw.js'));
  const shell = sw.slice(sw.indexOf('SHELL'), sw.indexOf(']', sw.indexOf('SHELL')));
  assert.ok(!shell.includes('vendor/libraw'), 'libraw is in SHELL - if that is intended, say so here');
  // The LGPL argument in THIRD-PARTY.md rests on this: bundled, it is one work.
  assert.ok(!read(join(WEB, 'assets', 'app.js')).includes('LibRaw disposed'), 'libraw has been bundled into app.js');
});
