// Read palette swatches from the stylesheet that defines them.
// Broken out of appearance-controls.ts to avoid a cycle through
// settings-schema → panel → appearance-controls.
// Imports nothing; touches document only when called.

/** The three tokens that visually distinguish palettes: ground, accent, ink. */
const SWATCH_TOKENS = ['--paper', '--accent', '--ink'];

// Swatch colours for one palette value. Walks cssRules rather than
// getComputedStyle so Papyrus reads the sheet, not Dynamic's inline overrides.
// Empty return is valid (draws label with no chips). Cross-origin sheets
// are caught and skipped.
export function paletteSwatches(value: string): string[] {
  const want = value ? `:root[data-palette="${value}"]` : ':root';
  // Match the whimsy tier so chips reflect the dressed palette, not mid-tier.
  // Read off the attribute to avoid importing the look model (cycle).
  const tier = document.documentElement.dataset.whimsy || '1';
  const dressed = value
    ? `:root[data-whimsy="${tier}"][data-palette="${value}"]`
    : `:root[data-whimsy="${tier}"]`;
  // In the dark, the twins in tokens.css 3c as well, which come after and so win.
  const selectors = new Set([want, dressed]);
  if (document.documentElement.dataset.scheme === 'dark') {
    const dark = ':root[data-scheme="dark"]';
    const palette = value ? `[data-palette="${value}"]` : '';
    selectors.add(dark + palette);
    if (tier !== '1') selectors.add(`${dark}[data-whimsy="${tier}"]${palette}`);
  }
  const found: Record<string, string> = {};
  for (const sheet of document.styleSheets) {
    let rules: CSSRuleList;
    try { rules = sheet.cssRules; } catch { continue; }
    for (const rule of rules) {
      if (!(rule instanceof CSSStyleRule)) continue;
      // Later rules overwrite earlier — mirrors the cascade, no second pass needed.
      if (!selectors.has(rule.selectorText)) continue;
      for (const t of SWATCH_TOKENS) {
        const v = rule.style.getPropertyValue(t).trim();
        if (v) found[t] = v;
      }
    }
  }
  const out = SWATCH_TOKENS.map(t => found[t]).filter(Boolean);
  // All three or nothing — a partial match hit a non-tokens.css :root rule.
  if (out.length === SWATCH_TOKENS.length) return out;
  // No block → Dynamic's row: show the live computed values.
  if (!value) return [];
  const now = getComputedStyle(document.documentElement);
  return SWATCH_TOKENS.map(t => now.getPropertyValue(t).trim()).filter(Boolean);
}
