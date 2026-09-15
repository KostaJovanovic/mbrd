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
  // The three that would be visible are untouched.
  assert.equal(quality.motion, true);
  assert.equal(quality.shadows, true);
  assert.equal(quality.anim, true);
});

test('Light gives something up on every axis', () => {
  fresh();
  setQualityLevel('light');
  for (const key of ['motion', 'shadows', 'blur', 'anim']) {
    assert.equal(quality[key], false, `${key} should be off at Light`);
  }
  assert.equal(quality.sharpness, 1024);
  assert.equal(quality.build, 4);
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
  assert.match(stills, /!quality\.motion \|\| vp\.zoom < stillZoom\(\)/, 'motion off freezes at any zoom');
});
