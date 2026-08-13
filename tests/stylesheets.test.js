// Two things the stylesheets have to be true about themselves, both learned the
// same way: a rule that never parsed.
//
// This app's CSS carries its reasoning in long comments, which is a convention
// worth keeping and has one failure mode that nothing else here would catch. A
// stray `*/` closes a comment early; the prose after it is then read as a
// selector, and CSS's error recovery swallows everything up to the *next* brace -
// which is to say the rule the comment was written to explain. Nothing warns:
// not the browser, not a lint pass over JS, not a test about behaviour. The rule
// is simply not there, and the symptom shows up as a feature quietly not working.
//
// That is exactly how a fence lost its name at far zoom. So the general guard is
// here, and the case it cost is here beside it.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { WEB, APP_CSS_ORDER, appCss } from './helpers.js';

// patch.css is not in APP_CSS_ORDER and never will be - it dresses patch.html
// and is loaded by nothing else, so it is not part of the app's cascade and
// appCss() must not carry it. It is named here anyway, because the failure this
// file exists to catch is a property of any sheet that carries long prose, and
// that one carries as much as any of them.
const SHEETS = [...APP_CSS_ORDER, 'tokens.css', 'fonts.css', 'patch.css'];

test('no stylesheet closes a comment it did not open', () => {
  // Walked rather than regexed, because the question is about *nesting* and a
  // pattern that matches /* ... */ pairs cannot tell a second closer from a
  // first. CSS has no nested comments, so the rule is exactly: inside a comment
  // the only token that matters is `*/`, and outside one a `*/` is a mistake.
  for (const name of SHEETS) {
    const src = readFileSync(join(WEB, 'assets', 'css', name), 'utf8');
    let open = false;
    for (let i = 0; i < src.length - 1; i++) {
      const pair = src.slice(i, i + 2);
      if (!open && pair === '/*') { open = true; i++; continue; }
      if (open && pair === '*/') { open = false; i++; continue; }
      // A `*/` outside a comment is the whole bug: it means an earlier one was
      // closed too soon, and the prose between the two closers is now part of
      // whatever selector follows it.
      assert.ok(!(!open && pair === '*/'),
        `${name}: stray */ at offset ${i} - the comment above it closed early, and the next rule is being read as part of a selector`);
    }
    assert.equal(open, false, `${name}: a comment is left open at the end of the file`);
  }
});

test('a region keeps its name at every zoom, plate and label together', () => {
  // The board drops its captions at far zoom because a hundred of them at three
  // pixels are a hundred text nodes nobody can read. A fence is the opposite case
  // on every count - there are few, the name is set at the region's own size, and
  // finding your way around a large board is the moment its areas' names are what
  // you came for. It is also a fence's only hit area, since the face refuses the
  // pointer, so a hidden plate is a region that cannot be grabbed at all.
  //
  // Two rules, and both are needed: the label lives inside the bar, so unhiding
  // the child of a hidden parent buys nothing. Asserted as a pair for that reason
  // - the version of this that shipped had only the label half, inside a comment
  // that had already been closed.
  const css = appCss();
  assert.match(css, /#world\.zoom-far \.item\[data-type="fence"\] \.item-bar \{ display: flex; \}/);
  assert.match(css, /#world\.zoom-far \.item\[data-type="fence"\] \.item-label:not\(\[hidden\]\) \{ display: block; \}/);

  // And each sits *below* the rule it exempts, which is the whole of why it wins:
  // the two selectors in each pair do not weigh the same, but the label pair does
  // once :not([hidden]) is counted, and document order is what settles a tie.
  assert.ok(css.indexOf('#world.zoom-far .item-bar { display: none; }')
    < css.indexOf('#world.zoom-far .item[data-type="fence"] .item-bar'),
    'the exemption is above the rule it exempts and loses the tie');
  assert.ok(css.indexOf('#world.zoom-far .item:not(.is-editing) .item-label')
    < css.indexOf('#world.zoom-far .item[data-type="fence"] .item-label'),
    'the label exemption is above the rule it exempts');
});
