// The asking end of the CAD kernel.
//
// mesh/occt-worker.js runs Open CASCADE over a STEP or IGES file; this is the
// main-thread half, which decides whether the kernel is available and turns its
// answer into a `Mesh`. Why there is a kernel at all, and what it does not
// change, is at the top of that file.
//
// **The fallback is the point.** mesh/step.ts and mesh/iges.ts stay the readers
// of record when this cannot be used - an old cached service worker with no
// vendor directory, a browser with WebAssembly off, a build stripped of the
// 7 MB. So every failure returns `null` rather than throwing, and the caller
// reads the file the way it always did. The one failure that is *not* a null is
// a ceiling: a file the kernel could read but is larger than somebody agreed to
// look at is a question, not a fault, thrown so the retry contract in
// consent.ts can ask it.
//
// **One file at a time.** The kernel is one wasm instance with one heap and a
// STEP parse is a second or two of solid computation, so six pasted CAD files
// queue rather than starting six kernels or interleaving six parses through
// one. The queue also makes the worker's own state - a single memoised
// instantiation - safe to keep.

import { oversize } from '../consent.ts';
import { MeshError, type Mesh, tooBig } from './shared.ts';

/**
 * The vendored build, pinned.
 *
 * Read by tests/occt-vendor.test.js, which stops the directory and this number
 * drifting apart and holds the licence files to being present - see
 * web/assets/vendor/occt/LICENSE.txt for why they are not optional.
 */
export const OCCT_VERSION = '0.0.23';

export const OCCT_DIR = '/assets/vendor/occt/';

/**
 * A plain string, and it has to stay one.
 *
 * web/_headers drops the site's Content-Security-Policy on exactly this path,
 * and tests/csp.test.js reads the literal out of this file to check the rule
 * still points at a worker the app spawns. A computed URL leaves that rule
 * unanchored, which shows up as CAD files falling back to the hand-written
 * reader on the deployed site and not locally.
 */
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
    // A worker that dies takes its instance with it. Everything outstanding is
    // told so - each falls back rather than hanging - and the next request
    // spawns a fresh one: the usual cause is one enormous file exhausting the
    // wasm heap, not a kernel that will never work again.
    made.onerror = () => {
      worker = null;
      for (const [id, settle] of waiting) settle({ id, error: 'The kernel stopped' });
      waiting.clear();
    };
    worker = made;
    return made;
  } catch {
    // No Worker constructor at all - a browser this app does not otherwise
    // support - but the fallback costs nothing and this is the one place that
    // would throw at the top of a card's first paint.
    unavailable = true;
    return null;
  }
}

/**
 * One file, through the kernel.
 *
 * `null` means "read it the old way", and every reason is a null: the wrong
 * kind, no worker, a missing vendor directory, a file OpenCASCADE refused. A
 * `MeshError` here would claim the file is unreadable, which this module is in
 * no position to say.
 */
export function kernelMesh(
  kind: string | null,
  bytes: ArrayBuffer,
  // Passed rather than read off CAPS, and not a style choice. A lifted ceiling
  // is a global for the length of one parse (see mesh/shared.ts), and this
  // parse is awaited across a message port while other cards' parses may
  // start - so reading the global here would let one file's yes raise the
  // ceiling on whatever is queued behind it.
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
    waiting.set(id, resolve);
    // Copied rather than transferred: the caller still needs the bytes for the
    // fallback reader and for the second parse a lifted ceiling asks for. A
    // STEP file is a fraction of the mesh that comes back, which is the
    // direction worth transferring.
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
