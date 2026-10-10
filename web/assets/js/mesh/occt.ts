// Main-thread half of the CAD kernel — posts bytes to occt-worker.js,
// returns a Mesh or null. Fallback to mesh/step.ts and mesh/iges.ts
// when the worker is unavailable. One wasm heap, so files queue.

import { oversize } from '../consent.ts';
import { MeshError, type Mesh, tooBig } from './shared.ts';

/** The vendored build, pinned. tests/vendor.test.js checks this against
 *  the directory and that the licence files are present. */
export const OCCT_VERSION = '0.0.23';

export const OCCT_DIR = '/assets/vendor/occt/';

/** Must stay a plain string literal: web/_headers and tests/csp.test.js both
 *  read it directly to check the CSP still points at this worker. A computed
 *  URL breaks that only on the deployed site, not locally. */
export const WORKER_URL = '/assets/js/mesh/occt-worker.js';

/** The kinds this reads. Everything else has triangles in it already. */
const KERNEL_KINDS = new Set(['step', 'iges']);

/** A guard rather than a predicate, so the two callers below need no assertion
 *  to pass `kind` on as the string it was just shown to be. */
export const usesKernel = (kind: string | null): kind is string =>
  !!kind && KERNEL_KINDS.has(kind);

type Reply = {
  id: number;
  error?: string;
  oversize?: number;
  triangles?: number;
  positions?: Float32Array;
  normals?: Float32Array;
  colors?: Float32Array | null;
  bounds?: { min: number[]; max: number[] };
};

let worker: Worker | null = null;
let unavailable = false;
let next = 1;
const waiting = new Map<number, (reply: Reply) => void>();
/** The tail of the queue: every request awaits the one before it. */
let queue: Promise<unknown> = Promise.resolve();

function spawn(): Worker | null {
  if (unavailable) return null;
  if (worker) return worker;
  try {
    const made = new Worker(new URL(WORKER_URL, document.baseURI));
    made.onmessage = (ev: MessageEvent<Reply>) => {
      const settle = waiting.get(ev.data?.id);
      if (!settle) return;
      waiting.delete(ev.data.id);
      settle(ev.data);
    };
    // A dead worker takes its instance with it: tell everything outstanding so
    // it falls back rather than hangs. Next request spawns fresh - usually a
    // heap exhausted by one huge file, not a kernel that's broken for good.
    made.onerror = () => stop(made);
    worker = made;
    return made;
  } catch {
    // No Worker constructor - unsupported browser - but the fallback is free
    // and this is the one place that would otherwise throw on first paint.
    unavailable = true;
    return null;
  }
}

/** Ended, not just forgotten: an error event does not stop a worker, and one
 *  left running keeps its heap. Everything outstanding falls back. */
function stop(w: Worker) {
  if (worker === w) worker = null;
  w.terminate();
  for (const [id, settle] of waiting) settle({ id, error: 'The kernel stopped' });
  waiting.clear();
}

/** How long one file may hold the kernel. A large assembly takes tens of
 *  seconds; a call that has not returned by this will not, and every CAD file
 *  after it is queued behind it with no fallback until it does. */
export const KERNEL_TIMEOUT = 120_000;

/** One file through the kernel. `null` means "read it the old way" - wrong
 *  kind, no worker, missing vendor dir, or OpenCASCADE refused it. Never
 *  throws MeshError: this module can't claim a file is unreadable. */
export function kernelMesh(
  kind: string | null,
  bytes: ArrayBuffer,
  // Passed rather than read off CAPS: a lifted ceiling is global for one
  // parse's duration (mesh/shared.ts), and this parse is awaited across a
  // message port while others may queue behind it - reading the global here
  // would let one file's yes raise everyone else's ceiling.
  maxTriangles: number,
): Promise<Mesh | null> {
  if (!usesKernel(kind)) return Promise.resolve(null);
  const run = queue.then(() => attempt(kind, bytes, maxTriangles));
  // The queue must survive a rejection, or one oversize file stops every CAD
  // card after it from ever being read.
  queue = run.catch(() => {});
  return run;
}

function attempt(kind: string, bytes: ArrayBuffer, maxTriangles: number): Promise<Mesh | null> {
  const w = spawn();
  if (!w) return Promise.resolve(null);
  const id = next++;
  return new Promise<Reply>(resolve => {
    const timer = setTimeout(() => { if (waiting.has(id)) stop(w); }, KERNEL_TIMEOUT);
    waiting.set(id, reply => { clearTimeout(timer); resolve(reply); });
    // Copied not transferred: caller still needs the bytes for the fallback
    // reader and for a lifted-ceiling retry. The mesh coming back is the
    // bigger payload, so that's the direction worth transferring.
    w.postMessage({ id, kind, bytes, maxTriangles }, []);
  }).then(reply => {
    if (reply.oversize) throw oversize('mesh-triangles', tooBig(maxTriangles));
    if (reply.error || !reply.positions || !reply.normals || !reply.bounds) return null;
    if (!reply.triangles) throw new MeshError('This file has no geometry in it');
    return {
      positions: reply.positions,
      normals: reply.normals,
      count: reply.triangles * 3,
      bounds: reply.bounds,
      colors: reply.colors || null,
    } satisfies Mesh;
  });
}
