// Reading a 3D model, by hand.
//
// Three formats, chosen because between them they cover what actually lands on
// a moodboard: an STL off a printer or a scanner, an OBJ out of almost any
// modeller, and a GLB, which is what the web has settled on. No dependency -
// the same reason storage/zip.js inflates its own entries and import/artwork.js
// walks its own ID3 frames. A mesh loader is a few hundred lines of struct
// reading, and this project's one real property is that it has none.
//
// Everything here returns the same shape, so canvas/model.js only knows about
// one thing:
//
//   { positions: Float32Array,   // xyz per vertex, triangles already expanded
//     normals:   Float32Array,   // xyz per vertex, unit length
//     count:     number,         // vertices, so count/3 triangles
//     bounds:    { min: [x,y,z], max: [x,y,z] } }
//
// Indices are resolved rather than kept. A moodboard draws a model once at a
// small size and never edits it, so the memory an index buffer saves is not
// worth a second code path in the drawing.
//
// Nothing here touches the DOM or WebGL, which is what lets the whole file be
// tested against real bytes under node.

/**
 * The ceiling, in triangles.
 *
 * A 3D file has no natural size limit and a dropped folder is not vetted, so
 * this is the same kind of guard zip.js puts on an inflated entry: past it the
 * file is refused with a message rather than being allowed to take the tab
 * down. Two million triangles is roughly a 100MB binary STL and far more detail
 * than a card a few hundred pixels wide can show - the honest failure is "too
 * big to look at", not a black canvas after forty seconds.
 */
export const MAX_TRIANGLES = 2_000_000;

export class MeshError extends Error {}

/** Which parser a file wants, or null if it is not a model at all. */
export function meshKind(name = '') {
  const i = name.lastIndexOf('.');
  const ext = i > 0 ? name.slice(i + 1).toLowerCase() : '';
  if (ext === 'stl') return 'stl';
  if (ext === 'obj') return 'obj';
  if (ext === 'glb' || ext === 'gltf') return 'glb';
  return null;
}

/** Parse by kind. `bytes` is an ArrayBuffer. */
export function parseMesh(kind, bytes) {
  if (kind === 'stl') return parseSTL(bytes);
  if (kind === 'obj') return parseOBJ(bytes);
  if (kind === 'glb') return parseGLB(bytes);
  throw new MeshError('Not a model file');
}

// ---------------------------------------------------------------------------
// STL
// ---------------------------------------------------------------------------

/**
 * Binary or ASCII, told apart by arithmetic rather than by the leading word.
 *
 * The usual sniff - does it start with "solid"? - is wrong often enough to
 * matter: plenty of exporters write "solid" into the binary format's 80-byte
 * header, which is free-form text, and the file then parses as ASCII and comes
 * out empty. A binary STL's length is exactly 84 + 50n for its own declared n,
 * and that is a coincidence no ASCII file survives.
 */
export function parseSTL(bytes) {
  const view = new DataView(bytes);
  if (bytes.byteLength >= 84) {
    const n = view.getUint32(80, true);
    if (bytes.byteLength === 84 + n * 50) return binarySTL(view, n);
  }
  return asciiSTL(new TextDecoder().decode(bytes));
}

function binarySTL(view, n) {
  if (n > MAX_TRIANGLES) throw new MeshError(tooBig(n));
  const positions = new Float32Array(n * 9);
  const normals = new Float32Array(n * 9);
  const box = newBox();

  for (let t = 0; t < n; t++) {
    // 50 bytes a facet: a normal, three vertices, and two bytes of attribute
    // that carry a colour in some dialects and nothing in most.
    const at = 84 + t * 50;
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
    // A facet normal of zero is legal and common - some exporters simply do not
    // write them - so it is recomputed from the winding rather than trusted.
    fixFacet(positions, normals, t * 9);
  }
  return finish(positions, normals, box);
}

function asciiSTL(text) {
  // One pass with a number-hungry regex rather than a line reader: an ASCII STL
  // has no structure worth respecting beyond the order its numbers arrive in,
  // and the line breaks are not reliable across exporters.
  const facets = text.match(/facet[\s\S]*?endfacet/g);
  if (!facets) throw new MeshError('This STL has no facets in it');
  if (facets.length > MAX_TRIANGLES) throw new MeshError(tooBig(facets.length));

  const positions = new Float32Array(facets.length * 9);
  const normals = new Float32Array(facets.length * 9);
  const box = newBox();
  let t = 0;

  for (const facet of facets) {
    const nums = facet.match(/-?\d+(?:\.\d+)?(?:[eE][-+]?\d+)?/g);
    // A normal (3) and three vertices (9). Fewer means a truncated facet, and
    // a facet that is not a triangle is not one this can draw.
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

/**
 * Wavefront OBJ: a text file of vertices and the faces that join them.
 *
 * Three things about the format that the code below is shaped by:
 *
 * - **Indices are one-based, and may be negative.** A negative index counts
 *   backwards from the vertices seen *so far*, which is why they are resolved
 *   as they are read rather than in a second pass.
 * - **A face may have any number of corners.** Quads are ordinary and n-gons
 *   happen, so every face is fanned into triangles from its first corner. That
 *   is correct for the convex faces a modeller emits and is the standard
 *   reading.
 * - **Normals are optional.** Where a face gives them they are used; where it
 *   does not, the facet's own is computed. Mixing the two within one file is
 *   legal and does happen.
 *
 * Materials, groups, smoothing and texture coordinates are read past. A card on
 * a moodboard is a silhouette and a bit of shading; none of the rest would
 * change a pixel of it without a .mtl beside the file, which a drop does not
 * carry.
 */
export function parseOBJ(bytes) {
  const text = typeof bytes === 'string' ? bytes : new TextDecoder().decode(bytes);
  const vx = [], vn = [];
  const outP = [], outN = [];
  const box = newBox();

  for (const raw of text.split('\n')) {
    const line = raw.trim();
    if (!line || line[0] === '#') continue;
    const sp = line.indexOf(' ');
    if (sp < 0) continue;
    const tag = line.slice(0, sp);
    if (tag === 'v') {
      const n = line.slice(sp + 1).trim().split(/\s+/);
      vx.push(+n[0], +n[1], +n[2]);
    } else if (tag === 'vn') {
      const n = line.slice(sp + 1).trim().split(/\s+/);
      vn.push(+n[0], +n[1], +n[2]);
    } else if (tag === 'f') {
      const corners = line.slice(sp + 1).trim().split(/\s+/);
      if (corners.length < 3) continue;
      for (let i = 1; i + 1 < corners.length; i++) {
        if (outP.length / 9 >= MAX_TRIANGLES) throw new MeshError(tooBig(MAX_TRIANGLES));
        emitCorner(corners[0], vx, vn, outP, outN, box);
        emitCorner(corners[i], vx, vn, outP, outN, box);
        emitCorner(corners[i + 1], vx, vn, outP, outN, box);
        // A face that gave no normals gets the facet's own.
        if (!outN[outP.length - 1] && !outN[outP.length - 2] && !outN[outP.length - 3]) {
          fixFacetArrays(outP, outN, outP.length - 9);
        }
      }
    }
  }
  if (!outP.length) throw new MeshError('This OBJ has no faces in it');
  return finish(new Float32Array(outP), new Float32Array(outN), box);
}

/** One `v/vt/vn` corner, resolved against what has been read so far. */
function emitCorner(spec, vx, vn, outP, outN, box) {
  const parts = spec.split('/');
  const pi = resolve(+parts[0], vx.length / 3);
  const ni = parts[2] ? resolve(+parts[2], vn.length / 3) : -1;
  const x = vx[pi * 3] || 0, y = vx[pi * 3 + 1] || 0, z = vx[pi * 3 + 2] || 0;
  outP.push(x, y, z);
  if (ni >= 0) outN.push(vn[ni * 3] || 0, vn[ni * 3 + 1] || 0, vn[ni * 3 + 2] || 0);
  else outN.push(0, 0, 0);
  grow(box, x, y, z);
}

/** One-based, or negative and counting back from the end. */
function resolve(i, have) {
  if (!Number.isFinite(i) || i === 0) return 0;
  return i > 0 ? i - 1 : have + i;
}

// ---------------------------------------------------------------------------
// glTF / GLB
// ---------------------------------------------------------------------------

const GLB_MAGIC = 0x46546c67;   // 'glTF', little-endian
const CHUNK_JSON = 0x4e4f534a;  // 'JSON'
const CHUNK_BIN = 0x004e4942;   // 'BIN\0'

/**
 * A GLB is a three-part container - header, JSON chunk, binary chunk - around
 * a glTF document, and a .gltf is that document on its own.
 *
 * What is read: every primitive of every mesh reachable from a node, with its
 * POSITION and NORMAL accessors, transformed by the node's place in the scene
 * graph. What is not: materials, textures, animation, skins, morph targets,
 * cameras, and any buffer that lives in a separate file.
 *
 * That last one is a real limitation and it is deliberate. A .gltf pointing at
 * `scene.bin` beside it cannot be resolved from a dropped file - the browser
 * has one File and no directory to look in - and going and fetching it would
 * be a network request, which is the one thing this app does not do. So a
 * self-contained GLB works, a .gltf with embedded base64 buffers works, and a
 * .gltf with external buffers says so.
 */
export function parseGLB(bytes) {
  let json = null, bin = null;

  const view = new DataView(bytes);
  if (bytes.byteLength >= 12 && view.getUint32(0, true) === GLB_MAGIC) {
    let at = 12;
    while (at + 8 <= bytes.byteLength) {
      const len = view.getUint32(at, true);
      const type = view.getUint32(at + 4, true);
      const body = at + 8;
      if (body + len > bytes.byteLength) throw new MeshError('This GLB is truncated');
      if (type === CHUNK_JSON) json = JSON.parse(new TextDecoder().decode(new Uint8Array(bytes, body, len)));
      else if (type === CHUNK_BIN) bin = new Uint8Array(bytes, body, len);
      // Chunks are four-byte aligned, and an unknown one is skipped by spec.
      at = body + len + ((4 - (len % 4)) % 4);
    }
    if (!json) throw new MeshError('This GLB has no glTF in it');
  } else {
    try {
      json = JSON.parse(new TextDecoder().decode(bytes));
    } catch {
      throw new MeshError('This is not a glTF file');
    }
  }

  const buffers = (json.buffers || []).map(b => {
    if (!b.uri) return bin;                       // the GLB's own binary chunk
    if (b.uri.startsWith('data:')) return dataURIBytes(b.uri);
    throw new MeshError('This glTF keeps its data in a separate file, which a drop cannot reach');
  });

  const outP = [], outN = [];
  const box = newBox();
  // Every root of every scene, or - for a document with no scene at all, which
  // is legal - every node, so a single-mesh export still draws.
  const roots = json.scenes?.length
    ? (json.scenes[json.scene ?? 0]?.nodes ?? [])
    : (json.nodes || []).map((_, i) => i);
  for (const root of roots) walkNode(json, buffers, root, IDENTITY, outP, outN, box, new Set());

  if (!outP.length) throw new MeshError('This model has no geometry in it');
  return finish(new Float32Array(outP), new Float32Array(outN), box);
}

const IDENTITY = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];

function walkNode(json, buffers, index, parent, outP, outN, box, seen) {
  const node = json.nodes?.[index];
  if (!node) return;
  // A glTF node graph is meant to be a tree, and a hand-written one is not
  // always: a cycle here would recurse until the stack gave out.
  if (seen.has(index)) return;
  seen.add(index);

  const local = node.matrix ? node.matrix : trs(node);
  const world = mul(parent, local);

  if (node.mesh !== undefined) {
    for (const prim of json.meshes?.[node.mesh]?.primitives || []) {
      // mode 4 is TRIANGLES and is the default. Strips, fans, lines and points
      // are legal and are not what a solid model exports.
      if (prim.mode !== undefined && prim.mode !== 4) continue;
      addPrimitive(json, buffers, prim, world, outP, outN, box);
    }
  }
  for (const child of node.children || []) {
    walkNode(json, buffers, child, world, outP, outN, box, seen);
  }
  seen.delete(index);
}

function addPrimitive(json, buffers, prim, m, outP, outN, box) {
  const pos = readAccessor(json, buffers, prim.attributes?.POSITION);
  if (!pos) return;
  const nrm = readAccessor(json, buffers, prim.attributes?.NORMAL);
  const idx = prim.indices !== undefined ? readAccessor(json, buffers, prim.indices) : null;
  const n = idx ? idx.length : pos.length / 3;
  if (n % 3) return;
  if (outP.length / 9 + n / 3 > MAX_TRIANGLES) throw new MeshError(tooBig(MAX_TRIANGLES));

  // Normals transform by the inverse transpose, not the matrix - a non-uniform
  // scale would otherwise leave them off the surface and the shading wrong.
  const nm = normalMatrix(m);
  for (let k = 0; k < n; k++) {
    const v = idx ? idx[k] : k;
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

const COMPONENTS = { SCALAR: 1, VEC2: 2, VEC3: 3, VEC4: 4, MAT4: 16 };
const READERS = {
  5120: [Int8Array, 1], 5121: [Uint8Array, 1], 5122: [Int16Array, 2],
  5123: [Uint16Array, 2], 5125: [Uint32Array, 4], 5126: [Float32Array, 4],
};

/**
 * One accessor, flattened.
 *
 * Copied out element by element rather than wrapped as a typed array over the
 * buffer, because an accessor may be *strided* - interleaved with other
 * attributes - and because its byteOffset need not be aligned to its own
 * component size, which a typed array view requires and would throw on.
 */
function readAccessor(json, buffers, index) {
  if (index === undefined) return null;
  const acc = json.accessors?.[index];
  if (!acc) return null;
  const comps = COMPONENTS[acc.type];
  const reader = READERS[acc.componentType];
  if (!comps || !reader) return null;
  const [Kind, size] = reader;
  const out = new (acc.componentType === 5126 ? Float32Array : Uint32Array)(acc.count * comps);

  const bv = json.bufferViews?.[acc.bufferView ?? -1];
  // An accessor with no bufferView is defined as all zeroes, and is how a
  // sparse one starts. Sparse substitution itself is not read.
  if (!bv) return out;
  const buf = buffers[bv.buffer];
  if (!buf) throw new MeshError('This model refers to data that is not in the file');

  const start = (bv.byteOffset || 0) + (acc.byteOffset || 0);
  const stride = bv.byteStride || comps * size;
  const view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  const get = { 5120: 'getInt8', 5121: 'getUint8', 5122: 'getInt16',
                5123: 'getUint16', 5125: 'getUint32', 5126: 'getFloat32' }[acc.componentType];

  for (let e = 0; e < acc.count; e++) {
    for (let c = 0; c < comps; c++) {
      const at = start + e * stride + c * size;
      if (at + size > view.byteLength) throw new MeshError('This model is truncated');
      out[e * comps + c] = view[get](at, true);
    }
  }
  return out;
}

function dataURIBytes(uri) {
  const comma = uri.indexOf(',');
  if (comma < 0) throw new MeshError('This model has a malformed data URI in it');
  const head = uri.slice(0, comma);
  const body = uri.slice(comma + 1);
  if (!head.includes(';base64')) return new TextEncoder().encode(decodeURIComponent(body));
  const bin = atob(body);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

/** Translation, rotation (a quaternion) and scale, in that order, as a matrix. */
function trs(node) {
  const [tx, ty, tz] = node.translation || [0, 0, 0];
  const [qx, qy, qz, qw] = node.rotation || [0, 0, 0, 1];
  const [sx, sy, sz] = node.scale || [1, 1, 1];
  const x2 = qx + qx, y2 = qy + qy, z2 = qz + qz;
  const xx = qx * x2, xy = qx * y2, xz = qx * z2;
  const yy = qy * y2, yz = qy * z2, zz = qz * z2;
  const wx = qw * x2, wy = qw * y2, wz = qw * z2;
  // Column-major, which is what glTF's own `matrix` is, so both paths agree.
  return [
    (1 - (yy + zz)) * sx, (xy + wz) * sx, (xz - wy) * sx, 0,
    (xy - wz) * sy, (1 - (xx + zz)) * sy, (yz + wx) * sy, 0,
    (xz + wy) * sz, (yz - wx) * sz, (1 - (xx + yy)) * sz, 0,
    tx, ty, tz, 1,
  ];
}

function mul(a, b) {
  const out = new Array(16);
  for (let c = 0; c < 4; c++) {
    for (let r = 0; r < 4; r++) {
      out[c * 4 + r] = a[r] * b[c * 4] + a[4 + r] * b[c * 4 + 1] +
                       a[8 + r] * b[c * 4 + 2] + a[12 + r] * b[c * 4 + 3];
    }
  }
  return out;
}

const xform = (m, x, y, z) => [
  m[0] * x + m[4] * y + m[8] * z + m[12],
  m[1] * x + m[5] * y + m[9] * z + m[13],
  m[2] * x + m[6] * y + m[10] * z + m[14],
];
const xform3 = (m, x, y, z) => [
  m[0] * x + m[3] * y + m[6] * z,
  m[1] * x + m[4] * y + m[7] * z,
  m[2] * x + m[5] * y + m[8] * z,
];

/** The upper 3x3, inverted and transposed - the correct transform for a normal. */
function normalMatrix(m) {
  const a = [m[0], m[1], m[2], m[4], m[5], m[6], m[8], m[9], m[10]];
  const det = a[0] * (a[4] * a[8] - a[5] * a[7])
            - a[3] * (a[1] * a[8] - a[2] * a[7])
            + a[6] * (a[1] * a[5] - a[2] * a[4]);
  // A degenerate transform (a scale of zero on some axis) has no inverse; the
  // upper 3x3 is then as good an answer as exists and the shading is wrong on
  // geometry that is already flat.
  if (!det) return a;
  const inv = 1 / det;
  return [
    (a[4] * a[8] - a[5] * a[7]) * inv, (a[6] * a[5] - a[3] * a[8]) * inv, (a[3] * a[7] - a[6] * a[4]) * inv,
    (a[7] * a[2] - a[1] * a[8]) * inv, (a[0] * a[8] - a[6] * a[2]) * inv, (a[6] * a[1] - a[0] * a[7]) * inv,
    (a[1] * a[5] - a[4] * a[2]) * inv, (a[3] * a[2] - a[0] * a[5]) * inv, (a[0] * a[4] - a[3] * a[1]) * inv,
  ];
}

// ---------------------------------------------------------------------------
// Shared
// ---------------------------------------------------------------------------

const newBox = () => ({ min: [Infinity, Infinity, Infinity], max: [-Infinity, -Infinity, -Infinity] });

function grow(box, x, y, z) {
  if (x < box.min[0]) box.min[0] = x;
  if (y < box.min[1]) box.min[1] = y;
  if (z < box.min[2]) box.min[2] = z;
  if (x > box.max[0]) box.max[0] = x;
  if (y > box.max[1]) box.max[1] = y;
  if (z > box.max[2]) box.max[2] = z;
}

/** Replace a facet's normals with the one its winding implies, if it has none. */
function fixFacet(positions, normals, base) {
  if (normals[base] || normals[base + 1] || normals[base + 2]) return;
  const n = faceNormal(
    positions[base], positions[base + 1], positions[base + 2],
    positions[base + 3], positions[base + 4], positions[base + 5],
    positions[base + 6], positions[base + 7], positions[base + 8]);
  for (let v = 0; v < 3; v++) {
    normals[base + v * 3] = n[0];
    normals[base + v * 3 + 1] = n[1];
    normals[base + v * 3 + 2] = n[2];
  }
}

/** The same, for the plain arrays the OBJ and glTF paths build into. */
function fixFacetArrays(p, nrm, base) {
  const n = faceNormal(p[base], p[base + 1], p[base + 2],
                       p[base + 3], p[base + 4], p[base + 5],
                       p[base + 6], p[base + 7], p[base + 8]);
  for (let v = 0; v < 3; v++) {
    nrm[base + v * 3] = n[0];
    nrm[base + v * 3 + 1] = n[1];
    nrm[base + v * 3 + 2] = n[2];
  }
}

function faceNormal(ax, ay, az, bx, by, bz, cx, cy, cz) {
  const ux = bx - ax, uy = by - ay, uz = bz - az;
  const vx = cx - ax, vy = cy - ay, vz = cz - az;
  const x = uy * vz - uz * vy;
  const y = uz * vx - ux * vz;
  const z = ux * vy - uy * vx;
  const len = Math.hypot(x, y, z);
  // A degenerate triangle - three collinear points, which real files do carry -
  // has no normal at all. Up is a lie, but it is a lie that shades.
  return len ? [x / len, y / len, z / len] : [0, 0, 1];
}

function finish(positions, normals, box) {
  if (!Number.isFinite(box.min[0])) throw new MeshError('This model has no geometry in it');
  // Unit length, once, here - so the shader never has to normalise and a file
  // whose own normals were not unit does not come out shaded differently from
  // one whose were.
  for (let i = 0; i < normals.length; i += 3) {
    const len = Math.hypot(normals[i], normals[i + 1], normals[i + 2]);
    if (!len) { normals[i + 2] = 1; continue; }
    normals[i] /= len; normals[i + 1] /= len; normals[i + 2] /= len;
  }
  return { positions, normals, count: positions.length / 3, bounds: box };
}

const tooBig = n =>
  `This model has ${n.toLocaleString()} triangles, past the ${MAX_TRIANGLES.toLocaleString()} a card can show`;
