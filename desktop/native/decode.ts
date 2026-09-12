// Native image decoding via sharp (libvips) for formats browsers cannot open.
// HEIC/HEIF and large TIFFs. Returns PNG (lossless; the renderer re-encodes).
// Camera RAW is deliberately excluded — it needs creative decisions this
// module cannot make. Returns null on failure; never throws.

import { extname } from 'node:path';
import { log } from '../log.ts';

// Explicit list — sharp can decode JPEG/PNG too, but those are faster in-browser.
const KNOWN = new Set(['heic', 'heif', 'hif', 'avif', 'tif', 'tiff']);

let broken = false;

/** Whether a native decode is worth asking for. */
export function handles(name: string): boolean {
  if (broken) return false;
  return KNOWN.has(extname(name).replace('.', '').toLowerCase());
}

/** Decode to PNG bytes, or null on failure. Never throws. */
export async function decode(bytes: ArrayBuffer, name: string): Promise<Buffer | null> {
  if (!handles(name)) return null;
  try {
    // Lazy — sharp is tens of MB; most boards never need it.
    const sharp = (await import('sharp')).default;
    // Default limitInputPixels kept — decompression-bomb guard for foreign files.
    return await sharp(Buffer.from(bytes)).png().toBuffer();
  } catch (err) {
    // If sharp itself cannot load, mark broken to avoid re-importing per card.
    if (err instanceof Error && /Cannot find module|not compatible|Could not load/i.test(err.message)) {
      broken = true;
      log('error', 'sharp will not load; native decoding is off for this run', err);
    } else {
      log('info', 'a picture did not decode natively', { name, err: String(err) });
    }
    return null;
  }
}
