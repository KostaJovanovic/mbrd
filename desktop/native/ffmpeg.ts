// Native ffmpeg as a child process — poster frames and video transcoding.
// One job at a time (ffmpeg saturates cores on its own). Each job is killed
// at CEILING_MS to guard against truncated/hostile input. Pipes, not temp
// files. Falls back to the wasm path when no binary is bundled.

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

// undefined = not looked yet, null = looked and absent (normal — wasm fallback).
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

// Pipes, not temp files. Pipe cost: ffmpeg cannot seek input, so commands
// must work with a streaming demuxer (e.g. first frame, not seek-to-timestamp).
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
      // Bound on runaway output from broken input.
      if (size > MAX_OUTPUT) { finish(null, 'output past the ceiling'); return; }
      out.push(chunk);
    });
    // Drain stderr — an unread pipe blocks the process.
    child.stderr.resume();
    child.on('error', err => finish(null, 'could not start: ' + String(err)));
    child.on('close', code => {
      if (done) return;
      // Non-zero with output is still a failure — header may have been written before error.
      finish(code === 0 && out.length ? Buffer.concat(out) : null,
        code === 0 ? undefined : 'exited ' + code);
    });

    // EPIPE is normal — ffmpeg stops reading once it has the frame it needs.
    child.stdin.on('error', () => {});
    child.stdin.end(Buffer.from(input));
  });

  // Sequential queue; a failure does not stall later jobs.
  const chained = queue.then(() => job, () => job);
  queue = chained.catch(() => {});
  return chained;
}

/** First frame as PNG for clips the browser cannot decode. */
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

/** Shrink a clip to H.264/AAC MP4. scale only shrinks, never upscales. */
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
    // Fragmented — a pipe cannot seek back to write the moov atom.
    '-movflags', 'frag_keyframe+empty_moov+default_base_moof',
    '-f', 'mp4',
    'pipe:1',
  ], bytes);
}
