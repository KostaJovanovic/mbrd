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
  const harsh = document.documentElement.dataset.whimsy === HARSH;
  // The dot keeps its colour as `var(--grid-minor)` and never resolves it: a
  // gradient carrying a custom property restyles itself the instant the
  // strength slider moves, with no repaint at all. The cross cannot - its
  // colour goes inside a data URI, where var() means nothing - so it pays for
  // one resolved read, cached, and ui/appearance.js hands it back on change.
  const ink = harsh ? gridInk() : null;
  const mark = (which, scale, tile) => harsh
    ? cross(ink[which], ink.dot, scale, tile)
    : dot(`var(--grid-${which})`, scale);

  const images = [], sizes = [], positions = [];
  // A mark is a list of image layers rather than one, because the dot's major
  // and minor lattices each want their own. Every layer of a mark shares its
  // lattice's tile and origin, so they are pushed together.
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
  push(mark('major', 1.5, major), major, o.x - major / 2, o.y - major / 2);
  push(mark('minor', 1, minor), minor, o.x - minor / 2, o.y - minor / 2);

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
 * The lattice at Harsh: a registration mark instead of a dot. A real one.
 *
 * This was two elliptical gradients, an arm and its transpose, because a
 * gradient is the only thing that tiles for free and no gradient can bound a
 * rectangle on both axes - a linear one is bounded on one axis only and gives
 * ruled lines through every tile, and a radial one with two radii is an
 * ellipse. Which is what it looked like: an ellipse 10px long and 1.7px thick
 * keeps barely 40% of its thickness at 90% of its length, so both arms tapered
 * to points and the mark read as a smudge with a bright middle rather than as
 * a cross. Six pixels of it were doing the work of one dot.
 *
 * So the cross is drawn instead of approximated - one SVG polygon, twelve
 * corners, square ends, uniform density. The old pair also overlapped at the
 * centre and doubled their alpha there; a single polygon has no seam to double.
 *
 * The cost, stated plainly because it is a real one: the mark is a data URI
 * that bakes in the tile size, so it is rebuilt whenever the tile changes -
 * which is every frame of a zoom, though not of a pan, where only the position
 * moves. Memoised below to keep that to one small string per lattice, and paid
 * only by the tier that asked for crosses: every other tier is still two
 * gradients that never touch this path.
 */
function cross(color, dotPx, scale, tile) {
  // The cap is scaled with the mark, so the major lattice stays proportionally
  // the heavier of the two right up to the limit instead of meeting the minor
  // one there and losing the distinction.
  const long = Math.min(dotPx * ARM_LONG * scale, ARM_LONG_MAX * scale);
  const thick = Math.max(dotPx * ARM_THICK * scale, MIN_ARM);
  return [plusURL(tile, color, long, thick)];
}

/**
 * Half-thickness an arm may not go under, in px.
 *
 * An arm thinner than a device pixel is not a fainter cross, it is a cross with
 * gaps in it: the rasteriser drops parts of the stroke and the mark comes apart
 * into dashes. The strength slider is the control for "fainter".
 */
const MIN_ARM = 0.4;

/**
 * The twelve corners of a plus, centred in a `tile`-square SVG.
 *
 * Written as one polygon rather than two rectangles so the arms cannot double
 * their alpha where they meet - the grid colours are already mixed down to a
 * fraction of the ink, and a crossing point at twice the strength of its own
 * arms is what made the old mark read as a dot with whiskers.
 */
function plus(tile, long, thick) {
  const c = tile / 2;
  const n = v => v.toFixed(2);
  const pts = [
    [-thick, -long], [thick, -long], [thick, -thick], [long, -thick],
    [long, thick], [thick, thick], [thick, long], [-thick, long],
    [-thick, thick], [-long, thick], [-long, -thick], [-thick, -thick],
  ];
  return pts.map(([x, y]) => `${n(c + x)},${n(c + y)}`).join(' ');
}

/**
 * One tiled cross, as a background-image.
 *
 * The SVG's own width is the tile rounded to a tenth of a pixel while
 * background-size stays exact, so the lattice spacing is unchanged and only the
 * mark inside it is scaled by up to a twentieth of a pixel. That rounding is
 * what makes the cache worth having: a zoom sweeps the tile through a
 * continuous range, and to a tenth of a pixel it revisits the same values.
 */
const plusCache = new Map();
const PLUS_CACHE_MAX = 128;

function plusURL(tile, color, long, thick) {
  const t = Math.max(1, Math.round(tile * 10) / 10);
  const key = `${t}|${color}|${long.toFixed(2)}|${thick.toFixed(2)}`;
  const hit = plusCache.get(key);
  if (hit) return hit;
  const svg =
    `<svg xmlns="http://www.w3.org/2000/svg" width="${t}" height="${t}">` +
    `<polygon points="${plus(t, long, thick)}" fill="${color}"/></svg>`;
  // encodeURIComponent rather than a hand-rolled escape: a resolved colour
  // arrives as rgba(...) or color(srgb ... / ...), and `#` alone would end the
  // URI at a fragment.
  const url = `url("data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}")`;
  // A plain cap, not an LRU. The keys that matter are the ones a zoom is
  // sweeping through right now, and dropping the whole map costs one rebuild
  // per lattice on the next frame.
  if (plusCache.size >= PLUS_CACHE_MAX) plusCache.clear();
  plusCache.set(key, url);
  return url;
}

/**
 * The grid's resolved colours and dot size.
 *
 * getComputedStyle is exactly what the note in paintGrid() forbids per frame,
 * so this is read once and held. resetGridInk() below is how it is given back,
 * and ui/appearance.js calls it on every change to a look - which includes each
 * drag of the strength and weight sliders, since a cross cannot follow those on
 * its own the way a gradient carrying var() can.
 */
let ink = null;

function gridInk() {
  if (ink) return ink;
  const s = getComputedStyle(document.documentElement);
  const dot = parseFloat(s.getPropertyValue('--grid-dot'));
  ink = {
    major: s.getPropertyValue('--grid-major').trim() || 'currentColor',
    minor: s.getPropertyValue('--grid-minor').trim() || 'currentColor',
    dot: Number.isFinite(dot) ? dot : 1.5,
  };
  return ink;
}

/** Forget the resolved colours - the look changed. */
export function resetGridInk() {
  ink = null;
  plusCache.clear();
}
