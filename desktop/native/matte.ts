// u2netp background removal via native ONNX Runtime. Same model as the
// browser's wasm worker, but faster (DirectML/CoreML/CPU fallback chain).
// One session, created lazily on first use. Returns null on failure — callers
// fall back to the wasm worker.

import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { app } from 'electron';
import { log } from '../log.ts';

/** The model's fixed input square. Same constant as canvas/matte-worker.js. */
const SIDE = 320;

type Session = {
  inputNames: string[];
  outputNames: string[];
  run(feeds: Record<string, unknown>): Promise<Record<string, { data: Float32Array }>>;
};

let session: Promise<Session | null> | null = null;
let queue: Promise<unknown> = Promise.resolve();

// File path, not app:// — onnxruntime-node reads paths, not protocol URLs.
function modelPath(): string | null {
  const roots = app.isPackaged
    ? [join(process.resourcesPath, 'u2netp'), join(app.getAppPath(), 'web', 'assets', 'vendor', 'u2netp')]
    : [join(app.getAppPath(), '..', 'web', 'assets', 'vendor', 'u2netp'),
       join(app.getAppPath(), 'web', 'assets', 'vendor', 'u2netp')];
  for (const root of roots) {
    const path = join(root, 'u2netp.onnx');
    if (existsSync(path)) return path;
  }
  return null;
}

// Null is final — missing model or broken runtime does not get better on retry.
async function load(): Promise<Session | null> {
  const path = modelPath();
  if (!path) {
    log('warn', 'no u2netp model beside the app - the wasm worker stays');
    return null;
  }
  // Lazy — onnxruntime-node is tens of MB of native binary.
  const ort = await import('onnxruntime-node');
  const providers = process.platform === 'win32' ? ['dml', 'cpu']
    : process.platform === 'darwin' ? ['coreml', 'cpu']
      : ['cpu'];

  for (const provider of providers) {
    try {
      const made = await ort.InferenceSession.create(path, {
        executionProviders: [provider],
        graphOptimizationLevel: 'all',
        logSeverityLevel: 3,
      });
      log('info', 'matte session ready', { provider });
      const { inputNames, outputNames } = made;
      // SAFETY: runOne() feeds only float32 ort.Tensors keyed by inputNames. u2netp's outputs
      // are float32, and runOne() null-checks `data` and copies it inside its try/catch.
      const run = (feeds: Record<string, unknown>) =>
        made.run(feeds as Parameters<typeof made.run>[0]) as
          Promise<Record<string, { data: Float32Array }>>;
      return { inputNames: [...inputNames], outputNames: [...outputNames], run };
    } catch (err) {
      // Expected — no GPU, wrong driver, missing provider. cpu is the fallback.
      log('info', 'matte provider declined', { provider, err: String(err) });
    }
  }
  return null;
}

/** Whether a cut-out will be native. Answered without loading anything. */
export function available(): boolean {
  return modelPath() !== null;
}

/** One mask from one tensor. Null means "use the wasm worker". Serialised. */
export async function matte(input: Float32Array): Promise<Float32Array | null> {
  if (input.length !== 3 * SIDE * SIDE) {
    log('warn', 'a matte input was not 1x3x320x320', { length: input.length });
    return null;
  }
  const job = queue.then(() => runOne(input), () => runOne(input));
  queue = job.catch(() => {});
  return job.catch(() => null);
}

async function runOne(input: Float32Array): Promise<Float32Array | null> {
  session ??= load();
  const sess = await session;
  if (!sess) return null;
  try {
    const ort = await import('onnxruntime-node');
    const feeds = { [sess.inputNames[0]]: new ort.Tensor('float32', input, [1, 3, SIDE, SIDE]) };
    const out = await sess.run(feeds);
    // First output (d0) is the fused prediction; others are coarser side outputs.
    const map = out[sess.outputNames[0]];
    if (!map?.data) return null;
    // Copied — ORT owns and reuses the tensor buffer.
    return Float32Array.from(map.data);
  } catch (err) {
    log('warn', 'a native cut-out failed; the worker will be asked instead', err);
    return null;
  }
}
