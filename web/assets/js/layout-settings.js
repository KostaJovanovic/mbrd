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

/** Split one complete look into its board-wide and layout-local halves. */
export function splitAppearance(look = {}) {
  const source = look && typeof look === 'object' ? look : {};
  const sharedVars = {};
  const localVars = {};
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
