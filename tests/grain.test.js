// The zoom fade on the paper grain.
//
// The band exists because a grain that scales with the board runs out of room
// on the way out: by 30% the tile is 154px and a fleck is a third of a pixel,
// so the texture stops being texture and becomes a flat grey film over the
// whole sheet - the mean darkening with none of the detail that paid for it.
// See canvas/grain.js.
//
// Worth a test rather than a look, because the failure is quiet. Both ends of
// the band are correct-looking on their own: at 1.0 the grain is right, and at
// 0.05 it is gone either way. What breaks is the middle, and a board only
// passes through it while somebody is pinching.

import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { FADE_FULL, FADE_GONE, fadeFor } from '../web/assets/js/canvas/grain.ts';
import { appCss } from './helpers.js';

test('the band is a fade out, not a fade in', () => {
  assert.ok(FADE_GONE < FADE_FULL, 'gone must be the lower zoom of the two');
});

test('full strength at and above the top of the band', () => {
  assert.equal(fadeFor(FADE_FULL), 1);
  assert.equal(fadeFor(0.5), 1);
  assert.equal(fadeFor(1), 1);
  assert.equal(fadeFor(8), 1);
});

test('gone at and below the bottom of the band', () => {
  assert.equal(fadeFor(FADE_GONE), 0);
  assert.equal(fadeFor(0.2), 0);
  assert.equal(fadeFor(0.01), 0);
});

test('the middle of the band is half', () => {
  // Within a rounding, not exactly: the midpoint of two decimal fractions is
  // not representable, and grain.js writes the result at three places anyway.
  assert.ok(Math.abs(fadeFor((FADE_FULL + FADE_GONE) / 2) - 0.5) < 1e-9);
});

test('a quarter of the way up the band is a quarter of the strength', () => {
  const at = FADE_GONE + (FADE_FULL - FADE_GONE) * 0.25;
  assert.ok(Math.abs(fadeFor(at) - 0.25) < 1e-9, `got ${fadeFor(at)}`);
});

test('it never leaves 0..1, and never doubles back', () => {
  // Monotonic matters as much as the endpoints: a fade that rose anywhere on
  // the way out would read as the grain flickering back during a pinch.
  let prev = -1;
  for (let z = 0.01; z <= 2; z += 0.005) {
    const f = fadeFor(z);
    assert.ok(f >= 0 && f <= 1, `fadeFor(${z}) = ${f} is outside 0..1`);
    assert.ok(f >= prev, `fadeFor is not monotonic at ${z}`);
    prev = f;
  }
});

test('a nonsense zoom does not produce a nonsense opacity', () => {
  // paintGrain guards tile > 0 before it gets here, but the arithmetic should
  // not be the thing that decides whether that guard was enough.
  assert.equal(fadeFor(0), 0);
  assert.equal(fadeFor(-1), 0);
});

test('everything wearing the stock reads one fade, from the root', async () => {
  // The fade is a fact about the zoom, not about the layer. #grain is outside
  // #viewport on purpose (a blend inside a stacking context has nothing behind
  // it), and a fence's face is inside it - so the surface is the one element the
  // two cannot both inherit from, and the write goes to the root instead. Miss
  // this and a zoomed-out board keeps its texture in exactly the regions it has
  // given it up everywhere else.
  const src = await readFile(new URL('../web/assets/js/canvas/grain.ts', import.meta.url), 'utf8');
  assert.match(src, /document\.documentElement\.style\.setProperty\('--grain-fade', f\)/);
  // The screen-space pair stays on the layer wearing it; only the fade moved.
  assert.match(src, /surface\.style\.setProperty\('--grain-tile', size\)/);
  assert.match(src, /surface\.style\.setProperty\('--grain-pos', pos\)/);

  const css = appCss();
  // Both dials, on both surfaces. The board wears the tooth at 0.8 and a region
  // at full weight - a region's face is looked *at*, where the board is the space
  // behind everything on it - but the terms that make it one stock are the same
  // two variables, and it is those that this is about. --grain in particular:
  // leave it out of either and Harsh grows a texture it spent its whole argument
  // refusing.
  assert.match(css, /#grain[^}]*opacity:\s*calc\(0\.8 \* var\(--grain\) \* var\(--grain-fade, 1\)\);/s);
  const face = css.slice(css.indexOf('.fence-card::after'));
  assert.match(face.slice(0, face.indexOf('}')),
    /opacity:\s*calc\(var\(--grain\) \* var\(--grain-fade, 1\)\);/);
  // And at 1.4x the board's 512, in world units - coarser because a region is
  // read as a surface and the board as the space behind one.
  assert.match(css, /\.fence-card::after\s*\{[^}]*background-size:\s*717px 717px;/s);
});

test('cork is the softish end of the axis and nowhere else', async () => {
  // A fence is a cork board at whimsy 0 - the end where a board is a scrapbook -
  // and stays paper at the other two, where it is a marked-off part of the sheet
  // and a spec sheet has no cork on it. Unscope either half and every board in
  // the app grows a pinboard.
  const css = appCss();
  assert.match(css, /:root\[data-whimsy="0"\] \.item\[data-type="fence"\] \{ background: var\(--cork\); \}/);
  assert.match(css, /:root\[data-whimsy="0"\] \.fence-card::after\s*\{[^}]*cork-board\.webp/s);

  // And laid smaller than the paper it replaces - half the grain's 512, still
  // repeating. Paper's tooth should read as the surface having a texture; cork
  // has chips, and a chip is a thing of a certain size, so at the paper pitch the
  // tile reads as a print of cork rather than as cork.
  const cork = css.slice(css.indexOf(':root[data-whimsy="0"] .fence-card::after'));
  assert.match(cork.slice(0, cork.indexOf('}')), /background-size:\s*256px 256px;/);

  // The token is declared in that tier and only there, so the fallback the middle
  // and Harsh use stays --paper-2 by never having been overwritten. #fence-ghost
  // in menu.css is the only other thing that reads it - the preview of a region
  // being placed, which has to be visible against the board it is placed on.
  const tokens = await readFile(new URL('../web/assets/css/tokens.css', import.meta.url), 'utf8');
  assert.equal(tokens.match(/^\s*--cork:/gm)?.length, 1, 'declared once');
  const tier = tokens.slice(tokens.indexOf(':root[data-whimsy="0"] {'));
  assert.ok(tier.slice(0, tier.indexOf('\n}')).includes('--cork:'),
    '--cork escaped the softish block');
});

test('a cork region fades to cork rather than to grey', async () => {
  // The one thing the tile and the tint have to agree about. Zoomed out past the
  // band the chips stop resolving and the tile is taken off - so what is left is
  // the flat tint, and if that were the paper tone a region would change colour
  // on the way out and stop being a region at all. --cork is the mean of the tile
  // for exactly this reason, and the fade has to still be in the opacity for it
  // to ever be reached.
  const css = appCss();
  const cork = css.slice(css.indexOf(':root[data-whimsy="0"] .fence-card::after'));
  const rule = cork.slice(0, cork.indexOf('}'));
  // The fade has to be *in* the opacity, not be the whole of it. It was asserted
  // as the entire value until the tile's strength became a thing worth tuning -
  // `calc(var(--grain-fade, 1) * 0.5)` multiplies the fade rather than replacing
  // it, which is the shape any future tuning will take too. Pinning the literal
  // made the test fail on a change that kept every promise it was written to
  // keep, so it pins the reachability and not the number.
  assert.match(rule, /opacity:[^;]*var\(--grain-fade, 1\)/);
  // And --grain is deliberately not in it: that dial is how hard a tooth is
  // pressed into paper, and cork is a material rather than a tooth.
  assert.ok(!/var\(--grain\)/.test(rule), 'cork is not a grain');
});
