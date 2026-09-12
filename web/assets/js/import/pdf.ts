// Render a PDF's first page to a raster via pdf.js. The raster becomes the
// card's picture while the original PDF stays embedded. pdf.js is carried in
// web/assets/vendor/pdfjs (not fetched from a CDN — CSP blocks cross-origin
// scripts), loaded on demand, and any failure degrades to "no picture".

// Library + worker from the same versioned vendor directory. Carried locally
// because CSP's script-src 'self' blocks CDN scripts — a jsdelivr URL silently
// broke every PDF on the deployed site while working fine on serve.py (no
// headers). Apache-2.0, pinned build.
import { noPreview, canvasBlocked } from '../notify.ts';
import { canvasReads } from '../canvas/surface.ts';

// Exported for tests/pdf-vendor.test.js to verify against the shipped build.
export const PDF_VERSION = '4.7.76';
const PDF_DIR = './assets/vendor/pdfjs/';

/** Absolute URL for a pdf.js file. Resolved against document.baseURI so both
 * `import()` and `new Worker()` agree on the path. A function — cannot touch
 * document at import time. */
const pdfURL = (file: string) => new URL(PDF_DIR + file, document.baseURI).href;

/** Long-edge ceiling for the rendered page, in device pixels. */
const TARGET = 1600;

// ---------------------------------------------------------------------------
// As much of pdf.js as this module speaks
// ---------------------------------------------------------------------------
//
// Minimal type surface for the pdf.js calls this module uses — no package to
// import declarations from.

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

/** Load pdf.js once. Not in SHELL (1.7 MB) — cached by the SW on first use. */
function loadPdfjs(): Promise<PdfJs> {
  if (!libPromise) {
    libPromise = import(/* @vite-ignore */ pdfURL('pdf.min.mjs')).then(mod => {
      const pdfjs = mod.default && mod.default.getDocument ? mod.default : mod;
      pdfjs.GlobalWorkerOptions.workerSrc = pdfURL('pdf.worker.min.mjs');
      return pdfjs;
    });
  }
  return libPromise;
}

async function toBlob(canvas: HTMLCanvasElement, type: string, quality?: number): Promise<Blob | null> {
  return new Promise<Blob | null>(resolve => canvas.toBlob(resolve, type, quality));
}

/** Open a PDF for page-by-page rendering (viewer path). Returns a canvas per
 * page, not a blob. Caller must destroy() when done. Throws on failure (unlike
 * firstPageRaster which returns null). */
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
      // Scale to requested width, capped at 3× (no floor — see firstPageRaster).
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

/** Render page one to a WebP (or PNG) blob at up to TARGET px. Null on any
 * failure — the card falls back to a grey label. */
export async function firstPageRaster(file: Blob) {
  let doc: PdfDocument | null = null;
  try {
    const pdfjs = await loadPdfjs();
    // Copy — pdf.js detaches the buffer it receives.
    const data = new Uint8Array(await file.arrayBuffer());
    doc = await pdfjs.getDocument({ data, disableAutoFetch: true, disableStream: true }).promise;
    const page = await doc.getPage(1);

    const base = page.getViewport({ scale: 1 });
    // No floor — a huge MediaBox or UserUnit must scale down freely. The 3×
    // ceiling is for stamp-sized pages that would otherwise be illegible.
    const scale = Math.min(TARGET / Math.max(base.width, base.height, 1), 3);
    const viewport = page.getViewport({ scale });
    const w = Math.max(1, Math.ceil(viewport.width));
    const h = Math.max(1, Math.ceil(viewport.height));

    const canvas = document.createElement('canvas');
    canvas.width = w;
    canvas.height = h;
    const ctx = canvas.getContext('2d');
    if (!ctx) {
      console.warn('[mbrd] pdf: no 2D context for the page raster');
      noPreview('PDF', 'this browser would not give a canvas to draw the page on');
      return null;
    }
    await page.render({ canvasContext: ctx, viewport }).promise;

    const blob = await toBlob(canvas, 'image/webp', 0.9) || await toBlob(canvas, 'image/png');
    // Firefox fingerprinting protection (default on Android) silently blocks
    // canvas readback. The page drew fine — the fix is a device setting.
    if (!blob) {
      console.warn('[mbrd] pdf: the page rendered and would not encode');
      // Fingerprinting block vs. generic encode failure — different messages.
      if (!canvasReads()) canvasBlocked();
      else noPreview('PDF', 'the page drew and this browser would not encode it');
      return null;
    }
    return { blob, w, h };
  } catch (err) {
    // Surfaced on-screen (noPreview) — a CSP refusal once hid behind this catch
    // for months, indistinguishable from a grey card. Console alone is invisible
    // on mobile.
    console.warn('[mbrd] pdf: page one did not render', err);
    noPreview('PDF', err);
    return null;
  } finally {
    try { doc?.destroy?.(); } catch { /* nothing to clean up */ }
  }
}
