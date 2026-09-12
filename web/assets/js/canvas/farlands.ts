// Easter egg card placed at the float32 precision boundary (2^23 world units).
// Not an item, not persisted, not screen-pinned. Edge-triggered: fires on the
// crossing, removed when panned off screen, re-armed only by going back inside.

import { el } from '../util.ts';
import type { Viewport } from './viewport.ts';

export const FAR = 2 ** 23;
export const distance = (x: number, y: number) => Math.hypot(x, y);
export const isFarOut = (x: number, y: number) => distance(x, y) >= FAR;

const LINES = [
  'You are eight million pixels from anywhere.',
  'Past here the numbers stop being able to tell one pixel from the next, '
  + 'and the board starts to come apart. Nothing is stopping you.',
];

let card: HTMLElement | null = null;
let at: { x: number; y: number } | null = null;
let armed = false;

export function initFarLands(vp: Viewport) {
  return vp.onChange(v => {
    if (card) {
      if (!onScreen(v)) clear();
      return;
    }
    if (!isFarOut(v.pan.x, v.pan.y)) { armed = true; return; }
    if (!armed) return;
    at = { x: v.pan.x, y: v.pan.y };
    card = build(at.x, at.y);
    armed = false;
  });
}

export function boxInView(
  at: { x: number; y: number },
  rect: { x0: number; y0: number; x1: number; y1: number },
  w = W, h = H,
) {
  return at.x + w / 2 >= rect.x0 && at.x - w / 2 <= rect.x1
      && at.y + h / 2 >= rect.y0 && at.y - h / 2 <= rect.y1;
}

function onScreen(vp: Viewport) {
  return !!at && boxInView(at, vp.visibleRect(0));
}

function clear() {
  card?.remove();
  card = null;
  at = null;
}

const W = 420, H = 240;

function build(x: number, y: number) {
  const world = el('world');
  if (!world) return null;

  const node = document.createElement('div');
  node.id = 'far-lands';
  node.setAttribute('aria-hidden', 'true');
  node.style.left = (x - W / 2).toFixed(2) + 'px';
  node.style.top = (-y - H / 2).toFixed(2) + 'px';
  node.style.width = W + 'px';
  node.style.height = H + 'px';

  for (const line of LINES) {
    const p = document.createElement('p');
    p.textContent = line;
    node.append(p);
  }

  world.append(node);
  return node;
}

export function resetFarLands() {
  clear();
  armed = false;
}
