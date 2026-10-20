// A pinch that lands on the controls floating over the board zooms the board.
// Those controls sit outside #viewport, so a finger on one never reached the
// pipeline in canvas/input.ts, and the browser took the pair as a page zoom.
// This hands such fingers to #viewport as presses there, and the one pipeline
// sees an ordinary two-finger pinch. initChromePinch() wires it.

import { capturePointerSafely } from '../util.ts';

/**
 * The controls over the board: small, and nothing on them a reader zooms the
 * page for. The sidebar, the panels and the menus keep the browser's zoom,
 * which is how a low-vision reader enlarges their text (index.html says why).
 */
const OVER_BOARD = '#menu-btn, #mobile-header-edit-btn, #mobile-find-btn, #drawer-dock, #corner, #toolbar, #pen-bar, #board-path';

/** Fingers down on the controls, where they are now, not yet handed over. */
const held = new Map<number, { x: number, y: number }>();
/** Fingers down on the board itself, which the pipeline already has. */
const onBoard = new Set<number>();

export function initChromePinch(board: HTMLElement): void {
  // `none` and not `pan-x pan-y`: a pan the browser may claim ends in a
  // pointercancel, and the pinch with it. None of these scrolls.
  for (const node of document.querySelectorAll<HTMLElement>(OVER_BOARD)) node.style.touchAction = 'none';

  // Capture phase, so this sees a press before the control under it does.
  document.addEventListener('pointerdown', e => {
    if (e.pointerType !== 'touch' || !e.isTrusted) return;
    const target = e.target instanceof Element ? e.target : null;
    if (target && board.contains(target)) {
      onBoard.add(e.pointerId);
      // A finger already on the controls joins this one in a pinch: handed
      // over now, ahead of this press, so the pipeline counts two.
      if (held.size && boardShown()) handOver(board);
      return;
    }
    if (!target?.closest(OVER_BOARD)) return;
    held.set(e.pointerId, { x: e.clientX, y: e.clientY });
    // A second finger, wherever the first is: both go to the board, and the
    // control under this one never hears of it.
    if (held.size + onBoard.size >= 2 && boardShown()) {
      e.stopPropagation();
      e.preventDefault();
      handOver(board);
    }
  }, true);

  document.addEventListener('pointermove', e => {
    const at = held.get(e.pointerId);
    if (at) { at.x = e.clientX; at.y = e.clientY; }
  }, true);

  const lift = (e: PointerEvent) => { held.delete(e.pointerId); onBoard.delete(e.pointerId); };
  document.addEventListener('pointerup', lift, true);
  document.addEventListener('pointercancel', lift, true);
}

/** Not in Feed or the playlist, where the board is not what is on screen. */
function boardShown() {
  const up = (id: string) => document.getElementById(id)?.hidden === false;
  return !up('mobile-feed') && !up('mobile-playlist');
}

/**
 * Every held finger becomes a press on the board where it is, captured there
 * so its moves and its lift follow. The control it began on gets no click:
 * the lift lands on the board.
 */
function handOver(board: HTMLElement) {
  for (const [pointerId, at] of held) {
    held.delete(pointerId);
    onBoard.add(pointerId);
    capturePointerSafely(board, pointerId);
    board.dispatchEvent(new PointerEvent('pointerdown', {
      pointerId, pointerType: 'touch', isPrimary: false,
      clientX: at.x, clientY: at.y, button: 0, buttons: 1,
      bubbles: true, cancelable: true, composed: true,
    }));
  }
}
