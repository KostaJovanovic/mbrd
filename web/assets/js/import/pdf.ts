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

/** Long-edge ceiling for the rendered page, in device pixels. */
const TARGET = 1600;

// ---------------------------------------------------------------------------
// As much of pdf.js as this module speaks
// ---------------------------------------------------------------------------
//
// The library is fetched at a URL, so there is nothing for the typechecker to
// read it out of and no package to take a declaration from. What is written
// here is only the handful of calls below - four methods and two numbers - so
// that the rest of the module is checked against something rather than against
// whatever a CDN answers with. It is a description of this module's use of
// pdf.js, not of pdf.js.

/** A page's geometry at some scale. Handed straight back to render(). */
type PdfViewport = { width: number, height: number };

type PdfPage = {
  getViewport(opts: { scale: number }): PdfViewport,
  render(opts: { canvasContext: CanvasRenderingContext2D, viewport: PdfViewport }): {
    promise: Promise<void>,
  },
};

type PdfDocument = {
  numPages: number,
  getPage(n: number): Promise<PdfPage>,
  destroy?(): void,
};

type PdfJs = {
  GlobalWorkerOptions: { workerSrc: string },
  getDocument(opts: {
    data: Uint8Array,
    disableAutoFetch?: boolean,
    disableStream?: boolean,
  }): { promise: Promise<PdfDocument> },
};

let libPromise: Promise<PdfJs> | null = null;

/**
 * pdf.js, fetched once. The worker source is set on the shared module the first
 * time through; it is cross-origin, so the service worker leaves it alone.
 */
function loadPdfjs(): Promise<PdfJs> {
  if (!libPromise) {
    libPromise = import(PDF_BASE + 'pdf.min.mjs').then(mod => {
      const pdfjs = mod.default && mod.default.getDocument ? mod.default : mod;
      pdfjs.GlobalWorkerOptions.workerSrc = PDF_BASE + 'pdf.worker.min.mjs';
      return pdfjs;
    });
  }
  return libPromise;
}

async function toBlob(canvas: HTMLCanvasElement, type: string, quality?: number): Promise<Blob | null> {
  return new Promise<Blob | null>(resolve => canvas.toBlob(resolve, type, quality));
}

/**
 * A PDF opened for reading, page by page: `{ pages, render(n, scale) }`.
 *
 * The viewer's half of this module, and the reason it is a separate entry point
 * from firstPageRaster() below: that one wants a single raster and closes the
 * document again, while this one is opened, paged through and then destroyed by
 * the caller. Sharing them would mean either re-parsing the file per page or
 * leaving a document handle open after a thumbnail.
 *
 * `render` hands back a canvas rather than a blob - it is going straight into
 * the page, so there is nothing to encode and nothing to make a URL for. The
 * caller destroys the document when it is finished; failing to is a parsed PDF
 * held for the life of the tab.
 *
 * Throws where firstPageRaster() returns null, because the two failures mean
 * different things: a thumbnail that cannot be made is a card without one, and a
 * document that cannot be opened is a viewer with something to say.
 */
export async function openPdf(file: Blob) {
  const pdfjs = await loadPdfjs();
  const data = new Uint8Array(await file.arrayBuffer());
  const doc = await pdfjs.getDocument({ data, disableAutoFetch: true, disableStream: true }).promise;
  return {
    pages: doc.numPages,
    destroy: () => { try { doc.destroy?.(); } catch { /* nothing to clean up */ } },
    async render(n: number, width: number) {
      const page = await doc.getPage(n);
      const base = page.getViewport({ scale: 1 });
      // Scaled to the box it is going into rather than to a fixed target: a
      // viewer is as wide as the window and a thumbnail is not, so the same
      // ceiling would either blur one or waste memory on the other. Capped at 3
      // so a business card does not become a wall, and with no floor for the
      // reason firstPageRaster() gives below: a floor makes the requested width
      // a suggestion, and the page decides how much canvas to ask for.
      const scale = Math.min(width / Math.max(base.width, 1), 3);
      const viewport = page.getViewport({ scale });
      const canvas = document.createElement('canvas');
      canvas.width = Math.max(1, Math.ceil(viewport.width));
      canvas.height = Math.max(1, Math.ceil(viewport.height));
      const ctx = canvas.getContext('2d');
      if (!ctx) throw new Error('This browser would not give us a canvas');
      await page.render({ canvasContext: ctx, viewport }).promise;
      return canvas;
    },
  };
}

/**
 * Page one of `file` as `{ blob, w, h }`, or null.
 *
 * The page is drawn at whatever scale brings its long edge near TARGET, capped
 * so a small page is not blown up past three times its size and a poster-sized
 * one is brought down rather than rendered at hundreds of megapixels. WebP where
 * the browser will encode it, PNG otherwise - the same picture either way.
 */
export async function firstPageRaster(file: Blob) {
  let doc: PdfDocument | null = null;
  try {
    const pdfjs = await loadPdfjs();
    // pdf.js keeps the buffer; a copy is handed over so nothing else that holds
    // this file sees it detached.
    const data = new Uint8Array(await file.arrayBuffer());
    doc = await pdfjs.getDocument({ data, disableAutoFetch: true, disableStream: true }).promise;
    const page = await doc.getPage(1);

    const base = page.getViewport({ scale: 1 });
    // No floor on the way down, which is what makes TARGET a cap rather than a
    // wish. `clamp(..., 0.1, 3)` refused to scale a page below a tenth, so a
    // MediaBox of 200,000 units - or an ordinary page with a large UserUnit -
    // asked the canvas for 20,000 x 20,000, which is 1.6 GB. The docstring's
    // claim that "a poster-sized one is brought down rather than rendered at
    // hundreds of megapixels" was the opposite of what the floor did.
    //
    // The ceiling stays: scaling a stamp-sized page up to something legible is
    // the thing the number is for.
    const scale = Math.min(TARGET / Math.max(base.width, base.height, 1), 3);
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
