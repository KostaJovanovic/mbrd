// The shape every mesh parser returns, and the arithmetic they all repeat.
//
// This file exists because mesh.ts stopped being one reader and became eight.
// STL, OBJ and glTF were three parsers in one module and the helpers below were
// private to it; PLY, OFF, 3MF, AMF, FBX, Collada, 3DS, STEP and IGES are nine
// more, and nine more copies of "grow the box, unit the normals, refuse past the
// ceiling" is nine more places for the ceiling to be forgotten.
//
// So the pieces every reader needs sit here, one floor below all of them, and
// mesh.ts re-exports the public half so that `import { Mesh } from './mesh.ts'`
// keeps meaning what it meant. Nothing in here knows about any format. It
// imports consent.ts and nothing else, which is what keeps the whole family
// loadable in a test with no DOM - the same property mesh.ts has always had and
// the reason its parsers can be fed real bytes under node.
//
// The one thing to be careful with is CAPS. It is module state that a parse
// mutates, which is usually the wrong answer and is argued at length in
// mesh.ts's own header: **every parser under here is synchronous end to end**,
// so one parse cannot begin while another is in progress, and parseMesh()'s
// `finally` puts the defaults back whichever way a parse ended. If any reader in
// this family ever grows an `await`, that argument is gone and the caps have to
// be threaded instead.

import { oversize, mb } from '../consent.ts';

/**
 * A parsed model, in the app's own space.
 *
 * The first four fields are what every parser returns. The last three came from
 * OBJ and are now shared: a colour per vertex is what PLY, 3MF, AMF, Collada and
 * 3DS carry too, `mtllib` is still OBJ's alone, and `triMat` is the material name
 * per triangle that applyMaterials() resolves against a library.
 *
 * Indices are resolved rather than kept. A moodboard draws a model once at a
 * small size and never edits it, so the memory an index buffer saves is not
 * worth a second code path in the drawing.
 */
export type MeshBounds = { min: number[]; max: number[] };
export type Mesh = {
  positions: Float32Array;
  normals: Float32Array;
  count: number;
  bounds: MeshBounds;
  colors?: Float32Array | null;
  mtllib?: string | null;
  triMat?: (string | null)[] | null;
  /**
   * Which way this *file* says is up, where it says at all.
   *
   * Only two formats do: FBX carries `UpAxis` in its global settings and
   * Collada carries `<up_axis>`, and both genuinely vary - Maya writes Y-up and
   * 3ds Max writes Z-up, and neither is a fact about the format. So the reader
   * states what the document said and parseMesh() prefers it over
   * defaultUpAxis(), which is a guess about the format rather than a reading of
   * the file. A user's own `meta.upAxis` still beats both.
   */
  upAxis?: 'y' | 'z' | null;
};

/**
 * The ceiling, in triangles.
 *
 * A 3D file has no natural size limit and a dropped folder is not vetted, so
 * this is the same kind of guard zip.ts puts on an inflated entry: past it the
 * file is not opened without being asked about first, rather than being allowed
 * to take the tab down unannounced. Two million triangles is roughly a 100MB
 * binary STL and far more detail than a card a few hundred pixels wide can show -
 * the honest failure is "too big to look at", not a black canvas after forty
 * seconds.
 *
 * "Too big to look at" is the part that made this a question rather than a
 * refusal. It is an argument about what the *card* can use, and somebody opening
 * a 6M-triangle scan on a machine that can hold it is not wrong about their own
 * machine - they are answering a question about detail, and the answer is theirs.
 * What they are owed is the number and what it costs, which is what the warning
 * carries.
 */
export const MAX_TRIANGLES = 2_000_000;

/**
 * The most elements an accessor may declare, before any buffer is touched.
 *
 * `acc.count` is a number out of an untrusted file, and readAccessor() used to
 * allocate `count * components` up front - so a lie of a few bytes bought a
 * multi-gigabyte typed array. A 2M-triangle mesh needs at most 6M vertices, so
 * nothing legitimate declares more than this. See AUD-06.
 *
 * PLY, FBX and 3DS all declare their counts the same way and are held to the
 * same number, which is the reason this moved down here from mesh.ts.
 */
export const MAX_ELEMENTS = MAX_TRIANGLES * 3;

/** Decoded bytes of one embedded (data-URI, or inflated) buffer. atob() and the
 *  inflater both allocate the whole result, so this is checked from the stated
 *  or encoded length *before* decoding rather than after. */
export const MAX_BUFFER_BYTES = 512 * 1024 ** 2;

export class MeshError extends Error {}

// ---------------------------------------------------------------------------
// The ceilings, for one parse
// ---------------------------------------------------------------------------
//
// Every number above is a warning, not a refusal: a model past MAX_TRIANGLES is
// offered to whoever dropped it, with what it will cost, and opened if they say
// yes. See consent.ts, and the retry contract in its header - this family throws
// Oversize and canvas/model.ts asks and calls back with `lift`.
//
// Held in one mutable record rather than threaded through every parser. The
// alternative is a cap parameter on some forty functions across ten modules, a
// boolean carried down call chains that have no branches in them, and every one
// of them a place for a future caller to forget it.
//
// Read through the object rather than copied into locals at the top of a parse:
// a local is a snapshot, and lift() is answered *between* the two parses, not
// during one.
export const CAPS = {
  tri: MAX_TRIANGLES,
  elem: MAX_ELEMENTS,
  buf: MAX_BUFFER_BYTES,
};

/** Open it however large it turns out to be, because somebody has been told what
 *  that costs and said yes. Only parseMesh() is entitled to call this. */
export function liftCaps() {
  CAPS.tri = Infinity;
  CAPS.elem = Infinity;
  CAPS.buf = Infinity;
}

/** Back to the defaults, whichever way the parse ended. A lifted ceiling that
 *  outlived its parse would silently apply to the next model on the board, which
 *  nobody agreed to. */
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

/** Replace a facet's normals with the one its winding implies, if it has none. */
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

/** The same, for the plain arrays most of the readers build into. */
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

/**
 * Fill only the corners of the last triangle that carry no normal (0,0,0) with
 * the facet's own, leaving supplied per-corner normals intact. The face normal
 * is computed lazily, so a triangle that already has all three costs nothing.
 */
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
  // A degenerate triangle - three collinear points, which real files do carry -
  // has no normal at all. Up is a lie, but it is a lie that shades.
  return len ? [x / len, y / len, z / len] : [0, 0, 1];
}

// ---------------------------------------------------------------------------
// Finishing
// ---------------------------------------------------------------------------

export function finish(positions: Float32Array, normals: Float32Array, box: MeshBounds): Mesh {
  if (!Number.isFinite(box.min[0])) throw new MeshError('This model has no geometry in it');
  // Unit length, once, here - so the shader never has to normalise and a file
  // whose own normals were not unit does not come out shaded differently from
  // one whose were.
  for (let i = 0; i < normals.length; i += 3) {
    const len = Math.hypot(normals[i], normals[i + 1], normals[i + 2]);
    // `!(len > 0)` rather than `!len`, so a NaN component (a malformed file whose
    // normals ran short of its positions) collapses to a clean (0,0,1) too - `!NaN`
    // is true but only ever set z, leaving NaN in x/y for the shader.
    if (!(len > 0)) { normals[i] = 0; normals[i + 1] = 0; normals[i + 2] = 1; continue; }
    normals[i] /= len; normals[i + 1] /= len; normals[i + 2] /= len;
  }
  return { positions, normals, count: positions.length / 3, bounds: box };
}

/**
 * The common tail of every indexed reader: a vertex table, a triangle list into
 * it, and optionally a colour per vertex.
 *
 * Nine of the eleven formats in this family arrive in exactly this shape - PLY,
 * OFF, 3MF, AMF, Collada, 3DS, FBX and both CAD tessellators - because an
 * indexed mesh is what everybody who is not STL writes. Expanding it is the same
 * fifteen lines each time, and the ceiling check has to happen *before* the
 * allocation rather than after, which is the part that is easy to write in the
 * wrong order.
 *
 * `verts` is xyz per vertex, `tris` is three indices per triangle, `cols` is rgb
 * per vertex in 0..1 or null. An index outside the table is a file that does not
 * say what it means, and is a plain Error rather than a ceiling - see the
 * distinction in consent.ts's header.
 */
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
      // Checked rather than clamped. A model that names a vertex it does not
      // carry is not a large model or an old one, it is a file whose indices do
      // not mean what the format says they mean.
      if (!(vi >= 0 && vi < vertN)) {
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

/**
 * Fan an n-gon into triangles from its first corner, pushing indices.
 *
 * Correct for the convex faces a modeller emits and the standard reading, the
 * same one parseOBJ() takes. OFF, PLY, Collada and 3MF's production extension
 * all allow polygons, and every one of them means a convex one in practice.
 */
export function fanInto(tris: number[], corners: ArrayLike<number>) {
  for (let i = 1; i + 1 < corners.length; i++) {
    if (tris.length / 3 >= CAPS.tri) throw oversize('mesh-triangles', tooBig(CAPS.tri));
    tris.push(corners[0], corners[i], corners[i + 1]);
  }
}

/**
 * A mesh under construction, for the readers that emit triangles rather than
 * an index table.
 *
 * The formats that need this are the ones where a triangle's colour is the
 * triangle's and not its corners' - 3MF's property groups, 3DS's material
 * assignments, the per-face material of a Collada `<triangles>` - and the ones
 * that generate geometry rather than reading it, which is both CAD tessellators.
 * fromIndexed() cannot serve them: it colours per vertex, and a face colour on
 * shared vertices has no per-vertex answer.
 *
 * Colours are held back until the first coloured triangle arrives and then
 * backfilled with white, the same trick parseOBJ() plays with `hasVC`: near the
 * triangle ceiling an unused colour array is tens of megabytes of transient
 * allocation, and most files never colour anything.
 */
export class MeshBuild {
  p: number[] = [];
  n: number[] = [];
  c: number[] = [];
  coloured = false;
  box = newBox();

  /** One triangle, with an optional rgb in 0..1 for all three of its corners. */
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
      // First colour seen: white for every corner already emitted, so the array
      // stays in step with the positions.
      if (!this.coloured) { for (let k = this.c.length; k < base; k++) this.c.push(1); }
      this.coloured = true;
      for (let v = 0; v < 3; v++) this.c.push(rgb[0], rgb[1], rgb[2]);
    } else if (this.coloured) {
      for (let v = 0; v < 9; v++) this.c.push(1);
    }
  }

  /** The corner normals of the last triangle, where the file supplied them.
   *  Called straight after tri(), which has already filled in the facet's own. */
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

/**
 * `#rgb`, `#rrggbb` or `#rrggbbaa` to three numbers in 0..1, or null.
 *
 * Alpha is parsed and dropped. The renderer draws a model opaque - there is no
 * blend state and no depth sort in canvas/model.ts - so a translucent material
 * would come out as its own colour at full strength either way, and returning
 * the alpha would only invite somebody to multiply it into the colour and render
 * a red part pink.
 */
export function hexRGB(raw: string | undefined | null): number[] | null {
  const s = (raw || '').trim().replace(/^#/, '');
  if (!/^[0-9a-fA-F]+$/.test(s)) return null;
  const at = (i: number, w: number) => parseInt(s.slice(i, i + w), 16) / (w === 1 ? 15 : 255);
  if (s.length === 3 || s.length === 4) return [at(0, 1), at(1, 1), at(2, 1)];
  if (s.length === 6 || s.length === 8) return [at(0, 2), at(2, 2), at(4, 2)];
  return null;
}

/** Ext of a filename, lowercased, no dot. Empty for a name with no extension -
 *  a dotfile has none, which is why the index must be past zero. */
export function extOf(name: string) {
  const i = name.lastIndexOf('.');
  return i > 0 ? name.slice(i + 1).toLowerCase() : '';
}
