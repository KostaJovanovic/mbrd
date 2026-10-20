// The wallpaper's arithmetic (research/wallpaper-graphics-2026-10-20.md): which
// family of pieces a palette gets, the tones they are painted in, and which
// arrangement a board lands on. Pure - colours in, strings out - so it is tested
// with no browser; ui/wallpaper.ts reads the page and puts the answers on it.

import { colourName } from '../colour-words.ts';
import { hex, type OKLCh } from '../color.ts';

/** The families, one per basic colour name colourName() gives. */
export const FAMILIES = [
  'red', 'orange', 'yellow', 'green', 'blue', 'purple', 'pink', 'brown', 'white', 'grey', 'black',
] as const;
export type Family = typeof FAMILIES[number];

/** How many arrangements each family has: web/assets/img/wallpaper/<family>-<n>.svg, n from 1.
 *  Two each for now, a plant and a stone or feather, and five for green: the
 *  drawn stand-ins for the photographs the maintainer means to source later. */
export const PIECES: Readonly<Record<Family, number>> = Object.freeze({
  red: 2, orange: 2, yellow: 2, green: 5, blue: 2, purple: 2,
  pink: 2, brown: 2, white: 2, grey: 2, black: 2,
});

/** Where an arrangement is, document-relative like every asset path. */
export const pieceURL = (family: Family, n: number) => `./assets/img/wallpaper/${family}-${n}.svg`;

/** The family a palette's accent belongs to. */
export function familyOf(accent: OKLCh): Family {
  const name = colourName(accent);
  return isFamily(name) ? name : 'grey';
}

const isFamily = (name: string): name is Family => FAMILIES.some(f => f === name);

/** The tone names, highlight first, deepest last. The SVGs' classes are these. */
export const TONES = ['hi', '1', '2', '3', '4', '5'] as const;

/**
 * Steps from the paper, in OKLab lightness, and how much chroma each carries
 * against the paper's own. The light set sinks into the sheet as the
 * photographs do; the dark one is low-key: bodies a breath above the paper,
 * shade below it, a highlight that reads as rim light.
 */
const LIGHT_STEPS = [0.035, -0.05, -0.12, -0.21, -0.31, -0.42];
const DARK_STEPS = [0.24, 0.14, 0.085, 0.04, -0.03, -0.07];
const CHROMA = [0.6, 1.2, 1.5, 1.7, 1.6, 1.3];

/** How far the tones' hue leans from the paper's toward the accent's. */
const HUE_LEAN = 0.25;
/** Below this the paper reads as no colour, and the accent's hue is used whole. */
const GREY_PAPER = 0.015;
/** Below this the accent is a grey too, and the pieces stay as grey as the paper. */
const GREY_ACCENT = 0.04;

/** The shorter way round from a to b, t of the way. */
function leanHue(a: number, b: number, t: number) {
  const d = ((b - a + 540) % 360) - 180;
  return (a + d * t + 360) % 360;
}

/**
 * The six tones, as `#rrggbb` by name, plus `eye`: the accent itself, for the
 * small focal detail a piece is allowed. Family from the accent, tone from the
 * paper - the maintainer's answer, and what the reference photographs do.
 */
export function wallpaperTones(paper: OKLCh, accent: OKLCh, dark: boolean): Record<string, string> {
  const greyAccent = accent.C < GREY_ACCENT;
  const h = paper.C < GREY_PAPER && !greyAccent ? accent.h
    : greyAccent ? paper.h : leanHue(paper.h, accent.h, HUE_LEAN);
  // A grey family stays grey; otherwise at least enough colour to tell the
  // family, however pale the sheet.
  const base = greyAccent ? Math.min(paper.C, 0.02) : Math.max(paper.C, Math.min(accent.C * 0.35, 0.05), 0.02);
  const steps = dark ? DARK_STEPS : LIGHT_STEPS;
  const out: Record<string, string> = {};
  TONES.forEach((tone, i) => {
    const L = Math.min(0.995, Math.max(0.06, paper.L + steps[i]));
    out[tone] = hex(L, Math.min(0.16, base * CHROMA[i]), h);
  });
  out.eye = hex(accent.L, accent.C, accent.h);
  return out;
}

/** A small stable hash of a string, for the pick below. FNV-1a. */
function hash32(s: string) {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

/** The arrangement a board lands on within a family: the same every time it opens. */
export function pieceFor(seed: string, family: Family): number {
  return (hash32(seed + '/' + family) % PIECES[family]) + 1;
}
