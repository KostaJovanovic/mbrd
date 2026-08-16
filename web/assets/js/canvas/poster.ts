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

/**
 * How long a frame grab may take before the clip is left without one.
 *
 * Nine seconds rather than the six it was, because a grab is up to three seeks
 * now instead of one - see the point list in grab(). The whole of it is still
 * one budget: whatever has been captured when the clock runs out is what the
 * caller gets, so a slow clip yields the frame it managed rather than nothing.
 */
const POSTER_MS = 9000;

/**
 * How long a seek is given to put a frame on the element before it is read
 * anyway.
 *
 * The reason there is a number here at all is requestVideoFrameCallback, which
 * is the right thing to wait on and cannot be relied on to arrive: it fires when
 * a frame is *presented for composition*, and the element this module grabs from
 * is never in the document, so on Chrome it does not fire at all. Measured
 * rather than reasoned: a bench that recorded a clip, seeked it and waited on
 * the callback timed out at every attempt, on a detached element *and* on one
 * appended to the page, while a drawImage taken straight after `seeked` returned
 * the frame every time.
 *
 * It was the sole gate before the capture, which is why the whole feature
 * produced nothing: every grab sat until the cap above and answered null, at
 * import, in the optimiser and in the idle backfill alike. That is the "video
 * cards have no picture" bug, and it is older than the three-point walk below.
 *
 * So the callback is now a *shortcut* rather than a gate: whichever of it and
 * this clock comes first, the frame is read. `seeked` has already fired by then,
 * which is the condition that actually matters - a decoder that has finished
 * seeking draws through drawImage whether or not anything was composited.
 */
const FRAME_MS = 150;

/**
 * How much two sampled pixels may differ before a frame counts as having
 * something in it, and how many pixels are looked at.
 *
 * This replaces a test on the *encoded size* - under 2 KB was "blank" - which
 * was a guess wearing a number. A 320-wide frame of ordinary colour encodes to
 * 800 bytes, so the guess threw away real pictures; and it made the judgement at
 * one seek point, so a clip that opens on a fade from white, a slate or a title
 * card was written off entirely rather than looked at a second further in.
 *
 * The pixels answer the question the size was standing in for, and answer it
 * exactly. A flat frame is one where every sample is the same colour; anything
 * else is a picture, however dark or however small it compresses to.
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
 * A frame out of a clip, as a WebP blob, or null.
 *
 * This exists because of what a video card looks like before it is played. On a
 * touch device the source is deliberately held back until the first tap - see
 * the video renderer, and the decoder ceiling that forces it - so a clip with
 * nothing to show is an empty rectangle with a play button on it. The desktop
 * path gets a frame for free by loading metadata at `#t=0.1`; the mobile path
 * loads nothing at all, and so has to be *given* a picture at import.
 *
 * The browser's own decoder does the work, which is the point: the ffmpeg
 * poster path in optimize/media.js is thirty megabytes off a CDN and is only
 * reached for a clip this browser cannot open at all. A clip it *can* open
 * needs none of that - it needs a seek and a drawImage.
 *
 * ── Three points, not one ──
 *
 * It used to be a single seek to 0.1s whose capture was accepted or the clip was
 * written off. Films do not cooperate with that. An opening fade, a white slate,
 * a black leader, a title card over nothing - all of them are a flat frame a
 * tenth of a second in, all of them compress to under the blank floor, and every
 * one of them left a card with no picture on a clip the browser could decode
 * perfectly well. Worse, it was the *same* verdict everywhere: import, the
 * optimiser's repair pass and the idle backfill all call this, so "run Optimize"
 * did not fix what import had missed, which is exactly the complaint.
 *
 * So it walks a little way in - see POINTS - and keeps the first frame with
 * something in it. A clip that is flat at every point really is flat, and then
 * the flat frame is used anyway rather than nothing: a white rectangle the right
 * shape is still the clip, and the alternative on a phone is a card that shows
 * no picture at all.
 *
 * Everything here still degrades to null, and null is not a failure: it means
 * the card is exactly what it was before any of this existed. The refusals worth
 * naming are a decoder that will not seek without playback (older iOS), a codec
 * the browser cannot open at all (H.265 - the ffmpeg path is for that), and a
 * browser that will not write WebP. Each is logged by name, because a board
 * where every clip lands here should be answerable from a console rather than
 * from a guess.
 */
export async function videoFrame(file: Blob): Promise<VideoFrameShot | null> {
  const url = URL.createObjectURL(file);
  const v = document.createElement('video');
  // Muted and inline are not cosmetic: an unmuted video may not be allowed to
  // play at all without a gesture, and on iOS a video that has never played
  // draws as a transparent rectangle onto a canvas however far it has seeked.
  v.muted = true;
  v.playsInline = true;
  // 'metadata', not 'auto', and on a board of phone clips this is most of what
  // the grab costs. 'auto' asks the browser to buffer the *whole* file before
  // it is needed - a four-minute 4K clip is half a gigabyte read and held to
  // produce one frame a tenth of a second in, and a pass over twenty of them
  // was the optimiser sitting there for minutes. A seek needs the header and a
  // keyframe, which is what 'metadata' plus the seek below fetches. play() still
  // pulls whatever the decoder wants past that.
  v.preload = 'metadata';

  // The best flat frame seen, kept in this scope rather than inside grab() so
  // that a run cut off by the clock still answers with whatever it managed.
  const held: { shot: VideoFrameShot | null } = { shot: null };
  try {
    return await Promise.race([
      grab(v, url, held),
      wait(POSTER_MS).then(() => {
        console.warn('[mbrd] poster: gave up waiting for a frame');
        return held.shot;
      }),
    ]);
  } catch (err) {
    console.warn('[mbrd] poster: no frame', err);
    return held.shot;
  } finally {
    v.pause?.();
    v.removeAttribute('src');
    v.load?.();
    URL.revokeObjectURL(url);
  }
}

/**
 * Where to look for a frame, in order, for a clip `dur` seconds long.
 *
 * A hair past zero first, because that is the frame anybody would call the
 * clip's own and it is what the desktop card already parks on. Then a second in,
 * which clears nearly every fade and slate. Then a tenth of the way through,
 * which clears a long title sequence and is still recognisably the beginning.
 *
 * Bounded by the clip and de-duplicated, so a two-second cut is one or two seeks
 * rather than three at the same place, and a clip with no duration to speak of
 * (a stream, a file whose header lies) gets the single 0.1 it always got.
 */
function points(dur: number): number[] {
  if (!Number.isFinite(dur) || dur <= 0) return [0.1];
  const wanted = [Math.min(0.1, dur / 2), 1, dur * 0.1].filter(t => t < dur);
  return [...new Set(wanted.map(t => Math.round(t * 100) / 100))];
}

/** Open the clip, walk the points, and answer with the first frame worth having. */
async function grab(
  v: HTMLVideoElement,
  url: string,
  held: { shot: VideoFrameShot | null },
): Promise<VideoFrameShot | null> {
  const opened = once(v, 'loadedmetadata');
  const failed = once(v, 'error').then(() => { throw new Error('this browser cannot decode it'); });
  // Handled here as well as raced below, and it is not belt and braces: the
  // teardown in videoFrame() drops the source and calls load(), which fires
  // `error` on an element with no src. Once the races are over that rejection
  // has nobody listening, and an unhandled rejection in the console is exactly
  // the kind of noise this module is supposed to be quiet about.
  failed.catch(() => {});
  v.src = url;
  await Promise.race([opened, failed]);
  if (!v.videoWidth) throw new Error('no picture in it');

  // Some decoders will not produce a frame for a video that has never run, and
  // answer a seek with nothing at all. Starting it and stopping it immediately
  // costs a few milliseconds and is what makes this work on the devices the
  // whole feature is for. Failure is ignored: where play() is refused, the seek
  // alone is usually enough.
  await v.play().then(() => v.pause(), () => {});

  for (const at of points(v.duration)) {
    const seeked = once(v, 'seeked');
    v.currentTime = at;
    await Promise.race([seeked, failed]);
    await presented(v);
    const took = await capture(v).catch(() => null);
    if (!took) continue;
    if (!took.flat) return took.shot;
    // Nothing in this frame. Hold on to it in case the whole clip is like that,
    // and look further in - see the note on FLAT_SPREAD.
    held.shot ??= took.shot;
  }
  if (!held.shot) console.warn('[mbrd] poster: every seek came back with nothing');
  return held.shot;
}

/** One event, as a promise. */
function once(el: EventTarget, type: string): Promise<Event> {
  return new Promise(resolve => el.addEventListener(type, resolve, { once: true }));
}

/**
 * A frame on the element - either because the browser said so, or because long
 * enough has passed to read one anyway. See FRAME_MS, which is where the whole
 * argument for the race is written.
 */
function presented(v: HTMLVideoElement): Promise<void> {
  const clock = wait(FRAME_MS);
  return typeof v.requestVideoFrameCallback === 'function'
    ? Promise.race([new Promise<void>(resolve => v.requestVideoFrameCallback(() => resolve())), clock])
    : clock;
}

const wait = (ms: number) => new Promise<void>(resolve => { setTimeout(resolve, ms); });

/**
 * Draw whatever the element is showing into a capped picture, and say whether
 * there was anything in it.
 *
 * Null means the drawing itself did not come off - no 2D context, or nothing
 * this engine will encode at all. `flat` is the other answer, and it is a
 * report rather than a refusal: whether to keep a frame with nothing in it is a
 * question about the whole clip, so grab() decides it across every seek point
 * and this only says what it saw at one.
 */
async function capture(
  v: HTMLVideoElement,
): Promise<{ shot: VideoFrameShot, flat: boolean } | null> {
  const scale = Math.min(1, POSTER_SIDE / Math.max(v.videoWidth, v.videoHeight));
  const w = Math.max(1, Math.round(v.videoWidth * scale));
  const h = Math.max(1, Math.round(v.videoHeight * scale));
  const canvas = new OffscreenCanvas(w, h);
  const ctx = canvas.getContext('2d', { alpha: false });
  if (!ctx) return null;
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(v, 0, 0, w, h);
  const flat = looksFlat(ctx, w, h);
  const out = await encodeFrame(canvas);
  if (!out) return null;
  return { shot: { blob: out, w: v.videoWidth, h: v.videoHeight }, flat };
}

/**
 * Whether every sampled pixel is the same colour, give or take FLAT_SPREAD.
 *
 * Which is what "the decoder handed us nothing" looks like from here: a seek
 * that produced no frame draws as one flat rectangle, and so does a fade, a
 * slate and a black leader - all of which are things to seek past rather than
 * things to keep, and none of which can be told apart by how many bytes they
 * compress to.
 *
 * Sampled on a stride rather than pixel by pixel: a couple of hundred readings
 * spread across the frame settles the question, and this runs up to three times
 * per clip on a board that may hold fifty.
 *
 * True on a throw, which is the safe way round: getImageData on a tainted
 * canvas raises, and a frame this cannot inspect is one to look past rather than
 * one to keep. If every point raises, grab() keeps the first anyway.
 */
function looksFlat(ctx: OffscreenCanvasRenderingContext2D, w: number, h: number): boolean {
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
 * The frame as bytes. WebP where the engine writes it, JPEG where it does not.
 *
 * This used to ask for WebP and return null on anything else, which read as
 * "this browser cannot give up a frame" - and null here is not a soft answer.
 * capture() is the only thing in the app that cuts a poster, so a null means no
 * poster at import, none from the optimiser, and none from the idle backfill,
 * which then marks the clip `refused` for the session having decoded it to
 * produce nothing.
 *
 * **No version of Safari encodes WebP from a canvas** - not on iOS, not on the
 * desktop, not in the 27 beta - and the specification says an engine that
 * cannot write the type asked for hands back a PNG without complaint. So the
 * refusal fired for every clip on every Safari, and it compounded with the one
 * piece of this file that is exactly right: on a touch device the renderer
 * parks a clip's `src` so a zoomed-out board stays inside iOS's decoder ration,
 * and shows the poster meanwhile. With no poster there is nothing to show, and
 * every clip on an iPhone was a play button over black until it was tapped.
 *
 * JPEG unconditionally rather than the conditional retry canvas/display.js
 * makes, and the context above is why it is allowed to be that simple: this
 * canvas is built `alpha: false` and holds a frame of video. There is no
 * transparency here to flatten, so there is no question to ask about the
 * source.
 */
async function encodeFrame(canvas: OffscreenCanvas): Promise<Blob | null> {
  const webp = await canvas.convertToBlob({ type: 'image/webp', quality: 0.72 });
  if (!webp) return null;
  if (webp.type.toLowerCase() === 'image/webp') return webp;
  // Falls back to `webp` - a PNG under a wrong name - if this engine writes
  // neither, which no engine does: PNG is the one format a canvas must encode.
  // A large poster beats no poster, and the size guard this file does not have
  // is the size guard it does not need, since nothing here replaces a file.
  try {
    const jpeg = await canvas.convertToBlob({ type: 'image/jpeg', quality: 0.72 });
    return jpeg?.type.toLowerCase() === 'image/jpeg' ? jpeg : webp;
  } catch {
    return webp;
  }
}
