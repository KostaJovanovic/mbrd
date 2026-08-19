// IGES - the format CAD exchanged in before STEP, and still does.
//
// Older than STEP, less well specified, and completely different in shape: where
// a STEP file is a graph of typed records, an IGES file is **eighty-column card
// images**. Every line carries a section letter in column 73 and a sequence
// number in the last seven, and the file is five sections in a fixed order -
// Start, Global, Directory Entry, Parameter Data, Terminate. An entity is *two*
// lines in the directory (fixed eight-character fields) plus a run of lines in
// the parameter section (free format, comma separated), and the two halves refer
// to each other by line number. That is 1979 for you, and it means the reader
// below is a fixed-field parser and a free-format one stacked on each other.
//
// The geometry, once past that, is the same problem STEP poses and is solved by
// the same tessellator in mesh/brep.ts. There are two ways an IGES file
// describes a solid and this reads both:
//
//   - **Trimmed surfaces** (entity 144), which is what almost every exporter
//     writes. A surface plus the curves that cut it, with the curves given both
//     in three dimensions and in the surface's own parameters.
//   - **A boundary representation** (186 / 514 / 510 / 508 / 504 / 502), the
//     later addition that mirrors STEP's shells and faces.
//
// And a third case that is not a solid at all: a file of *untrimmed* surfaces,
// which is what a lot of older IGES is. Those are drawn over their whole
// parameter rectangle, because that is what they are.
//
// What is not read: dimensions, drafting entities, annotation, views, and the
// whole two-dimensional drawing half of the format - IGES carries drawings as
// well as models, and a card that showed the title block instead of the part
// would be a strange thing.

import { oversize } from '../consent.ts';
import {
  CAPS, MeshError, MeshBuild, type Mesh, clamp01, tooBig,
} from './shared.ts';
import {
  type Curve, type Facet, type Frame, type Loop, type Surface, type Vec,
  circleCurve, coneSurface, cylinderSurface, extrusionSurface,
  faceFacets, flatFacets, frame, gridFacets, length, lineCurve, planeSurface,
  polylineCurve, revolutionSurface, splineCurve, splineDomain, splineSurface,
  sphereSurface, sub, torusSurface, unit,
} from './brep.ts';

const MAX_ENTITIES = 500_000;
const MAX_FACES = 200_000;
const MAX_FOLLOW = 16;

// Entity type numbers, named where they are used more than once.
const CIRCULAR_ARC = 100;
const COMPOSITE_CURVE = 102;
const COPIOUS_DATA = 106;
const LINE = 110;
const PLANE = 108;
const TRANSFORM = 124;
const RULED_SURFACE = 118;
const SURFACE_OF_REVOLUTION = 120;
const TABULATED_CYLINDER = 122;
const RATIONAL_SPLINE_CURVE = 126;
const RATIONAL_SPLINE_SURFACE = 128;
const CURVE_ON_SURFACE = 142;
const TRIMMED_SURFACE = 144;
// A shell (514) and a manifold solid (186) are containers only: every face
// under one is already reached by the sweep over all 510s, so neither is named
// here and neither has to be walked.
const VERTEX_LIST = 502;
const EDGE_LIST = 504;
const LOOP = 508;
const FACE = 510;
const COLOUR = 314;

/** The analytic surface family, added late and written by few exporters - but
 *  the few include some CAM tools, and each is two lines here. */
const PLANE_SURFACE = 190;
const CYLINDRICAL_SURFACE = 192;
const CONICAL_SURFACE = 194;
const SPHERICAL_SURFACE = 196;
const TOROIDAL_SURFACE = 198;

type Entity = {
  /** The directory sequence number, which is what every pointer names. */
  id: number;
  type: number;
  form: number;
  /** Parameter values, the repeated type number already stripped from the
   *  front so every reading below counts from the first real field. */
  data: (number | string)[];
  /** The 124 that places this entity, if it declared one. */
  transform: number;
  colour: number;
};

export function parseIGES(bytes: string | ArrayBuffer): Mesh {
  const text = typeof bytes === 'string' ? bytes : new TextDecoder('latin1').decode(bytes);
  const db = read(text);
  return assemble(db);
}

// ---------------------------------------------------------------------------
// The card images
// ---------------------------------------------------------------------------

function read(text: string): Map<number, Entity> {
  const lines = text.split(/\r\n?|\n/);
  if (!lines.length) throw new MeshError('This IGES file is empty');

  // The delimiters are declared in the Global section, in its own first two
  // fields, and the declaration is itself written using them - which is why they
  // are read by pattern rather than by field. Almost every file uses the
  // defaults and a handful do not.
  let comma = ',', semi = ';';
  const global = lines.filter(l => l[72] === 'G' || l[72] === 'g').join('');
  const declared = /^(\d)H(.)(.)(\d)H(.)/.exec(global.trim());
  if (declared && declared[1] === '1' && declared[4] === '1') { comma = declared[2]; semi = declared[5]; }

  // The directory: two cards an entity, in order, keyed by the sequence number
  // of the *first* of the two.
  const directory: string[] = [];
  const parameters: { text: string; owner: number }[] = [];
  for (const line of lines) {
    const section = line[72];
    if (section === 'D' || section === 'd') directory.push(line);
    else if (section === 'P' || section === 'p') {
      parameters.push({ text: line.slice(0, 64), owner: Number(line.slice(64, 72).trim()) || 0 });
    }
  }
  if (!directory.length) throw new MeshError('This IGES file has no directory in it');

  // Parameter cards, gathered by the directory entry that owns them and split on
  // the record terminator. One entity's parameters may run over many cards.
  const byOwner = new Map<number, string>();
  for (const card of parameters) {
    byOwner.set(card.owner, (byOwner.get(card.owner) || '') + card.text);
  }

  const db = new Map<number, Entity>();
  const field = (line: string, n: number) => line.slice((n - 1) * 8, n * 8).trim();

  for (let i = 0; i + 1 < directory.length; i += 2) {
    if (db.size >= MAX_ENTITIES) throw new MeshError('This IGES file has more entities than a model has');
    const one = directory[i], two = directory[i + 1];
    const id = Number(one.slice(73, 80).trim()) || i + 1;
    const type = Number(field(one, 1)) || 0;
    const data = split(byOwner.get(id) || '', comma, semi);
    // The first parameter is the entity type repeated, and every reading below
    // is written as if it were not there.
    if (data.length && Number(data[0]) === type) data.shift();
    db.set(id, {
      id, type,
      form: Number(field(two, 9)) || 0,
      data,
      transform: Number(field(one, 7)) || 0,
      colour: Number(field(two, 3)) || 0,
    });
  }
  if (!db.size) throw new MeshError('This IGES file has no entities in it');
  return db;
}

/** One entity's parameter run, split on the record delimiters. Hollerith
 *  strings (`6HABCDEF`) are kept whole, because the count in front of one names
 *  bytes that may themselves be delimiters. */
function split(text: string, comma: string, semi: string) {
  const out: (number | string)[] = [];
  let token = '';
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (c === semi) break;
    if (c === comma) { out.push(value(token)); token = ''; continue; }
    if (c === 'H' && /^\d+$/.test(token.trim())) {
      const n = Number(token.trim());
      out.push(text.slice(i + 1, i + 1 + n));
      i += n;
      token = '';
      // Step over the delimiter that follows the string, if it is there.
      if (text[i + 1] === comma) i++;
      continue;
    }
    token += c;
  }
  if (token.trim()) out.push(value(token));
  return out;
}

/** IGES writes doubles in Fortran's D exponent form as often as in E's. */
function value(raw: string) {
  const t = raw.trim();
  if (!t) return 0;
  const n = Number(t.replace(/[Dd]([-+]?\d)/, 'e$1'));
  return Number.isFinite(n) ? n : t;
}

// ---------------------------------------------------------------------------
// Reading the model
// ---------------------------------------------------------------------------

type Db = Map<number, Entity>;

const numAt = (e: Entity, i: number, fallback = 0) => {
  const v = e.data[i];
  return typeof v === 'number' && Number.isFinite(v) ? v : fallback;
};

const pointer = (e: Entity, i: number) => Math.abs(numAt(e, i));

function assemble(db: Db): Mesh {
  const scaleHint = modelSize(db);
  const build = new MeshBuild();
  let faces = 0;

  // Which surfaces are already accounted for by a trimmed surface or a face, so
  // an untrimmed one is not drawn twice.
  const claimed = new Set<number>();
  for (const e of db.values()) {
    if (e.type === TRIMMED_SURFACE) claimed.add(pointer(e, 0));
    else if (e.type === FACE) claimed.add(pointer(e, 0));
  }

  const emit = (facets: Facet[], colour: number[] | null, place: Matrix | null) => {
    for (const facet of facets) {
      if (build.count >= CAPS.tri) throw oversize('mesh-triangles', tooBig(CAPS.tri));
      const p = place ? facet.p.map(q => applyTo(place, q)) : facet.p;
      const n = place ? facet.n.map(q => spinBy(place, q)) : facet.n;
      build.tri(p[0][0], p[0][1], p[0][2], p[1][0], p[1][1], p[1][2], p[2][0], p[2][1], p[2][2], colour);
      build.normals(n[0], n[1], n[2]);
    }
  };

  for (const e of db.values()) {
    if (e.type !== TRIMMED_SURFACE && e.type !== FACE) continue;
    if (++faces > MAX_FACES) throw new MeshError('This IGES file has more faces than a drawing has');
    emit(readFace(db, e, scaleHint), colourOf(db, e), matrixOf(db, e, 0));
  }

  // Untrimmed surfaces: whatever is left. A file of these is a surface model
  // rather than a solid, and drawing each over its own parameter rectangle is
  // the only reading of it there is.
  for (const e of db.values()) {
    if (claimed.has(e.id)) continue;
    const s = surfaceOf(db, e.id, scaleHint);
    if (!s) continue;
    if (++faces > MAX_FACES) throw new MeshError('This IGES file has more faces than a drawing has');
    emit(gridFacets(s.surface, s.u0, s.u1, s.v0, s.v1, scaleHint), colourOf(db, e), matrixOf(db, e, 0));
  }

  if (!build.count) throw new MeshError('This IGES file has no surfaces this can draw');
  return build.done();
}

/** The size of everything, for the relative chord tolerance. Taken from the
 *  points every curve and surface carries rather than from a bounding-box
 *  entity, because the format has no such entity. */
function modelSize(db: Db) {
  const lo = [Infinity, Infinity, Infinity];
  const hi = [-Infinity, -Infinity, -Infinity];
  const see = (x: number, y: number, z: number) => {
    const p = [x, y, z];
    for (let k = 0; k < 3; k++) {
      if (!Number.isFinite(p[k])) return;
      if (p[k] < lo[k]) lo[k] = p[k];
      if (p[k] > hi[k]) hi[k] = p[k];
    }
  };
  for (const e of db.values()) {
    if (e.type === LINE) { see(numAt(e, 0), numAt(e, 1), numAt(e, 2)); see(numAt(e, 3), numAt(e, 4), numAt(e, 5)); }
    else if (e.type === RATIONAL_SPLINE_CURVE || e.type === RATIONAL_SPLINE_SURFACE) {
      // The control points are the tail of the record; sampling every third
      // number from the back is enough to bound the thing.
      for (let i = Math.max(0, e.data.length - 300); i + 2 < e.data.length; i += 3) {
        see(numAt(e, i), numAt(e, i + 1), numAt(e, i + 2));
      }
    }
  }
  const span = Number.isFinite(lo[0]) ? Math.hypot(hi[0] - lo[0], hi[1] - lo[1], hi[2] - lo[2]) : 0;
  return span > 0 ? span : 1;
}

// ---------------------------------------------------------------------------
// Surfaces
// ---------------------------------------------------------------------------

type SurfaceInfo = { surface: Surface; u0: number; u1: number; v0: number; v1: number };

function surfaceOf(db: Db, id: number, scaleHint: number, depth = 0): SurfaceInfo | null {
  if (depth > MAX_FOLLOW) return null;
  const e = db.get(id);
  if (!e) return null;

  switch (e.type) {
    case RATIONAL_SPLINE_SURFACE: return splineSurfaceOf(e);
    case PLANE: {
      // Ax + By + Cz = D. An unbounded plane, so its rectangle is nominal - a
      // trimmed surface supplies the boundary and an untrimmed one is a
      // construction plane nobody wanted drawn anyway.
      const n = unit([numAt(e, 0), numAt(e, 1), numAt(e, 2)]);
      const d = numAt(e, 3);
      const f = frame([n[0] * d, n[1] * d, n[2] * d], n, null);
      return { surface: planeSurface(f), u0: -scaleHint, u1: scaleHint, v0: -scaleHint, v1: scaleHint };
    }
    case PLANE_SURFACE: {
      const f = frameFrom(db, pointer(e, 0), pointer(e, 1), pointer(e, 2));
      return f ? { surface: planeSurface(f), u0: -scaleHint, u1: scaleHint, v0: -scaleHint, v1: scaleHint } : null;
    }
    case CYLINDRICAL_SURFACE: {
      const f = frameFrom(db, pointer(e, 0), pointer(e, 1), pointer(e, 3));
      return f ? { surface: cylinderSurface(f, numAt(e, 2)), u0: 0, u1: Math.PI * 2, v0: -scaleHint, v1: scaleHint } : null;
    }
    case CONICAL_SURFACE: {
      const f = frameFrom(db, pointer(e, 0), pointer(e, 1), pointer(e, 4));
      return f ? { surface: coneSurface(f, numAt(e, 2), numAt(e, 3)), u0: 0, u1: Math.PI * 2, v0: -scaleHint, v1: scaleHint } : null;
    }
    case SPHERICAL_SURFACE: {
      const f = frameFrom(db, pointer(e, 0), pointer(e, 2), pointer(e, 3));
      return f ? { surface: sphereSurface(f, numAt(e, 1)), u0: 0, u1: Math.PI * 2, v0: -Math.PI / 2, v1: Math.PI / 2 } : null;
    }
    case TOROIDAL_SURFACE: {
      const f = frameFrom(db, pointer(e, 0), pointer(e, 3), pointer(e, 4));
      return f ? { surface: torusSurface(f, numAt(e, 1), numAt(e, 2)), u0: 0, u1: Math.PI * 2, v0: 0, v1: Math.PI * 2 } : null;
    }
    case TABULATED_CYLINDER: {
      // A curve dragged to a point. The direction and length come out of the
      // difference between that point and the curve's own start.
      const c = curveOf(db, pointer(e, 0), scaleHint, depth + 1);
      if (!c) return null;
      const tip: Vec = [numAt(e, 1), numAt(e, 2), numAt(e, 3)];
      const base = c.curve.at(c.domain[0]);
      const along = sub(tip, base);
      const len = length(along);
      if (!len) return null;
      return {
        surface: extrusionSurface(c.curve, along, c.domain),
        u0: c.domain[0], u1: c.domain[1], v0: 0, v1: len,
      };
    }
    case SURFACE_OF_REVOLUTION: {
      const axis = db.get(pointer(e, 0));
      const c = curveOf(db, pointer(e, 1), scaleHint, depth + 1);
      if (!axis || !c || axis.type !== LINE) return null;
      const o: Vec = [numAt(axis, 0), numAt(axis, 1), numAt(axis, 2)];
      const dir = unit(sub([numAt(axis, 3), numAt(axis, 4), numAt(axis, 5)], o));
      const f = frame(o, dir, null);
      const from = numAt(e, 2), to = numAt(e, 3, Math.PI * 2);
      return {
        surface: revolutionSurface(c.curve, f, c.domain),
        u0: c.domain[0], u1: c.domain[1], v0: from, v1: to > from ? to : from + Math.PI * 2,
      };
    }
    case RULED_SURFACE: {
      // Two curves with a straight line swept between them. Read as an
      // extrusion of the first along the offset to the second, which is exact
      // when the two are parallel copies and an approximation otherwise - and
      // the approximation is a ruled surface drawn as the ruled surface between
      // its own ends, which is what it looks like.
      const a = curveOf(db, pointer(e, 0), scaleHint, depth + 1);
      const b = curveOf(db, pointer(e, 1), scaleHint, depth + 1);
      if (!a || !b) return null;
      const along = sub(b.curve.at(b.domain[0]), a.curve.at(a.domain[0]));
      const len = length(along);
      if (!len) return null;
      return {
        surface: extrusionSurface(a.curve, along, a.domain),
        u0: a.domain[0], u1: a.domain[1], v0: 0, v1: len,
      };
    }
    default: return null;
  }
}

function splineSurfaceOf(e: Entity): SurfaceInfo | null {
  // 128: K1 K2 M1 M2 and *five* property flags - closed in each direction,
  // polynomial, periodic in each - then the two knot vectors, the weights, the
  // control points, and the four parameter bounds. Every count is derived from
  // K1, K2, M1 and M2, so the record is walked rather than indexed. The curve
  // form below has four flags rather than five, which is the sort of thing that
  // makes this format what it is.
  const k1 = numAt(e, 0), k2 = numAt(e, 1), m1 = numAt(e, 2), m2 = numAt(e, 3);
  if (![k1, k2, m1, m2].every(n => Number.isSafeInteger(n) && n >= 0)) return null;
  const uCount = k1 + 1, vCount = k2 + 1;
  if (uCount < 1 || vCount < 1 || uCount * vCount > 1_000_000) return null;
  const polynomial = numAt(e, 6) === 1;   // PROP3: 1 = polynomial, 0 = rational

  let at = 9;
  const take = (n: number) => {
    const out: number[] = [];
    for (let i = 0; i < n; i++) out.push(numAt(e, at++));
    return out;
  };
  const uKnots = take(uCount + m1 + 1);
  const vKnots = take(vCount + m2 + 1);
  const weights = take(uCount * vCount);
  const ctrl: Vec[] = [];
  for (let i = 0; i < uCount * vCount; i++) {
    ctrl.push([numAt(e, at), numAt(e, at + 1), numAt(e, at + 2)]);
    at += 3;
  }
  const u0 = numAt(e, at), u1 = numAt(e, at + 1), v0 = numAt(e, at + 2), v1 = numAt(e, at + 3);
  if (!(u1 > u0) || !(v1 > v0)) return null;

  // IGES stores control points in *v-major* order - the first index runs
  // fastest across the second - and the evaluator wants the opposite. This
  // transpose is the whole difference between a surface and its mirror.
  const rows: Vec[] = new Array(uCount * vCount);
  const w: number[] = new Array(uCount * vCount);
  for (let j = 0; j < vCount; j++) {
    for (let i = 0; i < uCount; i++) {
      rows[i * vCount + j] = ctrl[j * uCount + i];
      w[i * vCount + j] = weights[j * uCount + i] ?? 1;
    }
  }

  return {
    surface: splineSurface({
      uDegree: Math.max(1, m1), vDegree: Math.max(1, m2),
      uKnots, vKnots, ctrl: rows,
      weights: polynomial ? null : w,
      uCount, vCount,
    }),
    u0, u1, v0, v1,
  };
}

/** A frame from three pointers: an origin point and up to two directions, each
 *  of which IGES writes as its own entity. */
function frameFrom(db: Db, origin: number, axis: number, ref: number): Frame | null {
  const o = pointOf(db, origin);
  if (!o) return null;
  return frame(o, directionOf(db, axis), directionOf(db, ref));
}

/** Entity 116 is a point; a direction (123) is written the same way. */
function pointOf(db: Db, id: number): Vec | null {
  const e = db.get(id);
  if (!e) return null;
  return [numAt(e, 0), numAt(e, 1), numAt(e, 2)];
}

const directionOf = (db: Db, id: number) => (id ? pointOf(db, id) : null);

// ---------------------------------------------------------------------------
// Curves
// ---------------------------------------------------------------------------

type CurveInfo = { curve: Curve; domain: [number, number] };

function curveOf(db: Db, id: number, scaleHint: number, depth = 0): CurveInfo | null {
  if (depth > MAX_FOLLOW) return null;
  const e = db.get(id);
  if (!e) return null;
  const place = matrixOf(db, e, depth);
  const info = rawCurve(db, e, scaleHint, depth);
  return info && place ? { curve: moved(info.curve, place), domain: info.domain } : info;
}

function rawCurve(db: Db, e: Entity, scaleHint: number, depth: number): CurveInfo | null {
  switch (e.type) {
    case LINE: {
      const a: Vec = [numAt(e, 0), numAt(e, 1), numAt(e, 2)];
      const b: Vec = [numAt(e, 3), numAt(e, 4), numAt(e, 5)];
      return { curve: lineCurve(a, sub(b, a)), domain: [0, 1] };
    }
    case CIRCULAR_ARC: {
      // Flat in the plane z = ZT of the entity's own coordinate system, with a
      // centre, a start and an end. Anticlockwise from start to end, always.
      const z = numAt(e, 0);
      const c: Vec = [numAt(e, 1), numAt(e, 2), z];
      const s: Vec = [numAt(e, 3), numAt(e, 4), z];
      const r = Math.hypot(s[0] - c[0], s[1] - c[1]);
      if (!r) return null;
      const f = frame(c, [0, 0, 1], [1, 0, 0]);
      return { curve: circleCurve(f, r), domain: [0, Math.PI * 2] };
    }
    case COPIOUS_DATA: {
      // Form 1 is (x,y) pairs at a common z, forms 2 and 3 are triples. Form 11
      // upward are the same data as a polyline rather than as scattered points,
      // which is the same thing to a reader that joins them up.
      const form = e.form % 10;
      const stride = form === 1 ? 2 : 3;
      const count = numAt(e, 1);
      const base = form === 1 ? 3 : 2;
      const z = form === 1 ? numAt(e, 2) : 0;
      if (!Number.isSafeInteger(count) || count < 2 || count > 1_000_000) return null;
      const pts: Vec[] = [];
      for (let i = 0; i < count; i++) {
        const o = base + i * stride;
        pts.push(stride === 2
          ? [numAt(e, o), numAt(e, o + 1), z]
          : [numAt(e, o), numAt(e, o + 1), numAt(e, o + 2)]);
      }
      return { curve: polylineCurve(pts), domain: [0, pts.length - 1] };
    }
    case RATIONAL_SPLINE_CURVE: return splineCurveOf(e);
    case COMPOSITE_CURVE: {
      const count = numAt(e, 0);
      if (!Number.isSafeInteger(count) || count < 1 || count > 100_000) return null;
      const pts: Vec[] = [];
      for (let i = 0; i < count; i++) {
        const inner = curveOf(db, pointer(e, 1 + i), scaleHint, depth + 1);
        if (!inner) continue;
        const [lo, hi] = inner.domain;
        const n = inner.curve.segments(lo, hi);
        for (let k = 0; k <= n; k++) pts.push(inner.curve.at(lo + (hi - lo) * k / n));
      }
      return pts.length >= 2 ? { curve: polylineCurve(pts), domain: [0, pts.length - 1] } : null;
    }
    case CURVE_ON_SURFACE:
      // The three-dimensional form is the third pointer; the parameter-space
      // form is the second and is only reached for when there is no other.
      return curveOf(db, pointer(e, 2), scaleHint, depth + 1)
        || curveOf(db, pointer(e, 1), scaleHint, depth + 1);
    default: return null;
  }
}

function splineCurveOf(e: Entity): CurveInfo | null {
  // 126: K M PROP1..4, then knots, weights, control points, and the two bounds.
  const k = numAt(e, 0), m = numAt(e, 1);
  if (!Number.isSafeInteger(k) || !Number.isSafeInteger(m) || k < 0 || m < 1) return null;
  const count = k + 1;
  if (count < 2 || count > 1_000_000) return null;
  const polynomial = numAt(e, 4) === 1;
  let at = 6;
  const knots: number[] = [];
  for (let i = 0; i < count + m + 1; i++) knots.push(numAt(e, at++));
  const weights: number[] = [];
  for (let i = 0; i < count; i++) weights.push(numAt(e, at++));
  const ctrl: Vec[] = [];
  for (let i = 0; i < count; i++) { ctrl.push([numAt(e, at), numAt(e, at + 1), numAt(e, at + 2)]); at += 3; }
  const s = { degree: m, knots, ctrl, weights: polynomial ? null : weights };
  const [lo, hi] = splineDomain(s);
  const v0 = numAt(e, at, lo), v1 = numAt(e, at + 1, hi);
  return { curve: splineCurve(s), domain: [v0 < v1 ? v0 : lo, v0 < v1 ? v1 : hi] };
}

// ---------------------------------------------------------------------------
// Faces
// ---------------------------------------------------------------------------

function readFace(db: Db, e: Entity, scaleHint: number): Facet[] {
  const info = surfaceOf(db, pointer(e, 0), scaleHint);
  const loops = e.type === TRIMMED_SURFACE
    ? trimmedLoops(db, e, scaleHint, info)
    : brepLoops(db, e, scaleHint);
  if (!loops.length) {
    // A trimmed surface whose trimming could not be read is still a surface, and
    // its own rectangle is a better answer than nothing.
    return info ? gridFacets(info.surface, info.u0, info.u1, info.v0, info.v1, scaleHint) : [];
  }
  return info ? faceFacets(info.surface, loops, scaleHint) : flatFacets(loops);
}

/** Entity 144: N1 says whether the outer boundary is the surface's own, N2 how
 *  many inner ones there are, then the outer pointer and the inner ones. */
function trimmedLoops(db: Db, e: Entity, scaleHint: number, info: SurfaceInfo | null): Loop[] {
  const outerIsSurface = numAt(e, 1) === 0;
  const inner = numAt(e, 2);
  const loops: Loop[] = [];

  if (!outerIsSurface) {
    const points = boundaryPoints(db, pointer(e, 3), scaleHint, info);
    if (points.length >= 3) loops.push({ points, outer: true });
  }
  if (Number.isSafeInteger(inner) && inner > 0 && inner < 100_000) {
    for (let i = 0; i < inner; i++) {
      const points = boundaryPoints(db, pointer(e, 4 + i), scaleHint, info);
      if (points.length >= 3) loops.push({ points, outer: false });
    }
  }
  return loops;
}

/** One trimming curve, in three dimensions. Where the file gives only the
 *  parameter-space form, it is evaluated and pushed through the surface, which
 *  is exactly what the parameter form means. */
function boundaryPoints(db: Db, id: number, scaleHint: number, info: SurfaceInfo | null): Vec[] {
  const three = curveOf(db, id, scaleHint);
  if (three) return sampleCurve(three);
  const e = db.get(id);
  if (!e || e.type !== CURVE_ON_SURFACE || !info) return [];
  const flat = curveOf(db, pointer(e, 1), scaleHint);
  if (!flat) return [];
  // A parameter-space curve's "z" is unused and its x and y are u and v.
  return sampleCurve(flat).map(p => info.surface.at(p[0], p[1]));
}

function sampleCurve(info: CurveInfo): Vec[] {
  const [lo, hi] = info.domain;
  const n = Math.max(1, info.curve.segments(lo, hi));
  const out: Vec[] = [];
  for (let k = 0; k <= n; k++) out.push(info.curve.at(lo + (hi - lo) * k / n));
  // A closed curve arrives with its last point on its first.
  while (out.length > 1 && length(sub(out[0], out[out.length - 1])) < 1e-12) out.pop();
  return out;
}

/** Entity 510: a face is a surface and a list of 508 loops, each a list of
 *  edges out of a 504 edge list, each naming two vertices in a 502 list. */
function brepLoops(db: Db, face: Entity, scaleHint: number): Loop[] {
  const count = numAt(face, 1);
  if (!Number.isSafeInteger(count) || count < 1 || count > 100_000) return [];
  const outerFirst = numAt(face, 2) === 1;
  const loops: Loop[] = [];
  for (let i = 0; i < count; i++) {
    const loop = db.get(pointer(face, 3 + i));
    if (!loop || loop.type !== LOOP) continue;
    const points = loopPoints(db, loop, scaleHint);
    if (points.length >= 3) loops.push({ points, outer: outerFirst ? loops.length === 0 : false });
  }
  if (loops.length && !loops.some(l => l.outer)) loops[0].outer = true;
  return loops;
}

function loopPoints(db: Db, loop: Entity, scaleHint: number): Vec[] {
  const edges = numAt(loop, 0);
  if (!Number.isSafeInteger(edges) || edges < 1 || edges > 100_000) return [];
  const out: Vec[] = [];
  // Each edge contributes five values: a type flag, the list it lives in, the
  // index into that list, an orientation, and a count of parameter curves -
  // which is then followed by that many pairs, so the stride is not fixed.
  let at = 1;
  for (let i = 0; i < edges; i++) {
    const kind = numAt(loop, at);
    const listId = pointer(loop, at + 1);
    const index = numAt(loop, at + 2);
    const forward = numAt(loop, at + 3) !== 0;
    const extra = numAt(loop, at + 4);
    at += 5 + (Number.isSafeInteger(extra) && extra > 0 ? extra * 2 : 0);

    const list = db.get(listId);
    if (!list) continue;
    let points: Vec[] = [];
    if (kind === 0 && list.type === VERTEX_LIST) {
      // A degenerate edge: one vertex, which contributes a single point.
      const o = 1 + (index - 1) * 3;
      points = [[numAt(list, o), numAt(list, o + 1), numAt(list, o + 2)]];
    } else if (list.type === EDGE_LIST) {
      // Five values an entry: the curve, then the start and end vertices as a
      // list pointer and an index each.
      const o = 1 + (index - 1) * 5;
      const info = curveOf(db, pointer(list, o), scaleHint);
      if (info) points = sampleCurve(info);
    }
    if (!forward) points = points.slice().reverse();
    for (const p of points) {
      const last = out[out.length - 1];
      if (last && length(sub(last, p)) < 1e-12) continue;
      out.push(p);
    }
  }
  while (out.length > 1 && length(sub(out[0], out[out.length - 1])) < 1e-12) out.pop();
  return out;
}

// ---------------------------------------------------------------------------
// Placement and colour
// ---------------------------------------------------------------------------

type Matrix = { m: number[]; t: Vec };

const applyTo = (x: Matrix, p: Vec): Vec => [
  x.m[0] * p[0] + x.m[1] * p[1] + x.m[2] * p[2] + x.t[0],
  x.m[3] * p[0] + x.m[4] * p[1] + x.m[5] * p[2] + x.t[1],
  x.m[6] * p[0] + x.m[7] * p[1] + x.m[8] * p[2] + x.t[2],
];

const spinBy = (x: Matrix, n: Vec): Vec => unit([
  x.m[0] * n[0] + x.m[1] * n[1] + x.m[2] * n[2],
  x.m[3] * n[0] + x.m[4] * n[1] + x.m[5] * n[2],
  x.m[6] * n[0] + x.m[7] * n[1] + x.m[8] * n[2],
]);

/** Entity 124, and the chain of them an entity may sit under. */
function matrixOf(db: Db, e: Entity, depth: number): Matrix | null {
  if (!e.transform || depth > MAX_FOLLOW) return null;
  const t = db.get(e.transform);
  if (!t || t.type !== TRANSFORM) return null;
  const m = [
    numAt(t, 0), numAt(t, 1), numAt(t, 2),
    numAt(t, 4), numAt(t, 5), numAt(t, 6),
    numAt(t, 8), numAt(t, 9), numAt(t, 10),
  ];
  const here: Matrix = { m, t: [numAt(t, 3), numAt(t, 7), numAt(t, 11)] };
  const up = matrixOf(db, t, depth + 1);
  if (!up) return here;
  // A transform may itself be placed by another, and the outer one applies last.
  const out = new Array(9);
  for (let row = 0; row < 3; row++) {
    for (let col = 0; col < 3; col++) {
      out[row * 3 + col] =
        up.m[row * 3] * here.m[col] + up.m[row * 3 + 1] * here.m[3 + col] + up.m[row * 3 + 2] * here.m[6 + col];
    }
  }
  return { m: out, t: applyTo(up, here.t) };
}

/** A curve with a placement baked in, so the tessellator never sees the two
 *  separately - it inverts curves against surfaces and both have to be in the
 *  same space for that to mean anything. */
function moved(curve: Curve, m: Matrix): Curve {
  return {
    at: t => applyTo(m, curve.at(t)),
    // The inverse would need the matrix inverted; every placement IGES writes
    // is a rigid motion, whose inverse is its transpose.
    param: p => curve.param(unapply(m, p)),
    period: curve.period,
    segments: curve.segments,
  };
}

const unapply = (x: Matrix, p: Vec): Vec => {
  const d = sub(p, x.t);
  return [
    x.m[0] * d[0] + x.m[3] * d[1] + x.m[6] * d[2],
    x.m[1] * d[0] + x.m[4] * d[1] + x.m[7] * d[2],
    x.m[2] * d[0] + x.m[5] * d[1] + x.m[8] * d[2],
  ];
};

/**
 * The colour of an entity: a pointer to a 314 definition, or one of the eight
 * the format numbers outright.
 *
 * The numbered ones are stored as a negative colour field, which is the
 * format's way of distinguishing a small pointer from a small constant.
 */
function colourOf(db: Db, e: Entity): number[] | null {
  if (!e.colour) return null;
  if (e.colour > 0) {
    const def = db.get(e.colour);
    if (def && def.type === COLOUR) {
      // Percentages, not fractions.
      return [clamp01(numAt(def, 0) / 100), clamp01(numAt(def, 1) / 100), clamp01(numAt(def, 2) / 100)];
    }
    return STANDARD[e.colour] || null;
  }
  return STANDARD[-e.colour] || null;
}

/** The format's own numbered colours, in its own order. */
const STANDARD: Record<number, number[]> = {
  1: [0, 0, 0], 2: [1, 0, 0], 3: [0, 1, 0], 4: [0, 0, 1],
  5: [1, 1, 0], 6: [1, 0, 1], 7: [0, 1, 1], 8: [1, 1, 1],
};
