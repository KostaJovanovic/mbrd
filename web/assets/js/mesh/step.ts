// STEP (ISO 10303-21) - the format mechanical CAD actually exchanges in.
//
// A .step or .stp is not a mesh. It is a database: numbered records, each an
// entity with typed arguments, referring to each other by number. A part is a
// solid, which is a shell, which is a list of faces, each of which is a surface
// trimmed by loops of edges, each of which is a curve between two points. There
// is not a triangle anywhere in it.
//
// Which is why viewers ship a CAD kernel and why this does not. mesh/brep.ts is
// the tessellator - given a surface and its boundary loops it produces triangles
// - and this file is the half that reads the database and works out which
// surfaces and which loops. The two are split because IGES needs the same
// tessellator behind a completely different front end.
//
// **What is read.** ADVANCED_FACE and FACE_SURFACE, over planes, cylinders,
// cones, spheres, tori, NURBS patches, extrusions and surfaces of revolution;
// edges over lines, circles, ellipses, NURBS curves and polylines; the assembly
// transforms that place one part's representation inside another's; and the
// presentation colours a modeller assigned to a solid or a face.
//
// **What is not.** Everything that does not change the picture: tolerances,
// dimensions, product structure metadata, materials in the engineering sense,
// validation properties. And two things that do: `TESSELLATED_SHAPE_REPRESENTATION`
// (AP242's optional pre-triangulated form, which almost nothing writes), and
// exotic trimmed-surface types this has no formula for - those fall back to a
// flat fill of the face's boundary rather than to a hole, which brep.ts's header
// argues for at length.
//
// **The honest limitation.** This is an approximation of a boundary
// representation, not an evaluation of one. A face whose boundary crosses a
// surface's seam in more than one place, a spline patch whose parameter search
// lands in the wrong basin, a hole bridged into a loop that another hole already
// crossed - each produces a face that is slightly wrong rather than a file that
// fails. At the size a card draws a model these are invisible. Scaled up, they
// are not, and this is not a substitute for a CAD viewer.

import { oversize } from '../consent.ts';
import {
  CAPS, MeshError, MeshBuild, type Mesh, clamp01, tooBig,
} from './shared.ts';
import {
  type Curve, type Facet, type Frame, type Loop, type Surface, type Vec,
  circleCurve, coneSurface, cylinderSurface, ellipseCurve, expandKnots,
  extrusionSurface, faceFacets, flatFacets, frame, length, lineCurve, planeSurface,
  polylineCurve, revolutionSurface, splineCurve, splineDomain, splineSurface,
  sphereSurface, sub, torusSurface, unit,
} from './brep.ts';

/** The most records one file may declare. A large aircraft part is a few hundred
 *  thousand; this is well past anything a card is going to draw and well short
 *  of a number that would exhaust the tab before the ceiling below is reached. */
const MAX_ENTITIES = 4_000_000;

/** The most faces one model may tessellate. Each is tens of triangles, so this
 *  and MAX_TRIANGLES bound each other from opposite ends. */
const MAX_FACES = 200_000;

/** How deep a reference chain is followed when looking for a colour or a
 *  transform. Both are short in every real file; this is the cycle guard. */
const MAX_FOLLOW = 12;

// ---------------------------------------------------------------------------
// The exchange structure
// ---------------------------------------------------------------------------

type Ref = { ref: number };
type Typed = { type: string; args: Val[] };
type Val = number | string | boolean | null | Ref | Val[] | Typed;

/** One record. `parts` is set only for a complex instance - `#3=(A(..) B(..))` -
 *  which is how STEP expresses multiple inheritance, and how every rational
 *  spline and every transformed representation relationship is written. */
type Entity = { type: string; args: Val[]; parts: Typed[] | null };

const isRef = (v: Val): v is Ref => !!v && typeof v === 'object' && 'ref' in v;
const isList = (v: Val): v is Val[] => Array.isArray(v);

export function parseSTEP(bytes: string | ArrayBuffer): Mesh {
  const text = typeof bytes === 'string' ? bytes : new TextDecoder('latin1').decode(bytes);
  const db = readExchange(text);
  return build(db);
}

/**
 * Every `#n = TYPE(args);` record in the data section.
 *
 * Scanned rather than matched with a regular expression, for one reason: a
 * string in this format may contain a semicolon, a parenthesis, or the text
 * `ENDSEC`, and any of the three would end the record early. So the scan carries
 * one piece of state - whether it is inside a quoted string - and that is enough
 * to make every delimiter below trustworthy.
 */
function readExchange(text: string) {
  const db = new Map<number, Entity>();
  // Comments first. They may appear anywhere, including inside an argument list,
  // and they may not nest.
  const body = stripComments(text);
  const dataAt = body.indexOf('DATA;');
  if (dataAt < 0 && !body.includes('ISO-10303-21')) throw new MeshError('This is not a STEP file');
  let at = dataAt < 0 ? 0 : dataAt + 5;

  while (at < body.length) {
    const hash = body.indexOf('#', at);
    if (hash < 0) break;
    // Only a `#` at the start of a record declares one; the ones inside an
    // argument list are references and are read by the value parser.
    let i = hash + 1;
    let id = 0;
    while (i < body.length && body.charCodeAt(i) >= 48 && body.charCodeAt(i) <= 57) {
      id = id * 10 + (body.charCodeAt(i) - 48);
      i++;
    }
    if (i === hash + 1) { at = hash + 1; continue; }
    i = skipSpace(body, i);
    if (body[i] !== '=') { at = hash + 1; continue; }
    i = skipSpace(body, i + 1);

    const end = recordEnd(body, i);
    if (end < 0) break;
    if (db.size >= MAX_ENTITIES) throw new MeshError('This STEP file has more records than a model has');
    const entity = readEntity(body.slice(i, end));
    if (entity) db.set(id, entity);
    at = end + 1;
  }
  if (!db.size) throw new MeshError('This STEP file has no records in it');
  return db;
}

function stripComments(text: string) {
  if (!text.includes('/*')) return text;
  let out = '';
  let at = 0;
  let quoted = false;
  while (at < text.length) {
    const c = text[at];
    if (quoted) {
      out += c;
      if (c === "'") quoted = false;
      at++;
      continue;
    }
    if (c === "'") { quoted = true; out += c; at++; continue; }
    if (c === '/' && text[at + 1] === '*') {
      const end = text.indexOf('*/', at + 2);
      // Replaced by a space rather than removed, so a comment between two tokens
      // does not glue them together.
      out += ' ';
      at = end < 0 ? text.length : end + 2;
      continue;
    }
    out += c;
    at++;
  }
  return out;
}

/** The `;` that ends a record, skipping any inside a quoted string. */
function recordEnd(text: string, from: number) {
  let quoted = false;
  for (let i = from; i < text.length; i++) {
    const c = text[i];
    if (quoted) {
      // `''` is an escaped quote inside a STEP string and is the only escape
      // that changes where the string ends.
      if (c === "'") { if (text[i + 1] === "'") i++; else quoted = false; }
      continue;
    }
    if (c === "'") { quoted = true; continue; }
    if (c === ';') return i;
  }
  return -1;
}

const skipSpace = (text: string, at: number) => {
  while (at < text.length && text.charCodeAt(at) <= 32) at++;
  return at;
};

/** `TYPE(args)` or `(TYPE1(args) TYPE2(args))`. */
function readEntity(src: string): Entity | null {
  const at = skipSpace(src, 0);
  if (src[at] === '(') {
    const parts: Typed[] = [];
    let i = at + 1;
    for (;;) {
      i = skipSpace(src, i);
      if (i >= src.length || src[i] === ')') break;
      const one = readTyped(src, i);
      if (!one) break;
      parts.push(one.value);
      i = one.next;
    }
    if (!parts.length) return null;
    return { type: parts[0].type, args: parts[0].args, parts };
  }
  const one = readTyped(src, at);
  return one ? { type: one.value.type, args: one.value.args, parts: null } : null;
}

function readTyped(src: string, from: number): { value: Typed; next: number } | null {
  let i = skipSpace(src, from);
  const start = i;
  while (i < src.length && /[A-Za-z0-9_]/.test(src[i])) i++;
  if (i === start) return null;
  const type = src.slice(start, i).toUpperCase();
  i = skipSpace(src, i);
  if (src[i] !== '(') return { value: { type, args: [] }, next: i };
  const list = readList(src, i);
  return { value: { type, args: list.value }, next: list.next };
}

/** A parenthesised, comma-separated argument list. */
function readList(src: string, from: number): { value: Val[]; next: number } {
  const out: Val[] = [];
  let i = from + 1;
  for (;;) {
    i = skipSpace(src, i);
    if (i >= src.length) break;
    if (src[i] === ')') { i++; break; }
    if (src[i] === ',') { i++; continue; }
    const v = readValue(src, i);
    out.push(v.value);
    i = v.next;
  }
  return { value: out, next: i };
}

function readValue(src: string, from: number): { value: Val; next: number } {
  const i = skipSpace(src, from);
  const c = src[i];
  if (c === '(') {
    const list = readList(src, i);
    return { value: list.value, next: list.next };
  }
  if (c === "'") {
    let j = i + 1;
    let out = '';
    while (j < src.length) {
      if (src[j] === "'") {
        if (src[j + 1] === "'") { out += "'"; j += 2; continue; }
        j++;
        break;
      }
      out += src[j++];
    }
    return { value: out, next: j };
  }
  if (c === '#') {
    let j = i + 1;
    let id = 0;
    while (j < src.length && src.charCodeAt(j) >= 48 && src.charCodeAt(j) <= 57) {
      id = id * 10 + (src.charCodeAt(j) - 48);
      j++;
    }
    return { value: { ref: id }, next: j };
  }
  if (c === '.') {
    // An enumeration: `.T.`, `.F.`, `.UNSPECIFIED.`. The two booleans are the
    // only ones any reading here depends on.
    const end = src.indexOf('.', i + 1);
    const word = end < 0 ? '' : src.slice(i + 1, end);
    const next = end < 0 ? src.length : end + 1;
    if (word === 'T') return { value: true, next };
    if (word === 'F') return { value: false, next };
    return { value: word, next };
  }
  if (c === '$' || c === '*') return { value: null, next: i + 1 };
  // A number, or a typed value like `LENGTH_MEASURE(1.)` inside a select.
  let j = i;
  while (j < src.length && !',)'.includes(src[j])) j++;
  const raw = src.slice(i, j).trim();
  if (/^[A-Za-z_]/.test(raw)) {
    const typed = readTyped(src, i);
    if (typed) return { value: typed.value, next: typed.next };
  }
  const n = Number(raw);
  return { value: Number.isFinite(n) ? n : raw, next: j };
}

// ---------------------------------------------------------------------------
// Reading the model
// ---------------------------------------------------------------------------

type Db = Map<number, Entity>;

/** The one place a reference is resolved, so a dangling one is a null rather
 *  than a crash six frames down. */
const at = (db: Db, v: Val): Entity | null => (isRef(v) ? db.get(v.ref) || null : null);

/** The arguments of one branch of a complex instance, or of a plain one. */
function partArgs(e: Entity | null, type: string): Val[] | null {
  if (!e) return null;
  if (e.type === type) return e.args;
  for (const p of e.parts || []) if (p.type === type) return p.args;
  return null;
}

const isType = (e: Entity | null, type: string) =>
  !!e && (e.type === type || (e.parts || []).some(p => p.type === type));

const num = (v: Val, fallback = 0) => (typeof v === 'number' ? v : fallback);

function build(db: Db): Mesh {
  const scaleHint = modelSize(db);
  const placement = placements(db);
  const colours = styleColours(db);

  const build = new MeshBuild();
  let faces = 0;

  for (const [id, entity] of db) {
    if (!isType(entity, 'ADVANCED_FACE') && !isType(entity, 'FACE_SURFACE')) continue;
    if (++faces > MAX_FACES) throw new MeshError('This STEP file has more faces than a drawing has');
    const facets = readFace(db, entity, scaleHint);
    if (!facets.length) continue;
    const m = placement.get(id) || null;
    const rgb = colours.get(id) || null;
    for (const facet of facets) {
      if (build.count >= CAPS.tri) throw oversize('mesh-triangles', tooBig(CAPS.tri));
      const p = m ? facet.p.map(q => applyTo(m, q)) : facet.p;
      const n = m ? facet.n.map(q => spinBy(m, q)) : facet.n;
      build.tri(p[0][0], p[0][1], p[0][2], p[1][0], p[1][1], p[1][2], p[2][0], p[2][1], p[2][2], rgb);
      build.normals(n[0], n[1], n[2]);
    }
  }

  if (!build.count) throw new MeshError('This STEP file has no surfaces this can draw');
  return build.done();
}

/**
 * The size of the whole model, from its points alone.
 *
 * Needed before anything is tessellated, because the chord tolerance in brep.ts
 * is relative - a file in metres and the same file in millimetres must come out
 * with the same number of triangles. Reading every CARTESIAN_POINT once is far
 * cheaper than it sounds next to the tessellation that follows.
 */
function modelSize(db: Db) {
  const lo = [Infinity, Infinity, Infinity];
  const hi = [-Infinity, -Infinity, -Infinity];
  for (const e of db.values()) {
    if (e.type !== 'CARTESIAN_POINT') continue;
    const c = e.args[1];
    if (!isList(c) || c.length < 3) continue;
    for (let k = 0; k < 3; k++) {
      const v = num(c[k]);
      if (v < lo[k]) lo[k] = v;
      if (v > hi[k]) hi[k] = v;
    }
  }
  const span = Number.isFinite(lo[0]) ? Math.hypot(hi[0] - lo[0], hi[1] - lo[1], hi[2] - lo[2]) : 0;
  return span > 0 ? span : 1;
}

// ---------------------------------------------------------------------------
// Geometry
// ---------------------------------------------------------------------------

function point(db: Db, v: Val): Vec | null {
  const e = at(db, v);
  if (!e || e.type !== 'CARTESIAN_POINT') return null;
  const c = e.args[1];
  if (!isList(c) || c.length < 2) return null;
  return [num(c[0]), num(c[1]), num(c[2])];
}

/** A list of point references, with the ones that resolved to nothing dropped.
 *  A dangling reference in a vertex list is a broken file and the rest of the
 *  loop is still worth having. */
function points(db: Db, v: Val): Vec[] {
  if (!isList(v)) return [];
  const out: Vec[] = [];
  for (const item of v) {
    const p = point(db, item);
    if (p) out.push(p);
  }
  return out;
}

function direction(db: Db, v: Val): Vec | null {
  const e = at(db, v);
  if (!e || (e.type !== 'DIRECTION' && e.type !== 'VECTOR')) return null;
  if (e.type === 'VECTOR') return direction(db, e.args[1]);
  const c = e.args[1];
  if (!isList(c) || c.length < 2) return null;
  return [num(c[0]), num(c[1]), num(c[2])];
}

/** An AXIS2_PLACEMENT_3D, which is how every placement in the format is written. */
function placementFrame(db: Db, v: Val): Frame | null {
  const e = at(db, v);
  if (!e) return null;
  const args = partArgs(e, 'AXIS2_PLACEMENT_3D') || (e.type.startsWith('AXIS2_PLACEMENT') ? e.args : null);
  if (!args) return null;
  const o = point(db, args[1]);
  if (!o) return null;
  return frame(o, direction(db, args[2]), direction(db, args[3]));
}

function surfaceOf(db: Db, v: Val, scaleHint: number): Surface | null {
  const e = at(db, v);
  if (!e) return null;

  const spline = splineSurfaceOf(db, e);
  if (spline) return spline;

  switch (e.type) {
    case 'PLANE': {
      const f = placementFrame(db, e.args[1]);
      return f ? planeSurface(f) : null;
    }
    case 'CYLINDRICAL_SURFACE': {
      const f = placementFrame(db, e.args[1]);
      return f ? cylinderSurface(f, num(e.args[2])) : null;
    }
    case 'CONICAL_SURFACE': {
      const f = placementFrame(db, e.args[1]);
      return f ? coneSurface(f, num(e.args[2]), num(e.args[3])) : null;
    }
    case 'SPHERICAL_SURFACE': {
      const f = placementFrame(db, e.args[1]);
      return f ? sphereSurface(f, num(e.args[2])) : null;
    }
    case 'TOROIDAL_SURFACE':
    case 'DEGENERATE_TOROIDAL_SURFACE': {
      const f = placementFrame(db, e.args[1]);
      return f ? torusSurface(f, num(e.args[2]), num(e.args[3])) : null;
    }
    case 'SURFACE_OF_LINEAR_EXTRUSION': {
      const c = curveOf(db, e.args[1], scaleHint);
      const d = direction(db, e.args[2]);
      return c && d ? extrusionSurface(c.curve, d, c.domain) : null;
    }
    case 'SURFACE_OF_REVOLUTION': {
      const c = curveOf(db, e.args[1], scaleHint);
      const f = placementFrame(db, e.args[2]);
      return c && f ? revolutionSurface(c.curve, f, c.domain) : null;
    }
    // A trimmed or offset surface is drawn as the thing it was made from. The
    // trim is carried by the face's own loops in every file that writes one, and
    // an offset of a few thousandths is invisible at a card's size.
    case 'RECTANGULAR_TRIMMED_SURFACE':
    case 'CURVE_BOUNDED_SURFACE':
    case 'RECTANGULAR_COMPOSITE_SURFACE':
      return surfaceOf(db, e.args[1], scaleHint);
    case 'OFFSET_SURFACE':
      return surfaceOf(db, e.args[1], scaleHint);
    default:
      return null;
  }
}

function splineSurfaceOf(db: Db, e: Entity): Surface | null {
  const args = partArgs(e, 'B_SPLINE_SURFACE_WITH_KNOTS');
  const base = partArgs(e, 'B_SPLINE_SURFACE') || args;
  if (!args || !base) return null;

  const grid = base[3];
  if (!isList(grid) || !grid.length) return null;
  const uCount = grid.length;
  const rows = grid.map(row => (isList(row) ? row : []));
  const vCount = rows[0].length;
  if (!vCount) return null;

  const ctrl: Vec[] = [];
  for (const row of rows) {
    if (row.length !== vCount) return null;
    for (const cell of row) {
      const p = point(db, cell);
      if (!p) return null;
      ctrl.push(p);
    }
  }

  // The knot data sits on the WITH_KNOTS branch: multiplicities then knots, in
  // that order, for u and then v.
  const uMults = numbers(args[8]);
  const vMults = numbers(args[9]);
  const uKnots = expandKnots(numbers(args[10]), uMults);
  const vKnots = expandKnots(numbers(args[11]), vMults);
  if (uKnots.length < uCount || vKnots.length < vCount) return null;

  // A rational surface carries its weights on a second branch of the same
  // complex instance, in the same row-major order as the control points.
  const rational = partArgs(e, 'RATIONAL_B_SPLINE_SURFACE');
  let weights: number[] | null = null;
  if (rational && isList(rational[0])) {
    weights = [];
    for (const row of rational[0]) {
      if (!isList(row)) { weights = null; break; }
      for (const w of row) weights.push(num(w, 1));
    }
    if (weights && weights.length !== ctrl.length) weights = null;
  }

  return splineSurface({
    uDegree: Math.max(1, num(base[1], 1)),
    vDegree: Math.max(1, num(base[2], 1)),
    uKnots, vKnots, ctrl, weights, uCount, vCount,
  });
}

const numbers = (v: Val): number[] => (isList(v) ? v.map(x => num(x)) : []);

type CurveInfo = { curve: Curve; domain: [number, number] };

function curveOf(db: Db, v: Val, scaleHint: number): CurveInfo | null {
  const e = at(db, v);
  if (!e) return null;

  const spline = splineCurveOf(db, e);
  if (spline) return spline;

  switch (e.type) {
    case 'LINE': {
      const o = point(db, e.args[1]);
      const d = direction(db, e.args[2]);
      const mag = magnitudeOf(db, e.args[2]);
      if (!o || !d) return null;
      const dir: Vec = [d[0] * mag, d[1] * mag, d[2] * mag];
      return { curve: lineCurve(o, dir), domain: [0, 1] };
    }
    case 'CIRCLE': {
      const f = placementFrame(db, e.args[1]);
      return f ? { curve: circleCurve(f, num(e.args[2])), domain: [0, Math.PI * 2] } : null;
    }
    case 'ELLIPSE': {
      const f = placementFrame(db, e.args[1]);
      return f ? { curve: ellipseCurve(f, num(e.args[2]), num(e.args[3])), domain: [0, Math.PI * 2] } : null;
    }
    case 'POLYLINE': {
      const ok = points(db, e.args[1]);
      return ok.length >= 2 ? { curve: polylineCurve(ok), domain: [0, ok.length - 1] } : null;
    }
    // A composite or trimmed curve is followed to what it is made of. Its own
    // trimming is redundant here: the edge already says which two points it runs
    // between, and those are what the sampling uses.
    case 'TRIMMED_CURVE':
      return curveOf(db, e.args[1], scaleHint);
    case 'COMPOSITE_CURVE': {
      const points: Vec[] = [];
      if (isList(e.args[1])) {
        for (const seg of e.args[1]) {
          const s = at(db, seg);
          if (!s) continue;
          const inner = curveOf(db, s.args[2], scaleHint);
          if (!inner) continue;
          const [lo, hi] = inner.domain;
          const n = inner.curve.segments(lo, hi);
          for (let k = 0; k <= n; k++) points.push(inner.curve.at(lo + (hi - lo) * k / n));
        }
      }
      return points.length >= 2 ? { curve: polylineCurve(points), domain: [0, points.length - 1] } : null;
    }
    case 'SEAM_CURVE':
    case 'SURFACE_CURVE':
    case 'INTERSECTION_CURVE':
      // The first argument is the curve in 3D space; the rest are its two
      // representations on the surfaces it lies on, which this does not need.
      return curveOf(db, e.args[1], scaleHint);
    default:
      return null;
  }
}

/** A LINE's direction is a VECTOR, whose magnitude is its own argument. Ignoring
 *  it makes every line parameter come out scaled, which is invisible until an
 *  edge is trimmed against a parameter from somewhere else. */
function magnitudeOf(db: Db, v: Val) {
  const e = at(db, v);
  if (!e || e.type !== 'VECTOR') return 1;
  const m = num(e.args[2], 1);
  return m || 1;
}

function splineCurveOf(db: Db, e: Entity): CurveInfo | null {
  const args = partArgs(e, 'B_SPLINE_CURVE_WITH_KNOTS');
  const base = partArgs(e, 'B_SPLINE_CURVE') || args;
  if (!args || !base) return null;
  const list = base[2];
  if (!isList(list) || list.length < 2) return null;
  const ctrl: Vec[] = [];
  for (const c of list) {
    const p = point(db, c);
    if (!p) return null;
    ctrl.push(p);
  }
  const knots = expandKnots(numbers(args[7]), numbers(args[6]));
  if (knots.length < ctrl.length) return null;

  const rational = partArgs(e, 'RATIONAL_B_SPLINE_CURVE');
  let weights: number[] | null = null;
  if (rational && isList(rational[0])) {
    weights = rational[0].map(w => num(w, 1));
    if (weights.length !== ctrl.length) weights = null;
  }

  const s = { degree: Math.max(1, num(base[1], 1)), knots, ctrl, weights };
  return { curve: splineCurve(s), domain: splineDomain(s) };
}

// ---------------------------------------------------------------------------
// Topology
// ---------------------------------------------------------------------------

function readFace(db: Db, face: Entity, scaleHint: number): Facet[] {
  const args = partArgs(face, 'ADVANCED_FACE') || partArgs(face, 'FACE_SURFACE') || face.args;
  const boundList = args[1];
  if (!isList(boundList) || !boundList.length) return [];
  const surface = surfaceOf(db, args[2], scaleHint);
  // `same_sense` false means the face's normal is the surface's reversed.
  const sameSense = args[3] !== false;

  const loops: Loop[] = [];
  for (const b of boundList) {
    const bound = at(db, b);
    if (!bound) continue;
    const outer = isType(bound, 'FACE_OUTER_BOUND');
    const points = readLoop(db, bound.args[1], scaleHint);
    if (points.length < 3) continue;
    // The bound's own orientation flag reverses the loop it names.
    if (bound.args[2] === false) points.reverse();
    loops.push({ points, outer });
  }
  if (!loops.length) return [];
  // Exactly one outer bound, and a face that declared none gets the longest loop
  // as its outer - which is what a converter that dropped the distinction meant.
  if (!loops.some(l => l.outer)) {
    let best = 0;
    for (let i = 1; i < loops.length; i++) if (loops[i].points.length > loops[best].points.length) best = i;
    loops[best].outer = true;
  }

  const facets = surface ? faceFacets(surface, loops, scaleHint) : flatFacets(loops);
  if (sameSense) return facets;
  // Reversed: the winding *and* the normals, or the card is lit from inside.
  return facets.map(f => ({ p: [f.p[0], f.p[2], f.p[1]], n: [neg(f.n[0]), neg(f.n[2]), neg(f.n[1])] }));
}

const neg = (v: Vec): Vec => [-v[0], -v[1], -v[2]];

/** One loop, sampled into 3D points. */
function readLoop(db: Db, v: Val, scaleHint: number): Vec[] {
  const loop = at(db, v);
  if (!loop) return [];

  if (isType(loop, 'POLY_LOOP')) return points(db, loop.args[1]);
  if (!isType(loop, 'EDGE_LOOP')) return [];

  const edges = loop.args[1];
  if (!isList(edges)) return [];
  const out: Vec[] = [];
  for (const e of edges) {
    const oriented = at(db, e);
    if (!oriented) continue;
    // ORIENTED_EDGE(name, start, end, edge_element, orientation). The two
    // vertices are always `*` - derived from the edge it names - which is why
    // the element is the fourth argument and not the second.
    const forward = oriented.args[4] !== false;
    const edge = at(db, oriented.args[3]);
    if (!edge) continue;
    for (const p of sampleEdge(db, edge, forward, scaleHint)) {
      // Consecutive edges share a vertex; keeping both copies puts a
      // zero-length segment in the polygon, which is an ear the clipper has to
      // work around for no gain.
      const last = out[out.length - 1];
      if (last && length(sub(last, p)) < 1e-12) continue;
      out.push(p);
    }
  }
  // And the loop closes, so the last point is the first.
  while (out.length > 1 && length(sub(out[0], out[out.length - 1])) < 1e-12) out.pop();
  return out;
}

/**
 * One edge, from its start vertex to its end, as a polyline.
 *
 * The direction is two flags multiplied together: the oriented edge's, and the
 * edge curve's own `same_sense`. Both are ordinary and both occur false, and
 * getting the product wrong reverses a loop - which reads as a face turned
 * inside out rather than as an error.
 */
function sampleEdge(db: Db, edge: Entity, forward: boolean, scaleHint: number): Vec[] {
  const args = partArgs(edge, 'EDGE_CURVE') || edge.args;
  const a = vertexPoint(db, args[1]);
  const b = vertexPoint(db, args[2]);
  const info = curveOf(db, args[3], scaleHint);
  const sameSense = args[4] !== false;

  if (!a || !b) return [];
  if (!info) return forward ? [a] : [b];

  const dir = (forward ? 1 : -1) * (sameSense ? 1 : -1);
  const from = dir > 0 ? a : b;
  const to = dir > 0 ? b : a;

  const { curve } = info;
  let t0 = curve.param(from);
  let t1 = curve.param(to);

  if (curve.period) {
    // A closed edge - both vertices the same point - is a full turn, not a zero
    // one. Otherwise the span is brought into the direction the edge runs.
    const closed = length(sub(from, to)) < 1e-9 * Math.max(1, scaleHint);
    if (closed) t1 = t0 + dir * curve.period;
    else {
      while (dir > 0 && t1 <= t0) t1 += curve.period;
      while (dir < 0 && t1 >= t0) t1 -= curve.period;
    }
  } else if (dir < 0 && t1 > t0) {
    // A non-periodic curve read backwards: swap so the walk below still runs
    // from t0 to t1.
    [t0, t1] = [t1, t0];
  }

  const n = Math.max(1, curve.segments(t0, t1));
  const out: Vec[] = [from];
  for (let k = 1; k < n; k++) out.push(curve.at(t0 + (t1 - t0) * k / n));
  out.push(to);
  return out;
}

function vertexPoint(db: Db, v: Val): Vec | null {
  const e = at(db, v);
  if (!e) return null;
  if (e.type === 'CARTESIAN_POINT') return point(db, v);
  return point(db, e.args[1]);
}

// ---------------------------------------------------------------------------
// Assemblies
// ---------------------------------------------------------------------------

type Matrix = { m: number[]; t: Vec };
const UNIT: Matrix = { m: [1, 0, 0, 0, 1, 0, 0, 0, 1], t: [0, 0, 0] };

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

function times(outer: Matrix, inner: Matrix): Matrix {
  const m = new Array(9);
  for (let row = 0; row < 3; row++) {
    for (let col = 0; col < 3; col++) {
      m[row * 3 + col] =
        outer.m[row * 3] * inner.m[col] +
        outer.m[row * 3 + 1] * inner.m[3 + col] +
        outer.m[row * 3 + 2] * inner.m[6 + col];
    }
  }
  return { m, t: applyTo(outer, inner.t) };
}

/**
 * Where each face ends up, once the assembly is put together.
 *
 * An assembly in STEP is a set of *representation relationships*: a component's
 * shape representation is related to its parent's, with an
 * ITEM_DEFINED_TRANSFORMATION saying where. The transformation is given as two
 * placements, and the transform is the one that carries the first onto the
 * second.
 *
 * A file with no such relationships - a single part, which is most of them -
 * gets nothing from this and every face is already where it belongs.
 *
 * The convention read here is the one every open reader uses: the *first*
 * representation of the relationship is the component and the second is the
 * assembly it sits in. Files written the other way round exist; the symptom is
 * an assembly whose parts are inside out of each other, which is the reason this
 * paragraph is here.
 */
function placements(db: Db) {
  /** Representation entity id -> its parent and the transform into it. */
  const parent = new Map<number, { to: number; m: Matrix }>();

  for (const e of db.values()) {
    const rel = partArgs(e, 'REPRESENTATION_RELATIONSHIP');
    const withT = partArgs(e, 'REPRESENTATION_RELATIONSHIP_WITH_TRANSFORMATION');
    if (!rel || !withT) continue;
    const child = rel[2], owner = rel[3];
    if (!isRef(child) || !isRef(owner)) continue;
    const transform = at(db, isList(withT[0]) ? withT[0][0] : withT[0]);
    const item = transform ? partArgs(transform, 'ITEM_DEFINED_TRANSFORMATION') : null;
    if (!item) continue;
    const a = placementFrame(db, item[2]);
    const b = placementFrame(db, item[3]);
    if (!a || !b) continue;
    parent.set(child.ref, { to: owner.ref, m: between(a, b) });
  }

  const world = new Map<number, Matrix>();
  const resolve = (id: number, depth: number): Matrix => {
    const had = world.get(id);
    if (had) return had;
    if (depth > MAX_FOLLOW) return UNIT;
    const up = parent.get(id);
    const m = up ? times(resolve(up.to, depth + 1), up.m) : UNIT;
    world.set(id, m);
    return m;
  };

  // Every face under every representation, tagged with that representation's
  // place in the world. Reached by walking down from the representation rather
  // than up from the face, because a face has no back-reference to anything.
  const out = new Map<number, Matrix>();
  if (!parent.size) return out;
  for (const [id, e] of db) {
    if (!e.type.endsWith('SHAPE_REPRESENTATION') && e.type !== 'SHAPE_REPRESENTATION') continue;
    const m = resolve(id, 0);
    if (m === UNIT) continue;
    for (const face of facesUnder(db, e)) out.set(face, m);
  }
  return out;
}

/** The transform carrying frame `a` onto frame `b`: b's basis times a's inverse,
 *  which for two orthonormal frames is b's basis times a's transpose. */
function between(a: Frame, b: Frame): Matrix {
  const A = [a.x, a.y, a.z];
  const B = [b.x, b.y, b.z];
  const m = new Array(9);
  for (let row = 0; row < 3; row++) {
    for (let col = 0; col < 3; col++) {
      m[row * 3 + col] = B[0][row] * A[0][col] + B[1][row] * A[1][col] + B[2][row] * A[2][col];
    }
  }
  const base = { m, t: [0, 0, 0] };
  const moved = applyTo(base, a.o);
  return { m, t: [b.o[0] - moved[0], b.o[1] - moved[1], b.o[2] - moved[2]] };
}

/** Every ADVANCED_FACE reachable from a representation, by id. */
function facesUnder(db: Db, root: Entity) {
  const out: number[] = [];
  const seen = new Set<number>();
  const stack: Val[] = [...root.args];
  let steps = 0;
  while (stack.length) {
    if (++steps > 2_000_000) break;
    const v = stack.pop()!;
    if (isList(v)) { stack.push(...v); continue; }
    if (!isRef(v) || seen.has(v.ref)) continue;
    seen.add(v.ref);
    const e = db.get(v.ref);
    if (!e) continue;
    if (isType(e, 'ADVANCED_FACE') || isType(e, 'FACE_SURFACE')) { out.push(v.ref); continue; }
    // Geometry is a dead end and most of the file - not descending into a
    // surface or a point is what keeps this walk to the topology.
    if (e.type === 'CARTESIAN_POINT' || e.type === 'DIRECTION') continue;
    stack.push(...e.args);
    for (const p of e.parts || []) stack.push(...p.args);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Colour
// ---------------------------------------------------------------------------

/**
 * Face id -> the colour a modeller gave it.
 *
 * STEP's presentation layer is a chain six entities deep from a styled item to
 * an RGB triple, and every writer takes a slightly different route through it -
 * some style the solid, some style each face, some style a whole "presentation
 * layer assignment" holding a hundred items. Rather than encode all of them,
 * this finds the one COLOUR_RGB reachable from each styled item and applies it
 * to every face under the item that item names.
 *
 * A face styled twice keeps the first, which is the one nearest it: styled items
 * are written most-specific-first by every exporter this has been fed.
 */
function styleColours(db: Db) {
  const out = new Map<number, number[]>();
  for (const e of db.values()) {
    if (!isType(e, 'STYLED_ITEM')) continue;
    const args = partArgs(e, 'STYLED_ITEM') || e.args;
    const rgb = findColour(db, args[1], 0, new Set());
    if (!rgb) continue;
    const target = args[2];
    if (!isRef(target)) continue;
    const item = db.get(target.ref);
    if (!item) continue;
    // A styled item may name the face itself or the solid it belongs to, and
    // both are ordinary. The first is one face; the second is every face under
    // it.
    const faces = isType(item, 'ADVANCED_FACE') || isType(item, 'FACE_SURFACE')
      ? [target.ref]
      : facesUnder(db, item);
    for (const face of faces) if (!out.has(face)) out.set(face, rgb);
  }
  return out;
}

function findColour(db: Db, v: Val, depth: number, seen: Set<number>): number[] | null {
  if (depth > MAX_FOLLOW) return null;
  if (isList(v)) {
    for (const item of v) {
      const found = findColour(db, item, depth + 1, seen);
      if (found) return found;
    }
    return null;
  }
  if (!isRef(v)) return null;
  if (seen.has(v.ref)) return null;
  seen.add(v.ref);
  const e = db.get(v.ref);
  if (!e) return null;
  if (e.type === 'COLOUR_RGB' || e.type === 'DRAUGHTING_PRE_DEFINED_COLOUR') {
    if (e.type === 'COLOUR_RGB') {
      return [clamp01(num(e.args[1])), clamp01(num(e.args[2])), clamp01(num(e.args[3]))];
    }
    return NAMED[String(e.args[0] || '').toLowerCase()] || null;
  }
  for (const arg of e.args) {
    const found = findColour(db, arg, depth + 1, seen);
    if (found) return found;
  }
  for (const p of e.parts || []) {
    for (const arg of p.args) {
      const found = findColour(db, arg, depth + 1, seen);
      if (found) return found;
    }
  }
  return null;
}

/** The nine colours the standard names outright, for the exporters that use
 *  them instead of an RGB triple. */
const NAMED: Record<string, number[]> = {
  red: [1, 0, 0], green: [0, 1, 0], blue: [0, 0, 1],
  yellow: [1, 1, 0], magenta: [1, 0, 1], cyan: [0, 1, 1],
  black: [0, 0, 0], white: [1, 1, 1],
};
