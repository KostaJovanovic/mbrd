// A palette read off the pictures on the board.
//
// The rule this follows is not 60-30-10. That was tried on the four presets,
// measured, and abandoned - see research/decisions-2026-07-25.md - because the
// "30" band on this surface is text and hairlines, a few percent of the pixels
// whatever colour they are printed in. What is followed instead is the rule the
// presets were actually built on, so that an extracted palette and a chosen one
// come out as the same kind of object:
//
//   - one to three hues, taken from what the photographs contain;
//   - chroma capped near 0.13, so a board is tinted rather than saturated;
//   - the accent for action, --leafy for the second voice, --accent-warm for a
//     third when the pictures have one;
//   - a tinted sheet and a dark ink of the same hue, which is what makes a
//     palette read as a palette rather than as a grey page with a colour on it;
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

/** Near-black and near-white carry a hue the eye does not read as one. */
const MIN_L = 0.12;
const MAX_L = 0.95;

/**
 * How far apart two accepted hues have to be, in degrees.
 *
 * Below this they read as one colour with a bit of variation in it, and a
 * palette built on both would spend two of its three slots saying the same
 * thing. 40 degrees is roughly the gap between the presets' own two hues at
 * their closest - Absinthe's are 44 apart.
 */
const MIN_SEP = 40;

/** A second or third hue has to be worth this much of the leader to count. */
const MIN_SHARE = 0.22;

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
  const votes = new Float64Array(BINS);
  let counted = 0;
  for (const px of chunks) {
    const one = new Float64Array(BINS);
    let weight = 0;
    for (let i = 0; i + 3 < px.length; i += 4) {
      if (px[i + 3] < 128) continue;
      const { L, C, h } = oklch(px[i], px[i + 1], px[i + 2]);
      if (L < MIN_L || L > MAX_L || C < NEUTRAL_C) continue;
      one[Math.floor(h / 360 * BINS) % BINS] += C;
      weight += C;
    }
    if (!weight) continue;
    for (let i = 0; i < BINS; i++) votes[i] += one[i] / weight;
    counted++;
  }
  if (!counted) return [];

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

  const apart = (a, b) => { const d = Math.abs(a - b) % 360; return Math.min(d, 360 - d); };
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
 * How far --leafy turns from the accent when the pictures only had one hue.
 *
 * The presets put their second voice 44, 83, 93 and 104 degrees away. 85 is the
 * middle of that and close to three of them.
 */
const LEAFY_SOLO_TURN = 85;
const LEAFY = { L: 0.587, C: 0.071 };

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

export function paletteFor(hues) {
  if (!hues.length) return null;
  const [h0, h1, h2] = hues;
  const vars = {};

  for (const [key, { L, C }] of Object.entries(SHEET)) vars[key] = hex(L, C, h0);

  for (const [key, { L, C }] of Object.entries(PIGMENT)) {
    // A third hue, when the pictures have one, takes --accent-warm outright
    // rather than staying a relative of the accent. That token is the only
    // pigment slot with a job in app.css that is not already spoken for - it
    // washes the sheet, tints note 1 and carries the highlight - so a third
    // colour put here is one that is actually seen, which was the condition for
    // having a third at all.
    let h = h0;
    if (key === '--accent-warm') h = h2 != null ? h2 : warmer(h0);
    vars[key] = hex(L, C, (h + 360) % 360);
  }

  // The second voice: the pictures' second hue if they had one, and otherwise a
  // turn away from the first. Turning rather than omitting, because --leafy is
  // the ornamental wash and a board whose wash is its own accent has no second
  // voice at all - which is the thing the presets were criticised for.
  const leafyHue = h1 != null ? h1 : (h0 + LEAFY_SOLO_TURN) % 360;
  vars['--leafy'] = hex(LEAFY.L, LEAFY.C, leafyHue);

  return repair(vars, h0);
}

/**
 * Push lightness apart until the palette is legible, and say so if it cannot be.
 *
 * Only L moves. Hue is the answer the photographs gave and is not ours to
 * change; chroma is what keeps the palette tinted rather than saturated, and
 * spending it here would trade a legible palette for a grey one. Lightness is
 * the axis contrast is actually made of, which is the whole reason the file
 * works in OKLab.
 */
function repair(vars, hue) {
  const paper = vars['--paper'];
  for (const [key, floor] of Object.entries(FLOOR)) {
    let { L, C } = SHEET[key];
    for (let i = 0; i < 40 && contrast(vars[key], paper) < floor; i++) {
      L = Math.max(0, L - 0.02);
      vars[key] = hex(L, C, hue);
      if (L === 0) break;
    }
  }

  // The accent carries a button, and what sits on it is the sheet mixed towards
  // white - so the pair is tested as it will actually be rendered rather than
  // against a nominal white. A hue that cannot clear the floor with a light
  // label gets a dark one instead, which is what Peacock's gold needed by hand.
  const light = mixHex(paper, '#ffffff', 0.55);
  let { L, C } = PIGMENT['--accent'];
  for (let i = 0; i < 40 && contrast(vars['--accent'], light) < ACCENT_FLOOR; i++) {
    L = Math.max(0, L - 0.02);
    vars['--accent'] = hex(L, C, hue);
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
    vars['--accent'] = hex(PIGMENT['--accent'].L, PIGMENT['--accent'].C, hue);
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
 */
export function paletteFromAccent(picked) {
  if (!/^#[0-9a-f]{6}$/i.test(picked)) return null;
  const chosen = picked.toLowerCase();
  const { C, h } = oklch(...parseHex(chosen));
  // A grey has no hue to build from - every direction is equally wrong, and the
  // bins would hand back whatever rounding noise the pick happens to carry.
  if (C < NEUTRAL_C) return null;

  const vars = paletteFor([h]);
  vars['--accent'] = chosen;
  const light = mixHex(vars['--paper'], '#ffffff', 0.55);
  vars['--accent-fg'] =
    contrast(chosen, light) >= contrast(chosen, vars['--ink']) ? light : vars['--ink'];
  return vars;
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
export function extractPalette(chunks) {
  const hues = huesOf(chunks);
  if (!hues.length) return null;
  return paletteFor(hues);
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
  const out = [];
  for (const url of urls.slice(0, MAX_SOURCES)) {
    try {
      const img = new Image();
      img.src = url;
      await img.decode();
      const canvas = new OffscreenCanvas(SAMPLE, SAMPLE);
      const ctx = canvas.getContext('2d', { willReadFrequently: true });
      ctx.drawImage(img, 0, 0, SAMPLE, SAMPLE);
      out.push(ctx.getImageData(0, 0, SAMPLE, SAMPLE).data);
    } catch { /* one picture, one lost vote */ }
  }
  return out;
}
