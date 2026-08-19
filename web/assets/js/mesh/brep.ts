// A tessellator for boundary-representation CAD.
//
// STEP and IGES do not contain triangles. They contain *surfaces* - a plane, a
// cylinder, a NURBS patch - each trimmed by loops of *curves*, and the shape is
// what is left. Every other format in this family says where its triangles are;
// these two say what the object is and leave the triangles to whoever wants to
// draw it. That is the entire reason a CAD viewer normally ships a geometry
// kernel, and it is why this file exists: this project takes no dependencies,
// and a kernel that can facet the surfaces that actually occur is a few hundred
// lines rather than the twelve megabytes of OpenCASCADE.
//
// **What this is not.** It is not a kernel. It does not do booleans, it does not
// heal a broken solid, it does not compute an exact surface-surface
// intersection, and it will not tell you whether two parts collide. It converts
// a trimmed surface into triangles that look like the part at the size a card
// draws it. Every approximation below is chosen on that basis, and where one is
// visible at a larger size, the comment says so.
//
// The method, per face:
//
//   1. **Sample the boundary.** Each edge of each loop becomes a 3D polyline -
//      exactly two points for a line, many for a circle or a spline. This is the
//      only place the curve geometry is used, and the sampling density is what
//      decides how round a cylinder looks.
//   2. **Project into the surface's own parameters.** Every surface here can
//      answer "which (u,v) is this point?" in closed form except the splines,
//      which answer it by search. A cylinder's face becomes a rectangle-ish
//      polygon in (angle, height).
//   3. **Unwrap.** A face that goes all the way round a cylinder crosses the
//      seam where the angle jumps from +pi to -pi, and a polygon with that jump
//      in it is not a polygon. Both the loop and the holes are unwrapped and
//      then brought into the same turn.
//   4. **Triangulate in 2D.** Holes are bridged into the outer loop and the
//      result is ear-clipped. Plain, quadratic, and entirely fast enough - the
//      polygons are tens of points, not thousands.
//   5. **Subdivide where the surface bulges.** A boundary triangulation of a
//      sphere is flat. So each triangle is checked against the surface at its
//      own centre and split there if the two disagree, recursively. Splitting at
//      the *centre* rather than at edge midpoints is deliberate: it never moves
//      a boundary vertex, so two faces that share an edge still meet along it.
//
// The 3D positions of boundary points are the ones that were sampled, not the
// ones the surface would give for their computed (u,v). Those differ by whatever
// the projection got wrong, and using the sampled ones is what keeps adjacent
// faces sharing their edges exactly.

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

/**
 * A right-handed frame: an origin and three axes.
 *
 * Both formats describe every placement this way - a point, a "z" direction and
 * a "x" reference direction - and both allow the reference direction to be
 * missing or not perpendicular. So the frame is always re-orthogonalised here
 * rather than trusted, which is the difference between a cylinder and a sheared
 * cylinder.
 */
export type Frame = { o: Vec; x: Vec; y: Vec; z: Vec };

export function frame(origin: Vec, axis: Vec | null, ref: Vec | null): Frame {
  const z = unit(axis || [0, 0, 1]);
  let x = ref ? sub(ref, scale(z, dot(ref, z))) : [0, 0, 0];
  if (length(x) < 1e-12) {
    // No usable reference direction. Any perpendicular will do, and this picks
    // the one furthest from z so the cross product is well conditioned.
    const alt: Vec = Math.abs(z[0]) < 0.9 ? [1, 0, 0] : [0, 1, 0];
    x = sub(alt, scale(z, dot(alt, z)));
  }
  x = unit(x);
  return { o: origin, x, y: cross(z, x), z };
}

/** A point in the frame's own coordinates. */
const local = (f: Frame, p: Vec): Vec => {
  const d = sub(p, f.o);
  return [dot(d, f.x), dot(d, f.y), dot(d, f.z)];
};

/** And back out of them. */
const world = (f: Frame, x: number, y: number, z: number): Vec => [
  f.o[0] + f.x[0] * x + f.y[0] * y + f.z[0] * z,
  f.o[1] + f.x[1] * x + f.y[1] * y + f.z[1] * z,
  f.o[2] + f.x[2] * x + f.y[2] * y + f.z[2] * z,
];

// ---------------------------------------------------------------------------
// Curves
// ---------------------------------------------------------------------------

/**
 * A curve, reduced to what sampling one needs.
 *
 * `param(p)` is the inverse: which parameter is this point at? Both formats give
 * an edge as a curve plus its two end *points* rather than its two end
 * parameters, so every curve here has to be invertible or the edge cannot be
 * trimmed. Where the inverse is a search rather than a formula it says so by
 * being slow, not by being absent.
 */
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

/** How many straight segments a full turn is drawn with. Twenty-four is a
 *  degree and a half of chord error on a circle a card's width across, which is
 *  invisible; the cost of doubling it is a doubling of every round face. */
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
      // Not the geometric angle: the *parameter*, which for an ellipse is the
      // angle after undoing the two semi-axes. Using atan2 on the raw point puts
      // every trim in the wrong place on anything but a circle.
      return Math.atan2(l[1] / (b || 1), l[0] / (a || 1));
    },
    period: Math.PI * 2,
    segments: (t0, t1) => arcSegments(t1 - t0),
  };
}

const arcSegments = (span: number) =>
  Math.max(1, Math.min(FULL_TURN, Math.ceil(Math.abs(span) / (Math.PI * 2) * FULL_TURN)));

/** A polyline, which is what both formats' composite and trimmed curves reduce
 *  to once this reader has stopped following them. Parameter is the index. */
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

/** Control points with weights, degree, and a full (expanded) knot vector. */
export type Spline = {
  degree: number;
  knots: number[];
  ctrl: Vec[];
  weights: number[] | null;
};

/** STEP and IGES both give knots and multiplicities separately. */
export function expandKnots(knots: number[], mults: number[]) {
  const out: number[] = [];
  for (let i = 0; i < knots.length; i++) {
    const m = Math.max(0, Math.min(64, Math.round(mults[i] ?? 1)));
    for (let k = 0; k < m; k++) out.push(knots[i]);
  }
  return out;
}

/** The knot span containing `t`, clamped into the curve's own domain. */
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

/** de Boor, in homogeneous coordinates so the rational case falls out of it. */
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

/**
 * A spline curve. The inverse is a sampled search followed by a few bisection
 * steps - there is no closed form, and a Newton step on a curve with an inflexion
 * near the point walks away from the answer often enough to be worse than this.
 */
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
      // Golden-section-ish narrowing around the best sample. Twenty halvings of
      // a span already one part in a few hundred is far past what the chord
      // tolerance below can see.
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
    // A spline is sampled by its control net: more control points mean more
    // curvature to lose, and a straight two-point spline needs one segment.
    segments: (t0, t1) => {
      const frac = hi > lo ? Math.abs(t1 - t0) / (hi - lo) : 1;
      return Math.max(1, Math.min(256, Math.ceil(frac * Math.max(2, s.ctrl.length * 3))));
    },
  };
}

// ---------------------------------------------------------------------------
// Surfaces
// ---------------------------------------------------------------------------

/**
 * A surface, reduced to what triangulating one needs.
 *
 * `uv(p)` may return null for a point the surface cannot place, which is what a
 * spline patch says when its search does not converge. A face with too many of
 * those falls back to the flat triangulation, which is a face in roughly the
 * right place rather than a hole in the model.
 */
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
      // The outward normal of a cone leans away from the axis by the half-angle.
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
    // v does not wrap: it runs pole to pole and stops.
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

/** A surface swept by dragging a curve along a straight line. */
export function extrusionSurface(curve: Curve, direction: Vec, domain: [number, number]): Surface {
  const d = unit(direction);
  return {
    at: (u, v) => add(curve.at(u), scale(d, v)),
    uv: p => {
      const v = dot(sub(p, curve.at(domain[0])), d);
      // Undo the sweep before asking the curve where the point is, or every
      // parameter comes back as the one nearest the curve's own plane.
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

/** A surface swept by spinning a curve about an axis. */
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
      // Bring the point back to the generating curve's own turn, then ask it.
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

/** A NURBS patch: a spline in each direction over a grid of control points. */
export type SplineSurface = {
  uDegree: number; vDegree: number;
  uKnots: number[]; vKnots: number[];
  /** Row-major: `ctrl[i * vCount + j]`. */
  ctrl: Vec[];
  weights: number[] | null;
  uCount: number; vCount: number;
};

export function splineSurface(s: SplineSurface): Surface {
  const uLo = s.uKnots[s.uDegree], uHi = s.uKnots[s.uCount];
  const vLo = s.vKnots[s.vDegree], vHi = s.vKnots[s.vCount];

  // Evaluated the obvious way: run de Boor down each row of the control grid at
  // the v parameter, then once across the results at u. The row curves are built
  // per call rather than cached, which is the cost of not carrying a basis
  // cache; a face is a few hundred evaluations and this is not the slow part.
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
      // The weight at (u,v) follows the same recursion as the point, which is
      // what keeps the second pass rational too. Evaluated by running de Boor on
      // the weights as a one-dimensional curve.
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

  // Inversion: nearest of a coarse grid, then repeated halving in both
  // directions. A NURBS patch is not invertible in closed form and this is the
  // reading that does not need derivatives to be well behaved.
  const GRID = 20;
  const uv = (p: Vec): number[] | null => {
    let bu = uLo, bv = vLo, best = Infinity;
    for (let i = 0; i <= GRID; i++) {
      const u = uLo + (uHi - uLo) * i / GRID;
      for (let j = 0; j <= GRID; j++) {
        const v = vLo + (vHi - vLo) * j / GRID;
        const d = length(sub(at(u, v), p));
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

/** One boundary of a face, already sampled into 3D points in order. */
export type Loop = { points: Vec[]; outer: boolean };

/** A triangle of the result: three 3D points and three normals. */
export type Facet = { p: Vec[]; n: Vec[] };

/** How far a triangle's middle may sit from the surface before it is split, as
 *  a fraction of the model's own size. One part in four hundred is under half a
 *  pixel on a card a couple of hundred pixels across. */
const SAG = 1 / 400;

/** How many times one triangle may be split. Each split is a threefold
 *  increase, so four levels is eighty-one triangles from one - past which the
 *  face was not a good candidate for boundary triangulation in the first place. */
const MAX_SPLIT = 4;

/** The most triangles one face may produce. A face past this has gone wrong -
 *  a degenerate boundary, a projection that folded - and a card cannot show the
 *  difference between four thousand triangles and forty thousand anyway. */
const MAX_PER_FACE = 4_000;

/** Below this fraction of the parameter box, a loop encloses nothing: it is a
 *  seam walked out and back, which is how a fully closed surface is written. */
const DEGENERATE = 1e-9;

/**
 * Turn one trimmed face into triangles.
 *
 * `scaleHint` is the size of the whole model, used only to turn the relative sag
 * tolerance above into an absolute one - a tolerance in millimetres would be
 * meaningless on a file that measures in metres or in inches, and both occur.
 */
export function faceFacets(surface: Surface, loops: Loop[], scaleHint: number): Facet[] {
  const outer = loops.find(l => l.outer) || loops[0];
  if (!outer || outer.points.length < 3) return [];

  // Step 2 and 3: project and unwrap. A loop that cannot be projected at all
  // takes the whole face down the flat path, which is a face rather than a hole.
  const projected = loops.map(l => project(surface, l));
  if (projected.some(p => !p)) return flatFacets(loops);

  const rings = projected as Ring[];
  const outerRing = rings.find((_, i) => loops[i].outer) || rings[0];
  const holes = rings.filter(r => r !== outerRing);
  align(outerRing, holes, surface);

  // Step 3a: make the parameters isometric. This is the one step that is not in
  // the header's list and is the one that decides whether any of the rest work.
  //
  // A cylinder's parameters are (radians, millimetres). A triangle that looks
  // square in those numbers is a sliver a hundred times longer than it is wide
  // on the actual surface, and *every* decision below - which ear to clip, how
  // compact a triangle is, whether one needs splitting - is a decision about the
  // surface rather than about the numbers. So both axes are scaled by how far a
  // step in them actually moves, measured on the surface itself, and everything
  // downstream works in a space where a unit is a unit.
  const scale = metric(surface, outerRing);
  for (const ring of rings) {
    for (const p of ring.uv) { p[0] *= scale[0]; p[1] *= scale[1]; }
  }

  // A boundary that encloses nothing in parameter space is a seam, not a face -
  // which is how a whole cylinder or a whole sphere gets written as one face.
  // The band it seams is the face, and that is what is drawn.
  if (Math.abs(area2(outerRing.uv)) < DEGENERATE * boxArea(outerRing.uv)) {
    return bandFacets(surface, outerRing, scale, scaleHint);
  }

  const polygon = bridge(outerRing, holes);
  const tris = earClip(polygon.uv);
  if (!tris.length) return flatFacets(loops);

  const out: Facet[] = [];
  const tolerance = Math.max(1e-9, scaleHint * SAG);
  for (const [a, b, c] of tris) {
    if (out.length >= MAX_PER_FACE) break;
    emit(surface, polygon, scale, a, b, c, tolerance, surface.flat ? 0 : MAX_SPLIT, out);
  }
  return out;
}

/**
 * How far a step of one in each parameter moves on the surface, at the middle of
 * this face.
 *
 * One sample rather than a field: the whole point is to get the two axes into
 * the same units, and a surface whose stretch varies by more than a factor of a
 * few across one face is a surface whose face wanted splitting anyway.
 */
function metric(surface: Surface, ring: Ring): number[] {
  const u = centre(ring.uv, 0), v = centre(ring.uv, 1);
  const eu = span(ring.uv, 0) / 64 || 1e-4;
  const ev = span(ring.uv, 1) / 64 || 1e-4;
  const du = length(sub(surface.at(u + eu, v), surface.at(u - eu, v))) / (2 * eu);
  const dv = length(sub(surface.at(u, v + ev), surface.at(u, v - ev))) / (2 * ev);
  // A stretch of zero is a degenerate direction - the pole of a sphere - and
  // scaling by it would collapse the polygon.
  return [du > 1e-9 ? du : 1, dv > 1e-9 ? dv : 1];
}

const span = (uv: number[][], axis: number) => {
  let lo = Infinity, hi = -Infinity;
  for (const p of uv) { if (p[axis] < lo) lo = p[axis]; if (p[axis] > hi) hi = p[axis]; }
  return hi - lo;
};

const boxArea = (uv: number[][]) => Math.max(1e-30, span(uv, 0) * span(uv, 1));

/**
 * A face whose only boundary is a seam: the whole band of the surface between
 * the seam and itself, one full period round.
 *
 * Written as a grid rather than by triangulating the boundary, because there is
 * no boundary to triangulate - the loop went out along the seam and back along
 * it, enclosing nothing. This is what a cylinder exported without a separate
 * seam edge looks like, and what every closed sphere looks like.
 */
function bandFacets(surface: Surface, ring: Ring, scale: number[], scaleHint: number): Facet[] {
  const period = surface.periodU ? surface.periodU * scale[0] : surface.periodV ? 0 : 0;
  if (!period) return [];
  const u0 = centre(ring.uv, 0) - period / 2;
  let vLo = Infinity, vHi = -Infinity;
  for (const p of ring.uv) { if (p[1] < vLo) vLo = p[1]; if (p[1] > vHi) vHi = p[1]; }
  if (!(vHi > vLo)) return [];

  // Enough steps that the chord error round the band is under the tolerance,
  // and enough across it that a curved band (a sphere, a torus) is not a tube.
  const tolerance = Math.max(1e-9, scaleHint * SAG);
  const across = Math.max(2, Math.min(64, Math.ceil((vHi - vLo) / Math.max(tolerance * 8, 1e-9))));
  const round = 48;
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

/** A loop in parameter space, with the 3D point each parameter came from. */
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

/**
 * Undo the jump a periodic parameter makes at its seam.
 *
 * Walking a loop that goes all the way round a cylinder, the angle runs up to
 * +pi and then restarts at -pi. Adding a turn every time the step is more than
 * half a period turns that back into a monotone run, which is what the
 * triangulator needs and what the surface will still evaluate correctly - it
 * takes a cosine of it either way.
 */
function unwrap(uv: number[][], axis: number, period: number) {
  if (!period) return;
  const half = period / 2;
  for (let i = 1; i < uv.length; i++) {
    let step = uv[i][axis] - uv[i - 1][axis];
    while (step > half) { uv[i][axis] -= period; step -= period; }
    while (step < -half) { uv[i][axis] += period; step += period; }
  }
}

/** Bring each hole into the same turn as the outer loop. Unwrapping is relative
 *  to a loop's own start, so two loops on one cylinder can come out a full turn
 *  apart and the hole would be bridged to somewhere the face is not. */
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

/**
 * Cut each hole into the outer loop, producing one simple polygon.
 *
 * The classic bridge: take the hole's rightmost vertex, find the outer vertex
 * nearest it, and walk the hole into the loop and back out again along the same
 * pair - which leaves a zero-width channel the ear clipper walks straight past.
 * Not the most robust construction there is (two holes that both want the same
 * outer vertex can produce a self-touching polygon), and the failure is a face
 * with an extra sliver rather than a wrong shape.
 */
function bridge(outer: Ring, holes: Ring[]): Polygon {
  let uv = outer.uv.slice();
  let xyz = outer.xyz.slice();
  if (!ccw(uv)) { uv.reverse(); xyz.reverse(); }

  // Rightmost first, so a hole inside another hole's bridge is cut later.
  const ordered = holes.slice().sort((a, b) => rightmost(b.uv)[0] - rightmost(a.uv)[0]);

  for (const hole of ordered) {
    if (hole.uv.length < 3) continue;
    const h = hole.uv.slice(), hx = hole.xyz.slice();
    // A hole runs the other way round from the loop that contains it.
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

function area2(uv: number[][]) {
  let sum = 0;
  for (let i = 0, j = uv.length - 1; i < uv.length; j = i++) {
    sum += (uv[j][0] - uv[i][0]) * (uv[j][1] + uv[i][1]);
  }
  return sum;
}

const ccw = (uv: number[][]) => area2(uv) < 0;

/**
 * Ear clipping, plainly.
 *
 * Quadratic in the number of points and entirely fast enough: the polygons here
 * are a face's boundary, which is tens of points on anything but a spline patch
 * with a hundred-segment edge. The guard counter is what stops a self-touching
 * polygon - which the bridging above can produce - from looping forever; it
 * gives up and returns what it has, and the face comes out with a piece missing
 * rather than the tab hanging.
 */
function earClip(uv: number[][]): number[][] {
  const n = uv.length;
  if (n < 3) return [];
  const index = Array.from({ length: n }, (_, i) => i);
  if (!ccw(uv)) index.reverse();

  const out: number[][] = [];
  let guard = n * n + 16;
  while (index.length > 3 && guard-- > 0) {
    // Candidates in order of how square they are, and the first valid one wins.
    //
    // Taking the *first* ear rather than the best is the textbook version and it
    // is wrong here for a specific reason: a face on a cylinder is a long strip,
    // and clipping strictly in order eats it from one end, producing triangles
    // that span the whole width and cut through the surface. Preferring compact
    // ears makes the same strip come out as a zigzag of near-equilateral
    // triangles, which is both a better shape and - because the sag test below
    // then passes - an order of magnitude fewer of them.
    //
    // The parameters are isometric by the time they get here, so "compact" is a
    // statement about the surface and not about the numbers. See faceFacets().
    const order = index.map((_, i) => i).sort((p, q) => squat(uv, index, p) - squat(uv, index, q));
    let clipped = false;
    for (const i of order) {
      const a = index[(i + index.length - 1) % index.length];
      const b = index[i];
      const c = index[(i + 1) % index.length];
      if (!isEar(uv, index, a, b, c)) continue;
      out.push([a, b, c]);
      index.splice(i, 1);
      clipped = true;
      break;
    }
    // No ear anywhere means the polygon is degenerate or self-touching. Taking
    // the least-bad triangle keeps progress, and the alternative is nothing.
    if (!clipped) {
      const a = index[index.length - 1], b = index[0], c = index[1];
      out.push([a, b, c]);
      index.splice(0, 1);
    }
  }
  if (index.length === 3) out.push([index[0], index[1], index[2]]);
  return out;
}

/** Perimeter squared over area: one for an equilateral triangle after scaling,
 *  unbounded for a sliver. Infinite for a reflex corner, which sorts every
 *  non-candidate to the back without a second pass to find them. */
function squat(uv: number[][], index: number[], i: number) {
  const a = uv[index[(i + index.length - 1) % index.length]];
  const b = uv[index[i]];
  const c = uv[index[(i + 1) % index.length]];
  const turn = (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0]);
  if (turn <= 0) return Infinity;
  const perimeter = Math.hypot(b[0] - a[0], b[1] - a[1])
    + Math.hypot(c[0] - b[0], c[1] - b[1])
    + Math.hypot(a[0] - c[0], a[1] - c[1]);
  return perimeter * perimeter / turn;
}

function isEar(uv: number[][], index: number[], a: number, b: number, c: number) {
  const [ax, ay] = uv[a], [bx, by] = uv[b], [cx, cy] = uv[c];
  const turn = (bx - ax) * (cy - ay) - (by - ay) * (cx - ax);
  if (turn <= 0) return false;                 // reflex or collinear
  for (const i of index) {
    if (i === a || i === b || i === c) continue;
    if (inTriangle(uv[i], uv[a], uv[b], uv[c])) return false;
  }
  return true;
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

/** Parameters are held scaled - see the metric argument in faceFacets() - and
 *  the surface only ever answers in its own, so every call across that boundary
 *  goes through here. */
const unscale = (uv: number[], scale: number[]) => [uv[0] / scale[0], uv[1] / scale[1]];

function emitPoints(
  surface: Surface, scale: number[], uv: number[][], xyz: Vec[],
  tolerance: number, depth: number, out: Facet[],
) {
  if (out.length >= MAX_PER_FACE) return;
  if (depth > 0) {
    const mid = [
      (uv[0][0] + uv[1][0] + uv[2][0]) / 3,
      (uv[0][1] + uv[1][1] + uv[2][1]) / 3,
    ];
    const flat: Vec = [
      (xyz[0][0] + xyz[1][0] + xyz[2][0]) / 3,
      (xyz[0][1] + xyz[1][1] + xyz[2][1]) / 3,
      (xyz[0][2] + xyz[1][2] + xyz[2][2]) / 3,
    ];
    const m = unscale(mid, scale);
    const curved = surface.at(m[0], m[1]);
    if (length(sub(curved, flat)) > tolerance) {
      // Split at the centre, never on an edge - see the header. Three children,
      // each sharing the original edge it was built from, so the face's boundary
      // is untouched and its neighbours still meet it.
      for (const [i, j] of [[0, 1], [1, 2], [2, 0]]) {
        emitPoints(surface, scale, [uv[i], uv[j], mid], [xyz[i], xyz[j], curved], tolerance, depth - 1, out);
      }
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
 * The fallback: triangulate the boundary in its own best-fit plane.
 *
 * Used when a face's surface could not be projected - an exotic type this reader
 * has no formula for, or a spline search that did not converge. The result is
 * the face's outline filled in flat, which for a gently curved patch is close
 * and for a strongly curved one is visibly wrong but present. A hole in a solid
 * reads as a broken model; a slightly flat panel does not.
 */
export function flatFacets(loops: Loop[]): Facet[] {
  const outer = loops.find(l => l.outer) || loops[0];
  if (!outer || outer.points.length < 3) return [];
  const f = fitPlane(outer.points);
  const surface = planeSurface(f);
  const rings = loops.map(l => project(surface, l));
  if (rings.some(r => !r)) return [];
  const ok = rings as Ring[];
  const outerRing = ok[loops.indexOf(outer)];
  const poly = bridge(outerRing, ok.filter(r => r !== outerRing));
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
