// Fades corner chrome after 15 s of inactivity. Any pointer, key, wheel, or
// viewport change wakes it. Sidebar is not affected — it is a deliberate open.

import type { Viewport } from '../canvas/viewport.ts';

const IDLE_MS = 15000;

/** <html>, cached at init - poke() runs on every pointermove. */
let root: HTMLElement | null = null;
let last = 0, timer = 0, idle = false;

export function initIdle(vp: Viewport | null): void {
  root = document.documentElement;

  // Capture + passive: nothing here is cancelled, but a stopped event must still wake us.
  const opts = { capture: true, passive: true };
  for (const type of ['pointermove', 'pointerdown', 'wheel', 'keydown']) {
    addEventListener(type, poke, opts);
  }
  // Animated moves (fit, travel, fling) count as activity. The board held still
  // while its box grows does not: that is the band the Timeline gives up when
  // this goes idle (canvas.css), and counting it woke the page the moment it
  // slept, every fifteen seconds, with the board jumping each time.
  vp?.onChange?.(v => { if (!v.holding) poke(); });
  // Returning from a background tab resets the timer, not instant-fades.
  addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') poke();
  });

  poke();
}

/** Something happened. */
function poke(): void {
  last = now();
  if (idle) {
    idle = false;
    root!.classList.remove('is-idle');
  }
  // One timer, not one per event — checks elapsed time when it fires and rearms if needed.
  if (!timer) timer = setTimeout(check, IDLE_MS);
}

function check(): void {
  const left = IDLE_MS - (now() - last);
  // Skip rearm if within one frame of the deadline.
  if (left > 16) {
    timer = setTimeout(check, left);
    return;
  }
  timer = 0;
  idle = true;
  root!.classList.add('is-idle');
}

const now = () => (typeof performance === 'object' ? performance.now() : Date.now());
