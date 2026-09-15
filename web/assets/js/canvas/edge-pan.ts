// Edge panning: a drag held near the edge of the board's visible room pans the
// board under it, so a card can be carried past what the window shows. One
// frame loop per drag, timed by the frame's own interval so the speed is the
// same at 60 and 120 Hz; the drag re-applies itself at the still pointer after
// each step. The arithmetic is pure and exported for tests.

import type { Point } from '../geometry.ts';
import type { Viewport } from './viewport.ts';

/** How deep the band along each edge is, in CSS px. */
export const EDGE_BAND = 48;

/**
 * Top speed, in CSS px a second, reached at the edge and past it. About 15px a
 * frame at 60 Hz, which is what the Playlist's reorder stepped by when it
 * counted in frames.
 */
export const EDGE_MAX = 900;

/**
 * How long a pointer takes to reach its speed after it enters the band. A card
 * grabbed at the edge starts slowly rather than racing off with the board.
 */
const RAMP_MS = 250;

/** The longest frame counted, so a stalled tab does not come back with one huge step. */
const MAX_FRAME_MS = 50;

/** A rectangle in client px. */
export type Room = { left: number, top: number, right: number, bottom: number };

/**
 * One axis: how fast a pointer at `pos` pans between `lo` and `hi`, signed
 * towards the nearer edge. 0 in the middle, rising with the square of how deep
 * into the band it is, and full speed at the edge and past it - a captured
 * pointer over the sidebar, the Timeline or off the window. A room narrower
 * than three bands shares itself out in thirds, so the middle stays still.
 */
export function edgeSpeed(pos: number, lo: number, hi: number, band: number, max: number): number {
  const b = Math.min(band, Math.max(0, hi - lo) / 3);
  if (!(b > 0)) return 0;
  if (pos < lo + b) return -max * Math.min(1, (lo + b - pos) / b) ** 2;
  if (pos > hi - b) return max * Math.min(1, (pos - (hi - b)) / b) ** 2;
  return 0;
}

/** Both axes, so a corner pans diagonally. */
export function edgeVelocity(p: Point, room: Room, band = EDGE_BAND, max = EDGE_MAX): Point {
  return {
    x: edgeSpeed(p.x, room.left, room.right, band, max),
    y: edgeSpeed(p.y, room.top, room.bottom, band, max),
  };
}

export type EdgePanOptions = {
  /** The pointer, in client px, or null to hold still this frame. */
  point: () => Point | null,
  /**
   * Called after each step, to re-apply the drag at the same screen point.
   * Absent for a drag whose drop is read off the pointer as it lands.
   */
  onPan?: () => void,
  /**
   * Hold off until the pointer has been in the middle of the room once. For a
   * drag that starts in a window standing on the edge of the screen - the
   * sticker pad, the drawer - which would otherwise pan from its first frame.
   */
  needsEntry?: boolean,
};

/**
 * Pan the board while the pointer stands in the band along an edge of the room
 * it can be seen in (Viewport.room()). Returns the stop, which the drag calls
 * however it ends. Nothing on a Mobile board, which is not dragged on.
 */
export function startEdgePan(vp: Viewport, opts: EdgePanOptions): () => void {
  if (typeof requestAnimationFrame !== 'function') return () => {};
  let frame = 0;
  let last = 0;                     // the previous frame's time, 0 before the first
  let since = 0;                    // when the pointer entered the band, 0 outside it
  let entered = !opts.needsEntry;
  const tick = (now: number) => {
    frame = requestAnimationFrame(tick);
    const dt = last ? Math.min(now - last, MAX_FRAME_MS) / 1000 : 0;
    last = now;
    const p = opts.point();
    if (!p || vp.isMobile) { since = 0; return; }
    const v = edgeVelocity(p, vp.room());
    if (!v.x && !v.y) { since = 0; entered = true; return; }
    if (!entered) return;
    if (!since) since = now;
    const k = Math.min(1, (now - since) / RAMP_MS) * dt;
    if (!k) return;
    // panByScreen moves the board with the hand, so the view goes the other way.
    vp.panByScreen(-v.x * k, -v.y * k);
    opts.onPan?.();
  };
  frame = requestAnimationFrame(tick);
  return () => cancelAnimationFrame(frame);
}
