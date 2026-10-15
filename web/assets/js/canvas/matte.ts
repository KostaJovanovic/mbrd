// Background removal via U^2-Netp salient-object model (4.4 MB, wasm backend,
// runs in matte-worker.js). cutout() makes the non-subject pixels transparent.
// Used by display.ts (baked into display copy) and snapshot.ts (export).
// Every failure degrades to "the picture, uncut" — nothing here throws.
// Model is vendored (web/assets/vendor/u2netp) so the feature works offline.

import { canvasReads, surface, type Surface } from './surface.ts';
import { platform, isDesktop } from '../platform/platform.ts';
import { serial } from '../util.ts';

/** Pinned versions — tests/vendor.test.js checks these against the vendored files. */
export const ORT_VERSION = '1.23.0';
export const MODEL_NAME = 'u2netp';

/** Document-relative worker path. Must stay a literal — tests/csp.test.js reads it. */
const WORKER_URL = './assets/js/canvas/matte-worker.js';

/** The side of the square the model reads. Fixed in the graph, not a choice. */
const SIDE = 320;

/** ImageNet normalisation stats — must match training or the mask is subtly wrong everywhere. */
const MEAN = [0.485, 0.456, 0.406];
const STD = [0.229, 0.224, 0.225];

/** Generous timeout — first job pays for fetch + parse + wasm compile on a slow phone. */
const JOB_TIMEOUT_MS = 90_000;

type Pending = {
  resolve: (mask: Float32Array | null) => void,
  timer: ReturnType<typeof setTimeout>,
};

let worker: Worker | null = null;
let spawnFailed = false;
let nextId = 1;
const pending = new Map<number, Pending>();

/** Serial queue — wasm inference is single-threaded and each job holds a tensor.
 *  It outlives a failure, so one bad picture does not stall the rest. */
const inTurn = serial();

/** Cheap sync check: can we offer the button? Worker + canvas reads + no prior spawn failure. */
export function matteAvailable(): boolean {
  // Shell uses native matte — no worker needed, but still needs canvas reads.
  if (isDesktop()) return canvasReads();
  if (typeof Worker !== 'function' || spawnFailed) return false;
  return canvasReads();
}

/** Make non-subject pixels transparent, in place. Returns false if nothing was done. */
export function cutout(face: Surface, w: number, h: number): Promise<boolean> {
  if (w < 1 || h < 1 || !matteAvailable()) return Promise.resolve(false);
  return inTurn(() => run(face, w, h)).catch(() => false);
}

async function run(face: Surface, w: number, h: number): Promise<boolean> {
  const input = preprocess(face, w, h);
  if (!input) return false;
  // Shell's native matte first (faster); falls back to the web worker.
  const mask = (await platform.native.matte(input)) ?? await ask(input);
  if (!mask) return false;
  return applyMask(face, w, h, mask);
}

/** Spawn the worker on first use. Not retried after failure. */
function ensureWorker(): Worker | null {
  if (worker || spawnFailed) return worker;
  try {
    const w = new Worker(new URL(WORKER_URL, document.baseURI).href, { type: 'module' });
    w.onmessage = (e: MessageEvent) => {
      const { id, mask, error } = e.data || {};
      // Boot message has no id — ignored; first real job proves the worker works.
      if (typeof id !== 'number') return;
      const job = pending.get(id);
      if (!job) return;
      pending.delete(id);
      clearTimeout(job.timer);
      // SAFETY: message comes only from our worker; it posts either `error` or `mask`.
      job.resolve(error ? null : (mask as Float32Array));
    };
    // A 404'd import fires this — settle all pending jobs and drop the worker.
    w.onerror = () => killWorker();
    w.onmessageerror = () => killWorker();
    worker = w;
  } catch {
    spawnFailed = true;
    worker = null;
  }
  return worker;
}

/** Settle everything in flight, drop the worker, and stop offering the feature. */
function killWorker() {
  spawnFailed = true;
  for (const [, job] of pending) { clearTimeout(job.timer); job.resolve(null); }
  pending.clear();
  worker?.terminate();
  worker = null;
}

/** One tensor in, one saliency map out, or null for any way of not answering. */
function ask(input: Float32Array): Promise<Float32Array | null> {
  const w = ensureWorker();
  if (!w) return Promise.resolve(null);
  const id = nextId++;
  return new Promise<Float32Array | null>(resolve => {
    const timer = setTimeout(() => {
      pending.delete(id);
      resolve(null);
    }, JOB_TIMEOUT_MS);
    pending.set(id, { resolve, timer });
    // Transferred — 1.2 MB of floats, no further use on this side.
    w.postMessage({ id, input }, [input.buffer]);
  });
}

/** Resize to 320x320 planar NCHW tensor with ImageNet normalisation. Squashed, not letterboxed — distortion cancels on the way back. */
function preprocess(face: Surface, w: number, h: number): Float32Array | null {
  const small = surface(SIDE, SIDE);
  if (!small) return null;
  let px;
  try {
    small.ctx.drawImage(face.canvas, 0, 0, w, h, 0, 0, SIDE, SIDE);
    px = small.ctx.getImageData(0, 0, SIDE, SIDE);
  } catch {
    return null;
  }
  const d = px.data;
  const n = SIDE * SIDE;
  // Divide by max channel value (official loader). Falls back to 255 for all-black.
  let max = 0;
  for (let i = 0; i < d.length; i += 4) {
    if (d[i] > max) max = d[i];
    if (d[i + 1] > max) max = d[i + 1];
    if (d[i + 2] > max) max = d[i + 2];
  }
  if (!max) max = 255;
  // NCHW planar layout (not the interleaved RGBA from getImageData).
  const out = new Float32Array(3 * n);
  for (let p = 0; p < n; p++) {
    const i = p * 4;
    out[p] = (d[i] / max - MEAN[0]) / STD[0];
    out[n + p] = (d[i + 1] / max - MEAN[1]) / STD[1];
    out[2 * n + p] = (d[i + 2] / max - MEAN[2]) / STD[2];
  }
  return out;
}

/**
 * Stretch mask back to picture size and multiply into alpha. Min-max normalised
 * first (output is confidence, not probability). drawImage provides bilinear
 * interpolation. Existing alpha is preserved (multiplied, not replaced).
 */
function applyMask(face: Surface, w: number, h: number, map: Float32Array): boolean {
  let lo = Infinity, hi = -Infinity;
  for (const v of map) { if (v < lo) lo = v; if (v > hi) hi = v; }
  const span = hi - lo;
  const mask = surface(SIDE, SIDE);
  if (!mask) return false;
  let out;
  try {
    out = mask.ctx.createImageData(SIDE, SIDE);
  } catch {
    return false;
  }
  for (let p = 0; p < SIDE * SIDE; p++) {
    const v = span > 0 ? (map[p] - lo) / span : 1;
    const a = Math.round(Math.min(1, Math.max(0, v)) * 255);
    const i = p * 4;
    // White with confidence in alpha. Must not be black — premultiply would bleed dark edges.
    out.data[i] = 255; out.data[i + 1] = 255; out.data[i + 2] = 255; out.data[i + 3] = a;
  }
  mask.ctx.putImageData(out, 0, 0);
  try {
    // destination-in: keep picture colour, take alpha from mask. One draw call with bilinear stretch.
    face.ctx.save();
    face.ctx.globalCompositeOperation = 'destination-in';
    face.ctx.drawImage(mask.canvas, 0, 0, SIDE, SIDE, 0, 0, w, h);
    face.ctx.restore();
  } catch {
    return false;
  }
  return true;
}
