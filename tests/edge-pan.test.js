// Edge panning (canvas/edge-pan.ts): how fast a drag held near an edge of the
// board's visible room pans the board, and where that room is (Viewport.room()).

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';

import { edgeSpeed, edgeVelocity, EDGE_BAND, EDGE_MAX } from '../web/assets/js/canvas/edge-pan.ts';
import { Viewport } from '../web/assets/js/canvas/viewport.ts';

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

const element = (width, height) => ({
  style: { setProperty() {} },
  classList: { add() {}, remove() {}, toggle() {} },
  getBoundingClientRect: () => ({ left: 0, top: 0, width, height }),
});

const speed = pos => edgeSpeed(pos, 0, 1000, EDGE_BAND, EDGE_MAX);

test('the middle of the room holds still', () => {
  assert.equal(speed(500), 0);
  assert.equal(speed(EDGE_BAND), 0);
  assert.equal(speed(1000 - EDGE_BAND), 0);
});

test('the band pans towards its edge, faster the deeper in', () => {
  assert.ok(speed(EDGE_BAND / 2) < 0, 'the low edge pans back');
  assert.ok(speed(1000 - EDGE_BAND / 2) > 0, 'the high edge pans on');
  assert.equal(speed(EDGE_BAND / 2), -EDGE_MAX / 4);
  assert.ok(Math.abs(speed(4)) > Math.abs(speed(24)));
});

test('the edge and past it are full speed', () => {
  assert.equal(speed(0), -EDGE_MAX);
  assert.equal(speed(-200), -EDGE_MAX);
  assert.equal(speed(1000), EDGE_MAX);
  assert.equal(speed(1400), EDGE_MAX);
});

test('a narrow room keeps a still middle third', () => {
  assert.equal(edgeSpeed(45, 0, 90, EDGE_BAND, EDGE_MAX), 0);
  assert.equal(edgeSpeed(0, 0, 90, EDGE_BAND, EDGE_MAX), -EDGE_MAX);
  assert.equal(edgeSpeed(5, 0, 0, EDGE_BAND, EDGE_MAX), 0, 'no room, no pan');
});

test('a corner pans both ways at once', () => {
  const room = { left: 0, top: 0, right: 1000, bottom: 600 };
  assert.deepEqual(edgeVelocity({ x: 0, y: 600 }, room), { x: -EDGE_MAX, y: EDGE_MAX });
  assert.deepEqual(edgeVelocity({ x: 500, y: 0 }, room), { x: 0, y: -EDGE_MAX });
});

test('the room gives up an open sidebar on the left', () => {
  const vp = new Viewport(element(1000, 600), element(1000, 600));
  assert.deepEqual(vp.room(), { left: 0, top: 0, right: 1000, bottom: 600 });
  vp.setCover(() => 300);
  assert.deepEqual(vp.room(), { left: 300, top: 0, right: 1000, bottom: 600 });
  vp.setCover(() => 2000);
  assert.equal(vp.room().left, 1000, 'never past the viewport');
  vp.boardMode = 'mobile';
  assert.equal(vp.room().left, 0, 'a Mobile board is framed by its own rules');
});
