// The quality dial: what each stop asks for, and what a hand-set flag does to
// it. Pure throughout - the flags object and the two step tables - so no
// browser needed.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

import {
  quality, initQuality, setQualityLevel, setQualityOverride,
  clearQualityOverrides, qualityLevel, qualityPreset, qualityOverridden,
  onQuality, QUALITY_LEVELS, SHARPNESS_STEPS, BUILD_STEPS,
} from '../web/assets/js/quality.ts';

/** Back to a known state; every test starts from an unset preference. */
const fresh = () => initQuality(null);

test('an unset preference is Full, and Full is what the app shipped with', () => {
  fresh();
  assert.equal(qualityLevel(), 'full');
  // Installing the version that added the dial must not change what
  // anybody's board looks like. Each value is the constant it replaced -
  // DISPLAY_MAX (canvas/display.ts), BUILD_BUDGET (canvas/items.ts).
  assert.equal(quality.sharpness, 1280);
  assert.equal(quality.build, 12);
  assert.equal(quality.motion, true);
  assert.equal(quality.shadows, true);
  assert.equal(quality.blur, true);
  assert.equal(quality.anim, true);
  // Both added after Light was reported as no faster than Full on Android, and
  // both on at Full for the same reason as the four above: installing the
  // version that added them must not change what anybody's board looks like.
  assert.equal(quality.grain, true);
  assert.equal(quality.hires, true);
});

test('the dial cannot hide a line somebody drew', () => {
  // A `threads` flag was here and Light turned it off - right while the
  // web was worked out on every drag frame, wrong once connections became
  // a stored list: a quality setting silently deleting work. The board's
  // own "Show connections" is the control, not this dial.
  fresh();
  setQualityLevel('light');
  assert.equal('threads' in quality, false,
    'the threads flag is retired, not merely defaulted on - see quality.js');
});

test('Balanced changes nothing you can see on a board standing still', () => {
  fresh();
  setQualityLevel('balanced');
  // The three that cost without showing: memory, the GPU's most
  // expensive effect, and how much work one frame may do.
  assert.equal(quality.sharpness, 1152);
  assert.equal(quality.blur, false);
  assert.equal(quality.build, 8);
  // The ones that would be visible are untouched. The grain and the zoomed-in
  // original are both in this list on purpose: a board standing still pays
  // nothing for either - the grain layer is composited once and the swap only
  // happens to a card somebody has zoomed right into - so the stop that is
  // defined as costing nothing visible may not take them.
  assert.equal(quality.motion, true);
  assert.equal(quality.shadows, true);
  assert.equal(quality.anim, true);
  assert.equal(quality.grain, true);
  assert.equal(quality.hires, true);
});

test('Light gives something up on every axis', () => {
  fresh();
  setQualityLevel('light');
  for (const key of ['motion', 'shadows', 'blur', 'anim', 'grain', 'hires']) {
    assert.equal(quality[key], false, `${key} should be off at Light`);
  }
  assert.equal(quality.sharpness, 1024);
  assert.equal(quality.build, 4);
});

test('Light turns off the two that a moving board pays for every frame', async () => {
  // The report this pair was added for: "on Android, light quality, everything
  // still lags, and as I pan around or even just zoom a little it flashes a
  // lot". Both costs were real and neither was reachable from the dial, so
  // Light was doing nothing about the only two things that mattered. Pinned as
  // wiring, not as numbers, because the numbers are the presets' to state.
  const read = path => readFile(new URL(`../web/assets/${path}`, import.meta.url), 'utf8');
  const [grain, hires, css] = await Promise.all([
    read('js/canvas/grain.ts'), read('js/canvas/hires.ts'), read('css/quality.css'),
  ]);
  // The layer is taken off the page, and the per-frame writes onto it stop.
  assert.match(css, /data-q-grain="off"\] #grain \{ display: none/,
    'the grain layer is still painted at Light');
  assert.match(grain, /if \(!quality\.grain\) return;/,
    'paintGrain still writes to a layer that is not being drawn');
  // ...and the 48 MB decode is simply not asked for.
  assert.match(hires, /const allow = quality\.hires;/,
    'the original swap no longer reads the dial');
  assert.match(hires, /const wantOriginal = allow &&/,
    'the flag is read but not applied');
  // The sweep was walking every mounted photograph on every *pan* frame, to
  // answer a question only the zoom can change.
  assert.match(hires, /if \(zoom === lastZoom && count === lastCount\) return;/,
    'the sweep runs on frames that cannot have changed its answer');
});

test('the flags object is mutated in place, never replaced', () => {
  fresh();
  // Every reader imports it once - `if (quality.shadows)` inside a build
  // loop - so a reassigned binding would leave them all holding the boot object.
  const held = quality;
  setQualityLevel('light');
  assert.equal(held.shadows, false);
  setQualityLevel('full');
  assert.equal(held.shadows, true);
});

test('a hand-set flag outranks the dial, and moving the dial drops it', () => {
  fresh();
  setQualityLevel('light');
  setQualityOverride('shadows', true);
  assert.equal(quality.shadows, true, 'the override stands');
  assert.equal(quality.motion, false, 'and nothing else moved with it');
  assert.equal(qualityOverridden('shadows'), true);

  // Moving the dial must clear it, or reaching Full after pinning "no
  // shadows" would leave the stop looking broken.
  setQualityLevel('balanced');
  assert.equal(quality.shadows, true, 'Balanced has shadows of its own');
  assert.equal(qualityOverridden('shadows'), false);
});

test('Reset hands every flag back to the dial', () => {
  fresh();
  setQualityLevel('full');
  setQualityOverride('blur', false);
  setQualityOverride('build', 4);
  assert.equal(quality.blur, false);
  clearQualityOverrides();
  assert.deepEqual(
    { blur: quality.blur, build: quality.build },
    { blur: qualityPreset('full').blur, build: qualityPreset('full').build },
  );
});

test('a poisoned or stale preference falls back rather than reaching the page', () => {
  // localStorage is same-origin storage anyone with a console can edit,
  // and two of these numbers reach a canvas size and a loop bound.
  initQuality({ level: 'turbo', over: { build: '999', sharpness: 40000, nope: 1 } });
  assert.equal(qualityLevel(), 'full');
  assert.equal(quality.build, 12, 'a string where a number belongs is refused');
  assert.equal(quality.sharpness, 1280, 'an unlisted size is refused');
  assert.equal(qualityOverridden('nope'), false, 'an unknown key is not stored');

  initQuality({ level: 'light', over: { build: 8 } });
  assert.equal(qualityLevel(), 'light');
  assert.equal(quality.build, 8, 'a listed value from a known key is kept');
});

test('every change is announced once', () => {
  fresh();
  let calls = 0;
  const off = onQuality(() => calls++);
  setQualityLevel('light');
  assert.equal(calls, 1);
  setQualityLevel('light');
  assert.equal(calls, 1, 'the same stop again is not a change');
  setQualityOverride('blur', true);
  assert.equal(calls, 2);
  off();
  setQualityLevel('full');
  assert.equal(calls, 2, 'unsubscribed');
});

test('the panel’s stops and the step tables agree with the presets', () => {
  assert.deepEqual(QUALITY_LEVELS.map(l => l.id), ['light', 'balanced', 'full']);
  // The dial is a range input over these indices, so the order is the
  // axis and the top must be the stop that gives nothing up.
  assert.equal(QUALITY_LEVELS[QUALITY_LEVELS.length - 1].id, 'full');
  for (const id of ['light', 'balanced', 'full']) {
    const p = qualityPreset(id);
    assert.ok(SHARPNESS_STEPS.some(s => s.px === p.sharpness), `${id} sharpness is a listed step`);
    assert.ok(BUILD_STEPS.some(s => s.n === p.build), `${id} build is a listed step`);
  }
});

test('no stop makes a picture look broken', () => {
  // The ladder started at 1280/1024/800 and 800 was a mistake: the
  // ceiling only looks generous at zoom 1, and zooming in is what a
  // board is for - below ~1024 a close-up photo visibly upscales. Decode
  // cost goes as the square of the edge, so the floor costs a third of
  // Full's picture memory rather than a sixth, worth it and worth not
  // drifting back.
  const px = SHARPNESS_STEPS.map(s => s.px);
  assert.deepEqual([...px].sort((a, b) => b - a), px, 'the steps run high to low');
  assert.ok(Math.min(...px) >= 1024, 'no stop may fall below 1024px on the long edge');
});

test('the pre-paint guard in index.html knows the same three stops', async () => {
  // The inline script writes data-quality before the module can, so the
  // level it accepts must be the level quality.ts resolves - same
  // arrangement as the look guard with ui/look.ts.
  const html = await readFile(new URL('../web/index.html', import.meta.url), 'utf8');
  const inline = html.match(/\/\^\(([a-z|]+)\)\$\/\.test\(q\.level\)/);
  assert.ok(inline, 'the guard no longer tests the saved quality level');
  assert.deepEqual(inline[1].split('|').sort(), QUALITY_LEVELS.map(l => l.id).sort());
});

test('the wired sites read the dial rather than a constant', async () => {
  const read = name => readFile(new URL(`../web/assets/js/${name}`, import.meta.url), 'utf8');
  const [items, display, web, stills] = await Promise.all([
    read('canvas/items.ts'), read('canvas/display.ts'),
    read('canvas/web.ts'), read('canvas/stills.ts'),
  ]);
  assert.match(items, /built >= buildBudget\(\)/, 'the build budget is the dial’s');
  // *Which* items get no twin isn't this test's business - it grew from
  // one type to four, then past types when a cut-out image joined. What's
  // pinned is that `quality.shadows` still stands in front of
  // buildShadow(); the list moved behind noTwin(), a predicate over an
  // item rather than a set of type names.
  assert.match(items, /quality\.shadows && !noTwin\(/, 'no twin is built when shadows are off');
  assert.match(display, /displayMax\(\) \/ Math\.max/, 'the display copy takes the dial’s long edge');
  // canvas/web.ts is *not* in this list any more, the one site that
  // stopped reading the dial since what it draws is a stored list rather
  // than work to decide whether to afford. Asserted in reverse so the
  // flag can't creep back in.
  assert.doesNotMatch(web, /from '\.\.\/quality\.ts'/,
    'connections are drawn whatever the dial says - see canvas/web.ts');
  assert.match(stills, /const held = !quality\.motion;/, 'motion off freezes at any zoom');
});

test('Animated GIFs off holds GIFs still and leaves photographs alone', async () => {
  // Motion off used to set is-stilled, the zoom rung's class - which is also
  // what swaps every photograph to its hundred-pixel thumbnail. At Light that
  // meant every photo drawn from its thumbnail at every zoom, and every card
  // blinking as the swap landed on mount. The two reasons now have two classes.
  const read = path => readFile(new URL(`../web/assets/${path}`, import.meta.url), 'utf8');
  const [stills, css] = await Promise.all([read('js/canvas/stills.ts'), read('css/items.css')]);
  assert.match(stills, /classList\.toggle\('is-stilled', far\)/, 'is-stilled is the rung and only the rung');
  assert.match(stills, /classList\.toggle\('is-held', held\)/, 'motion off has its own class');
  const held = css.match(/#world\.is-held[^{]*\{/g) || [];
  assert.ok(held.length > 0, 'nothing in items.css answers is-held');
  for (const rule of held) assert.match(rule, /img\[data-gif\]/, `is-held reaches past GIFs: ${rule}`);
});

test('no stop reaches for the original sooner than Full', async () => {
  // Measured against its own copy, Light - the smallest copy - swapped in the
  // full original at the smallest card size, the opposite of what it is for.
  const { swapEdge } = await import('../web/assets/js/canvas/hires.ts');
  const { copyEdge } = await import('../web/assets/js/canvas/display.ts');
  setQualityLevel('full');
  const full = swapEdge();
  for (const { id } of QUALITY_LEVELS) {
    setQualityLevel(id);
    assert.equal(swapEdge(), full, `${id} swaps at a different size from Full`);
    assert.ok(swapEdge() >= copyEdge(), `${id} swaps before its own copy upscales`);
  }
});

test('Animations off cuts loops to one lap, not only to a short one', async () => {
  // Duration alone turns an `infinite` animation into a strobe: a hundred
  // thousand laps a second, sampled at a random point every frame.
  const read = name => readFile(new URL(`../web/assets/css/${name}`, import.meta.url), 'utf8');
  const [quality, status] = await Promise.all([read('quality.css'), read('status.css')]);
  const off = quality.match(/:root\[data-q-anim="off"\] \* \{[^}]*\}/);
  assert.ok(off, 'the Animations-off block moved');
  assert.match(off[0], /animation-iteration-count: 1 !important/, 'Animations off lets loops strobe');
  assert.match(status, /prefers-reduced-motion[\s\S]*animation-iteration-count: 1 !important/,
    'reduced motion lets loops strobe');
});
