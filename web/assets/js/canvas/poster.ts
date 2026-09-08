// A clip's own first frame, grabbed in the browser.
//
// Nothing here knows what an item is, and the only caller is import/drop.ts,
// deciding what a video card should show before it has been played.
//
// Everything fails to "no poster" rather than to a broken card - a clip this
// browser cannot decode (H.265 from a phone is the usual one) is the normal
// case, not an error. optimize/media.ts reaches for ffmpeg when it matters
// enough to be worth thirty megabytes.

import { surface, surfaceToBlob, canvasReads, type Surface } from './surface.ts';
// The console lines below are invisible on a phone, which is where a clip most
// often arrives without a frame. See noPreview().
import { noPreview, canvasBlocked } from '../notify.ts';
import { glFrame } from './gl-frame.ts';

/**
 * How wide a video's own first frame is kept.
 *
 * A poster is drawn full-bleed at card size, so it wants more than a cover's 600
 * corner-thumbnail ceiling and much less than the clip's own resolution - a 4K
 * first frame is a three-megabyte JPEG nobody needs. 640 covers a mobile card at
 * two device pixels per point and a desktop card at one.
 */
const POSTER_SIDE = 640;

/**
 * How long a frame grab may take before the clip is left without one.
 *
 * Nine seconds rather than six, because a grab is up to three seeks - see the
 * point list in grab(). One budget for all three, and a hard stop rather than a
 * settlement: the race in videoFrame() answers null the moment this expires, and
 * a capture still in flight is dropped. There is no partial answer to look for -
 * a frame arriving after nine seconds belongs to a clip the import has moved
 * past.
 */
const POSTER_MS = 9000;

/**
 * How long a seek is given to put a frame on the element before it is read
 * anyway.
 *
 * The number exists because requestVideoFrameCallback cannot be relied on to
 * arrive: it fires when a frame is *presented for composition*, and on Chrome it
 * does not fire at all here. Measured rather than reasoned - a bench that
 * recorded a clip, seeked it and waited on the callback timed out every attempt,
 * detached *and* appended to the page, while a drawImage straight after `seeked`
 * returned the frame every time.
 *
 * As the sole gate it produced nothing: every grab sat until the cap above and
 * answered null, at import, in the optimiser and in the idle backfill alike -
 * the "video cards have no picture" bug. So the callback is a *shortcut*, not a
 * gate: whichever of it and this clock comes first, the frame is read. `seeked`
 * has fired by then, which is the condition that matters - a decoder that has
 * finished seeking draws through drawImage whether or not anything was
 * composited.
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
 * A frame out of a clip, as a WebP blob, or null.
 *
 * On a touch device the source is held back until the first tap - see the video
 * renderer, and the decoder ceiling that forces it - so a clip with nothing to
 * show is an empty rectangle with a play button on it. The desktop path gets a
 * frame for free by loading metadata at `#t=0.1`. The mobile path loads nothing,
 * so it has to be *given* a picture at import.
 *
 * The browser's own decoder does the work: the ffmpeg poster path in
 * optimize/media.ts is thirty megabytes off a CDN and is only reached for a clip
 * this browser cannot open at all. A clip it *can* open needs a seek and a
 * drawImage.
 *
 * ── Three points, not one ──
 *
 * A single seek to 0.1s left a card with no picture on clips the browser decodes
 * perfectly well: an opening fade, a white slate, a black leader or a title card
 * is a flat frame a tenth of a second in. And the verdict was the *same*
 * everywhere - import, the optimiser's repair pass and the idle backfill all
 * call this, so "run Optimize" did not fix what import had missed.
 *
 * So it walks a little way in - see points() - and keeps the first frame with
 * something in it.
 *
 * A clip flat at *every* point gets no poster. A frame with nothing in it is
 * what a genuine fade looks like and also what a decoder that produced nothing
 * looks like, and the pixels cannot tell them apart. Storing one settles that
 * permanently: `meta.cover` would name real bytes, every repair pass would skip
 * the card, and a board of black rectangles could never be fixed. Not storing it
 * costs a genuinely flat clip its poster and keeps the question open.
 *
 * Null is not a failure: the card is exactly what it was before any of this
 * existed. The refusals worth naming are a decoder that will not seek without
 * playback (older iOS), a codec the browser cannot open at all (H.265 - the
 * ffmpeg path is for that), and a browser that will not write WebP. Each is
 * logged by name, so a board where every clip lands here is answerable from a
 * console rather than from a guess.
 */
export async function videoFrame(file: Blob): Promise<VideoFrameShot | null> {
  // **Asked and answered.** Once one clip has proved this browser draws video
  // onto a canvas as nothing, every clip after it would spend three seeks, a
  // second of playback and up to nine seconds of budget proving it again - on a
  // phone, during an import, while the fallback downloads thirty megabytes in
  // the background. Silent, because the first toast said it. See blankBrowser.
  if (blankBrowser) return null;
  const url = URL.createObjectURL(file);
  const v = document.createElement('video');
  // Muted and inline are not cosmetic: an unmuted video may not be allowed to
  // play at all without a gesture, and on iOS a video that has never played
  // draws as a transparent rectangle onto a canvas however far it has seeked.
  v.muted = true;
  v.playsInline = true;
  // And it has to be *in the page*, and drawn while it is there.
  //
  // An element outside the document is one no engine has reason to decode for.
  // It will load metadata, report videoWidth, accept a currentTime and fire
  // `seeked` - every signal this function waits on - and still have no pixels to
  // give. drawImage then paints nothing onto an `alpha: false` canvas, a flat
  // black rectangle, at every seek point. Black is also what gets *stored*,
  // because on a phone the card's own source is parked (see rationsDecoders()
  // and the video renderer) so the poster is the only picture there will be.
  //
  // Two pixels, all but transparent, out of the flow and refusing the pointer.
  // Each part is chosen against a way of being ignored:
  //
  //   not `display: none`, not `visibility: hidden`  both say "nothing to show
  //     here", which is the state being escaped.
  //   `opacity: 0.01` rather than 0  Chrome may class a fully transparent video
  //     as hidden and suspend the decoder, on Android especially. A hundredth is
  //     not visible on any screen and is not zero.
  //   `position: fixed` at the origin  so it intersects the viewport. Decoding
  //     is skipped for what is scrolled far out of sight.
  //
  // 160x90 was tried, on a guess that Gecko wanted something card-sized before
  // allocating a frame. It would not have helped: the Android fault is a
  // SurfaceTexture with one consumer, the compositor, so a *more* visible
  // element is the wrong direction. The fix is in canvas/gl-frame.ts.
  //
  // Written through .style rather than as an attribute, which is what the CSP
  // requires of every inline style in this app - see the note in web/_headers.
  v.style.position = 'fixed';
  v.style.left = '0';
  v.style.top = '0';
  v.style.width = '2px';
  v.style.height = '2px';
  v.style.opacity = '0.01';
  v.style.pointerEvents = 'none';
  v.setAttribute('aria-hidden', 'true');
  document.body?.append(v);
  // 'metadata', not 'auto', and on a board of phone clips this is most of what
  // the grab costs. 'auto' buffers the *whole* file - a four-minute 4K clip is
  // half a gigabyte read and held to produce one frame a tenth of a second in,
  // and twenty of them was the optimiser sitting there for minutes. A seek needs
  // the header and a keyframe, which 'metadata' plus the seek below fetches.
  // play() still pulls whatever the decoder wants past that.
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

/**
 * Where to look for a frame, in order, for a clip `dur` seconds long.
 *
 * A hair past zero first - the frame anybody would call the clip's own, and what
 * the desktop card parks on. Then a second in, which clears nearly every fade
 * and slate. Then a tenth of the way through, which clears a long title sequence
 * and is still recognisably the beginning.
 *
 * Bounded by the clip and de-duplicated, so a two-second cut is one or two seeks
 * rather than three at the same place, and a clip with no usable duration (a
 * stream, a file whose header lies) gets the single 0.1.
 */
function points(dur: number): number[] {
  if (!Number.isFinite(dur) || dur <= 0) return [0.1];
  const wanted = [Math.min(0.1, dur / 2), 1, dur * 0.1].filter(t => t < dur);
  return [...new Set(wanted.map(t => Math.round(t * 100) / 100))];
}

/** Open the clip, walk the points, and answer with the first frame worth having. */
async function grab(v: HTMLVideoElement, url: string): Promise<VideoFrameShot | null> {
  const opened = once(v, 'loadedmetadata');
  const failed = once(v, 'error').then(() => { throw new Error('this browser cannot decode it'); });
  // Handled here as well as raced below, and it is not belt and braces: the
  // teardown in videoFrame() drops the source and calls load(), which fires
  // `error` on an element with no src. Once the races are over that rejection
  // has nobody listening, and an unhandled rejection is the noise this module is
  // supposed to be quiet about.
  failed.catch(() => {});
  v.src = url;
  await Promise.race([opened, failed]);
  if (!v.videoWidth) throw new Error('no picture in it');

  // Some decoders will not produce a frame for a video that has never run, and
  // answer a seek with nothing. Starting and stopping it costs a few
  // milliseconds and is what makes this work on the devices the feature is for.
  // Failure is ignored: where play() is refused, the seek alone is usually
  // enough.
  await v.play().then(() => v.pause(), () => {});

  // The last reason a capture produced nothing, kept for the line at the foot of
  // this function. Empty means every capture came back with a frame in it and
  // every frame was flat, which is a different fact about a different thing.
  let refused = '';
  for (const at of points(v.duration)) {
    const seeked = once(v, 'seeked');
    v.currentTime = at;
    await Promise.race([seeked, failed]);
    // Read twice before giving up on a point. The second read is for the engines
    // that cannot say when a frame has arrived.
    //
    // The first look is free where the element can answer for itself: presented()
    // returns at once on a readyState that already has a frame at the current
    // position, the exact question drawImage is about to ask. Where it cannot -
    // most of the time here, since a seek that has just fired `seeked` is still
    // catching up - the wait is a guess at a decode, and a guess that is short on
    // a slow phone reads *before* the seek has drawn. That is a flat capture,
    // which walks on and eventually answers null for a clip that was fine.
    //
    // So the second look always takes the clock, however ready the element
    // claimed to be. It costs nothing when the first was good, because a good
    // first read returns from inside the loop.
    for (let look = 0; look < 2; look++) {
      await presented(v, look);
      const took = await capture(v).catch(err => {
        // Not silent, and the one place in the pipeline where an error has
        // anything to say: above it is a race that expires, below it a null. A
        // throw here is an encoder or a canvas refusing - a fault to fix rather
        // than a clip to walk past.
        console.warn(`[mbrd] poster: capture threw at ${at}s`, err);
        return { shot: null, flat: false, why: 'the capture threw: ' + why(err) };
      });
      if (took.shot && !took.flat) return took.shot;
      if (took.why) refused = took.why;
    }
    // Nothing at this point. Look further in - see the note on FLAT_SPREAD, and
    // the head of this function for why a frame with nothing in it is never kept
    // as a last resort.
  }
  // Nothing at any seek point. One more attempt, and not a repetition: see
  // running(), the only state in which the Android path can hand a frame over.
  if (!refused) {
    const live = await running(v).catch(() => null);
    if (live) return live;
  }
  // **What this browser has just proved about itself**, a bigger fact than what
  // it said about this clip. Every capture came back with an encoded frame, the
  // canvas reads back, and every pixel was the same colour - through both doors,
  // 2D and WebGL, on three seek points and again while the clip was running.
  // That is a decoder this app cannot reach, and no further clip on this board
  // goes differently.
  //
  // Recorded rather than acted on here, because what to do about it costs thirty
  // megabytes and belongs to whoever is importing. See videoDrawsBlank() and
  // posterFor() in import/drop.ts.
  //
  // When it is wrong - a clip that genuinely opens on black - it costs one trip
  // the long way round to a picture that is also black, which posterFor() then
  // declines to store.
  if (!refused && canvasReads()) blankBrowser = true;
  if (blankBrowser) {
    console.warn('[mbrd] poster: this browser draws video onto a canvas as nothing');
    noPreview('clip', 'this browser will not draw a clip onto a canvas - trying the video tools instead');
    return null;
  }
  // Two endings, told apart rather than sharing one "every frame came back
  // empty" - which pointed a reader at the one thing in the chain that worked.
  //
  // A refusal is a canvas or an encoder saying no, in its own words. Anything
  // else reaching here has flat frames *and* a canvas that would not be read,
  // because flat frames on a readable canvas returned above.
  console.warn('[mbrd] poster: no frame kept', refused || 'the pixels could not be read');
  if (refused) noPreview('clip', refused);
  else canvasBlocked();
  return null;
}

/**
 * A frame off the clip while it is *running*, which on Android is the only
 * moment there is one to take.
 *
 * The walk above parks the element on a seek, which is cheap and works
 * everywhere else. On Firefox for Android it cannot work: frames decode into a
 * SurfaceTexture, and the WebGL blit that gets round the 2D bug
 * (canvas/gl-frame.ts) copies whatever is *currently* in that texture. A paused
 * element that has never been composited has nothing in it, and the upload is
 * the "Resource has no data (yet?). Uploading zeros" that A-Frame, PixiJS and
 * Hubs all hit - which arrives here as one more flat frame.
 *
 * Playing it puts frames in the texture. Eight looks, each waiting on
 * requestVideoFrameCallback or a frame interval, whichever comes first, and
 * capture() tries both doors on each so the WebGL one gets a live texture.
 *
 * Reached only after every seek point came back flat, so a browser that works
 * never plays anything. Muted from birth (see videoFrame), which is what allows
 * play() without a gesture - where it is refused this answers null.
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
    // videoFrame's teardown drops the source, and an element left running while
    // its src is pulled is a decoder held open on a phone with a ration of them.
    v.pause();
  }
}

/**
 * Whether this browser has been shown to draw video onto a canvas as nothing.
 *
 * A fact about the engine, not about a file, and only ever set by the evidence
 * in grab(): every seek point flat, through both doors, on a canvas that reads
 * back. False until something has failed that way - nothing here guesses from a
 * user-agent string.
 *
 * It drives one decision in import/drop.ts: whether a clip the browser opened
 * perfectly well should still go the thirty-megabyte way round. Normally no -
 * that route exists for a format nothing here can read. But on an engine that
 * will not hand over a frame it is the only route, and the alternative is a
 * board of black rectangles on a phone where the card's own source is parked
 * until it is tapped.
 *
 * Sticky for the session and never unset. One clip proving it is enough, and the
 * next fifty should not each pay three seeks and nine seconds of budget to prove
 * it again - see the early return in videoFrame().
 */
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
 * A frame on the element - either because the browser said so, or because long
 * enough has passed to read one anyway. See FRAME_MS, which is where the whole
 * argument for the race is written.
 *
 * `look` is which of grab()'s two reads this is, and it lives here because it
 * decides whether the readyState shortcut applies. HAVE_CURRENT_DATA means there
 * is a frame at the current position, precisely what drawImage needs, so the
 * first look takes it at face value - a ready decoder read 150ms sooner is 150ms
 * off every clip on the board. The second look does not: the element said the
 * same thing before the read that came back flat, so believing it again would
 * collapse the two looks into one and throw away the only mitigation here.
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
 * Draw whatever the element is showing into a capped picture, and say whether
 * there was anything in it.
 *
 * No shot means the drawing did not come off, and `why` says which of the two -
 * no canvas at all, or nothing this engine will encode. Those two failures are a
 * browser's and the third, an empty clip, is a film's. A bare null reported the
 * wrong one and cost somebody an evening at the wrong end of it.
 *
 * `flat` is a report rather than a refusal: whether to keep a frame with nothing
 * in it is a question about the whole clip, so grab() decides it across every
 * seek point and this only says what it saw at one.
 */
async function capture(
  v: HTMLVideoElement,
): Promise<{ shot: VideoFrameShot | null, flat: boolean, why: string }> {
  const scale = Math.min(1, POSTER_SIDE / Math.max(v.videoWidth, v.videoHeight));
  const w = Math.max(1, Math.round(v.videoWidth * scale));
  const h = Math.max(1, Math.round(v.videoHeight * scale));
  // Through canvas/surface.ts, which falls back to an ordinary <canvas> where
  // OffscreenCanvas is absent - Safari before 16.4. Without it this returned
  // null for every clip on those engines, indistinguishable from the "no poster"
  // an undecodable codec gets.
  const face = surface(w, h, { alpha: false });
  if (!face) return { shot: null, flat: false, why: 'this browser would not give a canvas to draw the frame on' };
  face.ctx.drawImage(v, 0, 0, w, h);
  let flat = looksFlat(face.ctx, w, h);
  // **On Firefox for Android that drawing is blank, and WebGL is the way round
  // it.** Mozilla bug 1526207, open since 2019: Gecko decodes video on Android
  // into a SurfaceTexture, which has one GL consumer, and the compositor is
  // already it - so `drawImage(video)` silently leaves the canvas as it was.
  // `texImage2D` takes the path Gecko does implement (bug 1655101, Firefox 123)
  // and hands back a canvas that draws normally. See canvas/gl-frame.ts.
  //
  // Reached only when the ordinary path came back flat, so every engine that
  // works pays nothing. If both are blank the first drawing stands - the case
  // where the clip really does open on a fade.
  if (flat) {
    const gl = glFrame(v, w, h);
    if (gl) {
      face.ctx.drawImage(gl, 0, 0, w, h);
      flat = looksFlat(face.ctx, w, h);
    }
  }
  const out = await encodeFrame(face);
  if (!out) return { shot: null, flat, why: 'the frame drew and this browser would not encode it' };
  return { shot: { blob: out, w: v.videoWidth, h: v.videoHeight }, flat, why: '' };
}

/**
 * Whether every sampled pixel is the same colour, give or take FLAT_SPREAD.
 *
 * Which is what "the decoder handed us nothing" looks like from here: a seek
 * that produced no frame draws as one flat rectangle, and so do a fade, a slate
 * and a black leader - all things to seek past, and none of them tellable apart
 * by how many bytes they compress to.
 *
 * Sampled on a stride rather than pixel by pixel: a couple of hundred readings
 * settle the question, and this runs up to three times per clip on a board that
 * may hold fifty.
 *
 * **False, not true, where this browser will not hand its pixels back.** A frame
 * that cannot be *inspected* is not a frame that is empty, and answering "flat"
 * would discard a good frame on a browser that merely refused to be read. See
 * canvasReads(). Where reading really is blocked the cost is the seek past a
 * black leader - the first frame is kept whatever is in it, which beats no still
 * at all.
 *
 * A throw is still treated as flat: the tainted-canvas case really is a frame
 * nothing can be done with.
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
 * The frame a `<video>` that is *already on the board* is showing this instant.
 *
 * videoFrame() above is the import path and opens a clip of its own to do it -
 * it takes a Blob, mints an element, seeks it, walks three points looking for a
 * frame with something in it. None of that applies here. The element has been
 * decoding in front of somebody for the last minute and is parked on the frame
 * they stopped it at, so the whole job is capture(): one drawImage off a
 * decoder that is already where it is wanted.
 *
 * Which is also why the flat test is *reported* and not obeyed. grab() seeks
 * past a flat frame because it is choosing one on the clip's behalf; this is
 * given one, by a person looking at it, and a still of a fade to black is a
 * still of a fade to black. The caller may want to say so - see keepFrame() in
 * commands/item-meta.ts, which does - but nothing here refuses it.
 *
 * Null where there is nothing to read, and the case that matters is a *parked*
 * clip: on iOS the renderer holds a card's `src` back until the first tap (see
 * rationsDecoders in canvas/renderers.ts), so its element has no dimensions and
 * no frame, and what the card is showing is its poster rather than any frame at
 * all. A caller wanting "what is on that card" has to answer that one from
 * `meta.cover`, which is the picture actually on screen.
 */
export async function frameOnScreen(v: HTMLVideoElement): Promise<VideoFrameShot | null> {
  if (!v.videoWidth || !v.videoHeight) return null;
  if (v.readyState < v.HAVE_CURRENT_DATA) return null;
  return (await capture(v)).shot;
}

/**
 * Whether a picture already on a card has nothing in it.
 *
 * The repair for what the bug above left behind. A build that could not decode
 * a frame still wrote one - a black rectangle, cut and stored as the clip's
 * poster - and a stored poster is the strongest thing there is here: `meta.cover`
 * names real bytes, so every pass that looks for clips needing a picture skips
 * that card forever. The board cannot heal, and on a phone, where the card's own
 * source is parked and the poster is the only picture, the clip is black for
 * good.
 *
 * So the two repair passes ask this of a cover they are about to accept, and
 * treat a flat one as no cover at all - see wantsPoster() in optimize/backfill.ts
 * and the filter in backfillPosters(). It is the same reading looksFlat() makes
 * of a fresh capture, applied to bytes rather than to an element, which is what
 * keeps one definition of "nothing in it" for both.
 *
 * A decode per cover, so neither caller does it in bulk: the trickle asks about
 * one clip at a time when it has nothing else to do, and the optimiser is a
 * modal act that has already been given permission to spend a minute.
 *
 * False on anything it cannot read. A picture that will not decode is a
 * different fault with a different repair, and guessing here would re-cut
 * posters for a board whose bytes are simply missing.
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
 * JPEG unconditionally rather than the conditional retry canvas/display.ts
 * makes, and the context above is why it is allowed to be that simple: this
 * canvas is built `alpha: false` and holds a frame of video. There is no
 * transparency here to flatten, so there is no question to ask about the
 * source.
 */
async function encodeFrame(face: Surface): Promise<Blob | null> {
  const webp = await surfaceToBlob(face, 'image/webp', 0.72);
  if (!webp) return null;
  if (webp.type.toLowerCase() === 'image/webp') return webp;
  // Falls back to `webp` - a PNG under a wrong name - if this engine writes
  // neither, which no engine does: PNG is the one format a canvas must encode.
  // A large poster beats no poster, and the size guard this file does not have
  // is the size guard it does not need, since nothing here replaces a file.
  try {
    const jpeg = await surfaceToBlob(face, 'image/jpeg', 0.72);
    return jpeg?.type.toLowerCase() === 'image/jpeg' ? jpeg : webp;
  } catch {
    return webp;
  }
}
