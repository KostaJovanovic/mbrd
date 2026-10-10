// Decode a TIFF to a raster via UTIF.js (vendored, 79 kB) + pako inflate.
// Carried locally (not CDN — CSP), loaded on demand, run in a worker (flatbed
// scans are hundreds of megapixels). Produces meta.preview; original file stays
// in the .mbrd untouched. Any failure degrades to a named card.

import { extOf } from '../util.ts';
import { oversize, isOversize } from '../consent.ts';

/** Worker path, resolved against index.html's <base>. */
const WORKER_URL = './assets/js/import/tiff-worker.js';

/** Generous timeout — large scans are tens of seconds of JS. Backstop against
 * a dead worker, not a limit on honest decodes. */
const DECODE_MS = 120_000;

/** Plain TIFFs only — TIFF-based RAWs have a JPEG preview that preview.ts
 *  reads far more cheaply. */
const TIFF_EXTS = new Set(['tif', 'tiff']);

/** Whether this file is one to try, by name and by its own first bytes. */
export function isTiffFile(file: File): boolean {
  const ext = extOf(file.name);
  return TIFF_EXTS.has(ext) || (file.type || '').toLowerCase() === 'image/tiff';
}

let worker: Worker | null = null;
let nextId = 1;
/** The jobs in flight, by id. One worker, many decodes, answered out of order. */
const waiting = new Map<number, (msg: WorkerReply) => void>();

type WorkerReply = {
  id: number, blob?: Blob, w?: number, h?: number, error?: string,
  /** Set instead of a blob when the page is past the decode ceiling. */
  pixels?: number,
};

/** Decode the TIFF to a WebP File, or null. Returns File (not Blob) to match
 * prepareFile()'s interface. `lift` bypasses the pixel ceiling (Oversize). */
export async function tiffRaster(file: File, lift = false): Promise<File | null> {
  try {
    const bytes = await file.arrayBuffer();
    const reply = await run(bytes, lift);
    if (reply.pixels) {
      throw oversize('pixels', `This scan is ${reply.w}x${reply.h} - `
        + `${Math.round(reply.pixels / 1e6)} megapixels, past the `
        + `${Math.round(MAX_PIXELS / 1e6)} a decode is normally given.`);
    }
    if (!reply.blob) return null;
    return new File([reply.blob], baseName(file.name) + '.webp', { type: reply.blob.type || 'image/webp' });
  } catch (err) {
    // Oversize = liftable ceiling; everything else = decode failure (named card).
    if (isOversize(err)) throw err;
    console.warn('[mbrd] tiff: could not decode', file.name, err);
    return null;
  }
}

/** The worker's ceiling, repeated here for the sentence above. Kept in step by
 *  tests/vendor.test.js, which reads the number out of both files. */
const MAX_PIXELS = 64 * 1024 * 1024;

/** The name without its extension, so a `scan.tif` becomes a `scan.webp`. */
const baseName = (name: string) => name.replace(/\.[^./\\]*$/, '') || 'page';

/** One decode on the shared worker. Worker spawned on first call and kept —
 * a folder of TIFFs is the common case. */
function run(bytes: ArrayBuffer, lift: boolean): Promise<WorkerReply> {
  const w = ensureWorker();
  const id = nextId++;
  return new Promise<WorkerReply>((resolve, reject) => {
    const timer = setTimeout(() => {
      waiting.delete(id);
      reject(new Error('the decoder did not answer'));
      // The worker is stuck, not slow, and every later job queues behind it:
      // end it, and let the next file spawn a fresh one.
      stop(w);
    }, DECODE_MS);
    waiting.set(id, msg => {
      clearTimeout(timer);
      if (msg.error) reject(new Error(msg.error));
      else resolve(msg);
    });
    // Transferred (not copied) — TIFFs can be hundreds of MB.
    w.postMessage({ id, bytes, lift }, [bytes]);
  });
}

function ensureWorker(): Worker {
  if (worker) return worker;
  // Failure to spawn = named card. Not cached — next file retries.
  const w = new Worker(WORKER_URL);
  w.onmessage = (e: MessageEvent<WorkerReply>) => {
    const done = waiting.get(e.data?.id);
    if (!done) return;               // a job that timed out and gave up
    waiting.delete(e.data.id);
    done(e.data);
  };
  // Dead worker: fail all in-flight jobs immediately, respawn on next call.
  w.onerror = () => stop(w);
  worker = w;
  return w;
}

/** End a worker that died or hung, and fail every job that was waiting on it. */
function stop(w: Worker) {
  for (const [id, done] of waiting) { waiting.delete(id); done({ id, error: 'the decoder stopped' }); }
  if (worker === w) worker = null;
  w.terminate();
}
