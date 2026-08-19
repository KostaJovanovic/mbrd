// Geomview OFF, and the family of prefixes around it.
//
// The smallest interesting mesh format there is: a magic word, three counts, a
// block of vertices, a block of faces. It turns up wherever geometry is being
// passed between research tools - CGAL, MeshLab, Geomview itself - and it is the
// format somebody hand-writes when they want a mesh in a text editor.
//
// The prefixes are the whole complication. `OFF` may be `COFF` (vertices carry
// colour), `NOFF` (normals), `STOFF` (texture coordinates), `4OFF`
// (four-dimensional, homogeneous coordinates), or any combination -
// `CNOFF`, `STCNOFF`. Each adds numbers to a vertex line, and the spec's order
// is position, normal, colour, texture.
//
// Which is where the reading gets careful rather than clever. That order is what
// the spec says and it is *not* what every writer does - a COFF out of MeshLab
// is `x y z r g b a` and a COFF out of somewhere else is `x y z r g b`. So the
// prefix decides which extras are *present* and how many numbers each takes, and
// the first three numbers are always the position whatever else follows. A
// vertex is one line in every OFF that exists, which is what makes reading it a
// line at a time safe and reading it as a token stream not.
//
// Face colours are read past. A face colour in OFF is per-polygon and this
// module's output is per-vertex, so honouring them would mean splitting shared
// vertices; a moodboard card is a silhouette and some shading, and the vertex
// colours a COFF carries are the ones that make a scan look like itself.

import { oversize } from '../consent.ts';
import {
  CAPS, MeshError, type Mesh, clamp01, fanInto, fromIndexed, tooBig,
} from './shared.ts';

export function parseOFF(bytes: string | ArrayBuffer): Mesh {
  const text = typeof bytes === 'string' ? bytes : new TextDecoder().decode(bytes);
  const lines = meaningfulLines(text);
  if (!lines.length) throw new MeshError('This OFF file is empty');

  // The magic word, and whatever counts share its line. `OFF 8 6 12` is legal
  // and common enough that treating the first line as the word alone loses the
  // counts.
  let cursor = 0;
  const first = lines[cursor].split(/\s+/);
  const magic = (first[0] || '').toUpperCase();
  if (!/^(ST)?(C)?(N)?(4)?(N)?OFF$/.test(magic)) throw new MeshError('This is not an OFF file');
  const hasColour = magic.includes('C');
  const hasNormals = magic.includes('N');
  const hasTexture = magic.startsWith('ST');
  const homogeneous = magic.includes('4');

  let counts = first.slice(1).filter(Boolean);
  cursor++;
  while (counts.length < 3 && cursor < lines.length) {
    counts = counts.concat(lines[cursor++].split(/\s+/).filter(Boolean));
  }
  if (counts.length < 3) throw new MeshError('This OFF file has no counts in it');

  const vertN = Number(counts[0]);
  const faceN = Number(counts[1]);
  if (!Number.isSafeInteger(vertN) || vertN < 0 || !Number.isSafeInteger(faceN) || faceN < 0) {
    throw new MeshError('This OFF file declares counts that are not numbers');
  }
  if (vertN > CAPS.elem) throw oversize('mesh-triangles', tooBig(vertN));
  // Against the lines that are actually there, before anything is allocated.
  if (vertN + faceN > lines.length - cursor) {
    throw new MeshError('This OFF file declares more data than it contains');
  }

  // How many numbers precede the colour on a vertex line, and how many follow
  // it. The spec's order, which is what the count is derived from; the fallback
  // below is what covers the writers that disagree.
  const posN = homogeneous ? 4 : 3;
  const beforeColour = posN + (hasNormals ? 3 : 0);

  const verts: number[] = new Array(vertN * 3);
  const cols: number[] | null = hasColour ? new Array(vertN * 3) : null;

  for (let v = 0; v < vertN; v++) {
    const n = lines[cursor++].split(/\s+/).filter(Boolean).map(Number);
    if (n.length < posN) throw new MeshError('This OFF file has a vertex with too few coordinates');
    // A 4OFF's fourth coordinate is a homogeneous divisor. One is the identity
    // and zero is a point at infinity, which is not a place a card can draw.
    const w = homogeneous && n[3] ? n[3] : 1;
    verts[v * 3] = n[0] / w;
    verts[v * 3 + 1] = n[1] / w;
    verts[v * 3 + 2] = n[2] / w;
    if (cols) {
      // From the declared position where the line is long enough for it, and
      // from the tail where it is not - which is the writer that put the colour
      // somewhere else, and the only reading that recovers it.
      const at = n.length >= beforeColour + 3 ? beforeColour : Math.max(0, n.length - (hasTexture ? 5 : 3));
      const scale = n[at] > 1 || n[at + 1] > 1 || n[at + 2] > 1 ? 1 / 255 : 1;
      cols[v * 3] = clamp01(n[at] * scale);
      cols[v * 3 + 1] = clamp01(n[at + 1] * scale);
      cols[v * 3 + 2] = clamp01(n[at + 2] * scale);
    }
  }

  const tris: number[] = [];
  for (let f = 0; f < faceN && cursor < lines.length; f++) {
    const n = lines[cursor++].split(/\s+/).filter(Boolean);
    const corners = Number(n[0]);
    // A polygon with more corners than the file has vertices is not a polygon.
    // The ceiling is here rather than at the fan because the slice below sizes
    // an array from it.
    if (!Number.isSafeInteger(corners) || corners < 3 || corners > vertN) continue;
    if (n.length < corners + 1) throw new MeshError('This OFF file has a face with too few corners');
    fanInto(tris, n.slice(1, corners + 1).map(Number));
  }

  if (!tris.length) throw new MeshError('This OFF file has no faces in it');
  return fromIndexed(verts, tris, cols);
}

/** Every line with something on it, comments and blanks dropped. OFF's comment
 *  is a `#` anywhere on a line, which is why this is a strip rather than a
 *  filter. */
function meaningfulLines(text: string) {
  const out: string[] = [];
  for (const raw of text.split(/\r\n?|\n/)) {
    const hash = raw.indexOf('#');
    const line = (hash < 0 ? raw : raw.slice(0, hash)).trim();
    if (line) out.push(line);
  }
  return out;
}
