// Drawing a 3D model on a card.
//
// mesh.ts turns the bytes into triangles; this puts them on screen and
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
const turning = new Set<string>();

/**
 * The biggest either path is ever asked to draw.
 *
 * A card can be dragged to any size on an infinite board, and the drawing buffer
 * is the one cost that scales with it. Past this the model is drawn at this size
 * and stretched, which on a card that large is a difference nobody looking at a
 * moodboard is going to find.
 */
const MAX_BUFFER = 1024;

/**
 * The still's **long** edge, in pixels - the short one follows the shape of the
 * card's picture area, see stageShape(). Sized to the card rather than fixed,
 * between these two.
 *
 * **SHOT_MAX is MAX_BUFFER, and that identity is the point rather than a
 * coincidence.** The live canvas is clamped to MAX_BUFFER too (see drawInto), so
 * on a card bigger than that the *live* render is being upscaled as well. Tying
 * the two together makes the still exactly as sharp as the geometry it stands in
 * for, at every card size there is - which is what lets the ceiling below this
 * go away entirely.
 *
 * SHOT_MIN is a floor rather than an exact fit, because pixels are cheap and a
 * small card that is later made bigger should not have to be re-photographed to
 * look right.
 *
 * The number used to be a fixed 450, and that same 450 was also a ceiling past
 * which a card gave up on stills and drew live WebGL for the life of the session,
 * re-reading its geometry on every reload - a second of CAD kernel per load, on
 * exactly the cards big enough to be worth looking at. That ceiling has now been
 * hit three times by ordinary use at three different values, which is the board
 * telling us the rule was wrong rather than the number.
 *
 * **So there is no ceiling.** A card is always photographed. The argument for
 * one was "past some size the live geometry is sharper than a picture of it",
 * and MAX_BUFFER makes that false above 1024 - the two are the same pixels. What
 * is left is a still that costs one WebP against a card that costs a WebGL blit
 * on every move, every palette change and every redraw, for ever.
 */
const SHOT_MIN = 320;
const SHOT_MAX = MAX_BUFFER;

/**
 * How much smaller than the card wants it a still may be before it is retaken.
 *
 * Only the repair in buildModelCard() reads this now. A card is resized by
 * dragging, which fires 'geom' and retakes on its own; this is for the still
 * that arrives already wrong - taken by an older build, or under a size the
 * runtime record of has been lost to a reload. Some slack, or every card whose
 * size has drifted by a pixel would re-read its mesh on mount.
 */
const SHOT_SLACK = 1.35;

/** The shared context, built on first use and never torn down. */
let gl: WebGLRenderingContext | null = null;
let glCanvas: HTMLCanvasElement | null = null;
let program: WebGLProgram | null = null;
/** `of` is the mesh the three buffers currently hold - see renderShared(). */
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

/** Parsed meshes, by asset hash: a board of nine views of one part parses once. */
const meshes = new Map<string, Mesh>();

// A board can hold more geometry than a page should keep resident. Least
// recently drawn goes first, and it is re-parsed from the asset bytes if it is
// wanted again, which costs a frame rather than a fetch.
const MESH_CACHE_MAX = 12;

/**
 * How far the camera stands off, in radii of the model's bounding sphere.
 *
 * **Fixed, and that is load-bearing twice over.** It is the same 2.73 radii the
 * old sphere-on-the-narrow-axis rule put the camera at with a 45 degree lens, so
 * the perspective is the one this app has always drawn - but it is now the only
 * thing the camera position depends on. It does not move with the card's shape,
 * with the zoom, or with the angle.
 *
 * That is what makes a still a *rigid scale* of the live render. Perspective
 * foreshortening is a function of distance, so a model photographed from one
 * distance and drawn from another is not the same picture scaled - it is a
 * different picture, and `object-fit: contain` cannot turn one into the other.
 * Framing by moving the camera, which is the obvious way and the way this was
 * first written, breaks the still/live pairing by 8% on an ordinary card. So the
 * camera holds still and the *lens* does the framing - see frame() below.
 *
 * It also means the perspective does not breathe while you turn the model, which
 * a distance that tracked the outline would have done.
 */
const STANDOFF = 2.73;

/**
 * How much of the frame the model is allowed to fill. 1 touches the edge on
 * every side, and the margin is the air around it.
 */
const FIT_MARGIN = 1.12;

/**
 * How big the model is, as one number that does not depend on which way round
 * it is: the furthest any of its points sits from the centre of its box.
 *
 * **A model must not change size as you turn it over**, and that is a hard
 * constraint rather than a preference - a card you are dragging is the one place
 * on the board where the thing under your hand has to hold still. A measurement
 * that cannot change under rotation is a measurement about a *sphere*, so a
 * sphere is what this is. Fitting the silhouette instead fills the card far
 * better and makes the part breathe the whole time you turn it, which was worse
 * than the air it saved.
 *
 * What can be improved is *which* sphere. The one this used was the bounding
 * box's diagonal, and a box diagonal is only the model's own size when the model
 * fills its corners. A turned part, a bracket, a bolt, a body with a curved
 * shell - all of them have empty box corners, and every one was framed as though
 * it were the ball that box would hold. Reading the real vertices instead is
 * exact, never clips (nothing lies outside a sphere that contains every point),
 * and on the STEP assembly this was found on it is 18% tighter, which is 18%
 * less air on every model card at every angle.
 *
 * Cached per mesh, because it is a pass over every vertex - one to two million
 * floats on a large STL - and the answer cannot change: standing a mesh up
 * rewrites its points, but that produces a different Mesh under a different
 * cache key (see load()). A WeakMap so it does not outlive the mesh.
 *
 * Falls back to the box diagonal for a mesh with no positions, which is the
 * empty model and draws nothing anyway.
 */
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

/** What a camera has to be told to draw a model of this size into a w x h box. */
export type Framing = {
  /** Eye to centre. STANDOFF radii, and nothing else. */
  dist: number;
  /** The model's silhouette half-angle at `dist`, as a tangent. */
  tan: number;
  /** Pixels per tangent unit: the framing itself. */
  scale: number;
  /** The vertical field of view, in radians, that puts `scale` on the canvas. */
  fov: number;
};

/**
 * Everything the camera needs, from the model's size and the box it goes in.
 *
 * **Nothing here reads the angle**, which is the whole point: the model is the
 * same size at every yaw and pitch, so turning it over moves it and does not
 * resize it.
 *
 * The camera stands at a fixed distance and the *lens* does the framing. Those
 * could be swapped - backing the camera off is the more obvious way and is what
 * this did for one revision - but they are not interchangeable, because
 * foreshortening is a function of distance. A model photographed from one
 * distance and drawn from another is not the same picture at a different size,
 * it is a different picture, and `object-fit: contain` can only scale. With the
 * eye pinned the still is a rigid scale of the live render by construction, and
 * the two agree for every box shape and size with nothing recorded on either
 * side.
 *
 * `tan` is the exact silhouette of a sphere rather than `radius / dist`: the
 * tangent line from the eye touches the sphere short of its equator, so the
 * naive ratio over-states the silhouette and quietly buys air nobody asked for
 * on top of FIT_MARGIN.
 *
 * The fit is `min(w, h)` - the sphere touches the narrow axis and leaves the
 * long one slack, because a sphere has nothing to say about which axis is which.
 * That slack is the model's remaining air and there is no honest way to spend it
 * without reading the angle.
 */
export function frame(radius: number, zoom: number, w: number, h: number): Framing {
  const dist = radius * STANDOFF;
  // sin of the silhouette half-angle is radius/dist; this is its tangent.
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

function ensureGL(): WebGLRenderingContext | null {
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

/**
 * The context is a parameter rather than the module's own `gl`, and that is the
 * whole of what makes this function's types honest: it may only be called once
 * ensureGL() has answered one, which is a fact about the call and not about the
 * variable. Its one caller asks in that order.
 */
function ensureProgram(gl: WebGLRenderingContext): WebGLProgram | null {
  if (program) return program;
  const vs = compile(gl, gl.VERTEX_SHADER, VERT);
  const fs = compile(gl, gl.FRAGMENT_SHADER, FRAG);
  if (!vs || !fs) { contextDead = true; return null; }
  const p = gl.createProgram();
  // A context that will not mint a program is a dead one, which is the same
  // conclusion the link check below reaches for it - the shape a null `p` used
  // to take the long way round to.
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
  // Same reading as the program above: no shader object, no shader.
  if (!s) return null;
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
export function buildModelCard(item: Item) {
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
    // **Nothing records what a still was taken at**, deliberately - that would
    // be a second size field and a shape field in the file format, kept in step
    // for ever. The picture is its own record, so it is asked once it decodes,
    // and a still that no longer suits the card is replaced.
    //
    // Two ways it can stop suiting. It can be too *small*, which is a card that
    // was made bigger; and it can be the wrong *shape*, which is a card that was
    // reshaped, or a still taken by a build whose shot was square. Both come out
    // of naturalWidth and naturalHeight against what takeShot() would do now.
    //
    // Size only upwards: a card made smaller keeps its bigger still and draws it
    // scaled down, which is what an <img> is good at. Shape in both directions,
    // because a wrong shape is not a soft picture, it is a model at the wrong
    // size next to the live canvas.
    //
    // Self-limiting, which it has to be: a retake is a mesh parse. The new still
    // is taken at exactly this stage's shape and edge, so the second pass through
    // here returns at the first line, and the shotSize entry stops a card whose
    // retake fails from trying again on every mount.
    img.addEventListener('load', () => {
      const it = byId(item.id);
      if (!it || it.type !== 'model') return;
      // The long edge, which is what shotEdge() sets - a stage-shaped still is
      // taller than it is wide as often as not, so reading the width alone would
      // call every portrait shot too small and retake it for ever.
      const long = Math.max(img.naturalWidth, img.naturalHeight);
      const shape = img.naturalHeight ? img.naturalWidth / img.naturalHeight : 1;
      // Null is a card with no box to measure, which is a question this cannot
      // answer rather than a shot that is wrong - retaking on it would replace a
      // good still with a squared-up one.
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
    // The zoomed-out twin, exactly as a photograph carries one: a sibling
    // `<img class="still">` that items.css shows in the primary's place once
    // #world is marked zoomed-out. Immediately after the primary and before the
    // filename, because the rule that hides the primary is written with an
    // adjacent sibling combinator and only looks one element forward.
    //
    // `model-still` as well as `still`, so the twin sits in the box the same way
    // the picture it stands for does - it is the same square photograph at a
    // hundred pixels, and `contain` has to survive the swap or the model would
    // change size at the rung it is meant to become cheaper at.
    //
    // is-ready on load rather than on assignment, which is the whole point of
    // the class: the src lands at once and the bytes still have to decode, and
    // a card that swapped early would show a blank square where the model was.
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
  let mesh: Mesh | null = null;

  const paint = () => {
    if (!mesh) return;
    drawInto(stage, mesh, view);
  };

  // The card is sized by the board, not by its contents, so the canvas has to
  // follow the box rather than the other way round. The observer is also the
  // box cache's one invalidation - it clears the stale rect before repainting.
  const ro = new ResizeObserver(() => { stageBox.delete(stage); paint(); });
  ro.observe(stage);
  // Hung on the node so it can be disconnected when the card is thrown away -
  // see releaseModels(). An observer whose only reference is this closure is
  // reachable for as long as its target is, and `paint` closes over the parsed
  // Mesh, so a culled model card kept a whole mesh alive past the point
  // MESH_CACHE_MAX would have evicted it.
  // SAFETY: StageCanvas is this module's own name for the canvas it made, plus
  // the two fields it hangs off it. Nothing outside this file writes or reads
  // `_modelRO`, and the element is the one created a few lines up.
  (stage as StageCanvas)._modelRO = ro;

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
    // A declined ceiling reads out what was found, not "could not be read" - the
    // model reads perfectly well and somebody said not to. isOversize() first
    // because Oversize is not a MeshError and would otherwise land on the generic
    // half of this line, which is the app forgetting the answer it just got.
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

  // Read once; if it stops at a ceiling, say what it found and read it again.
  //
  // The asking end of the retry contract in consent.ts. The readers underneath
  // are synchronous and cannot ask anything - readModel() awaits the CAD kernel
  // for STEP and IGES, but a worker cannot put a dialog on the page either - and
  // this is the nearest place that both knows the file's name and is allowed to
  // wait. So the ceiling comes back as a throw, the question goes out here, and a
  // yes re-reads with `lift`. The second read is the cost of a yes and it only
  // ever happens to a model somebody has explicitly asked for.
  //
  // Keyed by the asset hash rather than by a name: two cards on one file are one
  // model, and answering for the first has answered for the second.
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
  // The loop condition is what makes the first key present: a Map with more
  // entries than the cap has at least one.
  while (meshes.size > MESH_CACHE_MAX) meshes.delete(meshes.keys().next().value!);
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
async function paint(mesh: Mesh) {
  if (!mesh.mtllib || mesh.colors) return;
  // split() always yields at least one part, so pop() has one to give.
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

/**
 * How much of a .mtl to read.
 *
 * A material library is a few lines per material and these are read in full;
 * the cap is here because readText() takes one and the alternative is trusting
 * that a file named `.mtl` is one. 256KB is a library with thousands of
 * materials in it and a model that has no business being on a moodboard.
 */
const MTL_MAX = 256 * 1024;

/** A model card's canvas, with the observer that follows its box. */
type StageCanvas = HTMLCanvasElement & { _modelRO?: ResizeObserver };

/**
 * Disconnect the size observer on every model stage inside `el`.
 *
 * Called by discard() in canvas/items.ts, beside the media and picture
 * teardown. Nothing disconnected these: the observer's callback closes over the
 * parsed Mesh, so a culled model card held one for as long as the observer was
 * reachable - past the point MESH_CACHE_MAX would have evicted it.
 *
 * Not called by culling, which puts the same node back and wants the canvas to
 * go on following its box.
 */
export function releaseModels(el: Element): void {
  for (const stage of el.querySelectorAll<StageCanvas>('canvas.model-stage')) {
    stage._modelRO?.disconnect();
    stage._modelRO = undefined;
  }
}

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
const views = new Map<string, View>();

const DEFAULT_VIEW: View = { yaw: 0.6, pitch: 0.5, zoom: 1 };

/**
 * The angle this model is being looked at, as one object per item.
 *
 * Seeded from what the board remembers and then mutated in place by orbit(),
 * which is what lets takeShot() photograph the angle actually on screen rather
 * than the one last written down.
 */
function liveView(item: Item): View {
  const held = views.get(item.id);
  if (held) return held;
  // meta is unknown per key on purpose - see board-model.ts - so a stored view
  // is narrowed to an object here and each field converted rather than trusted.
  // Number() is the unary + this line was written with, said in a form that
  // takes an unknown; the coercion and the `|| default` are unchanged.
  const m = item.meta?.view;
  // SAFETY: the `typeof m === 'object'` on the same line is the check, and the
  // truthiness before it rules out null. Every key read off `raw` below goes
  // through Number() and a `|| default`, so a record holding rubbish gives the
  // default view rather than a broken camera.
  const raw = m && typeof m === 'object' ? m as Record<string, unknown> : null;
  const view = raw
    ? { yaw: Number(raw.yaw) || 0, pitch: Number(raw.pitch) || 0, zoom: Number(raw.zoom) || 1 }
    : { ...DEFAULT_VIEW };
  views.set(item.id, view);
  return view;
}

/**
 * The URL of the still to show for this item, or null to draw it live.
 *
 * Null for three different reasons, and each one is a case that would otherwise
 * show somebody the wrong picture: the card is being turned, there is no still
 * yet, or the palette has moved since it was taken.
 *
 * There used to be a fourth - a card grown past some multiple of the shot's own
 * size went back to live geometry rather than show a soft picture. It is gone;
 * SHOT_MAX says why at length. The short version is that it was the single
 * biggest source of trouble in this file: it is reached by ordinary use, a card
 * past it never becomes a photograph, and so it re-reads its geometry on every
 * load for ever - which on a STEP file is a second of CAD kernel each time.
 */
function stillFor(item: Item): string | null {
  if (turning.has(item.id)) return null;
  // The string test is the same refusal the truthiness test was making: an item
  // arrives through makeItem(), which drops a `shot` that is not a digest, so
  // anything else here is a value no asset could ever be found under.
  const hash = item.meta?.shot;
  if (typeof hash !== 'string' || !hash) return null;
  // A model with no colours of its own is drawn in the board's ink, so a change
  // of palette leaves its photograph a shade out of date. Models that brought
  // their own colours carry no shotInk and never go stale this way.
  const ink = item.meta.shotInk;
  if (ink && ink !== boardInk()) return null;
  return assetURL(hash);
}

/**
 * How big to photograph this card: the still's **long** edge.
 *
 * The still is shaped like the card's picture area (see stageShape), so its long
 * edge lies along the card's long edge and `max` is the axis to read. `min`
 * would under-resolve a wide model on a wide card by the whole aspect ratio -
 * which it did, for one revision, while the shot was square and pinned to the
 * narrow axis. The rule follows the shot's shape and has changed with it twice.
 *
 * Measured against the item's own size in world units and not against what is on
 * screen, on purpose: zoom does not rebuild cards, so a rule that read the zoom
 * would be answered once at mount and then be wrong for the rest of the session.
 *
 * There is no companion "too big to bother" test any more, and its absence is
 * deliberate - see SHOT_MAX. A card larger than MAX_BUFFER is upscaling its live
 * geometry too, so refusing it a still only ever bought a permanent WebGL card.
 */
const shotEdge = (item: Item) =>
  clamp(Math.round(Math.max(+item.w || 0, +item.h || 0)), SHOT_MIN, SHOT_MAX);

/**
 * The colour an uncoloured model is shaded in, resolved to plain rgb().
 *
 * Read off a probe rather than off the root's custom property, because
 * getPropertyValue hands back whatever the token literally says - a color-mix,
 * an oklch, an inline override - and none of those compare equal across a
 * palette change that lands on the same colour. `color` is resolved by the
 * engine before getComputedStyle sees it.
 *
 * Held once, because measuring it is an insert, a forced style recalculation and
 * a removal - and stillFor() asks for every uncoloured model card, inside
 * buildModelCard(), inside the culler's build budget. A screenful of models was
 * a screenful of layout flushes on exactly the frames that budget exists to
 * protect. The value changes about as often as the palette does, which is what
 * resetModelInk() below is for; canvas/grid.ts's gridInk() is the same shape
 * for the same reason.
 */
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

/** Forget the resolved ink - the look changed. The twin of resetGridInk(). */
export function resetModelInk() {
  ink = null;
}

/**
 * Turn this model over by hand. The card swaps to live geometry until it is
 * deselected, and then photographs itself again.
 */
export function rotateModel(id: string) {
  const it = byId(id);
  if (!it || it.type !== 'model') return;
  turning.add(id);
  bus.emit('item', id);
}

export const isTurning = (id: string) => turning.has(id);

/**
 * The shape of the box this card shows its model in, as width over height.
 *
 * The **stage**, not the card: a model card is padding, then the picture, then
 * the filename, and only the middle one of those is what `object-fit: contain`
 * fits the still into. Reading the card's own w/h instead is the bug this
 * function exists to end, and it is not a small one - the filename row is a
 * fifth of a small card's height.
 *
 * Either element will do and both are the same box: the live canvas while the
 * model is being turned, the still standing in its place the rest of the time.
 *
 * clientWidth over clientHeight rather than a client rect, for the reason set
 * out at stageBox() below: a card is tilted, and the rect of a rotated element
 * is the axis-aligned box around it - a different shape from the element, by an
 * amount that depends on the lean. The layout box is the one the still is
 * `contain`ed into and so the one to shoot at.
 *
 * Null when the card is not mounted, which culling makes an ordinary case rather
 * than an edge one: a shot can be retaken for a card that has been panned off
 * screen. The caller squares up rather than guessing.
 */
function stageShape(id: string): number | null {
  const card = document.querySelector(`.item[data-id="${CSS.escape(id)}"] .card-model`);
  const box = card?.querySelector('canvas.model-stage, img.model-still');
  if (!(box instanceof HTMLElement) || !box.clientWidth || !box.clientHeight) return null;
  // Bounded on the same argument as the shot's own edge: a card dragged to a
  // sliver is still a card, and a still one pixel tall is not a still.
  return clamp(box.clientWidth / box.clientHeight, 0.2, 5);
}

/**
 * Photograph a model as it currently sits.
 *
 * At most SHOT_MAX on the long edge, in WebP - which is the whole point of the
 * exercise: a card showing a 40KB picture costs nothing to keep on screen,
 * where a card holding geometry costs a blit from the one shared context every
 * time anything moves.
 *
 * Silent on failure. A model that cannot be photographed - no WebGL, a mesh
 * that will not parse - simply keeps drawing itself live, which is what it did
 * before any of this existed. "The engine will not write WebP" used to be on
 * that list and is not any more: see the encode below.
 */
async function takeShot(id: string): Promise<boolean> {
  const item = byId(id);
  if (!item || item.type !== 'model') return false;
  const mesh = await load(item);

  const ink = boardInk();
  const view = liveView(item);

  // **Shaped like the card's picture area, measured rather than guessed.**
  //
  // This has been three shapes now and the card's proportions were the first,
  // on the reasoning that the still would then drop in without letterboxing.
  // The reasoning was right and the measurement was wrong: it is not dropped
  // into the card, it is dropped into the **stage** - the card less its padding,
  // less the filename, less the gap above it. On a 240 x 300 card that is a box
  // wider than it is tall inside a card taller than it is wide, so `contain`
  // re-fitted the picture and the model changed size the moment you let go.
  //
  // So the stage is measured. stageShape() reads the box the card is actually
  // showing the model in - the live canvas, or the still standing in its place -
  // and that is the aspect the shot is taken at. A card not on screen has no box
  // to read and falls back to a square, which composes exactly too (see
  // frame(): the fit is min(w, h), so a square contained in any box lands where
  // the live canvas draws). The square is the safe answer, not the good one -
  // it is a bigger file for the same picture.
  //
  // The long edge follows the card (shotEdge()), and a resize is already a
  // retake - see the 'geom' handler below - so a card made bigger is
  // re-photographed bigger rather than left holding a picture it has outgrown.
  const shape = stageShape(id) ?? 1;
  const edge = shotEdge(item);
  const w = shape >= 1 ? edge : Math.max(1, Math.round(edge * shape));
  const h = shape >= 1 ? Math.max(1, Math.round(edge / shape)) : edge;

  if (!renderShared(mesh, view, w, h, ink)) return false;

  // Copied off the shared canvas rather than encoded from it: that one is the
  // WebGL drawing buffer and the next card to draw will overwrite it, so the
  // bytes have to be taken now.
  // Through canvas/surface.ts: OffscreenCanvas is Safari 16.4, and below that
  // this line threw and takeShot() answered false - forever, on every settle,
  // paying a WebGL render each time to throw it away.
  const flat = surface(w, h);
  if (!flat) return false;
  // Non-null: renderShared() has just answered true, which it only does once
  // ensureGL() has built the shared canvas.
  flat.ctx.drawImage(glCanvas!, 0, 0, w, h, 0, 0, w, h);
  // Whatever came out. This used to require WebP, and the doc above still
  // called that case "a browser without WebP" as though it were exotic - it is
  // every Safari, none of which encodes WebP from a canvas. The cost was not a
  // missing still but a permanent one: takeShot() is called again on every
  // settle, so each attempt was a WebGL render, an OffscreenCanvas copy and an
  // encode, thrown away, for the life of the board.
  //
  // No JPEG retry, unlike canvas/display.ts and canvas/poster.ts. A model is
  // drawn over the board's own paper and the still carries that transparency;
  // flattening it onto black would put a rectangle under every model card.
  const blob = await surfaceToBlob(flat, 'image/webp', 0.9);
  if (!blob) return false;

  const hash = await addFile(derivedFile(blob, `${id}-still`));
  // Recorded before the item is told, so the rebuild this triggers does not read
  // it back as a card that still owes a picture.
  shotSize.set(id, sizeOf(item));
  setModelShot(id, { hash, ink: mesh.colors ? '' : ink, view });
  // After the card has its picture, not before: the thumbnail is the zoomed-out
  // copy of a still that already exists, and making it is another decode and
  // another encode. Nothing waits on it and a failure is silent - the card then
  // simply draws its full still at every zoom, which is what it did before.
  cutThumb(id, blob, w).catch(() => {});
  return true;
}

/**
 * The hundred-pixel copy the board draws when it is zoomed out.
 *
 * The same twin every photograph on the board carries, and made for the same
 * reason: past the detail rung a card is under a hundred pixels wide, and a
 * board of models drawing their full stills there is a full decode per card for
 * a difference nobody can see. The swap itself is two rules in items.css and a
 * sibling `<img class="still">` - see the image renderer in canvas/renderers.ts,
 * which is where that arrangement is argued.
 *
 * It matters more here than it does there now that the still follows the card:
 * shotEdge() will photograph a large card at 900px, and the CSS note that used
 * to call the still "an <img> of at most 450px, the cheapest picture on the
 * board" stopped being true the moment that number moved.
 *
 * Cut from the still rather than from the shared canvas, which costs a decode
 * and is worth it: makeThumb() is the one place in the app that knows what a
 * thumbnail is - the resize-on-decode, the quality, the refusal when the copy
 * outweighs the original - and a second implementation here would be a second
 * set of those numbers to keep in step.
 */
async function cutThumb(id: string, still: Blob, width: number) {
  const small = await makeThumb(still, width);
  if (!small) return;
  setItemThumb(id, await addFile(derivedFile(small.blob, `${id}-thumb`)));
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
  // Before the loop, not after: stillFor() compares each still's shotInk against
  // boardInk(), so a cache still holding the old colour would find every one of
  // them current and invalidate nothing.
  resetModelInk();
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
const shotSize = new Map<string, string>();
const sizeOf = (item: Item) => `${Math.round(+item.w || 0)}x${Math.round(+item.h || 0)}`;

/** Retakes in flight, so a drag does not queue one per frame. */
const pending = new Map<string, ReturnType<typeof setTimeout>>();
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
      takeShot(id).catch(() => {});
    }, RESIZE_QUIET_MS));
  }
});

/**
 * Drop a deleted model's per-item state. `views` and `shotSize` are keyed by id
 * and otherwise only cleared wholesale on a board swap (resetModels), so without
 * this a session that repeatedly adds and deletes models leaks one entry each.
 * `meshes` is LRU-capped and `pending` self-deletes, so only these two need it.
 */
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
    // The canvas is one of the widgets canvas/input.ts hands the whole gesture
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

  const stop = (e: PointerEvent) => {
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

// ---------------------------------------------------------------------------
// The draw
// ---------------------------------------------------------------------------

/**
 * The stage's box and its 2d context, cached per canvas so a turn's per-frame
 * drawInto() forces neither a layout nor a context lookup. The box changes only
 * on a resize, which the ResizeObserver on the stage signals by clearing this
 * entry before it repaints (see buildModelCard); the context a plain <canvas>
 * hands back is the same object every call. Same motive as the boardInk() cache
 * below - a turn should force nothing it does not have to.
 *
 * **The layout box, not a client rect, and that is a bug fix rather than a
 * tidy-up.** Every card on this board is *tilted* - `--item-tilt`, dealt per
 * card - and getBoundingClientRect() on a rotated element does not describe the
 * element. It describes the axis-aligned box the rotated shape fits inside,
 * which is both bigger and **a different shape**. So the drawing buffer was
 * allocated at the bounding box's proportions, renderShared() framed the model
 * for those proportions, and the browser then stretched that buffer into the
 * canvas's real box: a model squashed along one axis, by an amount that depends
 * on how far the card happens to lean. clientWidth and clientHeight are the
 * untransformed layout box, which is what a canvas's backing store has to match.
 *
 * It costs one thing, knowingly: a client rect carried the board's own
 * magnification, so a card turned while zoomed in got a buffer sized to what was
 * on screen. The layout box does not, so that card is drawn at its unzoomed size
 * times the device ratio and scaled up. Slightly soft while turning in close is a
 * straight trade against the wrong shape at every zoom, and MAX_BUFFER was
 * already capping the sharp end of that anyway.
 */
type Box = { w: number; h: number };
const stageBox = new WeakMap<HTMLCanvasElement, Box>();
const stageCtx = new WeakMap<HTMLCanvasElement, CanvasRenderingContext2D>();

function drawInto(stage: HTMLCanvasElement, mesh: Mesh, view: View) {
  let box = stageBox.get(stage);
  if (!box) { box = { w: stage.clientWidth, h: stage.clientHeight }; stageBox.set(stage, box); }
  if (!box.w || !box.h) return;
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  // Both axes by one factor, which is what keeps the ceiling a ceiling rather
  // than a reshape. Clamping them separately - which is what this did - turns a
  // card big enough to reach MAX_BUFFER on its long edge into a *square* buffer:
  // the framing in renderShared() reads the buffer's aspect, so the model was
  // framed for a shape the canvas was not, and the browser then stretched the
  // backing store to the element's real box - the same failure the client rect
  // above was causing by a different route, which is how that one was found.
  const scale = Math.min(1, MAX_BUFFER / Math.max(box.w * dpr, box.h * dpr));
  const w = Math.max(1, Math.round(box.w * dpr * scale));
  const h = Math.max(1, Math.round(box.h * dpr * scale));

  if (stage.width !== w || stage.height !== h) { stage.width = w; stage.height = h; }

  // The stage is a plain <canvas> this module made and has only ever drawn 2d
  // into, so it is never the already-bound-to-something-else case.
  let ctx = stageCtx.get(stage);
  if (!ctx) { ctx = stage.getContext('2d')!; stageCtx.set(stage, ctx); }
  ctx.clearRect(0, 0, w, h);
  // boardInk() rather than a per-frame getComputedStyle(stage).color: the stage's
  // colour is always var(--ink-2) (see buildModelCard), which is exactly what
  // boardInk() resolves and caches, so a turn no longer forces a style recalc per
  // frame - the box and context above are cached against the same motive. Same
  // value the still path (renderStill) already uses.
  if (!renderShared(mesh, view, w, h, boardInk())) return;
  // As in takeShot(): a true from renderShared() is the shared canvas existing.
  ctx.drawImage(glCanvas!, 0, 0, w, h, 0, 0, w, h);
}

/** Draw the mesh into the shared canvas at w x h. False if WebGL is unavailable. */
function renderShared(mesh: Mesh, view: View, w: number, h: number, cssColor: string): boolean {
  // Asked in this order and one at a time, as before: ensureProgram() builds on
  // the context ensureGL() returns and must not run without one.
  const gl = ensureGL();
  if (!gl) return false;
  const prog = ensureProgram(gl);
  if (!prog) return false;
  // ensureGL() makes the canvas before it hands back a context and ensureProgram()
  // fills all three tables before it answers, so a pair of successful calls is
  // exactly the guarantee these four assertions rest on. Bound to locals so that
  // is said once here rather than at each of the thirty uses below.
  const canvas = glCanvas!, bufs = buffers!, attr = attribs!, uni = uniforms!;
  if (canvas.width !== w || canvas.height !== h) {
    canvas.width = w;
    canvas.height = h;
  }
  gl.viewport(0, 0, w, h);
  gl.clearColor(0, 0, 0, 0);
  gl.enable(gl.DEPTH_TEST);
  // No face culling: a scanned or printed STL is frequently wound
  // inconsistently, and culling turns those faces into holes. The shader
  // handles the wrong-facing ones instead.
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
  // An uncoloured mesh gets a constant attribute rather than a buffer full of
  // the same three numbers: one call instead of a megabyte of white, and it
  // means an STL costs nothing for a feature only OBJ has. The array has to be
  // *disabled* for the constant to be read at all - a stale enabled pointer
  // from the last mesh would otherwise still be feeding this one.
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
  // Framed from the model's own size, so a 3mm screw and a 3m bridge both arrive
  // filling the card - and from a size that does not change with the angle, so
  // turning one over moves it and does not resize it. See frame(), which is also
  // the reason `fov` is a variable and the distance is not.
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

/** `rgb(r, g, b)` from getComputedStyle, as three floats. */
function rgbOf(css: string): number[] {
  // Anchored on `rgb(`/`rgba(`, not a scan for numbers anywhere in the string.
  //
  // getComputedStyle().color is serialised as `rgb(r g b)` by every engine
  // today, and this leaned on that by pulling every run of digits out of
  // whatever came back. A wide-gamut serialisation - `color(display-p3 0.2 0.3
  // 0.4)`, which is what a colour outside sRGB will eventually come back as -
  // makes that scan answer ["3", "0.2", "0.3", "0.4"], where the leading 3 is
  // the one in "display-p3", and every uncoloured model on the board is then
  // shaded from a garbage triple. A form this cannot read falls back to the
  // default clay below, which is a colour rather than a colour-shaped accident.
  const m = css.match(/^\s*rgba?\(([^)]*)\)/i);
  const n = m && !m[1].includes('%') ? m[1].match(/[\d.]+/g) : null;
  if (!n || n.length < 3) return [0.42, 0.36, 0.31];
  // Nudged towards mid grey: a token meant for text on paper is nearly black,
  // and a nearly black model shows no shading at all.
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
export function orbitView(centre: number[], dist: number, yaw: number, pitch: number): Float32Array {
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
