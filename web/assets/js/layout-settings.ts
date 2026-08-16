// Pure helpers for the one part of board settings shared by both layouts.
//
// Color is one identity for the board, even when Desktop and Mobile otherwise
// have independent controls. Everything outside this list belongs to the active
// layout: typefaces, radii, density, grid styling, and panel dimensions.

export const PALETTE_TOKENS = [
  '--paper', '--paper-2', '--paper-3', '--paper-card',
  '--ink', '--ink-2', '--ink-3', '--rule', '--rule-2',
  '--accent', '--accent-warm', '--accent-deep', '--leafy', '--accent-fg',
];

export const TYPOGRAPHY_TOKENS = ['--font-display', '--font-body'];
const paletteToken = new Set([...PALETTE_TOKENS, ...TYPOGRAPHY_TOKENS]);

/**
 * Tokens the whimsy axis owns. A hand-set value beats any stylesheet, which is
 * what you want for a pigment - but not for these: leaving a hand-picked 13px
 * radius inline would keep the corners round in a mode whose whole point is
 * that they are square. So sliding the axis drops them back to the stylesheet.
 *
 * The grid pair belongs here for the same reason - each level sets its own
 * weight and strength, and touching either slider once would otherwise pin the
 * grid for good and leave it ignoring the axis from then on.
 *
 * The snap setting is owned in exactly this spirit without being a token at
 * all; see axisMoved() in ui/appearance.ts for why it is, and for what it
 * costs.
 *
 * ── The rule, and why the list used to be three names long ──
 *
 * It held `--radius`, `--grid-alpha` and `--grid-dot`, out of the sixty the
 * `[data-whimsy]` blocks in tokens.css declare. So a .mbrd carrying
 * `--item-shadow: none` or `--tilt-max: 0deg` - both on the look allowlist,
 * both declared per tier - kept the old level's elevation and lean through
 * every move of the slider, and only Reset appearance could clear them. Three
 * of sixty is not an axis, it is the two controls somebody happened to have
 * been annoyed by.
 *
 * The rule now is: **the axis owns what only the axis declares.** A token a
 * `[data-palette]` block also sets belongs to the palette, and the two faces
 * belong to the face picker - both are chosen out loud, where a tier is a
 * personality. That is PALETTE_TOKENS and TYPOGRAPHY_TOKENS above, which is why
 * they are subtracted rather than a second list being written.
 * tests/appearance.test.js holds both halves against tokens.css, so a token
 * added to a tier block and not to this list fails rather than quietly going on
 * ignoring the slider.
 *
 * Here rather than in ui/appearance.ts, beside the two lists it is defined
 * against: that module touches `document` at import time, so a test cannot read
 * this out of it, and a list nothing can check is the shape of the bug being
 * fixed.
 */
export const AXIS_TOKENS = [
  '--btn-grow', '--btn-lift', '--btn-press', '--card-rule-gap', '--cork',
  '--display-italic', '--display-weight', '--dur-base', '--dur-fast',
  '--dur-travel', '--dur-zoom', '--ease', '--ease-back',
  '--font-mono', '--ghost-edge', '--ghost-ink',
  '--ghost-ink-2', '--ghost-weight', '--grain', '--grid-alpha', '--grid-dot',
  '--grow-hover', '--highlight', '--highlight-ink', '--item-border',
  '--item-shadow', '--lift-drag', '--lift-hover', '--note-1', '--note-2',
  '--note-3', '--note-4', '--note-shadow', '--radius', '--radius-pill',
  '--sel-corner', '--sel-gap', '--sel-line', '--sel-reach', '--shadow-1',
  '--shadow-2', '--stock', '--t-display', '--t-title', '--tilt-drag',
  '--tilt-max', '--vignette', '--wash',
];

/**
 * The whimsy axis may suggest Desktop snapping, but Mobile's grid choice is a
 * layout setting controlled only by its own checkbox after the profile exists.
 */
export const whimsyControlsSnap = (mode: string) => mode !== 'mobile';

/** Some layout-local appearance controls still make sense on Desktop alone. */
export const appearanceControlVisible = (name: string, mode: string) =>
  name !== '--sidebar-w' || mode === 'desktop';

/**
 * How many pictures a board has to hold before it starts colouring itself.
 *
 * Taking the colours from the pictures is on by default, so without a floor the
 * first photograph dropped onto a fresh board turns the whole interface over -
 * paper, ink, rules and all three pigments - on the strength of one file that
 * nobody said was representative of anything. That reads as a fault rather than
 * as a feature, and it is worst exactly where it is most likely: the first thing
 * you ever do with the app.
 *
 * Three is where a board stops being a photograph and starts being a
 * collection, and a collection having a colour of its own is the whole of what
 * this feature is for.
 *
 * The floor governs the *automatic* path alone. Choosing Dynamic from the
 * palette menu is somebody asking out loud, and making them drop two more
 * photographs before the thing they asked for happens would be the same fault
 * pointing the other way.
 */
export const AUTO_PALETTE_FLOOR = 3;

/**
 * Whether an extraction nobody asked for should run.
 *
 * `dynamic` is whether the board is *already* wearing colours taken from its
 * pictures. Once it is, every change follows - including down past the floor,
 * and all the way to none, where the board hands the sheet back to the palette
 * named in the menu. The floor is about starting, not about staying: a board
 * that has been colouring itself since its third photograph must not stop
 * agreeing with its own pictures the moment you delete one.
 */
export const autoPaletteReady = (pictures: number, dynamic: boolean) =>
  dynamic || pictures >= AUTO_PALETTE_FLOOR;

/**
 * One complete look: the board's palette choice and the custom properties it
 * resolves to.
 *
 * Every field is optional because this type stands at a boundary in both
 * directions - it describes what arrives out of somebody else's board.json as
 * well as what the app builds - and the two halves below are total functions
 * over it, coercing rather than trusting. `vars` is declared as a map of
 * strings because that is what the app writes and what board-schema.ts holds an
 * arriving one to; the runtime `typeof` guards are what make that safe for the
 * file that says otherwise.
 */
export interface Look {
  whimsy?: number;
  palette?: string;
  vars?: Record<string, string>;
  auto?: boolean;
  derived?: boolean;
}

/**
 * A look taken apart: the half that belongs to the board and the half that
 * belongs to one layout profile.
 *
 * The local half is only ever vars - a palette and a whimsy level are board-wide
 * by definition - and saying that in the type is what stops a later edit from
 * quietly giving Desktop and Mobile two different palettes.
 */
export type SplitLook = { shared: Look, local: { vars: Record<string, string> } };

/** Split one complete look into its board-wide and layout-local halves. */
export function splitAppearance(look: Look = {}): SplitLook {
  const source = look && typeof look === 'object' ? look : {};
  const sharedVars: Record<string, string> = {};
  const localVars: Record<string, string> = {};
  const vars = source.vars && typeof source.vars === 'object' ? source.vars : {};
  for (const [key, value] of Object.entries(vars)) {
    (paletteToken.has(key) ? sharedVars : localVars)[key] = value;
  }

  // The three optional keys are written rather than spread, and the difference
  // is the one this whole type turns on: absent means "never said", where a
  // present `false` means "said no". mergeAppearance() puts the halves back
  // together by spreading, so a key invented here would outlive the split.
  const shared: Look = {
    palette: typeof source.palette === 'string' ? source.palette : '',
    vars: sharedVars,
  };
  if (source.whimsy != null) shared.whimsy = source.whimsy;
  if (source.auto === false) shared.auto = false;
  if (source.derived === true && Object.keys(sharedVars).length) shared.derived = true;
  return { shared, local: { vars: localVars } };
}

/** Rebuild the complete look consumed by ui/appearance.js. */
export function mergeAppearance(shared: Look = {}, local: Look = {}): Look {
  // Each half named before the merge. Both arguments default to {} but are also
  // guarded, because these two arrive off a file as often as from the app.
  const base = shared && typeof shared === 'object' ? shared : {};
  const fromLocal = local?.vars && typeof local.vars === 'object' ? local.vars : {};
  const fromShared = shared?.vars && typeof shared.vars === 'object' ? shared.vars : {};
  // Shared wins, which is what makes a palette token board-wide.
  return { ...base, vars: { ...fromLocal, ...fromShared } };
}
