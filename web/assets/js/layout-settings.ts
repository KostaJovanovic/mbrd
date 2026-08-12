// @ts-nocheck - TypeScript migration debt, not a judgement about this file.
//
// The tree was renamed from .js to .ts mechanically, which moved 104 modules in
// one step and annotated none of them. This module is carried unchecked so that
// npm run typecheck stays green and keeps meaning something, rather than going
// red and being ignored. Converting this module IS deleting this block and
// fixing what tsc then says - tests/ts-debt.test.js holds the count and lets it
// only fall.
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
 * The whimsy axis may suggest Desktop snapping, but Mobile's grid choice is a
 * layout setting controlled only by its own checkbox after the profile exists.
 */
export const whimsyControlsSnap = mode => mode !== 'mobile';

/** Some layout-local appearance controls still make sense on Desktop alone. */
export const appearanceControlVisible = (name, mode) =>
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
export const autoPaletteReady = (pictures, dynamic) =>
  dynamic || pictures >= AUTO_PALETTE_FLOOR;

/**
 * Split one complete look into its board-wide and layout-local halves.
 *
 * @typedef {object} Look
 * @property {number}  [whimsy]
 * @property {string}  [palette]
 * @property {Record<string, string>} [vars]
 * @property {boolean} [auto]
 * @property {boolean} [derived]
 *
 * @param {Look} [look]
 * @returns {{shared: Look, local: {vars: Record<string, string>}}}
 */
export function splitAppearance(look = {}) {
  const source = look && typeof look === 'object' ? look : {};
  /** @type {Record<string, string>} */ const sharedVars = {};
  /** @type {Record<string, string>} */ const localVars = {};
  const vars = source.vars && typeof source.vars === 'object' ? source.vars : {};
  for (const [key, value] of Object.entries(vars)) {
    (paletteToken.has(key) ? sharedVars : localVars)[key] = value;
  }

  const shared = {
    ...(source.whimsy != null ? { whimsy: source.whimsy } : {}),
    palette: typeof source.palette === 'string' ? source.palette : '',
    vars: sharedVars,
    ...(source.auto === false ? { auto: false } : {}),
    ...(source.derived === true && Object.keys(sharedVars).length ? { derived: true } : {}),
  };
  return { shared, local: { vars: localVars } };
}

/** Rebuild the complete look consumed by ui/appearance.js. */
export function mergeAppearance(shared = {}, local = {}) {
  return {
    ...(shared && typeof shared === 'object' ? shared : {}),
    vars: {
      ...(local?.vars && typeof local.vars === 'object' ? local.vars : {}),
      ...(shared?.vars && typeof shared.vars === 'object' ? shared.vars : {}),
    },
  };
}
