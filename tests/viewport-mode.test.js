import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

import {
  Viewport, mobileZoom, mobileHeaderHeight,
} from '../web/assets/js/canvas/viewport.js';
import { axesVisible } from '../web/assets/js/canvas/grid.js';
import { webVisible } from '../web/assets/js/canvas/web.js';
import {
  createMobileSliderFocus,
  mobileLayoutDetected,
} from '../web/assets/js/ui/sidebar.js';

const saved = {};

before(() => {
  for (const key of ['ResizeObserver', 'addEventListener', 'requestAnimationFrame', 'cancelAnimationFrame']) {
    saved[key] = globalThis[key];
  }
  globalThis.ResizeObserver = class {
    observe() {}
  };
  globalThis.addEventListener = () => {};
  globalThis.requestAnimationFrame = () => 1;
  globalThis.cancelAnimationFrame = () => {};
});

after(() => {
  for (const [key, value] of Object.entries(saved)) {
    if (value === undefined) delete globalThis[key];
    else globalThis[key] = value;
  }
});

/** Where the board's top edge comes to rest: the pad plus the masthead. */
const topEdgeY = (viewWidth = 360, boardWidth = 384) =>
  32 + mobileHeaderHeight(boardWidth * mobileZoom(viewWidth, boardWidth));
const assertNear = (actual, expected, message) =>
  assert.ok(Math.abs(actual - expected) < 1e-9,
    message || `${actual} should be approximately ${expected}`);

const style = () => ({ setProperty() {} });
const element = (width = 360, height = 720) => ({
  style: style(),
  classList: { add() {}, remove() {}, toggle() {} },
  getBoundingClientRect: () => ({ left: 0, top: 0, width, height }),
});

test('Mobile zoom fits the selected board width and never enlarges it', () => {
  assert.equal(mobileZoom(360, 384), 328 / 384);
  assert.equal(mobileZoom(360, 512), 328 / 512);
  assert.equal(mobileZoom(1000, 384), 1);
});

test('the Mobile board follows the responsive layout on first use', () => {
  assert.equal(mobileLayoutDetected(query => ({
    matches: query === '(max-width: 700px)',
  })), true);
  assert.equal(mobileLayoutDetected(() => ({ matches: false })), false);
});

test('Mobile sidebar isolates a range only for the active pointer gesture', () => {
  const classes = () => {
    const values = new Set();
    return {
      add: value => values.add(value),
      remove: value => values.delete(value),
      contains: value => values.has(value),
    };
  };
  const root = { classList: classes() };
  const range = {
    classList: classes(),
    matches: selector => selector === 'input[type="range"]',
  };
  const button = { matches: () => false };
  const focus = createMobileSliderFocus(root, {
    isMobile: () => true,
  });

  assert.equal(focus.begin(button, 4), false, 'non-range controls are untouched');
  assert.equal(focus.begin(range, 4), true);
  assert.equal(root.classList.contains('is-slider-focus'), true);
  assert.equal(range.classList.contains('is-slider-active'), true);
  assert.equal(focus.end(9), false, 'another pointer cannot finish the gesture');
  assert.equal(focus.end(4), true);
  assert.equal(root.classList.contains('is-slider-focus'), false,
    'release restores the sidebar without a hold');
  assert.equal(range.classList.contains('is-slider-active'), false);

  assert.equal(focus.begin(range, 5), true);
  focus.clear();
  assert.equal(root.classList.contains('is-slider-focus'), false);
  assert.equal(range.classList.contains('is-slider-active'), false);
});

test('sidebar slider focus is disabled above the Mobile breakpoint', () => {
  const root = { classList: { add() {}, remove() {} } };
  const range = {
    classList: { add() {}, remove() {} },
    matches: () => true,
  };
  const focus = createMobileSliderFocus(root, { isMobile: () => false });
  assert.equal(focus.begin(range, 1), false);
});

test('Mobile masthead leaves descender room and its finite board follows the style radius', async () => {
  const [css, grid] = await Promise.all([
    readFile(new URL('../web/assets/css/app.css', import.meta.url), 'utf8'),
    readFile(new URL('../web/assets/js/canvas/grid.js', import.meta.url), 'utf8'),
  ]);
  const rule = id => css.match(new RegExp(`#${id}\\s*\\{([^}]+)\\}`))?.[1] || '';

  assert.match(rule('mobile-board-title'), /line-height:\s*normal;/);
  // More below than above: overflow:hidden clips at the padding edge, and the
  // descenders of g/j/y hang past the last line box - further when the Line
  // height dial tightens it.
  assert.match(rule('mobile-board-title'), /padding-block:\s*0\.2em\s+0\.45em;/);
  assert.match(rule('mobile-board-title'), /overflow-wrap:\s*anywhere;/);
  assert.match(rule('mobile-board-frame'), /top:\s*var\(--mobile-board-top,\s*0\);/);
  assert.match(rule('mobile-board-frame'), /height:\s*max\(0px,\s*calc\(/);
  assert.match(rule('mobile-board-frame'), /border-radius:\s*var\(--radius\);/);
  assert.match(rule('mobile-board-frame'),
    /background:\s*color-mix\(in srgb,\s*var\(--accent\)\s*var\(--mobile-board-accent\),\s*#fff\);/);
  assert.match(rule('mobile-board-frame'),
    /box-shadow:[^;]*color-mix\(in srgb,\s*var\(--ink\)\s*6%,\s*transparent\);/);
  assert.match(css,
    /data-whimsy="0"[^{}]*#mobile-board-frame\s*\{\s*--mobile-board-accent:\s*7%;\s*\}/);
  assert.match(css,
    /data-whimsy="2"[^{}]*#mobile-board-frame\s*\{\s*--mobile-board-accent:\s*4\.5%;\s*\}/);
  assert.match(grid, /topRadius:\s*r\.top\s*>=\s*0\s*\?\s*'var\(--radius\)'\s*:\s*'0px'/);
  assert.match(grid, /bottomRadius:\s*r\.bottom\s*<=\s*vp\.height\s*\?\s*'var\(--radius\)'\s*:\s*'0px'/);
});

test('Mobile masthead title preserves a trailing space while it is edited', async () => {
  const main = await readFile(new URL('../web/assets/js/main.js', import.meta.url), 'utf8');
  assert.match(main, /cleanBoardTitleDraft\(field\.textContent\)/);
  assert.doesNotMatch(main, /cleanBoardTitleDraft\(field\.innerText\)/);
});

test('the top-stop pen opens persisted header typography controls', async () => {
  const [html, css, module] = await Promise.all([
    readFile(new URL('../web/index.html', import.meta.url), 'utf8'),
    readFile(new URL('../web/assets/css/app.css', import.meta.url), 'utf8'),
    readFile(new URL('../web/assets/js/ui/mobile-header.js', import.meta.url), 'utf8'),
  ]);
  assert.match(html, /id="mobile-header-edit-btn"[\s\S]*aria-controls="header-panel"/);
  assert.match(html, /id="mobile-header-settings"/);
  for (const id of [
    'mobile-header-font', 'mobile-header-weight', 'mobile-header-size',
    'mobile-header-stretch', 'mobile-header-italic', 'mobile-header-axes',
  ]) {
    assert.match(html, new RegExp(`id="${id}"`));
  }
  assert.match(css, /#mobile-header-edit-btn\s*\{[\s\S]*var\(--chrome-button-h\)/);
  assert.match(module, /viewport\?\.atMobileTop\?\.\(\)/);
  assert.match(module, /headerFontAxes/);
  assert.match(module, /fontVariationSettings/);
  // A hair below the box's centre, which is where the ink's own middle is - see
  // app.css. Off by more than that and the title walks along the band.
  assert.match(css,
    /transform:\s*scaleY\(var\(--mobile-title-stretch,\s*1\)\);[\s\S]*transform-origin:\s*50%\s*52%;/);
});

test('Mobile viewport permits vertical movement only', () => {
  const vp = new Viewport(element(), element());
  vp.setBoardMode('mobile', 384, 384, -1216);
  const fixedZoom = vp.zoom;

  vp.panByScreen(80, -120);
  assert.equal(vp.pan.x, 0);
  assert.notEqual(vp.pan.y, 0);
  vp.zoomAt(100, 100, 2);
  assert.equal(vp.zoom, fixedZoom);
  vp.setView({ x: 900, y: -100 }, 10);
  assert.equal(vp.pan.x, 0);
  assert.equal(vp.pan.y, -100);
  assert.equal(vp.zoom, fixedZoom);
});

test('fitting Mobile returns to the top without fitting the whole height', () => {
  const vp = new Viewport(element(), element());
  vp.setBoardMode('mobile', 384, 384, -1216);
  vp.fit([
    { x: 0, y: -100, w: 200, h: 200 },
    { x: 0, y: -2000, w: 200, h: 200 },
  ], 80);

  assert.equal(vp.pan.x, 0);
  assertNear(vp.toScreen(0, 384).y, topEdgeY());
});

test('Mobile viewport has side gutters and finite vertical bounds', () => {
  const vp = new Viewport(element(), element());
  vp.setBoardMode('mobile', 384, 384, -1216);
  vp.fit([]);
  assert.equal(vp.atMobileTop(), true);

  assert.equal(vp.toScreen(-192, 0).x, 16);
  assert.equal(vp.toScreen(192, 0).x, 344);
  vp.panByScreen(0, 100000);
  assertNear(vp.toScreen(0, 384).y, topEdgeY(),
    'the board cannot scroll past its top edge');
  vp.panByScreen(0, -100000);
  assert.equal(vp.atMobileTop(), false);
  assert.equal(vp.toScreen(0, -1216).y, 688,
    'the board cannot scroll past its bottom edge');
});

test('the Mobile masthead keeps a 3:2 ratio with the board, above its top edge', () => {
  assert.equal(mobileHeaderHeight(330), 220);

  const vp = new Viewport(element(), element());
  vp.setBoardMode('mobile', 384, 384, -1216);
  vp.fit([]);
  assert.equal(vp.mobileScreenRect().width, 328);
  assertNear(vp.mobileHeaderPx(), 328 / (3 / 2));
  assertNear(vp.mobileScreenRect().width / vp.mobileHeaderPx(), 3 / 2);
  // The band stands on the top edge: its own top is the head of the viewport,
  // a pad down, and the board begins where it ends.
  assertNear(vp.toScreen(0, 384).y - vp.mobileHeaderPx(), 32);

  const shortVp = new Viewport(element(360, 300), element(360, 300));
  shortVp.setBoardMode('mobile', 384, 384, -1216);
  assert.equal(shortVp.mobileHeaderPx(), vp.mobileHeaderPx(),
    'screen height does not change the masthead');

  vp.setBoardMode('desktop');
  assert.equal(vp.mobileHeaderPx(), 0, 'Desktop has no masthead to make room for');
});

test('Mobile viewport follows a changing content bottom', () => {
  const vp = new Viewport(element(), element());
  vp.setBoardMode('mobile', 384, 384, -2400);
  vp.panByScreen(0, -100000);
  assert.equal(vp.toScreen(0, -2400).y, 688);

  vp.setMobileBounds(384, 384, -1216);
  assert.equal(vp.toScreen(0, -1216).y, 688,
    'shrinking content pulls an out-of-range view back to the new bottom');
});

test('Mobile suppresses Desktop spatial guides without changing their settings', () => {
  const settings = { axes: true };
  assert.equal(axesVisible(settings, 'mobile'), false);
  assert.equal(webVisible('mobile'), false);
  assert.equal(settings.axes, true);
  assert.equal(axesVisible(settings, 'desktop'), true);
  assert.equal(webVisible('desktop'), true);
});

test('Mobile board mode hides the ruler and zoom controls at every screen width', async () => {
  const css = await readFile(new URL('../web/assets/css/app.css', import.meta.url), 'utf8');
  const rule = /:root\[data-board-mode="mobile"\] #zoom-ctl,\s*:root\[data-board-mode="mobile"\] #scale-bar \{\s*display:\s*none;\s*\}/;
  const match = css.match(rule);
  assert.ok(match, 'visibility follows the selected board mode');
  assert.ok(css.indexOf(match[0]) < css.indexOf('@media (max-width: 700px)'),
    'the rule is not limited to a phone-sized viewport');
});
