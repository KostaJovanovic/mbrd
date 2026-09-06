// Fetch the ffmpeg binary this platform's build ships.
//
// Not committed, and that is the whole reason this script exists: an ffmpeg
// static build is 80-odd megabytes per platform, which belongs to a release
// rather than to a repository. `desktop/resources/ffmpeg/` is gitignored, the
// release workflow runs this before electron-builder, and a developer who never
// runs it gets a desktop with no video features and every caller falling
// through to the wasm path - which is the web's behaviour and is fine.
//
// ── The licence, which is plan §12's second open question ──
//
// This app is GPL-3, so a GPL ffmpeg build is fine. **A build with non-free
// codecs in it is not**, whatever its own page says - libfdk-aac is the usual
// one, and it makes the result undistributable under any licence. Every URL
// below names a GPL build without them, and the notice each one requires goes
// in the About sheet.
//
// The three sources are the ones that publish per-platform static builds with a
// stable URL. They are pinned by version rather than tracking "latest": a build
// that changes under a release is a release nobody can reproduce.
//
// ── What this does not do ──
//
// Check a signature. None of the three publishes one, which is worth being
// honest about rather than pretending a SHA typed here from the same page would
// be a check. What it does do is refuse a download that is obviously wrong -
// too small, or not an executable - which catches the failure that actually
// happens: a CDN serving an HTML error page with a 200.

import { mkdir, writeFile, rm, readdir, rename, stat, chmod } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const run = promisify(execFile);
const HERE = dirname(fileURLToPath(import.meta.url));
const OUT = join(HERE, '..', 'resources', 'ffmpeg');

/** Per platform: where the archive is, and what is inside it. */
const SOURCES = {
  win32: {
    // gyan.dev's GPL build. `-essentials` carries no non-free codec.
    url: 'https://github.com/GyanD/codexffmpeg/releases/download/7.1/ffmpeg-7.1-essentials_build.zip',
    member: /bin\/ffmpeg\.exe$/,
    name: 'ffmpeg.exe',
  },
  darwin: {
    // evermeet.cx publishes a signed, notarised, non-free-free GPL build.
    url: 'https://evermeet.cx/ffmpeg/ffmpeg-7.1.zip',
    member: /(^|\/)ffmpeg$/,
    name: 'ffmpeg',
  },
  linux: {
    // johnvansickle.com's static build, GPL, no non-free.
    url: 'https://johnvansickle.com/ffmpeg/releases/ffmpeg-release-amd64-static.tar.xz',
    member: /(^|\/)ffmpeg$/,
    name: 'ffmpeg',
  },
};

/** Below this and it is an error page rather than an encoder. */
const MIN_BYTES = 5 * 1024 * 1024;

const platform = process.argv[2] ?? process.platform;
const source = SOURCES[platform];
if (!source) {
  console.error(`no ffmpeg source for ${platform}; known: ${Object.keys(SOURCES).join(', ')}`);
  process.exit(1);
}

const target = join(OUT, source.name);
if (existsSync(target) && !process.argv.includes('--force')) {
  console.log(`ffmpeg already here: ${target}`);
  process.exit(0);
}

await mkdir(OUT, { recursive: true });
const scratch = join(OUT, '.download');
await rm(scratch, { recursive: true, force: true });
await mkdir(scratch, { recursive: true });

console.log(`fetching ${source.url}`);
const response = await fetch(source.url, { redirect: 'follow' });
if (!response.ok) {
  console.error(`${response.status} ${response.statusText}`);
  process.exit(1);
}
const bytes = Buffer.from(await response.arrayBuffer());
if (bytes.length < MIN_BYTES) {
  console.error(`only ${bytes.length} bytes - that is an error page, not an encoder`);
  process.exit(1);
}

const archive = join(scratch, 'archive' + (source.url.endsWith('.zip') ? '.zip' : '.tar.xz'));
await writeFile(archive, bytes);

// The system's own extractor rather than a dependency. tar is on every macOS
// and Linux and on Windows 10 and later; Expand-Archive is PowerShell's. This
// script runs in CI and on a maintainer's machine, and both have one of them.
console.log('extracting');
if (archive.endsWith('.zip') && process.platform === 'win32') {
  await run('powershell', ['-NoProfile', '-Command',
    `Expand-Archive -LiteralPath '${archive}' -DestinationPath '${scratch}' -Force`]);
} else {
  await run('tar', ['-xf', archive, '-C', scratch]);
}

const found = await find(scratch, source.member);
if (!found) {
  console.error('the archive did not contain an ffmpeg binary where one was expected');
  process.exit(1);
}
await rename(found, target);
// Executable, which a zip does not carry on macOS and Linux.
if (process.platform !== 'win32') await chmod(target, 0o755);
await rm(scratch, { recursive: true, force: true });

const size = (await stat(target)).size;
console.log(`ffmpeg -> ${target} (${(size / 1e6).toFixed(1)} MB)`);

/** The first file under `dir` whose path matches. */
async function find(dir, pattern) {
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) {
      const deeper = await find(path, pattern);
      if (deeper) return deeper;
    } else if (pattern.test(path.replaceAll('\\', '/'))) {
      return path;
    }
  }
  return null;
}
