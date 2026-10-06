// Light or dark: the board's own choice, `dark` in its look (ui/look.ts), so a
// board made dark opens dark wherever it is opened. Light is the default. This
// keeps data-scheme on :root in step with the look; index.html's pre-paint script
// reads the same flag off the stored look first. The dark colours are tokens.css
// section 3c and darkSheet() in ui/pigments.ts. No document reach at import.

/**
 * Only where color-mix() exists: section 3c leans on it, and section 7, the
 * palette without it, has no dark twin. The pre-paint script asks the same.
 */
export const canDark = () =>
  typeof CSS !== 'undefined' && !!CSS.supports?.('color', 'color-mix(in srgb, red, blue)');

/** Whether the page is dark right now. */
export const isDarkShown = () =>
  typeof document === 'object' && document.documentElement.dataset.scheme === 'dark';

/** data-scheme for a look that is dark or not. */
export function markScheme(dark: boolean) {
  const root = document.documentElement;
  if (dark && canDark()) root.dataset.scheme = 'dark';
  else delete root.dataset.scheme;
}

/**
 * The checkbox's way in. ui/appearance.ts owns the look and wires itself here,
 * since the settings schema is data and may not import it; unwired, nothing.
 */
let darken: (on: boolean) => void = () => {};
export function setDarkHandler(fn: (on: boolean) => void) { darken = fn; }
export const setDark = (on: boolean) => darken(on);
