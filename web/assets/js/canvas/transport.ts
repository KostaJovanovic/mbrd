// The control strip: a play button, the sound drawn as bars, and a clock.
//
// The native <audio controls> widget was the placeholder here, and it is the one
// piece of chrome a browser will not let you restyle - so every board, whatever
// its palette or its whimsy, had a strip of Chrome-grey plastic sitting in the
// middle of it. This is what replaced it, and it is the half of the old
// canvas/audio.js that builds nodes.
//
// One caller: canvas/renderers.js, for an audio card.
//
// It said four - this file for an audio card, canvas/video.js for a video one,
// ui/nowplaying.js's bar and ui/playlist.js's window - and named that as the
// reason to be one function rather than four strips that drifted. Three of the
// four never arrived. What the other three actually share is the part that went
// down to media/transport.js (bindScrub, clock, the two glyphs, and now
// reportPlayError), which is where a claim about four players belongs; each
// builds its own strip around them. The options this file carried for those
// callers - `line`, `signal`, `alive` - are gone with the sentence.
//
// ── Why canvas/ and not media/ ──
//
// media/transport.js is the obvious-looking home and is the wrong one, and the
// reason is a line in its own header: "nothing here should acquire an import
// that would block it - in particular not state.ts. A transport is told what to
// draw; it does not ask the board what is playing." This function does ask. It
// reads `bus` and `selection` from state.ts to know when a card has been let go
// of and may redraw its bars at a new width; it calls peaks() in
// canvas/waveform.js, which reaches storage/assets.js and marks the board dirty;
// and it starts playback through canvas/playlist-queue.js. media/ is in BASE in
// tests/layers.test.js precisely because everything in it sits at the bottom of
// the graph, and a module with three dependencies on state.ts and storage filed
// beside one with none would make the directory mean two opposite things.
//
// Complaining is the one item that has since gone the other way. A rejected
// play() is the same sentence in five players, so reportPlayError() is in
// media/transport.js now and takes notify.js with it - which is the one import
// that module has, and notify.js is beside it in BASE.
//
// So what went down to media/transport.js is the part that genuinely satisfies
// that promise - bindScrub(), clock(), and the two glyphs, none of which touch
// `document` or know there is a board - and the part that could not is here.
// canvas/ is reachable from all four callers without inverting anything, and DOM
// construction is not out of place in it: canvas/items.js, canvas/renderers.js
// and canvas/video.js all build nodes. Cards are canvas/'s to draw. What would
// be a layering regression is this module reaching *up* into ui/, and it does
// not.
//
// ── What must not move in here ──
//
// The measurement. peaks() and resample() are canvas/waveform.js, and the reason
// is the one that split this file: an amplitude is not a bar, and a module that
// knew both would be the module this came out of.
//
// The exclusivity rule, the volume, the record of what is playing. All
// canvas/audio.js. This builds a button that asks; it is not what answers.

import { clamp } from '../util.ts';
import { bus, selection } from '../state.ts';
import {
  PAUSE_ICON, PLAY_ICON, bindScrub, clock, reportPlayError,
} from '../media/transport.ts';
import { nowPlaying } from './audio.ts';
import type { Track } from './playlist-queue.ts';
import { playTrack } from './playlist-queue.ts';
import type { Measurable } from './waveform.ts';
import { peaks, resample } from './waveform.ts';

/** Screen px per bar, near enough - a bar plus its gap. */
const BAR_PITCH = 5;
const MIN_BARS = 10;

/**
 * What a transport needs of the thing it is a transport for: enough to measure
 * it (canvas/waveform.ts), enough to start it (canvas/playlist-queue.ts), and an
 * id to compare against the selection. Structural for the reason both of those
 * modules give - there is no shared board-item type to import yet.
 */
export type TransportItem = Measurable & Track;

// There was a `TransportOptions` here with three members - `line`, `signal` and
// `alive` - and nothing ever passed one. buildTransport() has exactly one call
// site (canvas/renderers.ts, an audio card) and calls it with two arguments, so
// `line` was permanently false and the whole branch it gated was unreachable,
// `signal` was permanently undefined on every addEventListener below, and
// `alive` always fell through to its default.
//
// The prose was the expensive part: the header claimed four callers, the
// docstring below explained at length how the bar uses the line form, and
// ui/nowplaying.ts's own header pointed here for it - a design described in
// three files and implemented in none of them. The bar draws its own strip out
// of seekInnerHTML() and clock(), which is what its header says a few lines
// further down.

/**
 * Build the play button, the waveform and the clock for one audio item.
 *
 * The waveform is two identical lanes of bars stacked on top of each other -
 * one in the quiet colour, one in the accent - and the played portion is the
 * accent lane revealed by a clip. That is what makes the fill continuous: a
 * clip can cut a bar in half, where colouring whole bars can only ever step
 * from one to the next, and at forty bars over three minutes that step is a
 * visible lurch every four seconds.
 *
 * Bars are mirrored about the centre line rather than standing on a baseline.
 * A recording has no up and no down - the waveform of a signal is symmetric by
 * construction, and drawing only its top half is a bar chart of a sound rather
 * than a picture of one.
 *
 * Built for an audio card, and for nothing else. See the note above the
 * signature about the three options that used to be here for callers that were
 * never written.
 */
export function buildTransport(
  item: TransportItem,
  sound: HTMLMediaElement,
): HTMLDivElement {
  const transport = document.createElement('div');
  transport.className = 'transport';

  const play = document.createElement('button');
  play.type = 'button';
  play.className = 'play';
  play.setAttribute('aria-label', 'Play');
  play.innerHTML = PLAY_ICON;

  // The thing you seek on, in whichever of its two forms. Same role, same keys,
  // same scrub - only the ink differs, and only paint() below knows which.
  const wave = document.createElement('div');
  wave.className = 'wave';
  // role="slider" is a promise: focusable, driven by the arrow keys, and
  // reporting where it is. It had the role and the label and none of the rest,
  // which is worse than no role at all - a screen reader announces a slider
  // that cannot be reached or moved. See seekBy() and paint() for the other
  // two thirds.
  wave.setAttribute('role', 'slider');
  wave.setAttribute('aria-label', 'Seek');
  wave.setAttribute('aria-valuemin', '0');
  /**
   * A stopped track's seek is not a control, so it does not answer the pointer,
   * take the Tab, or announce itself as something to operate. Written together
   * because they are one fact: `.is-playing` on the transport is what the
   * stylesheet reads for the pointer half, and these two are the keyboard and
   * screen-reader halves of the same sentence.
   */
  const setSeekable = (on: boolean) => {
    wave.tabIndex = on ? 0 : -1;
    wave.setAttribute('aria-disabled', String(!on));
  };
  setSeekable(false);
  // The two stacked lanes. Held as a list rather than as two names because that
  // is all either of them is ever used as.
  const lanes: HTMLElement[] = [];
  const base = lane('wave-base');
  const fill = lane('wave-fill');
  lanes.push(base, fill);
  wave.append(base, fill);

  const time = document.createElement('span');
  time.className = 'transport-time';
  time.textContent = '0:00';

  transport.append(play, wave, time);

  let values: number[] | null = null;   // the stored readings, once they arrive
  let builtFor = 0;                     // the width the current bars were drawn for

  const barCount = () => {
    const w = wave.clientWidth || parseFloat(getComputedStyle(wave).width) || 0;
    return Math.max(MIN_BARS, Math.round(w / BAR_PITCH));
  };

  const drawBars = () => {
    const w = wave.clientWidth;
    if (!w || !values) return;
    const heights = resample(values, barCount());
    for (const el of lanes) {
      el.replaceChildren(...heights.map(v => {
        const bar = document.createElement('i');
        // A floor, so a silent passage is a thin line through the middle
        // rather than a gap in the waveform.
        bar.style.height = Math.max(7, Math.round(v * 100)) + '%';
        return bar;
      }));
    }
    builtFor = w;
    paint();
  };

  const paint = () => {
    const at = sound.duration ? clamp(sound.currentTime / sound.duration, 0, 1) : 0;
    // A clip rather than a scale, and it is the cheap way to move this one:
    // the fill has to reveal shaped ink, so it is cut rather than resized.
    // Runs on every frame of playback.
    fill.style.clipPath = `inset(0 ${((1 - at) * 100).toFixed(3)}% 0 0)`;
    // How long it is until it starts, where it is once it has. A card sitting
    // at the top of a track has nothing to report about the playhead - it is at
    // the beginning, which is where the playhead always is before you press
    // anything - so every card on the board read 0:00 and the one number on it
    // said nothing about the file. The length is what somebody scanning a board
    // of records wants, and it is only in the way once there is a position to
    // show instead.
    time.textContent = clock(sound.currentTime || sound.duration || 0);
    // In seconds, with a spoken form beside it: "83" is not a position in a
    // recording, "1:23 of 4:10" is. Spelled through String() rather than handed
    // setAttribute a number and left to its own coercion, which is what this did
    // and is the same two characters either way.
    wave.setAttribute('aria-valuemax', String(Math.round(sound.duration || 0)));
    wave.setAttribute('aria-valuenow', String(Math.round(sound.currentTime || 0)));
    wave.setAttribute('aria-valuetext',
      `${clock(sound.currentTime || 0)} of ${clock(sound.duration || 0)}`);
  };

  // While it plays, the fill is driven by the frame clock rather than by
  // timeupdate, which fires about four times a second - fine for a digit,
  // nowhere near enough for something that is supposed to glide.
  let frame = 0;
  const follow = () => {
    paint();
    frame = sound.paused ? 0 : requestAnimationFrame(follow);
  };

  peaks(item).then(v => { values = v; drawBars(); });

  // The first draw waits for the element to have a real width, rather than
  // taking whatever it measures at the moment the readings arrive.
  //
  // buildContent() composes a card while its .item is still detached - on the
  // first build, and again on every rebuild() for a rename or a note edit -
  // and a detached element measures zero. That was survivable only because
  // decoding a file takes long enough for the node to land in the document
  // first. Cached readings do not: peaks() returns them in a microtask, which
  // beats attachment, so a reopened board drew its bars into a zero width,
  // bailed, and never had cause to try again. This fires whenever the box
  // turns up, which is the actual condition being waited on.
  //
  // Only while there is nothing drawn yet. Once there is, resizes are left to
  // the deselect below, so the bars do not reflow under a dragging pointer.
  const watch = new ResizeObserver(() => {
    if (builtFor || !wave.clientWidth || !values) return;
    drawBars();
    watch.disconnect();
  });
  watch.observe(wave);

  // The rule this module argued for and kept to itself now lives in
  // media/transport.ts, where the other four players can reach it. See
  // reportPlayError() there.
  play.addEventListener('click', () => {
    // The card is a voice of the shared queue - pressing play starts the queue
    // here, which is what keeps one thing sounding at a time and lets a Next
    // press reach the rest of the board. What it is *not* is a list: 'board'
    // says so, and the queue holds on to that. A card that ends stops there
    // rather than moving on to whichever audio the board's order happens to put
    // next, and the bar offers no Next button for it. See playTrack().
    //
    // When this card is already the sounding track, the button just pauses and
    // resumes it where it is.
    if (nowPlaying()?.el === sound) {
      if (sound.paused) sound.play().catch(reportPlayError); else sound.pause();
    } else {
      playTrack(item, 'board');
    }
  });
  // No signal to pass. The <audio> is built with the card and dies with it, so
  // these listeners die with it - which is the whole of why the `signal` option
  // that used to be threaded through here was never needed by the one caller.
  const on = (type: string, fn: () => void) => sound.addEventListener(type, fn);

  on('play', () => {
    transport.classList.add('is-playing');
    setSeekable(true);
    play.innerHTML = PAUSE_ICON;
    play.setAttribute('aria-label', 'Pause');
    if (!frame) frame = requestAnimationFrame(follow);
  });
  on('pause', () => {
    transport.classList.remove('is-playing');
    setSeekable(false);
    play.innerHTML = PLAY_ICON;
    play.setAttribute('aria-label', 'Play');
    paint();
  });
  on('loadedmetadata', paint);
  // A duration that arrives late, or arrives wrong and is corrected: a stream
  // with no duration in its container - raw AAC, an MP3 with no Xing header -
  // is guessed at from the bitrate at 'loadedmetadata' and settled later, and
  // the guess is what this bar sized itself against.
  on('durationchange', paint);
  // The frame loop above covers playback. This covers everything else that can
  // move the playhead - a seek while paused, a buffering stall, currentTime set
  // from outside - none of which produce a frame loop of their own.
  on('timeupdate', paint);
  on('seeked', paint);
  on('ended', () => { sound.currentTime = 0; paint(); });

  // A transport built onto an element that is already going has missed the
  // 'play' it would have taken its state from. The card never hit this - its
  // element is new - but the bar is handed a clip mid-flight every time.
  if (!sound.paused) {
    transport.classList.add('is-playing');
    setSeekable(true);
    play.innerHTML = PAUSE_ICON;
    play.setAttribute('aria-label', 'Pause');
    frame = requestAnimationFrame(follow);
  }
  paint();

  // Dragged, not just clicked. This was one pointerdown that jumped the
  // playhead and let go - so finding a moment in a recording meant a series of
  // guesses, each one a fresh click, with the sound restarting from wherever
  // the last guess landed. bindScrub() is the same gesture the video card's
  // line has always had.
  bindScrub(wave, clientX => {
    // Not while it is stopped. A card sitting on a board is a thing you drag, and
    // the waveform is most of its face - so a scrub on a paused track meant every
    // attempt to move the card by the part of it you were nearest scrubbed it
    // instead, and left a clip you had not asked to hear parked somewhere in the
    // middle. Playing, the same gesture is unmistakably a seek: there is a sound
    // to move through and a playhead moving through it.
    //
    // Press play and it is scrubbable again immediately - which is the honest
    // shape of it, since seeking a track you are not listening to has no
    // feedback anyway.
    if (sound.paused) return;
    if (!sound.duration) return;
    const box = wave.getBoundingClientRect();
    if (!box.width) return;
    sound.currentTime = clamp((clientX - box.left) / box.width, 0, 1) * sound.duration;
    paint();
  });

  /** Seek by `secs`, or to an absolute point when `to` is given. */
  const seekBy = (secs: number, to: number | null = null) => {
    if (sound.paused) return;      // the keyboard half of the rule above
    if (!sound.duration) return;
    const next = to != null ? to : sound.currentTime + secs;
    sound.currentTime = clamp(next, 0, sound.duration);
    paint();
  };

  // The keyboard contract for a slider: arrows nudge, PageUp/PageDown take a
  // bigger step, Home and End go to the ends. Space plays and pauses, which is
  // what that key does on every other transport a person has used.
  //
  // stopPropagation is what keeps the canvas out of it - these are its keys
  // too, and without this an arrow would seek *and* nudge the selection.
  wave.addEventListener('keydown', e => {
    const step = e.shiftKey ? 1 : 5;
    switch (e.key) {
      case 'ArrowRight': case 'ArrowUp': seekBy(step); break;
      case 'ArrowLeft': case 'ArrowDown': seekBy(-step); break;
      case 'PageUp': seekBy(30); break;
      case 'PageDown': seekBy(-30); break;
      case 'Home': seekBy(0, 0); break;
      case 'End': seekBy(0, sound.duration); break;
      case ' ': case 'Enter': play.click(); break;
      default: return;
    }
    e.preventDefault();
    e.stopPropagation();       // the canvas must not also act on this
  });

  // Redrawn when the card is let go of, not while it is being dragged.
  //
  // The bar count follows the card's width, so a resize wants a different set
  // of bars - but rebuilding them on every frame of a drag would have the
  // waveform reflowing under the pointer, which reads as the sound changing.
  // Deselection is the end of the gesture, and by then the width is final.
  //
  // A card replaced by rebuild() (a rename, a note edit) is detached from its
  // item and will never be seen again; that is when this stops. `.item` and not
  // isConnected, deliberately: buildContent() composes a card while it is still
  // detached, so a selection event landing in that window would read as death
  // and quietly cost the card its resize redraw for good.
  const alive = () => !!wave.closest('.item');
  // Annotated because the unsubscribe is called from inside the handler that
  // `bus.on` is being handed - state.ts is still unchecked, so its return type
  // is inferred, and an inferred type that refers to itself is a cycle tsc
  // cannot close.
  const off: () => void = bus.on('selection', () => {
    if (!alive()) { off(); return; }
    if (selection.has(item.id)) return;
    if (wave.clientWidth && wave.clientWidth !== builtFor) drawBars();
  });
  // ...and the same unsubscribe reachable from outside, because the check above
  // only ever runs when the selection *next* changes. Pan a board of fifty
  // audio cards until they are all discarded and then touch nothing: fifty live
  // subscriptions, each holding the wave, the item, the element and the
  // detached strip, for as long as the tab is open. A liveness test that runs
  // only on an event nobody is going to fire is not a teardown. See
  // releaseTransports(), which discard() calls.
  // SAFETY: TransportNode is this module's own name for the element it built,
  // plus the unsubscribe it hangs off it. `_offSelection` is written here and
  // read only by releaseTransports() in this same file.
  (transport as TransportNode)._offSelection = off;

  return transport;
}

/** A built strip, with the way to stop it listening hung off it. */
type TransportNode = HTMLElement & { _offSelection?: () => void };

/**
 * Unsubscribe every transport inside `el`. Called by discard() in
 * canvas/items.ts, beside the media and picture teardown it does there.
 *
 * Not called by culling: a culled card is coming back, and its strip has to go
 * on redrawing its bars at the width it comes back to.
 */
export function releaseTransports(el: Element): void {
  for (const strip of el.querySelectorAll<TransportNode>('.transport')) {
    strip._offSelection?.();
    strip._offSelection = undefined;
  }
}

function lane(className: string): HTMLDivElement {
  const el = document.createElement('div');
  el.className = 'wave-lane ' + className;
  return el;
}
