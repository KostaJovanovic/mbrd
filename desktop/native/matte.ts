// u2netp on a native runtime, which is the same model the browser runs.
//
// canvas/matte.ts runs this on ONNX Runtime's *wasm* backend in a worker, and
// its whole protocol is one Float32Array in and one out - a 1x3x320x320 tensor
// the caller has already built, and a mask of the same square. That is the
// entire interface, on both shells, which is why this file is short: it is the
// same model file and the same numbers, on a runtime that can use the machine.
//
// The difference is a two-second stall becoming a two-hundred-millisecond one
// per cut-out, and on Windows and macOS it is more than that, because the
// native build can reach hardware the wasm one cannot see at all.
//
// ── The execution providers, in order ──
//
// DirectML on Windows, CoreML on macOS, CPU everywhere. Each is *tried* and
// falls through: a machine with no compatible GPU, a driver that refuses, an
// ONNX Runtime build without the provider compiled in - all of them are
// ordinary, and none of them should mean no cut-out. The last entry is always
// CPU, which always works.
//
// ── One session, made once ──
//
// Creating a session loads and optimises the graph, which is most of a second.
// The renderer's worker keeps one for the life of the page for exactly this
// reason and so does this. It is created on the first ask rather than at boot,
// because most sessions of this app never cut anything out and a model nobody
// asked for is a second of startup nobody wanted.

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

/**
 * Where the model is.
 *
 * The same bytes web/ serves - `web/assets/vendor/u2netp/u2netp.onnx`, pinned
 * by tests/matte-vendor.test.js - reached as a file rather than over `app://`,
 * because onnxruntime-node reads a path and knows nothing about this app's
 * protocol handler. One model in the repository, two readers.
 */
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

/**
 * The session, or null if there will not be one.
 *
 * Null is not an error state and is not retried. The two ways this fails are a
 * model file that is not there and a runtime that will not load, and neither
 * gets better by asking twice - the same reasoning canvas/matte.ts gives for
 * not respawning its worker. Every caller falls through to the wasm path.
 */
async function load(): Promise<Session | null> {
  const path = modelPath();
  if (!path) {
    log('warn', 'no u2netp model beside the app - the wasm worker stays');
    return null;
  }
  // Imported here rather than at the top of the file, and it is worth saying
  // why: onnxruntime-node is tens of megabytes of native binary, and loading it
  // at startup would cost every launch of the app for a feature most sessions
  // never touch.
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
      // `made` is the object create() just returned; the three fields below are
      // the whole of what this file uses, each declared on onnxruntime's own
      // type. Named rather than asserted through, so what is being kept is
      // written down instead of being whatever survives a cast.
      const { inputNames, outputNames } = made;
      // SAFETY: both assertions are about the *feeds* record, not about a value
      // read out of one. Going in, the object is the one runOne() just built
      // with a Tensor onnxruntime itself constructed; coming out, `.data` on a
      // float32 output is a Float32Array by that tensor's own declaration, and
      // runOne() checks the field is there before reading it.
      const run = (feeds: Record<string, unknown>) =>
        made.run(feeds as Parameters<typeof made.run>[0]) as
          Promise<Record<string, { data: Float32Array }>>;
      return { inputNames: [...inputNames], outputNames: [...outputNames], run };
    } catch (err) {
      // Expected, not exceptional: a machine with no compatible GPU, a driver
      // that refuses, a build without the provider compiled in. The list ends
      // at cpu, which does not fail.
      log('info', 'matte provider declined', { provider, err: String(err) });
    }
  }
  return null;
}

/** Whether a cut-out will be native. Answered without loading anything. */
export function available(): boolean {
  return modelPath() !== null;
}

/**
 * One mask, from one tensor. Null means "use the worker".
 *
 * Serialised, like the browser's queue and for the same reason: the sessions
 * are already multi-threaded, and two at once is two lots of memory racing for
 * the same cores while one person waits for one picture.
 */
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
    // The first output is d0, the fused prediction. The other six are the side
    // outputs of each decoder stage - the network is trained with deep
    // supervision, and they are coarser versions of the same thing. Same
    // sentence as canvas/matte-worker.js, because it is the same model.
    const map = out[sess.outputNames[0]];
    if (!map?.data) return null;
    // Copied out of the tensor rather than handed over: ORT owns that buffer
    // and reuses it, so what crosses the bridge has to be ours.
    return Float32Array.from(map.data);
  } catch (err) {
    log('warn', 'a native cut-out failed; the worker will be asked instead', err);
    return null;
  }
}
