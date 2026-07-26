// Drawing a 3D model on a card.
//
// import/mesh.js turns the bytes into triangles; this puts them on screen and
// lets you turn them over. WebGL by hand, which is the first graphics code in
// this project and is here for the same reason the zip inflater and the ID3
// reader are: a renderer is a shader pair and a matrix stack, and taking a
// dependency for it would end the one property this codebase actually has.
//
// The thing that shapes this file is not the drawing. It is that **WebGL
// contexts are a scarce, per-page resource** - browsers give a page somewhere
// around sixteen and then start killing the oldest, which on an infinite canvas
// that mounts and unmounts cards as you pan is a guarantee that a model you
// scroll back to comes up blank.
//
// So there is exactly one context in the app, on a canvas that is never in the
// document, and each card holds an ordinary 2D canvas that the shared one is
// blitted into. Cards are then as cheap as pictures and there is no limit on
// how many a board can carry. The cost is that a card only redraws when
// something asks it to - which for a still model on a moodboard is what you
// want anyway.

import { allAssets, getAsset, readText } from '../storage/assets.js';
import { applyMaterials, meshKind, parseMesh, parseMTL, MeshError } from '../import/mesh.js';

/** The shared context, built on first use and never torn down. */
let gl = null;
let glCanvas = null;
let program = null;
let buffers = null;
let attribs = null;
let uniforms = null;
let contextDead = false;

/** Parsed meshes, by asset hash: a board of nine views of one part parses once. */
const meshes = new Map();

// A board can hold more geometry than a page should keep resident. Least
// recently drawn goes first, and it is re-parsed from the asset bytes if it is
// wanted again, which costs a frame rather than a fetch.
const MESH_CACHE_MAX = 12;

/**
 * The biggest the shared canvas is ever asked to be.
 *
 * A card can be dragged to any size on an infinite board, and the drawing
 * buffer is the one cost that scales with it. Past this the model is drawn at
 * this size and stretched, which on a card that large is a difference nobody
 * looking at a moodboard is going to find.
 */
const MAX_BUFFER = 1024;

const VERT = `
attribute vec3 aPos;
attribute vec3 aNormal;
attribute vec3 aColor;
uniform mat4 uProj;
uniform mat4 uView;
varying vec3 vNormal;
varying vec3 vEye;
varying vec3 vColor;
void main() {
  vec4 eye = uView * vec4(aPos, 1.0);
  vEye = eye.xyz;
  // The view matrix carries no scale - it is a rotation and a translation - so
  // the normal needs no separate inverse transpose here. The model's own
  // transforms were already baked in by the parser.
  vNormal = mat3(uView) * aNormal;
  vColor = aColor;
  gl_Position = uProj * eye;
}`;

// Two lights and no texture: a key over the viewer's shoulder and a much weaker
// fill from below-left, which is what stops the underside of a part reading as
// a hole. Backfaces are lit by the flipped normal rather than left black -
// plenty of real STLs have inconsistent winding, and a model with black patches
// looks broken where a model shaded from the wrong side merely looks soft.
// uOwnColor is 1 when the file brought colours of its own and 0 when it did not.
// A mix rather than a multiply: a model that says it is red should be red, not
// red filtered through the board's ink - but a model that says nothing has to
// come out in the palette, which is what makes an uncoloured card belong to the
// board it is pinned to.
const FRAG = `
precision mediump float;
varying vec3 vNormal;
varying vec3 vEye;
varying vec3 vColor;
uniform vec3 uColor;
uniform float uOwnColor;
void main() {
  vec3 n = normalize(vNormal);
  if (!gl_FrontFacing) n = -n;
  float key  = max(dot(n, normalize(vec3(0.35, 0.55, 0.75))), 0.0);
  float fill = max(dot(n, normalize(vec3(-0.6, -0.4, 0.3))), 0.0);
  // A touch of rim, so a silhouette against paper keeps an edge.
  float rim = pow(1.0 - max(dot(n, normalize(-vEye)), 0.0), 2.5);
  float light = 0.26 + key * 0.72 + fill * 0.18 + rim * 0.22;
  gl_FragColor = vec4(mix(uColor, vColor, uOwnColor) * light, 1.0);
}`;

function ensureGL() {
  if (gl || contextDead) return gl;
  glCanvas = document.createElement('canvas');
  glCanvas.width = glCanvas.height = 300;
  gl = glCanvas.getContext('webgl', {
    alpha: true,
    antialias: true,
    depth: true,
    // Nothing reads the buffer after the blit, and asking to preserve it costs
    // a copy per frame on some drivers for a guarantee nothing here wants.
    preserveDrawingBuffer: false,
    // A moodboard is not a game. If the machine would rather not spin up the
    // discrete card for a thumbnail of a bracket, that is the right answer.
    powerPreference: 'low-power',
  });
  if (!gl) { contextDead = true; return null; }

  // A context can be lost at any time - a driver reset, the tab being
  // backgrounded on a laptop that switched GPUs. Everything built on it goes
  // with it, so the state is dropped and rebuilt rather than used dead.
  glCanvas.addEventListener('webglcontextlost', e => {
    e.preventDefault();
    program = null; buffers = null;
  });
  glCanvas.addEventListener('webglcontextrestored', () => { program = null; buffers = null; });

  return gl;
}

function ensureProgram() {
  if (program) return program;
  const vs = compile(gl.VERTEX_SHADER, VERT);
  const fs = compile(gl.FRAGMENT_SHADER, FRAG);
  if (!vs || !fs) { contextDead = true; return null; }
  const p = gl.createProgram();
  gl.attachShader(p, vs);
  gl.attachShader(p, fs);
  gl.linkProgram(p);
  if (!gl.getProgramParameter(p, gl.LINK_STATUS)) { contextDead = true; return null; }
  program = p;
  attribs = {
    pos: gl.getAttribLocation(p, 'aPos'),
    normal: gl.getAttribLocation(p, 'aNormal'),
    color: gl.getAttribLocation(p, 'aColor'),
  };
  uniforms = {
    proj: gl.getUniformLocation(p, 'uProj'),
    view: gl.getUniformLocation(p, 'uView'),
    color: gl.getUniformLocation(p, 'uColor'),
    ownColor: gl.getUniformLocation(p, 'uOwnColor'),
  };
  buffers = { pos: gl.createBuffer(), normal: gl.createBuffer(), color: gl.createBuffer(), of: null };
  return program;
}

function compile(kind, src) {
  const s = gl.createShader(kind);
  gl.shaderSource(s, src);
  gl.compileShader(s);
  return gl.getShaderParameter(s, gl.COMPILE_STATUS) ? s : null;
}

// ---------------------------------------------------------------------------
// The card
// ---------------------------------------------------------------------------

/**
 * A model card: a canvas you can turn the model over in, and the filename
 * under it.
 *
 * The mesh is read lazily and asynchronously, because a 40MB STL is a real
 * pause and it must not be one the board takes while mounting a card. Until it
 * arrives the card says what it is holding, which is also what it says for good
 * if the file turns out to be unreadable.
 */
export function buildModelCard(item) {
  const card = document.createElement('div');
  card.className = 'card card-model';

  const stage = document.createElement('canvas');
  stage.className = 'model-stage';
  // The colour the model is shaded in, taken from the palette rather than
  // hard-coded: `color` resolves whatever the token is - a color-mix, an oklch,
  // an inline override from the Appearance panel - to plain rgb() by the time
  // getComputedStyle sees it, which no amount of parsing var() by hand would.
  stage.style.color = 'var(--ink-2)';

  const note = document.createElement('div');
  note.className = 'model-note';
  note.textContent = 'reading…';

  const name = document.createElement('div');
  name.className = 'card-name';
  name.textContent = item.name || 'model';

  card.append(stage, note, name);

  const view = { yaw: 0.6, pitch: 0.5, zoom: 1 };
  let mesh = null;

  const paint = () => {
    if (!mesh) return;
    drawInto(stage, mesh, view);
  };

  // The card is sized by the board, not by its contents, so the canvas has to
  // follow the box rather than the other way round.
  const ro = new ResizeObserver(paint);
  ro.observe(stage);

  orbit(stage, view, paint);

  load(item).then(m => {
    mesh = m;
    note.remove();
    card.classList.add('is-loaded');
    paint();
  }).catch(err => {
    note.textContent = err instanceof MeshError ? err.message : 'This model could not be read';
    note.classList.add('is-error');
    stage.remove();
  });

  return card;
}

async function load(item) {
  const hash = item.asset?.hash;
  if (!hash) throw new MeshError('This model has no file behind it');
  // Keyed by the up-axis as well as the bytes. Standing a mesh up rewrites its
  // points in place, so one cache entry cannot serve both readings - and two
  // cards on the same file, flipped differently, is exactly what somebody does
  // to decide which way round it goes.
  const key = `${hash}:${item.meta?.upAxis === 'y' ? 'y' : item.meta?.upAxis === 'z' ? 'z' : '-'}`;
  const hit = meshes.get(key);
  if (hit) {
    // Touch: re-inserting moves it to the end of the Map's own ordering, which
    // is what makes the eviction below least-recently-used rather than random.
    meshes.delete(key);
    meshes.set(key, hit);
    return hit;
  }

  const asset = getAsset(hash);
  if (!asset) throw new MeshError('This model is missing its file');
  const kind = meshKind(asset.name || item.name || '');
  if (!kind) throw new MeshError('This is not a model file');

  const mesh = parseMesh(kind, await asset.blob.arrayBuffer(), item.meta?.upAxis);
  await paint(mesh);
  meshes.set(key, mesh);
  while (meshes.size > MESH_CACHE_MAX) meshes.delete(meshes.keys().next().value);
  return mesh;
}

/**
 * An OBJ's material library, if it was dropped alongside the model.
 *
 * A `mtllib` line names a second file, and until now that was the end of it -
 * the parser's own comment said a drop does not carry the .mtl. It does: a drop
 * is a whole folder as often as it is one file, and importFiles() takes up to
 * five hundred of them, so the library is usually sitting in the asset store
 * already under its own name.
 *
 * Matched on the basename only. Exporters write `mtllib` with whatever path
 * they had at the time - `../materials/part.mtl`, a Windows path with
 * backslashes - and none of that survives a drop, which flattens everything to
 * a filename. Case-insensitively, because the file came off somebody else's
 * filesystem and half of those do not care either.
 *
 * Silent when it finds nothing, which is the common case and not a failure: a
 * model with no colours is drawn in the board's ink, which is what every model
 * did before this existed.
 */
async function paint(mesh) {
  if (!mesh.mtllib || mesh.colors) return;
  const want = mesh.mtllib.replace(/\\/g, '/').split('/').pop().toLowerCase();
  if (!want) return;
  for (const [hash, a] of allAssets()) {
    if ((a.name || '').toLowerCase() !== want) continue;
    try {
      applyMaterials(mesh, parseMTL(await readText(hash, MTL_MAX)));
    } catch { /* an unreadable library is a model without colours */ }
    return;
  }
}

/**
 * How much of a .mtl to read.
 *
 * A material library is a few lines per material and these are read in full;
 * the cap is here because readText() takes one and the alternative is trusting
 * that a file named `.mtl` is one. 256KB is a library with thousands of
 * materials in it and a model that has no business being on a moodboard.
 */
const MTL_MAX = 256 * 1024;

/** Drop every cached mesh - the board has been replaced. */
export function resetModels() { meshes.clear(); }

// ---------------------------------------------------------------------------
// Turning it over
// ---------------------------------------------------------------------------

function orbit(stage, view, paint) {
  let dragging = 0;
  let last = null;

  stage.addEventListener('pointerdown', e => {
    // The canvas is one of the widgets canvas/input.js hands the whole gesture
    // to, so a drag here turns the model and does not move the card.
    dragging = e.pointerId;
    last = { x: e.clientX, y: e.clientY };
    stage.setPointerCapture(e.pointerId);
    stage.classList.add('is-turning');
  });

  stage.addEventListener('pointermove', e => {
    if (dragging !== e.pointerId || !last) return;
    view.yaw += (e.clientX - last.x) * 0.01;
    // Stopped just short of the poles: at exactly straight down the up vector
    // and the view direction are parallel and the camera has no idea which way
    // is which, so the model flips.
    view.pitch = clamp(view.pitch + (e.clientY - last.y) * 0.01, -1.5, 1.5);
    last = { x: e.clientX, y: e.clientY };
    paint();
  });

  const stop = e => {
    if (dragging !== e.pointerId) return;
    dragging = 0; last = null;
    stage.classList.remove('is-turning');
  };
  stage.addEventListener('pointerup', stop);
  stage.addEventListener('pointercancel', stop);

  // Wheel zooms the model inside its card rather than the board, but only
  // while the pointer is actually over the canvas - and the board's own zoom
  // has to be told to keep its hands off, or one gesture would do both.
  stage.addEventListener('wheel', e => {
    e.preventDefault();
    e.stopPropagation();
    view.zoom = clamp(view.zoom * Math.exp(-e.deltaY * 0.001), 0.35, 6);
    paint();
  }, { passive: false });
}

const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);

// ---------------------------------------------------------------------------
// The draw
// ---------------------------------------------------------------------------

function drawInto(stage, mesh, view) {
  const box = stage.getBoundingClientRect();
  if (!box.width || !box.height) return;
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  const w = Math.max(1, Math.min(Math.round(box.width * dpr), MAX_BUFFER));
  const h = Math.max(1, Math.min(Math.round(box.height * dpr), MAX_BUFFER));

  if (stage.width !== w || stage.height !== h) { stage.width = w; stage.height = h; }

  const ctx = stage.getContext('2d');
  ctx.clearRect(0, 0, w, h);
  if (!renderShared(mesh, view, w, h, getComputedStyle(stage).color)) return;
  ctx.drawImage(glCanvas, 0, 0, w, h, 0, 0, w, h);
}

/** Draw the mesh into the shared canvas at w x h. False if WebGL is unavailable. */
function renderShared(mesh, view, w, h, cssColor) {
  if (!ensureGL() || !ensureProgram()) return false;
  if (glCanvas.width !== w || glCanvas.height !== h) {
    glCanvas.width = w;
    glCanvas.height = h;
  }
  gl.viewport(0, 0, w, h);
  gl.clearColor(0, 0, 0, 0);
  gl.enable(gl.DEPTH_TEST);
  // No face culling: a scanned or printed STL is frequently wound
  // inconsistently, and culling turns those faces into holes. The shader
  // handles the wrong-facing ones instead.
  gl.disable(gl.CULL_FACE);
  gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
  gl.useProgram(program);

  if (buffers.of !== mesh) {
    gl.bindBuffer(gl.ARRAY_BUFFER, buffers.pos);
    gl.bufferData(gl.ARRAY_BUFFER, mesh.positions, gl.STATIC_DRAW);
    gl.bindBuffer(gl.ARRAY_BUFFER, buffers.normal);
    gl.bufferData(gl.ARRAY_BUFFER, mesh.normals, gl.STATIC_DRAW);
    if (mesh.colors) {
      gl.bindBuffer(gl.ARRAY_BUFFER, buffers.color);
      gl.bufferData(gl.ARRAY_BUFFER, mesh.colors, gl.STATIC_DRAW);
    }
    buffers.of = mesh;
  }
  gl.bindBuffer(gl.ARRAY_BUFFER, buffers.pos);
  gl.enableVertexAttribArray(attribs.pos);
  gl.vertexAttribPointer(attribs.pos, 3, gl.FLOAT, false, 0, 0);
  gl.bindBuffer(gl.ARRAY_BUFFER, buffers.normal);
  gl.enableVertexAttribArray(attribs.normal);
  gl.vertexAttribPointer(attribs.normal, 3, gl.FLOAT, false, 0, 0);
  // An uncoloured mesh gets a constant attribute rather than a buffer full of
  // the same three numbers: one call instead of a megabyte of white, and it
  // means an STL costs nothing for a feature only OBJ has. The array has to be
  // *disabled* for the constant to be read at all - a stale enabled pointer
  // from the last mesh would otherwise still be feeding this one.
  if (mesh.colors) {
    gl.bindBuffer(gl.ARRAY_BUFFER, buffers.color);
    gl.enableVertexAttribArray(attribs.color);
    gl.vertexAttribPointer(attribs.color, 3, gl.FLOAT, false, 0, 0);
  } else {
    gl.disableVertexAttribArray(attribs.color);
    gl.vertexAttrib3f(attribs.color, 1, 1, 1);
  }

  const { min, max } = mesh.bounds;
  const centre = [(min[0] + max[0]) / 2, (min[1] + max[1]) / 2, (min[2] + max[2]) / 2];
  const radius = Math.max(1e-6, Math.hypot(max[0] - min[0], max[1] - min[1], max[2] - min[2]) / 2);
  // Framed from the model's own size, so a 3mm screw and a 3m bridge both
  // arrive filling the card. 2.4 radii back gives a little air around it at a
  // 45 degree field.
  const dist = (radius * 2.4) / view.zoom;

  gl.uniformMatrix4fv(uniforms.proj, false,
    perspective(0.79, w / h, radius * 0.02, dist + radius * 4));
  gl.uniformMatrix4fv(uniforms.view, false, orbitView(centre, dist, view.yaw, view.pitch));
  gl.uniform3fv(uniforms.color, rgbOf(cssColor));
  gl.uniform1f(uniforms.ownColor, mesh.colors ? 1 : 0);

  gl.drawArrays(gl.TRIANGLES, 0, mesh.count);
  return true;
}

/** `rgb(r, g, b)` from getComputedStyle, as three floats. */
function rgbOf(css) {
  const n = css.match(/[\d.]+/g);
  if (!n || n.length < 3) return [0.42, 0.36, 0.31];
  // Nudged towards mid grey: a token meant for text on paper is nearly black,
  // and a nearly black model shows no shading at all.
  return [0, 1, 2].map(i => Math.min(1, (+n[i] / 255) * 0.5 + 0.42));
}

function perspective(fovy, aspect, near, far) {
  const f = 1 / Math.tan(fovy / 2);
  const d = near - far;
  return new Float32Array([
    f / aspect, 0, 0, 0,
    0, f, 0, 0,
    0, 0, (far + near) / d, -1,
    0, 0, (2 * far * near) / d, 0,
  ]);
}

/**
 * A camera at (yaw, pitch, dist) around `centre`, looking back at it.
 *
 * Written out rather than composed from a lookAt: the eye is on a sphere, so
 * its basis vectors fall straight out of the two angles.
 *
 * Exported for the tests, which is the whole reason the mirroring below is
 * caught now and was not before. Nothing else in the file is reachable from
 * node - it is all WebGL calls on a context that does not exist there - and a
 * matrix is the one part of a renderer that can be checked by arithmetic rather
 * than by looking at a picture and deciding it seems about right.
 */
export function orbitView(centre, dist, yaw, pitch) {
  const cp = Math.cos(pitch), sp = Math.sin(pitch);
  const cy = Math.cos(yaw), sy = Math.sin(yaw);
  // Forward: from the eye towards the centre.
  //
  // Both signs here are the drag convention rather than free choices, and both
  // were wrong in the opposite direction. You are turning the object, not
  // flying a camera around it: swipe right and its front face goes right, pull
  // down and its top comes over towards you. That means the *camera* goes the
  // other way in both axes, which is what these two negations buy.
  const fx = cp * sy, fy = -sp, fz = -cp * cy;
  // Right and up, orthonormal with it by construction.
  //
  // up is r x f, and the order matters: f x r is the same axis negated, and
  // both are perpendicular to the forward direction, so "orthonormal by
  // construction" is true of the wrong one too. It was the wrong one - at
  // pitch 0 it came out (0, -1, 0), a camera whose up points at the floor.
  //
  // That does not render upside down, which is why it survived a look: (r, -u,
  // -f) is left-handed, so the picture was *mirrored* down the vertical. On a
  // roughly symmetric part that reads as nothing much until you notice the
  // model turns the wrong way under the pointer.
  const rx = cy, ry = 0, rz = sy;
  const ux = sp * sy, uy = cp, uz = -sp * cy;
  const ex = centre[0] - fx * dist, ey = centre[1] - fy * dist, ez = centre[2] - fz * dist;
  return new Float32Array([
    rx, ux, -fx, 0,
    ry, uy, -fy, 0,
    rz, uz, -fz, 0,
    -(rx * ex + ry * ey + rz * ez),
    -(ux * ex + uy * ey + uz * ez),
    fx * ex + fy * ey + fz * ez,
    1,
  ]);
}
