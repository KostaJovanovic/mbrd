// Background grid. Purely visual: it never participates in hit-testing and no
// item is ever snapped to it unless the snap setting is on.
//
// The grid is painted as layered CSS background gradients on #viewport (screen
// space), not inside the transformed #world - so lines stay hairline-crisp at
// any zoom instead of being scaled up into fat blurry bands. The world origin is
// tracked through `background-position`, and the spacing is quantised in powers
// of two so it never degenerates into a solid fill when you zoom out.

import { board } from '../state.js';

const MIN_PX = 26;    // on-screen spacing below which we step up to a coarser grid
const MAX_PX = 104;   // ...and above which we step down to a finer one
const MAJOR = 4;      // major line every N minor steps

/** World-space grid step whose on-screen spacing lands inside [MIN_PX, MAX_PX]. */
export function gridStep(base, zoom) {
  let step = base > 0 ? base : 64;
  let guard = 0;
  while (step * zoom < MIN_PX && guard++ < 64) step *= 2;
  while (step * zoom > MAX_PX && guard++ < 64) step /= 2;
  return step;
}

export function paintGrid(vp) {
  const el = vp.el;
  const s = board.settings;

  el.classList.toggle('no-axes', !s.axes);

  if (!s.grid) {
    el.style.backgroundImage = 'none';
    return;
  }

  const step = gridStep(s.gridStep, vp.zoom);
  const minor = step * vp.zoom;
  const major = minor * MAJOR;
  const o = vp.toScreen(0, 0);

  const images = [], sizes = [], positions = [];
  const push = (img, size, px, py) => { images.push(img); sizes.push(`${size}px ${size}px`); positions.push(`${px.toFixed(1)}px ${py.toFixed(1)}px`); };

  // First layer paints on top, so majors are listed before minors.
  if (s.gridStyle === 'dots') {
    push(dot('var(--grid-major)', 'calc(var(--grid-dot) * 1.5)'), major, o.x - major / 2, o.y - major / 2);
    push(dot('var(--grid-minor)', 'var(--grid-dot)'), minor, o.x - minor / 2, o.y - minor / 2);
  } else if (s.gridStyle === 'graph') {
    // Major lines only - a calmer grid for busy boards.
    push(line(90, 'var(--grid-major)'), major, o.x, o.y);
    push(line(180, 'var(--grid-major)'), major, o.x, o.y);
  } else {
    push(line(90, 'var(--grid-major)', 'calc(var(--grid-dot) * 1.2)'), major, o.x, o.y);
    push(line(180, 'var(--grid-major)', 'calc(var(--grid-dot) * 1.2)'), major, o.x, o.y);
    push(line(90, 'var(--grid-minor)'), minor, o.x, o.y);
    push(line(180, 'var(--grid-minor)'), minor, o.x, o.y);
  }

  el.style.backgroundImage = images.join(', ');
  el.style.backgroundSize = sizes.join(', ');
  el.style.backgroundPosition = positions.join(', ');
}

const dot = (color, r) =>
  `radial-gradient(circle at center, ${color} 0, ${color} ${r}, transparent calc(${r} + 0.7px))`;

const line = (deg, color, t = 'var(--grid-dot)') =>
  `linear-gradient(${deg}deg, ${color} 0, ${color} ${t}, transparent ${t})`;
