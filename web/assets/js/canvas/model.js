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

import { addFile, allAssets, assetURL, getAsset, readText } from '../storage/assets.js';
import { applyMaterials, meshKind, parseMesh, parseMTL, MeshError } from '../import/mesh.js';
import { board, bus, byId, selection, setModelShot } from '../state.js';

/**
 * A model card is a photograph until you ask it to be a model.
 *
 * Every card holding live geometry costs a blit from the shared context on
 * every resize, every palette change and every redraw, and a board is mostly
 * models sitting still. So a card that is not being turned shows a still - a
 * WebP taken the last time anybody moved it - and the geometry is only loaded,
 * parsed and drawn for the one card you asked to rotate.
 *
 * Held as a runtime Set rather than a field on the item, deliberately: which
 * card you happen to be turning right now is not a property of the board, and
 * saving it would mean a .mbrd could arrive with a card already spinning.
 */
const turning = new Set();

/** The still's long edge, in device pixels. */
const SHOT_MAX = 450;

/**
 * How much bigger than its still a card has to be drawn before the still stops
 * being good enough. Below this it is indistinguishable; above it, the card
 * goes back to live geometry rather than showing somebody a soft picture.
 */
const SHOT_SLACK = 1.35;

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

/** Vertical field of view, in radians. About 45 degrees. */
const FOV = 0.79;

/**
 * How much of the frame the model's bounding sphere is allowed to fill.
 *
 * 1 is an exact fit and touches the edge on every side. The sphere is the
 * *diagonal* of the bounding box, so a model rarely reaches it - but a cube
 * seen corner-on does, and that is the one that came out clipped.
 */
const FIT_MARGIN = 1.12;

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

  // The cheap path, and the one nearly every card takes: a picture of the
  // model, taken the last time it was turned. No geometry parsed, no context
  // touched, no redraw on resize - it is an <img>, and the browser has been
  // scaling those well for thirty years.
  const still = stillFor(item);
  if (still) {
    card.classList.add('is-loaded', 'is-still');
    const img = document.createElement('img');
    img.className = 'model-still';
    img.src = still;
    img.alt = item.name || 'model';
    img.draggable = false;
    const name = document.createElement('div');
    name.className = 'card-name';
    name.textContent = item.name || 'model';
    card.append(img, name);
    return card;
  }

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

  // One view object per item, shared with orbit() and with the snapshot below,
  // so the picture is taken from the angle that is actually on screen rather
  // than from whatever was last written to the item.
  const view = liveView(item);
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
    // A model nobody has asked to turn gets its photograph taken as soon as it
    // is on screen, and the card becomes a still. That is what makes this the
    // one-off cost it is meant to be: without it a board of models that have
    // never been rotated stays a board of live WebGL for ever.
    if (!turning.has(item.id)) takeShot(item.id).catch(() => {});
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
export function resetModels() {
  meshes.clear();
  turning.clear();
  views.clear();
  shotSize.clear();
  for (const t of pending.values()) clearTimeout(t);
  pending.clear();
}

// ---------------------------------------------------------------------------
// The still
// ---------------------------------------------------------------------------

/** id -> the live view object, shared between the card and the snapshot. */
const views = new Map();

const DEFAULT_VIEW = { yaw: 0.6, pitch: 0.5, zoom: 1 };

/**
 * The angle this model is being looked at, as one object per item.
 *
 * Seeded from what the board remembers and then mutated in place by orbit(),
 * which is what lets takeShot() photograph the angle actually on screen rather
 * than the one last written down.
 */
function liveView(item) {
  const held = views.get(item.id);
  if (held) return held;
  const m = item.meta?.view;
  const view = m && typeof m === 'object'
    ? { yaw: +m.yaw || 0, pitch: +m.pitch || 0, zoom: +m.zoom || 1 }
    : { ...DEFAULT_VIEW };
  views.set(item.id, view);
  return view;
}

/**
 * The URL of the still to show for this item, or null to draw it live.
 *
 * Null for four different reasons, and each one is a case that would otherwise
 * show somebody the wrong picture: the card is being turned, there is no still
 * yet, the bytes have gone, or the palette has moved since it was taken.
 */
function stillFor(item) {
  if (turning.has(item.id)) return null;
  if (outgrewStill(item)) return null;
  const hash = item.meta?.shot;
  if (!hash) return null;
  // A model with no colours of its own is drawn in the board's ink, so a change
  // of palette leaves its photograph a shade out of date. Models that brought
  // their own colours carry no shotInk and never go stale this way.
  const ink = item.meta.shotInk;
  if (ink && ink !== boardInk()) return null;
  return assetURL(hash);
}

/**
 * A card dragged so much bigger than its still that the picture would show.
 *
 * Measured against the item's own size in world units and not against what is
 * on screen, on purpose: zoom does not rebuild cards, so a rule that read the
 * zoom would be answered once at mount and then be wrong for the rest of the
 * session - and a card that flipped between a photograph and live geometry as
 * you scrolled the wheel would be worse than either.
 *
 * The same test guards the photographing below, which is what stops the two
 * from arguing: a card this size is never given a still it would refuse, and a
 * shot is never taken that nothing would show.
 */
const outgrewStill = item =>
  Math.max(+item.w || 0, +item.h || 0) > SHOT_MAX * SHOT_SLACK;

/**
 * The colour an uncoloured model is shaded in, resolved to plain rgb().
 *
 * Read off a probe rather than off the root's custom property, because
 * getPropertyValue hands back whatever the token literally says - a color-mix,
 * an oklch, an inline override - and none of those compare equal across a
 * palette change that lands on the same colour. `color` is resolved by the
 * engine before getComputedStyle sees it.
 */
function boardInk() {
  const probe = document.createElement('div');
  probe.style.cssText = 'position:absolute;visibility:hidden;color:var(--ink-2)';
  document.body.append(probe);
  const ink = getComputedStyle(probe).color;
  probe.remove();
  return ink;
}

/**
 * Turn this model over by hand. The card swaps to live geometry until it is
 * deselected, and then photographs itself again.
 */
export function rotateModel(id) {
  const it = byId(id);
  if (!it || it.type !== 'model') return;
  turning.add(id);
  bus.emit('item', id);
}

export const isTurning = id => turning.has(id);

/**
 * Photograph a model as it currently sits.
 *
 * At most SHOT_MAX on the long edge, in WebP - which is the whole point of the
 * exercise: a card showing a 40KB picture costs nothing to keep on screen,
 * where a card holding geometry costs a blit from the one shared context every
 * time anything moves.
 *
 * Silent on failure. A model that cannot be photographed - no WebGL, a mesh
 * that will not parse, a browser without WebP - simply keeps drawing itself
 * live, which is what it did before any of this existed.
 */
async function takeShot(id) {
  const item = byId(id);
  if (!item || item.type !== 'model') return false;
  // Nothing would show it - see outgrewStill(). Encoding a WebP for a card that
  // is going to draw itself live anyway is the one cost this whole file exists
  // to avoid paying.
  if (outgrewStill(item)) return false;
  const mesh = await load(item);

  // The card's own proportions, so the still drops straight into the same box
  // without letterboxing. Falls back to square for an item with no size yet.
  const aspect = (+item.w > 0 && +item.h > 0) ? item.w / item.h : 1;
  const w = Math.max(1, Math.round(aspect >= 1 ? SHOT_MAX : SHOT_MAX * aspect));
  const h = Math.max(1, Math.round(aspect >= 1 ? SHOT_MAX / aspect : SHOT_MAX));

  const ink = boardInk();
  const view = liveView(item);
  if (!renderShared(mesh, view, w, h, ink)) return false;

  // Copied off the shared canvas rather than encoded from it: that one is the
  // WebGL drawing buffer and the next card to draw will overwrite it, so the
  // bytes have to be taken now.
  const flat = new OffscreenCanvas(w, h);
  flat.getContext('2d').drawImage(glCanvas, 0, 0, w, h, 0, 0, w, h);
  const blob = await flat.convertToBlob({ type: 'image/webp', quality: 0.9 });
  if (!blob || !/webp/.test(blob.type)) return false;

  const hash = await addFile(new File([blob], `${id}-still.webp`, { type: 'image/webp' }));
  // Recorded before the item is told, so the rebuild this triggers does not read
  // it back as a card that still owes a picture.
  shotSize.set(id, sizeOf(item));
  setModelShot(id, { hash, ink: mesh.colors ? '' : ink, view });
  return true;
}

/**
 * Put the camera down when the card is no longer selected.
 *
 * Deselection is the end of the gesture: you asked to turn it, you turned it,
 * you looked away. Taking the picture on every drag instead would encode a
 * WebP on every frame.
 */
bus.on('selection', () => {
  for (const id of [...turning]) {
    if (selection.has(id)) continue;
    turning.delete(id);
    takeShot(id).catch(() => {})
      // Whether or not the photograph worked, the card has to come back - it is
      // showing live geometry because this set said so.
      .finally(() => bus.emit('item', id));
  }
});

/**
 * A palette change makes every still of an uncoloured model a shade wrong.
 *
 * Not re-photographed here, deliberately - that would parse and draw every
 * model on the board the moment somebody nudged a colour slider. stillFor()
 * simply stops offering the stale one, the card falls back to live geometry,
 * and the load path photographs it again on its way past.
 */
bus.on('settings', key => {
  if (key !== 'appearance') return;
  for (const it of board.items) {
    if (it.type === 'model' && it.meta?.shotInk) bus.emit('item', it.id);
  }
});

// ---------------------------------------------------------------------------
// Resize
// ---------------------------------------------------------------------------

/**
 * The size each model card was last photographed at, so a *move* can be told
 * from a *resize*. 'geom' says both, and the still only goes stale for one of
 * them.
 *
 * Runtime, not saved: it is seeded from the card the first time one is built,
 * so after a reload the first resize retakes the picture whether or not it
 * needed to. One WebP is the right price for not putting a second size field in
 * the file format.
 */
const shotSize = new Map();
const sizeOf = item => `${Math.round(+item.w || 0)}x${Math.round(+item.h || 0)}`;

/** Retakes in flight, so a drag does not queue one per frame. */
const pending = new Map();
const RESIZE_QUIET_MS = 260;

/**
 * A model dragged to a new size is a model whose photograph is the wrong shape:
 * the still is drawn `contain`, so a card made much wider than the shot leaves
 * the model marooned in the middle of it at the old proportions.
 *
 * Waited out rather than answered per frame - 'geom' fires all the way through
 * a drag, and each answer is a mesh parse, a WebGL draw and a WebP encode.
 */
bus.on('geom', ids => {
  for (const id of ids || []) {
    const it = byId(id);
    if (!it || it.type !== 'model' || turning.has(id)) continue;
    if (shotSize.get(id) === sizeOf(it)) continue;
    clearTimeout(pending.get(id));
    pending.set(id, setTimeout(() => {
      pending.delete(id);
      const item = byId(id);
      if (!item || turning.has(id)) return;
      shotSize.set(id, sizeOf(item));
      // Past the point where a still would be shown at all, there is nothing to
      // retake - the card just has to be told to go back to live geometry.
      if (outgrewStill(item)) { bus.emit('item', id); return; }
      takeShot(id).catch(() => {});
    }, RESIZE_QUIET_MS));
  }
});

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
  // arrive filling the card.
  //
  // Backed off far enough that the model's bounding sphere fits the *narrow*
  // axis. The field of view is vertical and the projection widens it by the
  // aspect, so a flat 2.4 radii framed the height and let a card taller than it
  // is wide crop the model at the sides - which is what cut the corner off a
  // model on a portrait card. And 2.4 radii was the exact fit even then: at a
  // 45 degree field the half-height at that distance is one radius, so the
  // sphere touched the edge and any rounding took a pixel off it. FIT_MARGIN is
  // the air around it.
  const fit = Math.min(1, w / h);
  const dist = (radius * FIT_MARGIN) / (Math.tan(FOV / 2) * fit * view.zoom);

  gl.uniformMatrix4fv(uniforms.proj, false,
    perspective(FOV, w / h, radius * 0.02, dist + radius * 4));
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
