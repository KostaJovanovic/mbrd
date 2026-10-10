// Every library this app carries under web/assets/vendor rather than fetches,
// held to one checklist: the files are here and whole, the pin matches the
// bytes and THIRD-PARTY.md, the licence travels, the code loads it from this
// origin, and it is neither precached nor bundled. A CDN copy works under
// tools/serve.py and is refused by the deployed CSP, which is how pdf.js was
// once dead in production. Each library's own contract follows the table.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

import { JS, THIRD_PARTY, WEB, read } from './helpers.js';
import { LIBARCHIVE_VERSION } from '../web/assets/js/import/archive.ts';
import { HEIC2ANY_VERSION } from '../web/assets/js/import/heif.ts';
import { PDF_VERSION } from '../web/assets/js/import/pdf.ts';
import { ORT_VERSION, MODEL_NAME } from '../web/assets/js/canvas/matte.ts';
import { OCCT_DIR, OCCT_VERSION, WORKER_URL as OCCT_WORKER } from '../web/assets/js/mesh/occt.ts';
import { LIBRAW_VERSION, WORKER_URL as LIBRAW_WORKER } from '../web/assets/js/optimize/demosaic.ts';
import { KATEX_VERSION } from '../web/assets/js/ui/math.ts';

const VENDOR = join(WEB, 'assets', 'vendor');
const vendor = (rel) => join(VENDOR, ...rel.split('/'));
const source = (rel) => join(JS, ...rel.split('/'));

/**
 * One row a library. `files` maps each path under vendor/ to the least size it
 * can have: a truncated copy is what a partial checkout or a Git LFS pointer
 * produces, and it fails at run time with nothing readable in the console.
 * `credit` is how THIRD-PARTY.md names it before the version, `carries` the
 * files whose bytes must hold the pin. `loaders` are the sources that reach
 * it, each with the path it must name. `bundled` is a string only the library
 * contains, which app.js must not; `named` one the bundle must.
 */
const VENDORS = [
  {
    name: 'pdf.js', dirs: ['pdfjs'], version: PDF_VERSION, credit: 'pdf.js',
    files: { 'pdfjs/pdf.min.mjs': 100_000, 'pdfjs/pdf.worker.min.mjs': 500_000, 'pdfjs/LICENSE.txt': 0 },
    carries: ['pdfjs/pdf.min.mjs', 'pdfjs/pdf.worker.min.mjs'],
    licences: { 'pdfjs/LICENSE.txt': [/Apache License/, /Version 2\.0/] },
    loaders: { 'import/pdf.ts': 'vendor/pdfjs/' },
    bundled: 'pdfjs-dist', named: 'assets/vendor/pdfjs/',
  },
  {
    name: 'UTIF.js and pako', dirs: ['utif', 'pako'],
    files: {
      'utif/UTIF.js': 40_000, 'utif/LICENSE.txt': 0,
      'pako/pako_inflate.min.js': 15_000, 'pako/LICENSE.txt': 0,
    },
    licences: { 'utif/LICENSE.txt': [/MIT License/, /Photopea/], 'pako/LICENSE.txt': [/MIT License/i] },
    loaders: { 'import/tiff-worker.js': ['vendor/pako/pako_inflate.min.js', 'vendor/utif/UTIF.js'] },
    bundled: 'UTIF.decodeImage', named: 'tiff-worker.js',
  },
  {
    name: 'libarchive.js', dirs: ['libarchive'], version: LIBARCHIVE_VERSION, credit: 'libarchive.js',
    files: {
      'libarchive/libarchive.js': 0, 'libarchive/worker-bundle.js': 40_000,
      'libarchive/libarchive.wasm': 900_000, 'libarchive/LICENSE.txt': 0,
    },
    wasm: ['libarchive/libarchive.wasm'],
    licences: { 'libarchive/LICENSE.txt': [/MIT License/] },
    loaders: { 'import/archive.ts': './assets/vendor/libarchive/' },
    bundled: 'getEntrySize',
  },
  {
    name: 'libraw-wasm', dirs: ['libraw'], version: LIBRAW_VERSION, credit: 'libraw-wasm',
    files: {
      'libraw/index.js': 0, 'libraw/worker.js': 40_000, 'libraw/libraw.js': 0,
      'libraw/libraw.wasm': 1_000_000, 'libraw/LICENSE.txt': 0,
    },
    wasm: ['libraw/libraw.wasm'],
    licences: { 'libraw/LICENSE.txt': [/GNU LESSER GENERAL PUBLIC LICENSE/, /LibRaw LLC/, /ISC/] },
    loaders: { 'optimize/demosaic.ts': './assets/vendor/libraw/' },
    // The LGPL argument in THIRD-PARTY.md rests on this: bundled, it is one work.
    bundled: 'LibRaw disposed',
  },
  {
    name: 'heic2any', dirs: ['heic2any'], version: HEIC2ANY_VERSION, credit: 'heic2any',
    files: { 'heic2any/heic2any.min.js': 1_000_000, 'heic2any/LICENSE.txt': 0 },
    licences: { 'heic2any/LICENSE.txt': [/MIT License/, /GNU Lesser General Public License/] },
    loaders: { 'import/heif-worker.js': 'vendor/heic2any/heic2any.min.js' },
    bundled: 'libde265',
  },
  {
    name: 'onnxruntime-web', dirs: ['onnxruntime'], version: ORT_VERSION, credit: 'onnxruntime-web',
    // The entry resolves the other two from its own directory at run time
    // (`ort.env.wasm.wasmPaths` in canvas/matte-worker.js).
    files: {
      'onnxruntime/ort.wasm.min.mjs': 0, 'onnxruntime/ort-wasm-simd-threaded.mjs': 0,
      'onnxruntime/ort-wasm-simd-threaded.wasm': 10_000_000, 'onnxruntime/LICENSE.txt': 0,
    },
    carries: ['onnxruntime/ort.wasm.min.mjs'],
    wasm: ['onnxruntime/ort-wasm-simd-threaded.wasm'],
    licences: { 'onnxruntime/LICENSE.txt': [/MIT License/, /Microsoft/] },
    loaders: { 'canvas/matte.ts': null, 'canvas/matte-worker.js': null },
    named: 'assets/js/canvas/matte-worker.js',
  },
  {
    name: 'u2netp', dirs: ['u2netp'],
    files: { [`u2netp/${MODEL_NAME}.onnx`]: 4_000_000, 'u2netp/LICENSE.txt': 0 },
    licences: { 'u2netp/LICENSE.txt': [/Apache License/, /Version 2\.0/] },
  },
  {
    name: 'occt-import-js', dirs: ['occt'], version: OCCT_VERSION, credit: 'occt-import-js',
    // The .js finds the .wasm beside itself (`locateFile` in occt-worker.js).
    files: { 'occt/occt-import-js.js': 0, 'occt/occt-import-js.wasm': 1_000_000, 'occt/LICENSE.txt': 0 },
    wasm: ['occt/occt-import-js.wasm'],
    licences: {
      'occt/LICENSE.txt': [/GNU LESSER GENERAL PUBLIC LICENSE/, /Version 2\.1/, /occt-import-js/, /Open CASCADE/],
    },
    loaders: { 'mesh/occt-worker.js': 'vendor/occt/occt-import-js.js', 'mesh/occt.ts': null },
    // LGPL-2.1 section 6 lets this GPL-3.0 build use the kernel only while it
    // stays separate: loaded by the worker, never in app.js.
    bundled: 'occtimportjs',
  },
  {
    name: 'KaTeX', dirs: ['katex'], version: KATEX_VERSION, credit: 'KaTeX',
    files: { 'katex/katex.mjs': 100_000, 'katex/katex.min.css': 0, 'katex/LICENSE.txt': 0 },
    carries: ['katex/katex.mjs'],
    licences: { 'katex/LICENSE.txt': [/MIT License|Permission is hereby granted/] },
    loaders: { 'ui/math.ts': null },
  },
];

/** Comments out, so a header may name the CDN it no longer uses. */
const code = (file) => read(file).replace(/\/\*[\s\S]*?\*\//g, '').replace(/^[ \t]*\/\/.*$/gm, '');
const sw = read(join(WEB, 'sw.js'));
const SHELL = sw.slice(sw.indexOf('SHELL'), sw.indexOf(']', sw.indexOf('SHELL')));
const BUNDLE = read(join(WEB, 'assets', 'app.js'));

for (const v of VENDORS) {
  test(`${v.name}: the files are here and whole`, () => {
    for (const [rel, least] of Object.entries(v.files)) {
      assert.ok(existsSync(vendor(rel)), `web/assets/vendor/${rel} is missing`);
      assert.ok(statSync(vendor(rel)).size > least, `web/assets/vendor/${rel} is too small to be it`);
    }
    // \0asm: an HTML error page saved under the right name has a size too.
    for (const rel of v.wasm ?? []) {
      assert.deepEqual([...readFileSync(vendor(rel)).subarray(0, 4)], [0x00, 0x61, 0x73, 0x6d],
        `${rel} does not begin with the wasm magic number`);
    }
  });

  if (v.version) {
    test(`${v.name}: the pin is the build on disk and the one THIRD-PARTY.md names`, () => {
      assert.match(v.version, /^\d+\.\d+\.\d+$/);
      for (const rel of v.carries ?? []) {
        assert.ok(read(vendor(rel)).includes(v.version),
          `${rel} does not carry ${v.version} - the constant and the bytes have drifted`);
      }
      assert.ok(read(THIRD_PARTY).includes(`${v.credit} ${v.version}`),
        `THIRD-PARTY.md names another version of ${v.credit} than the source pins`);
    });
  }

  test(`${v.name}: the licence travels, and is one this project can ship`, () => {
    for (const [rel, patterns] of Object.entries(v.licences)) {
      const licence = read(vendor(rel));
      for (const p of patterns) assert.match(licence, p, `${rel} does not say ${p}`);
      // Either would look like an upgrade in a diff and be wrong on a GPL-3.0 deploy.
      assert.doesNotMatch(licence, /NonCommercial|non-commercial/i, `${rel} is a non-commercial licence`);
      assert.doesNotMatch(licence, /GNU AFFERO/i, `${rel} is the AGPL, which would relicense the whole`);
    }
  });

  if (v.loaders) {
    test(`${v.name}: it loads from this origin`, () => {
      for (const [rel, needs] of Object.entries(v.loaders)) {
        const src = code(source(rel));
        for (const path of [needs ?? []].flat()) {
          assert.ok(src.includes(path), `${rel} does not load ${path}`);
        }
        assert.doesNotMatch(src, /['"`]https?:\/\//, `${rel} names a remote host - the deploy will refuse it`);
      }
    });
  }

  test(`${v.name}: it is deliberately not precached, nor bundled`, () => {
    // Each is read only when its kind of file turns up; on every install it
    // would be megabytes for a rarely used feature. A notice may be precached.
    for (const dir of v.dirs) {
      const precached = SHELL.match(new RegExp(`vendor/${dir}/[^']*`, 'g'))?.filter(p => !p.endsWith('LICENSE.txt'));
      assert.ok(!precached?.length,
        `vendor/${dir} is in SHELL - if that is intended, say so here and change this test`);
    }
    if (v.bundled) assert.ok(!BUNDLE.includes(v.bundled), `${v.name} has been bundled into app.js`);
    if (v.named) assert.ok(BUNDLE.includes(v.named), `the bundle does not name ${v.named}`);
  });
}

// ---------------------------------------------------------------------------
// Each library's own contract
// ---------------------------------------------------------------------------

test('UTIF and pako still speak the contract the TIFF worker expects', () => {
  // UTIF assigns itself to `self.UTIF` and reads `self.pako` back out, which is
  // why the worker is classic. An ES module build would import and then be
  // undefined at first use.
  const utif = read(vendor('utif/UTIF.js'));
  assert.match(utif, /self\.UTIF\s*=/, 'UTIF no longer publishes itself as a global');
  assert.match(utif, /self\.pako/, 'UTIF no longer takes pako from a global');
  assert.ok(/pako/.test(read(vendor('pako/pako_inflate.min.js'))), 'the inflate build does not name itself');
  assert.match(read(source('import/tiff-worker.js')), /importScripts\(/, 'the worker does not import the library at all');
});

test('the TIFF ceiling means the same number in the worker and the module', () => {
  // The worker refuses a page past it; the module puts it in the sentence
  // somebody answers. A classic worker cannot import, so it is written twice.
  const inWorker = read(source('import/tiff-worker.js')).match(/const MAX_PIXELS = ([^;]+);/)?.[1]?.trim();
  const inModule = read(source('import/tiff.ts')).match(/const MAX_PIXELS = ([^;]+);/)?.[1]?.trim();
  assert.ok(inWorker, 'the worker has no MAX_PIXELS');
  assert.ok(inModule, 'the module has no MAX_PIXELS');
  assert.equal(inModule, inWorker, 'the decode ceiling is two different numbers');
});

test('libarchive still speaks the contract import/archive.ts expects', () => {
  // Archive.init({ workerUrl }), a worker that finds its wasm beside itself,
  // and the flat list readLibarchive() reads instead of the tree.
  assert.match(read(vendor('libarchive/libarchive.js')), /workerUrl/, 'the library no longer takes a worker URL');
  const worker = read(vendor('libarchive/worker-bundle.js'));
  assert.ok(worker.includes('libarchive.wasm'), 'the worker no longer loads libarchive.wasm');
  assert.match(worker, /listFiles/, 'the worker no longer lists entries');
});

test('libraw still speaks the contract optimize/demosaic.ts expects', () => {
  const index = read(vendor('libraw/index.js'));
  // index.js spawns the worker from beside itself, and that path is the one
  // _headers exempts (tests/csp.test.js reads WORKER_URL for it).
  assert.match(index, /new Worker\(new URL\("\.\/worker\.js",import\.meta\.url\),\{type:"module"\}\)/,
    'index.js no longer spawns ./worker.js beside itself as a module worker');
  for (const method of ['open', 'metadata', 'imageData', 'dispose']) {
    assert.match(index, new RegExp(`\\b${method}\\(`), `index.js no longer has ${method}()`);
  }
  const worker = read(vendor('libraw/worker.js'));
  assert.ok(worker.includes('libraw.wasm') && worker.includes('libraw.js'),
    'the worker no longer loads libraw.js and libraw.wasm beside itself');
});

test('libraw: WORKER_URL names the file index.js spawns', () => {
  const base = 'https://mbrd.test/';
  const dir = /LIB_DIR = '([^']+)'/.exec(read(source('optimize/demosaic.ts')))?.[1];
  assert.ok(dir, 'optimize/demosaic.ts no longer names LIB_DIR');
  assert.equal(new URL(LIBRAW_WORKER, base).href, new URL('./worker.js', new URL(`${dir}index.js`, base)).href,
    'the exempted worker path is not where index.js looks for it');
});

test('the matte model is an ONNX file and not something renamed', () => {
  // A protobuf has no magic number; the producer string torch writes into
  // every export's first bytes tells a model from an error page.
  assert.ok(read(vendor(`u2netp/${MODEL_NAME}.onnx`)).slice(0, 64).includes('pytorch'),
    'the model does not begin like a torch ONNX export - check what was downloaded');
});

test('the matte worker pins its runtime to this origin, one thread and wasm', () => {
  const wk = read(source('canvas/matte-worker.js'));
  // Unset, wasmPaths defaults to a jsdelivr URL that connect-src refuses.
  assert.ok(wk.includes('ort.env.wasm.wasmPaths'),
    'matte-worker.js no longer pins wasmPaths - the runtime will fetch its binary from a CDN');
  assert.ok(wk.includes('ort.env.wasm.numThreads = 1'),
    'matte-worker.js no longer pins numThreads - threads need SharedArrayBuffer, which needs COOP/COEP, '
    + 'which would break the embeds');
  // WebGL lacks int64, and the model computes all 38 of its Resize targets as
  // int64 at run time.
  assert.ok(wk.includes("executionProviders: ['wasm']"), 'matte-worker.js no longer asks for the wasm provider');
  assert.ok(!existsSync(vendor('onnxruntime/ort.webgl.min.mjs')),
    'the WebGL runtime is back - it cannot run this model; see the header of canvas/matte.ts');
  // esbuild never sees it, so a type annotation reaches the browser as a syntax error.
  assert.doesNotMatch(wk, /:\s*(string|number|boolean)\b/,
    'matte-worker.js carries type annotations - it is served raw and the browser will not strip them');
});

test('occt: the worker tells Emscripten where the wasm is, and the paths have not moved', () => {
  assert.match(read(source('mesh/occt-worker.js')), /locateFile/,
    'mesh/occt-worker.js does not tell Emscripten where its .wasm is - it will guess, and guess the page');
  assert.equal(OCCT_DIR, '/assets/vendor/occt/', 'OCCT_DIR no longer points at the vendor directory');
  assert.equal(OCCT_WORKER, '/assets/js/mesh/occt-worker.js',
    'the worker moved - web/_headers drops the policy on the old path');
  assert.match(read(THIRD_PARTY), /web\/assets\/vendor\/occt\/LICENSE\.txt/,
    'THIRD-PARTY.md does not point at the notice beside the kernel');
});

test('occt: the kernel is used, not linked', () => {
  // `import` from a .ts would pull LGPL-2.1 into app.js as one GPL-3.0 work;
  // importScripts from a worker keeps it separate and replaceable.
  for (const rel of ['mesh/occt.ts', 'mesh.ts', 'canvas/model.ts']) {
    assert.ok(!/from ['"][^'"]*vendor\/occt/.test(read(source(rel))),
      `${rel} imports the kernel. That bundles LGPL-2.1 into a GPL-3.0 build - `
      + 'it has to be loaded at run time by the worker. See THIRD-PARTY.md.');
  }
});

test('KaTeX: every woff2 its stylesheet asks for ships', () => {
  // A missing face draws a formula in the fallback serif, with nothing in the console.
  const css = read(vendor('katex/katex.min.css'));
  const fonts = [...new Set([...css.matchAll(/url\((fonts\/[^)]+\.woff2)\)/g)].map(m => m[1]))];
  assert.ok(fonts.length >= 10, `only ${fonts.length} woff2 faces named - has the sheet changed?`);
  for (const f of fonts) assert.ok(existsSync(join(VENDOR, 'katex', f)), `${f} is named and missing`);
});
