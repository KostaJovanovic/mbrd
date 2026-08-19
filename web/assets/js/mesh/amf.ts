// AMF - the ISO format 3MF was invented to replace.
//
// Still worth reading: it is what a decade of additive-manufacturing tooling
// exports, and unlike STL it carries colour, materials and a scene. Structurally
// it is the opposite of 3MF in one respect that shapes this reader - where 3MF
// puts its numbers in *attributes*, AMF puts them in *elements*, so a single
// vertex is `<vertex><coordinates><x>1</x><y>2</y><z>3</z></coordinates></vertex>`
// and a scan with a million points is seven million elements. That is why this
// uses the scanner rather than a tree, and why the state below is a handful of
// flags rather than a stack of nodes.
//
// A `.amf` may be the XML directly or a ZIP with the XML inside it, and the spec
// says both. Which one is in front of us is decided by the first two bytes,
// because the extension is the same either way.
//
// What is read: objects and their meshes, per-vertex colour, per-volume material
// colour, materials, and the constellations that place instances of an object.
// What is not: `<metadata>`, texture maps, composite materials (a material
// defined as a mix of others), and the `<edge>` curvature hints - AMF's one
// genuinely distinctive feature, which describes a curved edge so a slicer can
// subdivide it. Honouring those would mean subdividing every triangle that
// touches one, and the geometry a card shows is the geometry the file states.

import {
  MeshError, MeshBuild, type Mesh, clamp01,
} from './shared.ts';
import { readZip } from './zip.ts';
import { scanXML } from './xml.ts';

const MAX_INSTANCE_DEPTH = 32;

type Volume = { tris: number[]; material: string };
type Obj = { verts: number[]; colours: number[] | null; volumes: Volume[]; material: string };
type Instance = { objectid: string; delta: number[]; rot: number[] };

export function parseAMF(bytes: ArrayBuffer): Mesh {
  const text = unwrap(new Uint8Array(bytes));
  const doc = read(text);

  const build = new MeshBuild();
  const emit = (id: string, delta: number[], rot: number[], depth: number) => {
    if (depth > MAX_INSTANCE_DEPTH) throw new MeshError('This AMF nests its constellations too deeply');
    const obj = doc.objects.get(id);
    if (obj) { addObject(build, obj, doc, delta, rot); return; }
    // A constellation may name another constellation, which is how AMF writes an
    // assembly. The deltas and rotations compose the obvious way: the child's are
    // applied first, in its own frame.
    const nested = doc.constellations.get(id);
    if (!nested) return;
    for (const inst of nested) {
      const spun = rotate(inst.delta, rot);
      emit(inst.objectid, [spun[0] + delta[0], spun[1] + delta[1], spun[2] + delta[2]],
           [inst.rot[0] + rot[0], inst.rot[1] + rot[1], inst.rot[2] + rot[2]], depth + 1);
    }
  };

  // A constellation is optional and most files have none. Where there is one it
  // is the arrangement the author meant; where there is not, every object in the
  // document sits at the origin, which is what every other reader does too.
  if (doc.constellations.size) {
    for (const insts of doc.constellations.values()) {
      for (const inst of insts) emit(inst.objectid, inst.delta, inst.rot, 0);
    }
  } else {
    for (const id of doc.objects.keys()) emit(id, [0, 0, 0], [0, 0, 0], 0);
  }

  if (!build.count) throw new MeshError('This AMF has no geometry in it');
  return build.done();
}

/** The XML, whether the file was the document or a ZIP around it. */
function unwrap(u8: Uint8Array) {
  if (u8[0] === 0x50 && u8[1] === 0x4b) {
    const zip = readZip(u8);
    for (const [name, entry] of zip) {
      if (/\.(amf|xml)$/i.test(name)) return new TextDecoder().decode(entry.read());
    }
    // One entry and an unhelpful name is the common case for a compressed AMF.
    const first = zip.values().next().value;
    if (first) return new TextDecoder().decode(first.read());
    throw new MeshError('This AMF archive is empty');
  }
  return new TextDecoder().decode(u8);
}

// ---------------------------------------------------------------------------
// The document
// ---------------------------------------------------------------------------

type Doc = {
  objects: Map<string, Obj>;
  constellations: Map<string, Instance[]>;
  /** Material id -> rgb in 0..1. */
  materials: Map<string, number[]>;
};

function read(text: string): Doc {
  const objects = new Map<string, Obj>();
  const constellations = new Map<string, Instance[]>();
  const materials = new Map<string, number[]>();

  let obj: Obj | null = null;
  let volume: Volume | null = null;
  let instances: Instance[] | null = null;
  let instance: Instance | null = null;
  let materialId = '';

  // Where in a vertex or a triangle the reader currently is. Two shallow flags
  // rather than a path, because the elements that carry numbers are all leaves
  // and their names do not repeat across the contexts that matter.
  let inVertex = false;
  let inTriangle = false;
  let inColour = false;
  let inCoordinates = false;
  let leaf = '';

  const xyz = [0, 0, 0];
  const rgb = [1, 1, 1];
  const tri = [-1, -1, -1];
  let vertexColoured = false;

  scanXML(text, {
    open(name, a) {
      leaf = name;
      switch (name) {
        case 'object':
          // `materialid` belongs on a volume and turns up on an object often
          // enough to honour - it is the fallback for volumes that name none.
          obj = { verts: [], colours: null, volumes: [], material: a.materialid || '' };
          objects.set(a.id || String(objects.size), obj);
          break;
        case 'volume':
          if (!obj) break;
          volume = { tris: [], material: a.materialid || '' };
          obj.volumes.push(volume);
          break;
        case 'vertex':
          inVertex = true;
          xyz[0] = xyz[1] = xyz[2] = 0;
          rgb[0] = rgb[1] = rgb[2] = 1;
          vertexColoured = false;
          break;
        case 'coordinates': inCoordinates = true; break;
        case 'triangle':
          inTriangle = true;
          tri[0] = tri[1] = tri[2] = -1;
          break;
        case 'color':
          inColour = true;
          rgb[0] = rgb[1] = rgb[2] = 1;
          break;
        case 'material':
          materialId = a.id || '';
          break;
        case 'constellation':
          instances = [];
          constellations.set(a.id || String(constellations.size), instances);
          break;
        case 'instance':
          if (!instances) break;
          instance = { objectid: a.objectid || '', delta: [0, 0, 0], rot: [0, 0, 0] };
          instances.push(instance);
          break;
        default: break;
      }
    },

    text(value) {
      const n = +value;
      if (inColour) {
        // AMF colours are 0..1 floats, and `<a>` (alpha) is read past for the
        // reason hexRGB() gives: this renderer draws opaque.
        if (leaf === 'r') rgb[0] = clamp01(n);
        else if (leaf === 'g') rgb[1] = clamp01(n);
        else if (leaf === 'b') rgb[2] = clamp01(n);
        if (inVertex) vertexColoured = true;
        return;
      }
      if (inCoordinates) {
        if (leaf === 'x') xyz[0] = n;
        else if (leaf === 'y') xyz[1] = n;
        else if (leaf === 'z') xyz[2] = n;
        return;
      }
      if (inTriangle) {
        if (leaf === 'v1') tri[0] = n;
        else if (leaf === 'v2') tri[1] = n;
        else if (leaf === 'v3') tri[2] = n;
        return;
      }
      if (instance) {
        if (leaf === 'deltax') instance.delta[0] = n;
        else if (leaf === 'deltay') instance.delta[1] = n;
        else if (leaf === 'deltaz') instance.delta[2] = n;
        else if (leaf === 'rx') instance.rot[0] = n;
        else if (leaf === 'ry') instance.rot[1] = n;
        else if (leaf === 'rz') instance.rot[2] = n;
      }
    },

    close(name) {
      switch (name) {
        case 'vertex':
          inVertex = false;
          if (obj) {
            obj.verts.push(xyz[0], xyz[1], xyz[2]);
            if (vertexColoured && !obj.colours) {
              // First coloured vertex: white for the ones already read, so the
              // two arrays stay the same length.
              obj.colours = new Array(obj.verts.length - 3).fill(1);
            }
            if (obj.colours) obj.colours.push(rgb[0], rgb[1], rgb[2]);
          }
          break;
        case 'coordinates': inCoordinates = false; break;
        case 'triangle':
          inTriangle = false;
          if (volume) volume.tris.push(tri[0], tri[1], tri[2]);
          break;
        case 'color':
          inColour = false;
          // A `<color>` that was not inside a vertex belongs to whatever
          // declared it - a material, a volume, or the object.
          if (materialId) materials.set(materialId, [rgb[0], rgb[1], rgb[2]]);
          break;
        case 'material': materialId = ''; break;
        case 'volume': volume = null; break;
        case 'object': obj = null; break;
        case 'constellation': instances = null; break;
        case 'instance': instance = null; break;
        default: break;
      }
      leaf = '';
    },
  });

  return { objects, constellations, materials };
}

// ---------------------------------------------------------------------------
// Emitting
// ---------------------------------------------------------------------------

function addObject(build: MeshBuild, obj: Obj, doc: Doc, delta: number[], rot: number[]) {
  const vertN = (obj.verts.length / 3) | 0;
  const at = (i: number) => {
    const p = rotate([obj.verts[i * 3], obj.verts[i * 3 + 1], obj.verts[i * 3 + 2]], rot);
    return [p[0] + delta[0], p[1] + delta[1], p[2] + delta[2]];
  };
  for (const volume of obj.volumes) {
    const flat = doc.materials.get(volume.material || obj.material) || null;
    for (let t = 0; t + 3 <= volume.tris.length; t += 3) {
      const a = volume.tris[t], b = volume.tris[t + 1], c = volume.tris[t + 2];
      if (!(a >= 0 && a < vertN && b >= 0 && b < vertN && c >= 0 && c < vertN)) {
        throw new MeshError('This AMF refers to vertices it does not contain');
      }
      const p = at(a), q = at(b), r = at(c);
      // A vertex colour beats the volume's material, which is the spec's
      // precedence and also the useful one: a scan colours its vertices and a
      // designed part colours its volumes, and no file does both meaningfully.
      const rgb = obj.colours
        ? [obj.colours[a * 3], obj.colours[a * 3 + 1], obj.colours[a * 3 + 2]]
        : flat;
      build.tri(p[0], p[1], p[2], q[0], q[1], q[2], r[0], r[1], r[2], rgb);
      if (obj.colours) {
        // Per corner where the file gave one per vertex, which is the whole
        // point of a coloured scan. build.tri() has just written the first
        // corner's colour into all three, so only the other two need saying.
        const c3 = build.c.length;
        for (const [k, vi] of [b, c].entries()) {
          const o = c3 - 6 + k * 3;
          build.c[o] = obj.colours[vi * 3];
          build.c[o + 1] = obj.colours[vi * 3 + 1];
          build.c[o + 2] = obj.colours[vi * 3 + 2];
        }
      }
    }
  }
}

/** AMF instance rotations, in degrees about x then y then z. */
function rotate(p: number[], rot: number[]) {
  if (!rot[0] && !rot[1] && !rot[2]) return p;
  const d = Math.PI / 180;
  let [x, y, z] = p;
  if (rot[0]) {
    const c = Math.cos(rot[0] * d), s = Math.sin(rot[0] * d);
    [y, z] = [y * c - z * s, y * s + z * c];
  }
  if (rot[1]) {
    const c = Math.cos(rot[1] * d), s = Math.sin(rot[1] * d);
    [x, z] = [x * c + z * s, -x * s + z * c];
  }
  if (rot[2]) {
    const c = Math.cos(rot[2] * d), s = Math.sin(rot[2] * d);
    [x, y] = [x * c - y * s, x * s + y * c];
  }
  return [x, y, z];
}
