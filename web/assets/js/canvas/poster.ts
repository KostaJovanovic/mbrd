// A clip's own first frame, grabbed in the browser.
//
// Lifted out of canvas/renderers.js, where it sat between the sizing helpers
// and the renderer map without belonging to either: nothing here knows what an
// item is, and the only caller is import/drop.js deciding what a video card
// should show before it has been played.
//
// Everything fails to "no poster" rather than to a broken card - a clip this
// browser cannot decode (H.265 from a phone is the usual one) is the normal
// case, not an error. optimize/media.js is the path that reaches for ffmpeg
// when it matters enough to be worth thirty megabytes.


/**
 * How wide a video's own first frame is kept.
 *
 * A poster is drawn full-bleed at card size, so it wants more than a cover's 600
 * corner-thumbnail ceiling and much less than the clip's own resolution - a 4K
 * phone video's first frame is a three-megabyte JPEG nobody needs to see a
 * still of. 640 covers a mobile card at two device pixels per point and a
 * desktop card at one, which is the whole job.
 */
const POSTER_SIDE = 640;

/** How long a frame grab may take before the clip is left without one. */
const POSTER_MS = 6000;

/**
 * A grabbed frame: the WebP itself, and the clip's *own* pixel size.
 *
 * The dimensions are the video's, not the blob's - the blob is capped at
 * POSTER_SIDE, while a caller sizing a card wants the aspect the clip really
 * has.
 */
export type VideoFrameShot = { blob: Blob; w: number; h: number };

/**
 * The first frame of a clip, as a WebP blob, or null.
 *
 * This exists because of what a video card looks like before it is played. On a
 * touch device the source is deliberately held back until the first tap - see
 * the video renderer, and the decoder ceiling that forces it - so a clip with
 * nothing to show is a black rectangle with a play button on it. The desktop
 * path gets a frame for free by loading metadata at `#t=0.1`; the mobile path
 * loads nothing at all, and so has to be *given* a picture at import.
 *
 * The browser's own decoder does the work, which is the point: the ffmpeg
 * poster path in optimize/media.js is thirty megabytes off a CDN and is only
 * reached for a clip this browser cannot open at all. A clip it *can* open
 * needs none of that - it needs a seek and a drawImage.
 *
 * Everything here degrades to null, and null is not a failure: it means the
 * card is exactly what it was before any of this existed. The refusals worth
 * naming are a decoder that will not seek without playback (older iOS), a clip
 * whose first frame is genuinely black, and a browser that will not write WebP.
 * The blank check is deliberately crude - a solid-colour frame compresses to
 * almost nothing - because storing a black rectangle as a picture of a black
 * rectangle is strictly worse than storing no picture.
 */
export function videoFrame(file: Blob): Promise<VideoFrameShot | null> {
  const url = URL.createObjectURL(file);
  const v = document.createElement('video');
  return new Promise<VideoFrameShot | null>(resolve => {
    let settled = false;
    const done = (value: VideoFrameShot | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      v.pause?.();
      v.removeAttribute('src');
      v.load?.();
      URL.revokeObjectURL(url);
      resolve(value);
    };
    const timer = setTimeout(() => done(null), POSTER_MS);

    // Muted and inline are not cosmetic: an unmuted video may not be allowed to
    // play at all without a gesture, and on iOS a video that has never played
    // draws as a transparent rectangle onto a canvas however far it has seeked.
    v.muted = true;
    v.playsInline = true;
    // 'metadata', not 'auto', and on a board of phone clips this is most of what
    // the grab costs. 'auto' asks the browser to buffer the *whole* file before
    // it is needed - a four-minute 4K clip is half a gigabyte read and held to
    // produce one frame a tenth of a second in, and a pass over twenty of them
    // was the optimiser sitting there for minutes. A seek to 0.1s needs the
    // header and the first keyframe, which is what 'metadata' plus the seek
    // below fetches. play() still pulls whatever the decoder wants past that.
    v.preload = 'metadata';
    v.addEventListener('error', () => done(null), { once: true });

    v.addEventListener('loadedmetadata', () => {
      if (!v.videoWidth) return done(null);
      // A hair past zero rather than zero. Plenty of clips open on a frame of
      // black - a fade-in, a slate - and the first tenth of a second is far
      // enough in to have a picture while still being "the start of the clip".
      const at = Number.isFinite(v.duration) && v.duration > 0
        ? Math.min(0.1, v.duration / 2)
        : 0.1;
      // Some decoders will not produce a frame for a video that has never run,
      // and answer a seek with the poster-frame nothing. Starting it and
      // stopping it immediately costs a few milliseconds and is what makes this
      // work on the devices the whole feature is for. Failure is ignored: where
      // play() is refused, the seek alone is usually enough.
      v.play().then(() => v.pause(), () => {}).finally(() => { v.currentTime = at; });
    }, { once: true });

    const grab = () => { capture(v).then(done, () => done(null)); };
    // requestVideoFrameCallback fires when a frame has actually been presented,
    // which 'seeked' does not promise - it says the seek finished, not that
    // there is anything on the element yet.
    if (typeof v.requestVideoFrameCallback === 'function') {
      v.addEventListener('seeked', () => v.requestVideoFrameCallback(grab), { once: true });
    } else {
      v.addEventListener('seeked', grab, { once: true });
    }

    v.src = url;
  });
}

/** Draw whatever the element is showing into a capped WebP. */
async function capture(v: HTMLVideoElement): Promise<VideoFrameShot | null> {
  const scale = Math.min(1, POSTER_SIDE / Math.max(v.videoWidth, v.videoHeight));
  const w = Math.max(1, Math.round(v.videoWidth * scale));
  const h = Math.max(1, Math.round(v.videoHeight * scale));
  const canvas = new OffscreenCanvas(w, h);
  const ctx = canvas.getContext('2d', { alpha: false });
  if (!ctx) return null;
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(v, 0, 0, w, h);
  const out = await canvas.convertToBlob({ type: 'image/webp', quality: 0.72 });
  // The same trap the picture shrinker guards - a browser that cannot write
  // WebP hands back a PNG - plus the blank frame described above. 2 KB is well
  // under any real photograph at this size and well over any flat colour.
  if (!out || out.type.toLowerCase() !== 'image/webp' || out.size < 2048) return null;
  return { blob: out, w: v.videoWidth, h: v.videoHeight };
}
