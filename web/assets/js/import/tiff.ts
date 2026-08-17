// A TIFF, decoded to a picture the board can draw.
//
// TIFF is the one format in this app's catalogue that is both *ordinary* and
// undrawable: a scan, a print-ready export, a Photoshop save, a fax - and no
// engine but Safari decodes one. Until this it was the worst card on the board,
// because the fallbacks that carry every other undecodable picture do not reach
// it. import/preview.ts walks the TIFF directory looking for an embedded JPEG,
// which a camera RAW has and a plain TIFF does not; import/document.ts wants a
// container with a thumbnail in it, and a TIFF is not a container of that kind.
// So a .tif landed as a grey named card with the file's own name on it, and the
// picture inside was simply unreachable.
//
// It is reachable with a decoder, and the decoder is 79 kB of somebody else's
// code: UTIF.js, from Photopea, plus pako's inflate for the pages written with
// ZIP compression. Both are vendored under web/assets/vendor and credited in
// index.html's credits sheet and in THIRD-PARTY.md. That is the third thing in
// this app that is not written here, after pdf.js and ffmpeg, and it is carried
// the way pdf.js is carried rather than fetched the way ffmpeg is:
//
//   - **carried, not fetched.** The two files sit in this repository and are
//     served from this origin, so nothing about a board is sent anywhere, the
//     library cannot change under the app, and `script-src 'self'` needs no
//     exception. See the head of import/pdf.ts, which argues this at length
//     after learning it the hard way.
//   - **loaded on demand.** Nothing here is touched until a TIFF is imported,
//     and neither file is in sw.js's SHELL - the service worker caches them on
//     first use like any other same-origin asset, so the second TIFF works
//     offline and the first costs 79 kB.
//   - **run in a worker.** UTIF is pure JavaScript over every pixel, and a
//     flatbed scan is hundreds of megapixels. On the main thread that is a
//     board that stops moving. See import/tiff-worker.js.
//   - **degrades to a named card.** Any failure - the library, the parse, a
//     page past the pixel ceiling - answers null, and the caller falls back to
//     exactly what it showed before this module existed.
//
// The original file is untouched and is still what the .mbrd carries and what a
// click downloads. What this produces is `meta.preview`, the same slot the
// picture out of a RAW and the raster of a PDF page go into - so the card draws
// the photograph and the file stays the file.

import { extOf } from '../util.ts';
import { oversize, isOversize } from '../consent.ts';

/** Where the worker is, relative to the document - see the note in optimize/media.ts
 *  about the same path. index.html carries a <base>, so this resolves against it. */
const WORKER_URL = './assets/js/import/tiff-worker.js';

/**
 * How long one decode may take before it is abandoned.
 *
 * Generous, because the thing being waited for is genuinely slow: a 200
 * megapixel scan is tens of seconds of straight-line JavaScript, and giving up
 * on it early would mean the format works for small files and mysteriously does
 * not for the big ones that most need it. It is a backstop against a worker
 * that has died rather than a limit on honest work - and while it runs, the
 * board is responsive, which is the whole reason there is a worker.
 */
const DECODE_MS = 120_000;

/** The extensions this is asked about. Every TIFF ever written is one of these,
 *  and the RAW formats that are *also* TIFFs are deliberately not: those carry
 *  a full-size JPEG the camera wrote, which import/preview.ts already reads at
 *  a thousandth of the cost. */
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

/**
 * The picture inside a TIFF, as a File, or null.
 *
 * A File rather than a Blob because that is what prepareFile() hands to
 * addFile() and measureSize(), and what the other preview readers already
 * answer with - they are used interchangeably at that one call site.
 *
 * `lift` is the retry half of consent.ts's contract, the same one the RAW
 * preview and the cover art take: called without it, a scan past the pixel
 * ceiling throws Oversize instead of decoding, asking() puts the question, and
 * a yes calls this again with the ceiling lifted. A no is a named card, which
 * is where this file was headed before any of it existed.
 */
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
    // The ceiling is a question and leaves by the front door; everything else is
    // a decode that did not work, which is a console line and a null - the same
    // bargain import/pdf.ts strikes. A decoder that could not read a file is
    // worth a line for whoever is looking at it and is not worth failing an
    // import over: the card is the one it would have been anyway.
    if (isOversize(err)) throw err;
    console.warn('[mbrd] tiff: could not decode', file.name, err);
    return null;
  }
}

/** The worker's ceiling, repeated here for the sentence above. Kept in step by
 *  tests/tiff.test.js, which reads the number out of both files. */
const MAX_PIXELS = 64 * 1024 * 1024;

/** The name without its extension, so a `scan.tif` becomes a `scan.webp`. */
const baseName = (name: string) => name.replace(/\.[^./\\]*$/, '') || 'page';

/**
 * One decode, on the shared worker.
 *
 * The worker is spawned on the first call and kept: a folder of TIFFs is the
 * ordinary case, spawning one per file would import the library once per file,
 * and the thing has no state between jobs to leak. It is never torn down, which
 * is the same choice optimize/media.ts makes about its own - a dead idle worker
 * costs a few hundred kilobytes, and the alternative is deciding when a board
 * has finished importing.
 */
function run(bytes: ArrayBuffer, lift: boolean): Promise<WorkerReply> {
  const w = ensureWorker();
  const id = nextId++;
  return new Promise<WorkerReply>((resolve, reject) => {
    const timer = setTimeout(() => {
      waiting.delete(id);
      reject(new Error('the decoder did not answer'));
    }, DECODE_MS);
    waiting.set(id, msg => {
      clearTimeout(timer);
      if (msg.error) reject(new Error(msg.error));
      else resolve(msg);
    });
    // Transferred rather than copied: the buffer is the whole file, and a TIFF
    // is the format most likely to be a hundred megabytes of it. The caller's
    // view is detached afterwards, which is why this takes the ArrayBuffer
    // rather than the File - nothing above needs it back.
    w.postMessage({ id, bytes, lift }, [bytes]);
  });
}

function ensureWorker(): Worker {
  if (worker) return worker;
  // A throw here is the honest failure: a browser that refuses to spawn a
  // worker cannot decode a TIFF at all, and tiffRaster()'s catch turns it into
  // the named card. Nothing is cached about the failure - the next file asks
  // again, which costs one refusal and covers a policy that changed.
  const w = new Worker(WORKER_URL);
  w.onmessage = (e: MessageEvent<WorkerReply>) => {
    const done = waiting.get(e.data?.id);
    if (!done) return;               // a job that timed out and gave up
    waiting.delete(e.data.id);
    done(e.data);
  };
  // A worker that dies takes every job on it down: each one is failed by name
  // rather than left to time out, and the next call spawns a new one.
  w.onerror = () => {
    for (const [id, done] of waiting) { waiting.delete(id); done({ id, error: 'the decoder stopped' }); }
    if (worker === w) worker = null;
    w.terminate();
  };
  worker = w;
  return w;
}
