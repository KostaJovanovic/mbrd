// The zoom fade on the paper grain.
//
// The band exists because grain that scales with the board runs out of
// room zooming out: by 30% the tile is 154px and a fleck is a third of a
// pixel, so the texture becomes a flat grey film. See canvas/grain.ts.
//
// Worth a test since the failure is quiet - both ends of the band look
// correct alone, and only the middle breaks, reached only while pinching.

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
  // Within a rounding, not exactly - the midpoint of two decimal fractions
  // isn't representable.
  assert.ok(Math.abs(fadeFor((FADE_FULL + FADE_GONE) / 2) - 0.5) < 1e-9);
});

test('a quarter of the way up the band is a quarter of the strength', () => {
  const at = FADE_GONE + (FADE_FULL - FADE_GONE) * 0.25;
  assert.ok(Math.abs(fadeFor(at) - 0.25) < 1e-9, `got ${fadeFor(at)}`);
});

test('it never leaves 0..1, and never doubles back', () => {
  // Monotonic matters as much as the endpoints - a fade rising anywhere
  // reads as the grain flickering back during a pinch.
  let prev = -1;
  for (let z = 0.01; z <= 2; z += 0.005) {
    const f = fadeFor(z);
    assert.ok(f >= 0 && f <= 1, `fadeFor(${z}) = ${f} is outside 0..1`);
    assert.ok(f >= prev, `fadeFor is not monotonic at ${z}`);
    prev = f;
  }
});

test('a nonsense zoom does not produce a nonsense opacity', () => {
  // paintGrain guards tile > 0 before this, but the arithmetic shouldn't be
  // what decides whether that guard was enough.
  assert.equal(fadeFor(0), 0);
  assert.equal(fadeFor(-1), 0);
});

test('everything wearing the stock reads one fade, from the root', async () => {
  // The fade is a fact about the zoom, not the layer. #grain sits outside
  // #viewport on purpose (a blend inside a stacking context has nothing
  // behind it), and a fence's face is inside it, so the write goes to the
  // root - miss this and a zoomed-out board keeps texture only in regions.
  const src = await readFile(new URL('../web/assets/js/canvas/grain.ts', import.meta.url), 'utf8');
  assert.match(src, /document\.documentElement\.style\.setProperty\('--grain-fade', f\)/);
  // The screen-space pair stays on the layer wearing it; only the fade moved
  assert.match(src, /surface\.style\.setProperty\('--grain-tile', size\)/);
  assert.match(src, /surface\.style\.setProperty\('--grain-pos', pos\)/);

  const css = appCss();
  // Both dials, on both surfaces. The board wears the tooth at 0.8, a
  // region at full weight - a region's face is looked at, the board is the
  // space behind everything - but both share the same two variables.
  // --grain especially: omit it from either and Harsh grows a texture it
  // was meant to refuse.
  assert.match(css, /#grain[^}]*opacity:\s*calc\(0\.8 \* var\(--grain\) \* var\(--grain-fade, 1\)\);/s);
  const face = css.slice(css.indexOf('.fence-card::after'));
  assert.match(face.slice(0, face.indexOf('}')),
    /opacity:\s*calc\(var\(--grain\) \* var\(--grain-fade, 1\)\);/);
  // 1.4x the board's 512, in world units - coarser since a region reads as
  // a surface and the board as the space behind one.
  assert.match(css, /\.fence-card::after\s*\{[^}]*background-size:\s*717px 717px;/s);
});

test('cork is the softish end of the axis and nowhere else', async () => {
  // A fence is a cork board at whimsy 0 (a scrapbook) and stays paper at
  // the other two, where a spec sheet has no cork on it. Unscope either
  // half and every board grows a pinboard.
  const css = appCss();
  assert.match(css, /:root\[data-whimsy="0"\] \.item\[data-type="fence"\] \{ background: var\(--cork\); \}/);
  assert.match(css, /:root\[data-whimsy="0"\] \.fence-card::after\s*\{[^}]*cork-board\.webp/s);

  // Laid smaller than the paper it replaces - half the grain's 512, still
  // repeating. Cork has chips of a certain size, so at the paper pitch the
  // tile reads as a print of cork rather than as cork.
  const cork = css.slice(css.indexOf(':root[data-whimsy="0"] .fence-card::after'));
  assert.match(cork.slice(0, cork.indexOf('}')), /background-size:\s*256px 256px;/);

  // Declared in that tier and only there, so the middle/Harsh fallback
  // stays --paper-2 by never being overwritten.
  const tokens = await readFile(new URL('../web/assets/css/tokens.css', import.meta.url), 'utf8');
  assert.equal(tokens.match(/^\s*--cork:/gm)?.length, 1, 'declared once');
  const tier = tokens.slice(tokens.indexOf(':root[data-whimsy="0"] {'));
  assert.ok(tier.slice(0, tier.indexOf('\n}')).includes('--cork:'),
    '--cork escaped the softish block');
});

test('a cork region fades to cork rather than to grey', async () => {
  // The tile and tint have to agree: past the band the chips stop
  // resolving and the tile comes off, leaving the flat tint - if that were
  // the paper tone, a region would change colour and stop being a region.
  // --cork is the tile's mean for this reason, so the fade must stay in
  // the opacity to ever be reached.
  const css = appCss();
  const cork = css.slice(css.indexOf(':root[data-whimsy="0"] .fence-card::after'));
  const rule = cork.slice(0, cork.indexOf('}'));
  // The fade must be in the opacity, not the whole of it. Used to be
  // asserted as the entire value, which failed on a tuning change that
  // kept every promise this test was written for - so it pins reachability, not
  // the number.
  assert.match(rule, /opacity:[^;]*var\(--grain-fade, 1\)/);
  // --grain is deliberately absent: that dial is how hard a tooth presses
  // into paper, and cork is a material rather than a tooth.
  assert.ok(!/var\(--grain\)/.test(rule), 'cork is not a grain');
});
