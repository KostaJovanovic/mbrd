// 3MF - the format a slicer saves, and the one a printed part actually arrives in.
//
// A 3MF is an OPC package: a ZIP holding an XML model, its relationships, and
// usually a thumbnail. What makes it worth reading properly rather than
// grabbing the first `<mesh>` is that a real one - anything out of PrusaSlicer,
// Bambu Studio, Cura or Fusion - is a *build*, not a mesh. The resources declare
// objects; an object is either a mesh or a list of components pointing at other
// objects, each with its own transform; and `<build>` names which of them are
// actually on the plate and where. A plate of six parts read naively is one part
// six times in the same place.
//
// So this walks the build. Every item is resolved to the meshes under it, each
// with the composed transform of the chain that reached it, and they are emitted
// into one mesh the way the plate looks.
//
// The **production extension** is handled too, because it is what the big
// slicers write for anything with more than a few objects: a component may name
// `p:path="/3D/Objects/part.model"`, a whole second model document inside the
// same package. Those are loaded from the ZIP on demand and cached, with a
// bounded recursion - a package whose parts refer to each other in a circle is a
// package, not a stack overflow.
//
// Colour comes from the property groups: `<basematerials>` carries a
// `displaycolor` per base and `<colorgroup>` (the materials extension) carries a
// colour per entry. A triangle names a group and up to three indices into it, so
// this resolves per corner where the file gives three and per face where it gives
// one. What is not read: textures, composite and multi-property materials, beam
// lattices, slices, and the `<metadata>` a slicer stuffs its own settings into.
//
// Vertices and triangles are read with the scanner rather than a tree, for the
// reason mesh/xml.ts's header gives: a 3MF writes one element per vertex, and a
// tree of objects for a half-million of them costs more than the geometry does.

import {
  MeshError, MeshBuild, type Mesh, hexRGB,
} from './shared.ts';
import { readZip, type ZipFile } from './zip.ts';
import { scanXML } from './xml.ts';

/** How deep a component chain may nest. A real assembly is three or four levels;
 *  this is the guard against a package that refers to itself. */
const MAX_DEPTH = 64;

/** How many object resolutions one package may perform. Depth alone does not
 *  bound a shallow DAG where every object names the same twenty children. */
const MAX_RESOLVES = 200_000;

/** How many model documents one package may pull in through the production
 *  extension. The biggest plates in the wild are a few hundred parts. */
const MAX_PARTS = 2_000;

type Component = { objectid: string; path: string; transform: number[] | null };

/** Numbers per triangle in `MeshData.tris`: three vertex indices, the interned
 *  colour group, and the three property indices into it. Flat rather than an
 *  array of objects, because a plate can carry a million of them. */
const STRIDE = 7;

type MeshData = {
  verts: number[];
  /** `STRIDE` numbers a triangle, with -1 for anything the file left out. */
  tris: number[];
  pid: string;
  pindex: number;
};

type Obj = {
  mesh: MeshData | null;
  components: Component[];
  /** The object's own default colour, from its `pid`/`pindex`. */
  pid: string;
  pindex: number;
};

type Doc = {
  objects: Map<string, Obj>;
  items: Component[];
  /** Property group id -> the colours in it, in index order. */
  groups: Map<string, (number[] | null)[]>;
  /** The group ids a triangle's interned key indexes into. Per document rather
   *  than module-wide: an intern table shared between parses is a table that
   *  only ever grows, and this app opens as many models as somebody drops. */
  keys: string[];
};

export function parse3MF(bytes: ArrayBuffer): Mesh {
  const zip = readZip(new Uint8Array(bytes));
  const rootPath = findRootModel(zip);
  const docs = new Map<string, Doc>();

  let partsRead = 0;
  const docAt = (path: string): Doc => {
    const key = normalize(path);
    const had = docs.get(key);
    if (had) return had;
    if (++partsRead > MAX_PARTS) throw new MeshError('This 3MF has more model parts than a build has');
    const entry = zip.get(key) || zip.get(key.replace(/^\//, ''));
    if (!entry) throw new MeshError('This 3MF refers to a model part it does not contain');
    const doc = readModel(new TextDecoder().decode(entry.read()));
    docs.set(key, doc);
    return doc;
  };

  const root = docAt(rootPath);
  const build = new MeshBuild();
  let resolves = 0;

  const emit = (ref: Component, from: string, m: number[], depth: number) => {
    if (++resolves > MAX_RESOLVES) throw new MeshError('This 3MF has more parts on its plate than a build has');
    if (depth > MAX_DEPTH) throw new MeshError('This 3MF nests its components too deeply');
    const path = ref.path ? normalize(ref.path) : from;
    const doc = path === from ? docAt(from) : docAt(path);
    const obj = doc.objects.get(ref.objectid);
    // A build item naming an object that is not there is a broken package and
    // not a broken reader; the rest of the plate is still worth drawing.
    if (!obj) return;
    const M = ref.transform ? compose(ref.transform, m) : m;
    if (obj.mesh) addMesh(build, obj.mesh, M, doc, obj);
    for (const child of obj.components) emit(child, path, M, depth + 1);
  };

  // A package with no `<build>` is legal-ish and does turn up from converters.
  // Every object in the root document is the best reading of it, which is what
  // "show me what is in this file" means.
  const items = root.items.length
    ? root.items
    : [...root.objects.keys()].map(id => ({ objectid: id, path: '', transform: null }));

  for (const item of items) emit(item, normalize(rootPath), IDENTITY, 0);
  if (!build.count) throw new MeshError('This 3MF has no geometry on its build plate');
  return build.done();
}

// ---------------------------------------------------------------------------
// The package
// ---------------------------------------------------------------------------

const START_PART = 'startpart';

/**
 * Which entry is the model, per the package's own relationships.
 *
 * `3D/3dmodel.model` is the conventional name and is what almost every writer
 * uses, but the convention is not the rule - the rule is the StartPart
 * relationship in `_rels/.rels`, and a package that renames the model is
 * perfectly valid. So the relationship is read first and the convention is the
 * fallback, which is also what makes a package with a damaged `_rels` still
 * open.
 */
function findRootModel(zip: Map<string, ZipFile>) {
  const rels = zip.get('_rels/.rels');
  if (rels) {
    let found = '';
    try {
      scanXML(new TextDecoder().decode(rels.read()), {
        open(name, attrs) {
          if (found || name !== 'relationship') return;
          const type = (attrs.type || '').toLowerCase();
          if (type.endsWith(START_PART) || type.endsWith('/3dmodel')) found = attrs.target || '';
        },
      });
    } catch { /* a damaged relationship part falls through to the convention */ }
    if (found) return found;
  }
  for (const name of ['3D/3dmodel.model', '3d/3dmodel.model']) {
    if (zip.has(name)) return name;
  }
  // Last resort: any .model in the package. A converter that wrote neither the
  // relationship nor the conventional path still has exactly one of these.
  for (const name of zip.keys()) {
    if (name.toLowerCase().endsWith('.model')) return name;
  }
  throw new MeshError('This 3MF has no model in it');
}

/** OPC paths are absolute with a leading slash; ZIP entry names are not. */
const normalize = (p: string) => p.replace(/\\/g, '/').replace(/^\/+/, '');

// ---------------------------------------------------------------------------
// One model document
// ---------------------------------------------------------------------------

/**
 * Read a `.model` in one pass.
 *
 * Order matters less than it looks: the resources come before the build in every
 * real file, but a colour group *may* be declared after the object that names
 * it, so the triangles keep their property references as raw numbers and the
 * colours are resolved afterwards. Nothing here allocates per vertex beyond the
 * numbers themselves.
 */
function readModel(text: string): Doc {
  const objects = new Map<string, Obj>();
  const items: Component[] = [];
  const groups = new Map<string, (number[] | null)[]>();
  const keys: string[] = [];
  const keyIndex = new Map<string, number>();

  /** A triangle's property group: its own `pid`, or its object's, as a small
   *  integer - the triangle list is flat numbers, and a parallel array of
   *  strings for a million triangles is not a thing to allocate. */
  const intern = (id: string) => {
    if (!id) return -1;
    const had = keyIndex.get(id);
    if (had !== undefined) return had;
    keys.push(id);
    keyIndex.set(id, keys.length - 1);
    return keys.length - 1;
  };

  let obj: Obj | null = null;
  let mesh: MeshData | null = null;
  let group: (number[] | null)[] | null = null;
  let inVertices = false;
  let inTriangles = false;

  scanXML(text, {
    open(name, a) {
      switch (name) {
        case 'object': {
          const id = a.id || '';
          obj = { mesh: null, components: [], pid: a.pid || '', pindex: intOr(a.pindex, -1) };
          if (id) objects.set(id, obj);
          break;
        }
        case 'mesh':
          if (!obj) break;
          mesh = { verts: [], tris: [], pid: obj.pid, pindex: obj.pindex };
          obj.mesh = mesh;
          break;
        case 'vertices': inVertices = true; break;
        case 'triangles': inTriangles = true; break;
        case 'vertex':
          if (inVertices && mesh) mesh.verts.push(+a.x, +a.y, +a.z);
          break;
        case 'triangle': {
          if (!inTriangles || !mesh) break;
          // `pid` on a triangle overrides the object's; the p-indices default to
          // p1 where only the first is given, which is the spec's rule and is
          // how a flat-coloured face is written.
          const p1 = intOr(a.p1, -1);
          mesh.tris.push(
            intOr(a.v1, -1), intOr(a.v2, -1), intOr(a.v3, -1),
            intern(a.pid || mesh.pid),
            p1, intOr(a.p2, p1), intOr(a.p3, p1),
          );
          break;
        }
        case 'component':
          if (obj) {
            obj.components.push({
              objectid: a.objectid || '',
              path: a.path || '',
              transform: matrix(a.transform),
            });
          }
          break;
        case 'item':
          items.push({
            objectid: a.objectid || '',
            path: a.path || '',
            transform: matrix(a.transform),
          });
          break;
        case 'basematerials':
        case 'colorgroup':
          group = [];
          if (a.id) groups.set(a.id, group);
          break;
        case 'base':
          if (group) group.push(hexRGB(a.displaycolor));
          break;
        case 'color':
          if (group) group.push(hexRGB(a.color));
          break;
        default: break;
      }
    },
    close(name) {
      if (name === 'vertices') inVertices = false;
      else if (name === 'triangles') inTriangles = false;
      else if (name === 'mesh') mesh = null;
      else if (name === 'object') { obj = null; mesh = null; }
      else if (name === 'basematerials' || name === 'colorgroup') group = null;
    },
  });

  return { objects, items, groups, keys };
}

// ---------------------------------------------------------------------------
// Emitting
// ---------------------------------------------------------------------------

function addMesh(build: MeshBuild, mesh: MeshData, m: number[], doc: Doc, obj: Obj) {
  const { verts, tris } = mesh;
  const vertN = (verts.length / 3) | 0;
  const own = obj.pid ? doc.groups.get(obj.pid) : null;

  for (let t = 0; t + STRIDE <= tris.length; t += STRIDE) {
    const a = tris[t], b = tris[t + 1], c = tris[t + 2];
    if (!(a >= 0 && a < vertN && b >= 0 && b < vertN && c >= 0 && c < vertN)) {
      throw new MeshError('This 3MF refers to vertices it does not contain');
    }
    const key = tris[t + 3];
    const group = key >= 0 ? doc.groups.get(doc.keys[key]) : null;
    const pick = (i: number) => {
      const at = tris[t + 4 + i];
      const from = group || own;
      if (!from) return null;
      const want = at >= 0 ? at : obj.pindex;
      return want >= 0 ? from[want] || null : from[0] || null;
    };
    // One colour for the face. Per-corner colours are what the three p-indices
    // *can* express, and canvas/model.ts shades a triangle from three corner
    // colours perfectly well - but a gradient across a face is a thing almost no
    // 3MF actually wants, and the first index is what every slicer writes.
    const rgb = pick(0);
    const p = xf(verts, a, m), q = xf(verts, b, m), r = xf(verts, c, m);
    build.tri(p[0], p[1], p[2], q[0], q[1], q[2], r[0], r[1], r[2], rgb);
  }
}

function xf(verts: number[], i: number, m: number[]) {
  const x = verts[i * 3], y = verts[i * 3 + 1], z = verts[i * 3 + 2];
  return [
    x * m[0] + y * m[3] + z * m[6] + m[9],
    x * m[1] + y * m[4] + z * m[7] + m[10],
    x * m[2] + y * m[5] + z * m[8] + m[11],
  ];
}

// ---------------------------------------------------------------------------
// Transforms
// ---------------------------------------------------------------------------
//
// 3MF writes a transform as twelve numbers: three basis rows then a translation
// row, with the implicit fourth column (0,0,0,1) left out. Points are row
// vectors, so a point is `p * M` - which is why `compose(a, b)` means "a first,
// then b" and not the other way round. Getting that backwards puts a rotated
// part in the right place with the wrong orientation, which looks like a
// plausible model and is the reason this is spelled out here.

const IDENTITY = [1, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0];

function matrix(raw: string | undefined): number[] | null {
  if (!raw) return null;
  const n = raw.trim().split(/\s+/).map(Number);
  if (n.length !== 12 || n.some(v => !Number.isFinite(v))) return null;
  return n;
}

function compose(a: number[], b: number[]) {
  const out = new Array(12);
  for (let row = 0; row < 4; row++) {
    for (let col = 0; col < 3; col++) {
      out[row * 3 + col] =
        a[row * 3] * b[col] +
        a[row * 3 + 1] * b[3 + col] +
        a[row * 3 + 2] * b[6 + col] +
        (row === 3 ? b[9 + col] : 0);
    }
  }
  return out;
}

const intOr = (raw: string | undefined, fallback: number) => {
  if (raw == null || raw === '') return fallback;
  const n = Number(raw);
  return Number.isSafeInteger(n) ? n : fallback;
};
