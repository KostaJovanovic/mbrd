// Colour, as arithmetic. No board, no tokens, no opinion about a palette.
//
// Every function here answers a question that has the same answer in every
// program ever written: what is this sRGB triple in OKLab, what is the closest
// hex the screen can actually show for this OKLCh, how much contrast is there
// between these two hexes. None of it knows what a pigment is, what the sheet is
// for, or that this app has photographs on a board.
//
// It came out of ui/pigments.ts, whose own section comment had already drawn the
// line - the first hundred lines under a heading that said "Colour" and then
// nine hundred under headings about photographs and roles and repair passes.
// Three other modules were reaching past that line by copying the smallest piece
// of it: `[1, 3, 5].map(i => parseInt(s.slice(i, i + 2), 16))` was written out
// three times, in ui/pigments.ts, ui/appearance.ts and ui/color-picker.ts, and
// two of those three were importing pigments.ts already. A helper duplicated by
// modules that import the file it lives in is a helper in the wrong file.
//
// ── Why OKLab and not HSL ──
//
// Carried down from pigments.ts because it is a fact about the space rather than
// about the palette: HSL's lightness is not lightness. #ff0000 and #0000ff are
// both "50%" in HSL and one of them is nearly three times brighter than the
// other, so anything that clusters or ranks by HSL lightness is ranking by
// something nobody can see. OKLab's L is perceptual, which is what makes "same
// lightness, different hue" mean what it says - and what lets hex() below give
// up chroma to stay in gamut while holding lightness exactly, since every
// contrast guarantee anywhere above this file is a statement about lightness.
//
// ── What must not move in here ──
//
// Anything that knows which colour does which job. The tables of measured
// lightness and chroma, the roles, the repair pass, the hue vote, the swatch
// sampler - all of that is ui/pigments.ts and all of it is *about* this app.
// The test for whether something belongs here is whether a stranger writing an
// unrelated program would recognise it as correct without being told what mbrd
// is.
//
// No DOM either, and no CSS. `readToken()` in util.ts reads a custom property
// and ui/look.ts decides what a board may ask for; both are colour arriving from
// somewhere, which is a different subject from colour being converted. This
// module is importable from the base layer, from canvas/ and from ui/ alike -
// tests/layers.test.js lists it in BASE - and one `getComputedStyle` in here
// would end that.
//
// ── Rejected: making these methods on a Color class ──
//
// Tried on paper and dropped. Every caller here has a hex string or three
// channel numbers already, from a stylesheet token or an ImageData buffer, and
// wrapping those in an object means allocating one per pixel in the hot loop
// pigments.ts runs over every photograph on the board. Free functions over
// plain numbers are what that loop wants and what the callers already hold.

/** A colour in OKLCh. `h` in degrees, 0-360; `L` and `C` in OKLab's own units. */
export interface OKLCh {
  L: number;
  C: number;
  h: number;
}

/** Three channels, in whatever range the function that produced them says. */
export type Triple = [number, number, number];

const cbrt = Math.cbrt;

/** sRGB 0-255 -> linear-light 0-1. */
function toLinear(c: number): number {
  c /= 255;
  return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
}

/** linear-light 0-1 -> sRGB 0-255, clamped. */
function toSrgb(c: number): number {
  const v = c <= 0.0031308 ? c * 12.92 : 1.055 * c ** (1 / 2.4) - 0.055;
  return Math.round(Math.min(1, Math.max(0, v)) * 255);
}

/** sRGB 0-255 -> OKLCh. Hue in degrees, 0-360; L and C in OKLab's own units. */
export function oklch(r: number, g: number, b: number): OKLCh {
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
function oklchToLinear(L: number, C: number, h: number): Triple {
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

function inGamut([r, g, b]: Triple): boolean {
  const lo = -1e-4, hi = 1 + 1e-4;
  return r >= lo && r <= hi && g >= lo && g <= hi && b >= lo && b <= hi;
}

/**
 * The most chroma this hue can hold at this lightness and still be sRGB, up to
 * `ceiling`.
 *
 * This is the bisection hex() has always done, given a name - because the wall
 * became something a caller wants to *ask about* rather than only be clipped
 * to. ui/pigments.js walks lightness reading this to find a hue's cusp, which
 * is the one place a colour can be as saturated as the screen allows.
 *
 * Bisection rather than a loop of small steps, because the first attempt is
 * usually in gamut already and this then costs one test.
 */
export function maxChroma(L: number, h: number, ceiling: number): number {
  if (inGamut(oklchToLinear(L, ceiling, h))) return ceiling;
  let lo = 0, hi = ceiling;
  for (let i = 0; i < 18; i++) {
    const mid = (lo + hi) / 2;
    if (inGamut(oklchToLinear(L, mid, h))) lo = mid; else hi = mid;
  }
  return lo;
}

/**
 * OKLCh -> `#rrggbb`, kept inside sRGB by giving up chroma rather than
 * lightness.
 *
 * Which of the two to sacrifice is a real choice and this one is forced: every
 * contrast guarantee the caller makes is a statement about lightness, so a gamut
 * clip that moved L would quietly undo a repair pass that had just run. Clipping
 * the channels instead - the obvious thing - is worse still, because it shifts
 * the hue: clamping a too-blue blue drags it towards cyan, and the palette stops
 * being the one that was chosen.
 */
export function hex(L: number, C: number, h: number): string {
  const [r, g, b] = oklchToLinear(L, maxChroma(L, h, C), h);
  return '#' + [r, g, b].map(v => toSrgb(v).toString(16).padStart(2, '0')).join('');
}

/** WCAG relative luminance from sRGB 0-255. */
export function luminance(r: number, g: number, b: number): number {
  return 0.2126 * toLinear(r) + 0.7152 * toLinear(g) + 0.0722 * toLinear(b);
}

/**
 * `#rrggbb` -> three channels, 0-255.
 *
 * Six digits only, and deliberately unvalidated: every caller has already
 * matched the string against `/^#[0-9a-f]{6}$/` or produced it from hex() above,
 * and a parser that re-checked would be a second, quieter place for that
 * grammar to be written down. A short `#rgb` has to be expanded before it gets
 * here - ui/color-picker.ts is the one place that accepts one, because it is the
 * one place a person types.
 */
export function parseHex(s: string): Triple {
  return [
    parseInt(s.slice(1, 3), 16),
    parseInt(s.slice(3, 5), 16),
    parseInt(s.slice(5, 7), 16),
  ];
}

/** WCAG contrast ratio between two `#rrggbb` strings. */
export function contrast(a: string, b: string): number {
  const x = luminance(...parseHex(a)), y = luminance(...parseHex(b));
  return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05);
}

/**
 * `a` and `b` mixed in sRGB, `t` of the way to `b`. Matches `color-mix()`.
 *
 * In sRGB rather than in OKLab, which looks like the wrong space for a file that
 * argues for OKLab everywhere else, and is not: the point of this one is to
 * agree digit for digit with what the browser would compute for the same mix
 * written in a stylesheet. A perceptually nicer blend that disagreed with
 * `color-mix()` would put a colour computed here and the same colour computed in
 * CSS a shade apart, which is the one failure this cannot have.
 */
export function mixHex(a: string, b: string, t: number): string {
  const [ar, ag, ab] = parseHex(a), [br, bg, bb] = parseHex(b);
  const m = (x: number, y: number) => Math.round(x + (y - x) * t).toString(16).padStart(2, '0');
  return '#' + m(ar, br) + m(ag, bg) + m(ab, bb);
}
