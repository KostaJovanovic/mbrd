// The pen's doing: drawing mode and its tool, ink and size; the stroke being
// drawn, as one SVG path over the viewport; and where a finished stroke lands -
// a drawing already there, or a new card - and drawings combined into one card
// afterwards. canvas/input.ts owns the gesture and
// calls in, so there is still one pointer pipeline. strokes.ts is the arithmetic.

import { addItems, board, byId, isLocked, removeItems, replaceItems, setDrawings } from '../state.ts';
import type { Item } from '../board-model.ts';
import { readPref, writePref } from '../prefs.ts';
import { rotatedExtents } from '../geometry.ts';
import type { Viewport } from './viewport.ts';
import {
  isInk, MAX_STROKES, addStroke, frameScale, joinDrawings, joinsDrawing, newDrawing, outlinePts, readDrawing,
  toLocal, touches, type Burst, type Frame, type Ink, type PenTool, type Pt,
} from './strokes.ts';
import { currentTier } from './drawing.ts';

/** The three sizes of each tool, in screen pixels: a stroke is as wide on the
 *  screen as the size says whatever the zoom, and stored at that width in the
 *  world. */
export const SIZES: Record<PenTool, readonly [number, number, number]> = {
  pen: [2, 4, 8],
  highlighter: [12, 22, 36],
  eraser: [10, 20, 40],
};

export type PenState = { on: boolean, tool: PenTool, ink: Ink, size: 0 | 1 | 2 };

const KEY = 'mbrd.pen';

/** The tool, ink and size are the device's, kept across boards and visits;
 *  whether the mode is on is never kept. */
function loadState(): PenState {
  const raw = readPref(KEY, '') ?? '';
  const [tool, ink, size] = raw.split(',');
  return {
    on: false,
    tool: tool === 'highlighter' || tool === 'eraser' ? tool : 'pen',
    ink: isInk(ink) ? ink : 'ink',
    size: size === '0' ? 0 : size === '2' ? 2 : 1,
  };
}

let state: PenState | null = null;
const watchers = new Set<(s: PenState) => void>();

export function penState(): PenState {
  state ??= loadState();
  return state;
}

/** Whether drawing mode is on - what input.ts asks of every press. */
export const penOn = () => !!state?.on;

/** Change any of the four, tell the toolbar, and keep the three that are kept. */
export function setPen(patch: Partial<PenState>) {
  const s = { ...penState(), ...patch };
  state = s;
  writePref(KEY, `${s.tool},${s.ink},${s.size}`);
  if (vp) vp.el.classList.toggle('is-drawing', s.on);
  if (!s.on) { dropStroke(); burst = null; }
  for (const fn of watchers) fn(s);
}

/** Hear every change, for the toolbar's button and the pen bar. */
export function onPen(fn: (s: PenState) => void): () => void {
  watchers.add(fn);
  return () => watchers.delete(fn);
}

// ---------------------------------------------------------------------------
// The stroke being drawn
// ---------------------------------------------------------------------------

const NS = 'http://www.w3.org/2000/svg';

let vp: Viewport | null = null;
let layer: SVGSVGElement | null = null;

/** Give the pen its viewport and the layer the live stroke is drawn in. */
export function initPen(viewport: Viewport) {
  vp = viewport;
  layer = document.createElementNS(NS, 'svg');
  layer.setAttribute('class', 'pen-live');
  layer.setAttribute('aria-hidden', 'true');
  viewport.el.append(layer);
  // The stroke is held in the world and drawn in the window, so a view that
  // moves under it (a pinch is refused, but a wheel is not) redraws it.
  viewport.onChange(() => { if (live) drawLive(); });
}

type Live = {
  tool: PenTool,
  ink: Ink,
  /** World units: the size on screen over the zoom at the press. */
  width: number,
  pts: Pt[],
  /** When the press came, for the burst rule. */
  at: number,
  /** The drawing card under the press, which a stroke starting on it joins. */
  on: string | null,
  path: SVGPathElement | null,
  /** The eraser's catch so far: drawing id to the strokes it has passed over. */
  erased: Map<string, Set<number>>,
};

let live: Live | null = null;
/** The drawing the last strokes went to, while a burst is still going. */
let burst: Burst | null = null;

/** Whether a stroke is being drawn - input.ts's palm rejection asks. */
export const stroking = () => !!live;

/** A press in drawing mode: start a stroke at a world point. */
export function beginStroke(at: { x: number, y: number }, pressure: number, onCard: string | null, now: number) {
  if (!vp || !layer) return;
  const s = penState();
  const card = onCard ? byId(onCard) : null;
  live = {
    tool: s.tool, ink: s.ink,
    width: SIZES[s.tool][s.size] / vp.zoom,
    pts: [{ x: at.x, y: at.y, p: pressure }],
    at: now,
    on: card?.type === 'drawing' && !isLocked(card) ? card.id : null,
    path: null,
    erased: new Map(),
  };
  if (s.tool === 'eraser') erase(at, at);
  else {
    live.path = document.createElementNS(NS, 'path');
    live.path.dataset.ink = s.ink;
    if (s.tool === 'highlighter') live.path.setAttribute('class', 'stroke-hl');
    layer.append(live.path);
    drawLive();
  }
}

/** The pointer moved with the stroke down. */
export function extendStroke(at: { x: number, y: number }, pressure: number) {
  if (!live) return;
  const last = live.pts[live.pts.length - 1];
  // Under a tenth of a unit is the same point once stored.
  if (Math.abs(at.x - last.x) < 0.1 && Math.abs(at.y - last.y) < 0.1) return;
  live.pts.push({ x: at.x, y: at.y, p: pressure });
  if (live.tool === 'eraser') erase(last, at);
  else drawLive();
}

/** The stroke drawn in the window: the world points to screen ones, outlined
 *  as the tier would draw them at the width the screen shows. */
function drawLive() {
  if (!live?.path || !vp || live.tool === 'eraser') return;
  const v = vp;
  // toScreen() answers in the viewport element's own pixels, which is where
  // the layer sits.
  const screen = live.pts.map(q => ({ ...v.toScreen(q.x, q.y), p: q.p }));
  const o = outlinePts(screen, live.width * v.zoom, live.tool, currentTier());
  const path = live.path;
  path.setAttribute('d', o.d);
  if (o.kind === 'line') {
    path.setAttribute('fill', 'none');
    path.setAttribute('stroke', 'currentColor');
    path.setAttribute('stroke-width', String(o.width));
    path.setAttribute('stroke-linecap', o.cap);
    path.setAttribute('stroke-linejoin', o.join);
  } else {
    path.setAttribute('fill', 'currentColor');
    path.removeAttribute('stroke');
  }
}

/** The pointer lifted: the stroke lands. */
export function endStroke(now: number) {
  const done = live;
  dropStroke();
  if (!done) return;
  if (done.tool === 'eraser') { finishErase(done.erased); return; }
  const tool = done.tool;
  // A stroke that starts on a drawing joins it; otherwise one in a burst joins
  // the drawing the burst is making; otherwise it is a new card.
  const target = [done.on, joinsDrawing(burst, done.pts[0], done.at) ? burst?.id : null]
    .map(id => (id ? byId(id) : null))
    .find((it): it is Item => !!it && it.type === 'drawing' && !isLocked(it)
      && readDrawing(it.meta).strokes.length < MAX_STROKES);
  let id: string;
  if (target) {
    const d = readDrawing(target.meta);
    const f: Frame = { x: target.x, y: target.y, w: target.w, h: target.h, rot: target.rot, space: d.space };
    const next = addStroke(f, d, done.pts, done.width, tool, done.ink);
    setDrawings([{
      id: target.id,
      next: { ...next.box, meta: { ...target.meta, strokes: next.drawing.strokes, space: next.drawing.space } },
    }], 'Draw');
    id = target.id;
  } else {
    const made = newDrawing(done.pts, done.width, tool, done.ink);
    const [item] = addItems([{
      type: 'drawing', name: '', rot: 0, ...made.box,
      meta: { strokes: made.drawing.strokes, space: made.drawing.space },
    }], 'Draw');
    if (!item) return;
    id = item.id;
  }
  const it = byId(id);
  if (!it) return;
  const { hw, hh } = rotatedExtents(it);
  burst = { id, at: now, box: { x0: it.x - hw, y0: it.y - hh, x1: it.x + hw, y1: it.y + hh } };
}

/** Which of these are drawings that may be combined: unanchored ones. */
export const combinable = (ids: Iterable<string>) => [...ids]
  .map(id => byId(id))
  .filter((it): it is Item => !!it && it.type === 'drawing' && !isLocked(it));

/**
 * Two or more drawings as one card, one undo step: every stroke where it was
 * on screen, the turn of each card taken into its strokes. Null when there are
 * fewer than two, or the strokes together pass MAX_STROKES.
 */
export function combineDrawings(ids: Iterable<string>): Item | null {
  const cards = combinable(ids);
  if (cards.length < 2) return null;
  const parts = cards.map(it => {
    const drawing = readDrawing(it.meta);
    const frame: Frame = { x: it.x, y: it.y, w: it.w, h: it.h, rot: it.rot, space: drawing.space };
    return { frame, drawing };
  });
  if (parts.reduce((n, p) => n + p.drawing.strokes.length, 0) > MAX_STROKES) return null;
  const joined = joinDrawings(parts);
  if (!joined) return null;
  burst = null;
  return replaceItems(cards.map(c => c.id), {
    type: 'drawing', name: '', rot: 0, ...joined.box,
    meta: { strokes: joined.drawing.strokes, space: joined.drawing.space },
  }, 'Combine drawings');
}

/** Let the stroke go without landing it: a second finger, Escape, the mode off. */
export function dropStroke() {
  if (!live) return;
  live.path?.remove();
  for (const el of document.querySelectorAll('.drawing-art .is-erasing')) el.classList.remove('is-erasing');
  live = null;
}

// ---------------------------------------------------------------------------
// The eraser
// ---------------------------------------------------------------------------

/** Every stroke the eraser's path from `a` to `b` passes over, marked. Walked
 *  in steps of half the eraser so a quick swipe does not jump a stroke. */
function erase(a: { x: number, y: number }, b: { x: number, y: number }) {
  if (!live) return;
  const r = live.width / 2;
  const steps = Math.max(1, Math.ceil(Math.hypot(b.x - a.x, b.y - a.y) / Math.max(r, 0.5)));
  for (const it of board.items) {
    if (it.type !== 'drawing' || isLocked(it)) continue;
    const { hw, hh } = rotatedExtents(it);
    const x0 = Math.min(a.x, b.x) - r, x1 = Math.max(a.x, b.x) + r;
    const y0 = Math.min(a.y, b.y) - r, y1 = Math.max(a.y, b.y) + r;
    if (x1 < it.x - hw || x0 > it.x + hw || y1 < it.y - hh || y0 > it.y + hh) continue;
    const d = readDrawing(it.meta);
    const f: Frame = { x: it.x, y: it.y, w: it.w, h: it.h, rot: it.rot, space: d.space };
    const k = frameScale(f);
    const caught = live.erased.get(it.id) ?? new Set<number>();
    for (let i = 0; i <= steps; i++) {
      const t = i / steps;
      const p = toLocal(f, { x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t });
      d.strokes.forEach((s, n) => {
        if (!caught.has(n) && touches(s, p, r / k)) caught.add(n);
      });
    }
    if (!caught.size) continue;
    live.erased.set(it.id, caught);
    const node = document.querySelector(`.item[data-id="${CSS.escape(it.id)}"] .drawing-art`);
    for (const n of caught) node?.querySelector(`[data-index="${n}"]`)?.classList.add('is-erasing');
  }
}

/** The eraser lifted: the strokes it passed over go, in one step, and a
 *  drawing left with none goes to the bin in the step after. */
function finishErase(erased: Map<string, Set<number>>) {
  const changes = [];
  const emptied: string[] = [];
  for (const [id, gone] of erased) {
    const it = byId(id);
    if (!it) continue;
    const strokes = readDrawing(it.meta).strokes.filter((_, i) => !gone.has(i));
    if (!strokes.length) { emptied.push(id); continue; }
    changes.push({ id, next: { x: it.x, y: it.y, w: it.w, h: it.h, meta: { ...it.meta, strokes } } });
  }
  if (changes.length) setDrawings(changes, 'Erase');
  if (emptied.length) removeItems(emptied, 'Erase');
}
