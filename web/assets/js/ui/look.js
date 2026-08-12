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
  '--dur-fast', '--dur-palette', '--dur-travel', '--dur-zoom', '--ease', '--ease-back',
  '--font-body', '--font-display', '--font-mono', '--font-sans',
  '--font-serif', '--font-serif-display', '--font-serif-text',
  '--ghost-edge', '--ghost-ink', '--ghost-ink-2', '--ghost-weight',
  '--grain', '--grid-alpha',
  '--grid-axis', '--grid-dot', '--grid-major', '--grid-minor',
  '--grow-hover', '--hairline', '--highlight', '--highlight-ink',
  '--ink', '--ink-2', '--ink-3',
  '--item-bg', '--item-border', '--item-shadow', '--leaf', '--leafy',
  '--lift-drag', '--lift-hover', '--ls-scale', '--note-1', '--note-2',
  '--note-3', '--note-4', '--note-radius', '--note-shadow', '--ogee',
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
export function safeVars(vars) {
  const out = {};
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
