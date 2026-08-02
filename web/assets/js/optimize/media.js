// A still poster for a clip the browser cannot open, through ffmpeg.
//
// This module used to encode sound and video too. It no longer does: the browser
// makes Opus by itself (opus.js), and video is now deliberately left alone -
// shrinking a clip needs a single-threaded wasm encoder that pins a core for the
// length of the clip, hard enough on the machine that it is not a trade worth
// making for a board you look at (see optimize.js). What remains is the one job
// worth ffmpeg's weight: pulling the first frame out of a video no browser here
// can decode, so its card is a picture of itself instead of a black rectangle.
//
// The case is H.265. A phone shoots HEVC by default and every desktop browser
// except Safari refuses it, so the clip saves fine and shows as a black
// rectangle with a dead play button. firstFrame() extracts one frame as a
// poster; the clip itself is never touched, so it still plays the day the
// browser learns to.
//
// This is the one place in the whole app that depends on somebody else's code,
// and it is written to keep that fact contained:
//
//   - it is **fetched from a CDN**, not vendored. The single-threaded ffmpeg
//     core lives at jsdelivr and is pulled on first use. Nothing about a *board*
//     is sent - only the request for the core itself - and the browser caches it
//     (immutable, a year) so it is asked for once. Offline or CDN down, the
//     poster is simply not made.
//   - it is **loaded on demand**. Nothing here is touched until a clip the
//     browser cannot open is imported, and it is deliberately *not* in sw.js's
//     SHELL: thirty megabytes has no business in the cache of an app that is
//     otherwise under two, and being cross-origin the service worker steps aside
//     for it anyway.
//   - it is **single-threaded**. The threaded core needs SharedArrayBuffer,
//     which needs COOP/COEP, which would break the YouTube embeds - the one
//     third-party thing the app does offer, and only on request. Slower and
//     entirely worth it.
//   - it runs in a **worker**. Even one frame is wasm, and wasm on the main
//     thread is a frozen board.
//
// Everything degrades to "no poster": if the core cannot be reached or the frame
// cannot be pulled, firstFrame() returns null and the card stays the rectangle
// it already was.

import { extOf } from '../util.js';

// Where the core lives. The single-threaded UMD build - the one that exposes a
// `createFFmpegCore` factory and loads through importScripts, which is what
// media-worker.js drives. (The ESM build would need a module worker; the
// threaded build would need SharedArrayBuffer, hence COOP/COEP, which would
// break the YouTube embeds - see the note above.) `locateFile` in the worker
// resolves ffmpeg-core.wasm against this same URL, so both come from here.
const CORE_DIR = 'https://cdn.jsdelivr.net/npm/@ffmpeg/core@0.12.6/dist/umd/';
const CORE_JS = CORE_DIR + 'ffmpeg-core.js';

/** Roughly what it weighs, for the sentence in the dialog. */
export const MEDIA_MB = 32;

let worker = null;
let ready = null;
let present = null;

// Every in-flight job, id -> { resolve, reject, timer }. A worker that crashes
// mid-encode used to leave its ask() promise pending forever, and a rejected
// boot promise was retained so no later attempt could respawn. Both are settled
// through this map and killWorker(). See AUD-10.
const pending = new Map();

/**
 * A single job's ceiling. Generous on purpose: a real settlement is the worker's
 * reply or an error event, not the clock. This only catches a worker that has
 * gone silent without either - a genuine wedge - so it must not fire on a long
 * but healthy single-threaded wasm encode.
 */
const JOB_TIMEOUT_MS = 15 * 60_000;

/**
 * Reject every pending job, drop the worker, and reset `ready` so the next call
 * spawns a fresh one. The one place a dead worker is cleaned up, whether the
 * death was a crash, a decode error, or a timeout.
 */
function killWorker(err) {
  for (const job of pending.values()) { clearTimeout(job.timer); job.reject(err); }
  pending.clear();
  if (worker) { try { worker.terminate(); } catch { /* already gone */ } }
  worker = null;
  ready = null;
}

/**
 * Whether the encoder can be reached, without downloading its 30 MB.
 *
 * A one-byte ranged GET rather than a HEAD: the CDN and the proxies in front of
 * it answer `Range: bytes=0-0` with a 206 and a single byte, which costs a round
 * trip and nothing else - where HEAD is routinely met with a 405, a redirect, or
 * a response stripped of CORS, every one of which reads as "unreachable" for a
 * file that is sitting right there. `no-store` keeps that one byte from being
 * mistaken for the whole core in the HTTP cache. Offline or CDN down, it throws,
 * we answer false, and video is left alone - the same graceful skip we gave when
 * the core was expected locally and was not there.
 *
 * Only a *true* is cached. A false is the answer to "right now", not "ever": the
 * commonest false is a transient one - the poster probe firing during a blip of
 * no network at import - and caching it would leave Optimize insisting the
 * encoder cannot be loaded for the rest of the session with the network long
 * back. So every negative is retried, and only success sticks.
 */
export async function mediaAvailable() {
  if (present === true) return true;
  try {
    const res = await fetch(CORE_JS, { headers: { Range: 'bytes=0-0' }, cache: 'no-store' });
    present = res.ok || res.status === 206;
  } catch {
    present = false;
  }
  return present;
}

/** The long edge of an extracted poster frame. A card, not a screening. */
const FRAME_MAX_SIDE = 1280;

/**
 * The first frame of a clip this browser cannot open, as a picture it can.
 *
 * The case is H.265. A phone shoots HEVC by default and every desktop browser
 * except Safari refuses to decode it, so the file arrives, is registered, is
 * saved into the .mbrd - and shows on the board as a black rectangle with a
 * play button that does nothing. The bytes are all there and none of them can
 * be seen. Anything else the browser will not open lands here too - AV1 on an
 * older build, ProRes, a raw stream - because the test that sends work this way
 * is "did the browser manage to read it", not "which codec is this". That is
 * both easier to be right about and the question that actually matters.
 *
 * A poster rather than a conversion, and that is the whole restraint of it. The
 * clip is untouched: it stays exactly the file that was dropped, so it plays the
 * day the browser learns to, it exports as itself, and Optimize can still turn
 * it into something this machine can play if that is what somebody wants. What
 * this buys is that the card looks like the thing it is in the meantime.
 *
 * Null whenever anything is not right - the core is not vendored, the file is
 * not readable, the encoder is missing a format. The caller treats that as "no
 * poster", which is the black rectangle it was already going to be.
 */
export async function firstFrame(file, say = () => {}) {
  if (!(await mediaAvailable())) return null;
  if (!ready) {
    say(`Loading the media decoder (${MEDIA_MB} MB, once)…`);
    // A boot that fails must not be remembered as a permanently rejected
    // promise: `if (!ready)` would be false forever and every later call would
    // reject without ever attempting a respawn. Cleared here rather than inside
    // spawn(), because a promise executor runs *before* the assignment it is
    // being assigned by - anything it writes to `ready` is overwritten by the
    // next line, which is exactly how the constructor-throw branch came to wedge
    // the module for the session. Guarded on identity so a stale failure cannot
    // clear a worker that has booted since.
    // The handler names `boot` before it is initialised, which is fine because
    // it can only run a tick later, by which time it is the promise below.
    const boot = spawn().catch(err => { if (ready === boot) ready = null; throw err; });
    ready = boot;
  }
  await ready;

  const ext = extOf(file.name);
  const inName = 'in' + (ext ? '.' + ext : '');
  // Two ways of writing a still, tried in order. mjpeg is the one worth having -
  // a poster is a photograph and JPEG is a tenth the size - but a core can be
  // built without that encoder, and png is in every one of them.
  const attempts = [
    { out: 'frame.jpg', type: 'image/jpeg', codec: 'mjpeg', extra: ['-q:v', '3'] },
    { out: 'frame.png', type: 'image/png', codec: 'png', extra: [] },
  ];

  for (const attempt of attempts) {
    // Read again per attempt rather than holding one copy: the bytes are
    // *transferred* into the worker, not copied, so the buffer from the first
    // attempt is detached by the time a second one would want it. Reading a file
    // twice is cheaper than keeping forty megabytes alive to avoid it.
    let bytes;
    try {
      bytes = new Uint8Array(await file.arrayBuffer());
    } catch {
      return null;
    }
    let res = null;
    try {
      res = await ask({
        type: 'run',
        inName,
        out: attempt.out,
        bytes,
        argv: [
          '-i', inName,
          // One frame, no sound, no attached pictures - just the picture stream.
          '-frames:v', '1', '-an', '-map', '0:v:0',
          '-vf', `scale='min(${FRAME_MAX_SIDE},iw)':-2:flags=lanczos`,
          '-c:v', attempt.codec, ...attempt.extra,
          '-f', 'image2', attempt.out,
        ],
      });
    } catch {
      // A refused format is not a failure of the feature; try the next writer.
    }
    if (res?.bytes?.byteLength) return new Blob([res.bytes], { type: attempt.type });
  }
  return null;
}

function spawn() {
  return new Promise((resolve, reject) => {
    let w;
    // A CSP that forbids workers, or a blocked script URL. Rejecting is the
    // whole of what this can do: clearing `ready` is the caller's, for the
    // reason given at firstFrame()'s spawn site.
    try { w = new Worker('./assets/js/optimize/media-worker.js'); }
    catch (err) { reject(err); return; }
    worker = w;

    // The boot handshake. Removed once, because everything after it is a job.
    const onBoot = e => {
      if (e.data?.type !== 'ready') return;
      w.removeEventListener('message', onBoot);
      if (e.data.ok) { resolve(); return; }
      const err = new Error(e.data.error || 'core failed to start');
      reject(err);
      killWorker(err);
    };
    w.addEventListener('message', onBoot);

    // Job replies, for the life of the worker. ask() parks each job in `pending`
    // keyed by id; this is where it is resolved and its timeout cleared.
    w.addEventListener('message', e => {
      const id = e.data?.id;
      if (id == null) return;
      const job = pending.get(id);
      if (!job) return;
      pending.delete(id);
      clearTimeout(job.timer);
      e.data.error ? job.reject(new Error(e.data.error)) : job.resolve(e.data);
    });

    // A crash or an undeliverable message settles the boot promise and every job
    // at once, then tears the worker down so a later call respawns. Without this
    // a crash mid-encode left the optimize UI busy forever.
    const onDead = () => {
      const err = new Error('the media worker stopped unexpectedly');
      reject(err);            // no-op if boot already resolved
      killWorker(err);
    };
    w.addEventListener('error', onDead);
    w.addEventListener('messageerror', onDead);

    w.postMessage({ type: 'boot', core: new URL(CORE_JS, location.href).href });
  });
}

let seq = 0;
function ask(msg) {
  return new Promise((resolve, reject) => {
    if (!worker) { reject(new Error('the media worker is not running')); return; }
    const id = ++seq;
    // A wedge backstop: a worker that never replies and never errors would
    // otherwise hold this promise forever. Firing it tears the worker down so
    // the next attempt respawns.
    const timer = setTimeout(() => {
      if (!pending.has(id)) return;
      pending.delete(id);
      const err = new Error('the media worker timed out');
      reject(err);
      killWorker(err);
    }, JOB_TIMEOUT_MS);
    pending.set(id, { resolve, reject, timer });
    try {
      // The bytes are transferred rather than copied: a 40MB file has no business
      // existing twice while it is being handed over.
      worker.postMessage({ ...msg, id }, [msg.bytes.buffer]);
    } catch (err) {
      pending.delete(id);
      clearTimeout(timer);
      reject(err);
    }
  });
}
