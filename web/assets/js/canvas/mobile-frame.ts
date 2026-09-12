// Mobile strip's sheet and masthead, positioned in screen space without touching
// #viewport (which would invalidate the style of every mounted card). The sheet
// is clipped to the window and cached — scrolling through the middle writes
// nothing. The masthead is moved by transform on its own layer.

import { mobilePerfFlags } from './viewport.ts';
import type { Viewport, MobileScreenRect } from './viewport.ts';

// Re-exported so callers can name the type without importing viewport.ts.
export type { MobileScreenRect };

/** The sheet's clipped box, with a radius per end - see sheetBox(). */
export type SheetBox = {
  x: number;
  y: number;
  w: number;
  h: number;
  topRadius: string;
  bottomRadius: string;
};

let vp: Viewport | null = null;
let frameEl: HTMLElement | null = null;
let mastEl: HTMLElement | null = null;

/** What was last written, so a scroll through the middle of a board writes none. */
let lastSheet = '';
let lastMast = '';
/** null, not '' — empty string is a real value (off-screen masthead). */
let lastShift: string | null = null;
/** Whether the last pass was a Mobile one, so leaving the mode drops the cache. */
let wasMobile: boolean | null = null;

export function initMobileFrame(viewport: Viewport | null | undefined): void {
  vp = viewport || null;
  if (!vp || !vp.el) return;
  // Queried off viewport, tolerant of absence — render harnesses have no full page.
  frameEl = vp.el.querySelector<HTMLElement>(':scope > #mobile-board-frame');
  mastEl = vp.el.querySelector<HTMLElement>(':scope > #mobile-board-header');
  if (!frameEl || !mastEl) return;
  // Runs inside viewport's rAF — same frame as grid and axes.
  vp.onChange(draw);
  draw();
}

/** Exported for main.ts's boot sequence, which paints once before the first frame. */
export const paintMobileFrame = () => draw();

function draw() {
  if (!vp || !frameEl || !mastEl) return;

  if (!vp.isMobile) {
    // Drop cache so coming back to Mobile writes fresh geometry.
    if (wasMobile !== false) { wasMobile = false; lastSheet = lastMast = ''; lastShift = null; }
    return;
  }
  wasMobile = true;

  // Perf flag — skip writes when chrome is hidden.
  if (!mobilePerfFlags.chrome) return;

  const r = vp.mobileScreenRect();
  const headerH = vp.mobileHeaderPx();

  // Dev A/B for the old approach. Off in shipped boards.
  if (mobilePerfFlags.legacyVars) {
    vp.el.style.setProperty('--mobile-board-left', `${r.left}px`);
    vp.el.style.setProperty('--mobile-board-width', `${r.width}px`);
    vp.el.style.setProperty('--mobile-board-top', `${r.top}px`);
    vp.el.style.setProperty('--mobile-board-bottom', `${r.bottom}px`);
    vp.el.style.setProperty('--mobile-header-height', `${headerH}px`);
  }

  paintSheet(r);
  paintMasthead(r, headerH);
}

/**
 * Sheet box clipped to window — stops changing during scroll through the middle.
 * Only real board edges get a radius; scrolled-away edges stay square (matches inkBox).
 */
export function sheetBox(r: MobileScreenRect, width: number, height: number): SheetBox {
  const x = Math.max(0, r.left);
  const y = Math.max(0, r.top);
  return {
    x,
    y,
    w: Math.max(0, Math.min(width, r.left + r.width) - x),
    h: Math.max(0, Math.min(height, r.bottom) - y),
    topRadius: r.top >= 0 ? 'var(--radius)' : '0px',
    bottomRadius: r.bottom <= height ? 'var(--radius)' : '0px',
  };
}

/** Whether the masthead band is on screen at all, and where its top sits. */
export type MastShift = { visible: boolean; y: number };

/** Masthead position. Not written once scrolled off — even a hidden transform costs the compositor. */
export function mastShift(
  r: Pick<MobileScreenRect, 'top'>,
  headerH: number,
  height: number,
): MastShift {
  const bottom = r.top;
  const visible = bottom > 0 && bottom - headerH < height;
  return { visible, y: bottom - headerH };
}

function paintSheet(r: MobileScreenRect) {
  // draw() already tested both.
  if (!vp || !frameEl) return;
  const box = sheetBox(r, vp.width, vp.height);
  const next = `${box.x},${box.y},${box.w},${box.h},${box.topRadius},${box.bottomRadius}`;
  if (next === lastSheet) return;
  lastSheet = next;

  frameEl.style.left = `${box.x}px`;
  frameEl.style.top = `${box.y}px`;
  frameEl.style.width = `${box.w}px`;
  frameEl.style.height = `${box.h}px`;
  frameEl.style.borderRadius =
    `${box.topRadius} ${box.topRadius} ${box.bottomRadius} ${box.bottomRadius}`;
}

/** Masthead: properties written onto itself (not #viewport). Size and position cached separately. */
function paintMasthead(r: MobileScreenRect, headerH: number) {
  // draw() already tested both.
  if (!vp || !mastEl) return;
  const box = `${r.left},${r.width},${headerH}`;
  if (box !== lastMast) {
    lastMast = box;
    mastEl.style.left = `${r.left}px`;
    mastEl.style.width = `${r.width}px`;
    mastEl.style.height = `${headerH}px`;
    mastEl.style.setProperty('--mobile-board-width', `${r.width}px`);
    mastEl.style.setProperty('--mobile-header-height', `${headerH}px`);
  }

  const { visible, y } = mastShift(r, headerH, vp.height);
  const shift = visible ? `translateY(${y.toFixed(2)}px)` : '';
  if (shift === lastShift) return;
  lastShift = shift;
  mastEl.style.visibility = visible ? '' : 'hidden';
  if (visible) mastEl.style.transform = shift;
}
