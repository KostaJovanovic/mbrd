// Tessellator for boundary-representation CAD (STEP, IGES).
// Converts trimmed analytic/NURBS surfaces into triangles by:
// sample boundary → project to (u,v) → unwrap seams → ear-clip → subdivide sag.
// Not a kernel: no booleans, no healing, no exact intersection.

// ---------------------------------------------------------------------------
// Vectors
// ---------------------------------------------------------------------------

export type Vec = number[];

export const sub = (a: Vec, b: Vec): Vec => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
export const add = (a: Vec, b: Vec): Vec => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
export const scale = (a: Vec, k: number): Vec => [a[0] * k, a[1] * k, a[2] * k];
export const dot = (a: Vec, b: Vec) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
export const cross = (a: Vec, b: Vec): Vec => [
  a[1] * b[2] - a[2] * b[1],
  a[2] * b[0] - a[0] * b[2],
  a[0] * b[1] - a[1] * b[0],
];
export const length = (a: Vec) => Math.hypot(a[0], a[1], a[2]);
export function unit(a: Vec): Vec {
  const len = length(a);
  return len ? [a[0] / len, a[1] / len, a[2] / len] : [0, 0, 1];
}

// Right-handed frame, always re-orthogonalised from the file's directions.
export type Frame = { o: Vec; x: Vec; y: Vec; z: Vec };

export function frame(origin: Vec, axis: Vec | null, ref: Vec | null): Frame {
  const z = unit(axis || [0, 0, 1]);
  let x = ref ? sub(ref, scale(z, dot(ref, z))) : [0, 0, 0];
  if (length(x) < 1e-12) {
    // No usable reference — pick the axis furthest from z.
    const alt: Vec = Math.abs(z[0]) < 0.9 ? [1, 0, 0] : [0, 1, 0];
    x = sub(alt, scale(z, dot(alt, z)));
  }
  x = unit(x);
  return { o: origin, x, y: cross(z, x), z };
}

const local = (f: Frame, p: Vec): Vec => {
  const d = sub(p, f.o);
  return [dot(d, f.x), dot(d, f.y), dot(d, f.z)];
};

const world = (f: Frame, x: number, y: number, z: number): Vec => [
  f.o[0] + f.x[0] * x + f.y[0] * y + f.z[0] * z,
  f.o[1] + f.x[1] * x + f.y[1] * y + f.z[1] * z,
  f.o[2] + f.x[2] * x + f.y[2] * y + f.z[2] * z,
];

// ---------------------------------------------------------------------------
// Curves
// ---------------------------------------------------------------------------

// A curve with sampling and inverse. Both formats give edges as curve + endpoints,
// so param(p) (the inverse) is required for trimming.
export type Curve = {
  at(t: number): Vec;
  param(p: Vec): number;
  /** 2*pi for a closed curve, 0 otherwise. */
  period: number;
  /** How many segments a span of this length wants. One for a line. */
  segments(t0: number, t1: number): number;
};

export function lineCurve(origin: Vec, direction: Vec): Curve {
  const d = direction;
  const dd = dot(d, d) || 1;
  return {
    at: t => add(origin, scale(d, t)),
    param: p => dot(sub(p, origin), d) / dd,
    period: 0,
    segments: () => 1,
  };
}

// Segments per full turn — chord error invisible at card size.
const FULL_TURN = 48;

export function circleCurve(f: Frame, radius: number): Curve {
  return {
    at: t => world(f, radius * Math.cos(t), radius * Math.sin(t), 0),
    param: p => {
      const l = local(f, p);
      return Math.atan2(l[1], l[0]);
    },
    period: Math.PI * 2,
    segments: (t0, t1) => arcSegments(t1 - t0),
  };
}

export function ellipseCurve(f: Frame, a: number, b: number): Curve {
  return {
    at: t => world(f, a * Math.cos(t), b * Math.sin(t), 0),
    param: p => {
      const l = local(f, p);
      // Parameter angle, not geometric — undo semi-axes before atan2.
      return Math.atan2(l[1] / (b || 1), l[0] / (a || 1));
    },
    period: Math.PI * 2,
    segments: (t0, t1) => arcSegments(t1 - t0),
  };
}

const arcSegments = (span: number) =>
  Math.max(1, Math.min(FULL_TURN, Math.ceil(Math.abs(span) / (Math.PI * 2) * FULL_TURN)));

// Polyline fallback — composite/trimmed curves reduce to this. Parameter = index.
export function polylineCurve(points: Vec[]): Curve {
  return {
    at: t => {
      if (points.length < 2) return points[0] || [0, 0, 0];
      const clamped = Math.max(0, Math.min(points.length - 1, t));
      const i = Math.min(points.length - 2, Math.floor(clamped));
      const f = clamped - i;
      return add(scale(points[i], 1 - f), scale(points[i + 1], f));
    },
    param: p => {
      let best = 0, bestD = Infinity;
      for (let i = 0; i < points.length; i++) {
        const d = length(sub(points[i], p));
        if (d < bestD) { bestD = d; best = i; }
      }
      return best;
    },
    period: 0,
    segments: (t0, t1) => Math.max(1, Math.min(256, Math.ceil(Math.abs(t1 - t0)))),
  };
}

// ---------------------------------------------------------------------------
// B-splines
// ---------------------------------------------------------------------------

export type Spline = {
  degree: number;
  knots: number[];
  ctrl: Vec[];
  weights: number[] | null;
};

/** The highest B-spline degree a file may declare. CAD kernels stop at 25; an
 *  evaluation costs the degree squared, and a knot vector is sized by it, so a
 *  degree past this is a corrupt record and never a large model. */
export const MAX_DEGREE = 32;

/** Whether a declared degree can be evaluated. The readers throw MeshError on
 *  false, never Oversize: no file needs more. */
export const saneDegree = (d: number) => Number.isSafeInteger(d) && d >= 0 && d <= MAX_DEGREE;

/** The most points one composite curve is sampled into. Every segment is
 *  already capped at 256, so a curve of a few hundred segments is untouched;
 *  past that each segment gets a smaller share instead of the total growing
 *  with the segment count. */
export const MAX_CURVE_POINTS = 16_384;

/** Samples per segment for a composite of `count` segments. */
export const compositeShare = (count: number) => Math.max(1, Math.floor(MAX_CURVE_POINTS / Math.max(1, count)));

export function expandKnots(knots: number[], mults: number[]) {
  const out: number[] = [];
  for (let i = 0; i < knots.length; i++) {
    const m = Math.max(0, Math.min(64, Math.round(mults[i] ?? 1)));
    for (let k = 0; k < m; k++) out.push(knots[i]);
  }
  return out;
}

function span(s: Spline, t: number) {
  const n = s.ctrl.length - 1;
  const lo = s.knots[s.degree];
  const hi = s.knots[n + 1];
  if (!(t > lo)) return s.degree;
  if (!(t < hi)) return n;
  let low = s.degree, high = n + 1, mid = (low + high) >> 1;
  while (t < s.knots[mid] || t >= s.knots[mid + 1]) {
    if (t < s.knots[mid]) high = mid; else low = mid;
    mid = (low + high) >> 1;
    if (mid <= s.degree) return s.degree;
    if (mid >= n) return n;
  }
  return mid;
}

// de Boor in homogeneous coords (handles rational case).
export function splineAt(s: Spline, t: number): Vec {
  const p = s.degree;
  const k = span(s, t);
  const work: number[][] = [];
  for (let j = 0; j <= p; j++) {
    const i = k - p + j;
    const c = s.ctrl[i] || [0, 0, 0];
    const w = s.weights ? (s.weights[i] ?? 1) : 1;
    work.push([c[0] * w, c[1] * w, c[2] * w, w]);
  }
  for (let r = 1; r <= p; r++) {
    for (let j = p; j >= r; j--) {
      const i = k - p + j;
      const denom = s.knots[i + p - r + 1] - s.knots[i];
      const a = denom ? (t - s.knots[i]) / denom : 0;
      for (let c = 0; c < 4; c++) work[j][c] = (1 - a) * work[j - 1][c] + a * work[j][c];
    }
  }
  const w = work[p][3] || 1;
  return [work[p][0] / w, work[p][1] / w, work[p][2] / w];
}

export const splineDomain = (s: Spline): [number, number] =>
  [s.knots[s.degree], s.knots[s.ctrl.length]];

// Spline curve. Inverse by coarse sample + bisection (Newton unstable near inflections).
export function splineCurve(s: Spline): Curve {
  const [lo, hi] = splineDomain(s);
  const coarse = Math.max(16, Math.min(512, s.ctrl.length * 6));
  return {
    at: t => splineAt(s, Math.max(lo, Math.min(hi, t))),
    param: p => {
      let best = lo, bestD = Infinity;
      for (let i = 0; i <= coarse; i++) {
        const t = lo + (hi - lo) * i / coarse;
        const d = length(sub(splineAt(s, t), p));
        if (d < bestD) { bestD = d; best = t; }
      }
      let step = (hi - lo) / coarse;
      for (let k = 0; k < 20 && step > 0; k++) {
        step /= 2;
        for (const t of [best - step, best + step]) {
          if (t < lo || t > hi) continue;
          const d = length(sub(splineAt(s, t), p));
          if (d < bestD) { bestD = d; best = t; }
        }
      }
      return best;
    },
    period: 0,
    segments: (t0, t1) => {
      const frac = hi > lo ? Math.abs(t1 - t0) / (hi - lo) : 1;
      return Math.max(1, Math.min(256, Math.ceil(frac * Math.max(2, s.ctrl.length * 3))));
    },
  };
}

// ---------------------------------------------------------------------------
// Surfaces
// ---------------------------------------------------------------------------

// A surface: at(u,v)→3D, uv(p)→params (null if search fails), normalAt.
export type Surface = {
  at(u: number, v: number): Vec;
  uv(p: Vec): number[] | null;
  normalAt(u: number, v: number): Vec;
  /** The period of each parameter, or 0 where it does not wrap. */
  periodU: number;
  periodV: number;
  /** Whether the surface is flat, in which case step 5 has nothing to do. */
  flat: boolean;
};

export function planeSurface(f: Frame): Surface {
  const n = f.z;
  return {
    at: (u, v) => world(f, u, v, 0),
    uv: p => { const l = local(f, p); return [l[0], l[1]]; },
    normalAt: () => n,
    periodU: 0, periodV: 0, flat: true,
  };
}

export function cylinderSurface(f: Frame, radius: number): Surface {
  return {
    at: (u, v) => world(f, radius * Math.cos(u), radius * Math.sin(u), v),
    uv: p => { const l = local(f, p); return [Math.atan2(l[1], l[0]), l[2]]; },
    normalAt: u => unit(add(scale(f.x, Math.cos(u)), scale(f.y, Math.sin(u)))),
    periodU: Math.PI * 2, periodV: 0, flat: false,
  };
}

export function coneSurface(f: Frame, radius: number, halfAngle: number): Surface {
  const tan = Math.tan(halfAngle);
  return {
    at: (u, v) => {
      const r = radius + v * tan;
      return world(f, r * Math.cos(u), r * Math.sin(u), v);
    },
    uv: p => { const l = local(f, p); return [Math.atan2(l[1], l[0]), l[2]]; },
    normalAt: u => {
      const radial = add(scale(f.x, Math.cos(u)), scale(f.y, Math.sin(u)));
      return unit(sub(radial, scale(f.z, tan)));
    },
    periodU: Math.PI * 2, periodV: 0, flat: false,
  };
}

export function sphereSurface(f: Frame, radius: number): Surface {
  return {
    at: (u, v) => {
      const c = Math.cos(v);
      return world(f, radius * c * Math.cos(u), radius * c * Math.sin(u), radius * Math.sin(v));
    },
    uv: p => {
      const l = local(f, p);
      const r = Math.hypot(l[0], l[1], l[2]) || radius || 1;
      return [Math.atan2(l[1], l[0]), Math.asin(Math.max(-1, Math.min(1, l[2] / r)))];
    },
    normalAt: (u, v) => {
      const c = Math.cos(v);
      return unit([
        f.x[0] * c * Math.cos(u) + f.y[0] * c * Math.sin(u) + f.z[0] * Math.sin(v),
        f.x[1] * c * Math.cos(u) + f.y[1] * c * Math.sin(u) + f.z[1] * Math.sin(v),
        f.x[2] * c * Math.cos(u) + f.y[2] * c * Math.sin(u) + f.z[2] * Math.sin(v),
      ]);
    },
    periodU: Math.PI * 2, periodV: 0, flat: false,
  };
}

export function torusSurface(f: Frame, major: number, minor: number): Surface {
  return {
    at: (u, v) => {
      const r = major + minor * Math.cos(v);
      return world(f, r * Math.cos(u), r * Math.sin(u), minor * Math.sin(v));
    },
    uv: p => {
      const l = local(f, p);
      const u = Math.atan2(l[1], l[0]);
      const inPlane = Math.hypot(l[0], l[1]) - major;
      return [u, Math.atan2(l[2], inPlane)];
    },
    normalAt: (u, v) => {
      const radial = add(scale(f.x, Math.cos(u)), scale(f.y, Math.sin(u)));
      return unit(add(scale(radial, Math.cos(v)), scale(f.z, Math.sin(v))));
    },
    periodU: Math.PI * 2, periodV: Math.PI * 2, flat: false,
  };
}

export function extrusionSurface(curve: Curve, direction: Vec, domain: [number, number]): Surface {
  const d = unit(direction);
  return {
    at: (u, v) => add(curve.at(u), scale(d, v)),
    uv: p => {
      const v = dot(sub(p, curve.at(domain[0])), d);
      // Undo the sweep before projecting onto the curve.
      return [curve.param(sub(p, scale(d, v))), v];
    },
    normalAt: u => {
      const e = (domain[1] - domain[0]) / 512 || 1e-4;
      const tangent = sub(curve.at(u + e), curve.at(u - e));
      return unit(cross(tangent, d));
    },
    periodU: curve.period, periodV: 0, flat: false,
  };
}

export function revolutionSurface(curve: Curve, f: Frame, domain: [number, number]): Surface {
  const spin = (p: Vec, a: number): Vec => {
    const l = local(f, p);
    const r = Math.hypot(l[0], l[1]);
    const base = Math.atan2(l[1], l[0]);
    return world(f, r * Math.cos(base + a), r * Math.sin(base + a), l[2]);
  };
  return {
    at: (u, v) => spin(curve.at(u), v),
    uv: p => {
      const l = local(f, p);
      const a = Math.atan2(l[1], l[0]);
      const back = world(f, Math.hypot(l[0], l[1]), 0, l[2]);
      const zero = local(f, curve.at(domain[0]));
      return [curve.param(back), a - Math.atan2(zero[1], zero[0])];
    },
    normalAt: (u, v) => {
      const e = (domain[1] - domain[0]) / 512 || 1e-4;
      const p = spin(curve.at(u), v);
      const tangent = sub(spin(curve.at(u + e), v), spin(curve.at(u - e), v));
      const around = cross(f.z, sub(p, f.o));
      return unit(cross(tangent, around));
    },
    periodU: curve.period, periodV: Math.PI * 2, flat: false,
  };
}

export type SplineSurface = {
  uDegree: number; vDegree: number;
  uKnots: number[]; vKnots: number[];
  ctrl: Vec[];
  weights: number[] | null;
  uCount: number; vCount: number;
};

export function splineSurface(s: SplineSurface): Surface {
  const uLo = s.uKnots[s.uDegree], uHi = s.uKnots[s.uCount];
  const vLo = s.vKnots[s.vDegree], vHi = s.vKnots[s.vCount];

  // de Boor down each row at v, then across at u.
  const at = (u: number, v: number): Vec => {
    const uu = Math.max(uLo, Math.min(uHi, u));
    const vv = Math.max(vLo, Math.min(vHi, v));
    const rows: Vec[] = [];
    const rowW: number[] = [];
    for (let i = 0; i < s.uCount; i++) {
      const ctrl: Vec[] = [];
      const weights: number[] = [];
      for (let j = 0; j < s.vCount; j++) {
        ctrl.push(s.ctrl[i * s.vCount + j] || [0, 0, 0]);
        weights.push(s.weights ? (s.weights[i * s.vCount + j] ?? 1) : 1);
      }
      const line: Spline = { degree: s.vDegree, knots: s.vKnots, ctrl, weights: s.weights ? weights : null };
      rows.push(splineAt(line, vv));
      rowW.push(s.weights ? splineAt({ degree: s.vDegree, knots: s.vKnots, ctrl: weights.map(w => [w, 0, 0]), weights: null }, vv)[0] : 1);
    }
    const outer: Spline = {
      degree: s.uDegree, knots: s.uKnots,
      ctrl: rows, weights: s.weights ? rowW : null,
    };
    return splineAt(outer, uu);
  };

  const normalAt = (u: number, v: number): Vec => {
    const eu = (uHi - uLo) / 1024 || 1e-5;
    const ev = (vHi - vLo) / 1024 || 1e-5;
    const du = sub(at(Math.min(uHi, u + eu), v), at(Math.max(uLo, u - eu), v));
    const dv = sub(at(u, Math.min(vHi, v + ev)), at(u, Math.max(vLo, v - ev)));
    return unit(cross(du, dv));
  };

  // Inversion: nearest on a coarse grid, then bisection refinement.
  const GRID = 20;

  // Coarse grid evaluated once per patch — at() is expensive on NURBS.
  let coarse: Vec[] | null = null;
  const grid = () => {
    if (coarse) return coarse;
    const g: Vec[] = [];
    for (let i = 0; i <= GRID; i++) {
      for (let j = 0; j <= GRID; j++) {
        g.push(at(uLo + (uHi - uLo) * i / GRID, vLo + (vHi - vLo) * j / GRID));
      }
    }
    coarse = g;
    return g;
  };

  const uv = (p: Vec): number[] | null => {
    const g = grid();
    let bu = uLo, bv = vLo, best = Infinity;
    for (let i = 0; i <= GRID; i++) {
      const u = uLo + (uHi - uLo) * i / GRID;
      for (let j = 0; j <= GRID; j++) {
        const v = vLo + (vHi - vLo) * j / GRID;
        const d = length(sub(g[i * (GRID + 1) + j], p));
        if (d < best) { best = d; bu = u; bv = v; }
      }
    }
    let su = (uHi - uLo) / GRID, sv = (vHi - vLo) / GRID;
    for (let k = 0; k < 24; k++) {
      su /= 2; sv /= 2;
      let moved = false;
      for (const [du, dv] of [[su, 0], [-su, 0], [0, sv], [0, -sv], [su, sv], [-su, -sv], [su, -sv], [-su, sv]]) {
        const u = Math.max(uLo, Math.min(uHi, bu + du));
        const v = Math.max(vLo, Math.min(vHi, bv + dv));
        const d = length(sub(at(u, v), p));
        if (d < best) { best = d; bu = u; bv = v; moved = true; }
      }
      if (!moved && k > 8) break;
    }
    return [bu, bv];
  };

  return { at, uv, normalAt, periodU: 0, periodV: 0, flat: false };
}

// ---------------------------------------------------------------------------
// Faces
// ---------------------------------------------------------------------------

export type Loop = { points: Vec[]; outer: boolean };

export type Facet = { p: Vec[]; n: Vec[] };

// Max sag as fraction of model size — sub-pixel at card scale.
const SAG = 1 / 400;

const MAX_SPLIT = 8;

const MAX_PER_FACE = 4_000;

// Below this, the loop is a degenerate seam (fully closed surface).
const DEGENERATE = 1e-9;

/** The most boundary points one face is triangulated from, holes included.
 *  Ear clipping costs about the square of this, and a face stops at
 *  MAX_PER_FACE triangles, so a longer boundary never drew whole anyway. */
export const MAX_LOOP_POINTS = 4_096;

/** Loops with more points than a face can use, sampled evenly down to the
 *  limit. Outer loops are placed first so a face never loses its outline to
 *  its holes; a hole that no longer fits is left out. */
export function thin(loops: Loop[]): Loop[] {
  let total = 0;
  for (const l of loops) total += l.points.length;
  if (total <= MAX_LOOP_POINTS) return loops;
  const out: Loop[] = [];
  let left = MAX_LOOP_POINTS;
  for (const l of [...loops.filter(l => l.outer), ...loops.filter(l => !l.outer)]) {
    const len = l.points.length;
    const keep = Math.min(len, Math.max(3, Math.floor(len * MAX_LOOP_POINTS / total)));
    if (keep > left) continue;
    left -= keep;
    const points: Vec[] = [];
    for (let k = 0; k < keep; k++) points.push(l.points[Math.floor(k * len / keep)]);
    out.push({ points, outer: l.outer });
  }
  return out;
}

// Triangulate one trimmed face. scaleHint converts relative sag to absolute.
export function faceFacets(surface: Surface, given: Loop[], scaleHint: number): Facet[] {
  const loops = thin(given);
  const outer = loops.find(l => l.outer) || loops[0];
  if (!outer || outer.points.length < 3) return [];

  // Project and unwrap. Unprojectable loops fall back to flat triangulation.
  const rings: Ring[] = [];
  let outerRing: Ring | null = null;
  for (const loop of loops) {
    const ring = project(surface, loop);
    if (!ring) return flatFacets(loops);
    rings.push(ring);
    if (loop.outer && !outerRing) outerRing = ring;
  }
  if (!outerRing) outerRing = rings[0];
  if (!outerRing) return [];
  const holes = rings.filter(r => r !== outerRing);
  align(outerRing, holes, surface);

  // Make parameters isometric — a cylinder is (radians, mm) and needs equalizing.
  const scale = metric(surface, outerRing);
  for (const ring of rings) {
    for (const p of ring.uv) { p[0] *= scale[0]; p[1] *= scale[1]; }
  }

  // Degenerate boundary → seam on a closed surface. Draw as a grid band.
  if (Math.abs(area2(outerRing.uv)) < DEGENERATE * boxArea(outerRing.uv)) {
    return bandFacets(surface, outerRing, scale);
  }

  const polygon = bridge(outerRing, holes);
  const tris = earClip(polygon.uv);
  if (!tris.length) return flatFacets(loops);
  flipToDelaunay(tris, polygon.uv, boundaryEdges(polygon.uv.length));

  const out: Facet[] = [];
  const tolerance = Math.max(1e-9, scaleHint * SAG);
  for (const [a, b, c] of tris) {
    if (out.length >= MAX_PER_FACE) break;
    emit(surface, polygon, scale, a, b, c, tolerance, surface.flat ? 0 : MAX_SPLIT, out);
  }
  return out;
}

// Surface stretch at the face centre — one sample to equalize the two axes.
function metric(surface: Surface, ring: Ring): number[] {
  const u = centre(ring.uv, 0), v = centre(ring.uv, 1);
  const eu = extent(ring.uv, 0) / 64 || 1e-4;
  const ev = extent(ring.uv, 1) / 64 || 1e-4;
  const du = length(sub(surface.at(u + eu, v), surface.at(u - eu, v))) / (2 * eu);
  const dv = length(sub(surface.at(u, v + ev), surface.at(u, v - ev))) / (2 * ev);
  // Zero stretch (sphere pole) would collapse the polygon.
  return [du > 1e-9 ? du : 1, dv > 1e-9 ? dv : 1];
}

const extent = (uv: number[][], axis: number) => {
  let lo = Infinity, hi = -Infinity;
  for (const p of uv) { if (p[axis] < lo) lo = p[axis]; if (p[axis] > hi) hi = p[axis]; }
  return hi - lo;
};

const boxArea = (uv: number[][]) => Math.max(1e-30, extent(uv, 0) * extent(uv, 1));

// Grid for a seam-only face (no boundary to triangulate).
function bandFacets(surface: Surface, ring: Ring, scale: number[]): Facet[] {
  const period = surface.periodU ? surface.periodU * scale[0] : surface.periodV ? 0 : 0;
  if (!period) return [];
  const u0 = centre(ring.uv, 0) - period / 2;
  let vLo = Infinity, vHi = -Infinity;
  for (const p of ring.uv) { if (p[1] < vLo) vLo = p[1]; if (p[1] > vHi) vHi = p[1]; }
  if (!(vHi > vLo)) return [];

  // Match across/round steps so short cylinders do not over-subdivide.
  const round = FULL_TURN;
  const across = Math.max(2, Math.min(FULL_TURN, Math.round(round * (vHi - vLo) / period)));
  const out: Facet[] = [];
  const point = (i: number, j: number) => {
    const u = (u0 + period * i / round) / scale[0];
    const v = (vLo + (vHi - vLo) * j / across) / scale[1];
    return { p: surface.at(u, v), n: surface.normalAt(u, v) };
  };
  for (let i = 0; i < round && out.length < MAX_PER_FACE; i++) {
    for (let j = 0; j < across; j++) {
      const a = point(i, j), b = point(i + 1, j), c = point(i + 1, j + 1), d = point(i, j + 1);
      out.push({ p: [a.p, b.p, c.p], n: [a.n, b.n, c.n] });
      out.push({ p: [a.p, c.p, d.p], n: [a.n, c.n, d.n] });
    }
  }
  return out;
}

type Ring = { uv: number[][]; xyz: Vec[] };

function project(surface: Surface, loop: Loop): Ring | null {
  const uv: number[][] = [];
  const xyz: Vec[] = [];
  for (const p of loop.points) {
    const q = surface.uv(p);
    if (!q || !Number.isFinite(q[0]) || !Number.isFinite(q[1])) return null;
    uv.push(q);
    xyz.push(p);
  }
  if (uv.length < 3) return null;
  unwrap(uv, 0, surface.periodU);
  unwrap(uv, 1, surface.periodV);
  return { uv, xyz };
}

// Unwrap the +π/−π jump on periodic parameters into a monotone run.
function unwrap(uv: number[][], axis: number, period: number) {
  if (!period) return;
  const half = period / 2;
  for (let i = 1; i < uv.length; i++) {
    let step = uv[i][axis] - uv[i - 1][axis];
    while (step > half) { uv[i][axis] -= period; step -= period; }
    while (step < -half) { uv[i][axis] += period; step += period; }
  }
}

// Shift holes into the same winding as the outer loop.
function align(outer: Ring, holes: Ring[], surface: Surface) {
  for (const [axis, period] of [[0, surface.periodU], [1, surface.periodV]] as const) {
    if (!period) continue;
    const mid = centre(outer.uv, axis);
    for (const hole of holes) {
      const shift = Math.round((mid - centre(hole.uv, axis)) / period) * period;
      if (shift) for (const p of hole.uv) p[axis] += shift;
    }
  }
}

const centre = (uv: number[][], axis: number) => {
  let lo = Infinity, hi = -Infinity;
  for (const p of uv) { if (p[axis] < lo) lo = p[axis]; if (p[axis] > hi) hi = p[axis]; }
  return (lo + hi) / 2;
};

// ---------------------------------------------------------------------------
// Triangulating
// ---------------------------------------------------------------------------

type Polygon = { uv: number[][]; xyz: Vec[] };

// Bridge holes into the outer loop via zero-width channels.
function bridge(outer: Ring, holes: Ring[]): Polygon {
  let uv = outer.uv.slice();
  let xyz = outer.xyz.slice();
  if (!ccw(uv)) { uv.reverse(); xyz.reverse(); }

  const ordered = holes.slice().sort((a, b) => rightmost(b.uv)[0] - rightmost(a.uv)[0]);

  for (const hole of ordered) {
    if (hole.uv.length < 3) continue;
    const h = hole.uv.slice(), hx = hole.xyz.slice();
    if (ccw(h)) { h.reverse(); hx.reverse(); }
    const start = rightmostIndex(h);
    let bestAt = -1, bestD = Infinity;
    for (let i = 0; i < uv.length; i++) {
      const d = (uv[i][0] - h[start][0]) ** 2 + (uv[i][1] - h[start][1]) ** 2;
      if (d < bestD) { bestD = d; bestAt = i; }
    }
    if (bestAt < 0) continue;
    const spliceUV: number[][] = [];
    const spliceXYZ: Vec[] = [];
    for (let k = 0; k <= h.length; k++) {
      const i = (start + k) % h.length;
      spliceUV.push(h[i]); spliceXYZ.push(hx[i]);
    }
    spliceUV.push(uv[bestAt]); spliceXYZ.push(xyz[bestAt]);
    uv = uv.slice(0, bestAt + 1).concat(spliceUV, uv.slice(bestAt + 1));
    xyz = xyz.slice(0, bestAt + 1).concat(spliceXYZ, xyz.slice(bestAt + 1));
  }
  return { uv, xyz };
}

const rightmost = (uv: number[][]) => uv[rightmostIndex(uv)];

function rightmostIndex(uv: number[][]) {
  let at = 0;
  for (let i = 1; i < uv.length; i++) if (uv[i][0] > uv[at][0]) at = i;
  return at;
}

// Twice signed area (shoelace). Positive = CCW.
function area2(uv: number[][]) {
  let sum = 0;
  for (let i = 0, j = uv.length - 1; i < uv.length; j = i++) {
    sum += (uv[j][0] - uv[i][0]) * (uv[j][1] + uv[i][1]);
  }
  return sum;
}

const ccw = (uv: number[][]) => area2(uv) > 0;

// Ear clipping. Tests only reflex corners — testing all corners falsely rejects
// bridge duplicates (same position, different index) and produces folded faces.
function earClip(uv: number[][]): number[][] {
  const n = uv.length;
  if (n < 3) return [];
  const index = Array.from({ length: n }, (_, i) => i);
  if (!ccw(uv)) index.reverse();

  // Turn and cost per corner, kept in step with `index`. A clip changes only
  // the two corners either side of it, so recomputing every corner on every
  // clip made a long loop cost its length squared in hypot calls - seconds for
  // a few thousand points.
  const turn: number[] = [];
  const cost: number[] = [];
  const corner = (i: number) => {
    const m = index.length;
    const a = uv[index[(i + m - 1) % m]], b = uv[index[i]], c = uv[index[(i + 1) % m]];
    turn[i] = (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0]);
    cost[i] = turn[i] > 0 ? squat(uv, index, i, turn[i]) : 0;
  };
  for (let i = 0; i < n; i++) corner(i);

  const out: number[][] = [];
  let guard = n + 16;
  while (index.length > 3 && guard-- > 0) {
    const m = index.length;
    const ear = (i: number) => [index[(i + m - 1) % m], index[i], index[(i + 1) % m]];

    // Prefer the most compact (squarest) ear — avoids strip-spanning slivers.
    // The cheapest is tried first and is almost always free; the sorted walk
    // is the rare case, and is stable, so both take the same ear.
    let best = -1;
    for (let i = 0; i < m; i++) if (turn[i] > 0 && (best < 0 || cost[i] < cost[best])) best = i;
    if (best < 0) break;

    let clipped = -1;
    const first = ear(best);
    if (!blocked(uv, index, turn, first[0], first[1], first[2])) { out.push(first); clipped = best; }
    if (clipped < 0) {
      const order: number[] = [];
      for (let i = 0; i < m; i++) if (turn[i] > 0) order.push(i);
      order.sort((p, q) => cost[p] - cost[q]);
      for (const i of order) {
        const t = ear(i);
        if (blocked(uv, index, turn, t[0], t[1], t[2])) continue;
        out.push(t);
        clipped = i;
        break;
      }
    }
    // Self-touching polygon — take the most compact convex corner to keep progress.
    if (clipped < 0) {
      out.push(first);
      clipped = best;
    }
    index.splice(clipped, 1);
    turn.splice(clipped, 1);
    cost.splice(clipped, 1);
    const left = index.length;
    corner((clipped + left - 1) % left);
    corner(clipped % left);
  }
  if (index.length === 3) out.push([index[0], index[1], index[2]]);
  return out;
}

// Compactness: perimeter² / area. Low = equilateral, high = sliver.
function squat(uv: number[][], index: number[], i: number, turn: number) {
  const m = index.length;
  const a = uv[index[(i + m - 1) % m]];
  const b = uv[index[i]];
  const c = uv[index[(i + 1) % m]];
  const perimeter = Math.hypot(b[0] - a[0], b[1] - a[1])
    + Math.hypot(c[0] - b[0], c[1] - b[1])
    + Math.hypot(a[0] - c[0], a[1] - c[1]);
  return perimeter * perimeter / turn;
}

// Skip bridge duplicates (same position, different index) in containment test.
function blocked(uv: number[][], index: number[], turn: number[], a: number, b: number, c: number) {
  const A = uv[a], B = uv[b], C = uv[c];
  for (let k = 0; k < index.length; k++) {
    if (!(turn[k] < 0)) continue;
    const i = index[k];
    if (i === a || i === b || i === c) continue;
    const p = uv[i];
    if (samePoint(p, A) || samePoint(p, B) || samePoint(p, C)) continue;
    if (inTriangle(p, A, B, C)) return true;
  }
  return false;
}

const samePoint = (p: number[], q: number[]) => p[0] === q[0] && p[1] === q[1];

// ---------------------------------------------------------------------------
// Delaunay edge-flipping (interior edges only)
// ---------------------------------------------------------------------------

function boundaryEdges(n: number) {
  const out = new Set<number>();
  for (let i = 0; i < n; i++) out.add(edgeKey(i, (i + 1) % n));
  return out;
}

const edgeKey = (a: number, b: number) => (a < b ? a * 1e6 + b : b * 1e6 + a);

function flipToDelaunay(tris: number[][], uv: number[][], fixed: Set<number>) {
  let guard = tris.length * 8 + 64;
  for (let pass = 0; pass < 16 && guard > 0; pass++) {
    const shared = new Map<number, number[]>();
    tris.forEach((t, i) => {
      for (let e = 0; e < 3; e++) {
        const key = edgeKey(t[e], t[(e + 1) % 3]);
        if (fixed.has(key)) continue;
        const had = shared.get(key);
        if (had) had.push(i); else shared.set(key, [i]);
      }
    });

    // At most one flip per triangle per pass — double-flipping produces folds.
    const done = new Set<number>();
    let flipped = false;
    for (const [key, list] of shared) {
      if (list.length !== 2 || guard-- <= 0) continue;
      const [i, j] = list;
      if (done.has(i) || done.has(j)) continue;
      const a = Math.floor(key / 1e6), b = key % 1e6;
      const c = tris[i].find(v => v !== a && v !== b);
      const d = tris[j].find(v => v !== a && v !== b);
      if (c === undefined || d === undefined || c === d) continue;
      // Must be strictly convex or the flip overlaps.
      if (!convexQuad(uv, a, c, b, d)) continue;
      if (!inCircle(uv[a], uv[c], uv[b], uv[d])) continue;
      // Preserve winding — the key's numerical order says nothing about direction.
      const carriesAB = carries(tris[i], a, b);
      if (!carriesAB && !carries(tris[j], a, b)) continue;
      const [p, q] = carriesAB ? [i, j] : [j, i];
      const [cp, cq] = carriesAB ? [c, d] : [d, c];
      tris[p] = [cp, a, cq];
      tris[q] = [cq, b, cp];
      done.add(i); done.add(j);
      flipped = true;
    }
    if (!flipped) break;
  }
}

const carries = (t: number[], a: number, b: number) =>
  (t[0] === a && t[1] === b) || (t[1] === a && t[2] === b) || (t[2] === a && t[0] === b);

function convexQuad(uv: number[][], a: number, c: number, b: number, d: number) {
  const q = [uv[a], uv[c], uv[b], uv[d]];
  let sign = 0;
  for (let i = 0; i < 4; i++) {
    const p0 = q[i], p1 = q[(i + 1) % 4], p2 = q[(i + 2) % 4];
    const turn = (p1[0] - p0[0]) * (p2[1] - p0[1]) - (p1[1] - p0[1]) * (p2[0] - p0[0]);
    if (Math.abs(turn) < 1e-18) return false;
    const here = turn > 0 ? 1 : -1;
    if (!sign) sign = here;
    else if (sign !== here) return false;
  }
  return true;
}

// In-circle test (determinant form, orientation-aware).
function inCircle(a: number[], b: number[], c: number[], d: number[]) {
  const ax = a[0] - d[0], ay = a[1] - d[1];
  const bx = b[0] - d[0], by = b[1] - d[1];
  const cx = c[0] - d[0], cy = c[1] - d[1];
  const det =
    (ax * ax + ay * ay) * (bx * cy - by * cx) -
    (bx * bx + by * by) * (ax * cy - ay * cx) +
    (cx * cx + cy * cy) * (ax * by - ay * bx);
  const orient = (a[0] - c[0]) * (b[1] - c[1]) - (a[1] - c[1]) * (b[0] - c[0]);
  return orient > 0 ? det > 1e-18 : det < -1e-18;
}

function inTriangle(p: number[], a: number[], b: number[], c: number[]) {
  const d1 = (p[0] - b[0]) * (a[1] - b[1]) - (a[0] - b[0]) * (p[1] - b[1]);
  const d2 = (p[0] - c[0]) * (b[1] - c[1]) - (b[0] - c[0]) * (p[1] - c[1]);
  const d3 = (p[0] - a[0]) * (c[1] - a[1]) - (c[0] - a[0]) * (p[1] - a[1]);
  const neg = d1 < 0 || d2 < 0 || d3 < 0;
  const pos = d1 > 0 || d2 > 0 || d3 > 0;
  return !(neg && pos);
}

// ---------------------------------------------------------------------------
// Emitting, with the bulge put back
// ---------------------------------------------------------------------------

function emit(
  surface: Surface, poly: Polygon, scale: number[],
  a: number, b: number, c: number,
  tolerance: number, depth: number, out: Facet[],
) {
  const uvA = poly.uv[a], uvB = poly.uv[b], uvC = poly.uv[c];
  const pA = poly.xyz[a], pB = poly.xyz[b], pC = poly.xyz[c];
  emitPoints(surface, scale, [uvA, uvB, uvC], [pA, pB, pC], tolerance, depth, out);
}

// Undo the isometric scaling before evaluating the surface.
const unscale = (uv: number[], scale: number[]) => [uv[0] / scale[0], uv[1] / scale[1]];

// Longest-edge bisection when the chord deviates from the surface.
// Two faces sharing an edge agree on the split point (same endpoints → same test).
function emitPoints(
  surface: Surface, scale: number[], uv: number[][], xyz: Vec[],
  tolerance: number, depth: number, out: Facet[],
) {
  if (out.length >= MAX_PER_FACE) return;
  if (depth > 0) {
    let at = 0, best = -1;
    for (let i = 0; i < 3; i++) {
      const d = length(sub(xyz[i], xyz[(i + 1) % 3]));
      if (d > best) { best = d; at = i; }
    }
    const i = at, j = (at + 1) % 3, k = (at + 2) % 3;
    const mid = [(uv[i][0] + uv[j][0]) / 2, (uv[i][1] + uv[j][1]) / 2];
    const chord: Vec = [
      (xyz[i][0] + xyz[j][0]) / 2,
      (xyz[i][1] + xyz[j][1]) / 2,
      (xyz[i][2] + xyz[j][2]) / 2,
    ];
    const m = unscale(mid, scale);
    const curved = surface.at(m[0], m[1]);
    // Also check the triangle centre — edges can hug while the interior bulges.
    const inside = [(uv[0][0] + uv[1][0] + uv[2][0]) / 3, (uv[0][1] + uv[1][1] + uv[2][1]) / 3];
    const flat: Vec = [0, 1, 2].map(t => (xyz[0][t] + xyz[1][t] + xyz[2][t]) / 3);
    const c = unscale(inside, scale);
    if (length(sub(curved, chord)) > tolerance
      || length(sub(surface.at(c[0], c[1]), flat)) > tolerance) {
      emitPoints(surface, scale, [uv[i], mid, uv[k]], [xyz[i], curved, xyz[k]], tolerance, depth - 1, out);
      emitPoints(surface, scale, [mid, uv[j], uv[k]], [curved, xyz[j], xyz[k]], tolerance, depth - 1, out);
      return;
    }
  }
  const n = uv.map(q => {
    const s = unscale(q, scale);
    return surface.normalAt(s[0], s[1]);
  });
  out.push({ p: [xyz[0], xyz[1], xyz[2]], n: [n[0], n[1], n[2]] });
}

/**
 * A whole surface, over a rectangle of its own parameters, as a grid.
 *
 * For a surface with no trimming at all - which is most of what an IGES surface
 * model contains, and what a NURBS patch nobody cut a hole in looks like in
 * either format. There is no boundary to triangulate and none is needed: the
 * parameter rectangle *is* the face.
 *
 * The step count is chosen so the cells come out square on the surface rather
 * than square in the parameters, for the reason faceFacets() gives at the point
 * where it scales them.
 */
export function gridFacets(
  surface: Surface,
  u0: number, u1: number, v0: number, v1: number,
  scaleHint: number,
): Facet[] {
  if (!(u1 > u0) || !(v1 > v0)) return [];
  const um = (u0 + u1) / 2, vm = (v0 + v1) / 2;
  const du = length(sub(surface.at(u1, vm), surface.at(u0, vm)));
  const dv = length(sub(surface.at(um, v1), surface.at(um, v0)));
  const step = Math.max(scaleHint * SAG * 8, 1e-9);
  const across = Math.max(1, Math.min(FULL_TURN, Math.ceil(du / step)));
  const down = Math.max(1, Math.min(FULL_TURN, Math.ceil(dv / step)));

  const out: Facet[] = [];
  const node = (i: number, j: number) => {
    const u = u0 + (u1 - u0) * i / across;
    const v = v0 + (v1 - v0) * j / down;
    return { p: surface.at(u, v), n: surface.normalAt(u, v) };
  };
  for (let i = 0; i < across && out.length < MAX_PER_FACE; i++) {
    for (let j = 0; j < down; j++) {
      const a = node(i, j), b = node(i + 1, j), c = node(i + 1, j + 1), d = node(i, j + 1);
      out.push({ p: [a.p, b.p, c.p], n: [a.n, b.n, c.n] });
      out.push({ p: [a.p, c.p, d.p], n: [a.n, c.n, d.n] });
    }
  }
  return out;
}

/**
 * The fallback: triangulate the boundary in its own best-fit plane.
 *
 * Used when a face's surface could not be projected - an exotic type this reader
 * has no formula for, or a spline search that did not converge. The result is
 * the face's outline filled in flat, which for a gently curved patch is close
 * and for a strongly curved one is visibly wrong but present. A hole in a solid
 * reads as a broken model; a slightly flat panel does not.
 */
export function flatFacets(given: Loop[]): Facet[] {
  const loops = thin(given);
  const outer = loops.find(l => l.outer) || loops[0];
  if (!outer || outer.points.length < 3) return [];
  const f = fitPlane(outer.points);
  const surface = planeSurface(f);
  const rings: Ring[] = [];
  let outerRing: Ring | null = null;
  for (const loop of loops) {
    const ring = project(surface, loop);
    // A plane can place any point at all, so this only fails on a loop with
    // fewer than three of them - which is a bound that carried no geometry.
    if (!ring) return [];
    rings.push(ring);
    if (loop === outer) outerRing = ring;
  }
  if (!outerRing) return [];
  const poly = bridge(outerRing, rings.filter(r => r !== outerRing));
  const out: Facet[] = [];
  for (const [a, b, c] of earClip(poly.uv)) {
    out.push({
      p: [poly.xyz[a], poly.xyz[b], poly.xyz[c]],
      n: [f.z, f.z, f.z],
    });
  }
  return out;
}

/** Newell's method: the plane a ring of points lies most nearly in, which is
 *  stable for a nearly-degenerate polygon in a way that three-point cross
 *  products are not. */
export function fitPlane(points: Vec[]): Frame {
  const n: Vec = [0, 0, 0];
  const o: Vec = [0, 0, 0];
  for (let i = 0, j = points.length - 1; i < points.length; j = i++) {
    const a = points[j], b = points[i];
    n[0] += (a[1] - b[1]) * (a[2] + b[2]);
    n[1] += (a[2] - b[2]) * (a[0] + b[0]);
    n[2] += (a[0] - b[0]) * (a[1] + b[1]);
    o[0] += b[0]; o[1] += b[1]; o[2] += b[2];
  }
  const k = points.length || 1;
  return frame([o[0] / k, o[1] / k, o[2] / k], unit(n), null);
}
