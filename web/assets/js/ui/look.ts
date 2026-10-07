// Look validation and model — the pure-data half of appearance.ts, split out
// so it can be tested without DOM. vars is the only part of a board that
// reaches the browser as code (CSS declarations), so it is sanitised here.

/** Allowlist of CSS custom properties a look may set. Must match tokens.css —
 * tests/appearance.test.js enforces the parity. Without this, vars would let
 * a .mbrd set any CSS property (display:none, url() fetches, etc). */
export const TOKENS = new Set([
  '--accent', '--accent-deep', '--accent-fg', '--accent-text', '--accent-warm',
  '--body-italic', '--btn-grow', '--btn-lift', '--btn-press', '--card-rule-gap',
  '--chrome-button-h', '--chrome-button-touch', '--chrome-button-w', '--cork',
  '--danger', '--density', '--display-italic', '--display-weight', '--dur-base',
  '--dur-fast', '--dur-palette', '--dur-travel', '--dur-zoom',
  '--ease', '--ease-back', '--ease-in',
  '--font-body', '--font-display', '--font-mono', '--font-sans',
  '--font-serif', '--font-serif-display', '--font-serif-text',
  '--ghost-edge', '--ghost-ink', '--ghost-ink-2', '--ghost-weight',
  '--grain', '--grid-alpha',
  '--grid-axis', '--grid-dot', '--grid-major', '--grid-minor',
  '--grow-hover', '--hairline', '--highlight', '--highlight-ink',
  '--icon-button', '--icon-glyph',
  '--ink', '--ink-2', '--ink-3',
  '--item-bg', '--item-border', '--item-shadow', '--leaf', '--leafy',
  '--lift-drag', '--lift-hover', '--ls-scale', '--note-1', '--note-2',
  '--note-3', '--note-4', '--note-radius', '--note-shadow',
  '--note-wash-amber', '--note-wash-graphite', '--note-wash-olive',
  '--note-wash-terracotta',
  '--paper', '--paper-2', '--paper-3', '--paper-card', '--radius',
  '--radius-pill', '--radius-sm', '--radius-xs', '--rule', '--rule-2', '--sel-corner',
  '--sel-gap', '--sel-line', '--sel-reach', '--select', '--select-fill',
  '--shade', '--shadow-1', '--shadow-2', '--sheet-fill', '--sheet-grip', '--sheet-line',
  '--sidebar-w',
  '--sticker-1', '--sticker-2', '--sticker-3', '--sticker-4', '--sticker-5',
  '--sticker-6', '--sticker-7', '--sticker-8', '--sticker-body',
  '--stock', '--t-body',
  '--t-display', '--t-small', '--t-tiny', '--t-title', '--tilt-drag',
  '--tilt-max', '--vignette', '--wash', '--web-line', '--web-weight',
  // No --z-*: stacking ladder lives in base.css and must not be settable by a board.
]);

/** Value shape: colours, lengths, numbers, font stacks, shadows, easings.
 * No escapes, no ; } @ < — an allowed property is substituted everywhere. */
const SAFE_VALUE = /^[-a-z0-9#%.,()/+*_'" ]{1,160}$/i;

/** Allowed CSS functions — allowlist not denylist, because resource-fetching
 * functions (url, image-set, attr, ...) are not a closed set. */
const SAFE_FN = new Set([
  'rgb', 'rgba', 'hsl', 'hsla', 'hwb', 'lab', 'lch', 'oklab', 'oklch',
  'color', 'color-mix', 'calc', 'min', 'max', 'clamp', 'var',
  'cubic-bezier', 'steps', 'linear',
]);

/** What a board saved before Piazzolla joined the stacks, mapped forward so the
 *  menu still shows the face as chosen and Cyrillic gets the serif. */
const RETIRED_STACKS: Record<string, string> = {
  '"Playfair", Georgia, serif': PLAYFAIR_STACK,
  '"Fraunces", Georgia, serif': FRAUNCES_STACK,
};

/** Filter vars to safe-to-apply tokens. Unknown tokens are dropped, not the whole look. */
export function safeVars(vars: unknown): Record<string, string> {
  const out: Record<string, string> = {};
  if (!vars || typeof vars !== 'object') return out;
  for (const [key, value] of Object.entries(vars)) {
    if (!TOKENS.has(key) || typeof value !== 'string') continue;
    if (!SAFE_VALUE.test(value)) continue;
    const fns = [...value.matchAll(/([a-z][a-z0-9-]*)\s*\(/gi)].map(m => m[1].toLowerCase());
    if (fns.some(fn => !SAFE_FN.has(fn))) continue;
    // "Same as display" left the body font list (research/old/done-2026-09-15.md,
    // R6). A look that still carries it reads as the default body font.
    if (key === '--font-body' && value.replace(/\s/g, '') === 'var(--font-display)') continue;
    out[key] = RETIRED_STACKS[value] ?? value;
  }
  return out;
}

// ---------------------------------------------------------------------------
// The look model
// ---------------------------------------------------------------------------
// Pure data model for looks — no DOM. cloneLook() normalises and filters
// every look the app handles.

import { clamp } from '../util.ts';
import { PLAYFAIR_STACK, FRAUNCES_STACK } from '../layout-settings.ts';
export { PLAYFAIR_STACK, FRAUNCES_STACK };
import type { Look } from './appearance-controls.ts';

/** The three stops on the whimsy axis, in order, as the slider labels them. */
export const WHIMSY = ['Softish', 'Middle', 'Harsh.'];

/** Middle. A board that has never been near the slider is at this one. */
export const DEFAULT_WHIMSY = 1;

/** Clamp to a valid whimsy index. || 0 catches NaN (clamp alone returns NaN). */
export const clampWhimsy = (v: unknown) =>
  clamp(Math.round(Number(v)) || 0, 0, WHIMSY.length - 1);

/** Carry the two provenance flags through cloneLook().
 * `derived`: who wrote the pigments (extraction vs hand). `auto`: whether
 * dynamic palette is on (absent = on, false = off — inverted because on is
 * the default and old boards have no field). And `dark`, present only as true,
 * since light is the default and old boards have no field either. */
function withProvenance(from: Partial<Look> | null | undefined, look: Look): Look {
  if (from?.derived === true && Object.keys(look.vars).length) look.derived = true;
  if (from?.auto === false) look.auto = false;
  if (from?.dark === true) look.dark = true;
  return look;
}

/** Normalise a look: clamp whimsy, validate palette id, filter vars. */
export const cloneLook = (look: Partial<Look> | null | undefined): Look =>
  withProvenance(look, {
    whimsy: look?.whimsy == null ? DEFAULT_WHIMSY : clampWhimsy(look.whimsy),
    // typeof guard is load-bearing: RegExp.test() coerces undefined to "undefined"
    // which matches the pattern, then look.palette throws on a null look.
    palette: typeof look?.palette === 'string' && /^[a-z0-9-]{1,24}$/i.test(look.palette)
      ? look.palette : '',
    vars: safeVars(look?.vars),
  });

/** Whether the extraction is on. Absent means on - see withProvenance(). */
export const autoOn = (look: Partial<Look> | null | undefined) => look?.auto !== false;

/** Whether the look differs from default. Compares values, not truthiness —
 * whimsy 0 (Softish) is a deliberate choice, not "no look". */
export const hasLook = (look: Partial<Look> | null | undefined) =>
  !!look && ((look.whimsy != null && +look.whimsy !== DEFAULT_WHIMSY) ||
             !!look.palette || look.dark === true || Object.keys(look.vars || {}).length > 0);

/** Field-by-field equality after normalising both sides. Not JSON.stringify —
 * that was key-order sensitive and a false negative cleared `derived`. */
export const sameLook = (
  a: Partial<Look> | null | undefined,
  b: Partial<Look> | null | undefined,
) => {
  const x = cloneLook(a);
  const y = cloneLook(b);
  return x.whimsy === y.whimsy
    && x.palette === y.palette
    // false vs undefined is meaningful (auto is stored inverted) — strict ===.
    && x.auto === y.auto
    && x.derived === y.derived
    && x.dark === y.dark
    && sameVars(x.vars, y.vars);
};

/** Two token maps, compared as maps rather than as text. */
const sameVars = (a: Record<string, string>, b: Record<string, string>) => {
  const keys = Object.keys(a);
  if (keys.length !== Object.keys(b).length) return false;
  for (const key of keys) if (a[key] !== b[key]) return false;
  return true;
};
