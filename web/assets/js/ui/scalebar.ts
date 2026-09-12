// Scale bar: a stick of known physical length in the corner cluster above the zoom.
// Snaps to round lengths that fit under MAX_BAR_PX; hides when no rung fits.

import { board, bus } from '../state.ts';
import { el, rafThrottle } from '../util.ts';
import { toUnits, scaleStep, formatMm } from '../measure.ts';
import type { Viewport } from '../canvas/viewport.ts';

const MAX_BAR_PX = 116;

type ScaleViewport = Viewport & { zoom: number };

let vp: ScaleViewport | null = null;
let node: HTMLElement | null = null;
let label: HTMLElement | null = null;
let stick: HTMLElement | null = null;
let last = '';

export function initScaleBar(viewport: ScaleViewport | null): void {
  vp = viewport;
  node = el('scale-bar');
  if (!node || !vp) return;
  label = el('scale-bar-label');
  stick = el('scale-bar-stick');

  const paint = rafThrottle(draw);
  vp.onChange(paint);
  bus.on('settings', paint);
  bus.on('board:load', paint);
  draw();
}

function draw(): void {
  if (!node || !vp) return;
  const pxPerMm = vp.zoom * toUnits(1, board.settings.scale);
  const step = scaleStep(pxPerMm, MAX_BAR_PX, board.settings.units);

  if (!step) {
    node.hidden = true;
    return;
  }
  node.hidden = false;

  // Only rewrite when the rung changes (not on every pan frame).
  const key = step.mm + '|' + Math.round(step.px);
  if (key === last) return;
  last = key;
  stick!.style.width = Math.round(step.px) + 'px';
  label!.textContent = formatMm(step.mm, board.settings.units);
}
