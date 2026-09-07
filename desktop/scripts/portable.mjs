// Build the portable copy, into desktop/portable/.
//
//   npm run portable          (from desktop/, or `npm run portable` at the root)
//
// It used to be dist/ at the repository root, on the reasoning that the root is
// where somebody looks for a built app. It is here now because the root is a
// place you read, not a place to park 250 MB of build output: everything the
// shell produces is under desktop/ already - out/ for the installers, dist/ for
// the two esbuild bundles - and this was the one thing reaching up out of it.
// Not desktop/dist/, which is taken.
//
// ── What a portable copy is here ──
//
// Not a target. installer.nsh's Portable branch is a page inside the one
// Setup.exe, and what it leaves on disk is the unpacked application plus a
// `portable` marker file beside the executable - see the head of that file for
// what the marker promises and what it gives up. This script produces exactly
// that, and skips the 202 MB installer that would otherwise have to be run to
// get it.
//
// So `portable/mbrd.exe` is the app, `portable/data/` is where it keeps boards
// (main.ts finds the marker before `ready` and moves userData there), and the
// folder is the whole of it - copy it to a stick and it comes off the machine
// leaving nothing behind.
//
// ── Why the folder is moved rather than built in place ──
//
// electron-builder names the unpacked directory `win-unpacked` and that name is
// not configurable, so building straight into portable/ gives
// portable/win-unpacked/ - a folder inside the folder, and an mbrd.exe one level
// from where this script promises it. It is built into a scratch directory under
// desktop/out/ and the contents moved up, which costs one rename on the same
// volume.
//
// ── portable/data/ is somebody's work and survives a rebuild ──
//
// The one thing in here this script did not put there. A portable copy that is
// rebuilt has boards, a recovery store and a shelf in it, and deleting them to
// make room for a new binary is the shape of mistake that is only noticed after
// it matters. Everything else in portable/ is replaced.

import { rm, mkdir, readdir, rename, writeFile, access } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';

const HERE = dirname(fileURLToPath(import.meta.url));
const DESKTOP = join(HERE, '..');
const DIST = join(DESKTOP, 'portable');
const SCRATCH = join(DESKTOP, 'out', 'portable-scratch');

/** The marker, byte for byte what installer.nsh's Portable branch writes. */
const MARKER = 'This copy of mbrd keeps its data in the data folder beside it.\r\n';

/**
 * Run a command line through the shell, inheriting stdio, and reject on a
 * non-zero exit.
 *
 * One string rather than a command and an args array, which is not the usual
 * advice and is the right call here. `npx` and `electron-builder` are `.cmd`
 * shims on Windows and Node refuses to spawn one without a shell - so the shell
 * is not optional - and passing an args array *with* a shell is the combination
 * Node deprecated in DEP0190, because the arguments are concatenated rather than
 * escaped and the escaping people assume is happening is not. A single string
 * says plainly that this is a command line. Everything interpolated into it is a
 * path this file computed.
 */
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
  // A warning and not an error, which matches what fetch-ffmpeg.mjs says about
  // itself: a build without it is a desktop with no video features and every
  // caller falling through to the wasm path, which is the web's behaviour.
  console.warn('[portable] no desktop/resources/ffmpeg - run `npm run fetch:ffmpeg` for the video features');
}

await rm(SCRATCH, { recursive: true, force: true });
console.log('[portable] packing');
await run(`npx electron-builder --win --dir "-c.directories.output=${SCRATCH}"`, DESKTOP);

const unpacked = join(SCRATCH, 'win-unpacked');
if (!await exists(unpacked)) {
  console.error(`[portable] electron-builder wrote no ${unpacked} - has the unpacked directory been renamed?`);
  process.exit(1);
}

// Clear it of everything this script put there last time, and nothing else.
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
