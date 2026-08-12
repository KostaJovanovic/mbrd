// The quality dial: what each stop asks for, and what a hand-set flag does to
// it. All of it is pure - the flags object and the two step tables - so none of
// this needs a browser.

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
  // The property this whole file exists to hold: installing the version that
  // added a quality dial must not change what anybody's board looks like. Each
  // of these is the constant it replaced - DISPLAY_MAX in canvas/display.js and
  // BUILD_BUDGET in canvas/items.js.
  assert.equal(quality.sharpness, 1280);
  assert.equal(quality.build, 12);
  assert.equal(quality.motion, true);
  assert.equal(quality.shadows, true);
  assert.equal(quality.blur, true);
  assert.equal(quality.anim, true);
});

test('the dial cannot hide a line somebody drew', () => {
  // There was a `threads` flag here, and Light turned it off. That was right
  // while the web was worked out from the board on every drag frame and wrong
  // the moment connections became a stored list drawn by hand: what it had
  // become was a quality setting that silently deleted work. The board's own
  // "Show connections" is the control, and it is not on this dial.
  fresh();
  setQualityLevel('light');
  assert.equal('threads' in quality, false,
    'the threads flag is retired, not merely defaulted on - see quality.js');
});

test('Balanced changes nothing you can see on a board standing still', () => {
  fresh();
  setQualityLevel('balanced');
  // The three that cost without showing: memory, the GPU's most expensive
  // effect, and how much work one frame may do.
  assert.equal(quality.sharpness, 1152);
  assert.equal(quality.blur, false);
  assert.equal(quality.build, 8);
  // And the three that would be visible are untouched.
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
  // Every reader imports it once - `if (quality.shadows)` inside a build loop -
  // so a reassigned binding would leave all of them holding the boot object.
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

  // Moving the dial has to clear it, or reaching for Full after pinning "no
  // shadows" would leave the stop looking broken.
  setQualityLevel('balanced');
  assert.equal(quality.shadows, true, 'Balanced has shadows of its own');
  assert.equal(qualityOverridden('shadows'), false);
});

test('Start over hands every flag back to the dial', () => {
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
  // localStorage is same-origin storage anyone with a console can edit, and two
  // of these numbers reach a canvas size and a loop bound.
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
  // The dial is a range input over these indices, so the order is the axis and
  // the top of it has to be the stop that gives nothing up.
  assert.equal(QUALITY_LEVELS[QUALITY_LEVELS.length - 1].id, 'full');
  for (const id of ['light', 'balanced', 'full']) {
    const p = qualityPreset(id);
    assert.ok(SHARPNESS_STEPS.some(s => s.px === p.sharpness), `${id} sharpness is a listed step`);
    assert.ok(BUILD_STEPS.some(s => s.n === p.build), `${id} build is a listed step`);
  }
});

test('no stop makes a picture look broken', () => {
  // This ladder started at 1280/1024/800, and 800 was a mistake: a card is a few
  // hundred world units wide, so the ceiling only looks generous at zoom 1, and
  // zooming in is what a board is for. Below ~1024 a photograph examined closely
  // is a visible upscale. Decode cost goes as the square of the edge, so the
  // floor buys back sharpness for about a third of Full's picture memory rather
  // than a sixth - a trade worth making, and one worth not drifting back.
  const px = SHARPNESS_STEPS.map(s => s.px);
  assert.deepEqual([...px].sort((a, b) => b - a), px, 'the steps run high to low');
  assert.ok(Math.min(...px) >= 1024, 'no stop may fall below 1024px on the long edge');
});

test('the pre-paint guard in index.html knows the same three stops', async () => {
  // The inline script writes data-quality before the module can, so the level
  // it will accept has to be the level quality.js will resolve - the same
  // arrangement the look guard has with ui/look.js.
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
  // The dial first, and the type list second. Which types get no twin is not
  // this test's business - it has grown from one to four and will grow again -
  // so it is matched loosely, and what is pinned is that `quality.shadows` is
  // still the thing standing in front of buildShadow().
  assert.match(items, /quality\.shadows && [^)]*NO_TWIN/, 'no twin is built when shadows are off');
  assert.match(display, /displayMax\(\) \/ Math\.max/, 'the display copy takes the dial’s long edge');
  // canvas/web.js is deliberately *not* in this list any more. It is the one
  // site that stopped reading the dial: what it draws is a stored list rather
  // than work it has to decide whether to afford. Asserted the other way round
  // instead, so the flag cannot creep back in.
  assert.doesNotMatch(web, /from '\.\.\/quality\.ts'/,
    'connections are drawn whatever the dial says - see canvas/web.ts');
  assert.match(stills, /!quality\.motion \|\| vp\.zoom < stillZoom\(\)/, 'motion off freezes at any zoom');
});
