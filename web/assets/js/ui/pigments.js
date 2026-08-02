// A palette read off the pictures on the board.
//
// The rule this follows is not 60-30-10. That was tried on the four presets,
// measured, and abandoned - see research/old/decisions-2026-07-25.md - because the
// "30" band on this surface is text and hairlines, a few percent of the pixels
// whatever colour they are printed in. What is followed instead is the scheme
// the presets were built on, with the one addition every colour-theory account
// of an interface agrees on: an analogous base and a contrasting colour for the
// thing you are meant to click.
//
//   - one to three hues, taken from what the photographs contain;
//   - a sheet and a dark ink of the *dominant* hue, which keeps the 60 in one
//     family - but at a chroma somebody would have to be told about. The sheet
//     used to be dyed well into that hue, on the reasoning that a tinted sheet
//     is what makes a palette read as a palette; what it actually did was cast
//     every photograph pinned to it, which on a board is the content losing an
//     argument with the frame. The saturation moved to the pigments;
//   - every other pigment taken from the photographs too, never constructed:
//     the accent is the board's own second colour, the one furthest from the
//     sheet, and a board of one colour gets a palette in one colour. Contrast
//     between the button and the page is the standard advice and was tried -
//     see rolesFor() for why an accent nobody photographed lost to one they
//     did;
//   - --leafy for whatever colour is left over, and a lightness split between
//     any two voices that land too close to tell apart by hue alone;
//   - a pigment's lightness and chroma read off the pixels of its own hue, not
//     only its angle. This was the last thing the presets still decided for
//     every board, and deciding it for every board is what made every board
//     look alike: a dusty photograph and a neon one at the same hue printed the
//     same button. The tables are still the reference, and are what a hue with
//     no photograph behind it gets - see WEARABLE_L for the two bounds a
//     measurement has to stay inside to be a pigment at all;
//   - the sheet's own chroma and lightness bent by what the photographs are -
//     vivid pictures get a stronger cast, dark ones a deeper sheet - but bent
//     within bounds measured off the presets, never freely;
//   - and a repair pass afterwards, because a palette that came out of a
//     photograph has no reason to be legible and every one of these has to be.
//
// Everything here is pure. Reading pixels off the board needs a canvas and
// lives in samplePixels() at the foot of the file, which is the only function
// that touches the DOM and the only one the tests do not call - they hand
// extractPalette() the pixels directly, which is also how a failing board can
// be reproduced from its colours rather than from its photographs.

import { PALETTE_TOKENS } from '../layout-settings.js';
export { PALETTE_TOKENS };

// ---------------------------------------------------------------------------
// Colour
// ---------------------------------------------------------------------------
//
// OKLab rather than HSL, and this is the decision the whole file rests on.
// HSL's lightness is not lightness: #ff0000 and #0000ff are both "50%" in HSL
// and one of them is nearly three times brighter than the other. Clustering
// hues in HSL therefore groups by something nobody sees, and holding a palette
// to a contrast ratio afterwards would fight the clustering the whole way.
// OKLab's L is perceptual, so "same lightness, different hue" means it.

const cbrt = Math.cbrt;

/** sRGB 0-255 -> linear-light 0-1. */
const toLinear = c => {
  c /= 255;
  return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
};

/** linear-light 0-1 -> sRGB 0-255, clamped. */
const toSrgb = c => {
  const v = c <= 0.0031308 ? c * 12.92 : 1.055 * c ** (1 / 2.4) - 0.055;
  return Math.round(Math.min(1, Math.max(0, v)) * 255);
};

/** sRGB 0-255 -> OKLCh. Hue in degrees, 0-360; L and C in OKLab's own units. */
export function oklch(r, g, b) {
  const R = toLinear(r), G = toLinear(g), B = toLinear(b);
  const l = cbrt(0.4122214708 * R + 0.5363325363 * G + 0.0514459929 * B);
  const m = cbrt(0.2119034982 * R + 0.6806995451 * G + 0.1073969566 * B);
  const s = cbrt(0.0883024619 * R + 0.2817188376 * G + 0.6299787005 * B);
  const L = 0.2104542553 * l + 0.7936177850 * m - 0.0040720468 * s;
  const A = 1.9779984951 * l - 2.4285922050 * m + 0.4505937099 * s;
  const Bb = 0.0259040371 * l + 0.7827717662 * m - 0.8086757660 * s;
  const C = Math.hypot(A, Bb);
  let h = Math.atan2(Bb, A) * 180 / Math.PI;
  if (h < 0) h += 360;
  return { L, C, h };
}

/** OKLCh -> linear-light sRGB, which may fall outside the gamut. */
function oklchToLinear(L, C, h) {
  const rad = h * Math.PI / 180;
  const A = Math.cos(rad) * C, B = Math.sin(rad) * C;
  const l = (L + 0.3963377774 * A + 0.2158037573 * B) ** 3;
  const m = (L - 0.1055613458 * A - 0.0638541728 * B) ** 3;
  const s = (L - 0.0894841775 * A - 1.2914855480 * B) ** 3;
  return [
    +4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s,
    -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s,
    -0.0041960863 * l - 0.7034186147 * m + 1.7076147010 * s,
  ];
}

const inGamut = ([r, g, b]) => {
  const lo = -1e-4, hi = 1 + 1e-4;
  return r >= lo && r <= hi && g >= lo && g <= hi && b >= lo && b <= hi;
};

/**
 * OKLCh -> `#rrggbb`, kept inside sRGB by giving up chroma rather than
 * lightness.
 *
 * Which of the two to sacrifice is a real choice and this one is forced: every
 * contrast guarantee below is a statement about lightness, so a gamut clip that
 * moved L would quietly undo the repair pass that had just run. Clipping the
 * channels instead - the obvious thing - is worse still, because it shifts the
 * hue: clamping a too-blue blue drags it towards cyan, and the palette stops
 * being the one that was chosen.
 *
 * Bisection rather than a loop of small steps, because the first attempt is
 * usually in gamut already and this then costs one test.
 */
export function hex(L, C, h) {
  let lo = 0, hi = C;
  if (!inGamut(oklchToLinear(L, C, h))) {
    for (let i = 0; i < 18; i++) {
      const mid = (lo + hi) / 2;
      if (inGamut(oklchToLinear(L, mid, h))) lo = mid; else hi = mid;
    }
  } else lo = C;
  const [r, g, b] = oklchToLinear(L, lo, h);
  return '#' + [r, g, b].map(v => toSrgb(v).toString(16).padStart(2, '0')).join('');
}

/** WCAG relative luminance from sRGB 0-255. */
const luminance = (r, g, b) =>
  0.2126 * toLinear(r) + 0.7152 * toLinear(g) + 0.0722 * toLinear(b);

const parseHex = s => [1, 3, 5].map(i => parseInt(s.slice(i, i + 2), 16));

/** WCAG contrast ratio between two `#rrggbb` strings. */
export function contrast(a, b) {
  const x = luminance(...parseHex(a)), y = luminance(...parseHex(b));
  return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05);
}

// ---------------------------------------------------------------------------
// Which hues the pictures are made of
// ---------------------------------------------------------------------------

/** The shorter way round the wheel between two hues, in degrees. 0 to 180. */
const apart = (a, b) => { const d = Math.abs(a - b) % 360; return Math.min(d, 360 - d); };

const clamp = (n, lo, hi) => Math.min(hi, Math.max(lo, n));

/** 5-degree bins. Fine enough to tell teal from green, coarse enough to vote. */
const BINS = 72;

/**
 * Below this chroma a pixel has no hue worth counting.
 *
 * Photographs are mostly near-neutral - skin, concrete, sky, shadow - and those
 * pixels do have a hue, technically, and it is noise. Letting them vote means
 * every board extracts to the same faint beige, because the average of a lot of
 * nearly-grey pixels is grey. The vote is deliberately of the *coloured* part of
 * a picture only, which is also what a person means when they say what colour a
 * photograph is.
 */
const NEUTRAL_C = 0.045;

/**
 * The floor a board gets when nothing on it clears the one above.
 *
 * A board of chalk, sea glass and bleached linen has a hue in every picture and
 * not one pixel vivid enough to vote with, so it used to extract nothing at all
 * and leave the look alone - which reads as the feature being broken on exactly
 * the boards whose colour is the most deliberate. Tried second rather than
 * instead, because at this floor an ordinary photograph's concrete and skin
 * would drown its actual subject.
 *
 * Still above where a black-and-white photograph sits. JPEG noise in a grey
 * frame lands under 0.01, so the "no colour worth taking" answer survives for
 * the boards that really have none.
 */
const NEUTRAL_FAINT = 0.018;

/** Near-black and near-white carry a hue the eye does not read as one. */
const MIN_L = 0.12;
const MAX_L = 0.95;

/**
 * How much of a picture has to be coloured before its vote counts for anything,
 * and how much before it counts in full. Fractions of the pixels that are not
 * transparent.
 *
 * One picture, one vote is the rule, and this is the sentence it was missing.
 * Measured on a real board: a screenshot of a dark grey interface had exactly
 * *one* pixel above the neutral floor, an olive one, and a whole vote to spend
 * on it - the same vote as a spectrogram with 771 coloured pixels. It won the
 * accent, because the accent goes to the hue furthest from the sheet and noise
 * is as far from the sheet as anything else. The palette on that board was
 * therefore chosen by a single pixel.
 *
 * A ramp rather than a cliff, so nothing hangs on which side of a line a
 * picture falls: below 0.5% coloured a picture is a grey picture and does not
 * vote, above 2% it votes in full, and between the two its vote is worth what
 * it looks like it is worth. The grey street with one red door survives - a
 * door is a few percent of a frame, and 200 red pixels in 4200 is 4.8%.
 */
const COLOUR_MIN = 0.005;
const COLOUR_FULL = 0.02;

/**
 * How far apart two accepted hues have to be, in degrees.
 *
 * Below this they read as one colour with a bit of variation in it, and a
 * palette built on both would spend two of its three slots saying the same
 * thing. 40 degrees is roughly the gap between the presets' own two hues at
 * their closest - Absinthe's are 44 apart.
 */
const MIN_SEP = 40;

/**
 * A second or third hue has to be worth this much of the leader to count.
 *
 * 0.15, down from 0.22, and the two changes that came before it are the reason.
 * Under one-picture-one-vote a colour that owns two photographs out of seven
 * polls 0.29 against a leader that owns four - but a colour that owns *one*
 * polls 0.14 and used to be thrown away, and with it the only real accent the
 * board had. A palette that takes its colours from the pictures cannot afford
 * to be that fussy about which pictures: a single strong photograph is a colour
 * on the board, and the alternative is a monochrome palette in the hue of the
 * majority. Still high enough that a smoothed histogram's shoulder does not
 * qualify - that lands nearer 0.05.
 */
const MIN_SHARE = 0.15;

/** A hue can be one, two or three voices, never more. */
const MAX_HUES = 3;

/**
 * The hues a set of pixels is made of, strongest first.
 *
 * One picture, one vote. Each chunk is counted into its own histogram and that
 * histogram is normalised to a total of 1 before it joins the board's, so a
 * palette is a representation of every photograph on the board rather than of
 * the loudest one. Pooling the pixels instead - which is what this did - let a
 * single vivid picture outvote ten quiet ones and decide the whole look, and a
 * board of ten pictures that comes out the colour of one of them is not a
 * palette taken from the board.
 *
 * Chroma still weights pixels *within* a picture, which is a different claim
 * and still the right one: the grey street with one red door is a red picture.
 * Normalising afterwards means it arrives as one red vote, not as however much
 * red the door happened to contain.
 *
 * A picture with no colour in it - a black-and-white photograph, a page of
 * text - sums to nothing and is skipped rather than counted as an empty vote,
 * so it dilutes nobody.
 *
 * Smoothed before peaks are looked for, because a single real colour lands
 * across two or three neighbouring bins and an unsmoothed histogram would offer
 * both halves of it as separate peaks - MIN_SEP would then throw the second one
 * away, which happens to give the right answer for the wrong reason and stops
 * doing so the moment the split is uneven.
 */
export function huesOf(chunks) {
  return peaksOf(readBoard(chunks)).map(p => p.h);
}

/**
 * How much of the board a hue actually is - the measurement the vote above
 * deliberately destroys, kept beside it.
 *
 * Normalising each picture to one vote is right for the question "which colours
 * does this board have", and it is wrong for every question about magnitude,
 * because dividing by a picture's own total is exactly what throws magnitude
 * away. A wisp of pale sky is the whole of a fog photograph's vote and arrives
 * indistinguishable from a wall of red.
 *
 * Measured on the board this was written for: eleven photographs, and the three
 * hues that survived the vote were a warm at 62 degrees, a green at 133 and a
 * blue at 248. By the vote the blue polled 0.38 of the leader and the green
 * 0.27, so the blue looked like the stronger of the two. By mass the warm is
 * 24.0% of the board's colour, the green 22.7%, and the blue **1.7%** - fifty
 * three pixels of haze in one frame. The green owns a third of one photograph
 * and is a colour of that board; the blue is the sky behind it.
 *
 * So the census answers two questions with two numbers rather than one with
 * one. Membership stays democratic - a board is entitled to a colour that only
 * one of its pictures holds, and MIN_SHARE is what guards that. Which of those
 * colours gets the loudest job is a question about magnitude, and this is what
 * answers it. See rolesFor().
 */
function standings(mass, peaks) {
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
 * Two passes and not one, because the neutral floor is doing two jobs: keeping
 * an ordinary photograph's concrete out of the vote, and deciding whether a
 * board has colour in it. Those want different numbers, and one number for both
 * meant a pastel board was read as a black-and-white one.
 */
function readBoard(chunks) {
  const strict = census(chunks, NEUTRAL_C);
  return strict.voters ? strict : census(chunks, NEUTRAL_FAINT);
}

/**
 * One pass over the pixels: the vote, and the two things about a set of
 * photographs that are not a hue.
 *
 * `vivid` is the mean chroma of the coloured part of a picture, averaged over
 * pictures - how much colour these photographs have in them, as distinct from
 * which. `key` is the mean lightness of the whole picture, neutrals included: a
 * night scene is dark because of its greys, and leaving them out would call it
 * as bright as a beach.
 *
 * Both are per-picture means before they are averaged, for the same reason the
 * vote is normalised per picture - one enormous photograph is still one
 * photograph.
 */
function census(chunks, floor) {
  const votes = new Float64Array(BINS);
  const mass = new Float64Array(BINS);
  // The third tally: what each hue actually *looks* like on this board, as
  // distinct from which hue it is and how much of it there is. Summed weighted
  // by chroma - the same weight the vote uses - so the answer is the mean colour
  // of the pixels that voted rather than of every pixel that grazed the floor.
  // See toneAt(): these three are only ever read as ratios.
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
    // What this picture's vote is worth: a full one if it is a colour
    // photograph, none at all if it is a grey frame with a stray pixel in it.
    const trust = clamp((coloured / opaque - COLOUR_MIN) / (COLOUR_FULL - COLOUR_MIN), 0, 1);
    if (!trust) continue;
    for (let i = 0; i < BINS; i++) {
      votes[i] += trust * one[i] / weight;
      // Not divided by `weight`, which is the entire point - see standing.
      mass[i] += trust * one[i] / opaque;
      // Trust-weighted like the other two, so a grey screenshot's one stray
      // pixel cannot be where the board's red comes from. Not normalised by
      // anything else: a mean is a mean, and it is taken over the pixels rather
      // than over the pictures because the question is what the colour is, not
      // how many photographs hold it.
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
 * standing is summed on - so a hue's colour covers the colour its peak does.
 *
 * Null when nothing voted there, which is what a bare angle from a test or from
 * the picker produces, and the tables stand.
 */
function toneAt({ litSum, chrSum, toneWeight }, i) {
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
 * Returns `{ h, standing }` rather than a bare angle. The angle was all that
 * used to survive this function, and everything downstream had to invent the
 * rest from tables - which is how a hue that is 1.7% of a board came to be
 * rendered at the same chroma as one that is 24% of it.
 */
function peaksOf({ votes, mass, tone, voters }) {
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
  // A histogram with no local maximum is a flat one - every pixel in a single
  // bin, which real photographs do not produce but a test fixture and a solid
  // colour both do. Take the largest bin.
  if (!peaks.length) {
    let best = 0;
    for (let i = 1; i < BINS; i++) if (smooth[i] > smooth[best]) best = i;
    if (smooth[best] <= 0) return [];
    peaks.push({ i: best, h: (best + 0.5) * 360 / BINS, w: smooth[best] });
  }
  peaks.sort((a, b) => b.w - a.w);

  // The sheet is the hue most of the photographs hold, and that is the vote's
  // question - a colour many pictures share, whatever any one of them holds a
  // lot of. It does not move below.
  const standing = standings(mass, peaks);
  const sheet = { ...peaks[0], standing: standing[0] };

  // Everything after it is ordered by the same score rolesFor() will use to hand
  // out the roles, and *that* is the fix for a palette that used to flicker.
  //
  // The two used to disagree: the shortlist was cut by peak height in the vote,
  // and the roles were then chosen from the survivors by standing. So a hue
  // could be the obvious accent by a factor of twenty and still be pruned by a
  // hue with a marginally taller vote - measured on a board of 67 pictures, one
  // photograph joining the set moved the accent from blue to magenta on a vote
  // tie of 0.219 against 0.219, decided by sort order. Turning the dial one stop
  // rewrote every button on the board and turning it back rewrote it again.
  //
  // One ordering now decides both membership and role, so the hue that would win
  // the accent cannot be cut before it is asked. MIN_SHARE stays exactly where
  // it was and does the job it was written for: it is a floor on the vote, so a
  // colour almost no picture holds is not a candidate at all, however much of it
  // the one picture that does hold it holds. See the sky in rolesFor().
  const floor = sheet.w * MIN_SHARE;
  const facing = p => 1 + FACING_BONUS * apart(p.h, sheet.h) / 180;
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
// an extracted palette sits in the same place on every axis that the chosen
// ones do. tools/preset-oklch.mjs prints the measurement.

/**
 * Lightness and chroma for each paper and ink token: the mean of the four
 * presets, to three places. Regenerate with tools/preset-oklch.mjs after
 * touching them, or the extraction drifts away from the family it belongs to.
 *
 * All nine still take the first hue, but the chroma they take it at is now
 * 0.007 on the sheet against the 0.017 it was. The sheet is a cast, not a dye.
 * It used to be the other way round, on the reasoning that a tinted sheet is
 * what makes a palette read as a palette; what that actually produced was a
 * board whose paper tinted every photograph pinned to it, and photographs are
 * the content here. So the hue survives and the saturation went to the
 * pigments, where it is looked at rather than looked through.
 *
 * The papers went *up* in lightness at the same time - 0.980 against 0.965 -
 * and that pairing is the whole of it. Taking chroma out while leaving the
 * sheet where it was made the first attempt look more tinted rather than less,
 * which is not a contradiction: at equal chroma a darker sheet shows its hue
 * more, so a de-tint that dims the paper reads as a dye. Less colour, more
 * light. Either one alone is the wrong half.
 *
 * Papyrus is the one preset whose sheet is far off its accent, at 44 degrees,
 * and Papyrus is not what this is imitating.
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
 * The pigment trio. Means again, and the hue offsets are measured too:
 * --accent-deep sits within a couple of degrees of the accent in all four
 * presets, so it is the same hue darker and nothing else.
 *
 * The accent mean is 0.147 and the four range from 0.096 to 0.204, but that
 * spread is not a design decision the way the sheet's was - the presets all ask
 * for 0.185 and what differs is how much of it their hue can hold at L 0.548.
 * The mean is therefore the mean of four *clipped* answers, which is the honest
 * reference for an extractor that will be clipped the same way.
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
 * The tables above are the reference and no longer the answer. Only the *hue*
 * used to come out of the pictures, which meant every extracted board printed
 * its accent at exactly L 0.548, C 0.147 - the mean of the four presets - and
 * two boards with nothing in common came out as one design in two rotations.
 * The lightness and the saturation of a colour are as much of it as its angle,
 * and a board of chalk photographs asking for the same chroma as a board of
 * neon was the plainest way of saying the palette had not really looked.
 *
 * So the measurement stands, inside these bounds, and the bounds are only the
 * ones a token has to clear to do its job:
 *
 * - **Lightness.** A pigment carries a button and a link. Below the floor it is
 *   a colour you cannot see the difference between and black; above the ceiling
 *   it cannot hold a light label and repair() has to darken it anyway, which
 *   throws the measurement away by a slower route. The band is wide enough to
 *   hold every preset (0.415 to 0.730) with room either side.
 * - **Chroma.** The floor is what keeps a hue with almost no colour in it from
 *   printing a grey button and calling it a palette - a board can be muted
 *   without its one accent being absent. There is no ceiling, because the gamut
 *   already is one: hex() bisects any chroma the screen cannot show.
 */
const WEARABLE_L = { min: 0.36, max: 0.78 };
const WEARABLE_C_MIN = 0.055;

/** A measured colour, held to what a pigment has to be. Null passes through. */
function wearable(tone) {
  if (!tone) return null;
  return {
    L: clamp(tone.L, WEARABLE_L.min, WEARABLE_L.max),
    C: Math.max(tone.C, WEARABLE_C_MIN),
  };
}

/**
 * --accent-deep, from whatever the accent turned out to be.
 *
 * The presets put it a fixed distance below their accent rather than at a
 * lightness of its own - "the same hue darker and nothing else" - so it is that
 * distance, and the same ratio of chroma, applied to the measurement instead of
 * to the table. Taking a second measurement for it would let the two drift
 * apart, and a deep that is not the accent's own darker twin is a third colour.
 */
const DEEP_DROP = PIGMENT['--accent'].L - PIGMENT['--accent-deep'].L;
const DEEP_TEMPER = PIGMENT['--accent-deep'].C / PIGMENT['--accent'].C;

const deepen = ink => ({ L: Math.max(0, ink.L - DEEP_DROP), C: ink.C * DEEP_TEMPER });

/**
 * Where "warm" is, in OKLCh degrees, and how far a hue may be turned towards it.
 *
 * A fixed offset would be wrong in half the cases: +20 degrees from a red is
 * warmer and +20 from a green is not. So --accent-warm is rotated *towards* the
 * ambers by up to WARM_TURN and stops there, which for a hue that is already
 * amber leaves it where it is and lets the lightness do the work - which is
 * what it mostly does anyway. Three of the four presets keep --accent-warm
 * within 24 degrees of their accent; Peacock is the one that spends it on a
 * second hue, and so does this when the photographs offer a third.
 */
const WARM_ANCHOR = 75;
const WARM_TURN = 20;

/**
 * How far --leafy turns from the sheet when the pictures only had one hue.
 *
 * The presets put their second voice 44, 83, 93 and 104 degrees away. 85 is the
 * middle of that and close to three of them.
 */
const LEAFY_SOLO_TURN = 85;
const LEAFY = { L: 0.572, C: 0.111 };

// ---------------------------------------------------------------------------
// The scheme: which hue does which job
// ---------------------------------------------------------------------------
//
// The sheet takes the dominant hue and the accent stands away from it. That is
// the one thing every account of colour in an interface agrees on and the one
// thing this did not do: paper, ink and button all sat on the same hue, which
// is a monochrome palette - safe, and with nothing in it that draws the eye to
// the thing you are meant to click.
//
// It is also half of why every extracted board used to look like the same
// board: only the hue came from the photographs, and one hue rotated is one
// design. Giving the roles different hues fixed the half of it that was about
// the scheme; the other half was that a hue is not a colour, and it is fixed at
// WEARABLE_L above - the lightness and the saturation are read off the pictures
// too now, so a board of chalk and a board of neon no longer print the same
// button at two angles.

/**
 * Two voices closer than this cannot be told apart by hue, so they are told
 * apart by lightness instead - which is the standing advice for an analogous
 * pair and the one lever left once hue is spoken for. Only --leafy moves: the
 * accent's lightness is load-bearing for the contrast floor below.
 */
const ANALOGOUS = 60;
const LEAFY_DROP = 0.07;

/**
 * Which hue does which job, from one to three of them.
 *
 * Every hue here came out of the photographs. That is the whole rule, and it
 * was briefly not: the accent used to be *constructed*, a split-complement 150
 * degrees off the sheet, on the standard advice that the thing you click should
 * contrast with the page it sits on. The advice is sound and the result was
 * not - a warm board of warm photographs got a blue button that appeared in
 * none of them, which is a good palette and somebody else's board. Between "the
 * colours are the pictures' colours" and "the accent contrasts", the first is
 * the feature; the second is a preference about buttons.
 *
 * What survived of it, and had to be walked back further: the accent used to
 * take whichever remaining hue was *furthest* from the sheet, full stop. That
 * reads as a modest rule and is not one, because on a warm board the hue
 * furthest from the sheet is blue, and the blue in an outdoor photograph is the
 * sky - the least saturated and least present thing in the frame, and the one
 * thing almost every picture taken outdoors contains. So the rule reliably
 * found sky, promoted it to the loudest role on the board, and rendered it at a
 * table chroma three times the haze's own. A board of eleven low-saturation
 * photographs came out with a cobalt button that 1.7% of its colour asked for.
 *
 * Distance is now a thumb on the scale instead of the scale. Hues are ranked by
 * standing - how much of the board's colour each actually is - and a hue
 * opposite the sheet counts for up to twice its standing, because it does make
 * the better button. Twice is enough to settle a near-tie between two real
 * colours and nowhere near enough to hand the job to a wisp: on the board this
 * was written for the green scores 0.32 against the blue's 0.03.
 *
 * A board with one hue in it gets a palette in one hue - sheet, ink and accent
 * together. Which is what three of the four presets do, and what a board of
 * photographs that are all one colour honestly is.
 *
 * Bare angles are still accepted, and then there is no standing to rank by and
 * distance decides alone - which is what a hand-picked colour and every test
 * that cares only about hue want.
 */
const FACING_BONUS = 1;

function rolesFor(hues) {
  const [sheet, ...rest] = hues.map(p => (typeof p === 'number' ? { h: p, standing: 0 } : p));
  const score = p => p.standing * (1 + FACING_BONUS * apart(p.h, sheet.h) / 180);
  const order = [...rest]
    .sort((a, b) => (score(b) - score(a)) || (apart(b.h, sheet.h) - apart(a.h, sheet.h)));
  const ranked = order.map(p => p.h);
  // The colour each role was measured at, alongside the angle. Null wherever
  // there is nothing to measure - a bare angle, or a role whose hue no
  // photograph supplied - and build() falls back to the tables for that one
  // token. Carried beside `ranked` rather than inside it because every caller
  // of these four fields wants a number.
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
    // *between* them rather than at a turn of its own: on a board of rose and
    // magenta, +85 degrees is an olive that nothing on the board is, and the
    // ornament is no better a place to invent a colour than the button was.
    // Only a board with a single hue has nothing to sit between, and there the
    // turn stands - a wash that is its own accent is not a second voice at all.
    leafy: ranked.length > 1 ? ranked[1]
      : ranked.length ? midHue(sheet.h, ranked[0])
        : (sheet.h + LEAFY_SOLO_TURN) % 360,
    // --accent-warm has no photograph left to take by this point - the vote
    // yields three hues at the most and the other two are spoken for - so it
    // stays a relative of the sheet it washes.
    warm: warmer(sheet.h),
  };
}

// ---------------------------------------------------------------------------
// The dials: what the photographs are, not just which hue they are
// ---------------------------------------------------------------------------
//
// The tables above are the mean of the four presets, and using them unchanged
// meant a board of storm photographs and a board of pastel ones came out as the
// same palette in two hues. These two dials let the pictures move the other two
// axes as well - but between stops, and the stops are the range the presets
// themselves span, so a bent palette is still one of the family.

/**
 * The reference photograph: the vividness and the lightness at which the tables
 * stand exactly as measured. An ordinary well-lit colour photograph sits near
 * here, which is what makes the presets the middle of this rather than one end.
 */
const REF_VIVID = 0.065;
const REF_KEY = 0.62;

/**
 * How far chroma may be scaled by how vivid the pictures are.
 *
 * Both ends moved when the tables did, and the ceiling moved *down*, which
 * looks backwards for a palette that got louder. The reason is that the tables
 * it multiplies now start at the sRGB wall: the presets ask for chroma 0.185 on
 * the accent and mostly do not get it, so the reference is already the most
 * saturated version of its hue the screen can show. Multiplying that by 2 asks
 * for nothing the gamut can give - every vivid board would land on the same
 * clipped colour as every other, and the top half of the dial would be dead
 * travel. 1.35 keeps the range meaningful where a hue does have room to grow
 * and costs nothing where it does not.
 *
 * The floor is where the work happens instead. At 0.40 a board of concrete and
 * fog gets an accent at 0.059 against a vivid board's 0.198 - a greyed palette
 * against a saturated one - and downwards is the direction with room in it,
 * because the gamut is not what limits how *little* colour a palette can hold.
 *
 * So: the dial no longer says how loud the loudest board is, since that is
 * fixed by the screen. It says how quiet the quietest one gets.
 */
const VIVID_FLOOR = 0.40;
const VIVID_CEIL = 1.35;

/**
 * How far the sheet's lightness may follow the pictures' own.
 *
 * Asymmetric, and deliberately: there is room below 0.979 for a sheet to go
 * deeper and almost none above it before paper stops being paper and starts
 * being a lit screen. Dark photographs therefore get most of this range and
 * bright ones get a token amount of it.
 *
 * The upward stop is 0.010 because the base sheet is now bright enough that
 * anything more would reach L 1.0, and at L 1.0 hex() returns #ffffff whatever
 * chroma it was handed - so a board of beach photographs would lose its tint
 * entirely and print on the browser's white rather than its own. The clamp is
 * what keeps the brightest board still a board.
 *
 * Widened along with the chroma dial and for the same reason. Now that the
 * sheet is near-neutral, its *lightness* is the only thing left that can tell
 * one board's paper from another's - a board of night photographs printing on
 * a sheet at 0.857 is grey paper, which reads as a different board, where the
 * same board under the old range printed within a hair of the same white as
 * everything else and relied on a tint to say so.
 *
 * Only the paper and the rules move. The inks stay where they are, so every one
 * of these shifts widens the contrast between text and its sheet rather than
 * narrowing it - the repair pass below is a floor, not a substitute for not
 * walking towards it.
 */
const KEY_GAIN = 0.30;
const KEY_DOWN = 0.085;
const KEY_UP = 0.010;
const PAPERS = ['--paper', '--paper-2', '--paper-3', '--paper-card', '--rule', '--rule-2'];

/**
 * Where the sheet goes at the plain end of the whimsy axis, and how much of its
 * tint it keeps once it is there.
 *
 * Harsh is the level where the board stops being a scrapbook and starts being a
 * drawing - it is already where the grid turns to crosses and where things snap
 * to a lattice - and a drawing is made on white paper. So at that end the sheet
 * returns to nearly white however dark or vivid the photographs were, keeping
 * some of its tint so it is still recognisably this board's white rather than
 * the browser's.
 *
 * Kept fraction went from a third to 0.55 when the papers were de-tinted, and
 * it is the same amount of colour arriving by a different route: a third of the
 * old chroma was 0.006, half of the new is 0.004, and below about 0.003 an
 * 8-bit sheet is simply #fdfdfd and the board has lost its white.
 *
 * The pigments are untouched: the accent, the wash and the ink are what the
 * pictures said, and this is a statement about paper, not about colour.
 */
const PLAIN_PAPER = 0.985;
const PLAIN_TINT = 0.55;

/**
 * The tables, bent by what the photographs are. Null traits leaves them be.
 *
 * The square root is what keeps this a dial rather than a switch. A straight
 * ratio spends its whole range within a stone's throw of the reference and
 * pins to one stop or the other for nearly every real board - measured: four
 * boards, three of them pinned. Under a root the middle stays responsive and
 * the extremes arrive slowly, which is also the honest shape, since twice the
 * chroma in a photograph is nothing like twice the colour in a palette.
 *
 * Every field of `traits` is optional and independently so - a hand-picked
 * colour brings no photographs with it but is still subject to the axis.
 */
function temper(traits) {
  const scale = traits?.vivid != null
    ? clamp(Math.sqrt(traits.vivid / REF_VIVID), VIVID_FLOOR, VIVID_CEIL) : 1;
  const key = traits?.key != null
    ? clamp((traits.key - REF_KEY) * KEY_GAIN, -KEY_DOWN, KEY_UP) : 0;
  // The axis overrules the photographs about the paper, and only about the
  // paper: at the plain end the sheet is white because that is what that end
  // of the axis *is*, not because the pictures were bright.
  const shift = traits?.plain ? PLAIN_PAPER - SHEET['--paper'].L : key;
  const sheetScale = traits?.plain ? scale * PLAIN_TINT : scale;
  const sheet = {}, pigment = {};
  for (const [key, { L, C }] of Object.entries(SHEET)) {
    sheet[key] = {
      L: PAPERS.includes(key) ? clamp(L + shift, 0, 1) : L,
      C: C * sheetScale,
    };
  }
  for (const [key, { L, C }] of Object.entries(PIGMENT)) pigment[key] = { L, C: C * scale };
  return { sheet, pigment, leafy: { L: LEAFY.L, C: LEAFY.C * scale } };
}

/**
 * What the repair pass will not let through.
 *
 * These are floors, not targets - the presets clear them comfortably and a
 * palette that only just clears them is still a palette somebody can read.
 * Body text is held to AA for normal text against the sheet it is printed on;
 * the secondary ink is held to the large-text ratio because that is what it is
 * used for, and the accent has to carry a button.
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
 * Exported separately from extractPalette() so the rule can be tested on hues
 * chosen to break it - a yellow that cannot be made dark enough, two hues a
 * degree apart - without going through a histogram first.
 */
/**
 * Every token an extraction writes.
 *
 * Built from the same tables paletteFor() fills, so the two cannot drift: a
 * pigment added to SHEET or PIGMENT is in this list the moment it exists.
 * appearance.js needs it to tell a colour decision from any other kind - a
 * hand-picked accent is one, choosing a display face is not, and only the first
 * has any business switching the extraction off.
 */
/**
 * A full set of pigment tokens from one to three hues.
 *
 * `hues` is either bare angles or peaksOf()'s `{ h, standing }`. The extraction
 * hands over the second so rolesFor() can rank on how much of the board each
 * colour is; anything that only knows an angle passes the first and gets the
 * old distance rule, which is the right answer when there is no board to weigh.
 *
 * `traits` is what the photographs were - see temper(). Absent, the tables
 * stand as measured, which is what a hand-picked colour and every test that
 * cares only about hue want.
 *
 * Exported separately from extractPalette() so the rule can be tested on hues
 * chosen to break it - a yellow that cannot be made dark enough, two hues a
 * degree apart - without going through a histogram first.
 */
export function paletteFor(hues, traits = null) {
  if (!hues.length) return null;
  return build(rolesFor(hues), traits);
}

function build(roles, traits) {
  const { sheet, pigment, leafy } = temper(traits);
  const vars = {};

  for (const [key, { L, C }] of Object.entries(sheet)) vars[key] = hex(L, C, roles.sheet);

  // What the accent is actually made of: the photographs' own lightness and
  // chroma at that hue where they were measured, the tables where they were not.
  const accentInk = wearable(roles.tone?.accent) || pigment['--accent'];
  const leafyInk = wearable(roles.tone?.leafy) || leafy;

  for (const [key, { L, C }] of Object.entries(pigment)) {
    // --accent-warm is the one pigment no photograph supplied - rolesFor() turns
    // it out of the sheet's hue - so it has no measurement to wear and keeps the
    // table, bent by the vivid dial like everything else.
    if (key === '--accent-warm') {
      vars[key] = hex(L, C, (roles.warm + 360) % 360);
      continue;
    }
    const ink = key === '--accent-deep' ? deepen(accentInk) : accentInk;
    vars[key] = hex(ink.L, ink.C, (roles.accent + 360) % 360);
  }

  // Told apart by lightness when hue cannot do it - see ANALOGOUS. Dropped
  // rather than raised, because --leafy is a wash on a light sheet and the
  // room is downwards.
  const crowded = apart(roles.accent, roles.leafy) < ANALOGOUS;
  vars['--leafy'] =
    hex(crowded ? leafyInk.L - LEAFY_DROP : leafyInk.L, leafyInk.C, (roles.leafy + 360) % 360);

  return repair(vars, roles, sheet, accentInk);
}

/**
 * Push lightness apart until the palette is legible, and say so if it cannot be.
 *
 * Only L moves. Hue is the answer the photographs gave and is not ours to
 * change; chroma is what keeps the palette tinted rather than saturated, and
 * spending it here would trade a legible palette for a grey one. Lightness is
 * the axis contrast is actually made of, which is the whole reason the file
 * works in OKLab.
 *
 * Works from the tempered tables it is handed rather than from SHEET and
 * PIGMENT directly, because the palette it is repairing was not built from
 * those: a vivid board's ink starts with more chroma in it and a dark board's
 * paper starts lower, and re-deriving from the means would quietly undo both.
 * `accentInk` is the same thing one step further - the accent as the pictures
 * measured it, which is what the fallback below has to restore it to.
 */
function repair(vars, roles, sheet, accentInk) {
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

  // The accent carries a button, and what sits on it is the sheet mixed towards
  // white - so the pair is tested as it will actually be rendered rather than
  // against a nominal white. A hue that cannot clear the floor with a light
  // label gets a dark one instead, which is what Peacock's gold needed by hand.
  const light = mixHex(paper, '#ffffff', 0.55);
  const { C } = accentInk;
  let { L } = accentInk;
  for (let i = 0; i < 40 && contrast(vars['--accent'], light) < ACCENT_FLOOR; i++) {
    L = Math.max(0, L - 0.02);
    vars['--accent'] = hex(L, C, roles.accent);
    if (L === 0) break;
  }
  // Always named, never left to the stylesheet. The default is a mix of the
  // sheet, which is the right answer here and would also be the right answer if
  // this were omitted - but omitting it means an extraction that needed the
  // dark label leaves it behind for the next extraction that does not, since
  // applying a look adds tokens and only a change of look takes them away.
  vars['--accent-fg'] = light;
  if (contrast(vars['--accent'], light) < ACCENT_FLOOR) {
    // Darkening did not get there, which happens for yellows: they run out of
    // gamut long before they run out of lightness. Flip the label to the ink,
    // restore the accent to the lightness the palette wanted, and let the
    // brightest hues stay bright.
    vars['--accent'] = hex(accentInk.L, accentInk.C, roles.accent);
    vars['--accent-fg'] = vars['--ink'];
  }
  return vars;
}

/**
 * A whole palette from one chosen colour.
 *
 * What the Pigment control does now. Picking an accent used to move one token
 * and leave the sheet where the palette had it, with a second control for the
 * paper - so the two could be put out of tune, and a blue accent on a cream
 * sheet is the mistake that panel made easiest to make.
 *
 * The exact colour picked is kept. That is the difference between this and
 * paletteFor(): the extraction has no opinion to honour and takes the tables'
 * lightness and chroma, but somebody who picks #3355ff and is handed a
 * different blue back has been overruled by their own colour picker. So the
 * hue builds the sheet and the pick itself stands as `--accent`.
 *
 * Which means repair() cannot darken the accent to reach its contrast floor -
 * darkening it would be overruling the pick by a slower route. The label on top
 * moves instead: whichever of the light mix or the ink stands better on it. A
 * pick that clears neither is a pick that is legible in nothing, and the better
 * of the two is still the honest answer.
 *
 * Monochrome where an extraction is not: the pick is the sheet's hue *and* the
 * accent, so --accent-deep stays a darker version of the colour that was
 * chosen. Sending the accent to the far side of the wheel the way rolesFor()
 * does would answer a question nobody asked - somebody reaching for the picker
 * is choosing the board's colour, not commissioning a scheme around it.
 */
export function paletteFromAccent(picked, { plain = false } = {}) {
  if (!/^#[0-9a-f]{6}$/i.test(picked)) return null;
  const chosen = picked.toLowerCase();
  const { C, h } = oklch(...parseHex(chosen));
  // A grey has no hue to build from - every direction is equally wrong, and the
  // bins would hand back whatever rounding noise the pick happens to carry.
  if (C < NEUTRAL_C) return null;

  const vars = build(
    { sheet: h, accent: h, leafy: (h + LEAFY_SOLO_TURN) % 360, warm: warmer(h) },
    // The axis applies to a colour chosen by hand exactly as it does to one
    // read off the photographs: the sheet a pick brings with it is still the
    // sheet, and at the plain end of the axis the sheet is white.
    { plain });
  vars['--accent'] = chosen;
  const light = mixHex(vars['--paper'], '#ffffff', 0.55);
  vars['--accent-fg'] =
    contrast(chosen, light) >= contrast(chosen, vars['--ink']) ? light : vars['--ink'];
  return vars;
}

/** Halfway between two hues, the short way round the wheel. */
function midHue(a, b) {
  const d = ((b - a + 540) % 360) - 180;
  return (a + d / 2 + 360) % 360;
}

/** A hue turned towards the ambers, by WARM_TURN at most. */
function warmer(h) {
  // Signed shortest way round, so a hue at 350 turns forwards past 0 rather
  // than the long way down through the greens.
  const d = ((WARM_ANCHOR - h + 540) % 360) - 180;
  return h + Math.sign(d) * Math.min(Math.abs(d), WARM_TURN);
}

/** `a` and `b` mixed in sRGB, `t` of the way to `b`. Matches color-mix(). */
function mixHex(a, b, t) {
  const [ar, ag, ab] = parseHex(a), [br, bg, bb] = parseHex(b);
  const m = (x, y) => Math.round(x + (y - x) * t).toString(16).padStart(2, '0');
  return '#' + m(ar, br) + m(ag, bg) + m(ab, bb);
}

/**
 * The whole job: pixels in, tokens out.
 *
 * Returns null rather than a grey palette when the pictures have no colour in
 * them worth taking - a board of black-and-white photographs, or of nothing at
 * all. The caller's right move then is to leave the look alone, and null says
 * that in a way an all-neutral palette does not.
 */
export function extractPalette(chunks, { plain = false } = {}) {
  const board = readBoard(chunks);
  // The rich peaks, not huesOf()'s bare angles: rolesFor() ranks on standing,
  // and standing is what huesOf() drops on its way out.
  const hues = peaksOf(board);
  if (!hues.length) return null;
  return paletteFor(hues, { vivid: board.vivid, key: board.key, plain });
}

// ---------------------------------------------------------------------------
// Reading the board
// ---------------------------------------------------------------------------

/**
 * How many pictures a palette is read from when nobody says, newest first.
 *
 * This was a hard ceiling and is now a default, because the dial above it grew
 * a stop past its top: `paletteSources: 0` means every picture on the board and
 * arrives here as an infinite limit. The ceiling was never about correctness -
 * a palette read from forty photographs is a fine palette - it was about the
 * decode each source costs, and someone who asks for all of them has said they
 * will pay it. Each picture counts the same whatever its size or how vivid it
 * is - see huesOf().
 */
export const MAX_SOURCES = 24;

/** Each one drawn this big. 48x48 is 2304 pixels, and enough to vote with. */
const SAMPLE = 48;

/**
 * Pixels from a list of image URLs.
 *
 * Downscaled hard on the way in, which is not only for speed: drawing a photo
 * into 48x48 averages it, and averaging in sRGB is close enough to a blur that
 * single-pixel noise and JPEG artefacts stop voting. The full-size image would
 * give a *more* precise answer to a question nobody asked.
 *
 * Failures are skipped rather than thrown. One picture the browser cannot
 * decode should cost its own vote and nothing else.
 */
export async function samplePixels(urls, limit = MAX_SOURCES) {
  const ctx = sampler();
  if (!ctx) return [];
  // `limit` may be Infinity, which is what "every picture" arrives as. A falsy
  // limit is still the default rather than none: 0 reaching here would be a
  // caller that has not looked the setting up, and reading nothing at all is
  // never the answer anybody wanted.
  const asked = limit || MAX_SOURCES;
  const n = asked === Infinity ? urls.length : Math.max(1, Math.min(asked, MAX_SOURCES));
  const out = [];
  for (const url of urls.slice(0, n)) {
    try {
      const src = await frameFor(url);
      // One canvas for all of them, so it is cleared between pictures: a
      // transparent PNG drawn over the last one would otherwise vote with
      // whatever was underneath it.
      ctx.clearRect(0, 0, SAMPLE, SAMPLE);
      ctx.drawImage(src, 0, 0, SAMPLE, SAMPLE);
      out.push(ctx.getImageData(0, 0, SAMPLE, SAMPLE).data);
      src.close?.();
    } catch { /* one picture, one lost vote */ }
  }
  return out;
}

/**
 * Somewhere to draw 48x48, whatever the browser has.
 *
 * OffscreenCanvas first because it puts nothing in the document, and a real
 * <canvas> when there is no OffscreenCanvas - which used to mean the whole
 * feature failed silently rather than falling back, since the throw landed in
 * the same catch as "this one PNG is corrupt".
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
 * The bytes are fetched and decoded as a blob rather than handed to an <img>
 * src, because an <img> decides what it is decoding from the MIME type on the
 * URL: Chrome sniffs the bytes when that type is missing or wrong, Firefox does
 * not, and an asset that arrived without a type therefore extracted perfectly
 * in one browser and not at all in the other - silently, since a picture that
 * cannot be decoded is one lost vote and eleven lost votes are no palette.
 * createImageBitmap() takes the bytes themselves and has no such opinion.
 *
 * The <img> path stays as the fallback for anything without createImageBitmap.
 */
async function frameFor(url) {
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
