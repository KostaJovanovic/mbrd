// Palette read off the pictures on the board. Analogous base plus a
// contrasting accent, hues/lightness/chroma from the photographs.
// Pure except samplePixels() at the foot (the only DOM touch); tests
// call extractPalette() with pixels directly.

import { clamp } from '../util.ts';
import { contrast, hex, maxChroma, mixHex, oklch, parseHex } from '../color.ts';
import { PALETTE_TOKENS } from '../layout-settings.ts';
export { PALETTE_TOKENS };
// tests/pigments.test.js, web/lab.html and ui/appearance.ts read colour
// through this module because this is where it used to live. Re-exported by
// name, not `export *`, so a removed export breaks loudly here.
export { contrast, hex, oklch };

/**
 * One picture's pixels: an ImageData buffer, RGBA, as samplePixels() yields
 * them and as the tests hand them in directly.
 */
export type Chunk = Uint8ClampedArray;

/** A colour without its hue: what a pigment is worn at. */
export type Tone = { L: number, C: number };

/**
 * The three per-bin tallies census() keeps beside the vote, which are only ever
 * read as ratios - see toneAt().
 */
type ToneTally = { litSum: Float64Array, chrSum: Float64Array, toneWeight: Float64Array };

/** One pass over the pixels - see census(), which is the only thing that builds one. */
type Census = {
  votes: Float64Array,
  mass: Float64Array,
  tone: ToneTally,
  voters: number,
  vivid: number,
  key: number,
};

/** A bin that stood taller than its neighbours, before any of it is ranked. */
type BinPeak = { i: number, h: number, w: number };

/** A hue the board actually holds: the angle, its share of the board, its colour. */
export type Peak = { h: number, standing: number, tone: Tone | null };

/**
 * What the photographs were, as temper() bends the tables by them - and the
 * axis, which is not about the photographs at all. `tier` is the whimsy stop
 * the palette is built for: 0 pastel, 2 bold, 1 (or absent) the tables as
 * measured. Every field is optional and independent; null means "as measured".
 */
export type Traits = { vivid?: number, key?: number, tier?: number } | null;

/**
 * Which hue does which job - see rolesFor(). `tone` is the colour each of the
 * three photographed roles was measured at, or null where there is nothing to
 * measure and the tables stand.
 */
type Roles = {
  sheet: number,
  accent: number,
  leafy: number,
  warm: number,
  tone?: { sheet: Tone | null, accent: Tone | null, leafy: Tone | null },
};

/** A palette, as the tokens it is written to the document as: token -> #rrggbb. */
export type Vars = Record<string, string>;

// ---------------------------------------------------------------------------
// Which hues the pictures are made of
// ---------------------------------------------------------------------------

/** The shorter way round the wheel between two hues, in degrees. 0 to 180. */
const apart = (a: number, b: number) => { const d = Math.abs(a - b) % 360; return Math.min(d, 360 - d); };

/** 5-degree bins. Fine enough to tell teal from green, coarse enough to vote. */
const BINS = 72;

/**
 * Below this chroma a pixel has no hue worth counting. Photographs are
 * mostly near-neutral (skin, concrete, sky, shadow), and that near-neutral
 * hue is noise - letting it vote would extract every board to the same faint
 * beige. Exported for tools/gen-tier-palettes.mjs, which asks this of a
 * literal in tokens.css rather than of a vote.
 */
export const NEUTRAL_C = 0.045;

/**
 * The floor a board gets when nothing on it clears the one above.
 *
 * A board of chalk, sea glass and bleached linen has hue in every picture but
 * nothing vivid enough to vote, so without this it extracted nothing and left
 * the look alone - broken-looking on exactly the boards whose colour is most
 * deliberate. Tried second, not instead: at this floor an ordinary photo's
 * concrete and skin would drown its actual subject.
 *
 * Still above where a black-and-white photograph sits (JPEG noise lands under
 * 0.01), so "no colour worth taking" still holds for boards that really have none.
 */
const NEUTRAL_FAINT = 0.018;

/** Near-black and near-white carry a hue the eye does not read as one. */
const MIN_L = 0.12;
const MAX_L = 0.95;

/**
 * How much of a picture has to be coloured before its vote counts at all, and
 * how much before it counts in full. Fractions of the non-transparent pixels.
 *
 * One picture, one vote - and this is the sentence that rule was missing.
 * Measured on a real board: a dark-grey-interface screenshot had exactly one
 * olive pixel above the neutral floor and a whole vote to spend, same as a
 * spectrogram with 771 coloured pixels - and it won the accent, because the
 * accent goes to the hue furthest from the sheet and noise qualifies. The
 * palette on that board was chosen by a single pixel.
 *
 * A ramp, not a cliff: below 0.5% coloured a picture doesn't vote, above 2% it
 * votes in full, between the two its vote is worth what it looks worth. The
 * grey street with one red door still survives at ~4.8% coloured.
 */
const COLOUR_MIN = 0.005;
const COLOUR_FULL = 0.02;

/**
 * How far apart two accepted hues have to be, in degrees. Below this they read
 * as one colour with variation, spending two of a palette's three slots saying
 * the same thing. 40 is roughly the presets' own closest gap (Absinthe: 44).
 */
const MIN_SEP = 40;

/**
 * A second or third hue has to be worth this much of the leader to count.
 *
 * 0.15, down from 0.22: under one-picture-one-vote a colour owning one photo
 * out of seven polls 0.14 and used to be thrown away, taking the board's only
 * real accent with it. A palette built from the pictures can't be that fussy
 * about which pictures - the alternative is a monochrome palette of the
 * majority hue. Still high enough that a smoothed histogram's shoulder (~0.05)
 * doesn't qualify.
 */
const MIN_SHARE = 0.15;

/** A hue can be one, two or three voices, never more. */
const MAX_HUES = 3;

/**
 * The hues a set of pixels is made of, strongest first.
 *
 * One picture, one vote: each chunk's histogram is normalised to 1 before
 * joining the board's, so the palette represents every photograph rather than
 * the loudest one. Pooling pixels instead let one vivid picture outvote ten
 * quiet ones.
 *
 * Chroma still weights pixels *within* a picture - the grey street with one
 * red door is a red picture, arriving as one red vote rather than however much
 * red the door contained.
 *
 * A picture with no colour sums to nothing and is skipped, diluting nobody.
 *
 * Smoothed before peaks are found: an unsmoothed histogram offers a single
 * real colour spread across neighbouring bins as separate peaks.
 */
export function huesOf(chunks: Chunk[]) {
  return peaksOf(readBoard(chunks)).map(p => p.h);
}

/**
 * How much of the board a hue actually is - the magnitude the vote above
 * deliberately destroys, kept beside it.
 *
 * Normalising each picture to one vote answers "which colours does this board
 * have" and is wrong for magnitude, since dividing by a picture's own total is
 * exactly what throws magnitude away. A wisp of pale sky is a fog photograph's
 * whole vote, indistinguishable from a wall of red.
 *
 * Measured example: eleven photos, blue polled 0.38 of the leader vs green's
 * 0.27 by vote, but by mass warm is 24.0%, green 22.7%, blue **1.7%** - the sky
 * behind a green photograph, not a colour of the board.
 *
 * So the census answers "membership" (MIN_SHARE, democratic) and "loudness"
 * (this, mass) with two different numbers. See rolesFor().
 */
function standings(mass: Float64Array, peaks: BinPeak[]) {
  let total = 0;
  for (const v of mass) total += v;
  if (!total) return peaks.map(() => 0);
  // Summed over the same five-bin window the smoothing kernel spans, so a hue's
  // standing covers the same colour its peak does.
  return peaks.map(({ i }) => {
    let m = 0;
    for (let k = -2; k <= 2; k++) m += mass[(i + k + BINS) % BINS];
    return m / total;
  });
}

/**
 * The census, at the strictest floor that finds any colour at all.
 *
 * Two passes, not one: the neutral floor does two different jobs - keeping an
 * ordinary photo's concrete out of the vote, and deciding whether a board has
 * colour at all. One number for both used to read a pastel board as B&W.
 */
function readBoard(chunks: Chunk[]): Census {
  const strict = census(chunks, NEUTRAL_C);
  return strict.voters ? strict : census(chunks, NEUTRAL_FAINT);
}

/**
 * One pass over the pixels: the vote, plus two things about a set of
 * photographs that are not a hue.
 *
 * `vivid` is mean chroma of the coloured part, averaged per picture - how much
 * colour these photos have, not which. `key` is mean lightness including
 * neutrals: a night scene is dark because of its greys.
 *
 * Both are per-picture means before averaging, same reason the vote is
 * normalised per picture - one huge photo is still one photo.
 */
function census(chunks: Chunk[], floor: number): Census {
  const votes = new Float64Array(BINS);
  const mass = new Float64Array(BINS);
  // The third tally: what each hue actually *looks* like on this board, summed
  // weighted by chroma (same weight as the vote) so it's the mean colour of the
  // pixels that voted, not of every pixel that grazed the floor. See toneAt().
  const litSum = new Float64Array(BINS);
  const chrSum = new Float64Array(BINS);
  const toneWeight = new Float64Array(BINS);
  let voters = 0, vividSum = 0, keySum = 0, lit = 0;
  for (const px of chunks) {
    const one = new Float64Array(BINS);
    const oneL = new Float64Array(BINS);
    const oneC = new Float64Array(BINS);
    let weight = 0, coloured = 0, lSum = 0, opaque = 0;
    for (let i = 0; i + 3 < px.length; i += 4) {
      if (px[i + 3] < 128) continue;
      const { L, C, h } = oklch(px[i], px[i + 1], px[i + 2]);
      lSum += L; opaque++;
      if (L < MIN_L || L > MAX_L || C < floor) continue;
      const bin = Math.floor(h / 360 * BINS) % BINS;
      one[bin] += C;
      oneL[bin] += C * L;
      oneC[bin] += C * C;
      weight += C; coloured++;
    }
    if (opaque) { keySum += lSum / opaque; lit++; }
    if (!weight) continue;
    // What this picture's vote is worth: a full one for a colour photograph,
    // none for a grey frame with a stray pixel.
    const trust = clamp((coloured / opaque - COLOUR_MIN) / (COLOUR_FULL - COLOUR_MIN), 0, 1);
    if (!trust) continue;
    for (let i = 0; i < BINS; i++) {
      votes[i] += trust * one[i] / weight;
      // Not divided by `weight` - deliberately, see standings().
      mass[i] += trust * one[i] / opaque;
      // Trust-weighted like the other two, so one stray pixel in a grey
      // screenshot can't be where the board's red comes from.
      litSum[i] += trust * oneL[i];
      chrSum[i] += trust * oneC[i];
      toneWeight[i] += trust * one[i];
    }
    vividSum += trust * (weight / coloured);
    voters += trust;
  }
  return {
    votes,
    mass,
    tone: { litSum, chrSum, toneWeight },
    voters,
    vivid: voters ? vividSum / voters : 0,
    // No pixels at all is the reference picture rather than a black one: with
    // nothing to say, the tables stand as measured.
    key: lit ? keySum / lit : REF_KEY,
  };
}

/**
 * The mean lightness and chroma of one hue, over the same five-bin window its
 * standing is summed on. Null when nothing voted there (a bare angle from a
 * test or picker), and the tables stand.
 */
function toneAt({ litSum, chrSum, toneWeight }: ToneTally, i: number): Tone | null {
  let l = 0, c = 0, w = 0;
  for (let k = -2; k <= 2; k++) {
    const j = (i + k + BINS) % BINS;
    l += litSum[j]; c += chrSum[j]; w += toneWeight[j];
  }
  return w ? { L: l / w, C: c / w } : null;
}

/**
 * The peaks of a hue vote, strongest first, each with its standing.
 *
 * Returns `{ h, standing }` rather than a bare angle, so downstream doesn't
 * have to invent magnitude from tables - which is how a hue that is 1.7% of a
 * board used to render at the same chroma as one that is 24%.
 */
function peaksOf({ votes, mass, tone, voters }: Census): Peak[] {
  if (!voters) return [];

  const smooth = new Float64Array(BINS);
  const K = [1, 2, 3, 2, 1], KSUM = 9;
  for (let i = 0; i < BINS; i++) {
    let sum = 0;
    for (let k = -2; k <= 2; k++) sum += K[k + 2] * votes[(i + k + BINS) % BINS];
    smooth[i] = sum / KSUM;
  }

  const peaks = [];
  for (let i = 0; i < BINS; i++) {
    const prev = smooth[(i - 1 + BINS) % BINS], next = smooth[(i + 1) % BINS];
    // `>=` on one side only, so a plateau of equal bins yields its first bin
    // once rather than every bin in it.
    if (smooth[i] > 0 && smooth[i] >= prev && smooth[i] > next) {
      peaks.push({ i, h: (i + 0.5) * 360 / BINS, w: smooth[i] });
    }
  }
  // A flat histogram (every pixel in one bin) has no local maximum - take the
  // largest bin. Real photos don't produce this; test fixtures and solids do.
  if (!peaks.length) {
    let best = 0;
    for (let i = 1; i < BINS; i++) if (smooth[i] > smooth[best]) best = i;
    if (smooth[best] <= 0) return [];
    peaks.push({ i: best, h: (best + 0.5) * 360 / BINS, w: smooth[best] });
  }
  peaks.sort((a, b) => b.w - a.w);

  // The sheet is the hue most pictures hold - the vote's own question. Fixed,
  // doesn't move below.
  const standing = standings(mass, peaks);
  const sheet = { ...peaks[0], standing: standing[0] };

  // Ordered by the same score rolesFor() uses for roles - the fix for a
  // palette that used to flicker: membership (peak height) and role
  // (standing) used to disagree, so a hue could be the obvious accent by 20x
  // and still get pruned by a hue with a marginally taller vote. Measured: one
  // photograph joining a 67-picture board moved the accent blue->magenta on a
  // vote tie decided by sort order, and turning the whimsy dial rewrote every
  // button. One ordering now decides both, so the accent-winner can't be cut
  // first. MIN_SHARE still floors the vote, unchanged - see the sky note in
  // rolesFor().
  const floor = sheet.w * MIN_SHARE;
  const facing = (p: { h: number }) => 1 + FACING_BONUS * apart(p.h, sheet.h) / 180;
  const rest = peaks
    .map((p, n) => ({ ...p, standing: standing[n] }))
    .slice(1)
    .filter(p => p.w >= floor)
    .sort((a, b) => (b.standing * facing(b) - a.standing * facing(a)) || (b.w - a.w));

  const out = [sheet];
  for (const p of rest) {
    if (out.length >= MAX_HUES) break;
    if (out.every(q => apart(p.h, q.h) >= MIN_SEP)) out.push(p);
  }
  return out.map(p => ({ h: p.h, standing: p.standing, tone: toneAt(tone, p.i) }));
}

// ---------------------------------------------------------------------------
// Turning hues into a palette
// ---------------------------------------------------------------------------
//
// Every number below was measured off the four presets rather than chosen, so
// an extracted palette sits where the chosen ones do on every axis.
// tools/preset-oklch.mjs prints the measurement.

/**
 * Lightness and chroma for each paper and ink token: the mean of the four
 * presets, to three places. Regenerate with tools/preset-oklch.mjs after
 * touching them.
 *
 * The sheet is a cast, not a dye: chroma dropped to 0.007 (from 0.017)
 * because a tinted sheet cast every photograph pinned to it - saturation
 * moved to the pigments, where it's looked at rather than through. Papers
 * went *up* in lightness at the same time (0.980 vs 0.965): taking chroma out
 * while leaving lightness alone would read as more tinted, not less, since a
 * darker sheet at equal chroma shows its hue more.
 *
 * Papyrus (sheet 44 degrees off its accent) is not what this imitates.
 */
const SHEET = {
  '--paper':      { L: 0.980, C: 0.007 },
  '--paper-2':    { L: 0.952, C: 0.010 },
  '--paper-3':    { L: 0.914, C: 0.015 },
  '--paper-card': { L: 0.993, C: 0.003 },
  '--ink':        { L: 0.268, C: 0.026 },
  '--ink-2':      { L: 0.437, C: 0.033 },
  '--ink-3':      { L: 0.611, C: 0.035 },
  '--rule':       { L: 0.878, C: 0.014 },
  '--rule-2':     { L: 0.776, C: 0.021 },
};

/**
 * The pigment trio. Means again; hue offsets measured too - --accent-deep
 * sits within a couple of degrees of the accent in all four presets, so it's
 * the same hue darker and nothing else.
 *
 * The accent mean (0.147, range 0.096-0.204) isn't a design choice - all four
 * presets ask for 0.185 and differ only in how much their hue can hold at
 * L 0.548. The mean is of four *clipped* answers, the honest reference for an
 * extractor clipped the same way.
 */
const PIGMENT = {
  '--accent':      { L: 0.548, C: 0.147 },
  '--accent-warm': { L: 0.730, C: 0.158 },
  '--accent-deep': { L: 0.415, C: 0.114 },
};

/**
 * What a colour read off the photographs is allowed to be, once it has to be a
 * button rather than a pixel.
 *
 * The tables above are the reference, not the answer - taking only the *hue*
 * from pictures used to print every accent at exactly L 0.548, C 0.147, so
 * two unrelated boards became one design in two rotations. So the measurement
 * stands, inside bounds a token needs to clear:
 *
 * - **Lightness**: too dark and it's indistinguishable from black, too light
 *   and repair() has to darken it anyway. Wide enough to hold every preset
 *   (0.415-0.730) with room to spare.
 * - **Chroma**: floor only, keeping an almost-colourless hue from printing a
 *   grey button - no ceiling since the gamut already is one.
 */
const WEARABLE_L = { min: 0.36, max: 0.78 };
const WEARABLE_C_MIN = 0.055;

/** A measured colour, held to what a pigment has to be. Null passes through. */
function wearable(tone: Tone | null | undefined): Tone | null {
  if (!tone) return null;
  return {
    L: clamp(tone.L, WEARABLE_L.min, WEARABLE_L.max),
    C: Math.max(tone.C, WEARABLE_C_MIN),
  };
}

/**
 * --accent-deep, from whatever the accent turned out to be. The presets put
 * it a fixed distance below their accent - "the same hue darker" - so that
 * distance and chroma ratio apply to the measurement rather than a second
 * measurement being taken, which could let the two drift apart.
 */
const DEEP_DROP = PIGMENT['--accent'].L - PIGMENT['--accent-deep'].L;
const DEEP_TEMPER = PIGMENT['--accent-deep'].C / PIGMENT['--accent'].C;

const deepen = (ink: Tone): Tone => ({ L: Math.max(0, ink.L - DEEP_DROP), C: ink.C * DEEP_TEMPER });

/**
 * Where "warm" is, in OKLCh degrees, and how far a hue may be turned towards it.
 *
 * A fixed offset would be wrong in half the cases (+20 from red is warmer,
 * +20 from green isn't), so --accent-warm rotates *towards* amber by up to
 * WARM_TURN and stops - a hue already amber stays put. Three of four presets
 * keep --accent-warm within 24 degrees of their accent; Peacock spends it on a
 * second hue instead, as this does when a third hue is offered.
 */
const WARM_ANCHOR = 75;
const WARM_TURN = 20;

/**
 * How far --leafy turns from the sheet when the pictures only had one hue.
 * The presets' second voice sits 44, 83, 93, 104 degrees away; 85 is the
 * middle and close to three of them.
 */
const LEAFY_SOLO_TURN = 85;
const LEAFY = { L: 0.572, C: 0.111 };

// ---------------------------------------------------------------------------
// The scheme: which hue does which job
// ---------------------------------------------------------------------------
//
// The sheet takes the dominant hue and the accent stands away from it - the
// one thing every account of interface colour agrees on, and the one thing
// this used to skip: paper, ink and button all sat on the same hue, safe and
// with nothing drawing the eye to the clickable thing.
//
// Half of why extracted boards used to look alike: only the hue came from the
// photographs, and one hue rotated is one design. Different roles get
// different hues now; the other half is WEARABLE_L above, reading lightness
// and saturation off the pictures too.

/**
 * Two voices closer than this can't be told apart by hue, so lightness does it
 * instead - standing advice for an analogous pair. Only --leafy moves: the
 * accent's lightness is load-bearing for the contrast floor below.
 */
const ANALOGOUS = 60;
const LEAFY_DROP = 0.07;

/**
 * Which hue does which job, from one to three of them.
 *
 * Every hue here came out of the photographs - the whole rule. It was
 * briefly not: the accent used to be *constructed*, split-complement 150
 * degrees off the sheet, on the advice that a clickable thing should
 * contrast with the page - sound advice, wrong result: a warm board got a
 * blue button none of its photos had.
 *
 * What survived and had to be walked back further: the accent taking
 * whichever remaining hue was furthest from the sheet, full stop. On a warm
 * outdoor board that hue is sky-blue - the least saturated, least present
 * colour in the frame, and almost every outdoor photo has some. That rule
 * reliably found sky and rendered it at a table chroma three times its own;
 * eleven low-saturation photographs got a cobalt button that 1.7% of their
 * colour asked for.
 *
 * Distance is now a thumb on the scale, not the scale. Hues rank by standing
 * (share of the board's actual colour), and a hue opposite the sheet counts
 * for up to twice its standing - enough to settle a near-tie, nowhere near
 * enough to hand the job to a wisp (measured: green 0.32 vs blue's 0.03).
 *
 * A board with one hue gets a palette in one hue - what three of four presets
 * do. Bare angles are still accepted; then there's no standing to rank by and
 * distance decides alone, which is what a hand-picked colour wants.
 */
const FACING_BONUS = 1;

function rolesFor(hues: (number | Peak)[]): Roles {
  // A bare angle arrives as a peak with nothing measured, so the two forms are
  // one shape from here down.
  const [sheet, ...rest]: Peak[] =
    hues.map(p => (typeof p === 'number' ? { h: p, standing: 0, tone: null } : p));
  const score = (p: Peak) => p.standing * (1 + FACING_BONUS * apart(p.h, sheet.h) / 180);
  const order = [...rest]
    .sort((a, b) => (score(b) - score(a)) || (apart(b.h, sheet.h) - apart(a.h, sheet.h)));
  const ranked = order.map(p => p.h);
  // The colour each role was measured at, alongside the angle. Null wherever
  // there's nothing to measure. Carried beside `ranked`, not inside it, since
  // every caller of the four numeric fields wants a number.
  const tone = {
    sheet: sheet.tone || null,
    accent: order.length ? order[0].tone || null : sheet.tone || null,
    leafy: order.length > 1 ? order[1].tone || null : null,
  };
  return {
    tone,
    sheet: sheet.h,
    accent: ranked.length ? ranked[0] : sheet.h,
    // A third photographed hue if the board has one. With two, the wash sits
    // *between* them rather than at its own turn - inventing a colour is no
    // better a job for the ornament than it was for the button. Only a
    // single-hue board turns.
    leafy: ranked.length > 1 ? ranked[1]
      : ranked.length ? midHue(sheet.h, ranked[0])
        : (sheet.h + LEAFY_SOLO_TURN) % 360,
    // --accent-warm has no photograph left by this point (the vote yields at
    // most three hues, the other two spoken for), so it stays a relative of
    // the sheet it washes.
    warm: warmer(sheet.h),
  };
}

// ---------------------------------------------------------------------------
// The dials: what the photographs are, not just which hue they are
// ---------------------------------------------------------------------------
//
// Using the tables unchanged meant a storm board and a pastel board came out
// the same palette in two hues. These two dials move the other two axes too,
// between stops the presets themselves span, so a bent palette is still family.

/**
 * The reference photograph: the vividness and lightness at which the tables
 * stand exactly as measured. An ordinary well-lit photo sits near here, making
 * the presets the middle of the range rather than one end.
 */
const REF_VIVID = 0.065;
const REF_KEY = 0.62;

/**
 * How far chroma may be scaled by how vivid the pictures are.
 *
 * The ceiling moved *down* when the tables did, which looks backwards for a
 * louder palette - but the tables now start at the sRGB wall (the accent asks
 * for 0.185 and mostly doesn't get it), so 2x would ask for nothing the gamut
 * can give and every vivid board would clip to the same colour. 1.35 keeps the
 * range meaningful where a hue has room and costs nothing where it doesn't.
 *
 * The floor is where the real work happens: at 0.40 concrete-and-fog gets
 * 0.059 against a vivid board's 0.198. The dial no longer says how loud the
 * loudest board is (the screen fixes that) - it says how quiet the quietest gets.
 */
const VIVID_FLOOR = 0.40;
const VIVID_CEIL = 1.35;

/**
 * How far the sheet's lightness may follow the pictures' own.
 *
 * Asymmetric: room below 0.979 for a deeper sheet, almost none above before
 * paper stops being paper. Dark photos get most of this range, bright ones a
 * token amount. The upward stop (0.010) exists because the base sheet is
 * already bright enough that more would reach L 1.0, where hex() returns
 * #ffffff regardless of chroma.
 *
 * Widened with the chroma dial, same reason: with a near-neutral sheet, its
 * *lightness* is the only thing left telling one board's paper from another's.
 * Only paper and rules move; inks stay put, so every shift here widens
 * text/sheet contrast rather than narrowing it - repair() below is a floor,
 * not a substitute.
 */
const KEY_GAIN = 0.30;
const KEY_DOWN = 0.085;
const KEY_UP = 0.010;
const PAPERS = ['--paper', '--paper-2', '--paper-3', '--paper-card', '--rule', '--rule-2'];

/**
 * Where the sheet goes at the plain end of the whimsy axis, and how much tint
 * it keeps once there.
 *
 * Harsh is where the board stops being a scrapbook and starts being a drawing
 * (grid turns to crosses, things snap to a lattice), and a drawing is made on
 * white paper - so the sheet returns to near-white regardless of the photos,
 * keeping enough tint to stay this board's white rather than the browser's.
 *
 * Kept fraction went from a third to 0.55 when papers were de-tinted, to keep
 * the same absolute amount of colour arriving a different way (below ~0.003 an
 * 8-bit sheet is just #fdfdfd).
 */
const PLAIN_PAPER = 0.985;
const PLAIN_TINT = 0.55;

// ---------------------------------------------------------------------------
// The ends of the axis, as what each does to a pigment
// ---------------------------------------------------------------------------
//
// The axis used to touch only the sheet (Harsh whitened the paper, pigments
// rode along), so all three tiers were one palette in three shapes. Now each
// end dresses the pigments too: Softish pulls colour toward chalk, Harsh
// pushes chroma to the gamut wall. The middle stays the tables exactly as
// measured - the fixed reference the other two are relative to.
//
// Both are transforms on the measured tone, not replacement tables - per
// WEARABLE_L's reasoning: deciding lightness/chroma for every board is what
// made every board look alike.

/**
 * Softish: chalk. Lightness pulled mostly to a fixed pastel band, chroma
 * drained and capped - the cap is what makes it pastel; L 0.80 at full chroma
 * is fluorescent, not soft.
 *
 * The drain used to be harder (0.6x, capped at 0.10) - "too far gone": pastel
 * is a lightness statement, and this end was also spending it on saturation.
 * These three numbers deliberately sit on the saturated side of where the eye
 * lands, since a colour a shade too strong is easier to spot than everything
 * gone slightly grey.
 */
const PASTEL_L = 0.80;
const PASTEL_PULL = 0.75;
const PASTEL_C_SCALE = 0.75;
const PASTEL_C_MIN = 0.065;
const PASTEL_C_MAX = 0.13;

/**
 * How the Softish sheet takes its dye: more of it, on slightly deeper paper.
 * The scrapbook end can afford a tinted sheet, unlike the de-tinted extraction
 * default. Exported for tools/gen-tier-palettes.mjs, which dresses the
 * *presets'* sheet literals by the same numbers so CSS and extraction can't
 * drift apart.
 */
export const PASTEL_DYE = 2.6;
export const PASTEL_PAPER_DROP = 0.008;

/**
 * And how the Softish *print* takes it - a different question.
 *
 * The ink used to be the tables' near-black with a light dye (L 0.268, C
 * 0.036) - black with a rumour of tint, the one token still fighting the
 * pastel. So the soft ink is a deep, genuinely chromatic version of the
 * sheet's hue (dark plum on rose, deep pine on mint). The lift buys the chroma
 * room to be seen - much below L 0.30 a dark colour reads as black. Only the
 * body ink lifts; secondary and faint keep their measured ladder.
 *
 * The cap is the pastel cap's bargain: past it, text stops being text. Yellow,
 * which the gamut has no dark vivid version of, clips to sepia - a fine
 * scrapbook answer.
 */
const PASTEL_INK_LIFT = 0.035;
const PASTEL_INK_C_SCALE = 2.8;
const PASTEL_INK_C_MIN = 0.06;
const PASTEL_INK_C_MAX = 0.095;

/**
 * Harsh: poster - quoting Marathon's five values: acid #C2FE0C, blurple
 * #5200FF, black, white, grey.
 *
 * The first attempt asked for chroma 0.40 at each pigment's own lightness and
 * let hex() clip - a no-op on the presets, since they're already at the wall
 * (all four ask for 0.185, differ only in how much their hue can hold).
 *
 * The lever is lightness instead: every hue has a cusp lightness where it
 * holds most chroma, different per hue (chartreuse cusps high, violet dark).
 * Taking a pigment to its own cusp turns green into acid rather than mud.
 *
 * BOLD_C is asked for at the cusp, deliberately past every hue's wall, so
 * hex() answers with the wall itself. The pull dials back from full commitment.
 */
const BOLD_C = 0.40;
const BOLD_CUSP_PULL = 1;
const CUSP_LO = 0.35, CUSP_HI = 0.95, CUSP_STEPS = 24;

/**
 * ...and why the cusp alone is still not the answer for the accent.
 *
 * Marathon pairs an acid with a blurple - opposite ends of lightness. Copying
 * that directly put a chartreuse accent at L 0.92 on near-white paper: no
 * edge on the button, unreadable links.
 *
 * So registers are relative to the ground, not each other: **the accent takes
 * the register opposite the sheet**. On near-white paper that's the dark
 * register - descend the cusp along the wall, as vivid as the hue allows,
 * until the button reads against its board. A hue that already cusps dark
 * barely moves.
 *
 * 3:1, not 4.5:1 - the bar for a component against its background; the
 * label's own contrast is repair()'s separate question. Inverts cleanly for a
 * dark sheet: the accent ascends, the second voice follows.
 */
const BOLD_GROUND = 3;
const BOLD_STEP = 0.02;

/**
 * The second voice, worn in the register the accent left free - the ground's
 * own, since the accent took the opposite.
 *
 * This is where the light cusp went: roles that can hold it (wash, note tint,
 * chip, --highlight) but never text or a fill something must be read against.
 * Nothing here constructs a colour - the register decides how a hue is worn,
 * the hue is still whatever the board or preset actually had.
 */
const BOLD_SECOND_L = 0.80;

/**
 * ...and which hue gets to be loud - a separate question this end got wrong
 * for a while.
 *
 * Found on a real board: five cobalt posters, one green photo, Harsh tier -
 * interface came out entirely green. Nothing misfired (blue won the vote,
 * became the sheet, accent went to the counter-hue as intended), but at this
 * tier sheet and ink are erased to near-white/near-black, so the majority hue
 * disappears while the minority owns the screen.
 *
 * So at this tier the seats swap: **the vote's winner takes the accent**,
 * worn opposite the sheet like any accent here, and the displaced
 * counter-colour becomes the second voice in the light register. Every other
 * tier keeps rolesFor()'s answer. A hand-picked colour is untouched.
 *
 * The nudge is the one liberty taken with a hue anywhere in this file: the
 * second voice may turn up to COMPLEMENT_TURN degrees towards the accent's
 * complement, no further (measured board: chartreuse 127 -> 102, still acid,
 * tuned to the blue beside it). A single-hue winner is left alone entirely.
 */
const BOLD_DEEP_L = 0.475;
const COMPLEMENT_TURN = 25;

/**
 * The bold sheet's inks and rules: near-black text, hard hairlines, fixed
 * rather than transformed - the poster's typography, same at every hue, so the
 * accent is the only loud thing. Papers are not here; they keep PLAIN_PAPER
 * above, already the white this end wants.
 */
const BOLD_SHEET: Record<string, Tone> = {
  '--ink':    { L: 0.135, C: 0.012 },
  '--ink-2':  { L: 0.310, C: 0.018 },
  '--ink-3':  { L: 0.480, C: 0.022 },
  '--rule':   { L: 0.800, C: 0.008 },
  '--rule-2': { L: 0.640, C: 0.012 },
};

/** A pigment dressed for the soft end. Exported for tools/gen-tier-palettes.mjs. */
export const pastel = (t: Tone): Tone => ({
  L: t.L + (PASTEL_L - t.L) * PASTEL_PULL,
  C: clamp(t.C * PASTEL_C_SCALE, PASTEL_C_MIN, PASTEL_C_MAX),
});

/**
 * An ink dressed for the soft end. `token` because only the body ink takes the
 * lift - see PASTEL_INK_LIFT. Exported for tools/gen-tier-palettes.mjs.
 */
export const pastelInk = (t: Tone, token: string): Tone => ({
  L: t.L + (token === '--ink' ? PASTEL_INK_LIFT : 0),
  C: clamp(t.C * PASTEL_INK_C_SCALE, PASTEL_INK_C_MIN, PASTEL_INK_C_MAX),
});

/**
 * Where this hue holds its most colour.
 *
 * Sampled, not solved - a closed form needs per-hue face-of-the-solid logic,
 * and this runs a handful of times per palette on a single-maximum curve, so a
 * coarse walk suffices. Range stops short of both ends: near-black or
 * near-white holds almost no chroma whatever the hue.
 */
export function cuspL(h: number): number {
  let best = CUSP_LO, most = -1;
  for (let i = 0; i <= CUSP_STEPS; i++) {
    const L = CUSP_LO + (CUSP_HI - CUSP_LO) * (i / CUSP_STEPS);
    const c = maxChroma(L, h, BOLD_C);
    if (c > most) { most = c; best = L; }
  }
  return best;
}

/**
 * A pigment dressed for the plain end: taken to its hue's cusp and asked for
 * more chroma than sRGB holds there, so hex() answers with the wall.
 * Exported for tools/gen-tier-palettes.mjs.
 */
export const bolden = (t: Tone, h: number): Tone =>
  ({ L: t.L + (cuspL(h) - t.L) * BOLD_CUSP_PULL, C: BOLD_C });

/**
 * The plain end's two supporting registers, at the wall. The hue is the
 * caller's; neither touches it.
 *
 * `boldSecond` (light) is the only one an extraction uses - the winner takes
 * the accent and is already the deep voice. `boldDeep` is for the four
 * authored palettes, whose accent was chosen by a person and can't move - a
 * preset with a spare dominant hue wears it deep. Both exported for
 * tools/gen-tier-palettes.mjs.
 */
export const boldSecond = (): Tone => ({ L: BOLD_SECOND_L, C: BOLD_C });
export const boldDeep = (): Tone => ({ L: BOLD_DEEP_L, C: BOLD_C });

/**
 * `h` turned towards `target` by at most `limit` degrees, the signed shortest
 * way round - so a hue at 350 turns forwards past 0 rather than the long way
 * down through the greens. warmer() and the plain end's complement nudge are
 * the same move at different anchors.
 */
const toward = (h: number, target: number, limit: number) => {
  const d = ((target - h + 540) % 360) - 180;
  return h + Math.sign(d) * Math.min(Math.abs(d), limit);
};

/**
 * A bold accent walked down the wall until it can be seen on its own sheet.
 *
 * Every step re-asks for BOLD_C, so hex() hands back the wall at *that*
 * lightness rather than the cusp's chroma carried down - as loud as the hue
 * allows the whole way. Stops at CUSP_LO to avoid a loop on a ground no colour
 * can clear. Exported for tools/gen-tier-palettes.mjs.
 */
export function toGround(t: Tone, h: number, paper: string): Tone {
  let L = t.L;
  while (L > CUSP_LO && contrast(hex(L, t.C, h), paper) < BOLD_GROUND) L -= BOLD_STEP;
  return { L: Math.max(L, CUSP_LO), C: t.C };
}

/**
 * Where the plain end's second voice sits: its own hue, nudged at most
 * COMPLEMENT_TURN degrees towards the accent's complement.
 *
 * Returns null when the two match - a one-hue board has no second voice to
 * find, and turning its only hue would invent one. Caller decides which hue is
 * asked about: extraction hands over the counter-colour, gen-tier-palettes.mjs
 * hands over each preset's paper (a preset's accent is authored, not won).
 */
export function counterTurn(h: number, accentH: number): number | null {
  if (apart(h, accentH) < MIN_SEP) return null;
  return (toward(h, accentH + 180, COMPLEMENT_TURN) + 360) % 360;
}

/** What a tier does to one pigment, given the hue it will be worn at. */
type Dress = (t: Tone, h: number) => Tone;

/** The middle: the tables as measured, untouched by design. */
const asIs: Dress = t => t;

const dressFor = (tier: number | undefined): Dress =>
  tier === 0 ? t => pastel(t) : tier === 2 ? bolden : asIs;

/**
 * The tables, bent by what the photographs are. Null traits leaves them be.
 *
 * The square root keeps this a dial rather than a switch - a straight ratio
 * pins to one stop or the other for nearly every real board (measured: 3 of 4
 * pinned). Under a root the middle stays responsive and extremes arrive
 * slowly, the honest shape since 2x the chroma in a photo isn't 2x the colour
 * in a palette.
 *
 * Every field of `traits` is optional and independent - a hand-picked colour
 * brings no photographs but is still subject to the axis.
 */
function temper(traits: Traits) {
  const scale = traits?.vivid != null
    ? clamp(Math.sqrt(traits.vivid / REF_VIVID), VIVID_FLOOR, VIVID_CEIL) : 1;
  const key = traits?.key != null
    ? clamp((traits.key - REF_KEY) * KEY_GAIN, -KEY_DOWN, KEY_UP) : 0;
  // The axis overrules the photographs about the paper: at the plain end the
  // sheet is white because that's what that end *is*, not because the
  // pictures were bright. Bold inks/rules are the axis's one reach past the
  // paper - fixed in BOLD_SHEET above.
  const bold = traits?.tier === 2, soft = traits?.tier === 0;
  const shift = bold ? PLAIN_PAPER - SHEET['--paper'].L
    : key - (soft ? PASTEL_PAPER_DROP : 0);
  const paperDye = bold ? scale * PLAIN_TINT : soft ? scale * PASTEL_DYE : scale;
  const inkDye = bold ? scale * PLAIN_TINT : scale;
  const sheet: Record<string, Tone> = {}, pigment: Record<string, Tone> = {};
  for (const [key, { L, C }] of Object.entries(SHEET)) {
    const paper = PAPERS.includes(key);
    // The soft inks are the one part of the sheet that's a colour of its own,
    // not a dye - see PASTEL_INK_LIFT. Everything else is the table moved and scaled.
    sheet[key] = bold && BOLD_SHEET[key] ? { ...BOLD_SHEET[key] }
      : soft && !paper ? pastelInk({ L, C: C * scale }, key)
      : { L: paper ? clamp(L + shift, 0, 1) : L, C: C * (paper ? paperDye : inkDye) };
  }
  for (const [key, { L, C }] of Object.entries(PIGMENT)) pigment[key] = { L, C: C * scale };
  return { sheet, pigment, leafy: { L: LEAFY.L, C: LEAFY.C * scale } };
}

/**
 * What the repair pass will not let through.
 *
 * Floors, not targets - the presets clear these comfortably. Body ink is held
 * to AA for normal text against its sheet; the secondary ink to the
 * large-text ratio, since that's what it's used for; the accent has to carry
 * a button.
 */
const FLOOR = {
  '--ink': 7,
  '--ink-2': 4.5,
  '--ink-3': 2.2,
};
const ACCENT_FLOOR = 4.5;

/**
 * A full set of pigment tokens from one to three hues.
 *
 * `hues` is either bare angles or peaksOf()'s `{ h, standing }`. Extraction
 * hands over the second so rolesFor() ranks on board share; anything that only
 * knows an angle gets the old distance rule, right when there's no board to weigh.
 *
 * `traits` is what the photographs were - see temper(). Absent, the tables
 * stand as measured.
 *
 * Exported separately from extractPalette() so the rule can be tested on hues
 * chosen to break it, without going through a histogram first.
 */
export function paletteFor(hues: (number | Peak)[], traits: Traits = null) {
  if (!hues.length) return null;
  return build(rolesFor(hues), traits);
}

function build(roles: Roles, traits: Traits): Vars {
  const { sheet, pigment, leafy } = temper(traits);
  // The axis dresses every pigment after measurement and the dials have said
  // their piece - a pastel is a pastel *of this board's colour*, and a bold
  // accent clips to its own hue's wall rather than a table's.
  const dress = dressFor(traits?.tier);
  const vars: Vars = {};

  for (const [key, { L, C }] of Object.entries(sheet)) vars[key] = hex(L, C, roles.sheet);

  // What the accent is made of: the photographs' own lightness/chroma at that
  // hue where measured, the tables where not. Normalised here rather than at
  // each hex() call, since the cusp search dresses by hue and needs the final
  // printed angle.
  const bold = traits?.tier === 2;
  // At the plain end the seats swap: the vote's winner takes the accent and
  // the counter-colour rolesFor() picked becomes the second voice - see the
  // COMPLEMENT_TURN block. Only for a multi-hue board; a one-hue board has no
  // seats to swap.
  const swap = bold && apart(roles.sheet, roles.accent) >= MIN_SEP;
  const accentH = ((swap ? roles.sheet : roles.accent) + 360) % 360;
  // The second voice, nudged towards the accent's complement - and where the
  // seats swapped, the third real hue moves to the wash.
  const secondH = (swap ? counterTurn(roles.accent, accentH) : roles.leafy) ?? roles.leafy;
  const leafyH = (secondH + 360) % 360;
  const washH = ((swap ? roles.leafy : roles.warm) + 360) % 360;

  // At the plain end the accent is two colours depending on fill vs text:
  // --accent stays at the cusp, --accent-text walks down the wall until
  // legible on the sheet above. Elsewhere the two are one colour and the
  // stylesheet aliases the second.
  const accentTone = swap ? roles.tone?.sheet : roles.tone?.accent;
  const accentInk = dress(wearable(accentTone) || pigment['--accent'], accentH);
  if (bold) {
    const text = toGround(accentInk, accentH, vars['--paper']);
    vars['--accent-text'] = hex(text.L, text.C, accentH);
  }
  const leafyBase = wearable(roles.tone?.leafy) || leafy;
  const leafyInk = bold ? boldSecond() : dress(leafyBase, leafyH);

  for (const [key, { L, C }] of Object.entries(pigment)) {
    // --accent-warm is the one pigment no photograph supplied (rolesFor() turns
    // it out of the sheet's hue), so it keeps the table, bent by the vivid
    // dial and dressed like everything else.
    if (key === '--accent-warm') {
      const warm = bold ? boldSecond() : dress({ L, C }, washH);
      vars[key] = hex(warm.L, warm.C, washH);
      continue;
    }
    // --accent-deep derives from the dressed accent rather than dressing
    // itself, so it stays the accent's own darker twin at every tier.
    const ink = key === '--accent-deep' ? deepen(accentInk) : accentInk;
    vars[key] = hex(ink.L, ink.C, accentH);
  }

  // Told apart by lightness when hue can't - see ANALOGOUS. Dropped rather
  // than raised, since --leafy is a wash on a light sheet with room downwards.
  //
  // Not at the plain end, where both supporting voices already sit at a named
  // lightness chosen against the accent's - dropping further would spend the
  // register on a separation it already made.
  const crowded = !bold && apart(roles.accent, roles.leafy) < ANALOGOUS;
  vars['--leafy'] =
    hex(crowded ? leafyInk.L - LEAFY_DROP : leafyInk.L, leafyInk.C, leafyH);

  return repair(vars, roles, sheet, accentInk, traits?.tier);
}

/**
 * Push lightness apart until the palette is legible, and say so if it can't be.
 *
 * Only L moves. Hue is the photographs' answer, not ours to change; chroma
 * keeps the palette tinted rather than saturated, and spending it here trades
 * legibility for grey. Lightness is the axis contrast is made of - the whole
 * reason this file works in OKLab.
 *
 * Works from the tempered tables it's handed, not from SHEET/PIGMENT directly
 * - a vivid board's ink already starts with more chroma, and re-deriving from
 * the means would quietly undo that. `accentInk` is the fallback target below.
 */
function repair(vars: Vars, roles: Roles, sheet: Record<string, Tone>, accentInk: Tone,
  tier?: number): Vars {
  const paper = vars['--paper'];
  for (const [key, floor] of Object.entries(FLOOR)) {
    const { C } = sheet[key];
    let { L } = sheet[key];
    for (let i = 0; i < 40 && contrast(vars[key], paper) < floor; i++) {
      L = Math.max(0, L - 0.02);
      vars[key] = hex(L, C, roles.sheet);
      if (L === 0) break;
    }
  }

  // The accent carries a button, and what sits on it is the sheet mixed
  // towards white - tested as it will actually render, not against nominal
  // white. A hue that can't clear the floor with a light label gets a dark
  // one instead (Peacock's gold needed this by hand).
  const light = mixHex(paper, '#ffffff', 0.55);

  // Neither end lets the darkening loop run - it would be the axis overruling
  // itself. A pastel accent can never hold a light label (darkening un-pastels
  // it); a bold accent is already walked as far down its wall as its *sheet*
  // needed (toGround()), and walking further for its *label* spends the
  // tier's loudness on a contrast that has a second answer. So the label is
  // chosen instead: whichever of ink or light mix wins - ink on a pastel,
  // light mix on nearly every bold accent.
  if (tier === 0 || tier === 2) {
    vars['--accent-fg'] =
      contrast(vars['--accent'], vars['--ink']) >= contrast(vars['--accent'], light)
        ? vars['--ink'] : light;
    return alias(vars);
  }
  const { C } = accentInk;
  let { L } = accentInk;
  for (let i = 0; i < 40 && contrast(vars['--accent'], light) < ACCENT_FLOOR; i++) {
    L = Math.max(0, L - 0.02);
    vars['--accent'] = hex(L, C, roles.accent);
    if (L === 0) break;
  }
  // Always named, never left to the stylesheet default - an extraction that
  // needed the dark label shouldn't leave it for the next one that doesn't,
  // since applying a look adds tokens and only a changed look removes them.
  vars['--accent-fg'] = light;
  if (contrast(vars['--accent'], light) < ACCENT_FLOOR) {
    // Darkening didn't get there - yellows run out of gamut before lightness.
    // Flip the label to ink, restore the accent's wanted lightness.
    vars['--accent'] = hex(accentInk.L, accentInk.C, roles.accent);
    vars['--accent-fg'] = vars['--ink'];
  }
  return alias(vars);
}

/**
 * --accent-text, wherever the tier didn't give it one of its own.
 *
 * Written out rather than left to the stylesheet's `var(--accent)` default,
 * same reason as --accent-fg: applying a look only adds tokens, so a Harsh
 * palette's wall-descended value would otherwise leak into the next palette
 * built at another tier. Last thing to touch the accent is repair() above,
 * hence here and not build().
 */
function alias(vars: Vars): Vars {
  vars['--accent-text'] ||= vars['--accent'];
  return vars;
}

/**
 * A whole palette from one chosen colour.
 *
 * What the Pigment control does now. Picking an accent used to move one token
 * while the sheet stayed put, with a second control for paper - easy to put
 * out of tune, and a blue accent on a cream sheet was the easiest mistake.
 *
 * The exact colour picked is kept - unlike paletteFor(), which has no opinion
 * to honour: someone who picks #3355ff and gets a different blue back has been
 * overruled by their own picker. So the hue builds the sheet and the pick
 * itself stands as `--accent`.
 *
 * Which means repair() can't darken the accent for its contrast floor - that
 * would overrule the pick. The label moves instead: whichever of light mix or
 * ink reads better.
 *
 * Monochrome where an extraction isn't: the pick is both sheet hue and accent,
 * so --accent-deep stays its darker twin. Sending the accent across the wheel
 * the way rolesFor() does would answer a question nobody asked.
 */
export function paletteFromAccent(picked: string, { tier = 1 }: { tier?: number } = {}) {
  if (!/^#[0-9a-f]{6}$/i.test(picked)) return null;
  const chosen = picked.toLowerCase();
  const { C, h } = oklch(...parseHex(chosen));
  // A grey has no hue to build from - every direction is equally wrong, and
  // the bins would hand back rounding noise.
  if (C < NEUTRAL_C) return null;

  const vars = build(
    { sheet: h, accent: h, leafy: (h + LEAFY_SOLO_TURN) % 360, warm: warmer(h) },
    // The axis applies to a hand-picked colour exactly as to an extracted one
    // - sheet and other pigments dress for the tier - but the pick itself
    // stands at every stop; dressing it pastel or bold would overrule it.
    { tier });
  vars['--accent'] = chosen;
  // The text form follows the pick, not the built palette, even at the plain
  // end - the wall descent is a statement about a colour the extraction
  // *chose*, and running it on a typed colour is the same overruling.
  vars['--accent-text'] = chosen;
  const light = mixHex(vars['--paper'], '#ffffff', 0.55);
  vars['--accent-fg'] =
    contrast(chosen, light) >= contrast(chosen, vars['--ink']) ? light : vars['--ink'];
  return vars;
}

// ---------------------------------------------------------------------------
// The dark sheet
// ---------------------------------------------------------------------------

/**
 * Where the dark sheet sits at each tier, in OKLCh L. Softish a shade lifted,
 * so it is still a coloured paper rather than a night; Harsh nearest black,
 * the poster that acid colours were made for (tokens.css, 3b).
 */
const DARK_PAPER = [0.245, 0.215, 0.175];
/**
 * How deep each palette's night goes, from how dark its light ink was. In the
 * light the four sheets agree about white and are told apart by their print -
 * Orca's 16:1 ink against Tea rose's softer one (tokens.css, section 2). In the
 * dark that difference moves to the sheet, or the four are one charcoal: Orca
 * the deepest, Tea rose the softest. The middle only; the ends have a sheet of
 * their own already.
 */
const DARK_DEPTH = 0.6, DARK_DEPTH_MAX = 0.03;
/**
 * How much of its own hue the dark sheet takes, against the light one's. A
 * light sheet is held near neutral so it does not cast the photographs, and
 * at the bottom of the scale the same chroma reads as none at all, which left
 * four palettes on one grey. Capped per tier, below any cast a picture shows.
 */
const DARK_SHEET_DYE = 2.2;
const DARK_SHEET_C = [0.024, 0.016, 0.012];
/**
 * The one hue a dark sheet may not keep. A light sheet at 90 degrees is cream;
 * the same angle at the bottom of the scale is olive-brown, and every surface
 * built from it - cards, wells, the notes mixed into them - goes the colour of
 * mud. Papyrus's Softish board was all of it. Warm sheets in that band are
 * turned towards red, where dark and warm is walnut or leather, by up to
 * DARK_UNMUD degrees at the band's middle and nothing at its edges, so Absinthe's
 * green-gold and Tea rose's pink do not move. Its chroma stays: drained to a
 * warm charcoal it was tried, and lost the board its warmth.
 */
const MUD_H = 90, MUD_WIDTH = 25, DARK_UNMUD = 36;
/**
 * Where the accent climbs when that turn brings the sheet near it. Turning
 * Papyrus's cream out of the mud put the walnut 6 degrees from its terracotta,
 * where in the light the two stand 43 apart, and the orange melted into the
 * board. Turning the accent away was tried and made it coral - pink, not
 * Papyrus. It keeps its hue and stands off by lightness instead: a lighter
 * orange, by as much of the way here as the hues lost of their 16 degrees.
 */
const DARK_NEAR_L = 0.71, DARK_NEAR_SPAN = 16;
const unmud = (h: number) =>
  h - DARK_UNMUD * Math.max(0, 1 - Math.abs(((h - MUD_H + 540) % 360) - 180) / MUD_WIDTH);
/** The print on it. Not white: white on near-black is glare, not type. */
const DARK_INK = 0.93;
/** A card stands above the sheet, and in the dark nearer is lighter. */
const DARK_CARD_LIFT = 0.045;
/** Under 1 spreads the steps nearest the sheet, which the eye reads smaller in the
 *  dark - and keeps the hover well (--paper-2) clear above the card it shows on. */
const DARK_SPREAD = 0.7;
/** The most colour light print may carry before it reads as coloured type, per tier:
 *  Softish writes in a coloured pen, Harsh in white. */
const DARK_PRINT_C = [0.06, 0.04, 0.025];
/** The accent has to read as words on the dark sheet; washes and second voices only as marks. */
const DARK_ACCENT_GROUND = 4.5;
/** 3 let leafy through at L 0.57, a mud nobody would call a second voice. */
const DARK_VOICE_GROUND = 3.6;
/** How much of the light accent-to-deep step --accent-deep keeps, taken the other way. */
const DARK_DEEP_SHARE = 0.7;
/** How far up a pigment may climb towards its hue's cusp - see lift(). The
 *  second voices stop a step under the accent, so the three stay told apart
 *  by lightness as well as hue, as the light palettes are. */
const DARK_REACH = 0.72;
const DARK_VOICE_REACH = 0.64;
/** Above this a deeper accent has no room to rise, and goes down instead - Harsh's neon. */
const DARK_DEEP_ROOF = 0.88;

/** How far across --rule-2 may go. Harsh draws its lines at full ink, which in the
 *  dark is a white line that glares; this keeps every tier's line a line. */
const DARK_LINE = 0.42;
/** The sheet's ramp: every token between paper and ink, each keeping its place on the way across. */
const RAMP = ['--paper-2', '--paper-3', '--rule', '--rule-2', '--ink', '--ink-2', '--ink-3'];

/**
 * A pigment raised until it clears `ground` against the dark sheet - toGround()
 * turned upwards - keeping its place against the wall rather than its chroma.
 * A preset's accent is the wall at its light lightness, and carrying that
 * clipped number up left Absinthe's acid an olive and Orca's teal a grey-green;
 * the same share of what the hue holds at the new lightness is the same colour,
 * risen. A photograph's softer pigment keeps its softness the same way.
 */
function lift(t: Tone, h: number, paper: string, ground: number, reach = DARK_REACH, near = 0): Tone {
  const share = clamp(t.C / Math.max(maxChroma(t.L, h, BOLD_C), 1e-4), 0, 1);
  const at = (L: number) => share * maxChroma(L, h, BOLD_C);
  let L = t.L;
  while (L < CUSP_HI && contrast(hex(L, at(L), h), paper) < ground) L += BOLD_STEP;
  // And on towards where the hue holds most colour, if that is higher: a teal
  // clears the ground at L 0.59 with a tenth of the chroma it has at its cusp.
  // Capped, so a light-cusping hue stays a pigment and does not become a light.
  L = Math.min(Math.max(L, Math.min(cuspL(h), reach)), CUSP_HI);
  // A sheet that came near the pigment's hue: the rest of the way, by lightness.
  // Up there the wall is lower, so the share would wash it out: that climb goes at full colour.
  if (near > 0) {
    L = Math.max(L, L + (DARK_NEAR_L - L) * near);
    const wall = maxChroma(L, h, BOLD_C);
    return { L, C: at(L) + (wall - at(L)) * near };
  }
  return { L, C: at(L) };
}

/**
 * A light palette's dark twin, token for token.
 *
 * One transform for everything: the four presets go through it once, in
 * tools/gen-dark-palettes.mjs, and a Dynamic or hand-picked palette goes
 * through it every time it is painted, so a board looks dark by the same
 * rules whatever its colours came from. The board keeps the light palette;
 * this is only what the screen shows, which is why a board saved in the dark
 * opens light on a light machine.
 *
 * The ramp is mirrored rather than inverted: each token keeps how far it sat
 * from the paper towards the ink, so a well is still a step off the sheet and
 * a rule still a line. The card is the exception, lifted above the sheet
 * instead of sinking under it. Pigments keep their hue and chroma and only
 * rise, to where they read on the dark - toGround()'s walk, the other way.
 *
 * Only tokens the input carries as #rrggbb come back. `tier` picks the sheet.
 */
export function darkSheet(vars: Vars, tier = 1): Vars {
  const read = (key: string) =>
    (/^#[0-9a-f]{6}$/i.test(vars[key] || '') ? oklch(...parseHex(vars[key])) : null);
  const paper = read('--paper'), ink = read('--ink');
  const sheetH = unmud(paper?.h ?? ink?.h ?? 0);
  const fromP = paper?.L ?? SHEET['--paper'].L, fromI = ink?.L ?? SHEET['--ink'].L;
  const depth = tier === 1
    ? clamp((fromI - SHEET['--ink'].L) * DARK_DEPTH, -DARK_DEPTH_MAX, DARK_DEPTH_MAX) : 0;
  const P = (DARK_PAPER[tier] ?? DARK_PAPER[1]) + depth;
  const printC = DARK_PRINT_C[tier] ?? DARK_PRINT_C[1];
  const sheetC = Math.min((paper?.C ?? 0) * DARK_SHEET_DYE, DARK_SHEET_C[tier] ?? DARK_SHEET_C[1]);
  const ground = hex(P, sheetC, sheetH);
  const out: Vars = {};
  if (paper) out['--paper'] = ground;

  // The sheet's hue, not the card's own: a near-white card's angle is rounding noise.
  if (read('--paper-card')) out['--paper-card'] = hex(P + DARK_CARD_LIFT, sheetC, sheetH);
  // The three ink floors, asked by any ramp token's name.
  const floors: Partial<Record<string, number>> = FLOOR;
  for (const key of RAMP) {
    const t = read(key);
    if (!t) continue;
    const at = clamp((fromP - t.L) / Math.max(fromP - fromI, 0.1), 0, key === '--rule-2' ? DARK_LINE : 1);
    let L = P + at ** DARK_SPREAD * (DARK_INK - P);
    // The paper's half of the ramp takes the sheet's dye, or the wells and rules
    // read greyer than the sheet they are cut into; the print's half its own.
    const C = at < 0.5 ? Math.min(t.C * DARK_SHEET_DYE, DARK_SHEET_C[tier] ?? DARK_SHEET_C[1])
      : Math.min(t.C, printC);
    // And the sheet's turn out of the mud; light print in that band is cream, and stays.
    const h = at < 0.5 ? unmud(t.h) : t.h;
    // The light floors, held the other way: up, not down.
    const floor = floors[key];
    while (floor && L < 1 && contrast(hex(L, C, h), ground) < floor) L += 0.02;
    // A line stands off the dark as far as it stood off the light, and no further:
    // placed by position alone, a rule came out twice as strong, a white outline.
    if (paper && (key === '--rule' || key === '--rule-2')) {
      const was = contrast(vars[key], vars['--paper']);
      while (L > P && contrast(hex(L, C, h), ground) > was) L -= 0.01;
    }
    out[key] = hex(Math.min(L, 1), C, h);
  }

  const accent = read('--accent');
  if (accent) {
    const lost = paper ? apart(paper.h, accent.h) - apart(sheetH, accent.h) : 0;
    const accentH = accent.h;
    const a = lift(accent, accentH, ground, DARK_ACCENT_GROUND, DARK_REACH, clamp(lost / DARK_NEAR_SPAN, 0, 1));
    out['--accent'] = hex(a.L, a.C, accentH);
    // Already readable as words, so the text form is the fill again.
    if (vars['--accent-text']) out['--accent-text'] = out['--accent'];
    const deep = read('--accent-deep');
    if (deep) {
      const step = (accent.L - deep.L) * DARK_DEEP_SHARE;
      const L = a.L + step <= DARK_DEEP_ROOF ? a.L + step : a.L - step;
      out['--accent-deep'] = hex(L, a.C * (accent.C ? deep.C / accent.C : 1), deep.h);
    }
    // A raised accent wants a dark label, nearly always: whichever reads better.
    const under = hex(Math.max(P - 0.06, 0.1), sheetC, sheetH);
    const over = hex(0.985, sheetC / 2, sheetH);
    if (vars['--accent-fg']) {
      out['--accent-fg'] = contrast(out['--accent'], under) >= contrast(out['--accent'], over) ? under : over;
    }
  }
  for (const key of ['--accent-warm', '--leafy']) {
    const t = read(key);
    if (!t) continue;
    const v = lift(t, t.h, ground, DARK_VOICE_GROUND, DARK_VOICE_REACH);
    out[key] = hex(v.L, v.C, t.h);
  }
  return out;
}

/** Halfway between two hues, the short way round the wheel. */
function midHue(a: number, b: number) {
  const d = ((b - a + 540) % 360) - 180;
  return (a + d / 2 + 360) % 360;
}

/** A hue turned towards the ambers, by WARM_TURN at most. */
function warmer(h: number) {
  return toward(h, WARM_ANCHOR, WARM_TURN);
}

/**
 * The whole job: pixels in, tokens out.
 *
 * Returns null rather than a grey palette when the pictures have no colour
 * worth taking - a B&W board, or nothing at all. The caller's move then is to
 * leave the look alone, which null says and an all-neutral palette doesn't.
 */
export function extractPalette(chunks: Chunk[], { tier = 1 }: { tier?: number } = {}) {
  const board = readBoard(chunks);
  // The rich peaks, not huesOf()'s bare angles: rolesFor() ranks on standing,
  // which huesOf() drops on its way out.
  const hues = peaksOf(board);
  if (!hues.length) return null;
  return paletteFor(hues, { vivid: board.vivid, key: board.key, tier });
}

/**
 * The dominant colours of one picture, as `#rrggbb` strings, strongest first.
 *
 * Same read the Dynamic palette does (readBoard()'s vote, peaksOf()'s ranked
 * peaks) but stopped a step earlier: hands back each peak's *measured* tone
 * rather than synthesising a styled sheet, which is what a swatch wants. A
 * peak with no measured tone is skipped rather than invented at a table value.
 *
 * Takes one chunk, so a caller sampling a single image gets only that image's
 * colours. Returns fewer than `n` for a picture with fewer distinct hues, and
 * nothing for a picture with no colour worth taking.
 */
export function dominantColors(chunk: Chunk, n = 5) {
  const peaks = peaksOf(readBoard([chunk]));
  const out = [];
  for (const p of peaks) {
    if (out.length >= n) break;
    if (!p.tone) continue;
    out.push(hex(p.tone.L, p.tone.C, p.h));
  }
  return out;
}

// ---------------------------------------------------------------------------
// Reading the board
// ---------------------------------------------------------------------------

/**
 * How many pictures a palette is read from when nobody says, newest first.
 *
 * Was a hard ceiling, now a default: `paletteSources: 0` means every picture
 * and arrives here as ALL_SOURCES_MAX. The ceiling was never about
 * correctness (a palette from forty photos is fine) but about decode cost -
 * asking for all of them means paying it. Each picture counts the same
 * whatever its size or vividness - see huesOf().
 */
export const MAX_SOURCES = 24;

/** The hard cap on "Every photo": past about 120 the hues converge and only the cost grows. */
export const ALL_SOURCES_MAX = 120;

/** Each one drawn this big. 48x48 is 2304 pixels, and enough to vote with. */
const SAMPLE = 48;

/**
 * Pixels from a list of image URLs.
 *
 * Downscaled hard on the way in - not just for speed: drawing into 48x48
 * averages the photo, close enough to a blur that single-pixel noise and JPEG
 * artefacts stop voting. Full size would answer a question nobody asked.
 *
 * Failures are skipped rather than thrown - one undecodable picture should
 * cost its own vote and nothing else.
 */
export async function samplePixels(urls: string[], limit = MAX_SOURCES) {
  const ctx = sampler();
  if (!ctx) return [];
  // A falsy limit is the default, not none: 0 reaching here means a caller
  // that hasn't looked the setting up, not "read nothing".
  const asked = limit || MAX_SOURCES;
  const n = Math.max(1, Math.min(asked, ALL_SOURCES_MAX));
  const out = [];
  for (const url of urls.slice(0, n)) {
    try {
      const src = await frameFor(url);
      // One canvas for all of them, cleared between pictures - a transparent
      // PNG would otherwise vote with whatever was underneath it.
      ctx.clearRect(0, 0, SAMPLE, SAMPLE);
      ctx.drawImage(src, 0, 0, SAMPLE, SAMPLE);
      out.push(ctx.getImageData(0, 0, SAMPLE, SAMPLE).data);
      // Only the bitmap half of frameFor()'s answer has this - the <img>
      // fallback doesn't, which the optional call already says.
      if ('close' in src) src.close();
    } catch { /* one picture, one lost vote */ }
  }
  return out;
}

/**
 * Somewhere to draw 48x48, whatever the browser has.
 *
 * OffscreenCanvas first (puts nothing in the document), a real <canvas>
 * otherwise - which used to mean the whole feature failed silently rather than
 * falling back, since the throw landed in the same catch as "this PNG is corrupt".
 */
function sampler() {
  try {
    if (typeof OffscreenCanvas === 'function') {
      const ctx = new OffscreenCanvas(SAMPLE, SAMPLE)
        .getContext('2d', { willReadFrequently: true });
      if (ctx) return ctx;
    }
  } catch { /* fall through to the DOM */ }
  if (typeof document === 'undefined') return null;
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = SAMPLE;
  return canvas.getContext('2d', { willReadFrequently: true });
}

/**
 * The picture at `url`, as something drawImage() will take.
 *
 * Fetched and decoded as a blob rather than handed to an <img> src, because an
 * <img> decides what it's decoding from the MIME type: Chrome sniffs bytes
 * when the type is missing, Firefox doesn't, so a type-less asset extracted in
 * one browser and not the other, silently. createImageBitmap() takes the
 * bytes themselves and has no such opinion; the <img> path is the fallback for
 * anything without it.
 */
async function frameFor(url: string): Promise<ImageBitmap | HTMLImageElement> {
  if (typeof createImageBitmap === 'function' && typeof fetch === 'function') {
    try {
      return await createImageBitmap(await (await fetch(url)).blob());
    } catch { /* fall through to the element */ }
  }
  const img = new Image();
  img.src = url;
  await img.decode();
  return img;
}
