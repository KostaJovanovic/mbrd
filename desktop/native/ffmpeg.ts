// Native ffmpeg as a child process — poster frames and video transcoding.
// One job at a time (ffmpeg saturates cores on its own). Each job is killed
// at CEILING_MS to guard against truncated/hostile input. The input is a temp
// file and the output a pipe. Falls back to the wasm path when no binary is
// bundled. A transcode tries the best hardware H.264 encoder the probe found,
// then software.
//
// Measured 2026-09-13 on a Ryzen 5 5600X with an RTX 5070 Ti: one 10 s 1080p
// 30 fps clip (ffmpeg's testsrc2, 10 MB) with transcode()'s arguments. The wasm
// core the web pins (@ffmpeg/core 0.12.6, one thread, in Node's V8) 60.6 s.
// Native libx264 1.8 to 2.9 s. NVENC 0.9 to 1.4 s, and 1.2 s through the app.
// What each build fetch-ffmpeg.mjs names carries: gyan.dev 7.1 essentials
// (Windows) lists NVENC, Quick Sync and AMF. evermeet 7.1 (macOS) has
// VideoToolbox only. johnvansickle's "release" (Linux, 7.0.2 that day) has no
// hardware H.264 encoder, so Linux transcodes in software.

import { execFile, spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { app } from 'electron';
import { log } from '../log.ts';
import { FAMILIES, accelerate } from '../ffmpeg-accel.ts';
import type { Family } from '../ffmpeg-accel.ts';

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

// ---------------------------------------------------------------------------
// The probe: which hardware encoders really work here
//
// `ffmpeg -encoders` is not evidence. A full build lists NVENC, Quick Sync and
// AMF on a machine with one of them, and the other two fail at run time. So
// each family's H.264 encoder encodes three throwaway frames, and only an exit
// 0 counts. Cached in userData, keyed by the binary's path, size and mtime, so
// only the first transcode after an ffmpeg change pays for it.
// ---------------------------------------------------------------------------

let probed: Promise<Family[]> | undefined;

/** The hardware families this machine runs, best first. Empty with no binary. */
export function capabilities(): Promise<Family[]> {
  probed ??= probeOnce();
  return probed;
}

async function probeOnce(): Promise<Family[]> {
  const exe = binary();
  if (!exe) return [];
  const file = join(app.getPath('userData'), 'ffmpeg-caps.json');
  const key = binaryKey(exe);
  const cached = readCaps(file, key);
  if (cached) return cached;

  const found = await probe(exe);
  log('info', 'ffmpeg probe', { exe, found: found.map(f => f.label) });
  try {
    writeFileSync(file, JSON.stringify({ key, vendors: found.map(f => f.vendor) }));
  } catch (err) {
    // A lost cache costs one more probe, nothing else.
    log('warn', 'could not keep the ffmpeg probe', { err: String(err) });
  }
  return found;
}

/** The binary's identity. A replaced ffmpeg probes again. */
function binaryKey(exe: string): string {
  try {
    const st = statSync(exe);
    return `${exe}|${st.size}|${Math.round(st.mtimeMs)}`;
  } catch {
    return '';
  }
}

/** The cached answer for this binary, or null. Vendors only, so the encoder
 * names that reach a command line always come from FAMILIES. */
function readCaps(file: string, key: string): Family[] | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== 'object') return null;
  // SAFETY: a non-null object, and both fields are typed unknown and checked below.
  const { key: stored, vendors } = parsed as { key?: unknown, vendors?: unknown };
  if (!key || stored !== key || !Array.isArray(vendors)) return null;
  return FAMILIES.filter(f => vendors.includes(f.vendor));
}

async function probe(exe: string): Promise<Family[]> {
  const listed = await capture(exe, ['-hide_banner', '-encoders']);
  const found: Family[] = [];
  for (const family of FAMILIES) {
    // Not in this build at all, so no spawn is needed to know it fails.
    if (!listed.includes(family.h264)) continue;
    if (await encodes(exe, family.h264)) found.push(family);
  }
  return found;
}

/** The binary's combined output, or what there was of it when it failed. */
function capture(exe: string, args: string[]): Promise<string> {
  return new Promise(resolve => {
    execFile(exe, args, { timeout: 15_000, maxBuffer: 8 * 1024 * 1024, windowsHide: true },
      (_err, stdout, stderr) => resolve(String(stdout) + String(stderr)));
  });
}

/** Whether `encoder` encodes three frames of black with no error. FileAnalyser's probe. */
function encodes(exe: string, encoder: string): Promise<boolean> {
  return new Promise(resolve => {
    const child = spawn(exe, [
      '-hide_banner', '-loglevel', 'error',
      '-f', 'lavfi', '-i', 'color=c=black:s=320x240:d=0.1:r=10',
      '-c:v', encoder, '-frames:v', '3', '-f', 'null', '-',
    ], { stdio: 'ignore', windowsHide: true });
    const timer = setTimeout(() => child.kill('SIGKILL'), 20_000);
    child.on('error', () => { clearTimeout(timer); resolve(false); });
    child.on('close', code => { clearTimeout(timer); resolve(code === 0); });
  });
}

// ---------------------------------------------------------------------------
// Running a job
// ---------------------------------------------------------------------------

/** Where the input goes in an argument list. run() puts the temp file's path there. */
const INPUT = '<input>';

// The input is a temp file, not a pipe. ffmpeg cannot seek a pipe, and an MP4
// with its index after the media (ffmpeg's own default) cannot be read without
// seeking: through a pipe it failed as "partial file" before any encoder ran,
// poster frames included. The output stays a pipe, fragmented where needed.
function run(args: string[], input: ArrayBuffer): Promise<Buffer | null> {
  const exe = binary();
  if (!exe) return Promise.resolve(null);

  // A function, so the queue decides when it starts. It used to be a promise
  // made here, which spawned at once, and the queue ordered only the answers.
  const job = async (): Promise<Buffer | null> => {
    const path = join(app.getPath('temp'), `mbrd-ffmpeg-${randomUUID()}`);
    try {
      await writeFile(path, new Uint8Array(input));
    } catch (err) {
      log('warn', 'ffmpeg: could not write the input', { err: String(err) });
      return null;
    }
    try {
      return await spawnJob(exe, args.map(arg => (arg === INPUT ? path : arg)));
    } finally {
      await rm(path, { force: true }).catch(() => {});
    }
  };

  // Sequential queue; a failure does not stall later jobs.
  const chained = queue.then(job, job);
  queue = chained.catch(() => {});
  return chained;
}

/** One ffmpeg process, its stdout collected. */
function spawnJob(exe: string, args: string[]): Promise<Buffer | null> {
  return new Promise<Buffer | null>(resolve => {
    // windowsHide: a packaged app has no console, and Windows would open one.
    const child = spawn(exe, args, { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
    const out: Buffer[] = [];
    let size = 0;
    let done = false;
    // The end of stderr, for the log when the job fails. -loglevel error keeps it short.
    let errors = '';

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
    // Read, not left: an unread pipe blocks the process.
    child.stderr.on('data', (chunk: Buffer) => { errors = (errors + chunk.toString()).slice(-2000); });
    child.on('error', err => finish(null, 'could not start: ' + String(err)));
    child.on('close', code => {
      if (done) return;
      // Non-zero with output is still a failure — header may have been written before error.
      finish(code === 0 && out.length ? Buffer.concat(out) : null,
        code === 0 ? undefined : `exited ${code}${errors ? ': ' + errors.trim() : ''}`);
    });
  });
}

/** First frame as PNG for clips the browser cannot decode. */
export async function firstFrame(bytes: ArrayBuffer): Promise<Buffer | null> {
  return run([
    '-hide_banner', '-loglevel', 'error',
    '-i', INPUT,
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

/** Shrink a clip to H.264/AAC MP4. scale only shrinks, never upscales. The best
 * hardware family goes first, and when it fails the software list runs as it
 * is, so a driver quirk never loses the clip. */
export async function transcode(bytes: ArrayBuffer, opts: TranscodeOpts): Promise<Buffer | null> {
  const edge = Math.max(160, Math.round(opts.maxEdge ?? 1600));
  const rate = Math.max(100_000, Math.round(opts.bitrate ?? 2_000_000));
  const software = [
    '-hide_banner', '-loglevel', 'error',
    '-i', INPUT,
    '-vf', `scale='min(${edge},iw)':-2:flags=lanczos`,
    '-c:v', 'libx264', '-preset', 'medium', '-b:v', String(rate),
    '-pix_fmt', 'yuv420p',
    '-c:a', 'aac', '-b:a', '128k',
    // Fragmented — a pipe cannot seek back to write the moov atom.
    '-movflags', 'frag_keyframe+empty_moov+default_base_moof',
    '-f', 'mp4',
    'pipe:1',
  ];

  const [best = null] = await capabilities();
  const hardware = accelerate(software, best);
  if (hardware.changed) {
    const clip = await timed(hardware.args, bytes, hardware.note);
    if (clip) return clip;
    log('warn', 'the hardware encode failed, so the clip goes through software', { tried: hardware.note });
  }
  return timed(software, bytes, 'software libx264');
}

/** A transcode, and a line in the log saying what made the clip and how fast. */
async function timed(args: string[], bytes: ArrayBuffer, how: string): Promise<Buffer | null> {
  const started = Date.now();
  const clip = await run(args, bytes);
  if (clip) log('info', 'transcoded', { how, ms: Date.now() - started, bytes: clip.length });
  return clip;
}
