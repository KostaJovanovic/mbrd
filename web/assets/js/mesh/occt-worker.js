// The CAD kernel, off the main thread.
//
// STEP and IGES are the two formats in this app that do not contain a model.
// They contain a *description* of one - trimmed surfaces, curves, a topology
// tying them together - and turning that into triangles is a geometry kernel's
// job. mesh/step.ts and mesh/iges.ts do it, well enough for a card and no
// better; this runs Open CASCADE, which is what every CAD viewer runs, and gets
// the answer a CAD viewer gets. Which of the two a given file goes through is
// decided in mesh/occt.ts, and the hand-written pair are still there as what
// happens when this does not load.
//
// **Classic, not a module, and that is what `importScripts` below is for.** The
// vendored file is an Emscripten UMD bundle: it defines one global and resolves
// its own .wasm beside itself. Loading it as a module would mean shimming that,
// and there is nothing to gain - this worker imports nothing else, by design.
// The global is reached as `self.occtimportjs` rather than bare, which is what
// import/tiff-worker.js does with UTIF and for the same reason: a bare name has
// nothing declaring it and the lint cannot tell it from a typo.
//
// **It runs without the site's Content-Security-Policy**, which is a decision
// argued at length beside its rule in web/_headers. The short version is that
// compiling WebAssembly needs 'wasm-unsafe-eval', granting that to the document
// would grant it to everything, and what runs here instead is one file this
// repository carries, spawned by us, with no DOM and an interface of one message
// in and one message out. This file must therefore stay what it says it is:
// **it may not fetch anything, and it may not be given anything but bytes.**
//
// The interface is a triangle soup, not the kernel's own shape. OCCT answers
// with one indexed mesh per solid, each with its own colour; mbrd's Mesh is a
// flat run of triangles with a colour per vertex, so the expansion happens here
// rather than on the main thread - the arrays are transferred, so doing it here
// is what makes the hand-off free, and doing it on the other side would mean
// copying the indexed form across first.

importScripts('../../vendor/occt/occt-import-js.js');

/** Resolved once. The kernel is 7 MB of wasm and instantiating it is the
 *  expensive half of the first STEP file anybody opens; every one after that
 *  reuses this. */
let ready = null;

function kernel() {
  if (!ready) {
    ready = self.occtimportjs({
      // Emscripten asks where its .wasm is by filename alone. Answering with a
      // URL resolved against this file keeps the pair together whatever the
      // site is served from, and keeps the answer same-origin - which is the
      // whole reason this worker needs no network.
      locateFile: name => new URL('../../vendor/occt/' + name, self.location.href).href,
    });
    // A failed instantiation must not be remembered, or the second attempt
    // returns the first one's rejection and the fallback reader is chosen
    // forever on the strength of one bad load.
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

    const result = read(occt, new Uint8Array(bytes));
    if (!result || !result.success || !result.meshes || !result.meshes.length) {
      throw new Error('The kernel read this file and found no geometry in it');
    }

    // Counted before anything is allocated. A ceiling that is only noticed once
    // the arrays exist is not a ceiling - see mesh/shared.ts, where the number
    // comes from, and consent.ts for what the other side does with this.
    let triangles = 0;
    for (const m of result.meshes) triangles += triangleCount(m);
    if (triangles > maxTriangles) {
      self.postMessage({ id, oversize: triangles });
      return;
    }

    const mesh = flatten(result.meshes, triangles);
    // Handed over rather than copied: fourteen megabytes of positions and
    // normals is worth the two lines.
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
 * Every solid's triangles, end to end, in mbrd's own layout.
 *
 * **Colour is per solid in what arrives and per vertex here, and the interesting
 * case is the file that is only partly answered.** The kernel reports a colour
 * per solid, and an assembly whose parts are styled one at a time comes back
 * with some of them missing - this file's own test case has six of eight, and
 * the two it misses are the pair sharing one representation. There is no
 * per-vertex way to say "and this bit takes the board's ink": canvas/model.ts
 * has one `uOwnColor` uniform for the whole mesh. So a partly-answered file has
 * to be drawn entirely in its own colours or entirely in the board's.
 *
 * Filling the gaps with white was the first reading and it is plainly wrong -
 * white is a colour, it is not the board's, and what it drew was an assembly
 * with two of its parts blank. Dropping every colour the moment one solid is
 * unanswered was the second, and it is wrong more quietly: the file *did* say,
 * eight times, in one style; a reader that throws that away leaves the model
 * shaded in the board's ink, which is a still that goes stale on the next
 * palette change (see stillFor() in canvas/model.ts) and a model re-read from
 * its bytes every time somebody moves a colour slider.
 *
 * So: what the answered solids agree on, if they agree. One presentation style
 * over a whole assembly is what a mechanical exporter writes, and taking the
 * one colour a file names is a reading of the file rather than an invention.
 * Solids answered with two different colours and a gap between them is a file
 * this cannot draw faithfully either way, and that one takes the board's ink.
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
    // A solid the kernel answered for keeps its own colour; one it did not takes
    // the colour the rest of the file agreed on, which is the only reason there
    // is a colour array at all.
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

  // OCCT supplies normals for everything it tessellates. A solid that somehow
  // arrived without them is shaded flat rather than black.
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

/**
 * The one colour this file names, or null if it names none or more than one.
 *
 * Compared at four decimals rather than exactly. The colours come back as
 * doubles out of a linear conversion the kernel did per solid, so eight solids
 * carrying one STEP presentation style can differ in the last bits - and a
 * comparison that noticed would report "more than one colour" for a file with
 * one, which is the failure this whole function exists to avoid.
 */
function agreedColour(meshes) {
  let found = null;
  for (const m of meshes) {
    if (!m.color) continue;
    if (!found) { found = m.color; continue; }
    for (let k = 0; k < 3; k++) if (Math.abs(found[k] - m.color[k]) > 1e-4) return null;
  }
  return found;
}

/**
 * Back out of linear light, which is the space the kernel answers in.
 *
 * OCCT converts a STEP presentation colour to linear on the way in, so a file
 * saying 0.6275 comes back as 0.3515. mbrd's renderer has no gamma anywhere -
 * canvas/model.ts multiplies the colour by a light term and writes it straight
 * to the framebuffer - so a linear value handed to it is simply a darker one,
 * and the same file read by mesh/step.ts, which takes the number the file wrote,
 * would come out visibly lighter. Two readers of one file disagreeing about
 * shade is the kind of difference nobody diagnoses.
 *
 * The standard sRGB transfer function, not a 2.2 power: the toe below
 * 0.0031308 is linear, and skipping it turns near-black into black.
 */
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
