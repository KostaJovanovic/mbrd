// The scale bar: a stick of known length, laid on the board.
//
// The one piece of chrome that answers "how big is any of this" without being
// asked. Everything else the measurement feature adds is on demand - the HUD
// reads out where the pointer is, the selection reads out how big one item is -
// and neither helps with the question you have while looking at the whole
// board, which is whether the arrangement in front of you is a desk, a wall, or
// a building.
//
// Drawn as a real bar rather than printed as "1 px = 0.4 mm", and the reason is
// the same one every map has: a ratio has to be arithmetic'd against something
// before it means anything, and a bar is already the length it is talking
// about. You compare it to the picture beside it with your eyes.
//
// It lives in the corner cluster with the zoom control, above it, because the
// two answer halves of one question and because it must never be the thing
// nearest the thumb.

import { board, bus } from '../state.js';
import { el, rafThrottle } from '../util.js';
import { toUnits, scaleStep, formatMm } from '../measure.js';

/**
 * How long the bar is allowed to be, in screen pixels.
 *
 * The corner cluster is as wide as the zoom control, and a bar wider than its
 * neighbour turns a quiet corner into a ruler with a zoom button attached. This
 * is the ceiling, not the length: the bar is whatever round number fits under
 * it, so it breathes between about half this and all of it as you zoom.
 */
const MAX_BAR_PX = 116;

let vp = null;
let node = null;
let label = null;
let stick = null;
let last = '';

export function initScaleBar(viewport) {
  vp = viewport;
  node = el('scale-bar');
  if (!node || !vp) return;
  label = el('scale-bar-label');
  stick = el('scale-bar-stick');

  const paint = rafThrottle(draw);
  vp.onChange(paint);
  // The scale and the unit family both live in board.settings, so they arrive
  // through the same two doors every other setting does.
  bus.on('settings', paint);
  bus.on('board:load', paint);
  draw();
}

function draw() {
  if (!node || !vp) return;
  // Screen pixels per millimetre, which is the zoom and the scale composed:
  // toUnits(1, …) is how many world units one millimetre buys, and the zoom is
  // how many screen pixels one unit buys.
  const pxPerMm = vp.zoom * toUnits(1, board.settings.scale);
  const step = scaleStep(pxPerMm, MAX_BAR_PX, board.settings.units);

  // Zoomed so far in that even the shortest rung overflows the corner. There is
  // no honest bar to draw, so none is drawn - a bar clipped to its container is
  // a bar telling a lie about its own length.
  if (!step) {
    node.hidden = true;
    return;
  }
  node.hidden = false;

  // Rewriting the same two values on every frame of a pan is a layout pass per
  // frame for no change at all, and the bar only moves when the zoom crosses a
  // rung - which during a pan is never.
  const key = step.mm + '|' + Math.round(step.px);
  if (key === last) return;
  last = key;
  stick.style.width = Math.round(step.px) + 'px';
  label.textContent = formatMm(step.mm, board.settings.units);
}
