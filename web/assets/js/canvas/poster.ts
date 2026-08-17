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

import { surface, surfaceToBlob, canvasReads, type Surface } from './surface.ts';
// The console lines below are invisible on a phone, which is where a clip most
// often arrives without a frame. See noPreview().
import { noPreview, canvasBlocked } from '../notify.ts';

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
 * now instead of one - see the point list in grab(). The whole of it is one
 * budget for all three, and it is a hard stop rather than a settlement: the race
 * in videoFrame() answers null the moment this expires, and a capture still in
 * flight is dropped. That is the right way round - a frame that took longer than
 * nine seconds to arrive belongs to a clip the import has already moved past -
 * but it is worth saying plainly, because the comment here used to claim the
 * opposite and somebody reading it would look for a partial answer that is not
 * there.
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
 * So it walks a little way in - see points() - and keeps the first frame with
 * something in it.
 *
 * A clip that is flat at *every* point gets no poster, and that is deliberate
 * rather than defeatist. A frame with nothing in it is what a genuine fade looks
 * like and it is also what a decoder that produced nothing looks like, and the
 * two cannot be told apart from the pixels. Storing one settles the question the
 * wrong way and settles it permanently: `meta.cover` would then name real bytes,
 * every repair pass would see a clip with a picture and skip it, and a board of
 * black rectangles would be a board nothing could ever fix. Not storing it costs
 * a genuinely flat clip its poster - a card that looks exactly like the flat
 * frame it would have been given - and keeps the question open.
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
  // And it has to be *in the page*, and drawn while it is there.
  //
  // An element outside the document is one no engine has any reason to decode
  // for, and both of the ones that matter act on that. It will load metadata,
  // report videoWidth, accept a currentTime and fire `seeked` - every signal
  // this function waits on - and still have no pixels to give. drawImage then
  // paints nothing onto an `alpha: false` canvas, which is a flat black
  // rectangle, at every seek point. That is a phone's video card: black, and
  // black is also what gets *stored*, because the card's own source is parked on
  // a phone (see rationsDecoders() and the video renderer) so the poster is the
  // only picture there will ever be.
  //
  // A card-sized rectangle, all but transparent, out of the flow and refusing
  // the pointer. Every part of that is chosen against a way of being ignored:
  //
  //   not `display: none`, not `visibility: hidden`  both say "nothing to show
  //     here", which is the state being escaped rather than a way out of it.
  //   `opacity: 0.01` rather than 0  a fully transparent video is one Chrome may
  //     class as hidden and suspend the decoder for, on Android especially. A
  //     hundredth is not visible on any screen and is not zero.
  //   `position: fixed` at the origin  so it intersects the viewport. Decoding
  //     is skipped for what is scrolled far out of sight.
  //   **160x90 rather than the 2x2 it was**  and this one is a guess, said
  //     plainly because it cannot be checked from here. The same clip on the
  //     same phone gives Samsung Internet a frame and Firefox a flat rectangle,
  //     so what differs is Gecko: it decodes into a surface the compositor owns,
  //     and a two-pixel element is the least likely thing in the world to get
  //     one allocated for it. A card-sized element is an ordinary thing for a
  //     compositor to be asked about. It costs nothing if it changes nothing -
  //     at a hundredth of an opacity neither size is visible - and if it does
  //     work it saves every Firefox user a thirty-megabyte download.
  //
  // Written through .style rather than as an attribute, which is what the CSP
  // requires of every inline style in this app - see the note in web/_headers.
  v.style.position = 'fixed';
  v.style.left = '0';
  v.style.top = '0';
  v.style.width = '160px';
  v.style.height = '90px';
  v.style.opacity = '0.01';
  v.style.pointerEvents = 'none';
  v.setAttribute('aria-hidden', 'true');
  document.body?.append(v);
  // 'metadata', not 'auto', and on a board of phone clips this is most of what
  // the grab costs. 'auto' asks the browser to buffer the *whole* file before
  // it is needed - a four-minute 4K clip is half a gigabyte read and held to
  // produce one frame a tenth of a second in, and a pass over twenty of them
  // was the optimiser sitting there for minutes. A seek needs the header and a
  // keyframe, which is what 'metadata' plus the seek below fetches. play() still
  // pulls whatever the decoder wants past that.
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
async function grab(v: HTMLVideoElement, url: string): Promise<VideoFrameShot | null> {
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

  // The last reason a capture produced nothing, kept for the line at the foot of
  // this function. Empty means every capture came back with a frame in it and
  // every frame was flat, which is a different fact about a different thing.
  let refused = '';
  for (const at of points(v.duration)) {
    const seeked = once(v, 'seeked');
    v.currentTime = at;
    await Promise.race([seeked, failed]);
    // Read twice before giving up on a point, and the second read is for the
    // engines that cannot say when a frame has arrived.
    //
    // The first look is free where the element can answer for itself: presented()
    // returns at once on a readyState that already has a frame at the current
    // position, which is the exact question drawImage is about to ask. Where it
    // cannot - and that is most of the time here, because a seek that has only
    // just fired `seeked` is still catching up - the wait is a guess at how long
    // a decode takes, and a guess that is short on a slow phone reads *before*
    // the seek has drawn. That is a flat capture, which walks on to the next
    // point and eventually answers null for a clip that was going to be fine.
    //
    // So the second look always takes the clock, however ready the element
    // claimed to be. It costs nothing when the first was good, because a good
    // first read returns from inside the loop.
    for (let look = 0; look < 2; look++) {
      await presented(v, look);
      const took = await capture(v).catch(err => {
        // Not silent, and this is the one place in the pipeline where an error
        // has anything to say: everything above it is a race that expires and
        // everything below is a null. A throw here is an encoder or a canvas
        // refusing, which is a fault to fix rather than a clip to walk past.
        console.warn(`[mbrd] poster: capture threw at ${at}s`, err);
        return { shot: null, flat: false, why: 'the capture threw: ' + why(err) };
      });
      if (took.shot && !took.flat) return took.shot;
      if (took.why) refused = took.why;
    }
    // Nothing at this point. Look further in - see the note on FLAT_SPREAD, and
    // the head of this function for why a frame with nothing in it is never the
    // answer rather than being kept as a last resort.
  }
  // Nothing at any seek point. One last attempt, and it changes the question
  // rather than repeating it - see playing(), which grabs off a clip that is
  // running instead of one that has been parked on a seek.
  let played = false;
  if (!refused) {
    const live = await playing(v).catch(() => ({ played: false, shot: null }));
    if (live.shot) return live.shot;
    played = live.played;
  }
  // **What this browser has just proved about itself**, which is a bigger fact
  // than what it said about this clip. Every capture came back with an encoded
  // frame in it, the canvas reads back, the clip played - and every pixel of
  // every frame at four different moments was the same colour. A film can be
  // black at 0.1s; a film that is black at 0.1s, at 1s, a tenth of the way in
  // and through six looks of playback is not a film, it is a decoder handing its
  // picture to a surface this 2D context cannot see. Firefox for Android does
  // exactly that.
  //
  // Recorded rather than acted on here, because what to do about it is not this
  // module's to decide - it costs thirty megabytes and belongs to whoever is
  // importing. See videoDrawsBlank() and posterFor() in import/drop.ts.
  //
  // Whether playback actually started is *not* part of the condition, and that
  // is deliberate rather than an oversight - it is in the log because it is
  // worth knowing, not because it changes the answer. A browser that refused to
  // play the clip has not proved anything about its compositor, but it has
  // proved the same practical thing: four attempts at a frame, every one blank,
  // and no fifth attempt this module has. Both endings want the same fallback.
  //
  // What that costs when it is wrong is one clip that genuinely opens on black
  // going the long way round to a picture that is also black - which posterFor()
  // then declines to store, so the board is not poisoned by it.
  if (!refused && canvasReads()) blankBrowser = true;
  // Said differently in that case, and it is not a nicety: the ordinary line
  // here is about the clip, and this one is about the browser and is followed by
  // something being done. A person who reads "no frame could be decoded" and
  // then watches the decoder arrive has been told two contradictory things about
  // the same import.
  if (blankBrowser) {
    console.warn('[mbrd] poster: this browser draws video onto a canvas as nothing',
      played ? '(it played and drew nothing)' : '(it would not play either)');
    noPreview('clip', 'this browser will not draw a clip onto a canvas - trying the video tools instead');
    return null;
  }
  // **Three different endings, and they used to share one sentence.** "Every
  // frame came back empty" is true of exactly one of them - the decoder that
  // drew nothing at any seek point - and was said just as readily when the
  // canvas never existed and when the frame drew perfectly and would not
  // encode. A person reading that off a phone is being pointed at their video
  // file, which is the one thing in the chain that was working.
  console.warn('[mbrd] poster: no frame kept', refused || 'every seek was flat');
  if (refused) noPreview('clip', refused);
  else if (!canvasReads()) canvasBlocked();
  else noPreview('clip', 'every frame came back blank - this browser would not draw the clip onto a canvas');
  return null;
}

/**
 * A frame off a clip that is *running*, as the last thing tried.
 *
 * The walk above parks the element on a seek and reads it, which is the cheap
 * way and is what works nearly everywhere. What it assumes is that a decoder
 * asked for the frame at 1.0s will have that frame sitting on the element
 * afterwards, and on a phone that assumption is not always good: some decoders
 * produce nothing at all for a seek on a clip that has never run, and some
 * produce a frame the compositor has but the 2D context cannot see. Both look
 * identical from here - a flat rectangle at every point - and both are a clip
 * the person can watch by tapping the card.
 *
 * So this stops asking for a particular moment and takes whatever the running
 * clip has. Half a dozen looks, a frame interval apart, and the first one with
 * something in it wins; the point being reached at all means the clip is
 * already going to have no picture, so a second of playback is cheap against
 * that.
 *
 * Muted from birth (see videoFrame), which is what makes the play() allowed
 * without a gesture. Where it is refused anyway this answers null and the clip
 * keeps the card it had.
 *
 * The pause in `finally` is not tidiness: videoFrame's teardown drops the
 * source, and an element left running while its src is pulled is a decoder held
 * open on a phone with a ration of them.
 */
async function playing(v: HTMLVideoElement): Promise<{ played: boolean, shot: VideoFrameShot | null }> {
  try {
    await v.play();
  } catch {
    // Not the same as "it played and drew nothing", and the difference decides
    // what the caller concludes about the browser - see blankBrowser.
    return { played: false, shot: null };
  }
  try {
    for (let look = 0; look < 6; look++) {
      await wait(FRAME_MS);
      const took = await capture(v);
      if (took.shot && !took.flat) return { played: true, shot: took.shot };
    }
    return { played: true, shot: null };
  } finally {
    v.pause();
  }
}

/**
 * Whether this browser has been shown to draw video onto a canvas as nothing.
 *
 * A fact about the engine, not about a file, and it is only ever set by the
 * evidence in grab(): a clip that played, on a canvas that reads back, whose
 * every frame at four moments was one flat colour. False until something has
 * actually failed that way - nothing here guesses from a user-agent string, and
 * a browser that has not been asked is not accused.
 *
 * What it is for is one decision in import/drop.ts: whether a clip the browser
 * opened perfectly well should still go the thirty-megabyte way round. The
 * answer is normally no, emphatically - that route exists for a format nothing
 * here can read. But on an engine that will not hand over a frame it is the only
 * route there is, and the alternative is a board of black rectangles on a phone
 * where the card's own source is parked until it is tapped.
 *
 * Sticky for the session and never unset. One clip proving it is enough, and the
 * next fifty on the same board should not each pay four seeks and a second of
 * playback to prove it again.
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
 * `look` is which of grab()'s two reads this is, and it is here rather than at
 * the call site because it decides whether the readyState shortcut applies.
 * HAVE_CURRENT_DATA means there is a frame at the current position, which is
 * precisely what drawImage needs, so on the first look it is worth taking at
 * face value - a ready decoder read 150ms sooner is 150ms off every clip on the
 * board. On the second look it is not: the element said the same thing before
 * the read that came back flat, so believing it again would collapse the two
 * looks into one and throw away the only mitigation this function has.
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
 * No shot means the drawing itself did not come off, and `why` says which of
 * the two - no canvas at all, or nothing this engine will encode. It used to be
 * a bare null, which grab() could only report as the one thing it is not: a
 * clip whose every frame was empty. The two failures are a browser's and the
 * third is a film's, and telling somebody the wrong one costs them an evening
 * looking at the wrong end of it.
 *
 * `flat` is the other answer, and it is a report rather than a refusal: whether
 * to keep a frame with nothing in it is a question about the whole clip, so
 * grab() decides it across every seek point and this only says what it saw at
 * one.
 */
async function capture(
  v: HTMLVideoElement,
): Promise<{ shot: VideoFrameShot | null, flat: boolean, why: string }> {
  const scale = Math.min(1, POSTER_SIDE / Math.max(v.videoWidth, v.videoHeight));
  const w = Math.max(1, Math.round(v.videoWidth * scale));
  const h = Math.max(1, Math.round(v.videoHeight * scale));
  // Through canvas/surface.js, which falls back to an ordinary <canvas> where
  // OffscreenCanvas is absent - Safari before 16.4. Without it this returned
  // null for every clip on those engines, which is the same "no poster" answer
  // an undecodable codec gets, and so was indistinguishable from one.
  const face = surface(w, h, { alpha: false });
  if (!face) return { shot: null, flat: false, why: 'this browser would not give a canvas to draw the frame on' };
  face.ctx.drawImage(v, 0, 0, w, h);
  let flat = looksFlat(face.ctx, w, h);
  // **Two ways to get a frame off an element, and a browser may have only one.**
  //
  // `drawImage(video)` is the obvious one and it is the one that fails on
  // Firefox for Android: the canvas is fine there - it draws bitmaps, it reads
  // back, it encodes, all of which the Debug readout confirms - and a video
  // drawn onto it comes out as one flat rectangle at every seek point on a clip
  // the phone plays perfectly. The frame exists; that particular door to it is
  // shut, because the decoder hands its picture to a hardware surface the 2D
  // context never sees.
  //
  // createImageBitmap() asks the element for the same instant through a
  // different door, and it is a door that engine does open. Tried only when the
  // first came back flat, so a browser where drawImage works pays nothing for
  // this - and if the second is blank too, the first drawing stands and the
  // verdict is unchanged, which is the case where the clip really is on a fade.
  if (flat && typeof createImageBitmap === 'function') {
    try {
      const bmp = await createImageBitmap(v);
      face.ctx.drawImage(bmp, 0, 0, w, h);
      bmp.close?.();
      flat = looksFlat(face.ctx, w, h);
    } catch { /* the first drawing stands */ }
  }
  const out = await encodeFrame(face);
  if (!out) return { shot: null, flat, why: 'the frame drew and this browser would not encode it' };
  return { shot: { blob: out, w: v.videoWidth, h: v.videoHeight }, flat, why: '' };
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
 * **False, not true, where this browser will not hand its pixels back.** That
 * was the other way round and it was the wrong way round, because it treats one
 * failure as another: a frame that cannot be *inspected* is not a frame that is
 * empty. Firefox's fingerprinting protection - on by default in the strict mode
 * that is the default on Android - answers a canvas read with blank or
 * randomised data rather than an error, so every frame of every clip read as
 * one flat rectangle, all three seek points were walked and discarded, and the
 * whole feature answered "every seek came back with nothing in it" on a device
 * where the decoder had been handing over perfect frames all along. The clip
 * then had no poster, and on a phone the renderer parks the source, so the card
 * was black until it was tapped. See canvasReads() in canvas/surface.ts.
 *
 * What that costs where the reading really is blocked is the seek past a black
 * leader: the first frame is kept whatever is in it. A still of the first frame
 * beats no still, and it is what this function was written to improve on rather
 * than to replace.
 *
 * A throw is still treated as flat, which is the tainted-canvas case and is a
 * different thing again - that one really is a frame nothing can be done with.
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
 * JPEG unconditionally rather than the conditional retry canvas/display.js
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
