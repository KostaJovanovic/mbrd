// What each palette looks like, read out of the stylesheet that defines it.
//
// One function, and it exists so that the Palette row can show its options
// rather than only name them. Every palette is a `:root[data-palette="x"]` block
// in tokens.css declaring the same thirteen literal tokens, so the block *is*
// the definition; a table of colours in TypeScript would be a second definition,
// and the two would disagree the first time somebody tuned a pigment. That is
// not hypothetical - tools/preset-oklch.mjs already parses these same blocks at
// build time rather than keeping its own copy, for exactly this reason.
//
// ── Why this is its own module ──
//
// It began in ui/appearance-controls.ts, which is where the rest of the Palette
// row lives, and that made a cycle: ui/settings-schema.ts needs the function to
// declare the row, appearance-controls needs ui/panel.ts to repaint the row, and
// panel needs settings-schema to know what a row is. Three modules, one ring,
// and tests/imports.test.js says no. Here it imports nothing at all, so the ring
// is a line.
//
// Nothing here touches `document` at import time - the walk happens when a menu
// is opened - which is the rule tests/imports.test.js holds every module to.

/**
 * The three tokens shown beside a palette's name: the ground, the one loud
 * colour, and the writing.
 *
 * Three because that is what fits at the end of a row and because those three
 * are what tells two palettes apart at a glance. Any of the thirteen would
 * work; --paper-2 and --rule would not tell you anything.
 */
const SWATCH_TOKENS = ['--paper', '--accent', '--ink'];

/**
 * The colours to draw for one palette value, or an empty list.
 *
 * `value` is the palette name as the schema writes it: `''` for Papyrus, which
 * is the bare `:root` block, and a name for each of the others. A value with no
 * block of its own falls back to whatever is on `:root` right now - which is not
 * a fudge but the correct answer for the one option in that position: Dynamic is
 * *defined* as the pigments the board's own pictures gave, so the honest chips
 * are the live ones.
 *
 * Papyrus must come from the walk rather than from getComputedStyle, and that is
 * the subtle half of this. With Dynamic on, ui/appearance.ts writes the derived
 * pigments as inline custom properties on :root, and inline wins - so asking the
 * computed style for --accent while Dynamic is on would answer with somebody's
 * photographs and label them Papyrus.
 *
 * An empty list is a legal answer and draws a row with a label and no chips. A
 * stylesheet from another origin throws on `.cssRules`, and although nothing
 * here is cross-origin today, a row that loses its colours is a working row
 * where an exception is a panel that does not build. Same bargain stickerPaths()
 * makes in ui/snapshot.ts: a failure is silence rather than an error.
 */
export function paletteSwatches(value: string): string[] {
  const want = value ? `:root[data-palette="${value}"]` : ':root';
  for (const sheet of document.styleSheets) {
    let rules: CSSRuleList;
    try { rules = sheet.cssRules; } catch { continue; }
    for (const rule of rules) {
      if (!(rule instanceof CSSStyleRule) || rule.selectorText !== want) continue;
      const out = SWATCH_TOKENS
        .map(t => rule.style.getPropertyValue(t).trim())
        .filter(Boolean);
      // Keep looking unless the rule answered with all three. The bare `:root`
      // selector matches several rules across the sheets - base.css declares one,
      // quality.css another - and only tokens.css's carries pigments, so taking
      // the first rule that merely *matches* would hand back nothing for Papyrus.
      if (out.length === SWATCH_TOKENS.length) return out;
    }
  }
  // No block of its own: the live look. See the note above - this is Dynamic's
  // row, and the value it is showing is by definition whatever is on screen.
  if (!value) return [];
  const now = getComputedStyle(document.documentElement);
  return SWATCH_TOKENS.map(t => now.getPropertyValue(t).trim()).filter(Boolean);
}
