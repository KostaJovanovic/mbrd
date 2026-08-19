// Collada (.dae) - the open interchange format FBX won against.
//
// Still everywhere: SketchUp exports it, Blender imports it, every asset library
// that predates glTF has it, and it is what a .kmz holds inside. Unlike the rest
// of this family it is a *document* rather than a stream - the geometry is
// reached by following references across the file, and an array may be declared
// after the thing that uses it. That is the one format here that genuinely needs
// a tree, and mesh/xml.ts's header says so.
//
// The chain from a triangle to a number is four links long and worth spelling
// out once, because everything below is shaped by it:
//
//   <triangles> has <input semantic="VERTEX" source="#v" offset="0">
//   <vertices id="v"> has <input semantic="POSITION" source="#s">
//   <source id="s"> has a <float_array> and an <accessor> saying how to read it
//   <p> holds one index per input per corner, interleaved by offset
//
// So a `<p>` of `0 0 1 1 2 2` with two inputs at offsets 0 and 1 is three
// corners, not six. Getting the stride wrong reads a cube as a ribbon, which is
// why the offsets are taken from the inputs rather than assumed.
//
// Up is read from the file, like FBX: `<up_axis>` is part of the asset block and
// Z_UP is what SketchUp and most CAD exporters write while Y_UP is what the
// spec's default and most game tooling use.
//
// What is read: `<triangles>`, `<polylist>` and `<polygons>`, positions,
// normals, vertex colours, the node transforms of the visual scene, and the
// diffuse colour of a bound material. What is not: `<trifans>` and
// `<tristrips>` (rare enough that no exporter this project has seen writes
// them), skinning, textures, and the `<unit>` scale - a card frames a model by
// its own bounding sphere, so a millimetre file and a metre file look the same
// either way.

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

  // The visual scene, where there is one. A .dae with geometry and no scene is
  // ordinary - a library file - and every geometry in it is drawn at the origin,
  // which is the only reading available.
  const scenes = findAll(root, 'visual_scene');
  if (scenes.length) {
    let visits = 0;
    const walk = (node: XmlNode, m: number[], depth: number) => {
      if (depth > MAX_NODE_DEPTH) throw new MeshError('This Collada document nests its nodes too deeply');
      if (++visits > MAX_NODE_VISITS) throw new MeshError('This Collada document has more nodes than a scene has');
      const here = mul(m, localMatrix(node));
      for (const inst of children(node, 'instance_geometry')) {
        const geom = byId.get(ref(inst.attrs.url));
        if (geom) addGeometry(build, geom, byId, here, bound(inst, materials));
      }
      // An `<instance_node>` is a reference to a node elsewhere in the document,
      // which is how Collada writes an instanced assembly.
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

/** Everything with an `id`, so a `#ref` is a lookup rather than a search. */
function index(root: XmlNode) {
  const byId = new Map<string, XmlNode>();
  const walk = (node: XmlNode) => {
    const id = node.attrs.id;
    // First declaration wins. Duplicate ids are invalid and do occur in files
    // stitched together by a converter, and the first is the one the references
    // above it were written against.
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

/**
 * A `<source>` reduced to numbers and a stride.
 *
 * The `<accessor>` is what says how to read the array - a source of positions
 * has stride 3 and a source of texture coordinates has stride 2, and both are
 * one flat `<float_array>`. Where the accessor is missing (which converters do
 * write) the stride is guessed from the semantic by the caller.
 */
function source(node: XmlNode | undefined, fallbackStride: number): Source | null {
  if (!node) return null;
  const array = find(node, 'float_array') || find(node, 'int_array');
  if (!array) return null;
  const accessor = find(node, 'accessor');
  const stride = Number(accessor?.attrs.stride) || fallbackStride;
  return { data: floats(array.text), stride: stride > 0 ? stride : fallbackStride };
}

/** The source an `<input>` points at, following the one indirection a VERTEX
 *  input has: it names a `<vertices>` element, which names the real source. */
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

/** The primitive elements this reads, in the order a file may hold them. */
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

    // `<polygons>` holds one `<p>` per polygon; the other two hold one for the
    // lot, with `<vcount>` saying where the polygons break in a polylist.
    const lists = children(prim, 'p');
    const vcount = find(prim, 'vcount');
    const counts = vcount ? floats(vcount.text) : null;
    const flat = bindings?.get(prim.attrs.material || '') || null;

    for (const list of lists) {
      const p = floats(list.text);
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
  // An index past the array is a document that does not say what it means, and
  // the NaN it would otherwise produce reaches the bounding box rather than the
  // reader. Zero is wrong too, but it is wrong in a place that is visible.
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

/**
 * Material id -> its diffuse colour, resolved through the effect it names.
 *
 * Collada's material chain is `<instance_material target>` to `<material>` to
 * `<instance_effect url>` to `<effect>` to whichever of `<lambert>`, `<phong>`,
 * `<blinn>` or `<constant>` the exporter chose. Every one of those has a
 * `<diffuse>` (or an `<emission>`, for constant), and inside it either a
 * `<color>` or a `<texture>`.
 *
 * Textures read as no colour rather than as black. A card falls back to the
 * board's own ink for an uncoloured model, which looks deliberate; a model that
 * came out black because its texture could not be loaded looks broken.
 */
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

/** The symbol-to-colour bindings an `<instance_geometry>` carries, which is what
 *  a primitive's `material` attribute names. */
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
// Collada writes 4x4 matrices row-major and column-vector, so a point is `M * p`
// and the translation is the last *column*. A node may also carry any number of
// `<translate>`, `<rotate>` and `<scale>` elements, and they compose **in
// document order** - which is the part that is easy to get wrong, because the
// order is the order they are applied outermost-first.

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

/** Rodrigues, with the angle in degrees - which is what Collada writes. */
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
