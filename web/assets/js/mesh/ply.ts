// Stanford PLY, ASCII and both binary byte orders. Self-describing header:
// parse the plan, then walk the body once. Per-vertex colour is the reason this
// format matters (scans without it are grey lumps). Unrecognised elements are
// stepped over using their declared types. Not read: textures, range grids,
// material_index. Point clouds (no face element) are rejected.

import { oversize } from '../consent.ts';
import {
  CAPS, MeshError, type Mesh, clamp01, fanInto, fromIndexed, tooBig,
} from './shared.ts';

type ScalarType =
  | 'i8' | 'u8' | 'i16' | 'u16' | 'i32' | 'u32' | 'f32' | 'f64';

type Prop =
  | { list: false; name: string; type: ScalarType }
  | { list: true; name: string; count: ScalarType; type: ScalarType };

type Element = { name: string; count: number; props: Prop[] };

const TYPES: Record<string, ScalarType> = {
  char: 'i8', int8: 'i8',
  uchar: 'u8', uint8: 'u8',
  short: 'i16', int16: 'i16',
  ushort: 'u16', uint16: 'u16',
  int: 'i32', int32: 'i32',
  uint: 'u32', uint32: 'u32',
  float: 'f32', float32: 'f32',
  double: 'f64', float64: 'f64',
};

const WIDTH: Record<ScalarType, number> = {
  i8: 1, u8: 1, i16: 2, u16: 2, i32: 4, u32: 4, f32: 4, f64: 8,
};

/** Colour channel names across tools (Stanford: diffuse_red, modern: red, short: r). */
const RED = new Set(['red', 'diffuse_red', 'r']);
const GREEN = new Set(['green', 'diffuse_green', 'g']);
const BLUE = new Set(['blue', 'diffuse_blue', 'b']);

/** Face index list names (spec: vertex_index, common: vertex_indices). */
const FACE_LIST = new Set(['vertex_indices', 'vertex_index']);

export function parsePLY(bytes: ArrayBuffer): Mesh {
  const u8 = new Uint8Array(bytes);
  const head = readHeader(u8);
  if (head.format === 'ascii') return asciiBody(u8, head);
  return binaryBody(u8, head);
}

// ---------------------------------------------------------------------------
// The header
// ---------------------------------------------------------------------------

type Header = {
  format: 'ascii' | 'le' | 'be';
  elements: Element[];
  /** Byte offset of the body. For ASCII this is a character offset too, since
   *  everything up to `end_header` is by definition ASCII. */
  start: number;
};

/** Parse the header. Decoded as latin1 — the binary body may contain arbitrary
 * bytes that would break a UTF-8 decoder. */
function readHeader(u8: Uint8Array): Header {
  const limit = Math.min(u8.length, 1 << 20);
  let end = -1;
  for (let i = 0; i + 10 <= limit; i++) {
    if (u8[i] !== 0x65) continue;                       // 'e'
    if (matches(u8, i, 'end_header')) { end = i + 10; break; }
  }
  if (end < 0) throw new MeshError('This PLY has no header in it');
  // Past the newline that follows, in either convention.
  let start = end;
  if (u8[start] === 0x0d) start++;
  if (u8[start] === 0x0a) start++;

  const text = latin1(u8.subarray(0, end));
  const lines = text.split(/\r\n?|\n/);
  if (!/^ply\s*$/i.test(lines[0] || '')) throw new MeshError('This is not a PLY file');

  let format: Header['format'] | null = null;
  const elements: Element[] = [];

  for (const raw of lines.slice(1)) {
    const line = raw.trim();
    if (!line || line.startsWith('comment') || line.startsWith('obj_info')) continue;
    const t = line.split(/\s+/);
    if (t[0] === 'format') {
      if (t[1] === 'ascii') format = 'ascii';
      else if (t[1] === 'binary_little_endian') format = 'le';
      else if (t[1] === 'binary_big_endian') format = 'be';
      else throw new MeshError('This PLY is in a format this cannot read');
    } else if (t[0] === 'element') {
      const count = Number(t[2]);
      // Non-integer count would cause infinite or zero-length loops below.
      if (!Number.isSafeInteger(count) || count < 0) {
        throw new MeshError('This PLY declares an element count that is not a number');
      }
      elements.push({ name: (t[1] || '').toLowerCase(), count, props: [] });
    } else if (t[0] === 'property') {
      const el = elements[elements.length - 1];
      if (!el) throw new MeshError('This PLY has a property outside any element');
      if (t[1] === 'list') {
        const count = TYPES[t[2]], type = TYPES[t[3]];
        if (!count || !type) throw new MeshError('This PLY has a property of an unknown type');
        el.props.push({ list: true, name: (t[4] || '').toLowerCase(), count, type });
      } else {
        const type = TYPES[t[1]];
        if (!type) throw new MeshError('This PLY has a property of an unknown type');
        el.props.push({ list: false, name: (t[2] || '').toLowerCase(), type });
      }
    } else if (t[0] === 'end_header') break;
  }

  if (!format) throw new MeshError('This PLY does not say which format it is in');
  // An element with nothing in it takes no bytes and no tokens, so stepping
  // over a count of them is a loop that reads nothing and never ends.
  for (const el of elements) {
    if (el.count > 0 && !el.props.length) throw new MeshError('This PLY has an element with no properties');
  }
  return { format, elements, start };
}

const matches = (u8: Uint8Array, at: number, word: string) => {
  for (let k = 0; k < word.length; k++) if (u8[at + k] !== word.charCodeAt(k)) return false;
  return true;
};

const latin1 = (b: Uint8Array) => new TextDecoder('latin1').decode(b);

// ---------------------------------------------------------------------------
// What the reader is looking for
// ---------------------------------------------------------------------------

/** Where the interesting properties sit within one vertex, by index into the
 *  element's property list. -1 for absent. */
type VertexPlan = { x: number; y: number; z: number; r: number; g: number; b: number; scale: number };

function vertexPlan(el: Element): VertexPlan {
  const at = (want: string | Set<string>) => el.props.findIndex(p => (
    typeof want === 'string' ? p.name === want : want.has(p.name)
  ));
  const r = at(RED);
  // uchar (0..255) vs float (0..1) distinguished by declared type, not values.
  const floatColour = r >= 0 && (el.props[r].type === 'f32' || el.props[r].type === 'f64');
  const scale = floatColour ? 1 : 1 / 255;
  return { x: at('x'), y: at('y'), z: at('z'), r, g: at(GREEN), b: at(BLUE), scale };
}

function faceListIndex(el: Element) {
  // Prefer known names; fall back to first list property.
  const named = el.props.findIndex(p => p.list && FACE_LIST.has(p.name));
  return named >= 0 ? named : el.props.findIndex(p => p.list);
}

// ---------------------------------------------------------------------------
// ASCII
// ---------------------------------------------------------------------------

function asciiBody(u8: Uint8Array, head: Header): Mesh {
  // Token-based, not line-based — some files wrap face indices across lines.
  const tokens = latin1(u8.subarray(head.start)).split(/\s+/);
  let at = 0;
  const next = () => {
    while (at < tokens.length && !tokens[at]) at++;
    if (at >= tokens.length) throw new MeshError('This PLY ends before its header says it should');
    return +tokens[at++];
  };

  let verts: number[] | null = null;
  let cols: number[] | null = null;
  const tris: number[] = [];

  for (const el of head.elements) {
    if (el.name === 'vertex') {
      const plan = vertexPlan(el);
      if (plan.x < 0 || plan.y < 0 || plan.z < 0) {
        throw new MeshError('This PLY has vertices with no coordinates');
      }
      if (el.count > CAPS.elem) throw oversize('mesh-triangles', tooBig(el.count));
      verts = new Array(el.count * 3);
      const coloured = plan.r >= 0 && plan.g >= 0 && plan.b >= 0;
      if (coloured) cols = new Array(el.count * 3);
      const row: number[] = new Array(el.props.length);
      for (let v = 0; v < el.count; v++) {
        for (let p = 0; p < el.props.length; p++) {
          const prop = el.props[p];
          if (prop.list) {
            // A list property on a vertex is unusual and legal; it still has to
            // be consumed or every number after it is off by its length.
            const n = next();
            if (!(n >= 0 && n < 1e6)) throw new MeshError('This PLY has a malformed list in it');
            for (let k = 0; k < n; k++) next();
            row[p] = 0;
          } else row[p] = next();
        }
        verts[v * 3] = row[plan.x];
        verts[v * 3 + 1] = row[plan.y];
        verts[v * 3 + 2] = row[plan.z];
        if (cols) {
          cols[v * 3] = clamp01(row[plan.r] * plan.scale);
          cols[v * 3 + 1] = clamp01(row[plan.g] * plan.scale);
          cols[v * 3 + 2] = clamp01(row[plan.b] * plan.scale);
        }
      }
    } else if (el.name === 'face') {
      const listAt = faceListIndex(el);
      if (listAt < 0) throw new MeshError('This PLY has faces with no vertex list');
      const corners: number[] = [];
      for (let f = 0; f < el.count; f++) {
        for (let p = 0; p < el.props.length; p++) {
          const prop = el.props[p];
          if (!prop.list) { next(); continue; }
          const n = next();
          if (!(n >= 0 && n <= 1024)) throw new MeshError('This PLY has a face with an implausible number of corners');
          corners.length = 0;
          for (let k = 0; k < n; k++) corners.push(next());
          if (p === listAt && n >= 3) fanInto(tris, corners);
        }
      }
    } else {
      // An element this reader has no use for. Consumed exactly, because the
      // ones after it are positional.
      for (let n = 0; n < el.count; n++) {
        for (const prop of el.props) {
          if (!prop.list) { next(); continue; }
          const k = next();
          if (!(k >= 0 && k < 1e6)) throw new MeshError('This PLY has a malformed list in it');
          for (let j = 0; j < k; j++) next();
        }
      }
    }
  }

  return assemble(verts, tris, cols);
}

// ---------------------------------------------------------------------------
// Binary
// ---------------------------------------------------------------------------

function binaryBody(u8: Uint8Array, head: Header): Mesh {
  const view = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
  const le = head.format === 'le';
  let at = head.start;

  const read = (type: ScalarType) => {
    const w = WIDTH[type];
    if (at + w > u8.length) throw new MeshError('This PLY ends before its header says it should');
    const o = at;
    at += w;
    switch (type) {
      case 'i8': return view.getInt8(o);
      case 'u8': return view.getUint8(o);
      case 'i16': return view.getInt16(o, le);
      case 'u16': return view.getUint16(o, le);
      case 'i32': return view.getInt32(o, le);
      case 'u32': return view.getUint32(o, le);
      case 'f32': return view.getFloat32(o, le);
      default: return view.getFloat64(o, le);
    }
  };

  let verts: number[] | null = null;
  let cols: number[] | null = null;
  const tris: number[] = [];

  for (const el of head.elements) {
    const fixedWidth = el.props.every(p => !p.list)
      ? el.props.reduce((sum, p) => sum + WIDTH[p.type], 0)
      : 0;
    // The declared count against the bytes that are actually there, before a
    // single allocation. A header claiming forty million vertices in a 900-byte
    // file is not a large model, it is a file lying about its size.
    if (fixedWidth && head.start + el.count * fixedWidth > u8.length) {
      throw new MeshError('This PLY declares more data than it contains');
    }

    if (el.name === 'vertex') {
      const plan = vertexPlan(el);
      if (plan.x < 0 || plan.y < 0 || plan.z < 0) {
        throw new MeshError('This PLY has vertices with no coordinates');
      }
      if (el.count > CAPS.elem) throw oversize('mesh-triangles', tooBig(el.count));
      verts = new Array(el.count * 3);
      const coloured = plan.r >= 0 && plan.g >= 0 && plan.b >= 0;
      if (coloured) cols = new Array(el.count * 3);
      const row: number[] = new Array(el.props.length);
      for (let v = 0; v < el.count; v++) {
        for (let p = 0; p < el.props.length; p++) {
          const prop = el.props[p];
          if (prop.list) {
            const n = read(prop.count);
            if (!(n >= 0 && n < 1e6)) throw new MeshError('This PLY has a malformed list in it');
            at += n * WIDTH[prop.type];
            if (at > u8.length) throw new MeshError('This PLY ends before its header says it should');
            row[p] = 0;
          } else row[p] = read(prop.type);
        }
        verts[v * 3] = row[plan.x];
        verts[v * 3 + 1] = row[plan.y];
        verts[v * 3 + 2] = row[plan.z];
        if (cols) {
          cols[v * 3] = clamp01(row[plan.r] * plan.scale);
          cols[v * 3 + 1] = clamp01(row[plan.g] * plan.scale);
          cols[v * 3 + 2] = clamp01(row[plan.b] * plan.scale);
        }
      }
    } else if (el.name === 'face') {
      const listAt = faceListIndex(el);
      if (listAt < 0) throw new MeshError('This PLY has faces with no vertex list');
      const corners: number[] = [];
      for (let f = 0; f < el.count; f++) {
        for (let p = 0; p < el.props.length; p++) {
          const prop = el.props[p];
          if (!prop.list) { read(prop.type); continue; }
          const n = read(prop.count);
          if (!(n >= 0 && n <= 1024)) throw new MeshError('This PLY has a face with an implausible number of corners');
          if (p === listAt && n >= 3) {
            corners.length = 0;
            for (let k = 0; k < n; k++) corners.push(read(prop.type));
            fanInto(tris, corners);
          } else {
            at += n * WIDTH[prop.type];
            if (at > u8.length) throw new MeshError('This PLY ends before its header says it should');
          }
        }
      }
    } else if (fixedWidth) {
      at += el.count * fixedWidth;      // stepped over in one jump
    } else {
      for (let n = 0; n < el.count; n++) {
        for (const prop of el.props) {
          if (!prop.list) { read(prop.type); continue; }
          const k = read(prop.count);
          if (!(k >= 0 && k < 1e6)) throw new MeshError('This PLY has a malformed list in it');
          at += k * WIDTH[prop.type];
          if (at > u8.length) throw new MeshError('This PLY ends before its header says it should');
        }
      }
    }
  }

  return assemble(verts, tris, cols);
}

function assemble(verts: number[] | null, tris: number[], cols: number[] | null) {
  if (!verts || !verts.length) throw new MeshError('This PLY has no vertices in it');
  if (!tris.length) {
    // The honest failure. A PLY with vertices and no faces is a point cloud,
    // which is a real thing to have and not a thing a card can draw.
    throw new MeshError('This PLY is a point cloud - it has vertices but no faces');
  }
  return fromIndexed(verts, tris, cols);
}
