// Sound palette (vendored from Cuelume MIT v0.2.2, (c) 2026 Daniel Belyi)
// and the map from app events to recipes (CUES).
// No Web Audio here -- engine.ts owns the graph. Testable without a browser.
// invert() lets undo sound like redo backwards; that is why these are numbers, not samples.

/**
 * Own-property test. Written out here rather than imported from util.ts, and
 * that is deliberate: this module has no imports at all and is the better for
 * it - it is a vendored table of numbers, and a dependency on the app's own
 * helpers would make it something else.
 *
 * The long form rather than `Object.hasOwn`, which landed in Safari 15.4. Both
 * guards below are reached from ordinary interface sounds, so on an older
 * WebKit the modern spelling was a TypeError rather than a missing nicety.
 * Called off the prototype because the tables it is asked about are keyed by
 * strings that reach here from stored preferences.
 */
const own = <T extends object>(table: T, key: PropertyKey) =>
  Object.prototype.hasOwnProperty.call(table, key);

/** Seconds after the trigger that a layer starts, and its envelope. */
type BaseLayer = {
  offset?: number,
  /** Fade-in time, in seconds. */
  attack: number,
  /** Fade-out time, in seconds, starting right after the attack. */
  decay: number,
  /** Peak volume reached at the end of the attack. */
  peak: number,
};

/** A single note - the building block for chimes, arpeggios and pads. */
export type ToneLayer = BaseLayer & {
  kind: 'tone',
  waveform: OscillatorType,
  frequency: number,
  /** Detune in cents, for a gentle beating between two layers. */
  detune?: number,
  /** If set, the pitch glides smoothly from `frequency` to this value. */
  glideTo?: number,
  /** How long the glide takes, in seconds. Defaults to attack + decay. */
  glideTime?: number,
};

/** A soft filtered noise bed - the breathy, textural half. */
export type NoiseLayer = BaseLayer & {
  kind: 'noise',
  filterType: BiquadFilterType,
  filterFrequency: number,
  filterQ?: number,
};

export type SoundLayer = ToneLayer | NoiseLayer;

/** A spacious echo tail applied to the whole sound. */
export type Shimmer = {
  delay: number,
  feedback: number,
  wet: number,
  lowpass: number,
};

export type SoundRecipe = {
  masterGain: number,
  layers: SoundLayer[],
  shimmer?: Shimmer,
};

export const RECIPES = {
  /** A soft two-note ascending bell, like a confirmation tink. */
  chime: {
    masterGain: 0.5,
    layers: [
      { kind: 'tone', waveform: 'sine', frequency: 1046.5, attack: 0.006, decay: 0.22, peak: 0.09 },
      { kind: 'tone', waveform: 'sine', frequency: 1568, offset: 0.09, attack: 0.006, decay: 0.26, peak: 0.08 },
    ],
    shimmer: { delay: 0.12, feedback: 0.25, wet: 0.18, lowpass: 4000 },
  },
  /** A quick ascending twinkle of four notes - bright and playful. */
  sparkle: {
    masterGain: 0.5,
    layers: [
      { kind: 'tone', waveform: 'sine', frequency: 1760, offset: 0, attack: 0.003, decay: 0.09, peak: 0.045 },
      { kind: 'tone', waveform: 'sine', frequency: 2217, offset: 0.045, attack: 0.003, decay: 0.09, peak: 0.04 },
      { kind: 'tone', waveform: 'sine', frequency: 2637, offset: 0.09, attack: 0.003, decay: 0.1, peak: 0.038 },
      { kind: 'tone', waveform: 'sine', frequency: 3520, offset: 0.135, attack: 0.003, decay: 0.12, peak: 0.032 },
    ],
    shimmer: { delay: 0.07, feedback: 0.35, wet: 0.22, lowpass: 6000 },
  },
  /** A single note gliding smoothly downward, like a drop of water. */
  droplet: {
    masterGain: 0.55,
    layers: [
      { kind: 'tone', waveform: 'sine', frequency: 1200, glideTo: 550, glideTime: 0.14, attack: 0.004, decay: 0.2, peak: 0.075 },
    ],
    shimmer: { delay: 0.09, feedback: 0.2, wet: 0.15, lowpass: 3000 },
  },
  /** A warm, slow-swelling pad from two gently detuned sines. */
  bloom: {
    masterGain: 0.5,
    layers: [
      { kind: 'tone', waveform: 'sine', frequency: 528, attack: 0.06, decay: 0.32, peak: 0.06 },
      { kind: 'tone', waveform: 'sine', frequency: 528, detune: 12, attack: 0.06, decay: 0.34, peak: 0.05 },
    ],
    shimmer: { delay: 0.15, feedback: 0.2, wet: 0.12, lowpass: 2500 },
  },
  /** A soft hush with a falling tone - the quietest thing in the palette. */
  whisper: {
    masterGain: 0.48,
    layers: [
      { kind: 'noise', filterType: 'lowpass', filterFrequency: 1600, filterQ: 0.7, attack: 0.025, decay: 0.13, peak: 0.04 },
      { kind: 'tone', waveform: 'sine', frequency: 880, glideTo: 660, glideTime: 0.14, offset: 0.01, attack: 0.012, decay: 0.14, peak: 0.025 },
    ],
  },
  /** A focused bandpass tick with a bright sine ping on top - crisp and instant. */
  tick: {
    masterGain: 0.4,
    layers: [
      { kind: 'noise', filterType: 'bandpass', filterFrequency: 5400, filterQ: 1.8, attack: 0.001, decay: 0.018, peak: 0.14 },
      { kind: 'tone', waveform: 'sine', frequency: 2600, attack: 0.001, decay: 0.012, peak: 0.018 },
    ],
  },
  /** A dull, muted knock - a key bottoming out. */
  press: {
    masterGain: 0.4,
    layers: [
      { kind: 'noise', filterType: 'bandpass', filterFrequency: 1700, filterQ: 1.4, attack: 0.001, decay: 0.02, peak: 0.13 },
    ],
  },
  /** A brighter, springier tick - a key returning. */
  release: {
    masterGain: 0.4,
    layers: [
      { kind: 'noise', filterType: 'bandpass', filterFrequency: 4600, filterQ: 1.8, attack: 0.001, decay: 0.016, peak: 0.12 },
      { kind: 'tone', waveform: 'sine', frequency: 3200, offset: 0.006, attack: 0.001, decay: 0.05, peak: 0.02 },
    ],
  },
  /** A two-part click-clack, like a mechanical switch flipping between states. */
  toggle: {
    masterGain: 0.4,
    layers: [
      { kind: 'noise', filterType: 'bandpass', filterFrequency: 2200, filterQ: 1.6, attack: 0.001, decay: 0.016, peak: 0.12 },
      { kind: 'noise', filterType: 'bandpass', filterFrequency: 3800, filterQ: 1.6, offset: 0.024, attack: 0.001, decay: 0.02, peak: 0.1 },
    ],
  },
  /** A short, warm three-note ascending confirmation - "done", not a fanfare. */
  success: {
    masterGain: 0.5,
    layers: [
      { kind: 'tone', waveform: 'sine', frequency: 880, attack: 0.004, decay: 0.09, peak: 0.06 },
      { kind: 'tone', waveform: 'sine', frequency: 1108.73, offset: 0.06, attack: 0.004, decay: 0.1, peak: 0.06 },
      { kind: 'tone', waveform: 'sine', frequency: 1318.51, offset: 0.12, attack: 0.004, decay: 0.18, peak: 0.07 },
    ],
    shimmer: { delay: 0.1, feedback: 0.22, wet: 0.16, lowpass: 4500 },
  },
  /** A muted knock followed by two descending tones - a calm, recoverable refusal. */
  error: {
    masterGain: 0.42,
    layers: [
      { kind: 'noise', filterType: 'bandpass', filterFrequency: 850, filterQ: 1.1, attack: 0.001, decay: 0.035, peak: 0.13 },
      { kind: 'tone', waveform: 'triangle', frequency: 440, offset: 0.025, attack: 0.004, decay: 0.09, peak: 0.045 },
      { kind: 'tone', waveform: 'triangle', frequency: 349.23, offset: 0.1, attack: 0.004, decay: 0.14, peak: 0.04 },
    ],
  },
  /** A papery filtered flick with a tiny glass tick - pages and carousels. */
  page: {
    masterGain: 0.38,
    layers: [
      { kind: 'noise', filterType: 'lowpass', filterFrequency: 1800, filterQ: 0.7, attack: 0.006, decay: 0.08, peak: 0.11 },
      { kind: 'noise', filterType: 'bandpass', filterFrequency: 4200, filterQ: 1.2, offset: 0.04, attack: 0.004, decay: 0.065, peak: 0.08 },
      { kind: 'tone', waveform: 'sine', frequency: 2400, offset: 0.075, attack: 0.002, decay: 0.045, peak: 0.02 },
    ],
  },
  /** A brief unresolved lift - work has started. */
  loading: {
    masterGain: 0.42,
    layers: [
      { kind: 'noise', filterType: 'lowpass', filterFrequency: 1400, filterQ: 0.6, attack: 0.035, decay: 0.14, peak: 0.035 },
      { kind: 'tone', waveform: 'sine', frequency: 420, glideTo: 630, glideTime: 0.18, attack: 0.025, decay: 0.18, peak: 0.05 },
    ],
    shimmer: { delay: 0.11, feedback: 0.18, wet: 0.12, lowpass: 2800 },
  },
  /** A quick lock-on sweep resolving to a clear tone - the system is ready. */
  ready: {
    masterGain: 0.48,
    layers: [
      { kind: 'noise', filterType: 'bandpass', filterFrequency: 3600, filterQ: 1.8, attack: 0.001, decay: 0.02, peak: 0.11 },
      { kind: 'tone', waveform: 'triangle', frequency: 330, glideTo: 660, glideTime: 0.12, offset: 0.012, attack: 0.004, decay: 0.16, peak: 0.055 },
      { kind: 'tone', waveform: 'sine', frequency: 990, offset: 0.13, attack: 0.004, decay: 0.22, peak: 0.06 },
    ],
    shimmer: { delay: 0.1, feedback: 0.16, wet: 0.1, lowpass: 4200 },
  },
  /** A compact synthetic chirp - crisp feedback for a primary control. */
  pulse: {
    masterGain: 0.42,
    layers: [
      { kind: 'noise', filterType: 'bandpass', filterFrequency: 2600, filterQ: 2.4, attack: 0.001, decay: 0.022, peak: 0.08 },
      { kind: 'tone', waveform: 'triangle', frequency: 620, glideTo: 1240, glideTime: 0.07, attack: 0.002, decay: 0.085, peak: 0.055 },
    ],
  },
  /** A fast three-step locator signal - playful, secondary. */
  scan: {
    masterGain: 0.4,
    layers: [
      { kind: 'tone', waveform: 'sine', frequency: 740, attack: 0.002, decay: 0.055, peak: 0.05 },
      { kind: 'tone', waveform: 'sine', frequency: 1110, offset: 0.045, attack: 0.002, decay: 0.055, peak: 0.045 },
      { kind: 'tone', waveform: 'sine', frequency: 1665, offset: 0.09, attack: 0.002, decay: 0.07, peak: 0.04 },
    ],
    shimmer: { delay: 0.065, feedback: 0.16, wet: 0.1, lowpass: 4200 },
  },
  /** A rising harmonic portal with a soft tail - somewhere has been arrived at. */
  arrival: {
    masterGain: 0.44,
    layers: [
      { kind: 'noise', filterType: 'lowpass', filterFrequency: 900, filterQ: 0.8, attack: 0.05, decay: 0.24, peak: 0.035 },
      { kind: 'tone', waveform: 'sine', frequency: 220, glideTo: 440, glideTime: 0.32, attack: 0.04, decay: 0.34, peak: 0.055 },
      { kind: 'tone', waveform: 'sine', frequency: 659.25, offset: 0.12, attack: 0.045, decay: 0.32, peak: 0.04 },
      { kind: 'tone', waveform: 'sine', frequency: 987.77, offset: 0.19, attack: 0.045, decay: 0.34, peak: 0.032 },
    ],
    shimmer: { delay: 0.16, feedback: 0.28, wet: 0.18, lowpass: 3200 },
  },
} as const satisfies Record<string, SoundRecipe>;

export type SoundName = keyof typeof RECIPES;

/**
 * Every recipe name, in table order. The bench lists them; nothing else does.
 *
 * SAFETY: SoundName is `keyof typeof RECIPES`, so the keys of RECIPES are
 * exactly that union by construction. Object.keys() answers string[] because it
 * cannot know the object has no other keys; here the type is derived from the
 * object, so it does.
 */
export const SOUND_NAMES =
  // SAFETY: as above.
  Object.keys(RECIPES) as SoundName[];

// ---------------------------------------------------------------------------
// The cues
// ---------------------------------------------------------------------------

/**
 * What the app is allowed to say happened.
 *
 * Twelve names, ten sounds. on/off and rise/fall are inversions of one
 * recipe (see invert()). pick/tap sound the same — a different note on
 * drag-end read as a second event; they stay two names because the call
 * sites mean different things.
 *
 * `say` is one letter of somebody speaking, and it earns a name of its own
 * because of the *rate*: it fires every other character of a typed line, some
 * fifteen times a second, and a 5 kHz tick that reads as crisp once reads as a
 * cricket at that speed. A voice wants the dullest thing in the palette.
 */
export type Cue =
  | 'pick' | 'tap' | 'say' | 'on' | 'off' | 'rise' | 'fall'
  | 'done' | 'fail' | 'note' | 'arrive' | 'sweep';

/** One tier's answer to one cue: a recipe, optionally played backwards. */
export type Voice = { sound: SoundName, reverse?: boolean };

/**
 * Cue -> voice. One entry each, no tier dimension — the whimsy axis no
 * longer carries sound (three columns hid inaudible assignments). Chosen
 * by ear; measurement settles audibility but not desirability. Loudness
 * is now normalized by loudnessOf() / TARGET_LOUDNESS, not peak dBFS.
 * Every voice is distinct — no recipe answers two cues. Eight spare
 * recipes are listed in IDLE_SOUNDS.
 */
export const CUES = {
  pick:   { sound: 'toggle' },
  tap:    { sound: 'tick' },
  say:    { sound: 'press' },
  on:     { sound: 'pulse' },
  off:    { sound: 'pulse', reverse: true },
  rise:   { sound: 'chime' },
  fall:   { sound: 'chime', reverse: true },
  done:   { sound: 'success' },
  fail:   { sound: 'error' },
  note:   { sound: 'page' },
  arrive: { sound: 'arrival' },
  sweep:  { sound: 'ready' },
} satisfies Record<Cue, Voice>;

/** Every cue name. CUES satisfies Record<Cue, ...>, so this is exhaustive. */
export const CUE_NAMES =
  // SAFETY: as above.
  Object.keys(CUES) as Cue[];

export const isCue = (value: unknown): value is Cue =>
  typeof value === 'string' && own(CUES, value);

/** Spare recipes — no cue names them. tests/cuelume.test.js checks both
 *  directions. droplet/release/press were tried on `pick` and rejected
 *  (disliked or inaudible despite high peak dBFS); `press` has since been given
 *  `say`, where being the dullest and quietest thing in the table is the
 *  qualification rather than the objection. */
export const IDLE_SOUNDS: SoundName[] = [
  'sparkle', 'droplet', 'bloom', 'whisper', 'release', 'loading', 'scan',
];

/** The voice for one cue. Kept as a function — this is where a future
 *  dimension (theme, per-cue override) would land. */
export function voiceFor(cue: Cue): Voice {
  return CUES[cue];
}

/**
 * The same recipe, played backwards.
 *
 * Two things are reversed and the second is the one that matters. Each tone
 * layer's glide is swapped end for end, so a note that rose now falls; and every
 * layer's offset is mirrored about the last of them, so an ascending arpeggio is
 * dealt out descending. Reversing only the glide would leave `sparkle` climbing
 * through the same four notes in the same order with one of them bent, which is
 * not the opposite of anything.
 *
 * Envelopes are left alone deliberately. A reversed attack and decay is a sound
 * that swells out of nothing, which is a different *kind* of sound rather than
 * the same one going the other way - and at these durations, twenty
 * milliseconds of attack against ninety of decay, nobody hears it as a mirror.
 * They hear it as a smear.
 *
 * Pure, and returns a fresh object: RECIPES is `as const` and the engine hands
 * whatever it gets straight to the audio graph.
 */
export function invert(recipe: SoundRecipe): SoundRecipe {
  const last = Math.max(...recipe.layers.map(l => l.offset ?? 0));
  return {
    ...recipe,
    layers: recipe.layers.map(layer => {
      const moved = { ...layer, offset: last - (layer.offset ?? 0) };
      if (moved.kind !== 'tone' || moved.glideTo === undefined) return moved;
      return { ...moved, frequency: moved.glideTo, glideTo: moved.frequency };
    }),
  };
}

/** The recipe a voice names, inverted if the voice asked for it. */
export function recipeFor(voice: Voice): SoundRecipe {
  // SAFETY: RECIPES is read back as readonly literals, and SoundRecipe is the
  // mutable shape of one - the assertion drops `readonly` and claims nothing
  // about the contents. Nothing downstream writes to a recipe: invert() below
  // builds a new one, and engine.ts only reads numbers off it.
  const recipe = RECIPES[voice.sound] as SoundRecipe;
  return voice.reverse ? invert(recipe) : recipe;
}

// ---------------------------------------------------------------------------
// Levelling
// ---------------------------------------------------------------------------

/**
 * Why `masterGain` alone cannot make two recipes the same loudness.
 *
 * The table above was tuned by ear, one recipe at a time, and each number in it
 * is defensible on its own. Together they were not: measured as a listener
 * hears them, the palette spanned **twenty-three decibels** end to end - `chime`
 * at -37 dBFS against `press` at -60 - which is the difference between a
 * doorbell and a watch ticking in the next room. Undo was loud, a button press
 * was almost inaudible, and both were "correct" because nothing in this file
 * ever compared them.
 *
 * The head of CUES has the peak measurements and says the thing that matters
 * about them: **peak is not loudness.** `press` measures 2 dB above `chime` on
 * peak and cannot be heard beside it. Peak is what a meter sees in one sample;
 * what a person hears is energy gathered over about a fifth of a second, in the
 * band their ear is actually sensitive in. Three things separate the two, and
 * all three are arithmetic on the table rather than opinions about it:
 *
 *   duration     A 19 ms tick and a 356 ms bell at the same peak are nowhere
 *                near the same loudness. The ear integrates, so the short one
 *                arrives with a fifth of the energy.
 *   bandwidth    A layer's `peak` is applied *after* its filter. Broadband
 *                noise through a Q of 1.8 keeps a couple of kilohertz out of
 *                twenty-four, which is 8 dB gone before the gain node sees it -
 *                so a noise layer at peak 0.14 and a sine at peak 0.14 are not
 *                remotely the same signal.
 *   pitch        220 Hz and 3 kHz at one amplitude are ten decibels apart to a
 *                listener. `arrival` opens on a 220 Hz sine; `tick` sits at
 *                5400.
 *
 * So each recipe is measured here and trimmed to a common level. What that
 * buys is the thing the dial could not: **the dial now sets the loudness of the
 * app rather than the loudness of whichever cue happens to fire.**
 *
 * ── What this is not ──
 *
 * It is not a compressor and it does not run on audio. It is a number per
 * recipe, computed from the table, applied once to `masterGain` before anything
 * is scheduled. The limiter in engine.ts still catches sums; this stops the
 * *parts* being twenty decibels apart before they get there.
 *
 * Nor is it a claim about whether a sound is any good. Levelling settles
 * loudness and nothing else - the head of CUES is emphatic that measurement
 * says a sound will be heard and says nothing whatever about whether it will be
 * liked, and two of the entries in IDLE_SOUNDS are there because of it.
 *
 * ── What it measures ──
 *
 * The loudest fifth of a second in the sound, A-weighted, as an RMS amplitude:
 *
 *   1. Each layer's envelope is walked at 1 ms - a linear rise over `attack`,
 *      then the engine's exponential fall to a thousandth over `decay`.
 *   2. Its `peak` is scaled to an RMS by what the layer actually is: a sine
 *      spends its life between its extremes rather than at them, and filtered
 *      noise keeps only its own bandwidth out of the whole band.
 *   3. That is weighted by the ear's sensitivity at the layer's pitch.
 *   4. Layers are summed as powers, not amplitudes. Nothing in a recipe is
 *      correlated with anything else in it - different frequencies, and noise -
 *      so they add as energy.
 *   5. A 200 ms window is slid over the result and the loudest position wins.
 *
 * The shimmer is ignored. It is a wet echo at a fifth of the level behind a
 * lowpass, and folding it in would move every recipe that has one by about the
 * same amount - which is a change to TARGET rather than to the shape of this.
 */
const INTEGRATION = 0.2;

/** How finely the envelopes are walked, in seconds. */
const GRAIN = 0.001;

/** Half the rate the palette is measured at, in Hz - the whole audible band. */
const NYQUIST = 24000;

/**
 * A-weighting as a linear gain, 1.0 at 1 kHz.
 *
 * The standard curve, IEC 61672. It is a rough model of a real ear and a very
 * good one for this: the question here is only ever "how much quieter does this
 * layer sound than that one", over a palette that lives between 220 Hz and
 * 5.4 kHz where the curve is at its most trustworthy.
 */
function weighting(frequency: number): number {
  const f2 = frequency * frequency;
  const response = (12194 ** 2 * f2 * f2)
    / ((f2 + 20.6 ** 2)
      * Math.sqrt((f2 + 107.7 ** 2) * (f2 + 737.9 ** 2))
      * (f2 + 12194 ** 2));
  // The 1.2589 is what puts the curve through unity at 1 kHz rather than at the
  // 4 kHz where it peaks, so a weight reads as "against a reference tone".
  return 1.2589 * response;
}

/** The pitch a layer is heard at. */
function centreOf(layer: SoundLayer): number {
  if (layer.kind !== 'tone') return layer.filterFrequency;
  // The geometric mean rather than either end: a glide spends equal *time* per
  // octave, and the weighting curve is a function of the octave.
  return layer.glideTo === undefined
    ? layer.frequency
    : Math.sqrt(layer.frequency * layer.glideTo);
}

/**
 * RMS of what reaches the layer's gain node, per unit of `peak`.
 *
 * The bandwidth half is the one that surprises. A biquad has unity gain in its
 * passband and throws the rest away, so full-band noise comes out carrying only
 * the fraction of its power that the filter passed - the equivalent noise
 * bandwidth, which for a second-order bandpass is about (pi/2)(f/Q) and for a
 * lowpass about 1.11 f. Anything that is not a bandpass is treated as a lowpass
 * because the palette has only those two.
 */
function densityOf(layer: SoundLayer): number {
  if (layer.kind === 'tone') return Math.SQRT1_2;
  const q = layer.filterQ ?? 1;
  const bandwidth = layer.filterType === 'bandpass'
    ? (Math.PI / 2) * (layer.filterFrequency / q)
    : 1.11 * layer.filterFrequency;
  // Uniform noise over [-1, 1] has an RMS of 1/sqrt(3) before the filter takes
  // its share, and power scales with bandwidth, so amplitude scales with its
  // root.
  return Math.sqrt(Math.min(1, bandwidth / NYQUIST) / 3);
}

/** A layer's envelope at `t` seconds after the trigger, 0..1. */
function envelopeAt(layer: SoundLayer, t: number): number {
  const start = layer.offset ?? 0;
  if (t < start) return 0;
  const since = t - start;
  if (since < layer.attack) return layer.attack > 0 ? since / layer.attack : 1;
  const falling = since - layer.attack;
  if (falling > layer.decay) return 0;
  // A thousandth, not zero: engine.ts ramps exponentially and an exponential
  // never arrives. Matching it here is what keeps a long decay from being
  // counted as longer than it is heard.
  return 0.001 ** (falling / layer.decay);
}

/**
 * How loud a recipe is to a listener, as an RMS amplitude. Pure, and slow only
 * in the sense that it walks a few hundred milliseconds a millisecond at a time.
 */
export function loudnessOf(recipe: SoundRecipe): number {
  if (!recipe.layers.length) return 0;
  const span = Math.max(...recipe.layers.map(l => (l.offset ?? 0) + l.attack + l.decay));
  const amplitude = recipe.layers.map(l => l.peak * densityOf(l) * weighting(centreOf(l)));
  const steps = Math.ceil((span + INTEGRATION) / GRAIN);
  const width = Math.round(INTEGRATION / GRAIN);

  const power: number[] = [];
  let running = 0;
  let loudest = 0;
  for (let i = 0; i < steps; i++) {
    let sum = 0;
    for (let j = 0; j < recipe.layers.length; j++) {
      const a = amplitude[j] * envelopeAt(recipe.layers[j], i * GRAIN);
      sum += a * a;
    }
    power.push(sum);
    running += sum;
    if (i >= width) running -= power[i - width];
    if (running > loudest) loudest = running;
  }
  return recipe.masterGain * Math.sqrt(loudest / width);
}

/**
 * The level every cue is trimmed towards, and the numbers behind it.
 *
 * The geometric mean of the seventeen as they were written, rounded - which is
 * the one choice here that keeps the app as loud overall as it was. Levelling
 * to the loudest would have quadrupled everything and levelling to the quietest
 * would have buried the palette; the mean moves the parts and leaves the whole
 * alone, so the dial still means what it meant.
 *
 * Written down rather than computed from RECIPES at load, so that editing one
 * recipe moves one trim rather than all seventeen.
 *
 * As measured, loudest first, with the trim each lands on:
 *
 *     recipe    dBFS   trim        recipe    dBFS   trim
 *     chime     -37.0  x0.32*      page      -52.3  x1.48
 *     success   -40.5  x0.38       error     -52.5  x1.53
 *     bloom     -40.7  x0.39       whisper   -53.0  x1.60
 *     droplet   -42.4  x0.48       tick      -56.3  x2.36
 *     ready     -43.3  x0.53       release   -56.6  x2.43
 *     sparkle   -43.9  x0.57       toggle    -57.3  x2.65
 *     arrival   -44.0  x0.57       press     -60.4  x3.16*
 *     scan      -49.0  x1.02
 *     loading   -49.1  x1.03       * held at the clamp
 *     pulse     -50.6  x1.22
 *
 * Fifteen of the seventeen come out at -48.9 dB exactly; `chime` lands at -47.0
 * and `press` at -50.4, held off the target by the clamp. A palette that spanned
 * 23.4 dB now spans 3.4.
 *
 * Read the two ends together, because they are the whole argument: `chime` is
 * undo, `toggle` is every press of everything, and before this they were
 * twenty decibels apart.
 */
export const TARGET_LOUDNESS = 0.0036;

/**
 * The most a trim may move a recipe, as a factor - ten decibels either way.
 *
 * A guard rather than a lever. It bites on exactly two recipes today and both
 * are within a decibel of it, so it changes almost nothing now; what it is for
 * is later. The model is an estimate, and a recipe that came out needing to be
 * multiplied by eight would not be a levelling error, it would be a recipe
 * whose numbers are wrong - and quietly multiplying it by eight would turn a
 * sound into a click and hide the fault.
 */
const MAX_TRIM = 10 ** (10 / 20);

const trims = new WeakMap<SoundRecipe, number>();

/**
 * What to multiply a recipe's `masterGain` by so it lands at TARGET_LOUDNESS.
 *
 * Memoised on the recipe object, which is what makes it free for the nine
 * cues that name a table entry. The two inverted voices build a fresh object
 * every play and so measure every play; that costs a few thousand multiplies
 * against a sound that lasts a third of a second, and it is worth *not* caching
 * around, because a WeakMap keyed on throwaway objects is a cache that never
 * hits and a leak that never shows.
 *
 * Inverting a recipe moves its measured loudness by under a quarter of a
 * decibel across the whole palette - the layers are the same layers, dealt out
 * backwards - so `on` and `off` come out level with each other without this
 * having to know about the pair.
 */
export function trimFor(recipe: SoundRecipe): number {
  const cached = trims.get(recipe);
  if (cached !== undefined) return cached;
  const loudness = loudnessOf(recipe);
  const wanted = loudness > 0 ? TARGET_LOUDNESS / loudness : 1;
  const trim = Math.min(MAX_TRIM, Math.max(1 / MAX_TRIM, wanted));
  trims.set(recipe, trim);
  return trim;
}
