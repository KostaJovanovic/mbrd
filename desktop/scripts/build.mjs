// Builds the shell into dist/: main and the board's preload (Node, CommonJS),
// the chrome preload, the chrome pages' browser scripts, and a copy of the
// chrome's .html and .css beside them. One folder, which electron-builder's
// `files: dist/**` ships whole, so no chrome file can be left out of a package
// the way FileAnalyser 9.8 left out its title bar.

import { build } from 'esbuild';
import { copyFile, mkdir, readdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const DESKTOP = join(dirname(fileURLToPath(import.meta.url)), '..');
const DIST = join(DESKTOP, 'dist');
const CHROME = join(DESKTOP, 'chrome');
const OUT = join(DIST, 'chrome');

// CommonJS, because a preload under sandbox:true must be, and main follows so
// the package has one rule. The native modules carry .node binaries esbuild
// cannot inline, so they stay external and ship in node_modules.
const node = { bundle: true, platform: 'node', format: 'cjs', target: 'node20', logLevel: 'info' };

await build({
  ...node,
  entryPoints: [join(DESKTOP, 'main.ts'), join(DESKTOP, 'preload.ts')],
  outdir: DIST,
  external: ['electron', 'sharp', 'onnxruntime-node'],
});

await build({
  ...node,
  entryPoints: [join(CHROME, 'preload.ts')],
  outfile: join(OUT, 'preload.js'),
  external: ['electron'],
});

// Classic scripts, not modules: look.js has to block in the head, before the
// first paint, and the other two follow the same shape.
await build({
  bundle: true,
  platform: 'browser',
  format: 'iife',
  target: 'es2022',
  logLevel: 'info',
  entryPoints: ['titlebar.ts', 'panel.ts', 'look.ts'].map(name => join(CHROME, name)),
  outdir: OUT,
});

await mkdir(OUT, { recursive: true });
for (const name of await readdir(CHROME)) {
  if (/\.(html|css)$/.test(name)) await copyFile(join(CHROME, name), join(OUT, name));
}
