// Moving and resizing a floating window, for the two of them the Desktop board
// has: the Playlist's player and the sticker pad.
//
// Written for the player and lifted out when the second one wanted the same
// behaviour, which is the whole justification - a window you can drag by its
// title bar and pull bigger by its corner is not a fact about music. Nothing
// here knows what is inside the window or who opened it; it is handed the
// element and the handle and wires the pointer.
//
// Both take the same shape, and it is worth naming once rather than twice: the
// first grab reads the window's current rectangle and pins it to explicit
// left/top, because a window opens anchored to an edge (right/bottom) and an
// anchored box cannot be dragged away from that edge. From then on the pointer
// writes coordinates. Clamped to the viewport with a small margin, so a window
// dragged at speed cannot be parked off the screen with no way back.
//
// Touches `document` only inside the two functions, both of which run from a
// panel's open path - so this module is safe to import at the top of anything.

import { clamp } from '../util.js';

/** How much of the window stays on screen, in px. */
const MARGIN = 8;

/**
 * Drag a window by a handle - in practice its title bar.
 *
 * Presses on buttons inside the handle are left alone, and not merely so the
 * button still works: setPointerCapture on the bar retargets the eventual click
 * to the bar itself, so a captured press over a button never reaches it at all.
 * In the player the close button was exempt and the view toggle was not, which
 * is how "Album view" came to do nothing whatsoever.
 */
export function makeWindowDrag(win, handle) {
  let d = null;
  handle.addEventListener('pointerdown', e => {
    if (e.button !== 0 || e.target.closest('button')) return;
    const r = win.getBoundingClientRect();
    win.style.left = `${r.left}px`;
    win.style.top = `${r.top}px`;
    win.style.right = 'auto';
    win.style.bottom = 'auto';
    d = { dx: e.clientX - r.left, dy: e.clientY - r.top, w: r.width, h: r.height };
    handle.setPointerCapture?.(e.pointerId);
    win.classList.add('is-moving');
    e.preventDefault();
  });
  handle.addEventListener('pointermove', e => {
    if (!d) return;
    win.style.left = `${clamp(e.clientX - d.dx, MARGIN, window.innerWidth - d.w - MARGIN)}px`;
    win.style.top = `${clamp(e.clientY - d.dy, MARGIN, window.innerHeight - d.h - MARGIN)}px`;
  });
  const end = e => {
    if (!d) return;
    d = null;
    handle.releasePointerCapture?.(e.pointerId);
    win.classList.remove('is-moving');
  };
  handle.addEventListener('pointerup', end);
  handle.addEventListener('pointercancel', end);
}

/**
 * Resize a window by its bottom-right grip.
 *
 * Like the move drag, the first grab pins the window to top/left so the corner
 * is free to travel, then pointer moves set an explicit width and height,
 * clamped to a floor and to what stays on screen. The height cap the stylesheet
 * puts on an unsized window is lifted the moment a size is set by hand -
 * otherwise the grip would refuse to grow it downwards and look broken.
 */
export function makeWindowResize(win, handle, { minW = 260, minH = 220 } = {}) {
  let d = null;
  handle.addEventListener('pointerdown', e => {
    if (e.button !== 0) return;
    const r = win.getBoundingClientRect();
    win.style.left = `${r.left}px`;
    win.style.top = `${r.top}px`;
    win.style.right = 'auto';
    win.style.bottom = 'auto';
    win.style.maxHeight = 'none';
    d = { x: e.clientX, y: e.clientY, w: r.width, h: r.height, left: r.left, top: r.top };
    handle.setPointerCapture?.(e.pointerId);
    win.classList.add('is-resizing');
    e.preventDefault();
  });
  handle.addEventListener('pointermove', e => {
    if (!d) return;
    win.style.width =
      `${clamp(d.w + (e.clientX - d.x), minW, window.innerWidth - d.left - MARGIN)}px`;
    win.style.height =
      `${clamp(d.h + (e.clientY - d.y), minH, window.innerHeight - d.top - MARGIN)}px`;
  });
  const end = e => {
    if (!d) return;
    d = null;
    handle.releasePointerCapture?.(e.pointerId);
    win.classList.remove('is-resizing');
  };
  handle.addEventListener('pointerup', end);
  handle.addEventListener('pointercancel', end);
}
