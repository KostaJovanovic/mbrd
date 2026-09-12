// Drag-by-titlebar and corner-resize for floating windows (playlist player,
// sticker pad). First grab pins to explicit left/top (anchored windows cannot
// be dragged otherwise). Clamped to viewport with MARGIN.

import { clamp } from '../util.ts';

/** How much of the window stays on screen, in px. */
const MARGIN = 8;

/** Bind move/release on window for one grab; returns detach (must be called on
 * close — windows are rebuilt on each open). */
function grab(
  onMove: (e: PointerEvent) => void,
  onEnd: (e: PointerEvent) => void,
): () => void {
  addEventListener('pointermove', onMove);
  addEventListener('pointerup', onEnd);
  addEventListener('pointercancel', onEnd);
  return () => {
    removeEventListener('pointermove', onMove);
    removeEventListener('pointerup', onEnd);
    removeEventListener('pointercancel', onEnd);
  };
}

/** Drag a window by its title bar. Buttons inside the handle are not captured
 * — setPointerCapture retargets clicks to the bar and breaks them. */
export function makeWindowDrag(win: HTMLElement, handle: HTMLElement): () => void {
  /** The grab: where in the window the pointer took hold, and how big it was. */
  let d: { dx: number; dy: number; w: number; h: number } | null = null;
  handle.addEventListener('pointerdown', e => {
    // SAFETY: a pointerdown's target is the element it landed on; the cast says
    // that where the DOM types only promise an EventTarget. The listener is on
    // the window's own handle, so there is nowhere else it can come from.
    if (e.button !== 0 || (e.target as Element).closest('button')) return;
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
  // On the window, not on the handle - so the drag does not depend on capture
  // having been granted. All three were bound to the title bar and the whole
  // gesture rode on an optional-chained setPointerCapture(): where capture is
  // refused or absent, a pointer that left the bar delivered nothing here, `d`
  // was never cleared by an `up` that also went elsewhere, and the window went
  // on following the pointer with no way to put it down. `d` is what says
  // whether a drag is running; the listeners only have to be somewhere they
  // will hear about it. grab() binds their lifetime to the detach returned
  // below, which the caller calls on close - the window is rebuilt on every open.
  const move = (e: PointerEvent) => {
    if (!d) return;
    win.style.left = `${clamp(e.clientX - d.dx, MARGIN, window.innerWidth - d.w - MARGIN)}px`;
    win.style.top = `${clamp(e.clientY - d.dy, MARGIN, window.innerHeight - d.h - MARGIN)}px`;
  };
  const end = (e: PointerEvent) => {
    if (!d) return;
    d = null;
    handle.releasePointerCapture?.(e.pointerId);
    win.classList.remove('is-moving');
  };
  return grab(move, end);
}

/** Resize by bottom-right grip. Pins to top/left on first grab. Lifts the CSS
 * max-height when a manual size is set. */
export function makeWindowResize(
  win: HTMLElement,
  handle: HTMLElement,
  { minW = 260, minH = 220 }: { minW?: number; minH?: number } = {},
): () => void {
  /** The grab: where the pointer started, and the rectangle it started from. */
  let d: { x: number; y: number; w: number; h: number; left: number; top: number } | null = null;
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
  // On window — the 20px grip is left almost immediately.
  const move = (e: PointerEvent) => {
    if (!d) return;
    win.style.width =
      `${clamp(d.w + (e.clientX - d.x), minW, window.innerWidth - d.left - MARGIN)}px`;
    win.style.height =
      `${clamp(d.h + (e.clientY - d.y), minH, window.innerHeight - d.top - MARGIN)}px`;
  };
  const end = (e: PointerEvent) => {
    if (!d) return;
    d = null;
    handle.releasePointerCapture?.(e.pointerId);
    win.classList.remove('is-resizing');
  };
  return grab(move, end);
}
