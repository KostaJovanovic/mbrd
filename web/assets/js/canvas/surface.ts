// Drawing surface: OffscreenCanvas where available, <canvas> element as
// fallback (Safari <16.4). Unifies the two into one Surface type and owns the
// encode-to-blob difference in surfaceToBlob(). Five modules depend on this —
// without the fallback, all display copies / posters / thumbnails silently fail.

/** A canvas of either kind, with its 2D context already taken. */
export type Surface = {
  canvas: OffscreenCanvas | HTMLCanvasElement,
  ctx: OffscreenCanvasRenderingContext2D | CanvasRenderingContext2D,
};

/** A `w` x `h` drawing surface with a 2D context, or null. Tries OffscreenCanvas
 * first, then <canvas>. Smoothing set to 'high' — default 'low' aliases edges. */
export function surface(w: number, h: number, opts: { alpha?: boolean } = {}): Surface | null {
  // Falls through to <canvas> when OffscreenCanvas gives no 2D context.
  return withContext(offscreen(w, h), opts) || withContext(element(w, h), opts);
}

/**
 * Take a 2D context from a canvas, or null if it refuses. Firefox Android has
 * OffscreenCanvas but no 2D context on it — the constructor succeeds, getContext
 * returns null. This is why surface() tries both kinds. `alpha` passed through
 * for poster.ts's opaque context.
 */
function withContext(
  canvas: OffscreenCanvas | HTMLCanvasElement | null,
  opts: { alpha?: boolean },
): Surface | null {
  if (!canvas) return null;
  // Wrapped in try — some engines throw on unknown args.
  let ctx: Surface['ctx'] | null = null;
  try {
    // SAFETY: tsc cannot narrow getContext() across the union. '2d' gives CanvasRenderingContext2D
    // on an element and OffscreenCanvasRenderingContext2D on an OffscreenCanvas - the two arms of Surface['ctx'].
    ctx = canvas.getContext('2d', { alpha: opts.alpha !== false }) as Surface['ctx'] | null;
  } catch { /* the next canvas, or null */ }
  if (!ctx) return null;
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = 'high';
  return { canvas, ctx };
}

/** OffscreenCanvas or null. typeof check + try for engines that have the name but refuse the size. */
function offscreen(w: number, h: number): OffscreenCanvas | null {
  if (typeof OffscreenCanvas !== 'function') return null;
  try { return new OffscreenCanvas(w, h); } catch { return null; }
}

/** Ordinary <canvas>, or null in Node (no document). */
function element(w: number, h: number): HTMLCanvasElement | null {
  if (typeof document === 'undefined') return null;
  const el = document.createElement('canvas');
  el.width = w;
  el.height = h;
  return el;
}

/**
 * Whether this browser hands back the pixels it drew. Firefox fingerprinting
 * protection and Safari Lockdown Mode return blank/random data silently.
 * Probed by drawing a known colour and reading it back (tolerance ±8 per
 * channel). A yes is cached; a no is re-probed each call — Firefox can prompt
 * mid-session. False in Node.
 */
let readable = false;

export function canvasReads(): boolean {
  if (readable) return true;
  readable = probeReads();
  return readable;
}

function probeReads(): boolean {
  const face = surface(2, 2, { alpha: false });
  if (!face) return false;
  try {
    face.ctx.fillStyle = '#3b7dd8';
    face.ctx.fillRect(0, 0, 2, 2);
    const [r, g, b] = face.ctx.getImageData(0, 0, 1, 1).data;
    return Math.abs(r - 0x3b) <= 8 && Math.abs(g - 0x7d) <= 8 && Math.abs(b - 0xd8) <= 8;
  } catch {
    return false;
  }
}

/**
 * A photograph off this surface, as the smallest format the engine will write.
 *
 * WebP, or JPEG where the canvas will not write one - which is Safari, and
 * which is why surfaceToBlob()'s own fallback is no use here: it answers PNG,
 * and a full-resolution PNG of a twelve-megapixel photograph is forty megabytes
 * where the WebP is one. The same two-step optimize/picture.ts takes, hoisted
 * here because the decoders in import/heif.ts and optimize/demosaic.ts now
 * write the picture a card actually keeps rather than a stand-in behind one.
 */
export async function surfaceToPhoto(
  face: Surface,
  quality: number,
): Promise<Blob | null> {
  const webp = await surfaceToBlob(face, 'image/webp', quality);
  if (webp?.type.toLowerCase() === 'image/webp' && webp.size) return webp;
  const jpeg = await surfaceToBlob(face, 'image/jpeg', quality);
  return jpeg?.size ? jpeg : null;
}

/**
 * A picture off this surface: WebP, else JPEG, else whatever the canvas wrote.
 *
 * surfaceToPhoto() with a last resort. The posters, slides and display copies
 * would rather keep a large PNG than nothing, and the display copy and the
 * shrink pass `jpeg: false` when the pixels need their alpha (a cut-out, a PNG
 * source), because a JPEG would paint the transparency black. Null only when
 * the first encode gives nothing at all.
 */
export async function surfaceToPicture(
  face: Surface,
  quality: number,
  { jpeg = true }: { jpeg?: boolean } = {},
): Promise<Blob | null> {
  const first = await surfaceToBlob(face, 'image/webp', quality);
  if (!first) return null;
  if (first.type.toLowerCase() === 'image/webp' || !jpeg) return first;
  try {
    const out = await surfaceToBlob(face, 'image/jpeg', quality);
    return out?.type.toLowerCase() === 'image/jpeg' ? out : first;
  } catch {
    // No JPEG encoder either: the PNG is still the right pixels.
    return first;
  }
}

/** Whether a picture of this type has no alpha to lose to a JPEG. */
export const isJpeg = (type: string) => /^image\/jpe?g$/i.test(type);

/**
 * Encode the surface as bytes. Caller must check blob.type — Safari substitutes
 * PNG for WebP silently (toBlob), while convertToBlob rejects instead. The
 * try/catch unifies both: unsupported type falls back to PNG, the one format
 * every canvas must encode.
 */
export async function surfaceToBlob(
  { canvas }: Surface,
  type: string,
  quality: number,
): Promise<Blob | null> {
  // Test for the method, not the canvas kind — an engine may ship half the API.
  if ('convertToBlob' in canvas && typeof canvas.convertToBlob === 'function') {
    try {
      return await canvas.convertToBlob({ type, quality });
    } catch {
      try {
        return await canvas.convertToBlob({ type: 'image/png' });
      } catch {
        return null;
      }
    }
  }
  if ('toBlob' in canvas && typeof canvas.toBlob === 'function') {
    return new Promise(resolve => canvas.toBlob(resolve, type, quality));
  }
  return null;
}
