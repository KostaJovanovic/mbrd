// ffmpeg, as a child process.
//
// The web has a WebAssembly build of this fetched from a CDN, and the header of
// optimize/media.ts says what it costs: a single-threaded encoder that pins a
// core for the length of the clip, which is why **video optimisation was
// dropped on the web** and only the poster frame kept. A native binary does not
// have that problem, which makes shrinking a clip the first user-visible thing
// the desktop can do that the browser cannot.
//
// ── One job at a time ──
//
// Not a pool. ffmpeg is already good at using every core it can see, so two of
// them are two processes fighting over the same cores plus twice the memory,
// and the thing being waited on is one person pressing Optimise. The queue is a
// promise chain, the same shape canvas/matte.ts uses for the same reason.
//
// ── A ceiling, and why it is generous ──
//
// A hostile or broken file can make ffmpeg sit forever - a truncated container
// it keeps waiting for more of, a stream with a nonsense duration. So every job
// is killed at a ceiling. The number is minutes rather than seconds because the
// legitimate case is a long clip on a slow laptop, and a poster frame that gave
// up on a real file would be worse than one that took a while: the caller falls
// back to the browser's own decoder, and that is the path this was meant to
// replace.
//
// ── The licence ──
//
// This app is GPL-3, so a GPL ffmpeg build is fine and an LGPL one would be
// too. A build with non-free codecs in it - libfdk-aac is the usual one - is
// not, whatever its own README says. The fetch script names the build and the
// About sheet carries its notice; that is plan §12's second open question and
// it is answered by which URL the script points at.

import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { app } from 'electron';
import { log } from '../log.ts';

/** Long enough for a real clip on a slow machine; short enough to be a ceiling. */
const CEILING_MS = 5 * 60 * 1000;

/** Bigger than any poster frame, and a bound on a process that will not stop. */
const MAX_OUTPUT = 512 * 1024 * 1024;

let queue: Promise<unknown> = Promise.resolve();
let located: string | null | undefined;

/**
 * Where the binary is, looked for once.
 *
 * `process.resourcesPath` in a packaged app - electron-builder puts
 * `extraResources` there - and `desktop/resources` in development, which is
 * where the fetch script writes. `undefined` means "not looked yet" and `null`
 * means "looked, and there is none", which is a build without the fetch step
 * and a perfectly ordinary state: every caller falls through to the wasm path.
 */
function binary(): string | null {
  if (located !== undefined) return located;
  const name = process.platform === 'win32' ? 'ffmpeg.exe' : 'ffmpeg';
  const roots = app.isPackaged
    ? [join(process.resourcesPath, 'ffmpeg')]
    : [join(app.getAppPath(), 'resources', 'ffmpeg'), join(app.getAppPath(), '..', 'desktop', 'resources', 'ffmpeg')];
  located = null;
  for (const root of roots) {
    const path = join(root, name);
    if (existsSync(path)) { located = path; break; }
  }
  log('info', located ? 'ffmpeg found' : 'no ffmpeg bundled - the wasm path stays', { path: located });
  return located;
}

/** Whether there is a native encoder at all. The renderer asks before offering. */
export function available(): boolean {
  return binary() !== null;
}

/**
 * Run ffmpeg over bytes on stdin, collecting stdout.
 *
 * Pipes rather than temp files, which is not only tidiness: a board's clip is
 * already in memory on the renderer's side and about to cross the bridge, and
 * writing it to disk to read it straight back would double the I/O of every
 * job for the sake of a path nobody needs.
 *
 * The one thing a pipe costs is that ffmpeg cannot seek its input, so every
 * command below has to be one a streaming demuxer can serve. That is why the
 * poster frame asks for the *first* frame rather than one at a timestamp.
 */
function run(args: string[], input: ArrayBuffer): Promise<Buffer | null> {
  const exe = binary();
  if (!exe) return Promise.resolve(null);

  const job = new Promise<Buffer | null>(resolve => {
    const child = spawn(exe, args, { stdio: ['pipe', 'pipe', 'pipe'] });
    const out: Buffer[] = [];
    let size = 0;
    let done = false;

    const finish = (value: Buffer | null, why?: string) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      if (why) log('warn', 'ffmpeg: ' + why);
      child.kill('SIGKILL');
      resolve(value);
    };

    const timer = setTimeout(() => finish(null, `killed at the ${CEILING_MS}ms ceiling`), CEILING_MS);

    child.stdout.on('data', (chunk: Buffer) => {
      size += chunk.length;
      // A bound on a process that will not stop producing. Without it a broken
      // input that ffmpeg reads as an endless stream fills memory rather than
      // failing.
      if (size > MAX_OUTPUT) { finish(null, 'output past the ceiling'); return; }
      out.push(chunk);
    });
    // Drained and discarded. ffmpeg is talkative on stderr even when it
    // succeeds, and a pipe nobody reads fills and blocks the process.
    child.stderr.resume();
    child.on('error', err => finish(null, 'could not start: ' + String(err)));
    child.on('close', code => {
      if (done) return;
      // A non-zero exit with bytes on stdout is still a failure: ffmpeg writes
      // a container header before it knows whether it can finish.
      finish(code === 0 && out.length ? Buffer.concat(out) : null,
        code === 0 ? undefined : 'exited ' + code);
    });

    // EPIPE is the ordinary case, not an error: ffmpeg stops reading the moment
    // it has the frame it was asked for, which is long before a clip has
    // finished arriving.
    child.stdin.on('error', () => {});
    child.stdin.end(Buffer.from(input));
  });

  // One at a time, and the chain survives a failure so one bad clip does not
  // stall every clip behind it.
  const chained = queue.then(() => job, () => job);
  queue = chained.catch(() => {});
  return chained;
}

/**
 * A still from the first frame, for a clip the browser cannot decode.
 *
 * What optimize/media.ts does today with the wasm build, and the reason it
 * exists at all: HEVC out of a phone is a container Chromium will not open, so
 * the card is a grey rectangle with a filename on it. This is the same answer
 * without the download.
 *
 * PNG rather than JPEG because the caller re-encodes it anyway - see the poster
 * path - and a lossless hand-off means the one lossy step is the one somebody
 * chose.
 */
export async function firstFrame(bytes: ArrayBuffer): Promise<Buffer | null> {
  return run([
    '-hide_banner', '-loglevel', 'error',
    '-i', 'pipe:0',
    '-frames:v', '1',
    '-f', 'image2', '-c:v', 'png',
    'pipe:1',
  ], bytes);
}

/** What a transcode is allowed to change. Everything else is ffmpeg's default. */
export interface TranscodeOpts {
  maxEdge?: number;
  bitrate?: number;
}

/**
 * Shrink a clip. The desktop's own feature, and the web's dropped one.
 *
 * H.264 in an MP4 with faststart, because the result goes back onto a board and
 * is played by the same Chromium the web app uses - so the one format every
 * decoder in that browser certainly has is the right answer, not the newest one.
 *
 * `-vf scale` only ever shrinks: the `min(iw,N)` form leaves a clip that is
 * already small alone rather than blowing it up to the ceiling, which is the
 * same rule the picture path follows.
 */
export async function transcode(bytes: ArrayBuffer, opts: TranscodeOpts): Promise<Buffer | null> {
  const edge = Math.max(160, Math.round(opts.maxEdge ?? 1600));
  const rate = Math.max(100_000, Math.round(opts.bitrate ?? 2_000_000));
  return run([
    '-hide_banner', '-loglevel', 'error',
    '-i', 'pipe:0',
    '-vf', `scale='min(${edge},iw)':-2:flags=lanczos`,
    '-c:v', 'libx264', '-preset', 'medium', '-b:v', String(rate),
    '-pix_fmt', 'yuv420p',
    '-c:a', 'aac', '-b:a', '128k',
    // fragmented output, because a pipe cannot seek back to write the index a
    // normal MP4 keeps at the front. Chromium plays a fragmented MP4 without
    // complaint; a non-fragmented one written to a pipe is a file with no moov
    // atom, which nothing plays.
    '-movflags', 'frag_keyframe+empty_moov+default_base_moof',
    '-f', 'mp4',
    'pipe:1',
  ], bytes);
}
