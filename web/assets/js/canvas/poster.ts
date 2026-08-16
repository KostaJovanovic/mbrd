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
 * Under this many bytes, a capture is treated as a frame with nothing in it.
 *
 * A flat rectangle compresses to almost nothing, so size is a decent test for
 * "the decoder handed us a blank". It is a *verdict on that seek point* and not
 * on the clip, which is the thing that used to be wrong here: one 2 KB capture
 * at 0.1s and the clip was written off, which threw away every video that opens
 * on a fade from black or from white, a slate, or a title card - and threw it
 * away identically at import, in the optimiser and in the idle backfill, since
 * all three come through this one function. Now it moves on to the next point
 * and only settles for a blank frame if the whole clip looks like one.
 *
 * Lower than the 2 KB it was, too. 2 KB at 640px is not "nothing in it" - a
 * genuinely dark night shot lands near it - and a poster that is nearly black is
 * still the picture the clip starts on.
 */
const BLANK_BYTES = 900;

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
    // requestVideoFrameCallback fires when a frame has actually been presented,
    // which 'seeked' does not promise - it says the seek finished, not that
    // there is anything on the element yet.
    await presented(v);
    const shot = await capture(v).catch(() => null);
    if (!shot) continue;
    if (shot.blob.size >= BLANK_BYTES) return shot;
    // Flat here. Hold on to it in case the whole clip is flat, and look further
    // in - see the note on BLANK_BYTES.
    held.shot ??= shot;
  }
  if (!held.shot) console.warn('[mbrd] poster: every frame came back empty');
  return held.shot;
}

/** One event, as a promise. */
function once(el: EventTarget, type: string): Promise<Event> {
  return new Promise(resolve => el.addEventListener(type, resolve, { once: true }));
}

/** A frame actually on the element, where the browser can say so. */
function presented(v: HTMLVideoElement): Promise<void> {
  return typeof v.requestVideoFrameCallback === 'function'
    ? new Promise<void>(resolve => v.requestVideoFrameCallback(() => resolve()))
    : Promise.resolve();
}

const wait = (ms: number) => new Promise<void>(resolve => { setTimeout(resolve, ms); });

/**
 * Draw whatever the element is showing into a capped WebP.
 *
 * Null means the drawing itself did not come off - no 2D context, or a browser
 * that answered with something other than WebP (the same trap the picture
 * shrinker guards: one that cannot write WebP hands back a PNG). *How much* is
 * in the frame is not judged here any more; that is grab()'s to decide across
 * the whole clip rather than one seek's to decide for it.
 */
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
  if (!out || out.type.toLowerCase() !== 'image/webp') return null;
  return { blob: out, w: v.videoWidth, h: v.videoHeight };
}
