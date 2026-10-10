// A drawing card's face: one <svg> holding a <path> per stroke, highlighters
// under pens, each drawn the way the current whimsy tier draws it. Inks are
// classes the stylesheet colours (cards.css), so a drawing follows the
// palette and colourblind mode. A tier change redraws every mounted face.

import type { Item } from '../board-model.ts';
import { byId } from '../state.ts';
import { readDrawing, outline, type Stroke, type Tier } from './strokes.ts';

const NS = 'http://www.w3.org/2000/svg';

/** The tier as <html data-whimsy> says it, Middle when it says nothing. */
export function currentTier(): Tier {
  const w = typeof document === 'undefined' ? '1' : document.documentElement.dataset.whimsy;
  return w === '0' ? 0 : w === '2' ? 2 : 1;
}

/** One stroke's path, or null when it has no points. */
function strokePath(s: Stroke, tier: Tier): SVGPathElement | null {
  const o = outline(s, tier);
  if (!o.d) return null;
  const path = document.createElementNS(NS, 'path');
  path.setAttribute('d', o.d);
  path.setAttribute('class', s.tool === 'highlighter' ? 'stroke-hl' : 'stroke-pen');
  path.dataset.ink = s.ink;
  if (o.kind === 'line') {
    path.setAttribute('fill', 'none');
    path.setAttribute('stroke', 'currentColor');
    path.setAttribute('stroke-width', String(o.width));
    path.setAttribute('stroke-linecap', o.cap);
    path.setAttribute('stroke-linejoin', o.join);
  } else {
    path.setAttribute('fill', 'currentColor');
  }
  return path;
}

/** The whole face. `index` on each path is its place in meta.strokes, which
 *  the eraser marks strokes by while it is held. */
export function drawingArt(item: Pick<Item, 'meta'>): SVGSVGElement {
  watchTier();
  const { strokes, space } = readDrawing(item.meta);
  const svg = document.createElementNS(NS, 'svg');
  svg.setAttribute('class', 'drawing-art');
  svg.setAttribute('viewBox', `0 0 ${space[0]} ${space[1]}`);
  svg.setAttribute('preserveAspectRatio', 'xMidYMid meet');
  svg.setAttribute('aria-hidden', 'true');
  fill(svg, strokes, currentTier());
  return svg;
}

function fill(svg: SVGSVGElement, strokes: Stroke[], tier: Tier) {
  const paths: SVGPathElement[] = [];
  // Highlighters first, so ink lies over the wash as it would on paper.
  for (const pass of ['highlighter', 'pen'] as const) {
    strokes.forEach((s, i) => {
      if (s.tool !== pass) return;
      const p = strokePath(s, tier);
      if (!p) return;
      p.dataset.index = String(i);
      paths.push(p);
    });
  }
  svg.replaceChildren(...paths);
}

let watching = false;

/** Every mounted face drawn again when the tier changes, each from its own
 *  card's strokes, found through the id on the .item round it. Started by the
 *  first face built, so no module touches the document at import. */
function watchTier() {
  if (watching || typeof MutationObserver === 'undefined') return;
  watching = true;
  new MutationObserver(() => {
    const tier = currentTier();
    for (const svg of document.querySelectorAll<SVGSVGElement>('.item .drawing-art')) {
      const id = svg.closest<HTMLElement>('.item')?.dataset.id;
      const item = id && byId(id);
      if (item) fill(svg, readDrawing(item.meta).strokes, tier);
    }
  }).observe(document.documentElement, { attributes: true, attributeFilter: ['data-whimsy'] });
}
