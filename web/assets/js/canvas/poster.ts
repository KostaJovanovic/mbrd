// Grab a video's first frame in the browser. Fails to "no poster" — H.265
// from a phone is the common undecodable case. optimize/media.ts uses ffmpeg
// when it matters enough.

import { surface, surfaceToPicture, canvasReads, type Surface } from './surface.ts';
import { noPreview, canvasBlocked } from '../notify.ts';
import { glFrame } from './gl-frame.ts';

/** Max poster edge. 640 covers a mobile card at 2x and desktop at 1x. */
const POSTER_SIDE = 640;

/** Total budget for up to three seek attempts. Hard stop — no partial answer. */
const POSTER_MS = 9000;

/**
 * Fallback timeout after seek. requestVideoFrameCallback is unreliable (Chrome
 * never fires it here), so whichever of the callback and this clock comes first
 * triggers the read. seeked has fired by then, which is what matters.
 */
const FRAME_MS = 150;

/**
 * How much two sampled pixels may differ before a frame counts as having
 * something in it, and how many pixels are looked at.
 *
 * This replaces a test on the *encoded size* - under 2 KB was "blank" - which
 * threw away real pictures: a 320-wide frame of ordinary colour encodes to 800
 * bytes. It also judged at one seek point, so a clip opening on a fade, a slate
 * or a title card was written off rather than looked at further in.
 *
 * A flat frame is one where every sample is the same colour. Anything else is a
 * picture, however dark or however small it compresses to.
 */
const FLAT_SPREAD = 10;
const FLAT_SAMPLES = 240;

/**
 * A grabbed frame: the WebP itself, and the clip's *own* pixel size.
 *
 * The dimensions are the video's, not the blob's - the blob is capped at
 * POSTER_SIDE, while a caller sizing a card wants the aspect the clip really
 * has.
 */
export type VideoFrameShot = { blob: Blob; w: number; h: number };

/**
 * Grab a frame from a clip as a WebP blob. Seeks multiple points to skip
 * fades/slates, keeps the first non-flat frame. All-flat clips get no poster
 * (keeps the question open for repair passes). Null is normal — each refusal
 * is logged so it is debuggable from a console.
 */
export async function videoFrame(file: Blob): Promise<VideoFrameShot | null> {
  // Already proven this browser cannot draw video to canvas — skip.
  if (blankBrowser) return null;
  const url = URL.createObjectURL(file);
  const v = document.createElement('video');
  // Required: unmuted may not autoplay; non-inline iOS draws transparent.
  v.muted = true;
  v.playsInline = true;
  // Must be in the page for decoders to produce frames. 2px, nearly transparent,
  // fixed at origin — not display:none (no decode), not opacity:0 (Chrome may
  // suspend), must intersect viewport (out-of-sight decoding skipped).
  v.style.position = 'fixed';
  v.style.left = '0';
  v.style.top = '0';
  v.style.width = '2px';
  v.style.height = '2px';
  v.style.opacity = '0.01';
  v.style.pointerEvents = 'none';
  v.setAttribute('aria-hidden', 'true');
  document.body?.append(v);
  // 'metadata' not 'auto' — avoid buffering entire clips for one frame.
  v.preload = 'metadata';

  try {
    return await Promise.race([
      grab(v, url),
      wait(POSTER_MS).then(() => {
        console.warn('[mbrd] poster: gave up waiting for a frame');
        noPreview('clip', `no frame after ${POSTER_MS / 1000}s`);
        return null;
      }),
    ]);
  } catch (err) {
    console.warn('[mbrd] poster: no frame', err);
    noPreview('clip', err);
    return null;
  } finally {
    v.pause?.();
    v.removeAttribute('src');
    v.load?.();
    v.remove();
    URL.revokeObjectURL(url);
  }
}

/** Seek points: near start, 1s in, 10% in. Bounded by duration, deduplicated. */
function points(dur: number): number[] {
  if (!Number.isFinite(dur) || dur <= 0) return [0.1];
  const wanted = [Math.min(0.1, dur / 2), 1, dur * 0.1].filter(t => t < dur);
  return [...new Set(wanted.map(t => Math.round(t * 100) / 100))];
}

/** Open the clip, walk the points, and answer with the first frame worth having. */
async function grab(v: HTMLVideoElement, url: string): Promise<VideoFrameShot | null> {
  const opened = once(v, 'loadedmetadata');
  const failed = once(v, 'error').then(() => { throw new Error('this browser cannot decode it'); });
  // Swallow: teardown fires 'error' after races end, causing unhandled rejection.
  failed.catch(() => {});
  v.src = url;
  await Promise.race([opened, failed]);
  if (!v.videoWidth) throw new Error('no picture in it');

  // Some decoders need a play() before they produce frames from a seek.
  await v.play().then(() => v.pause(), () => {});

  // Last refusal reason — empty means all frames were flat (different diagnosis).
  let refused = '';
  for (const at of points(v.duration)) {
    const seeked = once(v, 'seeked');
    v.currentTime = at;
    await Promise.race([seeked, failed]);
    // Two reads per point: first uses readyState shortcut, second always waits
    // the clock — catches engines where seeked fires before the frame is ready.
    for (let look = 0; look < 2; look++) {
      await presented(v, look);
      const took = await capture(v).catch(err => {
        console.warn(`[mbrd] poster: capture threw at ${at}s`, err);
        return { shot: null, flat: false, why: 'the capture threw: ' + why(err) };
      });
      if (took.shot && !took.flat) return took.shot;
      if (took.why) refused = took.why;
    }
  }
  // Last resort: try while playing (the only way on Firefox Android).
  if (!refused) {
    const live = await running(v).catch(() => null);
    if (live) return live;
  }
  // Every frame flat + canvas readable = this browser cannot draw video to canvas.
  // Sticky for the session — subsequent clips skip to the ffmpeg path.
  if (!refused && canvasReads()) blankBrowser = true;
  if (blankBrowser) {
    console.warn('[mbrd] poster: this browser draws video onto a canvas as nothing');
    noPreview('clip', 'this browser will not draw a clip onto a canvas - trying the video tools instead');
    return null;
  }
  // Distinguish refusal (encoder/canvas said no) from unreadable canvas.
  console.warn('[mbrd] poster: no frame kept', refused || 'the pixels could not be read');
  if (refused) noPreview('clip', refused);
  else canvasBlocked();
  return null;
}

/**
 * Capture while playing — the only path that works on Firefox Android, where
 * a paused SurfaceTexture has no data. Eight looks with capture() trying both
 * 2D and WebGL doors. Only reached after all seek points were flat.
 */
async function running(v: HTMLVideoElement): Promise<VideoFrameShot | null> {
  try {
    await v.play();
  } catch {
    return null;
  }
  try {
    for (let look = 0; look < 8; look++) {
      await presented(v, 1);
      const took = await capture(v);
      if (took.shot && !took.flat) return took.shot;
    }
    return null;
  } finally {
    v.pause();
  }
}

/** Session-sticky flag: this browser draws video as nothing on canvas. */
let blankBrowser = false;

export function videoDrawsBlank(): boolean {
  return blankBrowser;
}

/** An error's own words, for a line somebody has to act on. */
const why = (err: unknown) => (err instanceof Error ? err.message : String(err ?? 'no reason given'));

/** One event, as a promise. */
function once(el: EventTarget, type: string): Promise<Event> {
  return new Promise(resolve => el.addEventListener(type, resolve, { once: true }));
}

/**
 * Wait for a frame. First look trusts readyState shortcut; second look always
 * takes the clock (readyState lied before the flat read). See FRAME_MS.
 */
function presented(v: HTMLVideoElement, look = 0): Promise<void> {
  if (look === 0 && v.readyState >= v.HAVE_CURRENT_DATA) return Promise.resolve();
  const clock = wait(FRAME_MS);
  return typeof v.requestVideoFrameCallback === 'function'
    ? Promise.race([new Promise<void>(resolve => v.requestVideoFrameCallback(() => resolve())), clock])
    : clock;
}

const wait = (ms: number) => new Promise<void>(resolve => { setTimeout(resolve, ms); });

/**
 * Draw the current frame into a capped picture. Returns shot, flat flag, and
 * refusal reason. `flat` is a report — grab() decides across all points.
 */
async function capture(
  v: HTMLVideoElement,
): Promise<{ shot: VideoFrameShot | null, flat: boolean, why: string }> {
  const scale = Math.min(1, POSTER_SIDE / Math.max(v.videoWidth, v.videoHeight));
  const w = Math.max(1, Math.round(v.videoWidth * scale));
  const h = Math.max(1, Math.round(v.videoHeight * scale));
  // Falls back to <canvas> where OffscreenCanvas is absent (Safari <16.4).
  const face = surface(w, h, { alpha: false });
  if (!face) return { shot: null, flat: false, why: 'this browser would not give a canvas to draw the frame on' };
  face.ctx.drawImage(v, 0, 0, w, h);
  let flat = looksFlat(face.ctx, w, h);
  // Firefox Android: drawImage(video) is blank (bug 1526207). WebGL texImage2D
  // works (bug 1655101). Only tried when the 2D path was flat.
  if (flat) {
    const gl = glFrame(v, w, h);
    if (gl) {
      face.ctx.drawImage(gl, 0, 0, w, h);
      flat = looksFlat(face.ctx, w, h);
    }
  }
  // WebP, or JPEG on Safari, which never encodes WebP from a canvas; a large
  // PNG poster beats none. Video frames have no transparency to lose.
  const out = await surfaceToPicture(face, 0.72);
  if (!out) return { shot: null, flat, why: 'the frame drew and this browser would not encode it' };
  return { shot: { blob: out, w: v.videoWidth, h: v.videoHeight }, flat, why: '' };
}

/**
 * Whether every sampled pixel is the same colour (within FLAT_SPREAD). Stride-
 * sampled for speed. False when the canvas is unreadable — a frame that cannot
 * be inspected is not necessarily empty.
 */
function looksFlat(ctx: Surface['ctx'], w: number, h: number): boolean {
  if (!canvasReads()) return false;
  let data: Uint8ClampedArray;
  try { data = ctx.getImageData(0, 0, w, h).data; } catch { return true; }
  const pixels = data.length / 4;
  const stride = Math.max(1, Math.floor(pixels / FLAT_SAMPLES)) * 4;
  const lo = [255, 255, 255];
  const hi = [0, 0, 0];
  for (let i = 0; i < data.length; i += stride) {
    for (let c = 0; c < 3; c++) {
      const v = data[i + c];
      if (v < lo[c]) lo[c] = v;
      if (v > hi[c]) hi[c] = v;
    }
  }
  return hi[0] - lo[0] <= FLAT_SPREAD
    && hi[1] - lo[1] <= FLAT_SPREAD
    && hi[2] - lo[2] <= FLAT_SPREAD;
}

/**
 * Capture the frame an on-board `<video>` is currently showing. Unlike
 * videoFrame() (import path), this reads a decoder already parked where the
 * user left it — one drawImage, no seeking. Flat result is reported, not
 * refused — the user chose this frame. Null when the element has no frame
 * (iOS parks src until first tap; caller should fall back to meta.cover).
 */
export async function frameOnScreen(v: HTMLVideoElement): Promise<VideoFrameShot | null> {
  if (!v.videoWidth || !v.videoHeight) return null;
  if (v.readyState < v.HAVE_CURRENT_DATA) return null;
  return (await capture(v)).shot;
}

/**
 * Whether a stored poster is a flat (blank) rectangle. Used by repair passes
 * (backfill, optimiser) to treat a blank cover as no cover — letting the clip
 * be re-grabbed. Same looksFlat() threshold as the live capture path. False
 * on anything it cannot decode.
 */
export async function pictureIsFlat(blob: Blob): Promise<boolean> {
  try {
    const bitmap = await createImageBitmap(blob);
    const w = Math.max(1, Math.min(bitmap.width, POSTER_SIDE));
    const h = Math.max(1, Math.round((bitmap.height / bitmap.width) * w));
    const face = surface(w, h, { alpha: false });
    if (!face) return false;
    face.ctx.drawImage(bitmap, 0, 0, w, h);
    bitmap.close?.();
    return looksFlat(face.ctx, w, h);
  } catch {
    return false;
  }
}

