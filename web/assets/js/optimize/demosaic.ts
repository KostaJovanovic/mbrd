// Camera RAW, developed: the sensor data in a .cr2, .nef, .arw and the rest,
// demosaiced by LibRaw (vendored, compiled to wasm) into a picture a browser
// draws. Loaded on first use, in a module worker the site policy is dropped for
// (web/_headers). A sensor past SENSOR_PIXELS throws Oversize for the caller.

import { RAW_EXTS } from '../import/formats.ts';
import { oversize } from '../consent.ts';
import { cameFrom } from '../util.ts';
import { surface, surfaceToPhoto } from '../canvas/surface.ts';

/** The libraw-wasm release in web/assets/vendor/libraw/, which wraps LibRaw 0.22.1. */
export const LIBRAW_VERSION = '1.6.0';
const LIB_DIR = './assets/vendor/libraw/';
// Named here rather than left to index.js, which spawns it from beside itself,
// so tests/csp.test.js reads the one path _headers exempts: the worker compiles
// libraw.wasm, which the page's policy does not allow.
export const WORKER_URL = './assets/vendor/libraw/worker.js';

/**
 * The largest sensor developed without asking, in pixels.
 *
 * LibRaw holds the image at four 16-bit channels a pixel while it works, so a
 * 61-megapixel sensor is about half a gigabyte inside the worker before the
 * picture comes back and is drawn again at four bytes a pixel. 64 Mpx lets
 * every full-frame body through and asks about medium format.
 */
export const SENSOR_PIXELS = 64 * 1024 * 1024;

/**
 * The largest picture this draws, in pixels: iOS Safari's canvas ceiling, past
 * which it draws nothing and says nothing. A sensor over it is scaled down to
 * fit. The RAW itself is kept, so nothing is lost that a card could show.
 */
const CANVAS_PIXELS = 4096 * 4096;

/** WebP, at the quality a photograph survives being kept at. The developed
 *  picture is the card's file rather than a stand-in behind one, so it is
 *  written once and read forever - see surfaceToPhoto(), which answers JPEG
 *  where WebP is not available. */
const QUALITY = 0.9;

/** The part of LibRaw's settings this sets. See the libraw-wasm readme for the rest. */
type Settings = {
  useCameraWb: boolean, outputBps: number, outputColor: number, halfSize: boolean,
};

/** As-shot white balance, which is what the camera's own preview used. 8 bits, sRGB. */
const SETTINGS: Settings = { useCameraWb: true, outputBps: 8, outputColor: 1, halfSize: false };

/** A developed picture and its size. */
export type Developed = { blob: Blob, width: number, height: number };

type Picture = { width?: unknown, height?: unknown, colors?: unknown, data?: unknown };
type LibRawInstance = {
  open(bytes: Uint8Array, settings: Settings): Promise<void>,
  metadata(): Promise<{ width?: unknown, height?: unknown } | null>,
  imageData(): Promise<Picture | null>,
  dispose(): void,
};
type LibRawModule = { default: new () => LibRawInstance };

let mod: Promise<LibRawModule> | null = null;

function loadLib(): Promise<LibRawModule> {
  // Against document.baseURI, so index.js resolves worker.js under the same path.
  mod ??= import(/* @vite-ignore */ new URL(`${LIB_DIR}index.js`, document.baseURI).href);
  // A failed load is not remembered, so the next RAW tries again.
  mod.catch(() => { mod = null; });
  return mod;
}

/**
 * A photograph whose own bytes are a camera RAW: the card Demosaic and Optimize
 * develop. By the extension it arrived with, since the registry forgets names.
 */
export function isRaw(it: {
  type?: string, name?: string, asset?: { hash?: string } | null, meta?: Record<string, unknown> | null,
} | null | undefined): boolean {
  if (it?.type !== 'image' || !it.asset?.hash) return false;
  return RAW_EXTS.has(cameFrom(it));
}

/**
 * Develop one RAW. One LibRaw per call, disposed after: a wasm heap never
 * shrinks, so ending the worker is the only way to give the memory back.
 *
 * `half` takes LibRaw's half-size path, which reads one pixel per sensor site
 * instead of interpolating four: a sixth of the time and a quarter of the
 * memory, for a picture still over the display ceiling on any camera made this
 * century. It is what the importer develops with (import/drop.ts) - the
 * Demosaic row is the one that asks for every pixel.
 */
export async function demosaic(raw: Blob, lift = false, half = false): Promise<Developed> {
  const { default: LibRaw } = await loadLib();
  const lib = new LibRaw();
  try {
    await lib.open(new Uint8Array(await raw.arrayBuffer()), { ...SETTINGS, halfSize: half });
    const facts = await lib.metadata();
    const w = Number(facts?.width) || 0;
    const h = Number(facts?.height) || 0;
    if (!lift && w * h > SENSOR_PIXELS) {
      throw oversize('sensor-pixels',
        `This RAW is ${w} x ${h}, ${Math.round(w * h / 1e6)} megapixels, past the ${Math.round(SENSOR_PIXELS / 1e6)} developed without asking.`);
    }
    const img = await lib.imageData();
    if (!img) throw new Error('LibRaw returned no picture');
    return await draw(img);
  } finally {
    lib.dispose();
  }
}

/** LibRaw's RGB rows, drawn and written as a JPEG. */
async function draw(img: Picture): Promise<Developed> {
  const w = Number(img.width);
  const h = Number(img.height);
  const colors = Number(img.colors);
  const data = img.data;
  const src = data instanceof Uint8Array || data instanceof Uint8ClampedArray || data instanceof Uint16Array
    ? data : null;
  if (!src || !(w > 0 && h > 0) || ![1, 3, 4].includes(colors)) {
    throw new Error('LibRaw returned a picture this cannot read');
  }
  const px = w * h;
  if (src.length < px * colors) throw new Error('LibRaw returned fewer pixels than it declared');
  // outputBps is 8, but a 16-bit answer is still read rather than refused.
  const shift = src instanceof Uint16Array ? 8 : 0;
  const rgba = new Uint8ClampedArray(px * 4);
  for (let i = 0, j = 0, o = 0; i < px; i++, j += colors, o += 4) {
    const r = src[j] >> shift;
    rgba[o] = r;
    rgba[o + 1] = colors === 1 ? r : src[j + 1] >> shift;
    rgba[o + 2] = colors === 1 ? r : src[j + 2] >> shift;
    rgba[o + 3] = 255;
  }
  const full = new ImageData(rgba, w, h);
  const scale = Math.min(1, Math.sqrt(CANVAS_PIXELS / px));
  const tw = Math.max(1, Math.floor(w * scale));
  const th = Math.max(1, Math.floor(h * scale));
  const face = surface(tw, th, { alpha: false });
  if (!face) throw new Error('No canvas to draw the developed picture on');
  if (scale < 1) {
    const bmp = await createImageBitmap(full, { resizeWidth: tw, resizeHeight: th, resizeQuality: 'high' });
    face.ctx.drawImage(bmp, 0, 0);
    bmp.close();
  } else {
    face.ctx.putImageData(full, 0, 0);
  }
  const blob = await surfaceToPhoto(face, QUALITY);
  if (!blob?.size) throw new Error('The developed picture could not be written');
  return { blob, width: tw, height: th };
}
