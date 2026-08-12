// A sheet of paper, outlined on the board - and the way the board gets measured.
//
// The measurement feature answers "how big is this" for one item at a time and
// "how big is all of it" with the scale bar. Neither answers the question a
// layout is actually for: does this fit on a page. So the board can be given a
// sheet - A4, A3, Letter - drawn at the size that sheet really is, through the
// board's scale.
//
// And then the sheet is draggable by its corners, which is the whole point.
// `settings.scale` is world units per millimetre: a number with no intuition
// attached, which changes by a factor of ten if you misjudge it. Every way of
// setting it by typing is a way of setting it wrong. Dragging an A4 until it
// looks right against the photographs already on the board is the same fact
// stated in the only language this question is ever really asked in - a sheet
// of paper is a thing everybody has held, so "that big" is an answer people
// have, where "0.37 units per millimetre" is not.
//
// Centred on the origin, and not movable. There is exactly one obvious place
// for a page on a board that already has a marked centre, and a sheet you can
// put anywhere is a sheet you then have to line things up against twice - once
// against the page and once against the grid. Fixing it to 0,0 makes the origin
// mark the page's centre mark for free, and it makes the corner drag a pure
// scale about a known point rather than a resize with an anchor to choose.
//
// Drawn in screen space, on #viewport rather than inside #world, for the reason
// the axes and the grid are: a border inside the transformed layer is scaled by
// the zoom, so the page edge would be a hairline at 20% and a four-pixel slab
// at 400%. Here it is one device pixel at every zoom, which is what a drawn
// edge should be.

import { board, bus, setSetting } from '../state.ts';
import { paperMm, toUnits, formatSize, clampScale } from '../measure.ts';
import { deviceRatio } from './viewport.ts';

/**
 * How far off screen an edge is allowed to be placed, in CSS pixels.
 *
 * Zoomed right in on a board measured in metres, an A0's far edge can be some
 * millions of pixels away, and handing a browser a box that size is asking it
 * to think about a region nothing can ever see. Anything past this is off the
 * window by a factor of twenty on any display, so clamping to it moves no
 * visible ink - only the border on the clamped side, which was never on screen.
 */
const LIMIT = 1e5;

/** Below this on screen the sheet is a smudge, and its caption is noise. */
const MIN_CAPTION_PX = 120;

/**
 * And below this the four grips overlap into one blob, which is a control that
 * cannot be aimed at. The sheet is still drawn - it is legible as a rectangle
 * long before it is grabbable - so this only takes the handles away.
 */
const MIN_GRIP_PX = 44;

/** The four corners, in world signs. +y is up, so north is positive. */
const GRIPS = [
  { id: 'nw', sx: -1, sy: 1 },
  { id: 'ne', sx: 1, sy: 1 },
  { id: 'sw', sx: -1, sy: -1 },
  { id: 'se', sx: 1, sy: -1 },
];

/** A world or screen point, which here are the same two numbers. */
type Point = { x: number; y: number };

/**
 * What this module asks of the viewport, and no more. Structural rather than
 * the `Viewport` class itself, because canvas/viewport.ts is still on the
 * migration ledger and a .ts class publishes no fields it does not declare.
 * `axisOrigin` is optional for the same reason the call site tests it: the
 * render harnesses mount a viewport that does not draw axes.
 */
type PaperViewport = {
  el: HTMLElement | null;
  zoom: number;
  onChange(fn: () => void): unknown;
  toScreen(wx: number, wy: number): Point;
  toWorld(sx: number, sy: number): Point;
  axisOrigin?: () => Point;
};

/** A corner drag in flight: the scale and corner it started from - see onDown(). */
type PaperDrag = { scale: number; cx: number; cy: number; from: Point };

let vp: PaperViewport | null = null;
let node: HTMLElement | null = null;
let caption: HTMLElement | null = null;
let last = '';
/** The live corner drag, or null. See onDown() for what each field is for. */
let drag: PaperDrag | null = null;

export function initPaper(viewport: PaperViewport | null): void {
  vp = viewport;
  if (!vp || !build(vp.el)) return;
  // Straight onto the viewport's change event rather than through a throttle of
  // its own: that event is already emitted from inside the viewport's own rAF,
  // so this paints on the same frame the grid and the axes do. A sheet arriving
  // a frame behind the lattice it is drawn over would visibly swim during a pan.
  vp.onChange(draw);
  bus.on('settings', draw);
  bus.on('board:load', draw);
  draw();
}

/** Exported for main.js's boot sequence, which paints once before the first frame. */
export const paintPaper = () => draw();

function draw() {
  // `caption` is built with `node` and never without it, so the extra test
  // costs a comparison and rules out nothing that can happen.
  if (!node || !caption || !vp) return;
  const s = board.settings;
  const mm = paperMm(s.paper, s.paperLandscape);

  if (!mm) {
    if (!node.hidden) { node.hidden = true; last = ''; }
    return;
  }

  // The sheet's size in world units, which is the only place the scale enters:
  // everything below is the same arithmetic the axes do.
  const w = toUnits(mm.w, s.scale) * vp.zoom;
  const h = toUnits(mm.h, s.scale) * vp.zoom;

  // The origin as the chrome draws it, not the raw one - see axisOrigin(). The
  // page is centred on 0,0 and the origin mark stands there, so the two have to
  // agree to the pixel or the mark sits visibly off the middle of the page.
  const o = vp.axisOrigin ? vp.axisOrigin() : vp.toScreen(0, 0);
  const d = deviceRatio();
  // Both edges snapped rather than one edge and a width, so the box cannot
  // breathe by a pixel as it is panned: rounding a position and a length
  // independently lets the far edge land on either side of the same device row
  // depending on where the near one fell.
  const snap = (v: number) => Math.round(Math.min(Math.max(v, -LIMIT), LIMIT) * d) / d;
  const left = snap(o.x - w / 2);
  const top = snap(o.y - h / 2);
  const right = snap(o.x + w / 2);
  const bottom = snap(o.y + h / 2);

  // Same trade the grid makes: this runs on every frame of every pan, and a
  // style write the browser has to parse and compare is not free. During a pan
  // the size never changes and during a zoom the position rarely repeats, so
  // the key covers both and skips whichever half held still.
  // The grips are off by default and are a setting of their own, so they join
  // the key rather than being toggled outside it - otherwise turning them on
  // while the board sat still would change nothing until the next pan.
  const grips = !!s.paperResize && Math.min(w, h) >= MIN_GRIP_PX;
  const key = `${left}|${top}|${right}|${bottom}|${s.paper}|${s.units}|${grips}`;
  if (key === last) return;
  last = key;

  node.hidden = false;
  node.style.left = left + 'px';
  node.style.top = top + 'px';
  node.style.width = (right - left) + 'px';
  node.style.height = (bottom - top) + 'px';
  // A class rather than four `hidden` writes, so the whole set of handles goes
  // with one attribute and the stylesheet decides what an absent grip looks
  // like. Two reasons it can be absent - not asked for, or a sheet too small on
  // screen for four separate targets - and one class, because the difference
  // does not matter to anything downstream.
  node.classList.toggle('no-grips', !grips);

  // The label is the honest part of the whole feature: it says which sheet this
  // is *and* how big that sheet is, so a drag that has gone somewhere silly is
  // legible as a number and not only as a shape.
  caption.hidden = w < MIN_CAPTION_PX;
  if (!caption.hidden) {
    // scale 1 because these millimetres are already millimetres - formatSize is
    // being used for its unit-picking and its shared-unit collapse, not for a
    // conversion there is nothing to convert.
    caption.textContent = `${mm.label} · ${formatSize(mm.w, mm.h, 1, s.units)}`;
  }
}

// ---------------------------------------------------------------------------
// Resizing the sheet, which is really setting the scale
// ---------------------------------------------------------------------------

/**
 * Grab a corner.
 *
 * Everything the drag needs is frozen here rather than recomputed from the
 * live sheet on each move, and that is what keeps the corner under the finger.
 * Reading the current scale every move compounds its own rounding, and worse,
 * a corner grabbed a few pixels off its true position would snap to the pointer
 * on the first move - the sheet would jump before it grew.
 */
function onDown(e: PointerEvent) {
  // The listener is on #paper, so the target is an element of it; the optional
  // call is kept because a harness can dispatch at something plainer.
  const grip = (e.target as Element).closest?.<HTMLElement>('[data-grip]');
  // The setting as well as the class, because a hidden grip is a stylesheet's
  // opinion and this is the board's. The two only disagree if a look ever
  // overrode the display, which is exactly the kind of thing a look should not
  // be able to turn into a live control.
  if (!grip || e.button > 0 || !vp || !board.settings.paperResize) return;
  const spec = GRIPS.find(g => g.id === grip.dataset.grip);
  const mm = paperMm(board.settings.paper, board.settings.paperLandscape);
  if (!spec || !mm) return;

  const scale = clampScale(board.settings.scale);
  drag = {
    scale,
    // The corner's world position at the moment it was grabbed, and where the
    // pointer was. Only the difference between the two ever matters.
    cx: spec.sx * toUnits(mm.w, scale) / 2,
    cy: spec.sy * toUnits(mm.h, scale) / 2,
    from: vp.toWorld(e.clientX, e.clientY),
  };
  grip.setPointerCapture(e.pointerId);
  // The board's own pan handler is on the viewport and would otherwise start a
  // pan under the drag.
  e.stopPropagation();
  e.preventDefault();
  document.documentElement.classList.add('is-sizing-paper');
}

function onMove(e: PointerEvent) {
  if (!drag || !vp) return;
  const p = vp.toWorld(e.clientX, e.clientY);
  // Where the corner would be if it had simply followed the pointer.
  const wantX = drag.cx + (p.x - drag.from.x);
  const wantY = drag.cy + (p.y - drag.from.y);

  // A sheet has a fixed aspect ratio - A4 turned is A5's shape doubled, not a
  // rectangle you get to choose - so the corner cannot go wherever the pointer
  // went. It goes to the nearest point on the diagonal it lives on, which is
  // the projection of the wanted corner onto the original one. That is also the
  // gesture that feels right: sliding along the diagonal resizes, and sliding
  // across it does nothing rather than fighting you.
  const denom = drag.cx * drag.cx + drag.cy * drag.cy;
  if (!(denom > 0)) return;
  let k = (wantX * drag.cx + wantY * drag.cy) / denom;
  // Dragged past the centre and out the other side, which as a scale means zero
  // or negative - a sheet with no size, or one inside out. The gesture stops at
  // the middle instead, and the clamp below catches the far end.
  k = Math.min(Math.max(k, 1e-4), 1e4);

  setSetting('scale', clampScale(drag.scale * k));
}

function onUp(e: PointerEvent) {
  if (!drag) return;
  drag = null;
  document.documentElement.classList.remove('is-sizing-paper');
  (e.target as Element).releasePointerCapture?.(e.pointerId);
}

// ---------------------------------------------------------------------------
// The layer
// ---------------------------------------------------------------------------

/**
 * The sheet layer and its four handles, made if they are not there.
 *
 * index.html carries the outline as one of the viewport's permanent layers, in
 * front of the grid and behind the axes - a page sits on the desk, under the
 * rules drawn across it. The grips are built here rather than written out four
 * times in the markup, since they are the same element with a different corner.
 * The whole fallback path is for the tests and the render harnesses, which
 * mount a bare #viewport.
 */
function build(host: HTMLElement | null): HTMLElement | null {
  if (!host) return null;
  node = host.querySelector<HTMLElement>(':scope > #paper');
  if (!node) {
    node = document.createElement('div');
    node.id = 'paper';
    node.setAttribute('aria-hidden', 'true');
    node.hidden = true;
    // After the grid canvas, so the page is drawn over the lattice rather than
    // under it; before everything else, so the axes and every item stay on top.
    const grid = host.querySelector(':scope > #grid-ink');
    grid ? grid.after(node) : host.prepend(node);
  }
  caption = node.querySelector<HTMLElement>('#paper-label');
  if (!caption) {
    caption = document.createElement('span');
    caption.id = 'paper-label';
    node.append(caption);
  }
  for (const g of GRIPS) {
    if (node.querySelector(`[data-grip="${g.id}"]`)) continue;
    const grip = document.createElement('i');
    grip.className = 'paper-grip';
    grip.dataset.grip = g.id;
    node.append(grip);
  }
  node.addEventListener('pointerdown', onDown);
  node.addEventListener('pointermove', onMove);
  node.addEventListener('pointerup', onUp);
  node.addEventListener('pointercancel', onUp);
  last = '';
  return node;
}
