// Pictures no browser will open.
//
// HEIC is the case that matters. A phone shoots it, no desktop browser decodes
// it, and today the card is a grey rectangle with a filename on it - the same
// shape an HEVC clip had before ffmpeg. import/preview.ts already goes looking
// for an embedded JPEG preview inside such a file, which works when the camera
// put one there and does not when it did not.
//
// libvips, through sharp, decodes the real thing. Behind the port, asked before
// the browser's own decoder is given up on, answering null for anything it does
// not know - which is most formats, because this is not a general converter and
// should not become one.
//
// ── What is here, and what is deliberately not ──
//
// HEIC/HEIF and big TIFFs. Both are formats this app already tries to handle
// and already handles badly: the TIFF worker under import/ reads a useful
// subset and gives up on the rest, and HEIC has no decoder at all.
//
// **Camera RAW is not here.** sharp can be built with RAW support and the
// temptation is obvious, but a RAW file is not a picture - it is sensor data
// plus a set of decisions nobody has made yet, and white balance, demosaic and
// tone curve are all choices that change what the photograph *is*. Getting them
// silently wrong is worse than the grey card, because a wrong answer looks like
// an answer. That is its own project and the plan says so.
//
// ── PNG out, always ──
//
// Lossless, and the renderer re-encodes anyway - it puts the result through the
// same optimiser every other picture goes through. Handing back a JPEG here
// would mean two lossy steps for a file the person never asked to compress
// twice.

import { extname } from 'node:path';
import { log } from '../log.ts';

/**
 * The extensions this will attempt, and nothing wider.
 *
 * A list rather than "try it and see", because sharp will happily decode a JPEG
 * and a PNG too - and routing those through a native process would be slower
 * than the browser doing it, for a picture the browser was never going to fail
 * on. The port is asked *before* the browser's own decoder gives up, so an
 * over-eager list here quietly takes work off a path that was already fine.
 */
const KNOWN = new Set(['heic', 'heif', 'hif', 'avif', 'tif', 'tiff']);

let broken = false;

/** Whether a native decode is worth asking for. */
export function handles(name: string): boolean {
  if (broken) return false;
  return KNOWN.has(extname(name).replace('.', '').toLowerCase());
}

/**
 * Decode to PNG bytes, or null.
 *
 * Null for every failure and never a throw, which is the protocol every native
 * port in this app takes: the caller has a path behind this one, and a decoder
 * that raised would turn "we could not read this picture" into an error
 * somebody has to catch three layers up.
 */
export async function decode(bytes: ArrayBuffer, name: string): Promise<Buffer | null> {
  if (!handles(name)) return null;
  try {
    // Imported on first use rather than at the top of the file. sharp is a
    // native module of some tens of megabytes; loading it at startup would cost
    // every launch for a format most boards never see.
    const sharp = (await import('sharp')).default;
    // `limitInputPixels` left at sharp's own default on purpose. It is a
    // decompression-bomb guard - a 50,000-square TIFF that expands to gigabytes
    // - and this file is reading documents the app did not write, which is
    // exactly the case it exists for. The app's own ceilings in import/budget.ts
    // are about what a board can hold; this one is about what a process can
    // survive decoding.
    return await sharp(Buffer.from(bytes)).png().toBuffer();
  } catch (err) {
    // A module that will not load at all is different from a file that will not
    // decode, and only the first is worth remembering: sharp's native binary
    // being absent or wrong for this platform means every later ask fails the
    // same way, and asking each time is tens of megabytes of import per card.
    if (err instanceof Error && /Cannot find module|not compatible|Could not load/i.test(err.message)) {
      broken = true;
      log('error', 'sharp will not load; native decoding is off for this run', err);
    } else {
      log('info', 'a picture did not decode natively', { name, err: String(err) });
    }
    return null;
  }
}
