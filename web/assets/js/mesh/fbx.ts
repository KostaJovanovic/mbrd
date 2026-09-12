// Autodesk FBX, binary and ASCII.
// Geometry resolved through the Connections graph so multi-object scenes lay out
// correctly. UpAxis read from GlobalSettings (Maya=Y, Max=Z). Polygon boundaries
// encoded as bitwise-NOT of the last index. Not read: skinning, animation,
// cameras, lights, textures, GeometricTranslation pivots.

import {
  CAPS, MeshError, MeshBuild, type Mesh, clamp01, tooBig,
} from './shared.ts';
import { inflateZlib } from './zip.ts';
import { oversize } from '../consent.ts';

const BIN_MAGIC = 'Kaydara FBX Binary';

// Cycle guard for the model parent chain.
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

// Decoded lazily — most arrays (weights, UVs) are never read.
type Packed = { kind: 'array'; type: string; length: number; encoding: number; data: Uint8Array };
type Prop = number | string | Packed | null;
type Node = { name: string; props: Prop[]; kids: Node[] };

function binary(u8: Uint8Array): Mesh {
  const view = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
  const version = view.getUint32(23, true);
  // v7500+ uses 64-bit record offsets instead of 32-bit.
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
        // Raw blobs (thumbnails, textures) — not needed, not copied.
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
      // Properties are self-describing; unknown type = can not step over it.
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
    // Bound the untrusted count before looping.
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

// Inflate and widen one packed array property to number[].
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
  // child id -> parent id
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
      // "OO" = object-to-object. "OP" is object-to-property (not transform-relevant).
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

const idOf = (node: Node) => Number(node.props[0]);

// Walk the parent chain to compose the full world transform.
function chain(id: number, parent: Map<number, number>, models: Map<number, Xform>): Xform {
  let out = UNIT;
  let at = parent.get(id);
  for (let step = 0; at !== undefined && step < MAX_CHAIN; step++) {
    const m = models.get(at);
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

// Extract Lcl Translation/Rotation/Scaling from Properties70.
function readModel(node: Node): Xform {
  const t = [0, 0, 0];
  const r = [0, 0, 0];
  const s = [1, 1, 1];
  for (const kid of node.kids) {
    if (kid.name !== 'Properties70' && kid.name !== 'Properties60') continue;
    for (const p of kid.kids) {
      if (p.name !== 'P' && p.name !== 'Property') continue;
      const which = String(p.props[0] || '');
      // Values are the last three props (works for both Properties70 and 60).
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

// UpAxis 1=y, 2=z. X-up is ignored (left to format default).
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

// Euler XYZ (applied X-first → matrix is Rz·Ry·Rx), then scale. Degrees.
function euler(r: number[], s: number[]) {
  const d = Math.PI / 180;
  const [cx, sx] = [Math.cos(r[0] * d), Math.sin(r[0] * d)];
  const [cy, sy] = [Math.cos(r[1] * d), Math.sin(r[1] * d)];
  const [cz, sz] = [Math.cos(r[2] * d), Math.sin(r[2] * d)];
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

// Walk the ~index polygon list, fan into triangles, apply the world transform.
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
        // tri() wrote the first corner's colour into all three — patch the others.
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

// Read one layer element (normals or colours), handling all mapping/index combos.
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
    // RGBA colours → drop alpha; XYZ normals → width param, always read 3.
    return width === 4
      ? [clamp01(data[o]), clamp01(data[o + 1]), clamp01(data[o + 2])]
      : [data[o], data[o + 1], data[o + 2]];
  };
}

// ---------------------------------------------------------------------------
// ASCII
// ---------------------------------------------------------------------------

// ASCII FBX — regex-extracted arrays, no connection graph.
// Multi-object scenes land at the origin (binary path handles transforms).
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
