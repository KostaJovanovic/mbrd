// When the far-zoom rung (is-stilled: thumbnails for photographs, frozen GIFs)
// flips. Towards the thumbnails on the frame that crosses it, gesture or not,
// since a zoom-out otherwise rasters everything it brings into view from the
// full display copies. Back to the display copies only once the view stops,
// since those are the expensive raster. Driven with a stand-in world and
// viewport, no document.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { initStills } from '../web/assets/js/canvas/stills.ts';
import { stillZoom } from '../web/assets/js/canvas/viewport.ts';

function world() {
  const classes = new Set();
  return {
    classes,
    classList: {
      toggle: (c, on) => { if (on) classes.add(c); else classes.delete(c); return on; },
      contains: c => classes.has(c),
    },
    querySelectorAll: () => [],
  };
}

function view(zoom) {
  const fns = [];
  return {
    zoom, moving: false,
    onChange: fn => { fns.push(fn); return () => {}; },
    frame(patch) { Object.assign(this, patch); for (const fn of fns) fn(this); },
  };
}

test('a zoom-out takes the thumbnails as it crosses the rung, and a zoom-in waits to give them back', () => {
  const far = stillZoom() / 2, near = stillZoom() * 2;
  const w = world(), vp = view(near);
  initStills(w, vp);
  assert.equal(w.classes.has('is-stilled'), false, 'close in, the display copies');

  vp.frame({ moving: true, zoom: far });
  assert.equal(w.classes.has('is-stilled'), true, 'the frame that crosses going out swaps');

  vp.frame({ moving: true, zoom: near });
  assert.equal(w.classes.has('is-stilled'), true, 'coming back in mid-gesture does not');

  vp.frame({ moving: false });
  assert.equal(w.classes.has('is-stilled'), false, 'the settling frame does');
});
