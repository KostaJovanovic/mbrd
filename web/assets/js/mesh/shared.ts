// Shared types and helpers for every mesh parser. Format-agnostic.
// CAPS is mutable module state — safe only because every parser is synchronous.
// If any reader adds an `await`, CAPS must be threaded instead.

import { oversize, mb } from '../consent.ts';

// Indices are expanded — a card draws once at small size, no index buffer needed.
export type MeshBounds = { min: number[]; max: number[] };
export type Mesh = {
  positions: Float32Array;
  normals: Float32Array;
  count: number;
  bounds: MeshBounds;
  colors?: Float32Array | null;
  mtllib?: string | null;
  triMat?: (string | null)[] | null;
  // From the file (FBX/Collada only); parseMesh() prefers it over the format default.
  upAxis?: 'y' | 'z' | null;
};

// ~100 MB binary STL. Past this the user is asked, not refused.
export const MAX_TRIANGLES = 2_000_000;

// Pre-allocation guard: prevents a bogus count from buying a multi-GB array.
export const MAX_ELEMENTS = MAX_TRIANGLES * 3;

// Checked before decoding — atob/inflate allocate the full result at once.
export const MAX_BUFFER_BYTES = 512 * 1024 ** 2;

export class MeshError extends Error {}

// ---------------------------------------------------------------------------
// The ceilings, for one parse
// ---------------------------------------------------------------------------
export const CAPS = {
  tri: MAX_TRIANGLES,
  elem: MAX_ELEMENTS,
  buf: MAX_BUFFER_BYTES,
};

// Called by parseMesh() after the user accepts the oversize warning.
export function liftCaps() {
  CAPS.tri = Infinity;
  CAPS.elem = Infinity;
  CAPS.buf = Infinity;
}

// Restore defaults in parseMesh()'s finally — a lifted cap must not leak.
export function resetCaps() {
  CAPS.tri = MAX_TRIANGLES;
  CAPS.elem = MAX_ELEMENTS;
  CAPS.buf = MAX_BUFFER_BYTES;
}

// ---------------------------------------------------------------------------
// Bounds
// ---------------------------------------------------------------------------

export const newBox = (): MeshBounds =>
  ({ min: [Infinity, Infinity, Infinity], max: [-Infinity, -Infinity, -Infinity] });

export function grow(box: MeshBounds, x: number, y: number, z: number) {
  if (x < box.min[0]) box.min[0] = x;
  if (y < box.min[1]) box.min[1] = y;
  if (z < box.min[2]) box.min[2] = z;
  if (x > box.max[0]) box.max[0] = x;
  if (y > box.max[1]) box.max[1] = y;
  if (z > box.max[2]) box.max[2] = z;
}

// ---------------------------------------------------------------------------
// Normals
// ---------------------------------------------------------------------------

// Fill missing normals from the triangle winding.
export function fixFacet(positions: Float32Array, normals: Float32Array, base: number) {
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

// Same as fixFacet, for plain number[] arrays.
export function fixFacetArrays(p: number[], nrm: number[], base: number) {
  const n = faceNormal(p[base], p[base + 1], p[base + 2],
                       p[base + 3], p[base + 4], p[base + 5],
                       p[base + 6], p[base + 7], p[base + 8]);
  for (let v = 0; v < 3; v++) {
    nrm[base + v * 3] = n[0];
    nrm[base + v * 3 + 1] = n[1];
    nrm[base + v * 3 + 2] = n[2];
  }
}

// Fill zero-normal corners with the face normal, leaving supplied normals intact.
export function fillFacetGaps(p: number[], nrm: number[], base: number) {
  let n: number[] | null = null;
  for (let v = 0; v < 3; v++) {
    const o = base + v * 3;
    if (nrm[o] || nrm[o + 1] || nrm[o + 2]) continue;
    if (!n) n = faceNormal(p[base], p[base + 1], p[base + 2],
                           p[base + 3], p[base + 4], p[base + 5],
                           p[base + 6], p[base + 7], p[base + 8]);
    nrm[o] = n[0]; nrm[o + 1] = n[1]; nrm[o + 2] = n[2];
  }
}

export function faceNormal(
  ax: number, ay: number, az: number,
  bx: number, by: number, bz: number,
  cx: number, cy: number, cz: number,
) {
  const ux = bx - ax, uy = by - ay, uz = bz - az;
  const vx = cx - ax, vy = cy - ay, vz = cz - az;
  const x = uy * vz - uz * vy;
  const y = uz * vx - ux * vz;
  const z = ux * vy - uy * vx;
  const len = Math.hypot(x, y, z);
  // Degenerate triangle (collinear points) — fallback so it still shades.
  return len ? [x / len, y / len, z / len] : [0, 0, 1];
}

// ---------------------------------------------------------------------------
// Finishing
// ---------------------------------------------------------------------------

export function finish(positions: Float32Array, normals: Float32Array, box: MeshBounds): Mesh {
  if (!Number.isFinite(box.min[0])) throw new MeshError('This model has no geometry in it');
  // All six, not the first: one vertex at infinity on any axis leaves a box
  // no camera can frame, and the card draws blank with nothing to say why.
  // Rounded to float first, since that is what the positions are stored as.
  if (![...box.min, ...box.max].every(v => Number.isFinite(Math.fround(v)))) {
    throw new MeshError('This model has a vertex at an impossible position');
  }
  // Normalize once so the shader never has to.
  for (let i = 0; i < normals.length; i += 3) {
    const len = Math.hypot(normals[i], normals[i + 1], normals[i + 2]);
    // !(len > 0) catches NaN from malformed files, where !NaN would leave x/y dirty.
    if (!(len > 0)) { normals[i] = 0; normals[i + 1] = 0; normals[i + 2] = 1; continue; }
    normals[i] /= len; normals[i + 1] /= len; normals[i + 2] /= len;
  }
  return { positions, normals, count: positions.length / 3, bounds: box };
}

// Expand an indexed mesh (verts xyz, tris 3-per-face, optional cols rgb 0..1)
// into the flat buffers every reader returns. Ceiling checked before allocation.
export function fromIndexed(
  verts: ArrayLike<number>,
  tris: ArrayLike<number>,
  cols?: ArrayLike<number> | null,
): Mesh {
  const n = (tris.length / 3) | 0;
  if (n > CAPS.tri) throw oversize('mesh-triangles', tooBig(n));
  if (!n) throw new MeshError('This model has no faces in it');
  const vertN = (verts.length / 3) | 0;
  const positions = new Float32Array(n * 9);
  const normals = new Float32Array(n * 9);
  const colors = cols ? new Float32Array(n * 9) : null;
  const box = newBox();

  for (let t = 0; t < n; t++) {
    const base = t * 9;
    for (let c = 0; c < 3; c++) {
      const vi = tris[t * 3 + c];
      // Out-of-range index = corrupt file, not oversize — throw Error, not Oversize.
      // So is 1.5, which is in range and reads half a vertex: NaN.
      if (!(Number.isInteger(vi) && vi >= 0 && vi < vertN)) {
        throw new MeshError('This model refers to vertices it does not contain');
      }
      const o = base + c * 3, s = vi * 3;
      positions[o] = verts[s];
      positions[o + 1] = verts[s + 1];
      positions[o + 2] = verts[s + 2];
      if (colors) {
        colors[o] = cols![s] ?? 1;
        colors[o + 1] = cols![s + 1] ?? 1;
        colors[o + 2] = cols![s + 2] ?? 1;
      }
      grow(box, positions[o], positions[o + 1], positions[o + 2]);
    }
    fixFacet(positions, normals, base);
  }
  const mesh = finish(positions, normals, box);
  if (colors) mesh.colors = colors;
  return mesh;
}

// Fan a convex n-gon into triangles from its first corner.
export function fanInto(tris: number[], corners: ArrayLike<number>) {
  for (let i = 1; i + 1 < corners.length; i++) {
    if (tris.length / 3 >= CAPS.tri) throw oversize('mesh-triangles', tooBig(CAPS.tri));
    tris.push(corners[0], corners[i], corners[i + 1]);
  }
}

// Incremental mesh builder for formats with per-face colour (not per-vertex).
// Colours are lazily allocated — most files never use them.
export class MeshBuild {
  p: number[] = [];
  n: number[] = [];
  c: number[] = [];
  coloured = false;
  box = newBox();

  tri(
    ax: number, ay: number, az: number,
    bx: number, by: number, bz: number,
    cx: number, cy: number, cz: number,
    rgb?: number[] | null,
  ) {
    if (this.p.length / 9 >= CAPS.tri) throw oversize('mesh-triangles', tooBig(CAPS.tri));
    const base = this.p.length;
    this.p.push(ax, ay, az, bx, by, bz, cx, cy, cz);
    this.n.push(0, 0, 0, 0, 0, 0, 0, 0, 0);
    grow(this.box, ax, ay, az);
    grow(this.box, bx, by, bz);
    grow(this.box, cx, cy, cz);
    fixFacetArrays(this.p, this.n, base);
    if (rgb) {
      // Backfill white up to here so the colour array stays aligned.
      if (!this.coloured) { for (let k = this.c.length; k < base; k++) this.c.push(1); }
      this.coloured = true;
      for (let v = 0; v < 3; v++) this.c.push(rgb[0], rgb[1], rgb[2]);
    } else if (this.coloured) {
      for (let v = 0; v < 9; v++) this.c.push(1);
    }
  }

  // Override corner normals on the last triangle (call after tri()).
  normals(a: number[], b: number[], c: number[]) {
    const base = this.n.length - 9;
    if (base < 0) return;
    for (const [i, v] of [a, b, c].entries()) {
      if (!v || (!v[0] && !v[1] && !v[2])) continue;
      this.n[base + i * 3] = v[0];
      this.n[base + i * 3 + 1] = v[1];
      this.n[base + i * 3 + 2] = v[2];
    }
  }

  get count() { return this.p.length / 9; }

  done(): Mesh {
    if (!this.p.length) throw new MeshError('This model has no geometry in it');
    const mesh = finish(new Float32Array(this.p), new Float32Array(this.n), this.box);
    if (this.coloured) mesh.colors = new Float32Array(this.c);
    return mesh;
  }
}

// ---------------------------------------------------------------------------
// Words
// ---------------------------------------------------------------------------

export const tooBig = (n: number) =>
  `This model has ${n.toLocaleString()} triangles, past the ${MAX_TRIANGLES.toLocaleString()} a card `
  + `normally shows - about ${mb(n * 36)} of geometry.`;

export const clamp01 = (v: number) => (Number.isFinite(v) ? (v < 0 ? 0 : v > 1 ? 1 : v) : 1);

// Hex colour to [r, g, b] in 0..1. Alpha is parsed and dropped (no blend state).
export function hexRGB(raw: string | undefined | null): number[] | null {
  const s = (raw || '').trim().replace(/^#/, '');
  if (!/^[0-9a-fA-F]+$/.test(s)) return null;
  const at = (i: number, w: number) => parseInt(s.slice(i, i + w), 16) / (w === 1 ? 15 : 255);
  if (s.length === 3 || s.length === 4) return [at(0, 1), at(1, 1), at(2, 1)];
  if (s.length === 6 || s.length === 8) return [at(0, 2), at(2, 2), at(4, 2)];
  return null;
}

// Lowercase extension without dot. Empty if none (dotfiles excluded).
export function extOf(name: string) {
  const i = name.lastIndexOf('.');
  return i > 0 ? name.slice(i + 1).toLowerCase() : '';
}
