// Autodesk FBX, binary and ASCII.
//
// The interchange format of the whole animation and games industry, and the one
// that arrives when somebody exports from Maya, 3ds Max, Blender or Cinema 4D
// without thinking about it. It is also, by a distance, the most awkward format
// in this family: undocumented by its owner, versioned in ways that move the
// field widths around, and shaped like a database rather than a file.
//
// What that means concretely. An FBX is a tree of records; the geometry sits in
// `Geometry` records as a flat vertex array plus a `PolygonVertexIndex` array
// where **the last index of each polygon is bitwise-NOT**, which is how polygon
// boundaries are marked in a flat list. But a `Geometry` is *not* placed - it is
// connected to a `Model` record by an entry in `Connections`, and the Model is
// what carries the translation, rotation and scale. A scene of six props read
// without following those connections is six props in a heap at the origin.
//
// So this reads the connections. Every geometry is resolved through the chain of
// models above it, each contributing its local transform, and the result is one
// mesh laid out the way the scene is. A geometry connected to nothing is drawn
// where it sits, which is what a single-mesh export looks like.
//
// Up is read from the file. FBX is the one format here that states its own axis
// convention - `GlobalSettings` carries `UpAxis` and `UpAxisSign` - and it
// genuinely varies: Maya writes Y-up and 3ds Max writes Z-up, and both are
// ordinary. So the answer comes from the document rather than from a guess about
// the format, which is what `Mesh.upAxis` exists for.
//
// What is not read: skinning, blend shapes, animation curves, cameras, lights,
// textures, and the `GeometricTranslation` family of pivot offsets. The first
// four cannot change a still card; the last is genuinely a gap and shows up as a
// part offset from where a modeller would expect, in the small number of files
// that use it.

import {
  CAPS, MeshError, MeshBuild, type Mesh, clamp01, tooBig,
} from './shared.ts';
import { inflateZlib } from './zip.ts';
import { oversize } from '../consent.ts';

const BIN_MAGIC = 'Kaydara FBX Binary';

/** How deep a model chain may be followed. A rig is tens of levels; a file whose
 *  connections form a cycle would otherwise be followed forever. */
const MAX_CHAIN = 256;

export function parseFBX(bytes: ArrayBuffer): Mesh {
  const u8 = new Uint8Array(bytes);
  return isBinary(u8) ? binary(u8) : ascii(new TextDecoder().decode(u8));
}

const isBinary = (u8: Uint8Array) => {
  if (u8.length < 27) return false;
  for (let i = 0; i < BIN_MAGIC.length; i++) if (u8[i] !== BIN_MAGIC.charCodeAt(i)) return false;
  return true;
};

// ---------------------------------------------------------------------------
// The record tree
// ---------------------------------------------------------------------------

/** An array property, still packed. Kept undecoded until somebody wants it -
 *  most of the arrays in a rigged FBX are weights and UVs this never reads, and
 *  inflating them all would be most of the file's cost for none of its value. */
type Packed = { kind: 'array'; type: string; length: number; encoding: number; data: Uint8Array };
type Prop = number | string | Packed | null;
type Node = { name: string; props: Prop[]; kids: Node[] };

function binary(u8: Uint8Array): Mesh {
  const view = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
  const version = view.getUint32(23, true);
  // 7500 moved the three record offsets from 32 to 64 bits. Everything else
  // about the layout is unchanged, which is why one reader covers both.
  const big = version >= 7500;
  const wide = big ? 8 : 4;
  const nullRec = big ? 25 : 13;
  const word = (at: number) => (big ? Number(view.getBigUint64(at, true)) : view.getUint32(at, true));

  let nodes = 0;

  const prop = (at: number): { value: Prop; next: number } => {
    if (at >= u8.length) throw new MeshError('This FBX ends mid-record');
    const type = String.fromCharCode(u8[at]);
    const p = at + 1;
    const room = (n: number) => {
      if (p + n > u8.length) throw new MeshError('This FBX ends mid-record');
    };
    switch (type) {
      case 'Y': room(2); return { value: view.getInt16(p, true), next: p + 2 };
      case 'C': room(1); return { value: u8[p], next: p + 1 };
      case 'I': room(4); return { value: view.getInt32(p, true), next: p + 4 };
      case 'F': room(4); return { value: view.getFloat32(p, true), next: p + 4 };
      case 'D': room(8); return { value: view.getFloat64(p, true), next: p + 8 };
      case 'L': room(8); return { value: Number(view.getBigInt64(p, true)), next: p + 8 };
      case 'S':
      case 'R': {
        room(4);
        const len = view.getUint32(p, true);
        if (p + 4 + len > u8.length) throw new MeshError('This FBX ends mid-record');
        // Raw blobs are thumbnails and embedded textures. Their bytes are never
        // read, so they are not copied out either.
        const value = type === 'S' ? latin1(u8.subarray(p + 4, p + 4 + len)) : null;
        return { value, next: p + 4 + len };
      }
      case 'f': case 'd': case 'l': case 'i': case 'b': {
        room(12);
        const length = view.getUint32(p, true);
        const encoding = view.getUint32(p + 4, true);
        const compressed = view.getUint32(p + 8, true);
        if (p + 12 + compressed > u8.length) throw new MeshError('This FBX ends mid-record');
        if (length > CAPS.elem) throw oversize('mesh-triangles', tooBig(length));
        return {
          value: { kind: 'array', type, length, encoding, data: u8.subarray(p + 12, p + 12 + compressed) },
          next: p + 12 + compressed,
        };
      }
      // An unknown type code means the property list can no longer be walked -
      // every property is positional and self-describing, so there is no way to
      // step over one whose width is unknown.
      default: throw new MeshError('This FBX has a property this cannot read');
    }
  };

  const node = (at: number): { node: Node; next: number } | null => {
    if (at + nullRec > u8.length) return null;
    const end = word(at);
    if (!end) return null;                       // the null record ends a sibling list
    if (end > u8.length || end <= at) throw new MeshError('This FBX has a record that points outside it');
    if (++nodes > 4_000_000) throw new MeshError('This FBX has more records than a scene has');
    let p = at + wide;
    const numProps = word(p); p += wide;
    p += wide;                                   // property list length, unused
    const nameLen = u8[p]; p += 1;
    const name = latin1(u8.subarray(p, p + nameLen)); p += nameLen;
    const props: Prop[] = [];
    // A property count out of a foreign file, bounded before it is looped on.
    if (numProps > 1 << 20) throw new MeshError('This FBX has a record with too many properties');
    for (let i = 0; i < numProps; i++) {
      const r = prop(p);
      props.push(r.value);
      p = r.next;
    }
    const kids: Node[] = [];
    while (p + nullRec <= end && p + nullRec <= u8.length) {
      if (word(p) === 0) { p += nullRec; break; }
      const child = node(p);
      if (!child) break;
      kids.push(child.node);
      p = child.next;
    }
    return { node: { name, props, kids }, next: end };
  };

  const roots: Node[] = [];
  let at = 27;                                   // 23-byte magic block, 4-byte version
  while (at + nullRec <= u8.length) {
    if (word(at) === 0) break;
    const r = node(at);
    if (!r) break;
    roots.push(r.node);
    at = r.next;
  }

  return assemble(roots);
}

const latin1 = (b: Uint8Array) => new TextDecoder('latin1').decode(b);

/** One packed array, inflated where it needs to be and widened to numbers. */
function unpack(p: Prop | undefined): number[] | null {
  if (!p || typeof p !== 'object' || p.kind !== 'array') return null;
  const bytes = p.encoding === 1 ? inflateZlib(p.data) : p.data;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const width = p.type === 'd' || p.type === 'l' ? 8 : p.type === 'b' ? 1 : 4;
  if (p.length * width > bytes.length) throw new MeshError('This FBX has an array shorter than it declares');
  const out = new Array<number>(p.length);
  for (let i = 0; i < p.length; i++) {
    const o = i * width;
    if (p.type === 'd') out[i] = view.getFloat64(o, true);
    else if (p.type === 'f') out[i] = view.getFloat32(o, true);
    else if (p.type === 'i') out[i] = view.getInt32(o, true);
    else if (p.type === 'l') out[i] = Number(view.getBigInt64(o, true));
    else out[i] = bytes[o];
  }
  return out;
}

// ---------------------------------------------------------------------------
// The scene
// ---------------------------------------------------------------------------

type Geom = {
  verts: number[];
  polys: number[];
  normals: number[] | null;
  normalsIndexed: number[] | null;
  normalMapping: string;
  colours: number[] | null;
  coloursIndexed: number[] | null;
  colourMapping: string;
};

type Xform = { m: number[]; t: number[] };
const UNIT: Xform = { m: [1, 0, 0, 0, 1, 0, 0, 0, 1], t: [0, 0, 0] };

function assemble(roots: Node[]): Mesh {
  const geoms = new Map<number, Geom>();
  const models = new Map<number, Xform>();
  /** child id -> parent id, from the object-to-object connections. */
  const parent = new Map<number, number>();
  let up: 'y' | 'z' | null = null;

  const walk = (node: Node) => {
    if (node.name === 'Geometry') {
      const g = readGeometry(node);
      if (g) geoms.set(idOf(node), g);
    } else if (node.name === 'Model') {
      models.set(idOf(node), readModel(node));
    } else if (node.name === 'GlobalSettings') {
      up = readUpAxis(node) ?? up;
    } else if (node.name === 'C' && node.props[0] === 'OO') {
      // `C: "OO", child, parent`. Object-to-property connections ("OP") name a
      // property rather than a node and are not part of the transform chain.
      const child = Number(node.props[1]);
      const owner = Number(node.props[2]);
      if (Number.isFinite(child) && Number.isFinite(owner)) parent.set(child, owner);
    }
    for (const kid of node.kids) walk(kid);
  };
  for (const root of roots) walk(root);

  const build = new MeshBuild();
  for (const [id, geom] of geoms) addGeometry(build, geom, chain(id, parent, models));
  if (!build.count) throw new MeshError('This FBX has no geometry in it');
  const mesh = build.done();
  mesh.upAxis = up;
  return mesh;
}

/** A record's own id, which FBX puts in the first property of every object. */
const idOf = (node: Node) => Number(node.props[0]);

/** The composed transform of every model above this geometry. */
function chain(id: number, parent: Map<number, number>, models: Map<number, Xform>): Xform {
  let out = UNIT;
  let at = parent.get(id);
  for (let step = 0; at !== undefined && step < MAX_CHAIN; step++) {
    const m = models.get(at);
    // Applied outermost-last: each step up the tree wraps what came before.
    if (m) out = compose(m, out);
    const next = parent.get(at);
    if (next === at) break;
    at = next;
  }
  return out;
}

function readGeometry(node: Node): Geom | null {
  let verts: number[] | null = null;
  let polys: number[] | null = null;
  let normals: number[] | null = null;
  let normalsIndexed: number[] | null = null;
  let normalMapping = '';
  let colours: number[] | null = null;
  let coloursIndexed: number[] | null = null;
  let colourMapping = '';

  for (const kid of node.kids) {
    if (kid.name === 'Vertices') verts = unpack(kid.props[0]);
    else if (kid.name === 'PolygonVertexIndex') polys = unpack(kid.props[0]);
    else if (kid.name === 'LayerElementNormal') {
      for (const c of kid.kids) {
        if (c.name === 'Normals') normals = unpack(c.props[0]);
        else if (c.name === 'NormalsIndex') normalsIndexed = unpack(c.props[0]);
        else if (c.name === 'MappingInformationType') normalMapping = String(c.props[0] || '');
      }
    } else if (kid.name === 'LayerElementColor') {
      for (const c of kid.kids) {
        if (c.name === 'Colors') colours = unpack(c.props[0]);
        else if (c.name === 'ColorIndex') coloursIndexed = unpack(c.props[0]);
        else if (c.name === 'MappingInformationType') colourMapping = String(c.props[0] || '');
      }
    }
  }
  if (!verts || !polys) return null;
  return { verts, polys, normals, normalsIndexed, normalMapping, colours, coloursIndexed, colourMapping };
}

/**
 * A model's local transform, out of its `Properties70` block.
 *
 * `P` records are positional: name, type, label, flags, then the values. The
 * three that matter here are all three-component and all in the same place,
 * which is what makes reading them a lookup rather than a parse.
 */
function readModel(node: Node): Xform {
  const t = [0, 0, 0];
  const r = [0, 0, 0];
  const s = [1, 1, 1];
  for (const kid of node.kids) {
    if (kid.name !== 'Properties70' && kid.name !== 'Properties60') continue;
    for (const p of kid.kids) {
      if (p.name !== 'P' && p.name !== 'Property') continue;
      const which = String(p.props[0] || '');
      // The values are the last three, whether the block is a Properties70 (a
      // type, a label and a flags string in front of them) or the older
      // Properties60 (one fewer).
      const at = p.props.length >= 6 ? p.props.length - 3 : -1;
      if (at < 0) continue;
      const v = [Number(p.props[at]), Number(p.props[at + 1]), Number(p.props[at + 2])];
      if (v.some(n => !Number.isFinite(n))) continue;
      if (which === 'Lcl Translation') { t[0] = v[0]; t[1] = v[1]; t[2] = v[2]; }
      else if (which === 'Lcl Rotation') { r[0] = v[0]; r[1] = v[1]; r[2] = v[2]; }
      else if (which === 'Lcl Scaling') { s[0] = v[0]; s[1] = v[1]; s[2] = v[2]; }
    }
  }
  return { m: euler(r, s), t };
}

/** `UpAxis` is 0/1/2 for x/y/z and `UpAxisSign` is 1 or -1. Only y and z have a
 *  reading here - the viewer's two - and an x-up file is left to the format
 *  default rather than being turned on its side by a guess. */
function readUpAxis(node: Node): 'y' | 'z' | null {
  for (const kid of node.kids) {
    if (kid.name !== 'Properties70' && kid.name !== 'Properties60') continue;
    for (const p of kid.kids) {
      if (String(p.props[0] || '') !== 'UpAxis') continue;
      const v = Number(p.props[p.props.length - 1]);
      if (v === 1) return 'y';
      if (v === 2) return 'z';
    }
  }
  return null;
}

/**
 * Scale, then rotate. FBX's default rotation order is eEulerXYZ, which names the
 * order the axes are *applied* in - X first - so the matrix is Rz Ry Rx.
 *
 * Degrees, like every angle FBX writes.
 */
function euler(r: number[], s: number[]) {
  const d = Math.PI / 180;
  const [cx, sx] = [Math.cos(r[0] * d), Math.sin(r[0] * d)];
  const [cy, sy] = [Math.cos(r[1] * d), Math.sin(r[1] * d)];
  const [cz, sz] = [Math.cos(r[2] * d), Math.sin(r[2] * d)];
  // Row-major 3x3, laid out so apply() below reads it a row at a time.
  const m = [
    cz * cy, cz * sy * sx - sz * cx, cz * sy * cx + sz * sx,
    sz * cy, sz * sy * sx + cz * cx, sz * sy * cx - cz * sx,
    -sy, cy * sx, cy * cx,
  ];
  for (let row = 0; row < 3; row++) {
    for (let col = 0; col < 3; col++) m[row * 3 + col] *= s[col];
  }
  return m;
}

/** `outer` applied after `inner`. */
function compose(outer: Xform, inner: Xform): Xform {
  const m = new Array(9);
  for (let row = 0; row < 3; row++) {
    for (let col = 0; col < 3; col++) {
      m[row * 3 + col] =
        outer.m[row * 3] * inner.m[col] +
        outer.m[row * 3 + 1] * inner.m[3 + col] +
        outer.m[row * 3 + 2] * inner.m[6 + col];
    }
  }
  // apply() already adds `outer.t`, which is the whole of the composed
  // translation: the inner origin carried through the outer transform.
  return { m, t: apply(outer, inner.t) };
}

function apply(x: Xform, p: number[]) {
  return [
    x.m[0] * p[0] + x.m[1] * p[1] + x.m[2] * p[2] + x.t[0],
    x.m[3] * p[0] + x.m[4] * p[1] + x.m[5] * p[2] + x.t[1],
    x.m[6] * p[0] + x.m[7] * p[1] + x.m[8] * p[2] + x.t[2],
  ];
}

// ---------------------------------------------------------------------------
// The polygons
// ---------------------------------------------------------------------------

/**
 * Fan every polygon in the index list, transformed into place.
 *
 * The bitwise-NOT convention is the whole trick: indices run positive until the
 * last corner of a polygon, which is written as `~i`. So the list is walked
 * accumulating corners, and a negative entry both supplies the last corner and
 * closes the polygon.
 *
 * Normals and colours are per *polygon vertex* rather than per vertex in the
 * common mapping, which is what lets a cube have eight positions and
 * twenty-four normals - so they are read at the corner's position in this walk
 * rather than at its vertex index. `ByVertice` mapping means the other thing,
 * and both turn up.
 */
function addGeometry(build: MeshBuild, geom: Geom, x: Xform) {
  const { verts, polys } = geom;
  const vertN = (verts.length / 3) | 0;
  const corners: number[] = [];
  const at: number[] = [];

  const normalAt = layer(geom.normals, geom.normalsIndexed, geom.normalMapping, 3);
  const colourAt = layer(geom.colours, geom.coloursIndexed, geom.colourMapping, 4);

  const point = (v: number) => apply(x, [verts[v * 3], verts[v * 3 + 1], verts[v * 3 + 2]]);
  const spin = (n: number[] | null) => (n ? [
    x.m[0] * n[0] + x.m[1] * n[1] + x.m[2] * n[2],
    x.m[3] * n[0] + x.m[4] * n[1] + x.m[5] * n[2],
    x.m[6] * n[0] + x.m[7] * n[1] + x.m[8] * n[2],
  ] : null);

  for (let i = 0; i < polys.length; i++) {
    const raw = polys[i];
    const last = raw < 0;
    const v = last ? ~raw : raw;
    if (!(v >= 0 && v < vertN)) throw new MeshError('This FBX refers to vertices it does not contain');
    corners.push(v);
    at.push(i);
    if (!last) continue;

    for (let k = 1; k + 1 < corners.length; k++) {
      const tri = [0, k, k + 1];
      const p = tri.map(c => point(corners[c]));
      const rgb = colourAt(at[tri[0]], corners[tri[0]]);
      build.tri(p[0][0], p[0][1], p[0][2], p[1][0], p[1][1], p[1][2], p[2][0], p[2][1], p[2][2], rgb);
      const n = tri.map(c => spin(normalAt(at[c], corners[c])));
      if (n[0] || n[1] || n[2]) build.normals(n[0] || [], n[1] || [], n[2] || []);
      if (rgb && build.coloured) {
        // Per corner, where the layer gives one per corner. build.tri() has
        // written the first corner's into all three.
        for (let c = 1; c < 3; c++) {
          const other = colourAt(at[tri[c]], corners[tri[c]]);
          if (!other) continue;
          const o = build.c.length - 9 + c * 3;
          build.c[o] = other[0]; build.c[o + 1] = other[1]; build.c[o + 2] = other[2];
        }
      }
    }
    corners.length = 0;
    at.length = 0;
  }
}

/**
 * A reader for one layer element, whichever way it is mapped.
 *
 * Returns a function of (polygon-vertex position, vertex index). The four
 * combinations that occur are direct or indexed, against corners or against
 * vertices; anything else - `ByPolygon`, `AllSame`, an edge mapping - reads as
 * absent rather than as the wrong number, and the facet's own normal stands.
 */
type LayerRead = (corner: number, vertex: number) => number[] | null;

function layer(data: number[] | null, index: number[] | null, mapping: string, width: number): LayerRead {
  const absent: LayerRead = () => null;
  if (!data || !data.length) return absent;
  const byVertex = mapping === 'ByVertice' || mapping === 'ByVertex';
  const byCorner = mapping === 'ByPolygonVertex' || mapping === '';
  if (!byVertex && !byCorner) return absent;
  return (corner, vertex) => {
    let slot = byVertex ? vertex : corner;
    if (index) {
      if (slot < 0 || slot >= index.length) return null;
      slot = index[slot];
    }
    const o = slot * width;
    if (slot < 0 || o + 3 > data.length) return null;
    // Colours arrive as RGBA and normals as XYZ; the fourth is dropped either
    // way, which is why the width is a parameter and the read is always three.
    return width === 4
      ? [clamp01(data[o]), clamp01(data[o + 1]), clamp01(data[o + 2])]
      : [data[o], data[o + 1], data[o + 2]];
  };
}

// ---------------------------------------------------------------------------
// ASCII
// ---------------------------------------------------------------------------

/**
 * The text form, read with a regex per array rather than a parser.
 *
 * ASCII FBX is a nested block syntax and writing a reader for it would be a
 * second full parser for a form that is rare, unversioned in practice, and
 * written mostly by converters. What it does guarantee is the shape of the
 * arrays - `Vertices: *N { a: 1,2,3 }` - and the pairing between the two arrays
 * of one geometry is their order in the file, which is enough to draw it.
 *
 * The cost is the transforms: this path does not follow connections, so a
 * multi-object ASCII FBX comes out with every object at the origin. That is
 * stated rather than hidden, and the binary form - which is what every tool
 * writes by default - has none of this.
 */
function ascii(text: string): Mesh {
  const grab = (re: RegExp) => {
    const out: string[] = [];
    let m: RegExpExecArray | null;
    while ((m = re.exec(text))) out.push(m[1]);
    return out;
  };
  const vertLists = grab(/Vertices:\s*\*\d+\s*\{\s*a:\s*([^}]*)\}/g);
  const polyLists = grab(/PolygonVertexIndex:\s*\*\d+\s*\{\s*a:\s*([^}]*)\}/g);
  if (!vertLists.length || !polyLists.length) throw new MeshError('This FBX has no geometry in it');

  const build = new MeshBuild();
  for (let i = 0; i < Math.min(vertLists.length, polyLists.length); i++) {
    const verts = numbers(vertLists[i]);
    const polys = numbers(polyLists[i]);
    if (!verts.length || !polys.length) continue;
    addGeometry(build, {
      verts, polys,
      normals: null, normalsIndexed: null, normalMapping: '',
      colours: null, coloursIndexed: null, colourMapping: '',
    }, UNIT);
  }
  if (!build.count) throw new MeshError('This FBX has no geometry in it');
  const mesh = build.done();
  // `UpAxis: 1` in the Properties70 block, in the one form this path can read it.
  const up = /UpAxis"?\s*,\s*"[^"]*"\s*,\s*"[^"]*"\s*,\s*"[^"]*"\s*,\s*(-?\d+)/.exec(text);
  if (up) mesh.upAxis = up[1] === '2' ? 'z' : up[1] === '1' ? 'y' : null;
  return mesh;
}

function numbers(blob: string) {
  const out: number[] = [];
  for (const tok of blob.split(',')) {
    const n = +tok;
    if (Number.isFinite(n)) out.push(n);
  }
  return out;
}
