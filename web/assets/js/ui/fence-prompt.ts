// "Fence these N?" prompt after a rubber-band selection. Appears beside the
// cursor and withdraws on distance or any view change — declining costs nothing.
// Built fresh on each open, torn down on close.

// No preview of the would-be fence: the band just drawn already shows the
// region, and a second box over it read as a fence that was already there.

// Uses menu.ts's icon builder — the offer wears .ctx-item.
import { icon } from './menu.ts';
import { markClosed } from '../util.ts';
import type { Viewport } from '../canvas/viewport.ts';

/** Max distance from popup edges before dismissal, in CSS px (~2.5cm). Measured
 * from edges, not anchor — moving toward the button can never dismiss it. */
export const REACH = 95;

/** The offer's wording. Plural, singular, and the empty region get their own. */
export function fencePromptLabel(count: number): string {
  if (!count) return 'Fence this area';
  if (count === 1) return 'Fence this one';
  return `Fence these ${count}`;
}

/** Whether (x, y) is further than `reach` from the rectangle (edge distance, not corner). */
export function outOfReach(
  rect: { left: number; right: number; top: number; bottom: number },
  x: number,
  y: number,
  reach: number,
): boolean {
  const dx = Math.max(rect.left - x, 0, x - rect.right);
  const dy = Math.max(rect.top - y, 0, y - rect.bottom);
  return Math.hypot(dx, dy) > reach;
}

let node: HTMLDivElement | null = null;
let box: DOMRect | null = null;
let vp: Viewport | null = null;
/** The viewport subscription, held so close() can drop it. */
let offView: (() => void) | null = null;

export function initFencePrompt(viewport: Viewport | null): void {
  vp = viewport;

  // Dismiss on distance (mouse) or on any gesture/blur/resize (touch fallback).
  addEventListener('pointermove', e => {
    if (!node || !box) return;
    // Pointer down = mid-gesture (pan, second band) — don't dismiss by distance.
    if (e.buttons) return;
    if (outOfReach(box, e.clientX, e.clientY, REACH)) close();
  }, { passive: true });
  addEventListener('pointerdown', e => {
    // Click outside the prompt closes it.
    // SAFETY: a pointerdown is dispatched at a node of this document, and contains() takes any Node.
    if (node && !node.contains(e.target as Node | null)) close();
  }, true);
  addEventListener('keydown', e => {
    if (node && e.key === 'Escape') { e.stopPropagation(); markClosed(e); close(); }
  }, true);
  addEventListener('resize', close);
  addEventListener('blur', close);
}

export function close(): void {
  node?.remove();
  node = null;
  box = null;
  offView?.();
  offView = null;
}

/** Offer to fence `count` items beside the pointer. `action` runs on press. */
export function openFencePrompt(
  clientX: number,
  clientY: number,
  count: number,
  action: () => void,
): void {
  close();

  node = document.createElement('div');
  node.id = 'fence-prompt';

  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'ctx-item';
  // .ctx-item is a 3-column grid — label must be in a <span>.
  btn.append(icon('i-fence'));
  const label = document.createElement('span');
  label.textContent = fencePromptLabel(count);
  btn.append(label);
  btn.addEventListener('click', () => {
    close();
    action();
  });
  node.append(btn);

  // Measure hidden, then place. Flipped at edges (not clamped) to avoid landing
  // under the pointer.
  node.style.visibility = 'hidden';
  document.body.append(node);
  const { width, height } = node.getBoundingClientRect();
  const gap = 12;
  const pad = 8;
  const x = clientX + gap + width + pad > innerWidth
    ? Math.max(pad, clientX - gap - width) : clientX + gap;
  const y = clientY + gap + height + pad > innerHeight
    ? Math.max(pad, clientY - gap - height) : clientY + gap;
  node.style.left = Math.round(x) + 'px';
  node.style.top = Math.round(y) + 'px';
  // Grow from the corner nearest the pointer, after the flip - as menu.ts's
  // placeRoot() does. Left at its centre, the offer swelled out of nowhere.
  node.style.transformOrigin = `${x > clientX ? 0 : 100}% ${y > clientY ? 0 : 100}%`;
  node.style.visibility = '';
  box = node.getBoundingClientRect();

  // Close on view change — the offer belongs to the band, which a pan leaves behind.
  offView = vp?.onChange(close) || null;
}
