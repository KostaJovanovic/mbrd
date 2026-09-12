// Two things the stylesheets must be true about themselves, both learned
// from a rule that never parsed. A stray `*/` closes a comment early; the
// prose after it reads as a selector, and CSS's error recovery swallows
// everything up to the *next* brace - the rule the comment was explaining.
// Nothing warns; the feature just quietly stops working. That is exactly
// how a fence lost its name at far zoom, so the general guard is here
// beside the specific case it cost.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { WEB, APP_CSS_ORDER, appCss } from './helpers.js';

// patch.css is not in APP_CSS_ORDER and never will be - it dresses
// patch.html alone, so appCss() must not carry it. Named here anyway
// because it carries as much long prose as any sheet in the app's cascade.
const SHEETS = [...APP_CSS_ORDER, 'tokens.css', 'fonts.css', 'patch.css'];

test('no stylesheet closes a comment it did not open', () => {
  // Walked rather than regexed: the question is about *nesting*, and a
  // /* ... */ pattern cannot tell a second closer from a first. CSS has no
  // nested comments, so a `*/` outside one is always a mistake.
  for (const name of SHEETS) {
    const src = readFileSync(join(WEB, 'assets', 'css', name), 'utf8');
    let open = false;
    for (let i = 0; i < src.length - 1; i++) {
      const pair = src.slice(i, i + 2);
      if (!open && pair === '/*') { open = true; i++; continue; }
      if (open && pair === '*/') { open = false; i++; continue; }
      // A `*/` outside a comment means an earlier one closed too soon, and
      // the prose between the two closers is now part of the next selector.
      assert.ok(!(!open && pair === '*/'),
        `${name}: stray */ at offset ${i} - the comment above it closed early, and the next rule is being read as part of a selector`);
    }
    assert.equal(open, false, `${name}: a comment is left open at the end of the file`);
  }
});

test('a region keeps its name at every zoom, plate and label together', () => {
  // The board drops captions at far zoom (a hundred unreadable text nodes),
  // but a fence is the opposite case: few of them, named at their own size,
  // and the name is exactly what a large board's far-zoom view is for. The
  // bar is also a fence's only hit area since the face refuses the pointer.
  // Both rules are needed - the label lives inside the bar, so unhiding a
  // hidden parent's child alone buys nothing. The shipped bug had only the
  // label half, inside a comment already closed.
  const css = appCss();
  assert.match(css, /#world\.zoom-far \.item\[data-type="fence"\] \.item-bar \{ display: flex; \}/);
  assert.match(css, /#world\.zoom-far \.item\[data-type="fence"\] \.item-label:not\(\[hidden\]\) \{ display: block; \}/);

  // Each sits *below* the rule it exempts, which is why it wins once
  // specificity ties (:not([hidden]) makes the label pair tie) and document
  // order settles it. Both halves are checked present first: `indexOf(a) <
  // indexOf(b)` is true for free when `a` is absent, so deleting the
  // exempted rule would otherwise pass this by accident.
  const before = (a, b, why) => {
    const i = css.indexOf(a), j = css.indexOf(b);
    assert.notEqual(i, -1, `the rule being exempted is gone: ${a}`);
    assert.notEqual(j, -1, `the exemption is gone: ${b}`);
    assert.ok(i < j, why);
  };
  before('#world.zoom-far .item-bar { display: none; }',
    '#world.zoom-far .item[data-type="fence"] .item-bar',
    'the exemption is above the rule it exempts and loses the tie');
  before('#world.zoom-far .item:not(.is-editing) .item-label',
    '#world.zoom-far .item[data-type="fence"] .item-label',
    'the label exemption is above the rule it exempts');
});
