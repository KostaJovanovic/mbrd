// Collada (.dae) parser. Geometry is reached by following id references across
// an XML tree, so <p> indices are interleaved by input offset — the stride comes
// from the inputs, not an assumption. Up axis read from <up_axis>.
// Reads: triangles, polylist, polygons, normals, vertex colours, node transforms,
// diffuse material colour. Does not read: trifans/tristrips, skinning, textures.

import {
  MeshError, MeshBuild, type Mesh, clamp01,
} from './shared.ts';
import { parseXML, find, findAll, children, floats, type XmlNode } from './xml.ts';

const MAX_NODE_DEPTH = 256;
const MAX_NODE_VISITS = 200_000;

export function parseCollada(bytes: string | ArrayBuffer): Mesh {
  const text = typeof bytes === 'string' ? bytes : new TextDecoder().decode(bytes);
  const doc = parseXML(text);
  const root = find(doc, 'collada');
  if (!root) throw new MeshError('This is not a Collada document');

  const byId = index(root);
  const build = new MeshBuild();
  const materials = readMaterials(root, byId);

  // A .dae with no scene is a library file; draw every geometry at the origin.
  const scenes = findAll(root, 'visual_scene');
  if (scenes.length) {
    let visits = 0;
    const walk = (node: XmlNode, m: number[], depth: number) => {
      if (depth > MAX_NODE_DEPTH) throw new MeshError('This Collada document nests its nodes too deeply');
      if (++visits > MAX_NODE_VISITS) throw new MeshError('This Collada document has more nodes than a scene has');
      const here = mul(m, localMatrix(node));
      for (const inst of children(node, 'instance_geometry')) {
        // Counted as a visit: an instance of a geometry with no triangles in it
        // never reaches the triangle ceiling, and costs its primitives anyway.
        if (++visits > MAX_NODE_VISITS) throw new MeshError('This Collada document has more nodes than a scene has');
        const geom = byId.get(ref(inst.attrs.url));
        if (geom) addGeometry(build, geom, byId, here, bound(inst, materials));
      }
      // <instance_node> = instanced assembly reference
      for (const inst of children(node, 'instance_node')) {
        const target = byId.get(ref(inst.attrs.url));
        if (target) walk(target, here, depth + 1);
      }
      for (const kid of children(node, 'node')) walk(kid, here, depth + 1);
    };
    for (const scene of scenes) for (const node of children(scene, 'node')) walk(node, IDENTITY, 0);
  }

  if (!build.count) {
    for (const geom of findAll(root, 'geometry')) addGeometry(build, geom, byId, IDENTITY, null);
  }
  if (!build.count) throw new MeshError('This Collada document has no geometry in it');

  const mesh = build.done();
  const up = find(root, 'up_axis');
  const said = (up?.text || '').trim().toUpperCase();
  mesh.upAxis = said === 'Z_UP' ? 'z' : said === 'Y_UP' ? 'y' : null;
  return mesh;
}

/** Index all `id` attributes for O(1) `#ref` lookups. */
function index(root: XmlNode) {
  const byId = new Map<string, XmlNode>();
  const walk = (node: XmlNode) => {
    const id = node.attrs.id;
    // First wins — duplicates occur in converter-stitched files.
    if (id && !byId.has(id)) byId.set(id, node);
    for (const kid of node.kids) walk(kid);
  };
  walk(root);
  return byId;
}

const ref = (url: string | undefined) => (url || '').replace(/^#/, '');

// ---------------------------------------------------------------------------
// Sources
// ---------------------------------------------------------------------------

type Source = { data: number[]; stride: number };

/** Each element's text as numbers, parsed once for the whole parse. A source
 *  or a `<p>` read again for every instance of its geometry made two thousand
 *  instances of one half-million-number array forty seconds of parsing the
 *  same text. Keyed by node, so it dies with the tree. */
const parsed = new WeakMap<XmlNode, number[]>();

function numbersOf(node: XmlNode) {
  let out = parsed.get(node);
  if (!out) { out = floats(node.text); parsed.set(node, out); }
  return out;
}

/** A <source> reduced to numbers + stride. Falls back to `fallbackStride` when <accessor> is missing. */
function source(node: XmlNode | undefined, fallbackStride: number): Source | null {
  if (!node) return null;
  const array = find(node, 'float_array') || find(node, 'int_array');
  if (!array) return null;
  const accessor = find(node, 'accessor');
  const stride = Number(accessor?.attrs.stride) || fallbackStride;
  return { data: numbersOf(array), stride: stride > 0 ? stride : fallbackStride };
}

/** Resolve an <input> to its source, following the VERTEX→<vertices> indirection. */
function inputSource(input: XmlNode, byId: Map<string, XmlNode>, fallbackStride: number) {
  let target = byId.get(ref(input.attrs.source));
  if (target?.name === 'vertices') {
    const inner = children(target, 'input').find(i => (i.attrs.semantic || '').toUpperCase() === 'POSITION')
      || children(target, 'input')[0];
    target = inner ? byId.get(ref(inner.attrs.source)) : undefined;
  }
  return source(target, fallbackStride);
}

// ---------------------------------------------------------------------------
// Geometry
// ---------------------------------------------------------------------------

/** Supported primitive types. */
const PRIMITIVES = ['triangles', 'polylist', 'polygons'];

function addGeometry(
  build: MeshBuild,
  geometry: XmlNode,
  byId: Map<string, XmlNode>,
  m: number[],
  bindings: Map<string, number[]> | null,
) {
  const mesh = find(geometry, 'mesh');
  if (!mesh) return;

  for (const prim of mesh.kids) {
    if (!PRIMITIVES.includes(prim.name)) continue;

    const inputs = children(prim, 'input');
    let stride = 0;
    let position: Source | null = null, normal: Source | null = null, colour: Source | null = null;
    let posOffset = 0, normOffset = -1, colourOffset = -1;

    for (const input of inputs) {
      const offset = Number(input.attrs.offset) || 0;
      stride = Math.max(stride, offset + 1);
      switch ((input.attrs.semantic || '').toUpperCase()) {
        case 'VERTEX':
        case 'POSITION':
          position = inputSource(input, byId, 3); posOffset = offset; break;
        case 'NORMAL':
          normal = inputSource(input, byId, 3); normOffset = offset; break;
        case 'COLOR':
          colour = inputSource(input, byId, 3); colourOffset = offset; break;
        default: break;
      }
    }
    if (!position || !position.data.length) continue;
    if (!stride) stride = 1;

    // <polygons> = one <p> per polygon; polylist uses <vcount> to split one <p>.
    const lists = children(prim, 'p');
    const vcount = find(prim, 'vcount');
    const counts = vcount ? numbersOf(vcount) : null;
    const flat = bindings?.get(prim.attrs.material || '') || null;

    for (const list of lists) {
      const p = numbersOf(list);
      const corners = (p.length / stride) | 0;
      let at = 0;
      let poly = 0;
      while (at < corners) {
        const n = counts && prim.name === 'polylist'
          ? (counts[poly++] | 0)
          : prim.name === 'triangles' ? 3 : corners - at;
        if (!(n >= 3) || at + n > corners) break;
        for (let k = 1; k + 1 < n; k++) {
          const tri = [at, at + k, at + k + 1];
          const pts = tri.map(c => xf(m, at3(position!, p[c * stride + posOffset])));
          const rgb = colour && colourOffset >= 0
            ? rgbAt(colour, p[tri[0] * stride + colourOffset])
            : flat;
          build.tri(
            pts[0][0], pts[0][1], pts[0][2],
            pts[1][0], pts[1][1], pts[1][2],
            pts[2][0], pts[2][1], pts[2][2],
            rgb,
          );
          if (normal && normOffset >= 0) {
            const ns = tri.map(c => spin(m, at3(normal!, p[c * stride + normOffset])));
            build.normals(ns[0], ns[1], ns[2]);
          }
          if (colour && colourOffset >= 0 && build.coloured) {
            for (let c = 1; c < 3; c++) {
              const other = rgbAt(colour, p[tri[c] * stride + colourOffset]);
              if (!other) continue;
              const o = build.c.length - 9 + c * 3;
              build.c[o] = other[0]; build.c[o + 1] = other[1]; build.c[o + 2] = other[2];
            }
          }
        }
        at += n;
      }
    }
  }
}

function at3(src: Source, index: number) {
  const o = index * src.stride;
  // Out-of-bounds index = corrupt document; throw rather than produce NaN.
  if (!(index >= 0) || o + 3 > src.data.length) {
    throw new MeshError('This Collada document refers to data it does not contain');
  }
  return [src.data[o] || 0, src.data[o + 1] || 0, src.data[o + 2] || 0];
}

function rgbAt(src: Source, index: number) {
  const o = index * src.stride;
  if (!(index >= 0) || o + 3 > src.data.length) return null;
  return [clamp01(src.data[o]), clamp01(src.data[o + 1]), clamp01(src.data[o + 2])];
}

// ---------------------------------------------------------------------------
// Materials
// ---------------------------------------------------------------------------

/** Material id → diffuse [r,g,b]. Textures yield no colour (board ink fallback looks better than black). */
function readMaterials(root: XmlNode, byId: Map<string, XmlNode>) {
  const out = new Map<string, number[]>();
  for (const material of findAll(root, 'material')) {
    const id = material.attrs.id;
    if (!id) continue;
    const instance = find(material, 'instance_effect');
    const effect = instance ? byId.get(ref(instance.attrs.url)) : null;
    if (!effect) continue;
    for (const shader of ['lambert', 'phong', 'blinn', 'constant']) {
      const node = find(effect, shader);
      if (!node) continue;
      const slot = find(node, 'diffuse') || find(node, 'emission');
      const colour = slot ? find(slot, 'color') : null;
      const n = colour ? floats(colour.text) : [];
      if (n.length >= 3) out.set(id, [clamp01(n[0]), clamp01(n[1]), clamp01(n[2])]);
      break;
    }
  }
  return out;
}

/** Symbol→colour bindings from an <instance_geometry>. */
function bound(instance: XmlNode, materials: Map<string, number[]>) {
  const out = new Map<string, number[]>();
  for (const bind of findAll(instance, 'instance_material')) {
    const colour = materials.get(ref(bind.attrs.target));
    if (colour && bind.attrs.symbol) out.set(bind.attrs.symbol, colour);
  }
  return out.size ? out : null;
}

// ---------------------------------------------------------------------------
// Transforms
// ---------------------------------------------------------------------------
//
// Row-major, column-vector (M * p). Transforms compose in document order (outermost-first).

const IDENTITY = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];

function localMatrix(node: XmlNode) {
  let m = IDENTITY;
  for (const kid of node.kids) {
    if (kid.name === 'matrix') {
      const n = floats(kid.text);
      if (n.length >= 16) m = mul(m, n.slice(0, 16));
    } else if (kid.name === 'translate') {
      const n = floats(kid.text);
      if (n.length >= 3) m = mul(m, [1, 0, 0, n[0], 0, 1, 0, n[1], 0, 0, 1, n[2], 0, 0, 0, 1]);
    } else if (kid.name === 'scale') {
      const n = floats(kid.text);
      if (n.length >= 3) m = mul(m, [n[0], 0, 0, 0, 0, n[1], 0, 0, 0, 0, n[2], 0, 0, 0, 0, 1]);
    } else if (kid.name === 'rotate') {
      const n = floats(kid.text);
      if (n.length >= 4) m = mul(m, axisAngle(n[0], n[1], n[2], n[3]));
    }
  }
  return m;
}

/** Rodrigues rotation; angle in degrees (Collada convention). */
function axisAngle(x: number, y: number, z: number, degrees: number) {
  const len = Math.hypot(x, y, z);
  if (!len) return IDENTITY;
  const [ax, ay, az] = [x / len, y / len, z / len];
  const a = degrees * Math.PI / 180;
  const c = Math.cos(a), s = Math.sin(a), t = 1 - c;
  return [
    t * ax * ax + c, t * ax * ay - s * az, t * ax * az + s * ay, 0,
    t * ax * ay + s * az, t * ay * ay + c, t * ay * az - s * ax, 0,
    t * ax * az - s * ay, t * ay * az + s * ax, t * az * az + c, 0,
    0, 0, 0, 1,
  ];
}

function mul(a: number[], b: number[]) {
  const out = new Array(16);
  for (let row = 0; row < 4; row++) {
    for (let col = 0; col < 4; col++) {
      out[row * 4 + col] =
        a[row * 4] * b[col] +
        a[row * 4 + 1] * b[4 + col] +
        a[row * 4 + 2] * b[8 + col] +
        a[row * 4 + 3] * b[12 + col];
    }
  }
  return out;
}

const xf = (m: number[], p: number[]) => [
  m[0] * p[0] + m[1] * p[1] + m[2] * p[2] + m[3],
  m[4] * p[0] + m[5] * p[1] + m[6] * p[2] + m[7],
  m[8] * p[0] + m[9] * p[1] + m[10] * p[2] + m[11],
];

const spin = (m: number[], n: number[]) => [
  m[0] * n[0] + m[1] * n[1] + m[2] * n[2],
  m[4] * n[0] + m[5] * n[1] + m[6] * n[2],
  m[8] * n[0] + m[9] * n[1] + m[10] * n[2],
];
