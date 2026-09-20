// The worker the vendored HEIC decoder runs in.
//
// A classic worker, like import/tiff-worker.js and optimize/media-worker.js:
// heic2any is a script that assigns itself to `self.heic2any`, which is what
// importScripts is for and what a module worker cannot do.
//
// Two reasons it is a worker rather than a call on the page, and the second is
// the load-bearing one. It is a second of straight-line JavaScript per
// photograph, which on the main thread is a board that stops moving. And it is
// libheif through Emscripten's embind, which builds its exported functions with
// `new Function` - so the page's own script-src, which carries no
// 'unsafe-eval', refuses it outright. web/_headers drops the policy for this
// one file and tests/csp.test.js holds that list to the workers the app really
// spawns.
//
// It speaks one message and holds no state at all:
//   { id, bytes }  ->  { id, blob } | { id, error }

// heic2any was written for a page and checks for both of these before it will
// run. `window` is this worker, and the only part of `document` it reaches for
// is a canvas to put the decoded picture on - which off the main thread is an
// OffscreenCanvas wearing an element canvas's toBlob().
self.window = self;
self.document = {
  createElement(tag) {
    if (tag !== 'canvas') return {};
    const canvas = new OffscreenCanvas(1, 1);
    canvas.toBlob = (done, type, quality) => {
      canvas.convertToBlob({ type, quality }).then(done, () => done(null));
    };
    return canvas;
  },
};

importScripts('../../vendor/heic2any/heic2any.min.js');

/** JPEG because every engine decodes it, and Safari's canvas cannot write WebP.
 *  The same number import/heif.ts writes its own output at. */
const QUALITY = 0.92;

self.onmessage = async (e) => {
  const { id, bytes } = e.data || {};
  try {
    // A sequence for a burst or a depth map; the first image is the picture.
    const out = await self.heic2any({
      blob: new Blob([bytes]), toType: 'image/jpeg', quality: QUALITY,
    });
    const blob = Array.isArray(out) ? out[0] : out;
    if (!blob || !blob.size) throw new Error('the decoder returned nothing');
    self.postMessage({ id, blob });
  } catch (err) {
    self.postMessage({ id, error: String((err && err.message) || err) });
  }
};
