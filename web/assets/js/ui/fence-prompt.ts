// "Fence these N?" prompt after a rubber-band selection. Appears beside the
// cursor and withdraws on distance or any view change — declining costs nothing.
// Built fresh on each open, torn down on close.

// Uses menu.ts's icon builder — the offer wears .ctx-item.
import { icon } from './menu.ts';
import { markClosed } from '../util.ts';
import type { Viewport } from '../canvas/viewport.ts';

/** Viewport fields this module reads — intersection until viewport.ts is fully typed. */
type PromptViewport = Viewport & { el: HTMLElement; zoom: number };

/** A rectangle in world space, as the marquee hands it over. */
interface WorldBox {
  x: number;
  y: number;
  w: number;
  h: number;
}

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
let ghost: HTMLDivElement | null = null;
let box: DOMRect | null = null;
let vp: PromptViewport | null = null;
/** The viewport subscription, held so close() can drop it. */
let offView: (() => void) | null = null;

export function initFencePrompt(viewport: PromptViewport | null): void {
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
  ghost?.remove();
  node = null;
  ghost = null;
  box = null;
  offView?.();
  offView = null;
}

/** Draw the fence's box faintly where it would land. Shows the fence's unioned
 * box, not the marquee's — they differ when items extend past the band.
 * Screen space, converted once (offer closes on any view change). */
function drawGhost(world: WorldBox | null): HTMLDivElement | null {
  if (!vp?.el || !world) return null;
  const el = document.createElement('div');
  el.id = 'fence-ghost';
  el.setAttribute('aria-hidden', 'true');
  // World y up, CSS y down — top-left is at +h/2.
  const at = vp.toScreen(world.x - world.w / 2, world.y + world.h / 2);
  el.style.left = `${Math.round(at.x)}px`;
  el.style.top = `${Math.round(at.y)}px`;
  el.style.width = `${Math.round(world.w * vp.zoom)}px`;
  el.style.height = `${Math.round(world.h * vp.zoom)}px`;
  vp.el.append(el);
  return el;
}

/** Offer to fence `count` items beside the pointer. `action` runs on press. */
export function openFencePrompt(
  clientX: number,
  clientY: number,
  count: number,
  world: WorldBox | null,
  action: () => void,
): void {
  close();

  // Ghost before button so the prompt is never painted under the ghost.
  ghost = drawGhost(world);

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
  node.style.visibility = '';
  box = node.getBoundingClientRect();

  // Close on view change — the ghost would drift from the actual fence region.
  offView = vp?.onChange(close) || null;
}
