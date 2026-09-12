// AMF — the ISO predecessor to 3MF. May be raw XML or a ZIP containing it.
// Numbers live in elements (not attributes), so uses the streaming scanner.
// Reads: objects, meshes, vertex/material colour, constellations.
// Not read: metadata, textures, composite materials, edge curvature hints.

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
    // Constellations can nest (assemblies).
    const nested = doc.constellations.get(id);
    if (!nested) return;
    for (const inst of nested) {
      const spun = rotate(inst.delta, rot);
      emit(inst.objectid, [spun[0] + delta[0], spun[1] + delta[1], spun[2] + delta[2]],
           [inst.rot[0] + rot[0], inst.rot[1] + rot[1], inst.rot[2] + rot[2]], depth + 1);
    }
  };

  // Without constellations, all objects sit at the origin.
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

function unwrap(u8: Uint8Array) {
  if (u8[0] === 0x50 && u8[1] === 0x4b) {
    const zip = readZip(u8);
    for (const [name, entry] of zip) {
      if (/\.(amf|xml)$/i.test(name)) return new TextDecoder().decode(entry.read());
    }
    // Compressed AMF often has one entry with a generic name.
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
          // Object-level materialid is the fallback for volumes with none.
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
              // Backfill white so colour array aligns with verts.
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
      // Vertex colour takes precedence over volume material (per spec).
      const rgb = obj.colours
        ? [obj.colours[a * 3], obj.colours[a * 3 + 1], obj.colours[a * 3 + 2]]
        : flat;
      build.tri(p[0], p[1], p[2], q[0], q[1], q[2], r[0], r[1], r[2], rgb);
      if (obj.colours) {
        // Patch corners b and c — tri() wrote a's colour into all three.
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

// Euler rotation in degrees, x → y → z.
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
