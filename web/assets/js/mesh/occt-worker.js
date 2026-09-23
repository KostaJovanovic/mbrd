// Open CASCADE worker — tessellates STEP/IGES into triangle soup.
// Classic script (importScripts) because the vendored Emscripten UMD
// resolves its own .wasm. Runs without CSP (needs wasm-unsafe-eval);
// must not fetch anything or receive anything but bytes.
// Output is flat per-vertex positions/normals/colors, transferred.

importScripts('../../vendor/occt/occt-import-js.js');

/** Resolved once — 7 MB wasm, expensive first time only. */
let ready = null;

function kernel() {
  if (!ready) {
    ready = self.occtimportjs({
      // Resolve .wasm relative to this file — keeps it same-origin.
      locateFile: name => new URL('../../vendor/occt/' + name, self.location.href).href,
    });
    // Don't cache a failed instantiation — retry must be possible.
    ready.catch(() => { ready = null; });
  }
  return ready;
}

const READERS = {
  step: (occt, bytes) => occt.ReadStepFile(bytes, null),
  iges: (occt, bytes) => occt.ReadIgesFile(bytes, null),
};

self.onmessage = async ev => {
  const { id, kind, bytes, maxTriangles } = ev.data || {};
  try {
    const occt = await kernel();
    const read = READERS[kind];
    if (!read) throw new Error(`${kind} is not a kernel format`);

    let result;
    try {
      result = read(occt, new Uint8Array(bytes));
    } catch (err) {
      // A throw out of the kernel is usually an Emscripten abort, which leaves
      // the instance unusable. Kept, it would fail every later file too.
      ready = null;
      throw err;
    }
    if (!result || !result.success || !result.meshes || !result.meshes.length) {
      throw new Error('The kernel read this file and found no geometry in it');
    }

    // Count before allocating — a ceiling checked after is not a ceiling.
    let triangles = 0;
    for (const m of result.meshes) triangles += triangleCount(m);
    if (triangles > maxTriangles) {
      self.postMessage({ id, oversize: triangles });
      return;
    }

    const mesh = flatten(result.meshes, triangles);
    // Transfer, not copy.
    const moved = [mesh.positions.buffer, mesh.normals.buffer];
    if (mesh.colors) moved.push(mesh.colors.buffer);
    self.postMessage({ id, ...mesh }, moved);
  } catch (err) {
    self.postMessage({ id, error: (err && err.message) || 'The kernel could not read this file' });
  }
};

function triangleCount(m) {
  const index = m.index && m.index.array;
  const position = m.attributes && m.attributes.position && m.attributes.position.array;
  if (index) return index.length / 3;
  return position ? position.length / 9 : 0;
}

/**
 * All solids' triangles in mbrd's per-vertex layout. Colour is per-solid
 * from OCCT but per-vertex here; partly-coloured files use the single
 * agreed colour (agreedColour) or fall back to the board's ink.
 */
function flatten(meshes, triangles) {
  const positions = new Float32Array(triangles * 9);
  const normals = new Float32Array(triangles * 9);
  const stated = agreedColour(meshes);
  const colors = stated ? new Float32Array(triangles * 9) : null;

  const min = [Infinity, Infinity, Infinity];
  const max = [-Infinity, -Infinity, -Infinity];
  let at = 0;

  for (const m of meshes) {
    const position = m.attributes && m.attributes.position && m.attributes.position.array;
    if (!position) continue;
    const normal = m.attributes && m.attributes.normal && m.attributes.normal.array;
    const index = m.index && m.index.array;
    // Unanswered solids take the agreed colour.
    const rgb = colors ? (m.color || stated).map(encode) : null;
    const vertices = index ? index.length : position.length / 3;

    for (let i = 0; i < vertices; i++) {
      const v = index ? index[i] : i;
      for (let k = 0; k < 3; k++) {
        const value = position[v * 3 + k];
        positions[at + k] = value;
        if (value < min[k]) min[k] = value;
        if (value > max[k]) max[k] = value;
        if (normal) normals[at + k] = normal[v * 3 + k];
        if (colors) colors[at + k] = rgb[k];
      }
      at += 3;
    }
  }

  // Fill missing normals with face normal — flat shading, not black.
  for (let i = 0; i < normals.length; i += 9) {
    if (normals[i] || normals[i + 1] || normals[i + 2]) continue;
    faceNormal(positions, normals, i);
  }

  return {
    triangles,
    positions,
    normals,
    colors,
    bounds: triangles ? { min, max } : { min: [0, 0, 0], max: [0, 0, 0] },
  };
}

/** The one colour all solids agree on, or null. Compared at 4 decimals
 *  because the kernel's linear conversion introduces last-bit drift. */
function agreedColour(meshes) {
  let found = null;
  for (const m of meshes) {
    if (!m.color) continue;
    if (!found) { found = m.color; continue; }
    for (let k = 0; k < 3; k++) if (Math.abs(found[k] - m.color[k]) > 1e-4) return null;
  }
  return found;
}

/** Linear → sRGB. OCCT answers in linear; mbrd's renderer has no gamma,
 *  so without this the mesh is darker than mesh/step.ts reads it. */
function encode(c) {
  const v = Math.max(0, Math.min(1, c));
  return v <= 0.0031308 ? v * 12.92 : 1.055 * Math.pow(v, 1 / 2.4) - 0.055;
}

function faceNormal(p, n, i) {
  const ax = p[i + 3] - p[i], ay = p[i + 4] - p[i + 1], az = p[i + 5] - p[i + 2];
  const bx = p[i + 6] - p[i], by = p[i + 7] - p[i + 1], bz = p[i + 8] - p[i + 2];
  let x = ay * bz - az * by, y = az * bx - ax * bz, z = ax * by - ay * bx;
  const length = Math.hypot(x, y, z) || 1;
  x /= length; y /= length; z /= length;
  for (let k = 0; k < 9; k += 3) { n[i + k] = x; n[i + k + 1] = y; n[i + k + 2] = z; }
}
