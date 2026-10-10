// The pen's arithmetic: a drawing card's stored strokes, read and written,
// and the outline each whimsy tier draws them with. Pure - no DOM, no state -
// so tests/strokes.test.js runs it under node --test. The tier changes how a
// stroke is drawn, never what is stored (research/pen-2026-10-07.md).

import { isRecord } from '../util.ts';
import { MIN_SIZE } from '../geometry.ts';

/** What made a stroke. The eraser is a tool too, but it never leaves one. */
type StrokeTool ='pen' | 'highlighter';
export type PenTool = StrokeTool | 'eraser';

/** The five inks, stored by name so a drawing follows the board's palette. */
export const INKS = ['ink', 'accent', 'warm', 'leaf', 'danger'] as const;
export type Ink = typeof INKS[number];

/** The token each ink name draws with. */
export const INK_VAR: Record<Ink, string> = {
  ink: '--ink', accent: '--accent', warm: '--accent-warm', leaf: '--leafy', danger: '--danger',
};

/** One stroke as `meta.strokes` holds it. `pts` is encodePts()'s string. */
export type Stroke = { tool: StrokeTool, ink: Ink, width: number, pts: string };

/** A point in a card's own space (y down, as the SVG draws it), and its pressure. */
export type Pt = { x: number, y: number, p: number };

/** What the card keeps: its strokes and the size of the space they live in. */
export type Drawing = { strokes: Stroke[], space: [number, number] };

/** A whimsy tier: 0 Softish, 1 Middle, 2 Harsh. */
export type Tier = 0 | 1 | 2;

/** Plain caps on what the app writes - not consent ceilings, since nothing
 *  here reads a file somebody else wrote. Past MAX_POINTS a stroke is
 *  simplified harder; past MAX_STROKES the next stroke starts a new card. */
export const MAX_POINTS = 2000;
export const MAX_STROKES = 400;
/** A stroke this soon after the last, and near it, joins the same drawing. */
export const BURST_MS = 2000;
/** The least reach round a drawing, in world units, for the burst rule. */
export const REACH_MIN = 96;
/** The quarter-unit tolerance strokes are simplified at when they end. */
const SIMPLIFY =0.25;
/** A stored `pts` longer than this is cut, so a hand-edited file cannot make
 *  the decoder walk megabytes. Generous: 2000 points at ~20 characters each. */
const PTS_CHARS = 64_000;
const WIDTH_MIN = 0.5;
const WIDTH_MAX = 400;

/** One base-36 integer as encodePts() writes it, and short enough to stay exact. */
const B36 = /^-?[0-9a-z]{1,9}$/;

/** Whether a stored value is one of the five ink names. */
export const isInk = (v: unknown): v is Ink => INKS.some(i => i === v);

// ---------------------------------------------------------------------------
// Stored form
// ---------------------------------------------------------------------------

/**
 * Points as one string: `x,y,p` in base 36, a tenth of a unit for x and y and
 * a hundredth for pressure, separated by spaces. Compact, legible enough to see
 * it is a list of numbers, and no binary in board.json.
 */
export function encodePts(pts: readonly Pt[]): string {
  return pts.map(q =>
    `${Math.round(q.x * 10).toString(36)},${Math.round(q.y * 10).toString(36)},`
    + Math.round(clamp01(q.p) * 100).toString(36)).join(' ');
}

/** The other way. Anything unreadable is skipped rather than thrown on. */
export function decodePts(raw: unknown): Pt[] {
  if (typeof raw !== 'string' || !raw) return [];
  const out: Pt[] = [];
  for (const part of raw.slice(0, PTS_CHARS).split(' ')) {
    if (out.length >= MAX_POINTS) break;
    const [a, b, c] = part.split(',');
    // parseInt reads `undefined` as the word, which is a number in base 36.
    if (!B36.test(a ?? '') || !B36.test(b ?? '')) continue;
    const x = parseInt(a, 36) / 10;
    const y = parseInt(b, 36) / 10;
    const p = c !== undefined && B36.test(c) ? parseInt(c, 36) : 50;
    out.push({ x, y, p: clamp01(p / 100) });
  }
  return out;
}

/** A drawing card's meta, read as far as it can be: a bad stroke is dropped,
 *  a missing space is taken from the strokes themselves. */
export function readDrawing(meta: Record<string, unknown> | null | undefined): Drawing {
  const raw = Array.isArray(meta?.strokes) ? meta.strokes.slice(0, MAX_STROKES) : [];
  const strokes: Stroke[] = [];
  for (const r of raw) {
    if (!isRecord(r)) continue;
    if (typeof r.pts !== 'string' || !r.pts) continue;
    const width = Number(r.width);
    strokes.push({
      tool: r.tool === 'highlighter' ? 'highlighter' : 'pen',
      ink: isInk(r.ink) ? r.ink : 'ink',
      width: Number.isFinite(width) ? Math.min(WIDTH_MAX, Math.max(WIDTH_MIN, width)) : 3,
      pts: r.pts.slice(0, PTS_CHARS),
    });
  }
  const sp = Array.isArray(meta?.space) ? meta.space : [];
  const sw = Number(sp[0]), sh = Number(sp[1]);
  let space: [number, number];
  if (sw > 0 && sh > 0 && Number.isFinite(sw) && Number.isFinite(sh)) space = [sw, sh];
  else {
    const b = strokesBox(strokes);
    space = b ? [Math.max(1, b.x1), Math.max(1, b.y1)] : [1, 1];
  }
  return { strokes, space };
}

/** The box round some strokes, in their own space, widths included. */
function strokesBox(strokes: readonly Stroke[]) {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const s of strokes) {
    const r = s.width / 2;
    for (const q of decodePts(s.pts)) {
      x0 = Math.min(x0, q.x - r); y0 = Math.min(y0, q.y - r);
      x1 = Math.max(x1, q.x + r); y1 = Math.max(y1, q.y + r);
    }
  }
  return x0 <= x1 ? { x0, y0, x1, y1 } : null;
}

// ---------------------------------------------------------------------------
// Simplifying
// ---------------------------------------------------------------------------

/**
 * Ramer-Douglas-Peucker, with a stack rather than recursion so a long stroke
 * cannot run the call stack out. Keeps the ends and every point further than
 * `tolerance` from the chord it would otherwise be folded into.
 */
export function simplify(pts: readonly Pt[], tolerance = SIMPLIFY): Pt[] {
  if (pts.length < 3) return pts.slice();
  const keep = new Uint8Array(pts.length);
  keep[0] = keep[pts.length - 1] = 1;
  const stack: [number, number][] = [[0, pts.length - 1]];
  while (stack.length) {
    const [a, b] = stack.pop()!;
    let far = -1, worst = tolerance;
    for (let i = a + 1; i < b; i++) {
      const d = segDist(pts[i], pts[a], pts[b]);
      if (d > worst) { worst = d; far = i; }
    }
    if (far < 0) continue;
    keep[far] = 1;
    stack.push([a, far], [far, b]);
  }
  return pts.filter((_, i) => keep[i]);
}

/** Simplified at the quarter unit, and harder until it fits MAX_POINTS. */
export function settle(pts: readonly Pt[]): Pt[] {
  let tol = SIMPLIFY;
  let out = simplify(pts, tol);
  while (out.length > MAX_POINTS && tol < 1e6) {
    tol *= 2;
    out = simplify(pts, tol);
  }
  return out.length > MAX_POINTS ? out.slice(0, MAX_POINTS) : out;
}

// ---------------------------------------------------------------------------
// The card's frame: world <-> a drawing's own space
// ---------------------------------------------------------------------------

/** A drawing card's box (centre, world y up, degrees anticlockwise) and its space. */
export type Frame = { x: number, y: number, w: number, h: number, rot: number, space: [number, number] };

/** The scale from space to world. Uniform, and the space centred in the box,
 *  as the SVG's viewBox `meet` draws it - so a snapped or stretched card
 *  shows the sketch whole and never squashed. */
const scaleOf = (f: Frame) => Math.min(f.w / f.space[0], f.h / f.space[1]) || 1;

export function toLocal(f: Frame, p: { x: number, y: number }): { x: number, y: number } {
  const k = scaleOf(f);
  const rad = (f.rot || 0) * Math.PI / 180;
  const c = Math.cos(rad), s = Math.sin(rad);
  const dx = p.x - f.x, dy = p.y - f.y;
  const ox = c * dx + s * dy, oy = -s * dx + c * dy;
  return { x: ox / k + f.space[0] / 2, y: -oy / k + f.space[1] / 2 };
}

export function toWorldPt(f: Frame, l: { x: number, y: number }): { x: number, y: number } {
  const k = scaleOf(f);
  const rad = (f.rot || 0) * Math.PI / 180;
  const c = Math.cos(rad), s = Math.sin(rad);
  const ox = (l.x - f.space[0] / 2) * k, oy = -(l.y - f.space[1] / 2) * k;
  return { x: f.x + c * ox - s * oy, y: f.y + s * ox + c * oy };
}

/** World units per unit of a drawing's space. */
export const frameScale = scaleOf;

/** Room round a stroke so its width and its round ends stay inside the card. */
const padFor = (width: number) => width / 2 + 2;

/** A tenth, which is what the stored form keeps - so a shift does not drift. */
const tenth = (v: number) => Math.floor(v * 10) / 10;

/**
 * A new drawing round one stroke drawn in world units: the card's box and the
 * stroke in its space.
 */
export function newDrawing(world: readonly Pt[], width: number, tool: StrokeTool, ink: Ink) {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const q of world) {
    x0 = Math.min(x0, q.x); x1 = Math.max(x1, q.x);
    y0 = Math.min(y0, q.y); y1 = Math.max(y1, q.y);
  }
  // Room for the width, and at least the smallest card on each side - a box
  // any smaller is clamped up on its way in, and the sketch would be drawn
  // larger to fill it. The room is shared either side so the mark stays put.
  const padX = padFor(width) + Math.max(0, MIN_SIZE - (x1 - x0) - 2 * padFor(width)) / 2;
  const padY = padFor(width) + Math.max(0, MIN_SIZE - (y1 - y0) - 2 * padFor(width)) / 2;
  const left = tenth(x0 - padX), top = Math.ceil((y1 + padY) * 10) / 10;
  const sw = Math.max(MIN_SIZE, x1 + padX - left), sh = Math.max(MIN_SIZE, top - (y0 - padY));
  const local = settle(world.map(q => ({ x: q.x - left, y: top - q.y, p: q.p })));
  const drawing: Drawing = {
    strokes: [{ tool, ink, width: round2(width), pts: encodePts(local) }],
    space: [round2(sw), round2(sh)],
  };
  return { box: { x: left + sw / 2, y: top - sh / 2, w: sw, h: sh }, drawing };
}

/**
 * Several drawings as one: every stroke taken out to the world through its
 * own card's frame - turn and scale included - and laid into one space round
 * all of them, unturned. Pens over highlighters stay so, as each pass draws
 * in stored order. Past MAX_STROKES the rest are left out, which the caller
 * refuses before it comes to that.
 */
export function joinDrawings(parts: readonly { frame: Frame, drawing: Drawing }[]) {
  const world: { s: Stroke, pts: Pt[], width: number }[] = [];
  for (const { frame, drawing } of parts) {
    const k = scaleOf(frame);
    for (const s of drawing.strokes) {
      const pts = decodePts(s.pts).map(q => ({ ...toWorldPt(frame, q), p: q.p }));
      if (pts.length) world.push({ s, pts, width: s.width * k });
    }
  }
  if (!world.length) return null;
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const { pts, width } of world) {
    const r = padFor(width);
    for (const q of pts) {
      x0 = Math.min(x0, q.x - r); x1 = Math.max(x1, q.x + r);
      y0 = Math.min(y0, q.y - r); y1 = Math.max(y1, q.y + r);
    }
  }
  const left = tenth(x0), top = Math.ceil(y1 * 10) / 10;
  const sw = Math.max(MIN_SIZE, x1 - left), sh = Math.max(MIN_SIZE, top - y0);
  const strokes: Stroke[] = world.slice(0, MAX_STROKES).map(({ s, pts, width }) => ({
    tool: s.tool, ink: s.ink, width: round2(width),
    pts: encodePts(settle(pts.map(q => ({ x: q.x - left, y: top - q.y, p: q.p })))),
  }));
  return {
    box: { x: left + sw / 2, y: top - sh / 2, w: sw, h: sh },
    drawing: { strokes, space: [round2(sw), round2(sh)] } satisfies Drawing,
  };
}

/**
 * One stroke drawn in world units, added to a drawing that already exists.
 * The space grows to take it - every stroke already there shifts by the same
 * amount - and the card's box grows round the same sketch, so nothing on the
 * card moves on screen. Rotation and scale are kept.
 */
export function addStroke(f: Frame, d: Drawing, world: readonly Pt[], width: number, tool: StrokeTool, ink: Ink) {
  const k = scaleOf(f);
  const w = width / k;
  const local = world.map(q => ({ ...toLocal(f, q), p: q.p }));
  const pad = padFor(w);
  let lx0 = 0, ly0 = 0, lx1 = d.space[0], ly1 = d.space[1];
  for (const q of local) {
    lx0 = Math.min(lx0, q.x - pad); ly0 = Math.min(ly0, q.y - pad);
    lx1 = Math.max(lx1, q.x + pad); ly1 = Math.max(ly1, q.y + pad);
  }
  const sx = -tenth(lx0), sy = -tenth(ly0);
  const strokes = sx || sy ? d.strokes.map(s => shiftStroke(s, sx, sy)) : d.strokes.slice();
  strokes.push({
    tool, ink, width: round2(w),
    pts: encodePts(settle(local.map(q => ({ x: q.x + sx, y: q.y + sy, p: q.p })))),
  });
  const space: [number, number] = [round2(lx1 + sx), round2(ly1 + sy)];
  // The centre of the grown space, measured in the old one - whose origin now
  // sits at (sx, sy) - and where that is in the world.
  const mid = toWorldPt(f, { x: space[0] / 2 - sx, y: space[1] / 2 - sy });
  return {
    box: { x: mid.x, y: mid.y, w: space[0] * k, h: space[1] * k },
    drawing: { strokes, space },
  };
}

function shiftStroke(s: Stroke, dx: number, dy: number): Stroke {
  return { ...s, pts: encodePts(decodePts(s.pts).map(q => ({ x: q.x + dx, y: q.y + dy, p: q.p }))) };
}

// ---------------------------------------------------------------------------
// The burst rule
// ---------------------------------------------------------------------------

/** The drawing a burst is adding to: its id, its world box and when the last
 *  stroke on it ended. */
export type Burst = { id: string, at: number, box: { x0: number, y0: number, x1: number, y1: number } };

/**
 * Whether a stroke starting at `at`, at time `now`, joins the drawing being
 * made. Both halves: within BURST_MS of the last stroke's end, and within the
 * drawing's box grown by a quarter of its longer side - never less than
 * REACH_MIN. A pause, or a mark well away from the sketch, starts a new card.
 */
export function joinsDrawing(last: Burst | null, at: { x: number, y: number }, now: number): boolean {
  if (!last) return false;
  const gap = now - last.at;
  if (!(gap >= 0 && gap <= BURST_MS)) return false;
  const b = last.box;
  const reach = Math.max(REACH_MIN, Math.max(b.x1 - b.x0, b.y1 - b.y0) / 4);
  return at.x >= b.x0 - reach && at.x <= b.x1 + reach && at.y >= b.y0 - reach && at.y <= b.y1 + reach;
}

// ---------------------------------------------------------------------------
// The eraser
// ---------------------------------------------------------------------------

/** Whether an eraser circle at `p` (radius `r`, the stroke's space) touches a stroke. */
export function touches(s: Stroke, p: { x: number, y: number }, r: number): boolean {
  const pts = decodePts(s.pts);
  const reach = s.width / 2 + r;
  if (pts.length === 1) return Math.hypot(pts[0].x - p.x, pts[0].y - p.y) <= reach;
  for (let i = 1; i < pts.length; i++) {
    if (segDist(p, pts[i - 1], pts[i]) <= reach) return true;
  }
  return false;
}

// ---------------------------------------------------------------------------
// Outline
// ---------------------------------------------------------------------------

/**
 * How one stroke is drawn: a filled outline, or a centre line stroked at a
 * width. The two plain tiers draw a line of one width, which a stroked path
 * says exactly; Softish and Middle vary the width, which only an outline can.
 */
export type Outline =
  | { kind: 'fill', d: string }
  | { kind: 'line', d: string, width: number, cap: 'round' | 'square' | 'butt', join: 'round' | 'miter' };

/** Pressure to a width factor. A mouse reports 0.5 while pressed, which is 1. */
const pressureScale = (p: number) => Math.min(1.65, Math.max(0.3, 0.35 + 1.3 * p));

export function outline(s: Stroke, tier: Tier): Outline {
  const pts = decodePts(s.pts);
  return outlinePts(pts, s.width, s.tool, tier);
}

export function outlinePts(pts: readonly Pt[], width: number, tool: StrokeTool, tier: Tier): Outline {
  if (!pts.length) return { kind: 'fill', d: '' };
  if (tool === 'highlighter') {
    const line = tier === 0 ? wobble(steady(pts, width), width * 0.06, seedOf(pts)) : steady(pts, width);
    return {
      kind: 'line', d: polyline(line), width,
      cap: tier === 2 ? 'butt' : 'round', join: tier === 2 ? 'miter' : 'round',
    };
  }
  if (tier === 2) return { kind: 'line', d: polyline(steady(pts, width)), width, cap: 'square', join: 'miter' };
  // Softish works along the line, so it wants points along it: a straight run
  // is stored as its two ends, and tapered as two ends it would be a hairline.
  const line = tier === 0 ? wobble(densify(pts, Math.max(2, width)), width * 0.12, seedOf(pts)) : pts;
  const radii = line.map(q => (width / 2) * pressureScale(q.p));
  if (tier === 0) taper(line, radii, width);
  return { kind: 'fill', d: ribbon(line, radii) };
}

/**
 * A drawing as an SVG document of its own, for a file that leaves the app (a
 * JSON Canvas export). The inks are the page's tokens, so the caller says what
 * each one is; a file elsewhere has no palette to follow.
 */
export function drawingSvg(d: Drawing, tier: Tier, colour: (ink: Ink) => string): string {
  const esc = (s: string) => s.replace(/[&<>"]/g, c => `&#${c.charCodeAt(0)};`);
  const paths: string[] = [];
  for (const pass of ['highlighter', 'pen'] as const) {
    for (const s of d.strokes) {
      if (s.tool !== pass) continue;
      const o = outline(s, tier);
      if (!o.d) continue;
      const ink = esc(colour(s.ink));
      const alpha = pass === 'highlighter' ? ' opacity="0.4"' : '';
      paths.push(o.kind === 'fill'
        ? `<path d="${o.d}" fill="${ink}"${alpha}/>`
        : `<path d="${o.d}" fill="none" stroke="${ink}" stroke-width="${o.width}"`
          + ` stroke-linecap="${o.cap}" stroke-linejoin="${o.join}"${alpha}/>`);
    }
  }
  const [w, h] = d.space;
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${w} ${h}" width="${w}" height="${h}">\n`
    + paths.join('\n') + '\n</svg>\n';
}

/** A centre line: M, then L to every point. One point is a dot. */
function polyline(pts: readonly Pt[]): string {
  if (pts.length === 1) return `M${n(pts[0].x)} ${n(pts[0].y)}h0.01`;
  return 'M' + pts.map(q => `${n(q.x)} ${n(q.y)}`).join('L');
}

/** Ends that thin over three widths, as a nib lifting does. Not speed: the
 *  stored points carry no time, and once simplified their spacing says how
 *  straight the line was rather than how fast. */
function taper(pts: readonly Pt[], radii: number[], width: number) {
  const span = width * 3;
  const along: number[] = [0];
  for (let i = 1; i < pts.length; i++) {
    along.push(along[i - 1] + Math.hypot(pts[i].x - pts[i - 1].x, pts[i].y - pts[i - 1].y));
  }
  const total = along[along.length - 1];
  for (let i = 0; i < pts.length; i++) {
    const end = Math.min(along[i], total - along[i]);
    const t = span > 0 ? Math.min(1, end / span) : 1;
    radii[i] *= 0.3 + 0.7 * t;
  }
}

/** Points put back along every segment longer than `step`, pressure carried
 *  across, so a line simplified to its corners can be shaped along its length.
 *  Capped, so a long line at a fine width is a bounded number of points. */
function densify(pts: readonly Pt[], step: number): Pt[] {
  if (pts.length < 2) return pts.slice();
  let total = 0;
  for (let i = 1; i < pts.length; i++) total += Math.hypot(pts[i].x - pts[i - 1].x, pts[i].y - pts[i - 1].y);
  const s = Math.max(step, total / (MAX_POINTS * 2));
  const out: Pt[] = [pts[0]];
  for (let i = 1; i < pts.length; i++) {
    const a = pts[i - 1], b = pts[i];
    const n = Math.floor(Math.hypot(b.x - a.x, b.y - a.y) / s);
    for (let k = 1; k < n; k++) {
      const t = k / n;
      out.push({ x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t, p: a.p + (b.p - a.p) * t });
    }
    out.push(b);
  }
  return out;
}

/**
 * The pointer's staircase taken out of a line drawn as straight segments.
 * A mouse reports whole pixels, so a slow diagonal arrives as a run of one-
 * pixel steps, which the simplifier keeps (each is further than its tolerance
 * from the chord) and a stroked polyline then draws as a stair - plainly at
 * Harsh, and on a highlighter, whose width shows every corner. Done at draw
 * time, so drawings made before are mended too: resampled along the line,
 * averaged three times with its neighbours, simplified again. The ends lean
 * on their one neighbour, or the last step of the stair stays as a hook.
 */
function steady(pts: readonly Pt[], width: number): Pt[] {
  return smoothed(pts, Math.max(0.75, width * 0.35), 0.05);
}

/**
 * The same staircase, taken out as a stroke is stored, at the size of the
 * pixel it was drawn with. Zoomed out, one screen pixel is many board units,
 * so the mouse's steps are as large on the board as the zoom is far, and
 * steady() - which works at the stroke's width - leaves them in.
 * `pixel` is a screen pixel in board units at the press.
 */
export function unstep(pts: readonly Pt[], pixel: number): Pt[] {
  return smoothed(pts, Math.max(0.75, pixel * 1.4), Math.max(0.05, pixel * 0.05));
}

/** Resampled every `step`, averaged three times with its neighbours,
 *  simplified again to `tolerance`. */
function smoothed(pts: readonly Pt[], step: number, tolerance: number): Pt[] {
  if (pts.length < 3) return pts.slice();
  let line = densify(pts, step);
  for (let pass = 0; pass < 3; pass++) {
    line = line.map((q, i) => {
      const a = line[Math.max(0, i - 1)], b = line[Math.min(line.length - 1, i + 1)];
      return { x: (a.x + 2 * q.x + b.x) / 4, y: (a.y + 2 * q.y + b.y) / 4, p: q.p };
    });
  }
  return simplify(line, tolerance);
}

/** The outline of a line whose half-width at each point is `radii[i]`, with
 *  round ends. The two sides are smoothed through their midpoints. */
function ribbon(pts: readonly Pt[], radii: readonly number[]): string {
  if (pts.length === 1) {
    const r = Math.max(0.2, radii[0]);
    const { x, y } = pts[0];
    return `M${n(x - r)} ${n(y)}a${n(r)} ${n(r)} 0 1 0 ${n(2 * r)} 0a${n(r)} ${n(r)} 0 1 0 ${n(-2 * r)} 0Z`;
  }
  const left: { x: number, y: number }[] = [];
  const right: { x: number, y: number }[] = [];
  for (let i = 0; i < pts.length; i++) {
    const a = pts[Math.max(0, i - 1)], b = pts[Math.min(pts.length - 1, i + 1)];
    let tx = b.x - a.x, ty = b.y - a.y;
    const len = Math.hypot(tx, ty) || 1;
    tx /= len; ty /= len;
    const r = radii[i];
    left.push({ x: pts[i].x - ty * r, y: pts[i].y + tx * r });
    right.push({ x: pts[i].x + ty * r, y: pts[i].y - tx * r });
  }
  const last = pts.length - 1;
  const rEnd = n(Math.max(0.2, radii[last])), rStart = n(Math.max(0.2, radii[0]));
  return `M${smooth(left)}`
    + `A${rEnd} ${rEnd} 0 0 0 ${n(right[last].x)} ${n(right[last].y)}`
    + `L${smooth(right.slice().reverse())}`
    + `A${rStart} ${rStart} 0 0 0 ${n(left[0].x)} ${n(left[0].y)}Z`;
}

/** A run of points as a smooth curve, starting at the first and ending at the
 *  last: a quadratic through every midpoint. Leaves off the leading command. */
function smooth(ps: readonly { x: number, y: number }[]): string {
  let d = `${n(ps[0].x)} ${n(ps[0].y)}`;
  for (let i = 1; i < ps.length - 1; i++) {
    const mx = (ps[i].x + ps[i + 1].x) / 2, my = (ps[i].y + ps[i + 1].y) / 2;
    d += `Q${n(ps[i].x)} ${n(ps[i].y)} ${n(mx)} ${n(my)}`;
  }
  const end = ps[ps.length - 1];
  return `${d}L${n(end.x)} ${n(end.y)}`;
}

/** The hand's unsteadiness, seeded by the stroke's own points so the same
 *  stroke wobbles the same way on every redraw rather than shimmering. Low
 *  frequency: each offset leans on the one before. */
function wobble(pts: readonly Pt[], amp: number, seed: number): Pt[] {
  if (pts.length < 3 || amp <= 0) return pts.slice();
  const rnd = mulberry(seed);
  let off = 0;
  return pts.map((q, i) => {
    if (i === 0 || i === pts.length - 1) return q;
    off = off * 0.6 + (rnd() - 0.5) * amp;
    const a = pts[i - 1], b = pts[i + 1];
    const len = Math.hypot(b.x - a.x, b.y - a.y) || 1;
    return { x: q.x - ((b.y - a.y) / len) * off, y: q.y + ((b.x - a.x) / len) * off, p: q.p };
  });
}

function seedOf(pts: readonly Pt[]): number {
  let h = pts.length | 0;
  for (let i = 0; i < Math.min(pts.length, 8); i++) {
    h = Math.imul(h ^ Math.round(pts[i].x * 10), 2654435761) ^ Math.round(pts[i].y * 10);
  }
  return h >>> 0;
}

function mulberry(a: number) {
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// ---------------------------------------------------------------------------

function segDist(p: { x: number, y: number }, a: { x: number, y: number }, b: { x: number, y: number }): number {
  const dx = b.x - a.x, dy = b.y - a.y;
  const len = dx * dx + dy * dy;
  const t = len ? Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / len)) : 0;
  return Math.hypot(p.x - (a.x + t * dx), p.y - (a.y + t * dy));
}

function clamp01(v: number) { return Number.isFinite(v) ? Math.min(1, Math.max(0, v)) : 0.5; }
function round2(v: number) { return Math.round(v * 100) / 100; }
/** Two decimals, and no trailing zeros, for path data. */
function n(v: number) { return String(Math.round(v * 100) / 100); }
