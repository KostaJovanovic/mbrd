// Puts the board's look on a chrome page: the whimsy tier, the palette, the
// per-token overrides and the quality level, read from the localStorage the
// board writes (one origin). Loaded as a blocking script in each page's head, so
// it runs before first paint, and imported by titlebar.ts to follow a change.
// The token filter is the board's own (web/assets/js/ui/look.ts), not a copy.

import { safeVars } from '../../web/assets/js/ui/look.ts';

/** Each field is checked where it is read. */
interface Stored {
  whimsy?: unknown;
  palette?: unknown;
  vars?: unknown;
  level?: unknown;
}

/** The custom properties this page set, so a change can take them off again. */
const applied = new Set<string>();

function read(key: string): Stored {
  try {
    const value: unknown = JSON.parse(localStorage.getItem(key) || '{}');
    // SAFETY: a non-null object, and every field of Stored is unknown and checked where it is read.
    return value && typeof value === 'object' ? value as Stored : {};
  } catch {
    return {};
  }
}

/** The same rules index.html's pre-paint script holds each value to. */
export function applyLook(): void {
  const root = document.documentElement;
  const look = read('mbrd.appearance');

  const whimsy = String(look.whimsy ?? '');
  if (/^[0-2]$/.test(whimsy)) root.dataset.whimsy = whimsy;
  else delete root.dataset.whimsy;

  const palette = look.palette;
  if (typeof palette === 'string' && /^[a-z0-9-]{1,24}$/i.test(palette)) root.dataset.palette = palette;
  else delete root.dataset.palette;

  const level = read('mbrd.quality').level;
  if (typeof level === 'string' && /^(light|balanced|full)$/.test(level)) root.dataset.quality = level;
  else delete root.dataset.quality;

  const vars = safeVars(look.vars);
  for (const key of applied) {
    if (key in vars) continue;
    root.style.removeProperty(key);
    applied.delete(key);
  }
  for (const [key, value] of Object.entries(vars)) {
    root.style.setProperty(key, value);
    applied.add(key);
  }
}

applyLook();
