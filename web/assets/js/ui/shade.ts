// A Debug-fold switch: drop shadows in plain black, or white on the dark sheet,
// instead of mixed from the palette's ink, to judge the coloured ones against.
// Only marks :root; the colours are tokens.css, after section 3c. Kept on the
// device, never in a board. No document reach at import.

import { readPref, writePref } from '../prefs.ts';

const KEY = 'mbrd.neutral-shadows';

/** Whether the shadows are plain rather than the palette's. */
export const neutralShadows = () => readPref(KEY) === '1';

/** data-shade on :root, from the stored choice. */
export function markShade() {
  const root = document.documentElement;
  if (neutralShadows()) root.dataset.shade = 'neutral';
  else delete root.dataset.shade;
}

/** Plain shadows or the palette's, from now and on every visit. */
export function setNeutralShadows(on: boolean) {
  writePref(KEY, on ? '1' : '0');
  markShade();
}
