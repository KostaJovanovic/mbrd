// 3D model parsing — twelve formats, zero dependencies, no DOM/WebGL.
// meshKind() classifies, parseMesh() reads synchronously, readModel() adds
// the async CAD-kernel path. STL/OBJ/glTF live here; the rest under mesh/.
// All parsers must stay synchronous — the ceiling/lift mechanism depends on it.

import { oversize, mb } from './consent.ts';
import { extOf } from './util.ts';
import {
  CAPS, MeshError, MAX_BUFFER_BYTES, MAX_ELEMENTS, MAX_TRIANGLES,
  clamp01, fillFacetGaps, finish, fixFacet, fixFacetArrays,
  grow, liftCaps, newBox, resetCaps, tooBig,
  type Mesh, type MeshBounds,
} from './mesh/shared.ts';
import { parsePLY } from './mesh/ply.ts';
import { parseOFF } from './mesh/off.ts';
import { parse3MF } from './mesh/threemf.ts';
import { parseAMF } from './mesh/amf.ts';
import { parseFBX } from './mesh/fbx.ts';
import { parseCollada } from './mesh/collada.ts';
import { parse3DS } from './mesh/tds.ts';
import { parseSTEP } from './mesh/step.ts';
import { parseIGES } from './mesh/iges.ts';
import { kernelMesh, usesKernel } from './mesh/occt.ts';

export { MeshError, MAX_TRIANGLES, MAX_ELEMENTS };
export type { Mesh, MeshBounds };

// A viewless accessor claims size without carrying bytes — bound it tightly.
const VIEWLESS_MAX = 100_000;

const MAX_NODE_DEPTH = 4096;
const MAX_NODE_VISITS = 1_000_000;

// ---------------------------------------------------------------------------
// glTF document shape — all fields optional (untrusted input).
// ---------------------------------------------------------------------------

type GLTFNode = {
  matrix?: number[];
  translation?: number[];
  rotation?: number[];
  scale?: number[];
  mesh?: number;
  children?: number[];
};

type GLTFPrimitive = {
  mode?: number;
  indices?: number;
  attributes?: { POSITION?: number, NORMAL?: number };
};

type GLTFAccessor = {
  type?: string;
  componentType?: number;
  count?: number;
  bufferView?: number;
  byteOffset?: number;
};

type GLTFBufferView = {
  buffer?: number;
  byteOffset?: number;
  byteStride?: number;
};

type GLTF = {
  buffers?: { uri?: string }[];
  bufferViews?: GLTFBufferView[];
  accessors?: GLTFAccessor[];
  meshes?: { primitives?: GLTFPrimitive[] }[];
  nodes?: GLTFNode[];
  scenes?: { nodes?: number[] }[];
  scene?: number;
};

type Matrix = number[];

export type MeshKind =
  | 'stl' | 'obj' | 'glb' | 'ply' | 'off' | '3mf' | 'amf'
  | 'fbx' | 'dae' | '3ds' | 'step' | 'iges';

const KINDS: Record<string, MeshKind> = {
  stl: 'stl',
  obj: 'obj',
  glb: 'glb', gltf: 'glb',
  ply: 'ply',
  off: 'off', coff: 'off', noff: 'off',
  '3mf': '3mf',
  amf: 'amf',
  fbx: 'fbx',
  dae: 'dae',
  '3ds': '3ds',
  step: 'step', stp: 'step',
  iges: 'iges', igs: 'iges',
};

export function meshKind(name = ''): MeshKind | null {
  return KINDS[extOf(name)] || null;
}

// CAD/manufacturing formats are Z-up; rendering formats are Y-up.
// FBX and Collada read it from the document and set Mesh.upAxis instead.
const Z_UP: Set<unknown> = new Set(['stl', 'obj', '3mf', 'amf', 'step', 'iges']);

export const defaultUpAxis = (kind: string | null) => (Z_UP.has(kind) ? 'z' : 'y');

// glTF, FBX, Collada know their axis — the rest are guesses the user can flip.
const GUESSED: Set<unknown> = new Set(['stl', 'obj', 'ply', '3ds', '3mf', 'amf', 'step', 'iges']);

export const upAxisIsGuessed = (kind: string | null) => GUESSED.has(kind);

const PARSERS: Record<MeshKind, (bytes: ArrayBuffer) => Mesh> = {
  stl: parseSTL,
  obj: parseOBJ,
  glb: parseGLB,
  ply: parsePLY,
  off: parseOFF,
  '3mf': parse3MF,
  amf: parseAMF,
  fbx: parseFBX,
  dae: parseCollada,
  '3ds': parse3DS,
  step: parseSTEP,
  iges: parseIGES,
};

// Map for runtime lookup — unknown kinds from saved boards return undefined.
const BY_KIND = new Map<string, (bytes: ArrayBuffer) => Mesh>(Object.entries(PARSERS));

export function parseMesh(
  kind: string | null,
  bytes: ArrayBuffer,
  upAxis?: unknown,
  lift = false,
): Mesh {
  if (lift) liftCaps();
  try {
    const read = kind ? BY_KIND.get(kind) : undefined;
    if (!read) throw new MeshError('Not a model file');
    return orient(kind, read(bytes), upAxis);
  } finally {
    resetCaps();
  }
}

// Up-axis priority: user override > file-stated > format default.
function orient(kind: string | null, mesh: Mesh, upAxis?: unknown): Mesh {
  const said = mesh.upAxis === 'z' || mesh.upAxis === 'y' ? mesh.upAxis : null;
  const up = upAxis === 'z' || upAxis === 'y' ? upAxis : said || defaultUpAxis(kind);
  return up === 'z' ? standUp(mesh) : mesh;
}

// Async entry point — tries the CAD kernel for STEP/IGES, falls back to parseMesh().
export async function readModel(
  kind: string | null,
  bytes: ArrayBuffer,
  upAxis?: unknown,
  lift = false,
): Promise<Mesh> {
  if (usesKernel(kind)) {
    const mesh = await kernelMesh(kind, bytes, lift ? Infinity : MAX_TRIANGLES);
    if (mesh) return orient(kind, mesh, upAxis);
  }
  return parseMesh(kind, bytes, upAxis, lift);
}

// Z-up → Y-up: rotate -90° about X, in place. Bounds rotated to match.
function standUp(mesh: Mesh) {
  for (const a of [mesh.positions, mesh.normals]) {
    for (let i = 0; i < a.length; i += 3) {
      const y = a[i + 1];
      a[i + 1] = a[i + 2];
      a[i + 2] = -y;
    }
  }
  const { min, max } = mesh.bounds;
  mesh.bounds = {
    min: [min[0], min[2], -max[1]],
    max: [max[0], max[2], -min[1]],
  };
  return mesh;
}

// ---------------------------------------------------------------------------
// STL
// ---------------------------------------------------------------------------

// Binary vs ASCII: check 84+50n length, not "solid" — exporters write "solid" in binary headers.
export function parseSTL(bytes: ArrayBuffer): Mesh {
  const view = new DataView(bytes);
  if (bytes.byteLength >= 84) {
    const n = view.getUint32(80, true);
    if (bytes.byteLength === 84 + n * 50) return binarySTL(view, n);
  }
  return asciiSTL(new TextDecoder().decode(bytes));
}

function binarySTL(view: DataView, n: number) {
  if (n > CAPS.tri) throw oversize('mesh-triangles', tooBig(n));
  const positions = new Float32Array(n * 9);
  const normals = new Float32Array(n * 9);
  const box = newBox();

  for (let t = 0; t < n; t++) {
    const at = 84 + t * 50; // 50 bytes per facet
    const nx = view.getFloat32(at, true);
    const ny = view.getFloat32(at + 4, true);
    const nz = view.getFloat32(at + 8, true);
    for (let v = 0; v < 3; v++) {
      const p = at + 12 + v * 12;
      const i = t * 9 + v * 3;
      positions[i] = view.getFloat32(p, true);
      positions[i + 1] = view.getFloat32(p + 4, true);
      positions[i + 2] = view.getFloat32(p + 8, true);
      normals[i] = nx; normals[i + 1] = ny; normals[i + 2] = nz;
      grow(box, positions[i], positions[i + 1], positions[i + 2]);
    }
    fixFacet(positions, normals, t * 9);
  }
  return finish(positions, normals, box);
}

function asciiSTL(text: string) {
  const facets = text.match(/facet[\s\S]*?endfacet/g);
  if (!facets) throw new MeshError('This STL has no facets in it');
  if (facets.length > CAPS.tri) throw oversize('mesh-triangles', tooBig(facets.length));

  const positions = new Float32Array(facets.length * 9);
  const normals = new Float32Array(facets.length * 9);
  const box = newBox();
  let t = 0;

  for (const facet of facets) {
    const nums = facet.match(/[-+]?(?:\d+\.?\d*|\.\d+)(?:[eE][-+]?\d+)?/g);
    if (!nums || nums.length < 12) continue;
    const n = nums.map(Number);
    const base = t * 9;
    for (let v = 0; v < 3; v++) {
      const i = base + v * 3;
      positions[i] = n[3 + v * 3];
      positions[i + 1] = n[4 + v * 3];
      positions[i + 2] = n[5 + v * 3];
      normals[i] = n[0]; normals[i + 1] = n[1]; normals[i + 2] = n[2];
      grow(box, positions[i], positions[i + 1], positions[i + 2]);
    }
    fixFacet(positions, normals, base);
    t++;
  }
  if (!t) throw new MeshError('This STL has no facets in it');
  return finish(positions.subarray(0, t * 9), normals.subarray(0, t * 9), box);
}

// ---------------------------------------------------------------------------
// OBJ
// ---------------------------------------------------------------------------

// OBJ: 1-based indices (may be negative), n-gon fan triangulation, optional normals.
export function parseOBJ(bytes: string | ArrayBuffer): Mesh {
  const text = typeof bytes === 'string' ? bytes : new TextDecoder().decode(bytes);
  const vx: number[] = [], vn: number[] = [], vc: number[] = [];
  const outP: number[] = [], outN: number[] = [], outC: number[] = [];
  const triMat: (string | null)[] = [];
  let hasVC = false, mtllib: string | null = null, material: string | null = null;
  const box = newBox();

  for (const raw of text.split('\n')) {
    const line = raw.trim();
    if (!line || line[0] === '#') continue;
    const sp = line.search(/\s/);
    if (sp < 0) continue;
    const tag = line.slice(0, sp);
    if (tag === 'v') {
      const n = line.slice(sp + 1).trim().split(/\s+/);
      vx.push(+n[0], +n[1], +n[2]);
      // Per-vertex colour (3 extra floats on the v line) — unofficial but universal.
      if (n.length >= 6) {
        if (!hasVC) { for (let k = outC.length; k < outP.length; k++) outC.push(1); }
        hasVC = true;
        vc.push(clamp01(+n[3]), clamp01(+n[4]), clamp01(+n[5]));
      } else vc.push(1, 1, 1);
    } else if (tag === 'vn') {
      const n = line.slice(sp + 1).trim().split(/\s+/);
      vn.push(+n[0], +n[1], +n[2]);
    } else if (tag === 'usemtl') {
      material = line.slice(sp + 1).trim() || null;
    } else if (tag === 'mtllib') {
      if (!mtllib) mtllib = line.slice(sp + 1).trim() || null;
    } else if (tag === 'f') {
      const corners = line.slice(sp + 1).trim().split(/\s+/);
      if (corners.length < 3) continue;
      for (let i = 1; i + 1 < corners.length; i++) {
        if (outP.length / 9 >= CAPS.tri) throw oversize('mesh-triangles', tooBig(CAPS.tri));
        const wantC = hasVC ? outC : null;
        emitCorner(corners[0], vx, vn, vc, outP, outN, wantC, box);
        emitCorner(corners[i], vx, vn, vc, outP, outN, wantC, box);
        emitCorner(corners[i + 1], vx, vn, vc, outP, outN, wantC, box);
        triMat.push(material);
        fillFacetGaps(outP, outN, outP.length - 9);
      }
    }
  }
  if (!outP.length) throw new MeshError('This OBJ has no faces in it');
  const mesh = finish(new Float32Array(outP), new Float32Array(outN), box);
  mesh.colors = hasVC ? new Float32Array(outC) : null;
  mesh.mtllib = mtllib;
  mesh.triMat = triMat.some(Boolean) ? triMat : null;
  return mesh;
}

function emitCorner(
  spec: string, vx: number[], vn: number[], vc: number[],
  outP: number[], outN: number[], outC: number[] | null, box: MeshBounds,
) {
  const parts = spec.split('/');
  const pi = resolve(+parts[0], vx.length / 3);
  const ni = parts[2] ? resolve(+parts[2], vn.length / 3) : -1;
  const x = vx[pi * 3] || 0, y = vx[pi * 3 + 1] || 0, z = vx[pi * 3 + 2] || 0;
  outP.push(x, y, z);
  if (ni >= 0) outN.push(vn[ni * 3] || 0, vn[ni * 3 + 1] || 0, vn[ni * 3 + 2] || 0);
  else outN.push(0, 0, 0);
  if (outC) {
    const c = pi * 3;
    outC.push(vc[c] ?? 1, vc[c + 1] ?? 1, vc[c + 2] ?? 1);
  }
  grow(box, x, y, z);
}

// ---------------------------------------------------------------------------
// .mtl
// ---------------------------------------------------------------------------

// Parse .mtl for diffuse colour (Kd) only — textures need a separate file.
export function parseMTL(bytes: string | ArrayBuffer) {
  const text = typeof bytes === 'string' ? bytes : new TextDecoder().decode(bytes);
  const mats = new Map<string, number[] | null>();
  let cur: string | null = null;
  for (const raw of text.split('\n')) {
    const line = raw.trim();
    if (!line || line[0] === '#') continue;
    const sp = line.search(/\s/);
    const tag = sp < 0 ? line : line.slice(0, sp);
    const rest = sp < 0 ? '' : line.slice(sp + 1).trim();
    if (tag === 'newmtl') {
      cur = rest;
      if (cur) mats.set(cur, null);
    } else if (cur && tag === 'Kd') {
      const n = rest.split(/\s+/);
      if (n.length >= 3 && n.every(v => Number.isFinite(+v))) {
        mats.set(cur, [clamp01(+n[0]), clamp01(+n[1]), clamp01(+n[2])]);
      }
    }
  }
  return mats;
}

// Bake Kd into per-vertex colours. Returns false if nothing matched.
export function applyMaterials(
  mesh: Mesh | null | undefined,
  materials: Map<string, number[] | null> | null | undefined,
) {
  if (!mesh?.triMat || !materials?.size) return false;
  const colors = new Float32Array(mesh.count * 3);
  let any = false;
  for (let t = 0; t < mesh.triMat.length; t++) {
    const name = mesh.triMat[t];
    const kd = name ? materials.get(name) : null;
    if (kd) any = true;
    const r = kd ? kd[0] : 1, g = kd ? kd[1] : 1, b = kd ? kd[2] : 1;
    for (let k = 0; k < 9; k += 3) {
      colors[t * 9 + k] = r;
      colors[t * 9 + k + 1] = g;
      colors[t * 9 + k + 2] = b;
    }
  }
  if (!any) return false;
  mesh.colors = colors;
  return true;
}

function resolve(i: number, have: number) {
  if (!Number.isFinite(i) || i === 0) return 0;
  return i > 0 ? i - 1 : have + i;
}

// ---------------------------------------------------------------------------
// glTF / GLB
// ---------------------------------------------------------------------------

const GLB_MAGIC = 0x46546c67;   // 'glTF', little-endian
const CHUNK_JSON = 0x4e4f534a;  // 'JSON'
const CHUNK_BIN = 0x004e4942;   // 'BIN\0'

// GLB/glTF: reads POSITION+NORMAL through the scene graph. No external buffers.
export function parseGLB(bytes: ArrayBuffer): Mesh {
  let json: GLTF | null = null;
  let bin: Uint8Array | null = null;

  const view = new DataView(bytes);
  if (bytes.byteLength >= 12 && view.getUint32(0, true) === GLB_MAGIC) {
    let at = 12;
    while (at + 8 <= bytes.byteLength) {
      const len = view.getUint32(at, true);
      const type = view.getUint32(at + 4, true);
      const body = at + 8;
      if (body + len > bytes.byteLength) throw new MeshError('This GLB is truncated');
      if (type === CHUNK_JSON) {
        try {
          json = JSON.parse(new TextDecoder().decode(new Uint8Array(bytes, body, len)));
        } catch {
          throw new MeshError('This is not a glTF file');
        }
      }
      else if (type === CHUNK_BIN) bin = new Uint8Array(bytes, body, len);
      at = body + len + ((4 - (len % 4)) % 4);
    }
    if (!json) throw new MeshError('This GLB has no glTF in it');
  } else {
    try {
      json = JSON.parse(new TextDecoder().decode(bytes));
    } catch {
      throw new MeshError('This is not a glTF file');
    }
    if (!json) throw new MeshError('This is not a glTF file');
  }

  const buffers = (json.buffers || []).map(b => {
    if (!b.uri) return bin;
    if (b.uri.startsWith('data:')) return dataURIBytes(b.uri);
    throw new MeshError('This glTF keeps its data in a separate file, which a drop cannot reach');
  });

  const outP: number[] = [], outN: number[] = [];
  const box = newBox();
  const roots = json.scenes?.length
    ? (json.scenes[json.scene ?? 0]?.nodes ?? [])
    : (json.nodes || []).map((_, i) => i);
  const walk: Walk = { visits: 0, accessors: new Map(), elements: 0 };
  for (const root of roots) walkNode(json, buffers, root, outP, outN, box, walk);

  if (!outP.length) throw new MeshError('This model has no geometry in it');
  return finish(new Float32Array(outP), new Float32Array(outN), box);
}

const IDENTITY = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];

type Frame = {
  index: number;
  parent: Matrix;
  phase: 0 | 1;
  world: Matrix;
  children: number[];
  ci: number;
};

/** State for one parse, across every root. A node reached by two paths is
 *  drawn twice, which is what instancing means, so visits are counted rather
 *  than refused - and counted for the whole scene, since a scene may list one
 *  root any number of times. */
type Walk = {
  visits: number;
  /** Accessors already read, by index. A shared child is visited once per
   *  path, and reading its arrays again on each visit made a chain of shared
   *  children with an empty index list cost hours while drawing nothing. */
  accessors: Map<number, ReturnType<typeof readAccessor>>;
  /** Elements allocated by those reads, held against the parse ceiling. */
  elements: number;
};

// Iterative scene-graph walk with cycle detection and depth/visit ceilings.
function walkNode(
  json: GLTF, buffers: (Uint8Array | null)[], root: number,
  outP: number[], outN: number[], box: MeshBounds, walk: Walk,
) {
  const seen = new Set<number>();
  const stack: Frame[] = [{ index: root, parent: IDENTITY, phase: 0, world: IDENTITY, children: [], ci: 0 }];
  while (stack.length) {
    if (stack.length > MAX_NODE_DEPTH) throw new MeshError('This model is nested too deeply');
    const frame = stack[stack.length - 1];
    if (frame.phase === 0) {
      const node = json.nodes?.[frame.index];
      if (!node || seen.has(frame.index)) { stack.pop(); continue; }
      if (++walk.visits > MAX_NODE_VISITS) throw new MeshError('This model has too many nodes in it');
      seen.add(frame.index);

      const local = isMatrix(node.matrix) ? node.matrix : trs(node);
      frame.world = mul(frame.parent, local);

      if (node.mesh !== undefined) {
        for (const prim of json.meshes?.[node.mesh]?.primitives || []) {
          if (prim.mode !== undefined && prim.mode !== 4) continue; // TRIANGLES only
          addPrimitive(json, buffers, prim, frame.world, outP, outN, box, walk);
        }
      }
      frame.children = node.children || [];
      frame.ci = 0;
      frame.phase = 1;
    }
    if (frame.ci < frame.children.length) {
      stack.push({
        index: frame.children[frame.ci++], parent: frame.world, phase: 0,
        world: IDENTITY, children: [], ci: 0,
      });
    } else {
      seen.delete(frame.index);
      stack.pop();
    }
  }
}

/** How many times the per-array ceiling one parse may allocate in total. A
 *  model at the triangle ceiling with positions, normals and indices in
 *  separate primitives reaches about seven. */
const PARSE_ELEMENTS = 8;

function accessorOnce(json: GLTF, buffers: (Uint8Array | null)[], index: number | undefined, walk: Walk) {
  if (index === undefined) return null;
  if (walk.accessors.has(index)) return walk.accessors.get(index) ?? null;
  const out = readAccessor(json, buffers, index, CAPS.elem * PARSE_ELEMENTS - walk.elements);
  walk.accessors.set(index, out);
  if (out) walk.elements += out.length;
  return out;
}

function addPrimitive(
  json: GLTF, buffers: (Uint8Array | null)[], prim: GLTFPrimitive, m: Matrix,
  outP: number[], outN: number[], box: MeshBounds, walk: Walk,
) {
  const pos = accessorOnce(json, buffers, prim.attributes?.POSITION, walk);
  if (!pos) return;
  const nrm = accessorOnce(json, buffers, prim.attributes?.NORMAL, walk);
  const idx = prim.indices !== undefined ? accessorOnce(json, buffers, prim.indices, walk) : null;
  const n = idx ? idx.length : pos.length / 3;
  if (n % 3) return;
  if (outP.length / 9 + n / 3 > CAPS.tri) throw oversize('mesh-triangles', tooBig(CAPS.tri));

  const nm = normalMatrix(m); // inverse transpose for correct normals under non-uniform scale
  const verts = pos.length / 3;
  for (let k = 0; k < n; k++) {
    const v = idx ? idx[k] : k;
    if (v < 0 || v >= verts) throw new MeshError('This model refers to vertices it does not contain');
    const p = xform(m, pos[v * 3], pos[v * 3 + 1], pos[v * 3 + 2]);
    outP.push(p[0], p[1], p[2]);
    grow(box, p[0], p[1], p[2]);
    if (nrm) {
      const q = xform3(nm, nrm[v * 3], nrm[v * 3 + 1], nrm[v * 3 + 2]);
      outN.push(q[0], q[1], q[2]);
    } else {
      outN.push(0, 0, 0);
    }
  }
  if (!nrm) {
    for (let base = outP.length - n * 3; base < outP.length; base += 9) {
      fixFacetArrays(outP, outN, base);
    }
  }
}

const COMPONENTS: Record<string, number | undefined> =
  { SCALAR: 1, VEC2: 2, VEC3: 3, VEC4: 4, MAT4: 16 };

// `signed` selects Int32Array vs Uint32Array for the output buffer.
const READERS: Record<number, {
  size: number, signed?: boolean, read: (view: DataView, at: number) => number,
} | undefined> = {
  5120: { size: 1, signed: true, read: (v, at) => v.getInt8(at) },
  5121: { size: 1, read: (v, at) => v.getUint8(at) },
  5122: { size: 2, signed: true, read: (v, at) => v.getInt16(at, true) },
  5123: { size: 2, read: (v, at) => v.getUint16(at, true) },
  5125: { size: 4, read: (v, at) => v.getUint32(at, true) },
  5126: { size: 4, read: (v, at) => v.getFloat32(at, true) },
};

// Element-by-element copy — handles strides and unaligned offsets.
function readAccessor(
  json: GLTF, buffers: (Uint8Array | null)[], index: number | undefined, room = Infinity,
) {
  if (index === undefined) return null;
  const acc = json.accessors?.[index];
  if (!acc) return null;
  const comps = acc.type ? COMPONENTS[acc.type] : undefined;
  const reader = acc.componentType ? READERS[acc.componentType] : undefined;
  if (!comps || !reader) return null;
  const size = reader.size;
  const count = acc.count;
  if (typeof count !== 'number' || !Number.isInteger(count) || count < 0) {
    throw new MeshError('This model declares an implausible amount of geometry');
  }
  if (count > CAPS.elem) throw oversize('mesh-triangles', manyElements(count));
  // Also check count*comps — MAT4 multiplies the allocation by 16.
  if (count * comps > CAPS.elem) throw oversize('mesh-triangles', manyElements(count * comps));
  // And the parse as a whole: many arrays each under the line above still add up.
  if (count * comps > room) throw oversize('mesh-triangles', manyInTotal());

  const bv = json.bufferViews?.[acc.bufferView ?? -1];
  const Arr = acc.componentType === 5126 ? Float32Array
    : reader.signed ? Int32Array
    : Uint32Array;
  const alloc = () => new Arr(count * comps);
  if (!bv) {
    if (count * comps > VIEWLESS_MAX) {
      throw new MeshError('This model declares data it does not contain');
    }
    return alloc();
  }
  const out = alloc();
  const buf = bv.buffer === undefined ? null : buffers[bv.buffer];
  if (!buf) throw new MeshError('This model refers to data that is not in the file');

  const start = (bv.byteOffset || 0) + (acc.byteOffset || 0);
  const stride = bv.byteStride || comps * size;
  const view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  const get = reader.read;

  for (let e = 0; e < count; e++) {
    for (let c = 0; c < comps; c++) {
      const at = start + e * stride + c * size;
      if (at + size > view.byteLength) throw new MeshError('This model is truncated');
      out[e * comps + c] = get(view, at);
    }
  }
  return out;
}

function dataURIBytes(uri: string) {
  const comma = uri.indexOf(',');
  if (comma < 0) throw new MeshError('This model has a malformed data URI in it');
  const head = uri.slice(0, comma);
  const body = uri.slice(comma + 1);
  if (body.length / 4 * 3 > CAPS.buf) {
    throw oversize(
      'mesh-buffer',
      `This model embeds a ${mb(body.length / 4 * 3)} buffer inside itself, past the `
      + `${mb(MAX_BUFFER_BYTES)} one is decoded at.`,
    );
  }
  if (!head.includes(';base64')) return new TextEncoder().encode(decodeURIComponent(body));
  const bin = atob(body);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

const isMatrix = (m: unknown): m is number[] =>
  Array.isArray(m) && m.length === 16 && m.every(n => typeof n === 'number' && Number.isFinite(n));

function trs(node: GLTFNode): Matrix {
  const [tx, ty, tz] = node.translation || [0, 0, 0];
  const [qx, qy, qz, qw] = node.rotation || [0, 0, 0, 1];
  const [sx, sy, sz] = node.scale || [1, 1, 1];
  const x2 = qx + qx, y2 = qy + qy, z2 = qz + qz;
  const xx = qx * x2, xy = qx * y2, xz = qx * z2;
  const yy = qy * y2, yz = qy * z2, zz = qz * z2;
  const wx = qw * x2, wy = qw * y2, wz = qw * z2;
  return [
    (1 - (yy + zz)) * sx, (xy + wz) * sx, (xz - wy) * sx, 0,
    (xy - wz) * sy, (1 - (xx + zz)) * sy, (yz + wx) * sy, 0,
    (xz + wy) * sz, (yz - wx) * sz, (1 - (xx + yy)) * sz, 0,
    tx, ty, tz, 1,
  ];
}

function mul(a: Matrix, b: Matrix): Matrix {
  const out = new Array<number>(16);
  for (let c = 0; c < 4; c++) {
    for (let r = 0; r < 4; r++) {
      out[c * 4 + r] = a[r] * b[c * 4] + a[4 + r] * b[c * 4 + 1] +
                       a[8 + r] * b[c * 4 + 2] + a[12 + r] * b[c * 4 + 3];
    }
  }
  return out;
}

const xform = (m: Matrix, x: number, y: number, z: number) => [
  m[0] * x + m[4] * y + m[8] * z + m[12],
  m[1] * x + m[5] * y + m[9] * z + m[13],
  m[2] * x + m[6] * y + m[10] * z + m[14],
];
const xform3 = (m: Matrix, x: number, y: number, z: number) => [
  m[0] * x + m[3] * y + m[6] * z,
  m[1] * x + m[4] * y + m[7] * z,
  m[2] * x + m[5] * y + m[8] * z,
];

function normalMatrix(m: Matrix): Matrix {
  const a = [m[0], m[1], m[2], m[4], m[5], m[6], m[8], m[9], m[10]];
  const det = a[0] * (a[4] * a[8] - a[5] * a[7])
            - a[3] * (a[1] * a[8] - a[2] * a[7])
            + a[6] * (a[1] * a[5] - a[2] * a[4]);
  if (!det) return a;
  const inv = 1 / det;
  return [
    (a[4] * a[8] - a[5] * a[7]) * inv, (a[6] * a[5] - a[3] * a[8]) * inv, (a[3] * a[7] - a[6] * a[4]) * inv,
    (a[7] * a[2] - a[1] * a[8]) * inv, (a[0] * a[8] - a[6] * a[2]) * inv, (a[6] * a[1] - a[0] * a[7]) * inv,
    (a[1] * a[5] - a[4] * a[2]) * inv, (a[3] * a[2] - a[0] * a[5]) * inv, (a[0] * a[4] - a[3] * a[1]) * inv,
  ];
}

const manyInTotal = () =>
  `This model's arrays add up to more than ${(MAX_ELEMENTS * PARSE_ELEMENTS).toLocaleString()} vertex values, `
  + `more than the ${MAX_TRIANGLES.toLocaleString()}-triangle ceiling leaves room for.`;

const manyElements = (n: number) =>
  `This model declares ${n.toLocaleString()} vertex values in one array, more than the `
  + `${MAX_TRIANGLES.toLocaleString()}-triangle ceiling leaves room for.`;
