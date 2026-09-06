// Knocking the background out of a picture, with a salient-object model.
//
// One function, `cutout()`, which takes a drawn surface and makes everything
// that is not the subject transparent. It is used twice - canvas/display.ts
// bakes it into the display copy the way it bakes the crop, and ui/snapshot.ts
// runs it again at export resolution so a cut-out card is cut out in the
// exported picture. Both call the same code for the reason adjustFilter() has
// one builder: two of these would drift, and the drift would be a card that does
// not match its own export.
//
// This file is the drawing either side of the model. The model itself runs in
// canvas/matte-worker.js, whose header covers the worker, the policy exemption
// and why it is single-threaded.
//
// ── What replaced what, twice, and what each attempt taught ──
//
// **First it was a flood fill** from the picture's edges against its mean edge
// colour, with a tolerance dial. That is a real technique, genuinely good on a
// product shot on white and useless on everything else, because it has no idea
// what a subject is. The dial did not fix that; it only chose which of the two
// failures you got. It is gone, and so is the dial - see itemMatte() in
// board-model.ts, which is a flag rather than a number.
//
// **Then it was the same model on ONNX Runtime's WebGL backend**, which is 454
// KB of plain JavaScript against the wasm build's 11.8 MB and needed no policy
// exemption at all. It does not work, and the reason is worth keeping because
// the check that would have caught it is not the obvious one: every *operator*
// this graph uses is supported by the WebGL backend at opset 11 - that table was
// read and it was right - but the backend has no int64, and u2netp computes the
// target size of all 38 of its Resize nodes as int64 at run time. An operator
// table does not express a dtype constraint. **Read both before believing a
// backend can run a graph.**
//
// So it is the wasm backend, which is the maintained one, runs everything, and
// buys back the other thing WebGL had cost: WebGL cannot run in a worker
// (`[webgl] backend not found`, open upstream), so that version put a
// several-hundred-millisecond stall on the main thread every time a cut-out card
// mounted. This one does not.
//
// ── U^2-Netp, carried rather than fetched ──
//
// The model is u2netp: the small variant of U^2-Net, a nested U-structure
// trained for salient-object detection - "which pixels are the thing this
// photograph is of". 4.4 MB, opset 11, one 320x320 input and seven outputs of
// which the first is the one anybody uses.
//
// It sits in web/assets/vendor/u2netp and is served from this origin, which is
// the same decision import/pdf.ts made for pdf.js and for the same three
// reasons: nothing about a board is sent anywhere, the model cannot change under
// the app, and it needs no host in web/_headers. It also means the feature works
// with the network off, which a download on first use would not.
//
// **Why this model and not a better one.** The honest ranking among models whose
// licence permits redistribution here at all is BEN2 (MIT, 219 MB) then
// BiRefNet_lite (MIT, 115 MB) then this (Apache-2.0, 4.4 MB). The three that
// would have been the obvious picks are all barred: RMBG-1.4 and RMBG-2.0 are
// CC BY-NC, and both ISNet-ONNX and @imgly/background-removal are AGPL, which
// this project is not. So the trade was quality against a hundred-plus megabytes
// on top of the runtime's own, and 4.4 MB won. u2netp is soft on hair, fur and
// glass and is otherwise close; the ceiling is the model, not this file, and
// swapping in a bigger one is a new file and a new constant, nothing else.
//
// ── Everything degrades to "the picture, uncut" ──
//
// No worker, a runtime that will not import, a model that will not fetch, a
// session that will not build, a canvas that will not hand its pixels back: each
// answers false and the caller keeps the picture it already drew. That is the
// same answer every derived image in this app gives, and it is why nothing here
// throws.

import { canvasReads, surface, type Surface } from './surface.ts';
import { platform, isDesktop } from '../platform/platform.ts';

/**
 * The two vendored things, pinned.
 *
 * Exported so tests/matte-vendor.test.js can hold these to the bytes actually
 * sitting in web/assets/vendor - the job tests/pdf-vendor.test.js does for
 * pdf.js, and for the reason given there: a version recorded only in a comment
 * beside a file nobody re-reads is a version that stops being true the first
 * time somebody drops a newer build in.
 */
export const ORT_VERSION = '1.23.0';
export const MODEL_NAME = 'u2netp';

/**
 * The worker, as the document sees it.
 *
 * A path relative to the document rather than to this module, because that is
 * what `new Worker()` resolves against - the same spelling optimize/media.ts
 * uses, and the reason index.html carries `<base href="/">`. It is also the
 * string tests/csp.test.js reads to check the exemption in web/_headers still
 * points at a worker this app actually spawns, so it must stay a plain literal.
 */
const WORKER_URL = './assets/js/canvas/matte-worker.js';

/** The side of the square the model reads. Fixed in the graph, not a choice. */
const SIDE = 320;

/**
 * ImageNet's channel statistics, which is what U^2-Net was trained against.
 *
 * Not decoration and not swappable: the network learned its features on inputs
 * normalised this way, and feeding it raw 0..1 pixels gives a mask that looks
 * plausible and is subtly wrong everywhere. The scaling before it is the
 * official loader's too - divide by the *maximum* channel value rather than by
 * 255, which is what makes a dark photograph read the same as a bright one.
 */
const MEAN = [0.485, 0.456, 0.406];
const STD = [0.229, 0.224, 0.225];

/**
 * How long one picture gets before it is given up on.
 *
 * The first job pays for a 4.4 MB fetch, a graph parse and a wasm compile, so
 * this has to be generous enough not to fire on a slow phone doing all three.
 * It is not the normal way a job ends - that is a reply or an error - it only
 * catches a worker that has gone silent without either, which would otherwise
 * leave a promise pending forever and the darkroom's spinner turning. The same
 * shape optimize/media.ts gives its own jobs, at a tenth of the time, because
 * one inference is not one video encode.
 */
const JOB_TIMEOUT_MS = 90_000;

type Pending = {
  resolve: (mask: Float32Array | null) => void,
  timer: ReturnType<typeof setTimeout>,
};

let worker: Worker | null = null;
let spawnFailed = false;
let nextId = 1;
const pending = new Map<number, Pending>();

/**
 * Runs, one at a time.
 *
 * One session lives in the worker and wasm inference is single-threaded, so two
 * overlapping jobs would queue inside the runtime anyway - but they would each
 * be holding an input tensor while they waited. canvas/display.ts already
 * serializes its own generation, and ui/snapshot.ts does not know about that
 * queue and the darkroom does not either, so the ordering lives here where the
 * worker does rather than in three callers that would each have to remember.
 */
let queue: Promise<unknown> = Promise.resolve();

/**
 * Whether a cut-out could work at all on this browser.
 *
 * Cheap and synchronous, for the one caller that needs to decide whether to
 * *offer* the button rather than whether to run it - see initDarkroom() in
 * ui/darkroom.ts. It asks the two questions that can be answered without loading
 * anything: is there a Worker constructor, and will this engine hand back pixels
 * that were drawn into a canvas (canvasReads(), which a fingerprinting defence
 * can refuse silently).
 *
 * It deliberately does not promise success. The runtime may still fail to
 * import and the model may still fail to fetch, and both of those answer false
 * from cutout() at the point of use. This is the difference between "not
 * offered" and "offered and then quietly did nothing", and only the first is
 * worth a synchronous check.
 *
 * `spawnFailed` is in it so that the button stops being offered after the worker
 * has actually failed to start, rather than staying on screen doing nothing for
 * the rest of the session.
 */
export function matteAvailable(): boolean {
  // The shell can do this without a worker at all, so a browser test for one is
  // the wrong question there. It still has to be able to *read* a canvas, since
  // that is where the pixels come from and where they go back.
  if (isDesktop()) return canvasReads();
  if (typeof Worker !== 'function' || spawnFailed) return false;
  return canvasReads();
}

/**
 * Make the background of a drawn surface transparent, in place.
 *
 * True when the pixels were rewritten, false when nothing was done. Every caller
 * reads false as "keep what you drew", which is already what they do for every
 * other step that can decline.
 *
 * `w` and `h` are passed rather than read off the canvas because the caller
 * always knows them already, and a surface whose backing store disagrees with
 * the drawing that went into it is a bug this function should not be quietly
 * absorbing.
 */
export function cutout(face: Surface, w: number, h: number): Promise<boolean> {
  if (w < 1 || h < 1 || !matteAvailable()) return Promise.resolve(false);
  // Chained rather than awaited, and the chain is kept alive past a failure so
  // one picture that will not run does not stall every picture behind it.
  const job = queue.then(() => run(face, w, h));
  queue = job.catch(() => {});
  return job.catch(() => false);
}

async function run(face: Surface, w: number, h: number): Promise<boolean> {
  const input = preprocess(face, w, h);
  if (!input) return false;
  // The shell first, and the worker behind it. Same model, same numbers, same
  // 1x3x320x320 tensor in and mask out - the only difference is a runtime that
  // can reach the machine, which is a two-second stall becoming a fifth of one.
  // Unwired, and on a desktop whose provider declined, this resolves null and
  // the worker below answers exactly as it always did.
  const mask = (await platform.native.matte(input)) ?? await ask(input);
  if (!mask) return false;
  return applyMask(face, w, h, mask);
}

/**
 * The worker, spawned on first use.
 *
 * Null once spawning has failed, and it is not retried: the two ways this throws
 * are a browser with no module workers and a file that is not there, and neither
 * gets better by asking twice. `type: 'module'` because the runtime's entry is
 * an ES module - the same spelling pdf.js uses for its own worker.
 */
function ensureWorker(): Worker | null {
  if (worker || spawnFailed) return worker;
  try {
    const w = new Worker(new URL(WORKER_URL, document.baseURI).href, { type: 'module' });
    w.onmessage = (e: MessageEvent) => {
      const { id, mask, error } = e.data || {};
      // The boot message carries no id. It is not waited on - the first job is
      // what proves the worker works - but a worker that says nothing at all is
      // still caught, by that job's timeout.
      if (typeof id !== 'number') return;
      const job = pending.get(id);
      if (!job) return;
      pending.delete(id);
      clearTimeout(job.timer);
      // SAFETY: the message comes from canvas/matte-worker.js and nowhere else -
      // a worker's port carries only what that file posts, and it posts exactly
      // one shape with an id: either an `error` string or a `mask` built by
      // `Float32Array.from(...)`. The `error ?` in front of this is the check,
      // and it is the branch every failure in that file takes. Nothing outside
      // this repository can reach this port.
      job.resolve(error ? null : (mask as Float32Array));
    };
    // A module worker whose import 404s fires this and never runs a line. Every
    // job in flight is settled rather than left pending, and the worker is
    // dropped so nothing waits on it again.
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
    // Transferred rather than copied: it is 1.2 MB of floats and this side has
    // no further use for it.
    w.postMessage({ id, input }, [input.buffer]);
  });
}

/**
 * The surface as the tensor the model wants: 320x320, planar, normalised.
 *
 * Squashed rather than letterboxed, and deliberately. The alternative is to fit
 * the picture inside a 320 square and pad the rest, which keeps the aspect ratio
 * and throws away resolution on the long edge - and the model is a saliency
 * detector rather than a classifier, so it cares much more about having pixels
 * to look at than about their proportions. The mask comes back at 320x320 and is
 * stretched back the same way, so the distortion cancels exactly.
 */
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
  // The largest channel value anywhere, which is what the official loader
  // divides by. Zero for an entirely black square, and dividing by it would fill
  // the tensor with NaN and the mask with nothing - so it falls back to 255 and
  // the picture is read as the black rectangle it is.
  let max = 0;
  for (let i = 0; i < d.length; i += 4) {
    if (d[i] > max) max = d[i];
    if (d[i + 1] > max) max = d[i + 1];
    if (d[i + 2] > max) max = d[i + 2];
  }
  if (!max) max = 255;
  // Planar - all the reds, then all the greens, then all the blues - which is
  // NCHW and is not the interleaved order getImageData hands back.
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
 * The mask, stretched back over the picture and multiplied into its alpha.
 *
 * **Min-max normalised first**, which the official implementation does too and
 * which matters more than it looks: the network's output is a confidence, not a
 * probability, and on a photograph with no strong subject every value comes back
 * bunched around 0.4. Written straight into alpha that is a uniformly murky
 * picture; stretched to the full range it is the best separation the model
 * actually found. A flat map - every value identical, which is what a completely
 * uniform picture gives - has no range to stretch, and is left alone rather than
 * divided by zero.
 *
 * The stretch back to the picture's size goes through drawImage rather than a
 * hand-written sampler, which buys bilinear interpolation from the compositor
 * for nothing - and bilinear is exactly right here, because a saliency map is a
 * smooth field and the soft edge it gives is the feathering this needs.
 *
 * The existing alpha is multiplied rather than replaced, so a picture that
 * arrived with transparency keeps it.
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
    // White with the confidence in its alpha. The colour is never read - the
    // composite below uses this as a stencil - but a fully transparent black
    // would premultiply to black and bleed dark edges through the interpolation
    // when it is scaled up.
    out.data[i] = 255; out.data[i + 1] = 255; out.data[i + 2] = 255; out.data[i + 3] = a;
  }
  mask.ctx.putImageData(out, 0, 0);
  try {
    // 'destination-in' keeps the destination's colour and takes its alpha from
    // the source: exactly "keep this picture, where the mask says so". Doing it
    // with the compositor rather than pixel by pixel is what makes the stretch
    // bilinear and the whole step one draw call.
    face.ctx.save();
    face.ctx.globalCompositeOperation = 'destination-in';
    face.ctx.drawImage(mask.canvas, 0, 0, SIDE, SIDE, 0, 0, w, h);
    face.ctx.restore();
  } catch {
    return false;
  }
  return true;
}
