// Colour words for Find: "red", "dark green", "pastel", "#3a6ea5". Pure - a
// query in, a test on a #rrggbb out - so it is tested with no browser. Read in
// OKLCh, whose L is perceptual, so "light" and "dark" mean what an eye says.
// A query with any word that is not a colour word is not a colour query: "red
// car" stays a text search for a card called that.

import { oklch, parseHex, type OKLCh } from '../color.ts';
import { hasOwn } from '../util.ts';

/** The basic names, as somebody would type them. */
export const COLOUR_NAMES = [
  'red', 'orange', 'yellow', 'green', 'blue', 'purple', 'pink', 'brown',
  'black', 'white', 'grey', 'gray',
] as const;

/** What narrows a colour, alone ("pastel") or before a name ("dark green"). */
export const COLOUR_MODIFIERS = ['dark', 'light', 'pastel', 'muted', 'warm', 'cool'] as const;

/** Below this chroma a colour is a grey, whatever its hue says. */
const NEUTRAL = 0.04;

/** The one basic name a colour goes by. */
export function colourName({ L, C, h }: OKLCh): string {
  if (L < 0.22) return 'black';
  if (C < NEUTRAL) return L > 0.93 ? 'white' : L < 0.3 ? 'black' : 'grey';
  // Brown is a dark orange or yellow, and a dark red gone dull: a deep red at
  // full chroma (oxblood) stays red.
  if (h >= 20 && h < 115 && L < (h < 75 ? 0.6 : 0.55) && (h >= 40 || C < 0.1)) return 'brown';
  if (h >= 345 || h < 40) return L > 0.75 ? 'pink' : 'red';
  if (h < 75) return 'orange';
  if (h < 115) return 'yellow';
  if (h < 180) return 'green';
  if (h < 275) return 'blue';
  if (h < 320) return 'purple';
  return 'pink';
}

const MODIFIER: Record<(typeof COLOUR_MODIFIERS)[number], (c: OKLCh) => boolean> = {
  dark: c => c.L < 0.5,
  light: c => c.L > 0.75,
  pastel: c => c.L > 0.75 && c.C >= 0.03 && c.C < 0.13,
  muted: c => c.C >= 0.02 && c.C < 0.08,
  warm: c => c.C >= NEUTRAL && (c.h < 110 || c.h >= 330),
  cool: c => c.C >= NEUTRAL && c.h >= 150 && c.h < 300,
};

/** How far apart two colours can be in OKLab and still be "that hex". */
const HEX_REACH = 0.08;

const lch = (hex: string) => oklch(...parseHex(hex));

/** Six digits from #rgb or #rrggbb, or null. The # is required: "facade" is a word. */
function sixDigits(word: string): string | null {
  const m = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(word);
  if (!m) return null;
  const d = m[1].toLowerCase();
  return '#' + (d.length === 3 ? [...d].map(c => c + c).join('') : d);
}

function oklabDistance(a: OKLCh, b: OKLCh): number {
  const ra = a.h * Math.PI / 180, rb = b.h * Math.PI / 180;
  return Math.hypot(a.L - b.L, a.C * Math.cos(ra) - b.C * Math.cos(rb), a.C * Math.sin(ra) - b.C * Math.sin(rb));
}

/**
 * A query read as colour words, as a test one colour passes or fails, or null
 * when the query is not made only of colour words. Every word must hold: "dark
 * blue" is a colour that is dark and blue.
 */
export function colourQuery(query: string): ((hex: string) => boolean) | null {
  const words = query.trim().toLowerCase().split(/[\s,]+/).filter(Boolean);
  if (!words.length) return null;
  const tests: ((c: OKLCh) => boolean)[] = [];
  for (const word of words) {
    const six = sixDigits(word);
    if (six) {
      const want = lch(six);
      tests.push(c => oklabDistance(c, want) < HEX_REACH);
    } else if (COLOUR_NAMES.some(n => n === word)) {
      const name = word === 'gray' ? 'grey' : word;
      tests.push(c => colourName(c) === name);
    } else if (hasOwn(MODIFIER, word)) {
      // SAFETY: hasOwn above said it is one of MODIFIER's own keys, never an inherited one.
      tests.push(MODIFIER[word as keyof typeof MODIFIER]);
    } else {
      return null;
    }
  }
  return hex => {
    const c = lch(hex);
    return tests.every(t => t(c));
  };
}
