// The sound palette, and the map from what happened to what is heard.
//
// Vendored from Cuelume (MIT, https://github.com/Danilaa1/cuelume, v0.2.2,
// Copyright (c) 2026 Daniel Belyi) - see web/assets/cuelume-LICENSE.txt and
// THIRD-PARTY.md. The seventeen recipes below are upstream's, number for
// number; everything under "The cues" is this app's and has no counterpart
// there.
//
// ── Why a table of numbers rather than a folder of .wav ──
//
// Every sound here is a handful of parameters - waveform, frequency, an
// optional glide, an attack, a decay, sometimes a bed of filtered noise or a
// feedback delay for a tail - rendered live by engine.ts. Nothing is fetched,
// nothing is decoded, and the whole palette costs about six kilobytes of source
// that minifies into the bundle.
//
// That is worth something on its own, but it is not the reason. The reason is
// invert() at the foot of this file: because a sound is arithmetic, undo can be
// redo played backwards and closing can be opening played backwards - the same
// recipe with its glide swapped end for end and its layers dealt out in
// reverse. Two sprites of audio can only ever be two sprites of audio that
// somebody hoped would sound related.
//
// ── What must not move in here ──
//
// Any Web Audio node. This file is a table and a lookup; engine.ts owns the
// graph, the context and the lifecycle, and the split is what lets the cue map
// be tested in node with no browser at all (tests/cuelume.test.js).
//
// Nor a call site's name. Nothing outside this file may name a *recipe* - the
// app says `cue('fall')` and this file decides what that is. Twenty modules
// naming recipes is how a palette becomes unchangeable: reassigning one would
// mean finding every caller, and the whole reason CUES below could be rewritten
// twice in a day is that nothing outside it had an opinion.

/** Seconds after the trigger that a layer starts, and its envelope. */
/**
 * Own-property test. Written out here rather than imported from util.js, and
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

export const isSoundName = (value: unknown): value is SoundName =>
  typeof value === 'string' && own(RECIPES, value);

// ---------------------------------------------------------------------------
// The cues
// ---------------------------------------------------------------------------

/**
 * What the app is allowed to say happened.
 *
 * Eleven names over nine ideas, because two of them are pairs rather than
 * neighbours: `on`/`off` and `rise`/`fall` resolve to *the same recipe with the
 * glide inverted*, so closing is audibly the opposite of opening and redo is
 * audibly undo backwards. See invert() below - that relationship is the whole
 * argument for having taken a synthesiser instead of a folder of samples.
 *
 *   pick    a control is pressed - a toolbar or panel button, a menu row, a
 *           tab, a dropdown, or a press on the board that selects a card
 *   tap     a card is set down - it lands after a drag; a sticker is placed
 *   on/off  a boolean board setting - the grid, the axes, the readout
 *   rise    redo; a restore; a connection drawn
 *   fall    undo; a delete; a connection parted
 *   done    a board saved; an import finished
 *   fail    an error
 *   note    every other receipt - every toast, with no exceptions
 *   arrive  a board opened
 *   sweep   a marquee closing on a non-empty selection
 *
 * `pick` and `tap` are two names for one sound, and that was decided by ear.
 * They were built as a *down* and an *up* - `press` and `release`, a key
 * bottoming out and a key returning, which is what those two recipes were drawn
 * as - and it did not work: a drag ending on a different note read as a second
 * event rather than as the end of the one you were already doing. So a drag
 * opens and closes on the same note. They stay two cue names because the call
 * sites mean two different things, and because making them differ again is one
 * line in the table rather than an edit to canvas/input.ts.
 */
export type Cue =
  | 'pick' | 'tap' | 'on' | 'off' | 'rise' | 'fall'
  | 'done' | 'fail' | 'note' | 'arrive' | 'sweep';

/** One tier's answer to one cue: a recipe, optionally played backwards. */
export type Voice = { sound: SoundName, reverse?: boolean };

/**
 * Cue -> voice. One entry each, and no tier dimension.
 *
 * ── Why the whimsy axis does not carry sound ──
 *
 * It did, and the argument was mine: the axis already moves shape, type, motion
 * and ornament together, so the interface at Softish is not a quieter interface
 * than at Harsh but a warmer one, and sound had to work the same way or it
 * would be the one thing on the dial that read as a loudness control. Every cue
 * had three entries and the three columns leaned on three ends of the palette -
 * the bell end, the mechanical end, the synthetic end. It also happened to give
 * all seventeen recipes a job, which was the second argument for it.
 *
 * Both arguments were made by reading, and listening threw them out.
 *
 * What thirty-three slots actually bought was thirty-three chances to be wrong,
 * chosen by matching adjectives to recipe names, with no way to hear more than
 * one third of the result at a time - because a person is only ever at one stop
 * on the dial. The two most-fired cues in the app ended up on the two least
 * audible recipes in the palette at two of the three tiers, and that went
 * unnoticed through several rounds of "it skips sometimes" precisely because it
 * looked like a plumbing fault rather than a choice. A table nobody can hear as
 * a whole is a table that cannot be judged.
 *
 * So: one voice per cue. Eight sounds, not thirty-three, and every one of them
 * is heard by everybody, which is the only condition under which the next one to
 * be wrong gets found.
 *
 * The axis keeps everything it was always better at. Nothing about how the app
 * *looks* changed, and if sound ever earns a character axis again it should be
 * its own control rather than a passenger on that one.
 *
 * ── How these eight were chosen ──
 *
 * By ear, over several passes, and the passes are worth recording because every
 * one of them that was made by *reading* was wrong.
 *
 * The first matched adjectives to recipe names and gave the most-fired cue in
 * the app the least audible sound in the palette - twice. The second corrected
 * that with arithmetic, which fixed audibility and nothing else. The third
 * restored a whole column of the old three-column table on the grounds that
 * somebody had liked it, which was closer and still not right in its parts.
 * What is here now is what was left after each of those was listened to.
 *
 * The arithmetic is still worth having in front of you, because it settles one
 * question completely - whether a sound can be heard at all - and it is the one
 * question intuition gets backwards. Peak amplitude through the output stage,
 * duration, and whether there is a pitch in it:
 *
 *     recipe     dBFS    ms   kind        recipe     dBFS    ms   kind
 *     ready      -17.9   354  pitched     error      -17.7   244  pitched
 *     chime      -19.3   356  pitched     page       -20.0   122  pitched
 *     droplet    -20.1   204  pitched     success    -21.5   304  pitched
 *     pulse      -21.9    87  pitched     bloom      -22.9   400  pitched
 *     arrival    -24.7   575  pitched     sparkle    -25.4   258  pitched
 *     loading    -26.0   205  pitched     scan       -26.4   162  pitched
 *     tick       -17.4    19  noise       press      -18.1    21  noise
 *     toggle     -18.8    45  noise       release    -18.8    57  noise
 *     whisper    -26.7   162  noise
 *
 * **The loudest recipes here are the shortest, and the longest are the
 * quietest.** The ear integrates loudness over something like a fifth of a
 * second, so a twenty-millisecond burst is heard well below its peak however
 * high that peak is, and an unpitched one gives nothing to hold on to at all.
 * `press` measures 2 dB *above* `chime` and cannot be heard beside it.
 *
 * What the arithmetic cannot tell you is whether a sound will be *wanted*, and
 * that is what every rewrite of this table has actually turned on. `pick` and
 * `tap` have now been through four recipes on that question alone - `press` and
 * `whisper` could not be heard, `release` and `droplet` could and were disliked.
 * They were chosen by measurement each time. These two were chosen by name.
 *
 *   pick      `toggle`, 45ms - two bursts, 2200 then 3800. A card or a control
 *             being taken hold of. This is the most-fired cue by a wide margin:
 *             every press on every card, every button, every menu row.
 *   tap       `tick`, 19ms - bright at 5400 Hz, which is the only reason
 *             anything that short can be heard at all. A card being set down.
 *             The pair reads as a hold and a release rather than one sound
 *             twice, which is what a drag is.
 *   on/off    `pulse`, 87ms - a glide from 620 to 1240, inverting into a glide
 *             from 1240 to 620. A rise and a fall of one chirp, which is what a
 *             switch is.
 *   rise/fall `chime`, 356ms - two bells, 1046 then 1568, inverting into 1568
 *             then 1046. Undo and redo are the pair heard most often *as* a
 *             pair, so they get the clearest direction in the palette.
 *   done      `success`, 304ms - three notes resolving upward. Drawn for this.
 *   fail      `error`, 244ms - the loudest thing here, which is the right way
 *             round for the one cue that must not be missed.
 *   note      `page`, 122ms - a papery flick. Short enough for every toast, and
 *             it sounds like a thing arriving rather than a thing being decided.
 *   arrive    `arrival`, 575ms - the only portal here, rare enough to afford
 *             half a second.
 *   sweep     `ready`, 354ms - "a quick lock-on sweep resolving to a clear
 *             tone", which is a marquee closing said in other words.
 *
 * Every voice is distinct: no recipe answers two cues. That is not a rule and
 * was not aimed at - it is what fell out once each cue was chosen on its own
 * merits - but it is worth keeping, because the two collisions a previous
 * version carried (`page` on both undo and every toast, `release` on both a
 * press and a marquee) were the two things most likely to be reported next.
 * `pick` and `tap` are the one place two cues were deliberately given *related*
 * sounds rather than one sound, and they are still two recipes.
 *
 * Eight recipes are spare. IDLE_SOUNDS below describes each and what it measures,
 * so the next reassignment starts from a description rather than from these
 * names - and from the knowledge that a measurement says a sound will be heard
 * and says nothing whatever about whether it will be liked.
 */
export const CUES = {
  pick:   { sound: 'toggle' },
  tap:    { sound: 'tick' },
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

/**
 * Every cue name, for the bench and for the test that walks all of them.
 *
 * SAFETY: CUES `satisfies Record<Cue, ...>`, so it has a row for every Cue and
 * no rows besides - which is the whole reason that line is a `satisfies` and not
 * an annotation.
 */
export const CUE_NAMES =
  // SAFETY: as above.
  Object.keys(CUES) as Cue[];

export const isCue = (value: unknown): value is Cue =>
  typeof value === 'string' && own(CUES, value);

/**
 * Recipes in the palette that no cue names, and what each is for.
 *
 * Nine of seventeen, and that is arithmetic rather than waste: eleven cues,
 * three of which are the inversion of another, is eight slots. The claim that
 * the whimsy axis gave all seventeen a job died with the axis, and this list is
 * what replaces it - tests/cuelume.test.js checks the table against these names
 * in both directions, so a recipe falling out of use is a deliberate line here
 * and a misspelled one is still a failure.
 *
 * Written as descriptions rather than as epitaphs, because the next
 * reassignment should start from what a thing sounds like and how loud it
 * measures rather than from reading the table above again. Two of the nine are
 * here because they were tried on the busiest cue in the app and *heard* to be
 * wrong, which is worth more than the rest of this list put together. In table
 * order, which is what the test compares against.
 *
 *   sparkle  -25.4 dBFS, 258ms. Four notes climbing to 3520 Hz. Genuinely
 *            celebratory and too much for anything that happens often; the one
 *            to reach for if a rare, unambiguously good event ever needs a
 *            sound of its own.
 *   droplet  -20.1 dBFS, 204ms. One warm sine falling 1200 to 550 with a tail.
 *            Loud, pitched and unmistakable - on the arithmetic the best spare
 *            here. **Tried on `pick` and disliked.**
 *   bloom    -22.9 dBFS, 400ms. A slow swell with a 60ms attack, which is what
 *            makes it soft rather than quiet. Right for something that has been
 *            waited for; wrong for anything with a transient in it.
 *   whisper  -26.7 dBFS, 162ms. The quietest thing in the table by some way and
 *            what its own comment says it is for. It held `pick` once, which is
 *            to say the most-fired cue in the app was assigned the least audible
 *            sound in the palette. Right for something genuinely incidental; a
 *            press is not that.
 *   press    -18.1 dBFS, 21ms, and the only recipe here with no tone layer.
 *            It measures louder than `chime` and cannot be heard beside it,
 *            which is the clearest thing in the palette about why peak is not
 *            loudness. Upstream drew it as the *down* half of a pair, heard
 *            against its partner tens of milliseconds later; alone it is a click
 *            in the room. **Tried on `pick` and inaudible.**
 *   release  -18.8 dBFS, 57ms. A bright burst at 4600 Hz with a short pitched
 *            tail - loud, short, and on the arithmetic the obvious answer for a
 *            cue that fires two hundred times an hour. **Tried on `pick` and
 *            disliked: it reads as hiss.** That is the entry in this list that
 *            most needs to survive, because everything measurable about it says
 *            it should have worked.
 *   loading  -26.0 dBFS, 205ms. A rising unresolved lift. The one recipe that
 *            says *started* rather than *finished*, so it is what a long import
 *            would open with if the busy strip ever wanted a voice.
 *   scan     -26.4 dBFS, 162ms. Three notes climbing, with a tail. Directional
 *            and quiet; it was `rise`/`fall` and lost them to `chime`, which is
 *            seven decibels louder and half as many notes.
 */
export const IDLE_SOUNDS: SoundName[] = [
  'sparkle', 'droplet', 'bloom', 'whisper', 'press', 'release', 'loading', 'scan',
];

/**
 * The voice for one cue.
 *
 * A one-line lookup, and kept as a function rather than folded into the callers
 * because it is the seam: it took a tier until listening said the tiers were
 * not worth having, and whatever the next dimension turns out to be - a theme, a
 * per-cue override, nothing at all - this is where it lands rather than in
 * engine.ts.
 */
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
