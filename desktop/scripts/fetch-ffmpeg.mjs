// Fetch a per-platform ffmpeg static build into desktop/resources/ffmpeg/.
// Not committed (~80 MB); without it the desktop falls through to the wasm
// path (web behaviour). URLs are GPL builds with no non-free codecs —
// **non-free (e.g. libfdk-aac) would make the binary undistributable**.
// Pinned by version, not "latest". No signature check (none published);
// rejects downloads that are obviously an error page (< 5 MB).

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
    // gyan.dev GPL build, no non-free codecs.
    url: 'https://github.com/GyanD/codexffmpeg/releases/download/7.1/ffmpeg-7.1-essentials_build.zip',
    member: /bin\/ffmpeg\.exe$/,
    name: 'ffmpeg.exe',
  },
  darwin: {
    // evermeet.cx signed GPL build.
    url: 'https://evermeet.cx/ffmpeg/ffmpeg-7.1.zip',
    member: /(^|\/)ffmpeg$/,
    name: 'ffmpeg',
  },
  linux: {
    // johnvansickle.com GPL static build, pinned by version rather than the
    // moving ffmpeg-release alias. The site moves a release to old-releases/
    // once a newer one ships, so that address is the fallback.
    url: 'https://johnvansickle.com/ffmpeg/releases/ffmpeg-7.0.2-amd64-static.tar.xz',
    fallback: 'https://johnvansickle.com/ffmpeg/old-releases/ffmpeg-7.0.2-amd64-static.tar.xz',
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
let response = await fetch(source.url, { redirect: 'follow' });
if (!response.ok && source.fallback) {
  console.log(`${response.status} there - fetching ${source.fallback}`);
  response = await fetch(source.fallback, { redirect: 'follow' });
}
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

// System tar (or PowerShell Expand-Archive on Windows) — no dependency.
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
// Zip does not carry the executable bit.
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
