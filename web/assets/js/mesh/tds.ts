// Autodesk 3D Studio (.3ds), the format that will not die.
//
// Late-eighties DOS software, superseded twice over, and still what half the
// free model libraries on the internet hand you. It is worth reading because it
// is trivially small: a tree of chunks, each a two-byte id and a four-byte
// length, and the geometry is two of them.
//
// The thing to know about a .3ds is that **its vertices are already in world
// space**. Each object block carries a `local coordinate system` chunk (0x4160)
// describing its own axes, and it is a description rather than a transform to
// apply - the points beside it are absolute. Multiplying by it, which looks like
// the obvious thing to do with a matrix in a file, moves every object twice.
//
// The format's own ceilings do most of the bounds checking for free: a vertex
// count is a `uint16`, so no object may have more than 65,535 of either
// vertices or faces. That is also its real limitation - anything modern is a
// scene of many small objects rather than one large one.
//
// What is read: every object's vertices and faces, and the diffuse colour of the
// materials assigned to face groups. What is not: the keyframer track (0xB000),
// which is animation; smoothing groups, which would let this shade a curved
// surface smoothly rather than faceted; texture coordinates and maps.

import {
  MeshError, MeshBuild, type Mesh, clamp01,
} from './shared.ts';

const MAIN = 0x4d4d;
const EDITOR = 0x3d3d;
const OBJECT = 0x4000;
const MESH = 0x4100;
const VERTICES = 0x4110;
const FACES = 0x4120;
const FACE_MATERIAL = 0x4130;
const MATERIAL = 0xafff;
const MATERIAL_NAME = 0xa000;
const MATERIAL_DIFFUSE = 0xa020;
const COLOUR_BYTES = 0x0011;
const COLOUR_BYTES_GAMMA = 0x0012;
const COLOUR_FLOATS = 0x0010;
const COLOUR_FLOATS_GAMMA = 0x0013;

/** The chunk header: id and length. Every offset below is relative to the start
 *  of the chunk, which is what the length counts from. */
const HEADER = 6;

type Group = { material: string; faces: number[] };
type Object3D = { verts: number[]; faces: number[]; groups: Group[] };

export function parse3DS(bytes: ArrayBuffer): Mesh {
  const view = new DataView(bytes);
  if (bytes.byteLength < HEADER || view.getUint16(0, true) !== MAIN) {
    throw new MeshError('This is not a 3DS file');
  }

  const objects: Object3D[] = [];
  const materials = new Map<string, number[]>();
  let object: Object3D | null = null;
  let material = '';

  // One walk, driven by the chunk tree. Chunks this reader has no use for are
  // stepped over by their own declared length, which is the property that makes
  // the format readable without knowing every id in it.
  const walk = (from: number, to: number, depth: number) => {
    if (depth > 32) throw new MeshError('This 3DS nests its chunks too deeply');
    let at = from;
    while (at + HEADER <= to) {
      const id = view.getUint16(at, true);
      const len = view.getUint32(at + 2, true);
      // A length that does not advance, or that runs past the parent, is a file
      // whose chunk tree does not close - and a loop that never ends.
      if (len < HEADER || at + len > to) throw new MeshError('This 3DS has a chunk that runs past its parent');
      const body = at + HEADER;
      const end = at + len;

      switch (id) {
        case EDITOR:
          walk(body, end, depth + 1);
          break;
        case OBJECT: {
          // The object's name, then whatever it is - a mesh, a light or a camera.
          const after = skipName(view, body, end);
          object = { verts: [], faces: [], groups: [] };
          walk(after, end, depth + 1);
          if (object.verts.length && object.faces.length) objects.push(object);
          object = null;
          break;
        }
        case MESH:
          walk(body, end, depth + 1);
          break;
        case VERTICES: {
          if (!object || body + 2 > end) break;
          const n = view.getUint16(body, true);
          if (body + 2 + n * 12 > end) throw new MeshError('This 3DS declares more vertices than it contains');
          for (let i = 0; i < n; i++) {
            const o = body + 2 + i * 12;
            object.verts.push(
              view.getFloat32(o, true),
              view.getFloat32(o + 4, true),
              view.getFloat32(o + 8, true),
            );
          }
          break;
        }
        case FACES: {
          if (!object || body + 2 > end) break;
          const n = view.getUint16(body, true);
          if (body + 2 + n * 8 > end) throw new MeshError('This 3DS declares more faces than it contains');
          for (let i = 0; i < n; i++) {
            const o = body + 2 + i * 8;
            object.faces.push(
              view.getUint16(o, true),
              view.getUint16(o + 2, true),
              view.getUint16(o + 4, true),
            );
          }
          // The face-material groups are subchunks of the face list itself,
          // which is the one place this format nests something interesting.
          walk(body + 2 + n * 8, end, depth + 1);
          break;
        }
        case FACE_MATERIAL: {
          if (!object) break;
          const named = skipName(view, body, end);
          if (named + 2 > end) break;
          const count = view.getUint16(named, true);
          if (named + 2 + count * 2 > end) break;
          const faces: number[] = [];
          for (let i = 0; i < count; i++) faces.push(view.getUint16(named + 2 + i * 2, true));
          object.groups.push({ material: readName(view, body, end), faces });
          break;
        }
        case MATERIAL:
          material = '';
          walk(body, end, depth + 1);
          material = '';
          break;
        case MATERIAL_NAME:
          material = readName(view, body, end);
          break;
        case MATERIAL_DIFFUSE: {
          const rgb = colour(view, body, end, depth + 1);
          if (rgb && material) materials.set(material, rgb);
          break;
        }
        default: break;
      }
      at = end;
    }
  };

  walk(HEADER, Math.min(view.getUint32(2, true), bytes.byteLength), 0);

  const build = new MeshBuild();
  for (const obj of objects) addObject(build, obj, materials);
  if (!build.count) throw new MeshError('This 3DS has no geometry in it');
  return build.done();
}

// ---------------------------------------------------------------------------
// Pieces
// ---------------------------------------------------------------------------

function addObject(build: MeshBuild, obj: Object3D, materials: Map<string, number[]>) {
  const vertN = (obj.verts.length / 3) | 0;
  const faceN = (obj.faces.length / 3) | 0;

  // Face index -> its material's colour, from the groups. Built once rather than
  // searched per face: a scene with forty materials and forty thousand faces
  // would otherwise be a linear scan per triangle.
  const perFace: (number[] | null)[] = new Array(faceN).fill(null);
  for (const group of obj.groups) {
    const rgb = materials.get(group.material);
    if (!rgb) continue;
    for (const f of group.faces) if (f >= 0 && f < faceN) perFace[f] = rgb;
  }

  for (let f = 0; f < faceN; f++) {
    const a = obj.faces[f * 3], b = obj.faces[f * 3 + 1], c = obj.faces[f * 3 + 2];
    if (!(a < vertN && b < vertN && c < vertN)) {
      throw new MeshError('This 3DS refers to vertices it does not contain');
    }
    build.tri(
      obj.verts[a * 3], obj.verts[a * 3 + 1], obj.verts[a * 3 + 2],
      obj.verts[b * 3], obj.verts[b * 3 + 1], obj.verts[b * 3 + 2],
      obj.verts[c * 3], obj.verts[c * 3 + 1], obj.verts[c * 3 + 2],
      perFace[f],
    );
  }
}

/** A colour subchunk, in whichever of the four forms the writer used. The gamma
 *  variants are the same numbers corrected for display, and a moodboard card
 *  wants the corrected one where both are present - which is why the walk takes
 *  the last it finds rather than the first. */
function colour(view: DataView, from: number, to: number, depth: number): number[] | null {
  if (depth > 32) return null;
  let out: number[] | null = null;
  let at = from;
  while (at + HEADER <= to) {
    const id = view.getUint16(at, true);
    const len = view.getUint32(at + 2, true);
    if (len < HEADER || at + len > to) break;
    const body = at + HEADER;
    if ((id === COLOUR_BYTES || id === COLOUR_BYTES_GAMMA) && body + 3 <= to) {
      out = [view.getUint8(body) / 255, view.getUint8(body + 1) / 255, view.getUint8(body + 2) / 255];
    } else if ((id === COLOUR_FLOATS || id === COLOUR_FLOATS_GAMMA) && body + 12 <= to) {
      out = [
        clamp01(view.getFloat32(body, true)),
        clamp01(view.getFloat32(body + 4, true)),
        clamp01(view.getFloat32(body + 8, true)),
      ];
    }
    at += len;
  }
  return out;
}

/** Past a null-terminated name. Bounded by the chunk rather than by the byte,
 *  so a name with no terminator ends at the chunk and does not run on. */
function skipName(view: DataView, from: number, to: number) {
  for (let i = from; i < to; i++) if (!view.getUint8(i)) return i + 1;
  return to;
}

function readName(view: DataView, from: number, to: number) {
  let out = '';
  for (let i = from; i < to; i++) {
    const b = view.getUint8(i);
    if (!b) break;
    out += String.fromCharCode(b);
  }
  return out;
}
