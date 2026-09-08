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
  // The same palette dressed for the end of the axis the reader is at. Section
  // 3b of tokens.css is a block per palette per end - `[data-whimsy="0"]
  // [data-palette="absinthe"]` and its Harsh twin - and without this the menu
  // showed the middle-tier literals at every level, so a board wearing pastels
  // was offered four chips it was not wearing and would not wear if picked.
  //
  // Read off the attribute rather than from the look model, which would be an
  // import and a ring - see the header. An absent attribute is level 1, where
  // there are no combo blocks and this walk finds nothing, which is the same
  // answer as not looking.
  const tier = document.documentElement.dataset.whimsy || '1';
  const dressed = value
    ? `:root[data-whimsy="${tier}"][data-palette="${value}"]`
    : `:root[data-whimsy="${tier}"]`;
  const found: Record<string, string> = {};
  for (const sheet of document.styleSheets) {
    let rules: CSSRuleList;
    try { rules = sheet.cssRules; } catch { continue; }
    for (const rule of rules) {
      if (!(rule instanceof CSSStyleRule)) continue;
      // Document order, and the combo blocks sit below the palette blocks they
      // dress, so a later answer overwrites an earlier one exactly the way the
      // cascade would - which is the property that makes two passes unnecessary.
      if (rule.selectorText !== want && rule.selectorText !== dressed) continue;
      for (const t of SWATCH_TOKENS) {
        const v = rule.style.getPropertyValue(t).trim();
        if (v) found[t] = v;
      }
    }
  }
  const out = SWATCH_TOKENS.map(t => found[t]).filter(Boolean);
  // All three or nothing. The bare `:root` selector matches several rules across
  // the sheets - base.css declares one, quality.css another - and only
  // tokens.css's carries pigments, so a partial answer means the walk found a
  // rule that merely matched and not the one that defines the palette.
  //
  // Harsh is the honest gap in this: its combo blocks set the pigments and not
  // the sheet, because the hand-written `[data-whimsy="2"]` block derives paper
  // and ink from `var(--accent)` by color-mix and the boldened accent propagates
  // through the whole ramp for free. So the paper chip there is the middle
  // tier's, which is the wrong white by a little. Resolving the paper chip means
  // evaluating a color-mix against a palette that is not on :root, which is the
  // engine's job and not this walk's - and the accent chip, the one that tells
  // two palettes apart, is exact.
  if (out.length === SWATCH_TOKENS.length) return out;
  // No block of its own: the live look. See the note above - this is Dynamic's
  // row, and the value it is showing is by definition whatever is on screen.
  if (!value) return [];
  const now = getComputedStyle(document.documentElement);
  return SWATCH_TOKENS.map(t => now.getPropertyValue(t).trim()).filter(Boolean);
}
