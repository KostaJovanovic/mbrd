// The synthesiser, the context's lifetime, and the four reasons to stay silent.
//
// Vendored from Cuelume (MIT, https://github.com/Danilaa1/cuelume, v0.2.2,
// Copyright (c) 2026 Daniel Belyi) - see web/assets/cuelume-LICENSE.txt and
// THIRD-PARTY.md. renderTone(), renderNoise(), attachShimmer(), the tail
// arithmetic and the shared output stage are upstream's, near enough line for
// line. What is new is everything below "The level", plus the context suspend
// and the ambient session - and one thing is *missing* that upstream ships,
// which is the half of this fork worth reading about first.
//
// ── What was left behind: bind() ──
//
// Upstream is two halves. This is the engine; the other half installs four
// capture-phase listeners on `document` - pointerenter, pointerdown, pointerup,
// click - and reads `data-cuelume-*` attributes off whatever the event landed
// on. For a library that is exactly right: it cannot know what the host app's
// actions are, so it lets the markup say. Here it is wrong three times over.
//
// It is a second event listener, which CLAUDE.md forbids in as many words - a
// user-facing action is an entry in `cmds`. Four global listeners in the capture
// phase would also land in the busiest part of this app: ui/menu.ts closes on
// outside pointerdown in the capture phase, and canvas/input.ts is one pipeline
// holding exactly one active gesture.
//
// It is a second markup contract. `data-cmd` already says what a button does;
// `data-cuelume-press` beside it would say what it sounds like, in a different
// vocabulary, maintained separately, and wrong the first time a button is
// renamed.
//
// And most of what it can reach is not what should make a sound. A card
// landing, a connection drawn, a delete, an undo - none of those are clicks on
// an element with an attribute. The one thing bind() is genuinely built for is
// the hover tick, and on a canvas you sweep the pointer across forty cards
// without meaning anything by it.
//
// So the cues are called from the places that already know what happened, which
// is a dozen one-line edits at chokepoints that exist anyway.
//
// ── Where this sits ──
//
// Bottom of the graph, beside quality.ts and for the same sentence: state.ts,
// canvas/, import/, ui/ and notify.ts all say something, four tiers apart, and
// a thing every tier reads has to be under all of them or it is an inversion for
// most of them. It touches no DOM at all - it did, to read the whimsy tier, and
// stopped when the tiers did - and localStorage only through prefs.ts, so
// tests/imports.test.js needs no exemption for it.
//
// ── What must not move in here ──
//
// The recipe table and the cue map. They are recipes.ts, and the split is what
// lets the map be walked in a test with no Web Audio at all. The levelling goes
// with them for the same reason: loudnessOf() is arithmetic on the table, so
// the claim that the palette comes out even is checkable without ears - which
// is the one claim about sound that can be.
//
// Nor any knowledge of *why* a cue fired. This module is handed a name and
// plays it; whether a delete should sound like `fall` is an argument that
// belongs at the call site, where the delete is.

import { readPref, writePref } from '../prefs.ts';
import {
  CUE_NAMES, RECIPES, isCue, recipeFor, trimFor, voiceFor,
  type Cue, type NoiseLayer, type Shimmer, type SoundRecipe, type ToneLayer, type Voice,
} from './recipes.ts';

// Upstream's four, unchanged. The gain of 4 is not a mistake: the palette is
// written low so that a dozen overlapping cues have somewhere to go, and the
// limiter after the output stage is what catches them when they do.
//
// It used to be true that "every peak in the table is under 0.15", and it is
// not any more - trimFor() in recipes.ts multiplies a recipe's gain by up to
// three so that a 20ms burst and a 350ms bell are the same loudness, and it is
// the bursts that go up. At the top of the dial the loudest single cue now
// peaks near -5.6 dBFS against the limiter's -2, so one cue is still nowhere
// near it and two of the shortest ones together just reach it. Which is the
// right way round: the cues that got louder are the ones that are over before
// the limiter's 20ms release has finished with them.
const SOURCE_STOP_PADDING = 0.05;
const CLEANUP_MARGIN = 0.05;
const INAUDIBLE_GAIN = 0.001;
const OUTPUT_GAIN = 4;

// ---------------------------------------------------------------------------
// The graph - upstream's, with one line added for the detune
// ---------------------------------------------------------------------------

function renderTone(
  context: AudioContext,
  destination: AudioNode,
  layer: ToneLayer,
  startTime: number,
  detune: number,
): void {
  const oscillator = context.createOscillator();
  oscillator.type = layer.waveform;
  oscillator.frequency.setValueAtTime(layer.frequency, startTime);
  // The recipe's own detune is a chorus between two layers of one sound; the
  // repeat detune is a few cents on the whole thing. They add.
  if (layer.detune || detune) oscillator.detune.value = (layer.detune ?? 0) + detune;

  if (layer.glideTo !== undefined) {
    const glideTime = layer.glideTime ?? layer.attack + layer.decay;
    oscillator.frequency.exponentialRampToValueAtTime(layer.glideTo, startTime + glideTime);
  }

  const gain = context.createGain();
  gain.gain.setValueAtTime(0.0001, startTime);
  gain.gain.exponentialRampToValueAtTime(layer.peak, startTime + layer.attack);
  gain.gain.exponentialRampToValueAtTime(0.0001, startTime + layer.attack + layer.decay);

  oscillator.connect(gain).connect(destination);
  oscillator.start(startTime);
  oscillator.stop(startTime + layer.attack + layer.decay + SOURCE_STOP_PADDING);
}

/**
 * Two seconds of white noise, made once and played from a different place in it
 * every time.
 *
 * Upstream allocates a buffer per layer per cue and fills every sample with
 * Math.random() - about six thousand of them for a press, twelve thousand for a
 * toast, on every single press and every single toast. That is right for a
 * library, which cannot know how often it will be called; here the busiest cue
 * fires several times a second and the allocation is pure waste.
 *
 * **Played from a random offset rather than from the start**, which is the half
 * that makes one buffer honest. Reusing a fixed window would make every burst
 * the *same* burst - forty identical noise bursts sum coherently rather than
 * incoherently and start to read as one sound with an amplitude problem, which
 * is the noise version of the phase-locking the detune exists to stop. Two
 * seconds against a longest layer of about a seventh of a second is fourteen
 * non-overlapping windows and effectively unbounded overlapping ones.
 *
 * Sized in seconds rather than samples so it means the same thing at 44.1 and
 * 48 kHz, and rebuilt if the context's rate ever differs from the one it was
 * made at - which happens when a device changes its output while a page is open.
 */
const NOISE_SECONDS = 2;

let noiseBuffer: AudioBuffer | null = null;

function getNoise(context: AudioContext): AudioBuffer {
  if (noiseBuffer && noiseBuffer.sampleRate === context.sampleRate) return noiseBuffer;
  const length = Math.max(1, Math.ceil(NOISE_SECONDS * context.sampleRate));
  const buffer = context.createBuffer(1, length, context.sampleRate);
  const data = buffer.getChannelData(0);
  for (let i = 0; i < length; i++) data[i] = 2 * Math.random() - 1;
  noiseBuffer = buffer;
  return buffer;
}

function renderNoise(
  context: AudioContext,
  destination: AudioNode,
  layer: NoiseLayer,
  startTime: number,
): void {
  const duration = layer.attack + layer.decay + SOURCE_STOP_PADDING;
  const buffer = getNoise(context);

  const source = context.createBufferSource();
  source.buffer = buffer;

  const filter = context.createBiquadFilter();
  filter.type = layer.filterType;
  filter.frequency.value = layer.filterFrequency;
  if (layer.filterQ !== undefined) filter.Q.value = layer.filterQ;

  const gain = context.createGain();
  gain.gain.setValueAtTime(0.0001, startTime);
  gain.gain.exponentialRampToValueAtTime(layer.peak, startTime + layer.attack);
  gain.gain.exponentialRampToValueAtTime(0.0001, startTime + layer.attack + layer.decay);

  source.connect(filter).connect(gain).connect(destination);
  // Three arguments, and the last two are the point: where in the shared buffer
  // this burst is taken from, and how much of it to play. The window is clamped
  // so an offset can never run off the end - a duration longer than the buffer
  // would be silence after it, which is a sound that quietly stops halfway.
  const window = Math.max(0, buffer.duration - duration);
  source.start(startTime, Math.random() * window, duration);
  // Redundant beside the duration above, and kept: a source that has been given
  // an end still costs nothing to be told about it twice, and this is the line
  // anybody reading for "when does it stop" will look for.
  source.stop(startTime + duration);
}

/** A soft echo send off `source`, feeding back into `destination`. */
function attachShimmer(
  context: AudioContext,
  source: AudioNode,
  destination: AudioNode,
  shimmer: Shimmer,
): AudioNode[] {
  const delay = context.createDelay(1);
  delay.delayTime.value = shimmer.delay;

  const feedbackFilter = context.createBiquadFilter();
  feedbackFilter.type = 'lowpass';
  feedbackFilter.frequency.value = shimmer.lowpass;

  const feedbackGain = context.createGain();
  feedbackGain.gain.value = shimmer.feedback;

  const wetGain = context.createGain();
  wetGain.gain.value = shimmer.wet;

  source.connect(delay);
  delay.connect(feedbackFilter);
  feedbackFilter.connect(feedbackGain);
  feedbackGain.connect(delay);
  feedbackFilter.connect(wetGain);
  wetGain.connect(destination);

  return [delay, feedbackFilter, feedbackGain, wetGain];
}

function sourceEnd(recipe: SoundRecipe): number {
  return Math.max(
    ...recipe.layers.map(l => (l.offset ?? 0) + l.attack + l.decay + SOURCE_STOP_PADDING),
  );
}

/** How long a feedback delay stays audible, in seconds. */
function shimmerTail(shimmer?: Shimmer): number {
  if (!shimmer || shimmer.feedback <= 0) return 0;
  if (shimmer.feedback >= 1) return shimmer.delay;
  return shimmer.delay * (1 + Math.ceil(Math.log(INAUDIBLE_GAIN) / Math.log(shimmer.feedback)));
}

let sharedOutput: GainNode | null = null;

/**
 * The one output stage every cue goes through, and the limiter behind it.
 *
 * This is what makes the decision not to throttle repeats affordable: forty
 * cards landing is forty overlapping transients, and without a shared limiter
 * the sum of them clips. With one, they duck each other and stay a texture.
 */
function getOutput(context: AudioContext): GainNode {
  if (sharedOutput) return sharedOutput;

  const output = context.createGain();
  output.gain.value = OUTPUT_GAIN;

  const limiter = context.createDynamicsCompressor();
  // Retuned from upstream's -8 / knee 6 / ratio 12 / release 80ms, and this is
  // the change worth understanding, because those numbers are why overlapping
  // cues did not *sound* overlapped.
  //
  // A single cue peaks between -26 and -6 dBFS at the top of the dial, the loud
  // end being the short transients that trimFor() lifts. Upstream's
  // threshold sat at -8 with a six-decibel knee, which means the *second*
  // simultaneous cue was already into gain reduction: two sounds together came
  // out at very nearly the level of one, and the eighty-millisecond release
  // held the whole bus down while it crawled back. That is a leveller. It does
  // exactly what a library wants - nothing a host throws at it can ever be too
  // loud - and here it made a run of presses sound like an app skipping them.
  //
  // These numbers make it a safety net instead. Hard knee, near the ceiling, a
  // ratio steep enough to be a brick wall, and a release short enough that it is
  // out of the way before the next transient. Four cues can now sum honestly
  // before anything touches them, which is more than ever arrive together in
  // practice; past that it stops the sum clipping and nothing else.
  //
  // The cost, stated because it is a real one: the app is louder at the same
  // dial setting than it was, since peaks that were being squashed are not any
  // more. The dial is the answer to that.
  limiter.threshold.value = -2;
  limiter.knee.value = 0;
  limiter.ratio.value = 20;
  limiter.attack.value = 0.001;
  limiter.release.value = 0.02;

  output.connect(limiter).connect(context.destination);
  sharedOutput = output;
  return output;
}

/**
 * The earliest a cue may start, in this context's clock. See startFor().
 *
 * Reset with the context, because it is a time on that context's timeline and
 * means nothing on the next one's.
 */
let nextFree = 0;

/** The smallest gap at which two attacks are heard as two events. */
const MIN_SPACING = 0.012;

/** How far ahead the spacing may push a cue before it gives up and piles. */
const MAX_LOOKAHEAD = 0.08;

/**
 * When this cue starts - now, or a few milliseconds after the one before it.
 *
 * The second half of why overlapping cues did not sound overlapped, and it is
 * not the audio graph, it is arithmetic on `currentTime`. Two cues fired by one
 * action - a toolbar press says `pick` and the command it ran says its own
 * thing, in the same tick - were both scheduled at the identical
 * `context.currentTime`, which is to say on the same sample. **Two transients
 * that start on the same sample are one transient.** No amount of overlapping
 * fixes that; they were overlapping perfectly, and perfect overlap is the one
 * kind that cannot be heard as two events.
 *
 * Twelve milliseconds is the smallest gap that reliably reads as two attacks
 * and is far below anything anybody perceives as latency or as waiting. It is
 * also below a frame, so the forty cards of a drag - which arrive at frame
 * rate, sixteen milliseconds apart - are untouched by this entirely: they were
 * already spaced further than it asks for.
 *
 * MAX_LOOKAHEAD is the backstop that keeps this from ever becoming a queue. If
 * something fires a hundred cues in one tick, the first few are spaced and the
 * rest pile up at eighty milliseconds out rather than stretching into a
 * one-second arpeggio nobody asked for. A cue is never delayed by more than
 * that, whatever happens.
 */
function startFor(context: AudioContext): number {
  const now = context.currentTime;
  const start = Math.max(now, Math.min(nextFree, now + MAX_LOOKAHEAD));
  nextFree = start + MIN_SPACING;
  return start;
}

function renderRecipe(
  context: AudioContext,
  recipe: SoundRecipe,
  volume: number,
  detune: number,
): void {
  const now = startFor(context);
  // How far into the future this sound was pushed, so the cleanup below can be
  // measured from when it *starts* rather than from when it was asked for.
  const lead = Math.max(0, now - context.currentTime);
  const output = getOutput(context);
  const master = context.createGain();
  // trimFor() is the palette's own levelling and belongs to the recipe, not to
  // the dial: see TARGET_LOUDNESS in recipes.ts. Applied here rather than in
  // recipeFor() so that everything reaching this function is levelled the same
  // way - which includes the bench's hand-built drafts, and is the only reason
  // web/lab-sound.html tells the truth about what a recipe will sound like.
  master.gain.value = recipe.masterGain * trimFor(recipe) * volume;
  master.connect(output);

  const shimmerNodes = recipe.shimmer
    ? attachShimmer(context, master, output, recipe.shimmer)
    : [];

  for (const layer of recipe.layers) {
    const startTime = now + (layer.offset ?? 0);
    if (layer.kind === 'tone') renderTone(context, master, layer, startTime, detune);
    else renderNoise(context, master, layer, startTime);
  }

  // Sized to this sound's own tail rather than to a constant, which is what
  // keeps a shimmer from being cut off and a tick from holding four nodes for a
  // second and a half.
  //
  // `lead` is the half of this that was missing and it was audible. A setTimeout
  // runs on wall-clock time from *now*; the sound runs on the context's clock
  // from `now`, which startFor() may have pushed up to MAX_LOOKAHEAD into the
  // future. So a cue that had been spaced away from its neighbours had its
  // master gain disconnected up to eighty milliseconds before it finished - and
  // for `tick`, whose whole tail is nineteen, that is most of the sound. The
  // symptom is the worst kind: it only happens during a run, so a cue was quiet
  // exactly when several of them fired at once and full whenever it was checked
  // on its own.
  const cleanupAfterMs =
    (lead + sourceEnd(recipe) + shimmerTail(recipe.shimmer) + CLEANUP_MARGIN) * 1000;
  setTimeout(() => {
    master.disconnect();
    for (const node of shimmerNodes) node.disconnect();
  }, cleanupAfterMs);
}

// ---------------------------------------------------------------------------
// The level
// ---------------------------------------------------------------------------

const PREF = 'mbrd.sound';
const LOG_PREF = 'mbrd.soundLog';

/**
 * The four stops, and what each multiplies the palette by.
 *
 * One control rather than a checkbox and a volume that can disagree with it -
 * the same shape Whimsy and Quality already use, and legible in a way tick marks
 * are not. Named here rather than in ui/settings-schema.ts because the default
 * and the clamp are this module's business and the panel is only a way to move
 * it.
 */
export const SOUND_STOPS = ['Off', 'Low', 'Medium', 'High'] as const;

const GAIN_AT = [0, 0.35, 0.6, 1];

/**
 * Medium, and on.
 *
 * On by default is the decision that makes the feature worth building: a
 * setting nobody finds is a setting nobody has, and the way to find out that an
 * app makes sounds is to hear one. Off is one drag away and it sticks - see the
 * Quality block in ui/settings-schema.ts.
 */
const DEFAULT_LEVEL = 2;

let level = DEFAULT_LEVEL;

/**
 * Whether this module is allowed to make any sound at all.
 *
 * False until initCuelume() runs, which is what keeps /patch silent without a
 * page check in here: main.ts skips the call on the changelog exactly as it
 * skips initIdle(). It is also what makes every module below ui/ importable in
 * a test without a stub for Web Audio - an unwired engine is a no-op, the same
 * bargain notify.ts makes.
 */
let armed = false;

const clampLevel = (n: unknown): number => {
  const v = typeof n === 'number' ? n : Number(n);
  return Number.isFinite(v) ? Math.min(3, Math.max(0, Math.round(v))) : DEFAULT_LEVEL;
};

/** Which stop the dial is on, 0..3. */
export const soundLevel = () => level;

/** Move the dial. Written straight through; there is nothing to undo. */
export function setSoundLevel(n: unknown): number {
  const next = clampLevel(n);
  if (next === level) return level;
  level = next;
  writePref(PREF, String(level));
  return level;
}

/**
 * Silent whatever the dial says.
 *
 * Reduced motion is honoured because there is no equivalent media query for
 * sound and somebody who has turned animation down has said something close
 * enough to be worth acting on. It is asked every time rather than latched at
 * boot: the setting can be changed while a page is open, and a cheap match call
 * against a cue that fires a few times a minute is not worth caching wrongly.
 */
function refusal(): Outcome | null {
  if (!armed) return 'unarmed';
  if (level === 0) return 'level-off';
  if (typeof matchMedia !== 'function') return null;
  try {
    return matchMedia('(prefers-reduced-motion: reduce)').matches ? 'reduced-motion' : null;
  } catch {
    return null;
  }
}

/**
 * The same question as a boolean. Named separately rather than folded into the
 * one above because the log needs the *reason* and the resume callback needs
 * only the answer, and a caller that wanted a yes-or-no should not have to know
 * the vocabulary of outcomes to get one.
 */
const muted = (): boolean => refusal() !== null;

// The whimsy tier was read here, off `data-whimsy` on <html>, because a cue
// resolved to a different recipe at each of the three stops. It does not any
// more - see the head of CUES in recipes.ts for why the axis stopped carrying
// sound - and with it goes the last thing in this module that touched the DOM.
// That is worth noticing rather than quietly enjoying: this file is now pure
// but for Web Audio and prefs.ts, which is what a base module should have been
// all along.

// ---------------------------------------------------------------------------
// The context, and how long it stays awake
// ---------------------------------------------------------------------------

let sharedContext: AudioContext | null = null;
let idleTimer: ReturnType<typeof setTimeout> | null = null;

/** How long after the last cue the context is put to sleep. */
const IDLE_MS = 5000;

/**
 * Sleep the context after a spell of quiet, and wake it on the next cue.
 *
 * Upstream never closes its context, which is right for a library that cannot
 * know the page's lifetime. Here it is a standing cost on a board somebody
 * leaves open all afternoon: a running AudioContext holds an audio thread and,
 * on a phone, is the thing that can be seen to be using the speaker. The trade
 * is a few milliseconds on the first sound after a quiet spell, which is under
 * one cue's own attack.
 *
 * Not close(): a closed context cannot be resumed, so this would be a one-way
 * door onto never making a sound again.
 */
function sleepLater(context: AudioContext): void {
  if (idleTimer) clearTimeout(idleTimer);
  idleTimer = setTimeout(() => {
    idleTimer = null;
    // Only from running. Suspending a context the browser has already suspended
    // for its own reasons throws in some builds and buys nothing in the rest.
    if (context.state === 'running') void context.suspend().catch(() => {});
  }, IDLE_MS);
}

/**
 * How late a cue may arrive and still be the sound of the thing that caused it.
 *
 * Waking the context from our own idle suspend takes single-digit milliseconds,
 * so this never fires on that path. What it is for is the other one - see wake()
 * below.
 */
const STALE_MS = 200;

/**
 * One resume in flight at a time, and everything waiting on the same promise.
 *
 * ── The bug this is the whole of ──
 *
 * A page that has not been touched yet may not make a sound, so a context built
 * at boot starts suspended and `resume()` returns a promise that **does not
 * settle until the browser decides to unlock it** - which may be the next
 * gesture, or ten seconds later, or never. render() used to call `resume()` per
 * cue and schedule the sound in its callback. So on a fresh load:
 *
 *   - the board opening said `arrive`, which built the context and queued;
 *   - every tick of the whimsy dial queued behind it, in silence, because
 *     dragging a slider is not always the gesture the browser is waiting for;
 *   - and when something finally unlocked it, forty callbacks resolved in one
 *     turn and forty sounds were scheduled inside eighty milliseconds - the
 *     whole drag, plus the boot chime, arriving at once as one noise, long
 *     after anything that could explain it.
 *
 * Two things were wrong and both are fixed here. Every cue held its own pending
 * resume, so nothing could see that a queue was forming; and a sound that
 * cannot be played *now* was treated as a sound worth playing later, which it
 * never is. A cue is feedback. Feedback that arrives after the fact is not
 * quieter feedback, it is a different and worse thing - a noise with no cause.
 *
 * So: one promise, shared, cleared when it settles; and a caller that has waited
 * longer than STALE_MS gives up rather than plays. The last cue of a run is
 * usually still inside the deadline, which is the right survivor - a drag that
 * unlocks the context on its final tick makes one sound rather than none.
 */
let waking: Promise<void> | null = null;

function wake(context: AudioContext): Promise<void> {
  if (!waking) {
    // Normalised to a plain Promise<void>: some browsers still return undefined
    // from resume() rather than a promise, and a caller here only ever wants to
    // know that the wait is over.
    waking = Promise.resolve(context.resume()).then(
      () => { waking = null; },
      reason => { waking = null; throw reason; },
    );
  }
  return waking;
}

function getAudioContext(): AudioContext | null {
  if (sharedContext) return sharedContext;
  if (typeof window === 'undefined') return null;
  const Ctor = window.AudioContext ?? window.webkitAudioContext;
  if (!Ctor) return null;
  try {
    sharedContext = new Ctor();
  } catch {
    return null;
  }
  return sharedContext;
}

/**
 * Mix with whatever else is playing rather than interrupting it.
 *
 * The one real hazard in shipping this: a live AudioContext on a phone can
 * interrupt or duck audio playing in another app, and this app is a moodboard -
 * arranging pictures with music on in the background is the ordinary case, not
 * the edge one.
 *
 * **There is no way to duck another app from a web page.** No API offers it.
 * What there is is the Audio Session API, and 'ambient' says: mix, interrupt
 * nothing, and be silenced by the ringer switch. That is the right category for
 * a hundred-millisecond blip and is the category a keyboard click uses.
 *
 * Feature-detected because it is a Safari API today - which is convenient,
 * since iOS is where the interruption risk mostly lives; elsewhere a short Web
 * Audio sound generally mixes anyway. See research/docs/browser-support.md:
 * this is a claim about a real device and no test in this repository can make
 * it.
 */
function setAmbient(): void {
  if (typeof navigator === 'undefined') return;
  const session = navigator.audioSession;
  if (!session) return;
  try { session.type = 'ambient'; } catch { /* a browser that has it read-only */ }
}

// ---------------------------------------------------------------------------
// Repeats
// ---------------------------------------------------------------------------

/**
 * Drag forty cards and forty of them land, and forty taps is what that should
 * sound like - an interface that goes quiet exactly when the most is happening
 * has stopped being feedback. Undo held down stutters for the same reason: the
 * stutter *is* the news that many steps are going by.
 *
 * **Nothing is ever dropped, and no cue waits for the one before it to finish.**
 * That is a decision and it was taken twice. The first version of this file held
 * a thirty-millisecond guard that swallowed a repeat on the grounds that two
 * identical transients that close together are heard as one louder one - which
 * is true of a *sample* and is beside the point here. What a person is listening
 * for during a fast run is that the app is keeping up, and an app that answers
 * thirty-nine of forty presses is an app that missed one. So a repeat starts on
 * top of its predecessor and the two overlap: that overlap is the stutter, and
 * the stutter is the feedback.
 *
 * What stops the stutter becoming a buzz is not a gate, it is two things that
 * cost nothing:
 *
 *   DETUNE_CENTS   identical waveforms starting in lockstep phase-lock into one
 *                  sustained tone rather than reading as a run of separate
 *                  events. A few cents, alternating up and down, is what keeps
 *                  forty taps sounding like forty small things.
 *   the limiter     one shared DynamicsCompressor after the output stage - see
 *                  getOutput(). A dozen overlapping cues duck each other into a
 *                  texture instead of summing into a clip. It is what makes
 *                  refusing to throttle affordable at all.
 */
const DETUNE_CENTS = 7;

/** How long a run counts as one run, for the alternating detune. */
const RUN_MS = 400;

let lastCue: Cue | null = null;
let lastAt = -Infinity;
let repeats = 0;

/** Everything about the last few cues, for the tests and for a fresh bench. */
export function resetCueState(): void {
  lastCue = null;
  lastAt = -Infinity;
  repeats = 0;
}

export interface CueOptions {
  /** 0..1 over the level's own gain. The bench uses it; the app does not. */
  volume?: number,
}

// ---------------------------------------------------------------------------
// The log
// ---------------------------------------------------------------------------

/**
 * Every cue that arrives, and what became of it.
 *
 * Off by default and behind one flag, because it exists for one question that
 * cannot be answered by reading the source: **which presses are not reaching
 * this module at all?**
 *
 * Three rounds of "it skipped that one" were each a call site missing from a
 * branch - a resize grip, a widget press, a multi-card drop - and every one of
 * them was found by reasoning about `pressIntent()` rather than by watching. A
 * transcript settles it in one pass, and the important half is what is *absent*
 * from it: press something, see nothing appear, and the gap is upstream of here
 * rather than inside it. So the log has to record refusals as loudly as it
 * records sounds, or a muted cue and a cue nobody made look identical.
 *
 * A ring buffer as well as a console line. Scrollback is where a gap is easy to
 * miss and impossible to hand to somebody else; `dump()` prints the whole run as
 * one table with the millisecond gap between neighbours in its own column, which
 * is the shape the question is actually in.
 */
const LOG_MAX = 400;

/** Why a cue made no sound, or that it made one. */
type Outcome =
  | 'played'          // rendered into a running context
  | 'resumed'         // rendered after waking a suspended context
  | 'unknown-cue'     // a name that is not in the table
  | 'unarmed'         // initCuelume() has not run - /patch, a test, before boot
  | 'level-off'       // the dial is at Off
  | 'reduced-motion'  // the operating system asked for less
  | 'no-audio'        // no Web Audio here, or the context refused to build
  | 'blocked'         // the browser refused to resume
  | 'stale';          // the context woke too late for this to still be feedback

export type CueLogEntry = {
  /** ms since the page loaded, which is what lines these up with anything else. */
  at: number,
  /** ms since the previous cue arrived. The column the gaps show up in. */
  gap: number,
  cue: string,
  /** The recipe it resolved to, or '-' where it never got that far. */
  sound: string,
  outcome: Outcome,
};

let logging = false;
const log: CueLogEntry[] = [];
let loggedAt = 0;

const stamp = (): number =>
  typeof performance === 'object' ? Math.round(performance.now()) : Date.now();

function record(name: string, sound: string, outcome: Outcome): void {
  const at = stamp();
  const entry: CueLogEntry = {
    at,
    gap: loggedAt ? at - loggedAt : 0,
    cue: name,
    sound,
    outcome,
  };
  loggedAt = at;
  log.push(entry);
  if (log.length > LOG_MAX) log.shift();
  // console.info rather than log or debug: debug is hidden at the default level
  // in Chrome, which would make this look like it was not working.
  console.info(
    `[cue] +${String(entry.gap).padStart(5)}ms  ${name.padEnd(7)} ${sound.padEnd(8)} ${outcome}`,
  );
}

/**
 * Start or stop the transcript. Returns whether it is now on.
 *
 * Persisted, because the gaps happen during ordinary use and the useful session
 * is "turn it on, reload, reproduce it" rather than one that has to survive
 * being set up first. It is swept by clearPrefs() like every other preference,
 * and it does nothing but write to the console.
 */
export function setCueLog(on: unknown = true): boolean {
  logging = !!on;
  writePref(LOG_PREF, logging ? '1' : '');
  if (!logging) return false;
  log.length = 0;
  loggedAt = 0;
  console.info('[cue] logging on - mbrd.sound.dump() for the table, '
    + 'mbrd.sound.log(false) to stop. A press that prints nothing at all never '
    + 'reached the engine.');
  return true;
}

/**
 * Whether the transcript is running.
 *
 * Exported because this toggle *persists* and the other two development toggles
 * beside it in the panel do not - so the button has to be able to paint itself
 * from the truth on a fresh load rather than assuming it starts off. See the
 * Debug fold in ui/settings-schema.ts.
 */
export const cueLogOn = (): boolean => logging;

/** The transcript so far, newest last. Handed out as a copy. */
export const cueLog = (): CueLogEntry[] => [...log];

/**
 * The transcript as a table, and the gaps as their own column.
 *
 * console.table rather than a returned array, because the question is read
 * rather than computed - and it falls back to the array where there is no
 * console.table to call.
 */
export function dumpCueLog(): CueLogEntry[] {
  const rows = cueLog();
  if (!rows.length) console.info('[cue] nothing logged - is it on? mbrd.sound.log()');
  else if (typeof console.table === 'function') console.table(rows);
  else console.info(rows);
  return rows;
}

// ---------------------------------------------------------------------------
// The door
// ---------------------------------------------------------------------------

/**
 * Say that something happened.
 *
 * Safe from anywhere and at any time: before boot, in a worker, in a test, on a
 * browser with no Web Audio, and before the first user gesture - which is the
 * one that would otherwise throw, since a page may not make a sound until it
 * has been touched.
 */
export function cue(name: Cue, opts: CueOptions = {}): void {
  if (!isCue(name)) {
    if (logging) record(String(name), '-', 'unknown-cue');
    return;
  }
  const stop = refusal();
  if (stop) {
    if (logging) record(name, '-', stop);
    return;
  }
  const now = Date.now();
  // No gate of any kind above this line. Every call plays.
  repeats = name === lastCue && now - lastAt < RUN_MS ? repeats + 1 : 0;
  lastCue = name;
  lastAt = now;
  // Alternating rather than climbing: a run of forty would otherwise walk a
  // third of an octave sharp and turn a texture into a melody going somewhere.
  const detune = repeats === 0 ? 0 : (repeats % 2 ? DETUNE_CENTS : -DETUNE_CENTS);
  const voice = voiceFor(name);
  render(recipeFor(voice), opts.volume ?? 1, detune,
    logging ? { cue: name, sound: voice.sound } : null);
}

/**
 * One voice, named outright. The bench's door and nothing else's - the app says
 * `cue()`, which is the whole point of the cue names existing.
 */
export function playVoice(voice: Voice, volume = 1): void {
  if (muted()) return;
  render(recipeFor(voice), volume, 0, logging ? { cue: 'lab', sound: voice.sound } : null);
}

/** The same, for a recipe built by hand. Only web/lab-sound.html calls it. */
export function playRecipe(recipe: SoundRecipe, volume = 1): void {
  if (muted()) return;
  render(recipe, volume, 0, logging ? { cue: 'lab', sound: 'custom' } : null);
}

/** What the log wants to say about this render, or null when it is off. */
type LogNote = { cue: string, sound: string };

function render(
  recipe: SoundRecipe,
  volume: number,
  detune: number,
  note: LogNote | null,
): void {
  const say = (outcome: Outcome) => {
    if (note) record(note.cue, note.sound, outcome);
  };

  // There was a check on navigator.userActivation.hasBeenActive here, refusing
  // to build a context before the page had been touched. It is gone, and the
  // reason is that it was **stricter than the browser's own rule**.
  //
  // `hasBeenActive` is false on any fresh load, full stop. What a browser
  // actually enforces is softer: a context may start without a gesture where
  // the origin has autoplay permission - a high media-engagement score, a
  // permission the visitor granted, and above all an installed PWA, which is
  // exactly the case where a board opening with a sound is most wanted. The
  // guard refused all of those on the app's behalf.
  //
  // Nothing is needed in its place. The resume below already handles both ways
  // this can fail - a rejected promise and a synchronous throw - and both are
  // logged as `blocked`, so a refusal is visible rather than silent. The only
  // cost is a context built on a load where it will not be used, and it
  // suspends itself after five seconds of quiet anyway.
  const gain = GAIN_AT[level] * Math.min(1, Math.max(0, volume));
  if (gain <= 0) { say('level-off'); return; }

  const context = getAudioContext();
  if (!context) { say('no-audio'); return; }

  if (context.state === 'running') {
    renderRecipe(context, recipe, gain, detune);
    sleepLater(context);
    say('played');
    return;
  }
  // Suspended, either by our own idle timer or by the browser's autoplay rules.
  // Rendered inside the resume so the nodes are scheduled against a clock that
  // is running; scheduling first would put the whole sound in the past.
  //
  // Logged from inside the callback for the same reason it renders there: until
  // it resolves nobody knows whether this became a sound, and a transcript that
  // said "played" before the fact would be the one line in it not worth trusting.
  //
  // `asked` is what makes this cue's own patience its own: several cues can be
  // waiting on the one promise wake() holds, and each has to answer for itself
  // whether it is still the sound of anything. See wake().
  const asked = stamp();
  try {
    void wake(context).then(
      () => {
        if (stamp() - asked > STALE_MS) { say('stale'); return; }
        if (muted() || context.state !== 'running') { say('blocked'); return; }
        renderRecipe(context, recipe, gain, detune);
        sleepLater(context);
        say('resumed');
      },
      () => say('blocked'),
    );
  } catch {
    // Some browsers throw synchronously when audio is blocked outright.
    say('blocked');
  }
}

/**
 * Read the stored level and let the module speak. Called once, from main.ts,
 * and not at all on /patch.
 *
 * `stored` is a parameter for the reason initQuality() takes one: the test
 * wants to hand it a value without owning localStorage for the process.
 */
export function initCuelume(stored: string | null = readPref(PREF)): number {
  level = stored === null ? DEFAULT_LEVEL : clampLevel(stored);
  armed = true;
  resetCueState();
  setAmbient();
  // Read rather than reset, so "turn it on, reload, reproduce it" works - which
  // is the only shape the useful session has, since the gaps happen during
  // ordinary use rather than in a console.
  logging = !!readPref(LOG_PREF);
  if (logging) console.info('[cue] logging is on from a previous session - '
    + 'mbrd.sound.log(false) to stop.');
  return level;
}

/**
 * Back to silence, and forget the context.
 *
 * The counterpart to setOverlays(null): a test that has stubbed Web Audio has
 * to be able to put the module back to how it found it, or the next test in the
 * same process inherits a context built out of the last one's fake.
 */
export function stopCuelume(): void {
  armed = false;
  if (idleTimer) { clearTimeout(idleTimer); idleTimer = null; }
  const context = sharedContext;
  sharedContext = null;
  sharedOutput = null;
  // A resume waiting on a context that is going. Dropping the handle is enough:
  // whatever is attached to it will find the module unarmed and refuse.
  waking = null;
  // Both belong to the context that is going: a buffer cannot cross one, and
  // `nextFree` is a time on a clock the next one does not share.
  noiseBuffer = null;
  nextFree = 0;
  resetCueState();
  if (!context || context.state === 'closed') return;
  // Guarded rather than awaited: a stub in a test may have no close() at all,
  // and a real one that refuses is a context nobody is going to use again.
  try { void context.close?.(); } catch { /* already gone */ }
}

/** Re-exported so the bench and the tests have one import rather than two. */
export { CUE_NAMES, RECIPES, voiceFor };
export type { Cue, Voice, SoundRecipe };
