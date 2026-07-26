// A palette read off the pictures on the board.
//
// The rule this follows is not 60-30-10. That was tried on the four presets,
// measured, and abandoned - see research/decisions-2026-07-25.md - because the
// "30" band on this surface is text and hairlines, a few percent of the pixels
// whatever colour they are printed in. What is followed instead is the scheme
// the presets were built on, with the one addition every colour-theory account
// of an interface agrees on: an analogous base and a contrasting colour for the
// thing you are meant to click.
//
//   - one to three hues, taken from what the photographs contain;
//   - a tinted sheet and a dark ink of the *dominant* hue, which is what makes
//     a palette read as a palette rather than as a grey page with a colour on
//     it, and what keeps the 60 in one family;
//   - every other pigment taken from the photographs too, never constructed:
//     the accent is the board's own second colour, the one furthest from the
//     sheet, and a board of one colour gets a palette in one colour. Contrast
//     between the button and the page is the standard advice and was tried -
//     see rolesFor() for why an accent nobody photographed lost to one they
//     did;
//   - --leafy for whatever colour is left over, and a lightness split between
//     any two voices that land too close to tell apart by hue alone;
//   - chroma and sheet lightness bent by what the photographs actually are -
//     vivid pictures get a stronger palette, dark ones a deeper sheet - but
//     bent within bounds measured off the presets, never freely;
//   - and a repair pass afterwards, because a palette that came out of a
//     photograph has no reason to be legible and every one of these has to be.
//
// Everything here is pure. Reading pixels off the board needs a canvas and
// lives in samplePixels() at the foot of the file, which is the only function
// that touches the DOM and the only one the tests do not call - they hand
// extractPalette() the pixels directly, which is also how a failing board can
// be reproduced from its colours rather than from its photographs.

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
  const { votes, voters } = readBoard(chunks);
  return peaksOf(votes, voters);
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
  let voters = 0, vividSum = 0, keySum = 0, lit = 0;
  for (const px of chunks) {
    const one = new Float64Array(BINS);
    let weight = 0, coloured = 0, lSum = 0, opaque = 0;
    for (let i = 0; i + 3 < px.length; i += 4) {
      if (px[i + 3] < 128) continue;
      const { L, C, h } = oklch(px[i], px[i + 1], px[i + 2]);
      lSum += L; opaque++;
      if (L < MIN_L || L > MAX_L || C < floor) continue;
      one[Math.floor(h / 360 * BINS) % BINS] += C;
      weight += C; coloured++;
    }
    if (opaque) { keySum += lSum / opaque; lit++; }
    if (!weight) continue;
    // What this picture's vote is worth: a full one if it is a colour
    // photograph, none at all if it is a grey frame with a stray pixel in it.
    const trust = clamp((coloured / opaque - COLOUR_MIN) / (COLOUR_FULL - COLOUR_MIN), 0, 1);
    if (!trust) continue;
    for (let i = 0; i < BINS; i++) votes[i] += trust * one[i] / weight;
    vividSum += trust * (weight / coloured);
    voters += trust;
  }
  return {
    votes,
    voters,
    vivid: voters ? vividSum / voters : 0,
    // No pixels at all is the reference picture rather than a black one: with
    // nothing to say, the tables stand as measured.
    key: lit ? keySum / lit : REF_KEY,
  };
}

/** The peaks of a hue vote, strongest first. */
function peaksOf(votes, voters) {
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
      peaks.push({ h: (i + 0.5) * 360 / BINS, w: smooth[i] });
    }
  }
  // A histogram with no local maximum is a flat one - every pixel in a single
  // bin, which real photographs do not produce but a test fixture and a solid
  // colour both do. Take the largest bin.
  if (!peaks.length) {
    let best = 0;
    for (let i = 1; i < BINS; i++) if (smooth[i] > smooth[best]) best = i;
    if (smooth[best] <= 0) return [];
    peaks.push({ h: (best + 0.5) * 360 / BINS, w: smooth[best] });
  }
  peaks.sort((a, b) => b.w - a.w);

  const out = [peaks[0]];
  for (const p of peaks.slice(1)) {
    if (out.length >= MAX_HUES) break;
    if (p.w < peaks[0].w * MIN_SHARE) break;
    if (out.every(q => apart(p.h, q.h) >= MIN_SEP)) out.push(p);
  }
  return out.map(p => p.h);
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
 * presets, to three places.
 *
 * All nine take the first hue. That is what three of the four presets do
 * already - Absinthe, Tea rose and Peacock put their sheet within 13 degrees of
 * their accent - and it is the thing that makes a palette read as one sheet of
 * tinted paper rather than as a grey page with a colour printed on it. Papyrus
 * is the exception at 44 degrees off, and Papyrus is not what this is imitating.
 */
const SHEET = {
  '--paper':      { L: 0.965, C: 0.017 },
  '--paper-2':    { L: 0.935, C: 0.027 },
  '--paper-3':    { L: 0.894, C: 0.037 },
  '--paper-card': { L: 0.988, C: 0.009 },
  '--ink':        { L: 0.295, C: 0.028 },
  '--ink-2':      { L: 0.483, C: 0.037 },
  '--ink-3':      { L: 0.641, C: 0.038 },
  '--rule':       { L: 0.856, C: 0.038 },
  '--rule-2':     { L: 0.750, C: 0.049 },
};

/**
 * The pigment trio. Means again, and the hue offsets are measured too:
 * --accent-deep sits within a degree of the accent in all four presets, so it
 * is the same hue darker and nothing else.
 */
const PIGMENT = {
  '--accent':      { L: 0.576, C: 0.115 },
  '--accent-warm': { L: 0.728, C: 0.120 },
  '--accent-deep': { L: 0.445, C: 0.094 },
};

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
const LEAFY = { L: 0.587, C: 0.071 };

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
// It is also why every extracted board used to look like the same board. Only
// the hue came from the photographs, and one hue rotated is one design.

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
 * What survives of it: among the hues that are not the sheet's, the accent
 * takes the one furthest from it. That is the most visible button available
 * *within* the colours the photographs actually hold, and it costs nothing,
 * because every hue that got this far is already MIN_SEP from every other.
 *
 * A board with one hue in it gets a palette in one hue - sheet, ink and accent
 * together. Which is what three of the four presets do, and what a board of
 * photographs that are all one colour honestly is.
 */
function rolesFor(hues) {
  const [sheet, ...rest] = hues;
  // Furthest from the sheet first, rather than strongest first: both are real
  // colours off the board, and of the two the further one makes the better
  // button. --leafy takes what is left, and washes the sheet.
  const ranked = [...rest].sort((a, b) => apart(b, sheet) - apart(a, sheet));
  return {
    sheet,
    accent: ranked.length ? ranked[0] : sheet,
    // A third photographed hue if the board has one. With two, the wash sits
    // *between* them rather than at a turn of its own: on a board of rose and
    // magenta, +85 degrees is an olive that nothing on the board is, and the
    // ornament is no better a place to invent a colour than the button was.
    // Only a board with a single hue has nothing to sit between, and there the
    // turn stands - a wash that is its own accent is not a second voice at all.
    leafy: ranked.length > 1 ? ranked[1]
      : ranked.length ? midHue(sheet, ranked[0])
        : (sheet + LEAFY_SOLO_TURN) % 360,
    // --accent-warm has no photograph left to take by this point - the vote
    // yields three hues at the most and the other two are spoken for - so it
    // stays a relative of the sheet it washes.
    warm: warmer(sheet),
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
 * The old ceiling was 1.35, chosen to sit near the presets' own cap of 0.13 -
 * and the complaint that followed was the correct one: a board of saturated
 * photographs came out at chroma 0.019 on the sheet while the photographs
 * themselves averaged 0.12, six times more colour than the palette they
 * produced. A palette that faint is a preset with a hue setting, and it does
 * not look like anybody's board.
 *
 * 1.9 puts a vivid board's paper at 0.032 and its --paper-3 at 0.070, which is
 * a plainly tinted sheet rather than a hint of one, and its accent at 0.219 -
 * beyond sRGB for some hues, where hex() gives up chroma and the palette simply
 * takes what the gamut allows. The floor drops further too, so a board of
 * concrete and fog reads as one.
 *
 * This is the axis to reach for first if boards still come out too polite.
 */
const VIVID_FLOOR = 0.55;
const VIVID_CEIL = 1.90;

/**
 * How far the sheet's lightness may follow the pictures' own.
 *
 * Asymmetric, and deliberately: there is room below 0.965 for a sheet to go
 * deeper and almost none above it before paper stops being paper and starts
 * being a lit screen. Dark photographs therefore get most of this range and
 * bright ones get a token amount of it.
 *
 * Only the paper and the rules move. The inks stay where they are, so every one
 * of these shifts widens the contrast between text and its sheet rather than
 * narrowing it - the repair pass below is a floor, not a substitute for not
 * walking towards it.
 */
const KEY_GAIN = 0.22;
const KEY_DOWN = 0.070;
const KEY_UP = 0.025;
const PAPERS = ['--paper', '--paper-2', '--paper-3', '--paper-card', '--rule', '--rule-2'];

/**
 * Where the sheet goes at the plain end of the whimsy axis, and how much of its
 * tint it keeps once it is there.
 *
 * Harsh is the level where the board stops being a scrapbook and starts being a
 * drawing - it is already where the grid turns to crosses and where things snap
 * to a lattice - and a drawing is made on white paper. So at that end the sheet
 * returns to nearly white however dark or vivid the photographs were, keeping a
 * third of its tint, which is enough that it is still recognisably this board's
 * white rather than the browser's.
 *
 * The pigments are untouched: the accent, the wash and the ink are what the
 * pictures said, and this is a statement about paper, not about colour.
 */
const PLAIN_PAPER = 0.985;
const PLAIN_TINT = 0.3;

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
export const PALETTE_TOKENS = [
  ...Object.keys(SHEET), ...Object.keys(PIGMENT), '--leafy', '--accent-fg',
];

/**
 * A full set of pigment tokens from one to three hues.
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

  for (const [key, { L, C }] of Object.entries(pigment)) {
    const h = key === '--accent-warm' ? roles.warm : roles.accent;
    vars[key] = hex(L, C, (h + 360) % 360);
  }

  // Told apart by lightness when hue cannot do it - see ANALOGOUS. Dropped
  // rather than raised, because --leafy is a wash on a light sheet and the
  // room is downwards.
  const crowded = apart(roles.accent, roles.leafy) < ANALOGOUS;
  vars['--leafy'] =
    hex(crowded ? leafy.L - LEAFY_DROP : leafy.L, leafy.C, (roles.leafy + 360) % 360);

  return repair(vars, roles, sheet, pigment);
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
 */
function repair(vars, roles, sheet, pigment) {
  const paper = vars['--paper'];
  for (const [key, floor] of Object.entries(FLOOR)) {
    let { L, C } = sheet[key];
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
  let { L, C } = pigment['--accent'];
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
    vars['--accent'] = hex(pigment['--accent'].L, pigment['--accent'].C, roles.accent);
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
  const { votes, voters, vivid, key } = readBoard(chunks);
  const hues = peaksOf(votes, voters);
  if (!hues.length) return null;
  return paletteFor(hues, { vivid, key, plain });
}

// ---------------------------------------------------------------------------
// Reading the board
// ---------------------------------------------------------------------------

/**
 * How many pictures to look at, newest first.
 *
 * A cap and not a sample of the whole board: past this the newest twelve are
 * what the palette is a representation of. Each of the twelve counts the same
 * whatever its size or how vivid it is - see huesOf().
 */
export const MAX_SOURCES = 12;

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
export async function samplePixels(urls) {
  const ctx = sampler();
  if (!ctx) return [];
  const out = [];
  for (const url of urls.slice(0, MAX_SOURCES)) {
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
