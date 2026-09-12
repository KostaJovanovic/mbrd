// Pure colour arithmetic in OKLab/OKLCh. No board, no DOM, no CSS.
// OKLab over HSL because its L is perceptual — every contrast guarantee
// above this file is a statement about lightness. Importable from BASE layer.
// App-specific colour logic (roles, repair, swatches) stays in ui/pigments.ts.

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

/** Maximum in-gamut chroma at this L and hue, up to `ceiling`. Binary search. */
export function maxChroma(L: number, h: number, ceiling: number): number {
  if (inGamut(oklchToLinear(L, ceiling, h))) return ceiling;
  let lo = 0, hi = ceiling;
  for (let i = 0; i < 18; i++) {
    const mid = (lo + hi) / 2;
    if (inGamut(oklchToLinear(L, mid, h))) lo = mid; else hi = mid;
  }
  return lo;
}

/** OKLCh -> #rrggbb, clipped by reducing chroma (not lightness — that would break contrast). */
export function hex(L: number, C: number, h: number): string {
  const [r, g, b] = oklchToLinear(L, maxChroma(L, h, C), h);
  return '#' + [r, g, b].map(v => toSrgb(v).toString(16).padStart(2, '0')).join('');
}

/** WCAG relative luminance from sRGB 0-255. */
export function luminance(r: number, g: number, b: number): number {
  return 0.2126 * toLinear(r) + 0.7152 * toLinear(g) + 0.0722 * toLinear(b);
}

/** #rrggbb -> [r, g, b] 0-255. Six digits only — callers pre-validate. */
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

/** Mix in sRGB (not OKLab) to match CSS color-mix() digit for digit. */
export function mixHex(a: string, b: string, t: number): string {
  const [ar, ag, ab] = parseHex(a), [br, bg, bb] = parseHex(b);
  const m = (x: number, y: number) => Math.round(x + (y - x) * t).toString(16).padStart(2, '0');
  return '#' + m(ar, br) + m(ag, bg) + m(ab, bb);
}
