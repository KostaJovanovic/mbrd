// Paper sheet overlay on the board. Lets the user set board scale by dragging
// corners until the sheet matches real life. Fixed at origin (no positioning
// ambiguity). Drawn in screen space so the border stays 1px at every zoom.

import { board, bus, setSetting } from '../state.ts';
import { paperMm, toUnits, formatSize, clampScale } from '../measure.ts';
import { deviceRatio } from './viewport.ts';
import type { Viewport } from './viewport.ts';

/** Max off-screen extent in CSS px. Prevents multi-million-pixel boxes at high zoom. */
const LIMIT = 1e5;

/** Below this on screen the sheet is a smudge, and its caption is noise. */
const MIN_CAPTION_PX = 120;

/** Below this the four grips overlap and become unusable. Sheet still drawn. */
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

/** A corner drag in flight: the scale and corner it started from - see onDown(). */
type PaperDrag = { scale: number; cx: number; cy: number; from: Point };

let vp: Viewport | null = null;
let node: HTMLElement | null = null;
let caption: HTMLElement | null = null;
let last = '';
/** The live corner drag, or null. See onDown() for what each field is for. */
let drag: PaperDrag | null = null;

export function initPaper(viewport: Viewport | null): void {
  vp = viewport;
  if (!vp || !build(vp.el)) return;
  // Draws on the viewport's own rAF — must stay in sync with the grid/axes.
  vp.onChange(draw);
  bus.on('settings', draw);
  bus.on('board:load', draw);
  draw();
}

/** Exported for main.ts's boot sequence, which paints once before the first frame. */
export const paintPaper = () => draw();

function draw() {
  // caption is built alongside node — both null or both present.
  if (!node || !caption || !vp) return;
  const s = board.settings;
  const mm = paperMm(s.paper, s.paperLandscape);

  if (!mm) {
    if (!node.hidden) { node.hidden = true; last = ''; }
    return;
  }

  // Sheet size in world units, then projected to screen by zoom.
  const w = toUnits(mm.w, s.scale) * vp.zoom;
  const h = toUnits(mm.h, s.scale) * vp.zoom;

  // Use axisOrigin() (not raw origin) so the sheet and the origin mark agree.
  const o = vp.axisOrigin ? vp.axisOrigin() : vp.toScreen(0, 0);
  const d = deviceRatio();
  // Snap both edges (not edge + width) so the box does not breathe by 1px during pan.
  const snap = (v: number) => Math.round(Math.min(Math.max(v, -LIMIT), LIMIT) * d) / d;
  const left = snap(o.x - w / 2);
  const top = snap(o.y - h / 2);
  const right = snap(o.x + w / 2);
  const bottom = snap(o.y + h / 2);

  // Skip style writes when nothing changed. Grips in the key so toggling them
  // takes effect even without a pan.
  const grips = !!s.paperResize && Math.min(w, h) >= MIN_GRIP_PX;
  const key = `${left}|${top}|${right}|${bottom}|${s.paper}|${s.units}|${grips}`;
  if (key === last) return;
  last = key;

  node.hidden = false;
  node.style.left = left + 'px';
  node.style.top = top + 'px';
  node.style.width = (right - left) + 'px';
  node.style.height = (bottom - top) + 'px';
  // One class toggles all four grips at once.
  node.classList.toggle('no-grips', !grips);

  // Sheet name + real-world size — legible feedback while dragging.
  caption.hidden = w < MIN_CAPTION_PX;
  if (!caption.hidden) {
    // scale 1: millimetres are already millimetres, just using formatSize for unit display.
    caption.textContent = `${mm.label} · ${formatSize(mm.w, mm.h, 1, s.units)}`;
  }
}

// ---------------------------------------------------------------------------
// Resizing the sheet, which is really setting the scale
// ---------------------------------------------------------------------------

/** Grab a corner. Freeze all drag state at grab time — recomputing per move
 * compounds rounding and causes the sheet to jump. */
function onDown(e: PointerEvent) {
  // Optional chaining covers harness dispatches on non-element targets.
  // SAFETY: the listener is on #paper, so a real press targets an element in it.
  const grip = (e.target as Element).closest?.<HTMLElement>('[data-grip]');
  // Check the setting, not just the CSS class — a look must not enable grips.
  if (!grip || e.button > 0 || !vp || !board.settings.paperResize) return;
  const spec = GRIPS.find(g => g.id === grip.dataset.grip);
  const mm = paperMm(board.settings.paper, board.settings.paperLandscape);
  if (!spec || !mm) return;

  const scale = clampScale(board.settings.scale);
  drag = {
    scale,
    // Corner world position and pointer at grab time.
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

  // Fixed aspect ratio — project wanted corner onto its diagonal.
  const denom = drag.cx * drag.cx + drag.cy * drag.cy;
  if (!(denom > 0)) return;
  let k = (wantX * drag.cx + wantY * drag.cy) / denom;
  // Clamp: dragging past centre would invert the sheet.
  k = Math.min(Math.max(k, 1e-4), 1e4);

  setSetting('scale', clampScale(drag.scale * k));
}

function onUp(e: PointerEvent) {
  if (!drag) return;
  drag = null;
  document.documentElement.classList.remove('is-sizing-paper');
  // Optional chaining covers non-element targets in test harnesses.
  // SAFETY: the listener is on #paper, so a real release targets an element in it.
  (e.target as Element).releasePointerCapture?.(e.pointerId);
}

// ---------------------------------------------------------------------------
// The layer
// ---------------------------------------------------------------------------

/** Build the sheet layer and four corner grips if not already present. Grips are
 * identical elements differing only by corner id. Fallback path creates them
 * when tests mount a bare #viewport. */
function build(host: HTMLElement | null): HTMLElement | null {
  if (!host) return null;
  node = host.querySelector<HTMLElement>(':scope > #paper');
  if (!node) {
    node = document.createElement('div');
    node.id = 'paper';
    node.setAttribute('aria-hidden', 'true');
    node.hidden = true;
    // After #grid-ink (over lattice), before everything else (under axes/items).
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
