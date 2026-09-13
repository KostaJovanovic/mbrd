// 3D model cards. mesh.ts parses geometry; this draws it and lets you turn it.
// One shared offscreen WebGL context, blitted into each card's 2D canvas — browsers
// kill contexts past ~16, so per-card contexts die as you pan. Cards show a still
// (WebP snapshot) by default; live geometry only while actively turning.

import { clamp } from '../util.ts';
import { addFile, allAssets, assetURL, derivedFile, getAsset, readText } from '../storage/assets.ts';
import { surface, surfaceToBlob } from './surface.ts';
import { applyMaterials, meshKind, readModel, parseMTL, MeshError } from '../mesh.ts';
import { lift, isOversize } from '../consent.ts';
import type { Mesh } from '../mesh.ts';
import { makeThumb } from '../optimize/picture.ts';
import { board, bus, byId, selection, setItemThumb, setModelShot } from '../state.ts';
import type { Item } from '../board-model.ts';

/** Where a model is being looked at from: two angles and a distance. */
type View = { yaw: number; pitch: number; zoom: number };

// Cards actively being rotated. Runtime-only — not persisted in .mbrd.
const turning = new Set<string>();

// Max drawing buffer edge — past this, the model is upscaled.
const MAX_BUFFER = 1024;

// Still snapshot long-edge range. SHOT_MAX = MAX_BUFFER so the still is
// exactly as sharp as the live render — no ceiling where live GL takes over.
const SHOT_MIN = 320;
const SHOT_MAX = MAX_BUFFER;

// How much a still may lag behind the card size before retaking on mount.
const SHOT_SLACK = 1.35;

// Shared WebGL context, built on first use.
let gl: WebGLRenderingContext | null = null;
let glCanvas: HTMLCanvasElement | null = null;
let program: WebGLProgram | null = null;
// `of` tracks which mesh the buffers currently hold.
let buffers: {
  pos: WebGLBuffer | null;
  normal: WebGLBuffer | null;
  color: WebGLBuffer | null;
  of: Mesh | null;
} | null = null;
let attribs: { pos: number; normal: number; color: number } | null = null;
let uniforms: {
  proj: WebGLUniformLocation | null;
  view: WebGLUniformLocation | null;
  color: WebGLUniformLocation | null;
  ownColor: WebGLUniformLocation | null;
} | null = null;
let contextDead = false;

// Parsed meshes by asset hash, LRU-evicted past the cap.
const meshes = new Map<string, Mesh>();
const MESH_CACHE_MAX = 12;

// Camera distance in bounding-sphere radii. Fixed so stills are a rigid scale
// of the live render — framing is done by the lens (see frame()), not distance.
const STANDOFF = 2.73;

// Margin around the model in the frame. 1 = edge-to-edge.
const FIT_MARGIN = 1.12;

// Bounding-sphere radius per mesh (max vertex distance from centre). Rotation-
// invariant so the model holds size while turning. Cached — vertex scan is O(n).
const radii = new WeakMap<Mesh, number>();

export function modelRadius(mesh: Mesh): number {
  const held = radii.get(mesh);
  if (held !== undefined) return held;
  const { min, max } = mesh.bounds;
  const cx = (min[0] + max[0]) / 2, cy = (min[1] + max[1]) / 2, cz = (min[2] + max[2]) / 2;
  let furthest = 0;
  const p = mesh.positions;
  for (let i = 0; i + 2 < p.length; i += 3) {
    const dx = p[i] - cx, dy = p[i + 1] - cy, dz = p[i + 2] - cz;
    const d = dx * dx + dy * dy + dz * dz;
    if (d > furthest) furthest = d;
  }
  const box = Math.hypot(max[0] - min[0], max[1] - min[1], max[2] - min[2]) / 2;
  const radius = Math.max(1e-6, furthest ? Math.sqrt(furthest) : box);
  radii.set(mesh, radius);
  return radius;
}

export type Framing = {
  dist: number;
  tan: number;
  scale: number;
  fov: number;
};

// Compute camera framing. Angle-independent — model holds size while turning.
export function frame(radius: number, zoom: number, w: number, h: number): Framing {
  const dist = radius * STANDOFF;
  // Exact sphere silhouette tangent, not the naive radius/dist ratio.
  const tan = radius / Math.sqrt(Math.max(dist * dist - radius * radius, 1e-12));
  const wheel = Number.isFinite(zoom) && zoom > 0 ? zoom : 1;
  const scale = (Math.min(w, h) / (2 * tan * FIT_MARGIN)) * wheel;
  return { dist, tan, scale, fov: 2 * Math.atan(h / (2 * scale)) };
}

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
  // No inverse transpose needed — view matrix has no scale.
  vNormal = mat3(uView) * aNormal;
  vColor = aColor;
  gl_Position = uProj * eye;
}`;

// Key + fill lights. Backfaces lit via flipped normal (STLs often have bad winding).
// uOwnColor mixes between the model's own colours and the board palette.
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
  // Rim light for silhouette edge visibility.
  float rim = pow(1.0 - max(dot(n, normalize(-vEye)), 0.0), 2.5);
  float light = 0.26 + key * 0.72 + fill * 0.18 + rim * 0.22;
  gl_FragColor = vec4(mix(uColor, vColor, uOwnColor) * light, 1.0);
}`;

function ensureGL(): WebGLRenderingContext | null {
  if (gl || contextDead) return gl;
  glCanvas = document.createElement('canvas');
  glCanvas.width = glCanvas.height = 300;
  gl = glCanvas.getContext('webgl', {
    alpha: true,
    antialias: true,
    depth: true,
    preserveDrawingBuffer: false,
    powerPreference: 'low-power',
  });
  if (!gl) { contextDead = true; return null; }

  // Context loss (driver reset, GPU switch) — drop state, rebuild on restore.
  glCanvas.addEventListener('webglcontextlost', e => {
    e.preventDefault();
    program = null; buffers = null;
  });
  glCanvas.addEventListener('webglcontextrestored', () => { program = null; buffers = null; });

  return gl;
}

function ensureProgram(gl: WebGLRenderingContext): WebGLProgram | null {
  if (program) return program;
  const vs = compile(gl, gl.VERTEX_SHADER, VERT);
  const fs = compile(gl, gl.FRAGMENT_SHADER, FRAG);
  if (!vs || !fs) { contextDead = true; return null; }
  const p = gl.createProgram();
  if (!p) { contextDead = true; return null; }
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

function compile(gl: WebGLRenderingContext, kind: number, src: string): WebGLShader | null {
  const s = gl.createShader(kind);
  if (!s) return null;
  gl.shaderSource(s, src);
  gl.compileShader(s);
  return gl.getShaderParameter(s, gl.COMPILE_STATUS) ? s : null;
}

// ---------------------------------------------------------------------------
// The card
// ---------------------------------------------------------------------------

// Build a model card. Mesh is loaded lazily — shows a loading note until ready.
export function buildModelCard(item: Item) {
  const card = document.createElement('div');
  card.className = 'card card-model';

  // Fast path: show the still snapshot as a plain <img>.
  const still = stillFor(item);
  if (still) {
    card.classList.add('is-loaded', 'is-still');
    const img = document.createElement('img');
    img.className = 'model-still';
    img.src = still;
    img.alt = item.name || 'model';
    img.draggable = false;
    // Check if the still is too small or wrong shape — retake if needed.
    img.addEventListener('load', () => {
      const it = byId(item.id);
      if (!it || it.type !== 'model') return;
      const long = Math.max(img.naturalWidth, img.naturalHeight);
      const shape = img.naturalHeight ? img.naturalWidth / img.naturalHeight : 1;
      const wanted = stageShape(it.id);
      const fits = wanted === null || Math.abs(shape / wanted - 1) < 0.02;
      if (long >= shotEdge(it) / SHOT_SLACK && fits) return;
      if (shotSize.get(it.id) === sizeOf(it)) return;
      shotSize.set(it.id, sizeOf(it));
      takeShot(it.id).catch(() => {});
    }, { once: true });
    const name = document.createElement('div');
    name.className = 'card-name';
    name.textContent = item.name || 'model';
    // Zoomed-out thumbnail twin — must be adjacent sibling for CSS combinator.
    const thumbHash = item.meta?.thumb;
    const thumb = typeof thumbHash === 'string' && thumbHash ? assetURL(thumbHash) : null;
    if (!thumb) {
      card.append(img, name);
      return card;
    }
    const small = document.createElement('img');
    small.className = 'still model-still';
    small.alt = '';
    small.decoding = 'async';
    small.draggable = false;
    small.addEventListener('load', () => small.classList.add('is-ready'), { once: true });
    small.src = thumb;
    card.append(img, small, name);
    return card;
  }

  const stage = document.createElement('canvas');
  stage.className = 'model-stage';
  // CSS resolves the token to rgb() for getComputedStyle.
  stage.style.color = 'var(--ink-2)';

  const note = document.createElement('div');
  note.className = 'model-note';
  note.textContent = 'reading…';

  const name = document.createElement('div');
  name.className = 'card-name';
  name.textContent = item.name || 'model';

  card.append(stage, note, name);

  const view = liveView(item);
  let mesh: Mesh | null = null;

  const paint = () => {
    if (!mesh) return;
    drawInto(stage, mesh, view);
  };

  const ro = new ResizeObserver(() => { stageBox.delete(stage); paint(); });
  ro.observe(stage);
  // Stored for releaseModels() to disconnect — prevents mesh leak via closure.
  // SAFETY: stage is the canvas made above, and StageCanvas only adds the optional _modelRO.
  (stage as StageCanvas)._modelRO = ro;

  orbit(stage, view, paint);

  load(item).then(m => {
    mesh = m;
    note.remove();
    card.classList.add('is-loaded');
    paint();
    if (!turning.has(item.id)) takeShot(item.id).catch(() => {});
  }).catch(err => {
    note.textContent = isOversize(err) ? err.what
      : err instanceof MeshError ? err.message
      : 'This model could not be read';
    note.classList.add('is-error');
    stage.remove();
  });

  return card;
}

async function load(item: Item): Promise<Mesh> {
  const hash = item.asset?.hash;
  if (!hash) throw new MeshError('This model has no file behind it');
  // Keyed by hash + up-axis: flipping rewrites points in place.
  const key = `${hash}:${item.meta?.upAxis === 'y' ? 'y' : item.meta?.upAxis === 'z' ? 'z' : '-'}`;
  const hit = meshes.get(key);
  if (hit) {
    // Re-insert to keep LRU ordering.
    meshes.delete(key);
    meshes.set(key, hit);
    return hit;
  }

  const asset = getAsset(hash);
  if (!asset) throw new MeshError('This model is missing its file');
  const kind = meshKind(asset.name || item.name || '');
  if (!kind) throw new MeshError('This is not a model file');

  // On ceiling hit, ask the user and re-read with lift if accepted.
  const buf = await asset.blob.arrayBuffer();
  const name = asset.name || item.name || 'This model';
  let mesh: Mesh;
  try {
    mesh = await readModel(kind, buf, item.meta?.upAxis);
  } catch (err) {
    if (!await lift(err, `mesh:${hash}`, name, 'Open it')) throw err;
    mesh = await readModel(kind, buf, item.meta?.upAxis, true);
  }
  await paint(mesh);
  meshes.set(key, mesh);
  while (meshes.size > MESH_CACHE_MAX) meshes.delete(meshes.keys().next().value!);
  return mesh;
}

// Apply OBJ .mtl colours if the library was dropped alongside the model.
// Matched on basename only, case-insensitive. Silent when not found.
async function paint(mesh: Mesh) {
  if (!mesh.mtllib || mesh.colors) return;
  const want = mesh.mtllib.replace(/\\/g, '/').split('/').pop()!.toLowerCase();
  if (!want) return;
  for (const [hash, a] of allAssets()) {
    if ((a.name || '').toLowerCase() !== want) continue;
    try {
      applyMaterials(mesh, parseMTL(await readText(hash, MTL_MAX)));
    } catch { /* an unreadable library is a model without colours */ }
    return;
  }
}

const MTL_MAX = 256 * 1024;

type StageCanvas = HTMLCanvasElement & { _modelRO?: ResizeObserver };

// Disconnect ResizeObservers on model stages inside el — prevents mesh leaks.
export function releaseModels(el: Element): void {
  for (const stage of el.querySelectorAll<StageCanvas>('canvas.model-stage')) {
    stage._modelRO?.disconnect();
    stage._modelRO = undefined;
  }
}

// Drop all cached meshes — board replaced.
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

const views = new Map<string, View>();

const DEFAULT_VIEW: View = { yaw: 0.6, pitch: 0.5, zoom: 1 };

// Get or create the live view for an item. Mutated by orbit() in place.
function liveView(item: Item): View {
  const held = views.get(item.id);
  if (held) return held;
  const m = item.meta?.view;
  // SAFETY: the same test makes m a non-null object, and each field is read through Number().
  const raw = m && typeof m === 'object' ? m as Record<string, unknown> : null;
  const view = raw
    ? { yaw: Number(raw.yaw) || 0, pitch: Number(raw.pitch) || 0, zoom: Number(raw.zoom) || 1 }
    : { ...DEFAULT_VIEW };
  views.set(item.id, view);
  return view;
}

// Still URL, or null if turning / no still / palette changed.
function stillFor(item: Item): string | null {
  if (turning.has(item.id)) return null;
  const hash = item.meta?.shot;
  if (typeof hash !== 'string' || !hash) return null;
  // Uncoloured models are drawn in board ink — palette change stales the still.
  const ink = item.meta.shotInk;
  if (ink && ink !== boardInk()) return null;
  return assetURL(hash);
}

// Still long edge, clamped to [SHOT_MIN, SHOT_MAX], from item world size.
const shotEdge = (item: Item) =>
  clamp(Math.round(Math.max(+item.w || 0, +item.h || 0)), SHOT_MIN, SHOT_MAX);

// Resolved --ink-2 colour, cached to avoid layout flush per card.
let ink: string | null = null;

function boardInk(): string {
  if (ink) return ink;
  const probe = document.createElement('div');
  probe.style.cssText = 'position:absolute;visibility:hidden;color:var(--ink-2)';
  document.body.append(probe);
  ink = getComputedStyle(probe).color;
  probe.remove();
  return ink;
}

// Invalidate cached ink on palette change.
export function resetModelInk() {
  ink = null;
}

// Switch card to live geometry. Reverts to still on deselection.
export function rotateModel(id: string) {
  const it = byId(id);
  if (!it || it.type !== 'model') return;
  turning.add(id);
  bus.emit('item', id);
}

export const isTurning = (id: string) => turning.has(id);

// Stage aspect ratio (w/h). Reads layout box, not client rect — cards are tilted.
// Null when unmounted (culled off-screen).
function stageShape(id: string): number | null {
  const card = document.querySelector(`.item[data-id="${CSS.escape(id)}"] .card-model`);
  const box = card?.querySelector('canvas.model-stage, img.model-still');
  if (!(box instanceof HTMLElement) || !box.clientWidth || !box.clientHeight) return null;
  return clamp(box.clientWidth / box.clientHeight, 0.2, 5);
}

// Snapshot the model as a WebP still. Silent on failure — card stays live.
async function takeShot(id: string): Promise<boolean> {
  const item = byId(id);
  if (!item || item.type !== 'model') return false;
  const mesh = await load(item);

  const ink = boardInk();
  const view = liveView(item);

  // Shaped to the stage box, not the card — falls back to square if unmounted.
  const shape = stageShape(id) ?? 1;
  const edge = shotEdge(item);
  const w = shape >= 1 ? edge : Math.max(1, Math.round(edge * shape));
  const h = shape >= 1 ? Math.max(1, Math.round(edge / shape)) : edge;

  if (!renderShared(mesh, view, w, h, ink)) return false;

  // Copy from shared GL buffer before the next draw overwrites it.
  const flat = surface(w, h);
  if (!flat) return false;
  flat.ctx.drawImage(glCanvas!, 0, 0, w, h, 0, 0, w, h);
  // No JPEG fallback — model stills need transparency over the paper.
  const blob = await surfaceToBlob(flat, 'image/webp', 0.9);
  if (!blob) return false;

  const hash = await addFile(derivedFile(blob, `${id}-still`));
  shotSize.set(id, sizeOf(item));
  setModelShot(id, { hash, ink: mesh.colors ? '' : ink, view });
  cutThumb(id, blob, w).catch(() => {});
  return true;
}

// Zoomed-out thumbnail from the still, via makeThumb().
async function cutThumb(id: string, still: Blob, width: number) {
  const small = await makeThumb(still, width);
  if (!small) return;
  setItemThumb(id, await addFile(derivedFile(small.blob, `${id}-thumb`)));
}

// On deselection: stop turning, take a still.
bus.on('selection', () => {
  for (const id of [...turning]) {
    if (selection.has(id)) continue;
    turning.delete(id);
    takeShot(id).catch(() => {})
      .finally(() => bus.emit('item', id));
  }
});

// Palette change invalidates uncoloured model stills — they redraw on next mount.
bus.on('settings', key => {
  if (key !== 'appearance') return;
  resetModelInk();
  for (const it of board.items) {
    if (it.type === 'model' && it.meta?.shotInk) bus.emit('item', it.id);
  }
});

// ---------------------------------------------------------------------------
// Resize
// ---------------------------------------------------------------------------

// Last-photographed size per card — distinguishes move from resize in 'geom'.
const shotSize = new Map<string, string>();
const sizeOf = (item: Item) => `${Math.round(+item.w || 0)}x${Math.round(+item.h || 0)}`;

const pending = new Map<string, ReturnType<typeof setTimeout>>();
const RESIZE_QUIET_MS = 260;

// Debounced retake on resize — 'geom' fires every drag frame.
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
      takeShot(id).catch(() => {});
    }, RESIZE_QUIET_MS));
  }
});

// Clean up per-item state on deletion to prevent leaks.
bus.on('items', delta => {
  for (const id of delta?.removed || []) {
    views.delete(id);
    shotSize.delete(id);
  }
});

// ---------------------------------------------------------------------------
// Turning it over
// ---------------------------------------------------------------------------

function orbit(stage: HTMLCanvasElement, view: View, paint: () => void) {
  let dragging = 0;
  let last: { x: number; y: number } | null = null;

  stage.addEventListener('pointerdown', e => {
    dragging = e.pointerId;
    last = { x: e.clientX, y: e.clientY };
    stage.setPointerCapture(e.pointerId);
    stage.classList.add('is-turning');
  });

  stage.addEventListener('pointermove', e => {
    if (dragging !== e.pointerId || !last) return;
    view.yaw += (e.clientX - last.x) * 0.01;
    // Clamped short of poles to avoid gimbal flip.
    view.pitch = clamp(view.pitch + (e.clientY - last.y) * 0.01, -1.5, 1.5);
    last = { x: e.clientX, y: e.clientY };
    paint();
  });

  const stop = (e: PointerEvent) => {
    if (dragging !== e.pointerId) return;
    dragging = 0; last = null;
    stage.classList.remove('is-turning');
  };
  stage.addEventListener('pointerup', stop);
  stage.addEventListener('pointercancel', stop);

  // Wheel zooms the model, not the board — stopPropagation prevents both.
  stage.addEventListener('wheel', e => {
    e.preventDefault();
    e.stopPropagation();
    view.zoom = clamp(view.zoom * Math.exp(-e.deltaY * 0.001), 0.35, 6);
    paint();
  }, { passive: false });
}

// ---------------------------------------------------------------------------
// The draw
// ---------------------------------------------------------------------------

// Cached layout box + 2d context per stage. Layout box, not client rect —
// cards are tilted and getBoundingClientRect returns the wrong shape.
type Box = { w: number; h: number };
const stageBox = new WeakMap<HTMLCanvasElement, Box>();
const stageCtx = new WeakMap<HTMLCanvasElement, CanvasRenderingContext2D>();

function drawInto(stage: HTMLCanvasElement, mesh: Mesh, view: View) {
  let box = stageBox.get(stage);
  if (!box) { box = { w: stage.clientWidth, h: stage.clientHeight }; stageBox.set(stage, box); }
  if (!box.w || !box.h) return;
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  // Single scale factor — clamping axes separately distorts the aspect.
  const scale = Math.min(1, MAX_BUFFER / Math.max(box.w * dpr, box.h * dpr));
  const w = Math.max(1, Math.round(box.w * dpr * scale));
  const h = Math.max(1, Math.round(box.h * dpr * scale));

  if (stage.width !== w || stage.height !== h) { stage.width = w; stage.height = h; }

  let ctx = stageCtx.get(stage);
  if (!ctx) { ctx = stage.getContext('2d')!; stageCtx.set(stage, ctx); }
  ctx.clearRect(0, 0, w, h);
  if (!renderShared(mesh, view, w, h, boardInk())) return;
  ctx.drawImage(glCanvas!, 0, 0, w, h, 0, 0, w, h);
}

function renderShared(mesh: Mesh, view: View, w: number, h: number, cssColor: string): boolean {
  const gl = ensureGL();
  if (!gl) return false;
  const prog = ensureProgram(gl);
  if (!prog) return false;
  const canvas = glCanvas!, bufs = buffers!, attr = attribs!, uni = uniforms!;
  if (canvas.width !== w || canvas.height !== h) {
    canvas.width = w;
    canvas.height = h;
  }
  gl.viewport(0, 0, w, h);
  gl.clearColor(0, 0, 0, 0);
  gl.enable(gl.DEPTH_TEST);
  // No culling — STLs often have inconsistent winding.
  gl.disable(gl.CULL_FACE);
  gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
  gl.useProgram(prog);

  if (bufs.of !== mesh) {
    gl.bindBuffer(gl.ARRAY_BUFFER, bufs.pos);
    gl.bufferData(gl.ARRAY_BUFFER, mesh.positions, gl.STATIC_DRAW);
    gl.bindBuffer(gl.ARRAY_BUFFER, bufs.normal);
    gl.bufferData(gl.ARRAY_BUFFER, mesh.normals, gl.STATIC_DRAW);
    if (mesh.colors) {
      gl.bindBuffer(gl.ARRAY_BUFFER, bufs.color);
      gl.bufferData(gl.ARRAY_BUFFER, mesh.colors, gl.STATIC_DRAW);
    }
    bufs.of = mesh;
  }
  gl.bindBuffer(gl.ARRAY_BUFFER, bufs.pos);
  gl.enableVertexAttribArray(attr.pos);
  gl.vertexAttribPointer(attr.pos, 3, gl.FLOAT, false, 0, 0);
  gl.bindBuffer(gl.ARRAY_BUFFER, bufs.normal);
  gl.enableVertexAttribArray(attr.normal);
  gl.vertexAttribPointer(attr.normal, 3, gl.FLOAT, false, 0, 0);
  // Constant attribute for uncoloured meshes — disable array for it to take.
  if (mesh.colors) {
    gl.bindBuffer(gl.ARRAY_BUFFER, bufs.color);
    gl.enableVertexAttribArray(attr.color);
    gl.vertexAttribPointer(attr.color, 3, gl.FLOAT, false, 0, 0);
  } else {
    gl.disableVertexAttribArray(attr.color);
    gl.vertexAttrib3f(attr.color, 1, 1, 1);
  }

  const { min, max } = mesh.bounds;
  const centre = [(min[0] + max[0]) / 2, (min[1] + max[1]) / 2, (min[2] + max[2]) / 2];
  const radius = modelRadius(mesh);
  const { dist, fov } = frame(radius, view.zoom, w, h);

  gl.uniformMatrix4fv(uni.proj, false,
    perspective(fov, w / h, radius * 0.02, dist + radius * 4));
  gl.uniformMatrix4fv(uni.view, false, orbitView(centre, dist, view.yaw, view.pitch));
  gl.uniform3fv(uni.color, rgbOf(cssColor));
  gl.uniform1f(uni.ownColor, mesh.colors ? 1 : 0);

  gl.drawArrays(gl.TRIANGLES, 0, mesh.count);
  return true;
}

// Parse rgb()/rgba() to [0–1] floats. Anchored on rgb( — a wide-gamut form
// like color(display-p3 ...) falls back to default clay.
function rgbOf(css: string): number[] {
  const m = css.match(/^\s*rgba?\(([^)]*)\)/i);
  const n = m && !m[1].includes('%') ? m[1].match(/[\d.]+/g) : null;
  if (!n || n.length < 3) return [0.42, 0.36, 0.31];
  // Nudged towards mid grey — ink tokens are too dark to shade well.
  return [0, 1, 2].map(i => Math.min(1, (+n[i] / 255) * 0.5 + 0.42));
}

function perspective(fovy: number, aspect: number, near: number, far: number): Float32Array {
  const f = 1 / Math.tan(fovy / 2);
  const d = near - far;
  return new Float32Array([
    f / aspect, 0, 0, 0,
    0, f, 0, 0,
    0, 0, (far + near) / d, -1,
    0, 0, (2 * far * near) / d, 0,
  ]);
}

// Orbit camera view matrix. Exported for tests — the only testable part without GL.
export function orbitView(centre: number[], dist: number, yaw: number, pitch: number): Float32Array {
  const cp = Math.cos(pitch), sp = Math.sin(pitch);
  const cy = Math.cos(yaw), sy = Math.sin(yaw);
  // Signs give "turn the object" drag convention, not "fly the camera".
  const fx = cp * sy, fy = -sp, fz = -cp * cy;
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
