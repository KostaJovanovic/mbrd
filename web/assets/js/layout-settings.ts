// Shared board settings: palette and typography tokens that are board-wide
// rather than layout-local. Everything else (radii, density, grid) belongs
// to the active layout profile.

export const PALETTE_TOKENS = [
  '--paper', '--paper-2', '--paper-3', '--paper-card',
  '--ink', '--ink-2', '--ink-3', '--rule', '--rule-2',
  '--accent', '--accent-warm', '--accent-deep', '--leafy', '--accent-fg', '--accent-text',
];

export const TYPOGRAPHY_TOKENS = ['--font-display', '--font-body'];
const paletteToken = new Set([...PALETTE_TOKENS, ...TYPOGRAPHY_TOKENS]);

/**
 * Tokens the whimsy axis owns — sliding the axis drops these back to the
 * stylesheet. Rule: the axis owns what only the axis declares (not palette
 * or typography tokens). tests/appearance.test.js holds this list against
 * tokens.css. Lives here (not ui/appearance.ts) so tests can import it.
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

/** Whimsy controls snap on Desktop; Mobile's grid is its own layout setting. */
export const whimsyControlsSnap = (mode: string) => mode !== 'mobile';

/** Some layout-local appearance controls still make sense on Desktop alone. */
export const appearanceControlVisible = (name: string, mode: string) =>
  name !== '--sidebar-w' || mode === 'desktop';

/** Minimum pictures before auto-palette kicks in. Explicit Dynamic menu choice bypasses this. */
export const AUTO_PALETTE_FLOOR = 3;

/** Whether auto-palette should run. Floor is about starting, not staying — once dynamic, it follows all changes. */
export const autoPaletteReady = (pictures: number, dynamic: boolean) =>
  dynamic || pictures >= AUTO_PALETTE_FLOOR;

/** Complete look from a board file or the app. All optional — coerced at the boundary. */
export interface Look {
  whimsy?: number;
  palette?: string;
  vars?: Record<string, string>;
  auto?: boolean;
  derived?: boolean;
}

/** Board-wide vs layout-local halves. Local is vars only — palette and whimsy are board-wide by definition. */
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

  // Written, not spread — absent means "never said", present false means "said no".
  const shared: Look = {
    palette: typeof source.palette === 'string' ? source.palette : '',
    vars: sharedVars,
  };
  if (source.whimsy != null) shared.whimsy = source.whimsy;
  if (source.auto === false) shared.auto = false;
  if (source.derived === true && Object.keys(sharedVars).length) shared.derived = true;
  return { shared, local: { vars: localVars } };
}

/** Rebuild the complete look consumed by ui/appearance.ts. */
export function mergeAppearance(shared: Look = {}, local: Look = {}): Look {
  // Both halves guarded — they arrive off a file as often as from the app.
  const base = shared && typeof shared === 'object' ? shared : {};
  const fromLocal = local?.vars && typeof local.vars === 'object' ? local.vars : {};
  const fromShared = shared?.vars && typeof shared.vars === 'object' ? shared.vars : {};
  // Shared wins, which is what makes a palette token board-wide.
  return { ...base, vars: { ...fromLocal, ...fromShared } };
}
