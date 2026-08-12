import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

import { appCss } from './helpers.js';

import {
  Viewport, mobileZoom, mobileHeaderHeight,
} from '../web/assets/js/canvas/viewport.ts';
import { axesVisible } from '../web/assets/js/canvas/grid.ts';
import { sheetBox, mastShift } from '../web/assets/js/canvas/mobile-frame.ts';
import { webVisible } from '../web/assets/js/canvas/web.ts';
import { setSetting } from '../web/assets/js/state.ts';
import {
  createMobileSliderFocus,
  mobileLayoutDetected,
} from '../web/assets/js/ui/sidebar.ts';

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
  const [grid, frame] = await Promise.all([
    readFile(new URL('../web/assets/js/canvas/grid.ts', import.meta.url), 'utf8'),
    readFile(new URL('../web/assets/js/canvas/mobile-frame.ts', import.meta.url), 'utf8'),
  ]);
  const css = appCss();
  const rule = id => css.match(new RegExp(`#${id}\\s*\\{([^}]+)\\}`))?.[1] || '';

  assert.match(rule('mobile-board-title'), /line-height:\s*normal;/);
  // More below than above: overflow:hidden clips at the padding edge, and the
  // descenders of g/j/y hang past the last line box - further when the Line
  // height dial tightens it.
  assert.match(rule('mobile-board-title'), /padding-block:\s*0\.2em\s+0\.45em;/);
  assert.match(rule('mobile-board-title'), /overflow-wrap:\s*anywhere;/);
  assert.match(rule('mobile-board-frame'), /border-radius:\s*var\(--radius\);/);
  assert.match(rule('mobile-board-frame'),
    /background:\s*color-mix\(in srgb,\s*var\(--accent\)\s*var\(--mobile-board-accent\),\s*#fff\);/);
  // The sheet is positioned from the live board rectangle, clipped to the
  // window and written only when it changes - not from custom properties on
  // #viewport, which invalidated every card on the board once a frame. What the
  // clipping and the rounding come out as is asserted on sheetBox() itself
  // below; this is only that the painter goes through it and keeps the cache.
  assert.match(frame, /vp\.mobileScreenRect\(\)/);
  assert.match(frame, /sheetBox\(r, vp\.width, vp\.height\)/);
  assert.match(frame, /if \(next === lastSheet\) return;/);
  // The surround is its own static wash now. It was a 100vmax spread shadow on
  // the sheet, which repainted the whole window every time the board scrolled;
  // the tone it states is the same 6% of ink.
  assert.match(rule('mobile-surround'),
    /background:\s*color-mix\(in srgb,\s*var\(--ink\)\s*6%,\s*transparent\);/);
  assert.doesNotMatch(rule('mobile-board-frame'), /box-shadow/);
  assert.match(css,
    /data-whimsy="0"[^{}]*#mobile-board-frame\s*\{\s*--mobile-board-accent:\s*7%;\s*\}/);
  assert.match(css,
    /data-whimsy="2"[^{}]*#mobile-board-frame\s*\{\s*--mobile-board-accent:\s*4\.5%;\s*\}/);
  assert.match(grid, /topRadius:\s*r\.top\s*>=\s*0\s*\?\s*'var\(--radius\)'\s*:\s*'0px'/);
  assert.match(grid, /bottomRadius:\s*r\.bottom\s*<=\s*vp\.height\s*\?\s*'var\(--radius\)'\s*:\s*'0px'/);
});

test('the Mobile sheet is clipped to the window and rounds only a real edge', () => {
  const W = 390, H = 800;
  // A long board: top edge below the masthead, bottom edge far off the screen.
  const atTop = sheetBox({ left: 16, width: 358, top: 260, bottom: 4000 }, W, H);
  assert.deepEqual(
    [atTop.x, atTop.y, atTop.w, atTop.h], [16, 260, 358, 540],
    'at the top stop the sheet starts at the board edge and runs off the bottom');
  assert.equal(atTop.topRadius, 'var(--radius)');
  assert.equal(atTop.bottomRadius, '0px', 'the far edge is off screen and stays square');

  // Scrolled into the middle: both edges outside the window, so the box is the
  // window - which is the whole saving. This answer does not change for as long
  // as the scroll stays in the middle of the board, and the caller compares it
  // against the last one and writes nothing.
  const mid = sheetBox({ left: 16, width: 358, top: -900, bottom: 3100 }, W, H);
  assert.deepEqual([mid.x, mid.y, mid.w, mid.h], [16, 0, 358, H]);
  assert.equal(mid.topRadius, '0px');
  assert.equal(mid.bottomRadius, '0px');
  assert.deepEqual(
    sheetBox({ left: 16, width: 358, top: -1200, bottom: 2800 }, W, H), mid,
    'two different scroll positions in the middle of a board are one box');

  // At the bottom stop the far edge is back on screen and rounds again.
  const atBottom = sheetBox({ left: 16, width: 358, top: -3200, bottom: 700 }, W, H);
  assert.deepEqual([atBottom.x, atBottom.y, atBottom.w, atBottom.h], [16, 0, 358, 700]);
  assert.equal(atBottom.topRadius, '0px');
  assert.equal(atBottom.bottomRadius, 'var(--radius)');

  // A board scrolled entirely past the window has no box at all rather than a
  // negative one.
  const gone = sheetBox({ left: 16, width: 358, top: -4000, bottom: -300 }, W, H);
  assert.equal(gone.h, 0);
});

test('the Mobile masthead is written only while it is on screen', () => {
  const H = 800, headerH = 240;
  const top = mastShift({ top: 260 }, headerH, H);
  assert.equal(top.visible, true);
  assert.equal(top.y, 20, 'the band stands on the board edge, its own height above it');

  // Scrolled away for good: the board's top edge is above the window, so the
  // band that hangs off it is further above still and is not written at all.
  assert.equal(mastShift({ top: -1 }, headerH, H).visible, false);
  assert.equal(mastShift({ top: 0 }, headerH, H).visible, false);

  // ...and a board whose top edge has not reached the window yet - a very short
  // board on a very tall window, scrolled to its bottom stop.
  assert.equal(mastShift({ top: H + headerH + 1 }, headerH, H).visible, false);
  assert.equal(mastShift({ top: H + headerH - 1 }, headerH, H).visible, true);
});

test('no view frame writes an inherited custom property onto #viewport', async () => {
  // #viewport is an ancestor of #world, and custom properties are inherited, so
  // writing one there on a pan frame invalidates the computed style of every
  // mounted card and everything inside it. --iz is published to #world and is
  // quantised for exactly this reason (see IZ_STEP); the five Mobile board
  // properties used to be published here with no such guard, on a layout that
  // has no zoom at all. They live on the two elements that read them now.
  const viewport = await readFile(
    new URL('../web/assets/js/canvas/viewport.ts', import.meta.url), 'utf8');
  const paint = viewport.match(/_paint\(\)\s*\{[\s\S]*?\n  \}/)?.[0] || '';
  assert.ok(paint, 'could not find Viewport._paint()');
  assert.doesNotMatch(paint, /this\.el\.style\.setProperty/);
  assert.doesNotMatch(viewport, /--mobile-board-(top|bottom|left|width)/);
});

test('Mobile masthead title preserves a trailing space while it is edited', async () => {
  // The shared inline board-name editor, which the masthead and the Desktop
  // title card both use. Lifted out of main.js into ui/board-title.js.
  const mod = await readFile(
    new URL('../web/assets/js/ui/board-title.ts', import.meta.url), 'utf8');
  assert.match(mod, /cleanBoardTitleDraft\(field\.textContent\)/);
  assert.doesNotMatch(mod, /cleanBoardTitleDraft\(field\.innerText\)/);
});

test('the top-stop pen opens persisted header typography controls', async () => {
  const [html, module] = await Promise.all([
    readFile(new URL('../web/index.html', import.meta.url), 'utf8'),
    readFile(new URL('../web/assets/js/ui/mobile-header.ts', import.meta.url), 'utf8'),
  ]);
  const css = appCss();
  assert.match(html, /id="mobile-header-edit-btn"[\s\S]*aria-controls="header-panel"/);
  assert.match(html, /id="mobile-header-settings"/);
  for (const id of [
    'mobile-header-font', 'mobile-header-weight', 'mobile-header-size',
    'mobile-header-stretch', 'mobile-header-offset', 'mobile-header-italic',
    'mobile-header-axes',
  ]) {
    assert.match(html, new RegExp(`id="${id}"`));
  }
  assert.match(css, /#mobile-header-edit-btn\s*\{[\s\S]*var\(--chrome-button-h\)/);
  // The pen shows over the Feed's masthead (the editable title page) and comes down
  // on the Playlist lens - gated on the lens, not on the now-dormant canvas scroll
  // stop it used to read (atMobileTop, moot behind a DOM lens).
  assert.match(module, /dataset\.feedLens/);
  assert.match(css, /\[data-feed-lens="playlist"\]\s*#mobile-header-edit-btn\s*\{\s*display:\s*none/);
  assert.match(module, /headerFontAxes/);
  assert.match(module, /fontVariationSettings/);
  // The title's vertical position dial rides ahead of the stretch, as a fraction
  // of the band height, and the stretch keeps its hair-below-centre origin - see
  // app.css. Off by more than that and the title walks along the band.
  assert.match(css,
    /transform:[\s\S]*translateY\(calc\(var\(--mobile-header-height[\s\S]*var\(--mobile-title-offset[\s\S]*scaleY\(var\(--mobile-title-stretch,\s*1\)\);[\s\S]*transform-origin:\s*50%\s*52%;/);
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
  // Both have to be asked for - the web is off by default - or the assertions
  // below would pass on a board that never wanted them in the first place.
  const settings = { axes: true };
  setSetting('web', true);
  assert.equal(axesVisible(settings, 'mobile'), false);
  assert.equal(webVisible('mobile'), false);
  assert.equal(settings.axes, true);
  assert.equal(axesVisible(settings, 'desktop'), true);
  assert.equal(webVisible('desktop'), true);
});

test('Mobile board mode hides the ruler and zoom controls at every screen width', async () => {
  const css = appCss();
  const rule = /:root\[data-board-mode="mobile"\] #zoom-ctl,\s*:root\[data-board-mode="mobile"\] #scale-bar \{\s*display:\s*none;\s*\}/;
  const match = css.match(rule);
  assert.ok(match, 'visibility follows the selected board mode');
  assert.ok(css.indexOf(match[0]) < css.indexOf('@media (max-width: 700px)'),
    'the rule is not limited to a phone-sized viewport');
});

test('the Playlist lens shows the player and hides the canvas, outside any width query', async () => {
  // Playlist is a lens on a Mobile board, entered by the switch - so its show is
  // keyed on data-feed-lens="playlist" (under data-board-mode="mobile") and lives
  // above every @media block in mobile.css, the same shape as the #zoom-ctl hide
  // above. A width query would make a wide tablet asked for it get the canvas
  // instead. Both lenses (Feed and Playlist) are DOM boards that cover the canvas,
  // so the world-space viewport is hidden for the whole of Mobile, not only under
  // Playlist - the hide is keyed on the mode, not the lens.
  const css = await readFile(
    new URL('../web/assets/css/mobile.css', import.meta.url), 'utf8');
  const show = css.match(/:root\[data-board-mode="mobile"\]\[data-feed-lens="playlist"\] #mobile-playlist \{\s*display:\s*block;\s*\}/);
  // visibility, not display: display:none would collapse the fixed viewport to a
  // zero rect and a fit() on the way back to the canvas would clamp to MIN_ZOOM.
  const hide = css.match(/:root\[data-board-mode="mobile"\] #viewport \{\s*visibility:\s*hidden;\s*\}/);
  assert.ok(show, 'the playlist appears under the Playlist lens');
  assert.ok(hide, 'and the world-space canvas is hidden under it');
  // '@media (' rather than '@media', so the prose in a comment that mentions the
  // word does not count as the first query.
  const firstMedia = css.indexOf('@media (');
  assert.ok(css.indexOf(show[0]) < firstMedia && css.indexOf(hide[0]) < firstMedia,
    'the switch sits above every media query in mobile.css');
});

test('the feed surface is a sibling of #viewport, never a child of it', async () => {
  // #viewport has paint containment and publishes --iz to its subtree; a feed
  // nested inside would inherit that custom property and be caught by the
  // whole-board invalidation canvas/mobile-frame.js exists to avoid.
  const html = await readFile(new URL('../web/index.html', import.meta.url), 'utf8');
  const viewportClose = html.indexOf('<aside id="sidebar"');
  const feedAt = html.indexOf('id="mobile-feed"');
  assert.ok(feedAt > -1, 'the feed surface is in the markup');
  assert.ok(feedAt < viewportClose, 'and it stands before the sidebar, after #viewport');
  // The div is not inside the #viewport block: everything from #viewport to its
  // close comes before #mobile-feed.
  const viewportOpen = html.indexOf('<div id="viewport">');
  const worldClose = html.indexOf('<div id="marquee" hidden></div>');
  assert.ok(viewportOpen < worldClose && worldClose < feedAt,
    'the feed div comes after the viewport block closes');
});
