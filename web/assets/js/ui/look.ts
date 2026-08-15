// What a look is allowed to be.
//
// Split out of appearance.js so it can be tested: appearance.js reaches for
// document at import time, by design - it is one of the two modules that owns
// DOM - and this is the half that is pure data and most wants holding to.
//
// The reason it exists at all is that `settings.appearance.vars` is the only
// part of a board that reaches the browser as *code* rather than as content.
// Everything else in a .mbrd is text, coordinates and bytes; this is a set of
// CSS declarations, out of a file that arrived from somewhere else.

/**
 * Every design token a look may set.
 *
 * Handed straight to `style.setProperty`, the field named "per-token
 * overrides" would set any CSS property at all. Two that need no script:
 *
 *   { "display": "none" }                       - the app vanishes on open
 *   { "background-image": "url(https://...)" }  - an outbound request from an
 *                                                 app whose first promise is
 *                                                 that nothing is uploaded
 *
 * So a look may name these and nothing else. The list is the tokens declared
 * in tokens.css, and tests/appearance.test.js holds the two to each other -
 * the same arrangement as sw.js's SHELL, and for the same reason: a
 * hand-maintained list beside a file that grows is a list that silently stops
 * matching. tokens.css is where a new token is born; this is where it becomes
 * something a board is allowed to ask for.
 */
export const TOKENS = new Set([
  '--accent', '--accent-deep', '--accent-fg', '--accent-warm',
  '--btn-grow', '--btn-lift', '--btn-press', '--card-rule-gap',
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
  '--ink', '--ink-2', '--ink-3',
  '--item-bg', '--item-border', '--item-shadow', '--leaf', '--leafy',
  '--lift-drag', '--lift-hover', '--ls-scale', '--note-1', '--note-2',
  '--note-3', '--note-4', '--note-radius', '--note-shadow',
  '--note-wash-amber', '--note-wash-graphite', '--note-wash-olive',
  '--note-wash-terracotta', '--ogee',
  '--paper', '--paper-2', '--paper-3', '--paper-card', '--radius',
  '--radius-pill', '--radius-sm', '--radius-xs', '--rule', '--rule-2', '--sel-corner',
  '--sel-gap', '--sel-line', '--sel-reach', '--select', '--select-fill',
  '--shadow-1', '--shadow-2', '--sheet-fill', '--sheet-grip', '--sheet-line',
  '--sidebar-w',
  '--sticker-1', '--sticker-2', '--sticker-3', '--sticker-4', '--sticker-5',
  '--sticker-6', '--sticker-7', '--sticker-8', '--sticker-body',
  '--stock', '--t-body',
  '--t-display', '--t-small', '--t-tiny', '--t-title', '--tilt-drag',
  '--tilt-max', '--vignette', '--wash', '--web-line', '--web-weight',
]);

/**
 * The shape of a value we will hand to the CSSOM.
 *
 * The names above are only half of it. An unknown custom property is inert -
 * nothing reads it - but an *allowed* one is substituted into real
 * declarations all over the CSS, so `--paper: url(https://...)` would still
 * fetch. What a token actually holds is a colour, a length, a number, a font
 * stack, a shadow or an easing curve, and all of those live inside this
 * alphabet.
 *
 * What it leaves out is the point: no backslash escapes, no `;` or `}` to end
 * the declaration early, no `@`, no `<`. Length-capped as well, because a
 * token is a value and not a document.
 */
const SAFE_VALUE = /^[-a-z0-9#%.,()/+*_'" ]{1,160}$/i;

/**
 * Functions a value may call.
 *
 * An allowlist rather than a ban on `url(`, because the ways to name a
 * resource in CSS are not a closed set you can enumerate from memory -
 * `image-set()`, `attr()`, `element()`, `-webkit-image-set()` and whatever
 * ships next all do it. Naming the handful that are arithmetic and colour
 * leaves the rest out by construction.
 *
 * `var()` is here because it resolves to another custom property, which has
 * been through this same filter.
 */
const SAFE_FN = new Set([
  'rgb', 'rgba', 'hsl', 'hsla', 'hwb', 'lab', 'lch', 'oklab', 'oklch',
  'color', 'color-mix', 'calc', 'min', 'max', 'clamp', 'var',
  'cubic-bezier', 'steps', 'linear',
]);

/**
 * A look's `vars`, reduced to what is safe to apply.
 *
 * Filtered rather than rejected wholesale: a board carrying one token this
 * version has never heard of should lose that token, not its whole look.
 */
export function safeVars(vars: unknown): Record<string, string> {
  const out: Record<string, string> = {};
  if (!vars || typeof vars !== 'object') return out;
  for (const [key, value] of Object.entries(vars)) {
    if (!TOKENS.has(key) || typeof value !== 'string') continue;
    if (!SAFE_VALUE.test(value)) continue;
    const fns = [...value.matchAll(/([a-z][a-z0-9-]*)\s*\(/gi)].map(m => m[1].toLowerCase());
    if (fns.some(fn => !SAFE_FN.has(fn))) continue;
    out[key] = value;
  }
  return out;
}

// ---------------------------------------------------------------------------
// The look model
// ---------------------------------------------------------------------------
//
// What a look *is*, separate from how one is applied to a document.
//
// This half came out of ui/appearance.ts, which was one file doing about six
// jobs - the data model, the persistence, the pigment extraction, the fade
// loop, the control building and the colour conversion. This is the first of
// them, and it landed here rather than in a new module because the allowlist it
// depends on was already here: `clone()` calls `safeVars()`, and a model whose
// rules live in one file and whose vocabulary lives in another is the same
// split-brain the move is meant to end.
//
// Nothing below touches the DOM, which is the property that makes it worth
// separating. It can be reasoned about, and tested, without a browser.

import { clamp } from '../util.ts';
import type { Look } from './appearance-controls.ts';

/** The three stops on the whimsy axis, in order, as the slider labels them. */
export const WHIMSY = ['Softish', 'Middle', 'Harsh.'];

/** Middle. A board that has never been near the slider is at this one. */
export const DEFAULT_WHIMSY = 1;

/**
 * A level the stylesheet actually answers to.
 *
 * Clamped, not trusted: this value arrives from localStorage, from the slider,
 * and from other people's .mbrd files, and an out-of-range one would set a
 * data-whimsy no rule matches - leaving the interface in whatever the base look
 * is while the slider claims otherwise. `|| 0` catches the non-number, since
 * clamping NaN only gives NaN back.
 */
export const clampWhimsy = (v: unknown) =>
  clamp(Math.round(Number(v)) || 0, 0, WHIMSY.length - 1);

/**
 * The two fields of a look that are not tokens.
 *
 * Neither is ever applied to :root - they describe the look rather than being
 * part of it - but both have to survive cloneLook(), because that is what every
 * look passes through. A flag dropped here is dropped on every save, every
 * reload and every board that travels with an extracted palette.
 *
 *   derived  who wrote these pigments. Provenance, set when a palette is
 *            extracted and cleared the moment a pigment is set by hand. It
 *            decides whether switching palette drops two tokens or all fourteen.
 *   auto     whether the board may take its colours from the pictures at all.
 *            The user's setting, written by the two ends of the palette menu -
 *            Dynamic deletes it, a named palette sets it false.
 *
 * `auto` is stored inverted - present and false means off, absent means on -
 * because on is the default. A board that has never been near this setting has
 * no field for it, and that has to mean the same thing as a board that chose
 * Dynamic, or the default would only apply to boards made after it changed.
 * The only value written is `false`; choosing Dynamic deletes the field.
 *
 * Both are held to an exact value, and `derived` additionally to there being
 * something for it to be true *of* - so a .mbrd claiming a derived look with no
 * pigments in it cannot make the palette menu throw away tokens it never wrote.
 */
function withProvenance(from: Partial<Look> | null | undefined, look: Look): Look {
  if (from?.derived === true && Object.keys(look.vars).length) look.derived = true;
  if (from?.auto === false) look.auto = false;
  return look;
}

/**
 * Every look the app handles - the user's stored one, the one a board brought,
 * the one a control just edited - is built here, which is what makes this the
 * one place the rules have to hold. `vars` is filtered rather than rejected
 * wholesale: a board with one bad token should lose that token, not its look.
 */
export const cloneLook = (look: Partial<Look> | null | undefined): Look =>
  withProvenance(look, {
    whimsy: look?.whimsy == null ? DEFAULT_WHIMSY : clampWhimsy(look.whimsy),
    // Becomes an attribute value that stylesheet rules match on, so it is held
    // to the shape a palette name has rather than trusted to be one.
    //
    // The typeof guard is load-bearing, not defensive padding. RegExp.test()
    // coerces its argument to a string, and `String(undefined)` is "undefined" -
    // twenty-four lowercase letters, which this pattern happily matches. So a
    // `look` of null took the true branch and then threw on `look.palette`, and
    // cloneLook(null) is not a hypothetical: the stored look is whatever the
    // preference store returns, which is null on any browser that has never
    // saved one. A fresh profile therefore threw before a single control had
    // been built - the palette menu, the whimsy slider and every token control
    // were dead on a first visit, and only on a first visit.
    palette: typeof look?.palette === 'string' && /^[a-z0-9-]{1,24}$/i.test(look.palette)
      ? look.palette : '',
    vars: safeVars(look?.vars),
  });

/** Whether the extraction is on. Absent means on - see withProvenance(). */
export const autoOn = (look: Partial<Look> | null | undefined) => look?.auto !== false;

/**
 * Does this look say anything at all?
 *
 * Compared against the default rather than tested for truthiness: whimsy 0 is
 * Softish, a deliberate choice, and `!0` would file a board saved at that end of
 * the axis as having brought no look at all.
 */
export const hasLook = (look: Partial<Look> | null | undefined) =>
  !!look && ((look.whimsy != null && +look.whimsy !== DEFAULT_WHIMSY) ||
             !!look.palette || Object.keys(look.vars || {}).length > 0);

/**
 * Are these two looks the same look?
 *
 * **Field by field, because a string compare was answering a different
 * question.** This used to be `JSON.stringify(clone(a)) === JSON.stringify(clone(b))`,
 * with a comment explaining that clone() made it safe by fixing the key order -
 * which is true of the four named fields and was never true of `vars`, whose
 * keys arrive in whatever order the palette that wrote them happened to use.
 * Two identical looks whose pigments were set in a different sequence compared
 * as different, and the cost of a false negative is not a wasted cycle: it
 * re-applies a look identical to the one already on screen, and the re-apply is
 * what clears `derived`. So a board could quietly lose the provenance of its own
 * extracted palette by being told about itself.
 *
 * cloneLook() stays, and not for the key order. It is the normaliser - it clamps
 * whimsy, holds the palette id to a pattern, drops junk out of `vars` and
 * carries the two provenance flags - so what is compared is two looks the app
 * would actually accept, rather than two things that arrived.
 */
export const sameLook = (
  a: Partial<Look> | null | undefined,
  b: Partial<Look> | null | undefined,
) => {
  const x = cloneLook(a);
  const y = cloneLook(b);
  return x.whimsy === y.whimsy
    && x.palette === y.palette
    // Both are `false | undefined` by withProvenance(), and the difference
    // between them is meaningful - see the note there on why `auto` is stored
    // inverted - so this is === rather than a truthiness test.
    && x.auto === y.auto
    && x.derived === y.derived
    && sameVars(x.vars, y.vars);
};

/** Two token maps, compared as maps rather than as text. */
const sameVars = (a: Record<string, string>, b: Record<string, string>) => {
  const keys = Object.keys(a);
  if (keys.length !== Object.keys(b).length) return false;
  for (const key of keys) if (a[key] !== b[key]) return false;
  return true;
};
