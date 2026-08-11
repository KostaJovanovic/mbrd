// The first page of a PDF, rendered to a picture, through pdf.js on demand.
//
// A PDF is a page-description language - paths, fonts, shadings, usually inside
// compressed streams - not an image, so no browser draws one into a card and
// nothing hand-rolled in this codebase is remotely the size of a PDF
// interpreter. But a PDF is the most ordinary reference a moodboard holds, and a
// wall of grey "PDF" cards is a poor answer. So this renders page one to a
// raster the ordinary image path can then show, and treats the result exactly
// like the embedded preview import/preview.js pulls out of a RAW: the original
// PDF is untouched, still embedded and still what a click opens, and the raster
// rides along as the picture the card draws.
//
// It leans on pdf.js, and is written to keep that dependency as contained as
// optimize/media.js keeps ffmpeg - the app's only other outside-code path, and
// the model this one copies:
//
//   - fetched from a CDN, not vendored. pdf.js is pulled from jsdelivr on first
//     use and the browser caches it; nothing about a board is sent, only the
//     request for the library. Offline or CDN down, the page is simply not
//     rendered and the PDF stays a named card.
//   - loaded on demand. Nothing here is touched until a PDF is imported, and it
//     is deliberately not in sw.js's SHELL - cross-origin, the service worker
//     steps aside for it, and it has no business in the cache of an app that is
//     otherwise self-contained.
//   - degrades to "no picture". Any failure - the library, the parse, the
//     render - returns null, and the caller falls back to the named card it
//     would have shown anyway.
//
// This is the second place, after media.js, that the app depends on somebody
// else's code, and it bends the no-runtime-dependency rule the same controlled
// way. Called out here so the bending is on the record.

// The library and its worker, from the same versioned directory so the two
// always match. The ESM build loads as a module; its worker is a module worker
// pdf.js spawns itself once workerSrc points at it.
const PDF_VERSION = '4.7.76';
const PDF_BASE = `https://cdn.jsdelivr.net/npm/pdfjs-dist@${PDF_VERSION}/build/`;

/** Roughly what pdf.js weighs, for anywhere that wants to warn before fetching. */
export const PDF_MB = 4;

/** Long-edge ceiling for the rendered page, in device pixels. */
const TARGET = 1600;

let libPromise = null;

/**
 * pdf.js, fetched once. The worker source is set on the shared module the first
 * time through; it is cross-origin, so the service worker leaves it alone.
 */
function loadPdfjs() {
  if (!libPromise) {
    libPromise = import(PDF_BASE + 'pdf.min.mjs').then(mod => {
      const pdfjs = mod.default && mod.default.getDocument ? mod.default : mod;
      pdfjs.GlobalWorkerOptions.workerSrc = PDF_BASE + 'pdf.worker.min.mjs';
      return pdfjs;
    });
  }
  return libPromise;
}

const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);

async function toBlob(canvas, type, quality) {
  return new Promise(resolve => canvas.toBlob(resolve, type, quality));
}

/**
 * Page one of `file` as `{ blob, w, h }`, or null.
 *
 * The page is drawn at whatever scale brings its long edge near TARGET, capped
 * so a small page is not blown up past three times its size and a poster-sized
 * one is brought down rather than rendered at hundreds of megapixels. WebP where
 * the browser will encode it, PNG otherwise - the same picture either way.
 */
export async function firstPageRaster(file) {
  let doc = null;
  try {
    const pdfjs = await loadPdfjs();
    // pdf.js keeps the buffer; a copy is handed over so nothing else that holds
    // this file sees it detached.
    const data = new Uint8Array(await file.arrayBuffer());
    doc = await pdfjs.getDocument({ data, disableAutoFetch: true, disableStream: true }).promise;
    const page = await doc.getPage(1);

    const base = page.getViewport({ scale: 1 });
    const scale = clamp(TARGET / Math.max(base.width, base.height), 0.1, 3);
    const viewport = page.getViewport({ scale });
    const w = Math.max(1, Math.ceil(viewport.width));
    const h = Math.max(1, Math.ceil(viewport.height));

    const canvas = document.createElement('canvas');
    canvas.width = w;
    canvas.height = h;
    const ctx = canvas.getContext('2d');
    if (!ctx) return null;
    await page.render({ canvasContext: ctx, viewport }).promise;

    const blob = await toBlob(canvas, 'image/webp', 0.9) || await toBlob(canvas, 'image/png');
    return blob ? { blob, w, h } : null;
  } catch {
    return null;
  } finally {
    try { doc?.destroy?.(); } catch { /* nothing to clean up */ }
  }
}
