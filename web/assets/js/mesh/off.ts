// Geomview OFF. Prefixes (COFF, NOFF, STOFF, 4OFF) declare which fields are
// present; actual offset recovered per line (writers disagree on column order).
// Face colours skipped (per-polygon; output is per-vertex).

import { oversize } from '../consent.ts';
import {
  CAPS, MeshError, type Mesh, clamp01, fanInto, fromIndexed, tooBig,
} from './shared.ts';

export function parseOFF(bytes: string | ArrayBuffer): Mesh {
  const text = typeof bytes === 'string' ? bytes : new TextDecoder().decode(bytes);
  const lines = meaningfulLines(text);
  if (!lines.length) throw new MeshError('This OFF file is empty');

  // `OFF 8 6 12` is legal and common - counts can share the magic word's line.
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
  // Checked against lines actually present, before anything is allocated.
  if (vertN + faceN > lines.length - cursor) {
    throw new MeshError('This OFF file declares more data than it contains');
  }

  // Numbers preceding the colour on a vertex line, per spec order; the
  // fallback below covers writers that put it somewhere else.
  const posN = homogeneous ? 4 : 3;
  const beforeColour = posN + (hasNormals ? 3 : 0);

  const verts: number[] = new Array(vertN * 3);
  const cols: number[] | null = hasColour ? new Array(vertN * 3) : null;

  for (let v = 0; v < vertN; v++) {
    const n = lines[cursor++].split(/\s+/).filter(Boolean).map(Number);
    if (n.length < posN) throw new MeshError('This OFF file has a vertex with too few coordinates');
    // 4OFF's fourth coordinate is a homogeneous divisor; zero is a point at
    // infinity, not drawable, so it falls back to the identity.
    const w = homogeneous && n[3] ? n[3] : 1;
    verts[v * 3] = n[0] / w;
    verts[v * 3 + 1] = n[1] / w;
    verts[v * 3 + 2] = n[2] / w;
    if (cols) {
      // Declared position when the line is long enough; otherwise the tail,
      // which recovers a colour a writer placed somewhere nonstandard.
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
    // More corners than the file has vertices isn't a polygon; checked here,
    // not at the fan, since the slice below sizes an array from it.
    if (!Number.isSafeInteger(corners) || corners < 3 || corners > vertN) continue;
    if (n.length < corners + 1) throw new MeshError('This OFF file has a face with too few corners');
    fanInto(tris, n.slice(1, corners + 1).map(Number));
  }

  if (!tris.length) throw new MeshError('This OFF file has no faces in it');
  return fromIndexed(verts, tris, cols);
}

/** Every non-empty line, comments and blanks dropped. OFF comments are a `#`
 *  anywhere on a line, so each line is stripped, not just filtered. */
function meaningfulLines(text: string) {
  const out: string[] = [];
  for (const raw of text.split(/\r\n?|\n/)) {
    const hash = raw.indexOf('#');
    const line = (hash < 0 ? raw : raw.slice(0, hash)).trim();
    if (line) out.push(line);
  }
  return out;
}
