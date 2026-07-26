import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';

import { Viewport, mobileZoom } from '../web/assets/js/canvas/viewport.js';
import { axesVisible } from '../web/assets/js/canvas/grid.js';
import { webVisible } from '../web/assets/js/canvas/web.js';

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

const style = () => ({ setProperty() {} });
const element = (width = 360, height = 720) => ({
  style: style(),
  classList: { add() {}, remove() {}, toggle() {} },
  getBoundingClientRect: () => ({ left: 0, top: 0, width, height }),
});

test('Mobile zoom fits six columns and never enlarges them', () => {
  assert.equal(mobileZoom(360, 384), 296 / 384);
  assert.equal(mobileZoom(1000, 384), 1);
});

test('Mobile viewport permits vertical movement only', () => {
  const vp = new Viewport(element(), element());
  vp.setBoardMode('mobile', 384, 640);
  const fixedZoom = vp.zoom;

  vp.panByScreen(80, -120);
  assert.equal(vp.pan.x, 0);
  assert.notEqual(vp.pan.y, 0);
  vp.zoomAt(100, 100, 2);
  assert.equal(vp.zoom, fixedZoom);
  vp.setView({ x: 900, y: 20 }, 10);
  assert.equal(vp.pan.x, 0);
  assert.equal(vp.pan.y, 20);
  assert.equal(vp.zoom, fixedZoom);
});

test('fitting Mobile returns to the top without fitting the whole height', () => {
  const vp = new Viewport(element(), element());
  vp.setBoardMode('mobile', 384, 640);
  vp.fit([
    { x: 0, y: -100, w: 200, h: 200 },
    { x: 0, y: -2000, w: 200, h: 200 },
  ], 80);

  assert.equal(vp.pan.x, 0);
  assert.equal(vp.toScreen(0, 640).y, 32);
});

test('Mobile viewport has side gutters, a finite top, and no lower bound', () => {
  const vp = new Viewport(element(), element());
  vp.setBoardMode('mobile', 384, 640);
  vp.fit([]);

  assert.equal(vp.toScreen(-192, 0).x, 32);
  assert.equal(vp.toScreen(192, 0).x, 328);
  vp.panByScreen(0, 100000);
  assert.equal(vp.toScreen(0, 640).y, 32, 'the board cannot scroll past its top edge');
  vp.panByScreen(0, -100000);
  assert.ok(vp.pan.y < -10000, 'downward travel remains unbounded');
});

test('Mobile suppresses Desktop spatial guides without changing their settings', () => {
  const settings = { axes: true };
  assert.equal(axesVisible(settings, 'mobile'), false);
  assert.equal(webVisible('mobile'), false);
  assert.equal(settings.axes, true);
  assert.equal(axesVisible(settings, 'desktop'), true);
  assert.equal(webVisible('desktop'), true);
});
