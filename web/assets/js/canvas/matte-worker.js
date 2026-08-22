// The background remover's model, off the main thread.
//
// One job: take a 320x320x3 tensor, run u2netp over it, hand back the 320x320
// saliency map. It knows nothing about pictures, crops, cards or the board - the
// drawing either side of it is canvas/matte.ts's, which is where the reasoning
// for the whole feature lives. This file is the part that must not run on the
// main thread.
//
// **A module worker, not a classic one.** The two workers this app already has
// are classic and use importScripts, because the ffmpeg core is a UMD build and
// pdf.js spawns its own. ONNX Runtime's wasm entry is an ES module, so this is
// `new Worker(url, { type: 'module' })` - the same spelling pdf.js uses for its
// own worker, and inside the floor (Safari 16.4; module workers landed in 15).
//
// **It runs without the site's Content-Security-Policy, and that is deliberate
// and narrow.** The policy forbids `wasm-unsafe-eval`, and compiling the runtime
// is the one thing this file exists to do - so web/_headers removes the header
// for this path, exactly as it already does for optimize/media-worker.js and for
// pdf.js's worker. What runs unpoliced is this file and a wasm binary committed
// to this repository: no DOM, no board, nothing it can reach on the page, and it
// answers one message with one Float32Array. tests/csp.test.js derives the
// exempt list from the code that spawns each worker, so this rule cannot drift
// away from this file without failing the suite.
//
// **Single-threaded on purpose.** The runtime's binary is the "-threaded" build
// because that is the only plain wasm build ORT publishes, but threads need
// SharedArrayBuffer, which needs COOP/COEP, which would break the YouTube embeds
// - the same trade optimize/media.ts makes for the ffmpeg core, and the same
// answer. numThreads is pinned to 1 below rather than left to default, because
// the default probes for SharedArrayBuffer and the failure when it is absent is
// a worker that never answers.
//
// Everything here degrades to "no answer, with a reason". A runtime that will
// not import, a model that will not fetch, a session that will not build: each
// posts an `error` back and canvas/matte.ts keeps the picture it already drew.

import * as ort from '../../vendor/onnxruntime/ort.wasm.min.mjs';

// Where the runtime's own .wasm and .mjs sit. Without this ORT resolves them
// against the *document* and, failing that, against a CDN - so on the deployed
// site it would either 404 or reach a host web/_headers does not name. Resolved
// from this module's own URL, which is the one thing that is true wherever the
// app is served from.
ort.env.wasm.wasmPaths = new URL('../../vendor/onnxruntime/', import.meta.url).href;
ort.env.wasm.numThreads = 1;
// The runtime is chatty on stderr about backends it did not pick. A console the
// app promises to keep clean is not where that belongs.
ort.env.logLevel = 'error';

const MODEL = new URL('../../vendor/u2netp/u2netp.onnx', import.meta.url).href;
const SIDE = 320;

/**
 * The session, built once on the first job.
 *
 * A settled-once promise rather than a retry: building it means a 4.4 MB fetch,
 * a parse and a wasm compile, and a second job must wait for the first attempt
 * rather than start a second one. It resolves to null on failure instead of
 * rejecting, so a caller reads one shape of answer either way.
 */
let session = null;

function load() {
  if (!session) {
    session = (async () => {
      const res = await fetch(MODEL);
      if (!res.ok) throw new Error(`model ${res.status}`);
      const bytes = await res.arrayBuffer();
      // 'all' rather than the default, and it is load-bearing rather than a
      // speed knob: the graph carries 266 Constant nodes, and folding is what
      // turns them into initializers before execution. It also collapses the
      // Shape/Gather/Concat chains that compute every Resize target, which is
      // most of the graph's node count.
      return ort.InferenceSession.create(bytes, {
        executionProviders: ['wasm'],
        graphOptimizationLevel: 'all',
      });
    })();
  }
  return session;
}

self.onmessage = async (e) => {
  const { id, input } = e.data || {};
  try {
    const sess = await load();
    const feeds = {
      [sess.inputNames[0]]: new ort.Tensor('float32', input, [1, 3, SIDE, SIDE]),
    };
    const out = await sess.run(feeds);
    // The first output is d0, the fused prediction. The other six are the side
    // outputs of each decoder stage - the network is trained with deep
    // supervision, and they are coarser versions of the same thing.
    const map = out[sess.outputNames[0]];
    if (!map || !map.data) throw new Error('no output');
    // Copied out of the tensor rather than posted from it: ORT owns that buffer
    // and reuses it, and transferring it would detach something the session
    // still holds.
    const mask = Float32Array.from(map.data);
    self.postMessage({ id, mask }, [mask.buffer]);
  } catch (err) {
    // A string, not the Error: a DOMException from the wasm compile does not
    // survive structured cloning on every engine, and what the caller does with
    // this is give up.
    self.postMessage({ id, error: String((err && err.message) || err) });
  }
};

// Said once, after the imports have settled, so canvas/matte.ts can tell "the
// worker is alive" from "the worker never parsed" - which is the failure a
// module worker gives when one of its imports 404s, and which fires no error
// event anywhere the page can see.
self.postMessage({ ready: true });
