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
  // An attribute read, not getComputedStyle. This function runs on every frame
  // of every pan and pinch, and asking for a computed value in here would force
  // a synchronous style flush per frame for a value that changes about once an
  // afternoon. ui/appearance.js announces the change instead, so the attribute
  // is always current by the time we look at it.
  const mark = document.documentElement.dataset.whimsy === HARSH ? cross : dot;

  const images = [], sizes = [], positions = [];
  // A mark is a list of gradient layers rather than one, because the cross
  // takes two. Every layer of a mark shares its lattice's tile and origin, so
  // they are pushed together.
  const push = (layers, size, px, py) => {
    for (const img of layers) {
      images.push(img);
      sizes.push(`${size}px ${size}px`);
      positions.push(`${px.toFixed(1)}px ${py.toFixed(1)}px`);
    }
  };

  // Marks, never ruled lines. Lines were an option here and were the wrong one
  // on an infinite board: at any fractional zoom a full-bleed line grid beats
  // against the pixel grid into moire, and it competes with the world axes for
  // the same reading. A mark at each intersection states the same lattice and
  // stays quiet - which is also why the cross below is a short mark and not
  // the pair of rules it looks like it wants to be.
  // First layer paints on top, so majors are listed before minors.
  push(mark('var(--grid-major)', 1.5), major, o.x - major / 2, o.y - major / 2);
  push(mark('var(--grid-minor)', 1), minor, o.x - minor / 2, o.y - minor / 2);

  el.style.backgroundImage = images.join(', ');
  el.style.backgroundSize = sizes.join(', ');
  el.style.backgroundPosition = positions.join(', ');
}

/**
 * The whimsy level that draws crosses. Compared as a string because that is
 * what a data attribute holds, and `data-whimsy` is always written - see the
 * note on `apply()` in ui/appearance.js - so an absent attribute here means
 * the page has not booted yet, not "the middle".
 */
const HARSH = '2';

/**
 * Both marks are sized from --grid-dot, the user's grid-weight slider, and
 * both take a scale so the major lattice is the same mark drawn heavier rather
 * than a second shape with its own rules.
 */
const scaled = scale => `calc(var(--grid-dot) * ${scale})`;

const dot = (color, scale) => {
  const r = scaled(scale);
  return [`radial-gradient(circle at center, ${color} 0, ${color} ${r}, transparent calc(${r} + 0.7px))`];
};

// The cross, in multiples of --grid-dot: half an arm's length, and half its
// thickness.
//
// The length is capped, and the cap is the whole point. A dot's extent is
// --grid-dot itself, so at the weight slider's maximum of 4px it is 8px across
// and the lattice stays a lattice. A cross built by the same rule is not: it
// spans twice its half-length, so scaling the length with the slider made the
// mark 2.7x the dot's width at the same setting, and on the minor lattice's
// tightest tile - gridStep() will let it down to 26px - a mark that wide leaves
// a few pixels of gap and the whole board floods with the grid's own colour.
// Past a certain size a bigger mark is not a heavier grid, it is a fill.
//
// So thickness follows the slider and length stops. That is also the more
// honest reading of "grid weight": turning it up should press harder, not draw
// a bigger cross.
const ARM_LONG = 3;
const ARM_LONG_MAX = 6;   // px, before the lattice's own scale factor
const ARM_THICK = 0.5;

/**
 * The lattice at Harsh: a registration mark instead of a dot.
 *
 * Two gradients, because one cannot do it. A linear-gradient is bounded on one
 * axis only, so the obvious pair of them gives full-length ruled lines through
 * every tile - the very thing the note above rejects - and no amount of colour
 * stops will shorten them. Bounding an arm on both axes inside its tile takes a
 * radial-gradient with two radii, which is an ellipse: an arm with faintly
 * rounded ends, invisible at a few pixels across. So each cross is that ellipse
 * and its transpose.
 *
 * The two overlap in the middle, and since the grid colours are mixed down to a
 * fraction of the ink the crossing point lands at roughly double the arms'
 * strength. That is left alone rather than worked around: a drawn cross is
 * densest where the pen crossed its own line, and the alternative - splitting
 * each arm into two stubs that stop short of the centre - is six layers per
 * lattice to remove something that reads as correct.
 */
const cross = (color, scale) => {
  // The cap is scaled with the mark, so the major lattice stays proportionally
  // the heavier of the two right up to the limit instead of meeting the minor
  // one there and losing the distinction.
  const long = `min(${scaled(ARM_LONG * scale)}, ${(ARM_LONG_MAX * scale).toFixed(2)}px)`;
  const thick = scaled(ARM_THICK * scale);
  return [arm(color, long, thick), arm(color, thick, long)];
};

/**
 * One arm, `rx` by `ry` from the tile's centre.
 *
 * The soft edge is a percentage where the dot's is 0.7px, because an elliptical
 * gradient measures its colour stops along the horizontal radius alone: an
 * absolute stop would feather the flat arm generously along its length and
 * barely at all across its thickness, and would then swap those two the moment
 * the same call is used for the upright arm. A proportional one gives both arms
 * the identical shape, one rotated, and keeps the feather across the thickness
 * - the edge you actually read the weight from - a sane fraction of it instead
 * of wide enough to eat a 1.5px arm whole.
 *
 * It also stops at 100% rather than running past it. A last stop beyond the
 * gradient's own radius makes the mark bigger than the radii say it is, which
 * is a quiet way to lose track of how much room a lattice actually needs - and
 * it was a third of the reason the crosses could swallow the board. Contained
 * here, the radii mean what they look like they mean.
 */
const arm = (color, rx, ry) =>
  `radial-gradient(ellipse ${rx} ${ry} at center, ${color} 0, ${color} 78%, transparent 100%)`;
