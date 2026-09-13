// Build the portable copy into desktop/portable/.
// Produces what installer.nsh's Portable branch would: the unpacked app plus a
// `portable` marker, without building the 202 MB installer. portable/data/
// survives rebuilds (boards live there); everything else is replaced.
// electron-builder's `win-unpacked` is built to a scratch dir and moved up.

import { rm, mkdir, readdir, rename, writeFile, access } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { stampedVersion } from './version.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const DESKTOP = join(HERE, '..');
const DIST = join(DESKTOP, 'portable');
const SCRATCH = join(DESKTOP, 'out', 'portable-scratch');

/** The marker, byte for byte what installer.nsh's Portable branch writes. */
const MARKER = 'This copy of mbrd keeps its data in the data folder beside it.\r\n';

/** Run a shell command line, inherit stdio, reject on non-zero exit. */
function run(line, cwd) {
  return new Promise((resolve, reject) => {
    const child = spawn(line, { cwd, stdio: 'inherit', shell: true });
    child.on('error', reject);
    child.on('close', code => code === 0 ? resolve() : reject(new Error(`exited ${code}: ${line}`)));
  });
}

const exists = path => access(path).then(() => true, () => false);

// ---------------------------------------------------------------------------

if (!await exists(join(DESKTOP, 'resources', 'ffmpeg'))) {
  // Not fatal — the desktop falls back to the wasm path (web behaviour).
  console.warn('[portable] no desktop/resources/ffmpeg - run `npm run fetch:ffmpeg` for the video features');
}

// The stamped version, as the release workflow passes it. desktop/package.json
// says 0.0.0, and without this the copy would too.
const { version } = await stampedVersion();

await rm(SCRATCH, { recursive: true, force: true });
console.log(`[portable] packing ${version}`);
await run(`npx electron-builder --win --dir "-c.directories.output=${SCRATCH}" "-c.extraMetadata.version=${version}"`, DESKTOP);

const unpacked = join(SCRATCH, 'win-unpacked');
if (!await exists(unpacked)) {
  console.error(`[portable] electron-builder wrote no ${unpacked} - has the unpacked directory been renamed?`);
  process.exit(1);
}

// Replace everything except data/ (boards live there).
console.log('[portable] replacing desktop/portable/');
await mkdir(DIST, { recursive: true });
for (const entry of await readdir(DIST)) {
  if (entry === 'data') continue;
  await rm(join(DIST, entry), { recursive: true, force: true });
}

for (const entry of await readdir(unpacked)) {
  await rename(join(unpacked, entry), join(DIST, entry));
}

await writeFile(join(DIST, 'portable'), MARKER);
await rm(SCRATCH, { recursive: true, force: true });

console.log(`[portable] ${join(DIST, 'mbrd.exe')}`);
console.log('[portable] boards will be kept in desktop/portable/data');
