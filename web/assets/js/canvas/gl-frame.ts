// A frame off a `<video>`, through WebGL, because 2D will not do it on Android.
//
// This file exists for one browser bug, and it is worth writing down properly
// because it took a long time to place and every guess about it was wrong.
//
// **Firefox for Android cannot draw a video onto a 2D canvas.**
// `ctx.drawImage(videoElement, ...)` leaves the canvas exactly as it was - no
// throw, no warning, nothing in the console. Mozilla bug 1526207, filed in 2019,
// still open, "wontfix" against every release since; it began life throwing
// NS_ERROR_NOT_AVAILABLE and became a silent no-op, which is the version this
// app met. Gecko decodes video on Android through MediaCodec into a
// SurfaceTexture, and a SurfaceTexture allows exactly one GL consumer at a time
// - the compositor already is that consumer, so there is nothing left for the
// 2D context to read. In Jamie Nicol's words on the bug: "we need 2, one for
// reading the pixels for the canvas, and another for compositing".
//
// Two consequences worth knowing, both of which explain things that looked like
// other faults:
//
//   - **It is the hardware codecs only.** H.264 and VP9 go through MediaCodec
//     and fail; AV1 is decoded in software and works. So a phone's own camera
//     footage is the exact case that breaks, and a test clip might not be.
//   - **The same clip on the same phone works in any Chromium browser.** That is
//     not a difference in the file, in this app, or in the canvas - Samsung
//     Internet simply does not have this bug.
//
// **WebGL is the way through, and it is the *only* one that does not cost thirty
// megabytes.** `gl.texImage2D` with a video source takes the SurfaceTexture path
// Gecko does support - bug 1655101, fixed in Firefox 123 - so the frame that
// will not come out through drawImage comes out through a texture upload. What
// this module does is upload the frame, draw it to a WebGL canvas, and hand that
// canvas back; a canvas *is* a legal drawImage source everywhere, so the caller
// blits it into the 2D surface it already had and everything downstream - the
// flat test, the encoder, the poster - is unchanged.
//
// It is a fallback and never the first choice. A GL context is an expensive
// thing to hold and the ordinary 2D path is fine on every other engine, so
// canvas/poster.ts only comes here when a frame has already come back blank.
//
// One context for the session, rebuilt if it is ever lost: a board of fifty
// clips must not build fifty of these, and a phone will drop the context on a
// background/foreground cycle without asking.

/** The canvas this module draws into, and the machinery for one upload. */
type Rig = {
  canvas: HTMLCanvasElement,
  gl: WebGLRenderingContext,
  tex: WebGLTexture,
};

let rig: Rig | null = null;

/**
 * The video's current frame on a canvas, or null if this engine will not do it
 * either.
 *
 * `w` and `h` are the size wanted, which is the poster's, not the clip's - the
 * upload is the whole frame however small this is, and the quad scales it.
 *
 * Null rather than a throw for every failure, because the caller's answer to
 * all of them is the same: this was the last door, try ffmpeg or leave the clip
 * without a picture. No WebGL at all, a context that will not build, a shader
 * that will not compile, a video with nothing decoded yet - all one answer.
 */
export function glFrame(v: HTMLVideoElement, w: number, h: number): HTMLCanvasElement | null {
  const r = rigFor(w, h);
  if (!r) return null;
  const { gl, tex, canvas } = r;
  try {
    gl.bindTexture(gl.TEXTURE_2D, tex);
    // Flipped on upload rather than in the shader: a video's rows run top-down
    // and a GL texture's run bottom-up, so without this the poster is a
    // perfectly good frame upside down - which no test here would catch, since
    // an upside-down picture is not a flat one.
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, true);
    // RGBA rather than RGB, and it is not cosmetic: bug 1709726 found the
    // SurfaceTexture fast path is the RGBA one, and RGB fell back to a readback
    // that ran at a tenth the speed.
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, v);
    gl.viewport(0, 0, w, h);
    gl.clearColor(0, 0, 0, 1);
    gl.clear(gl.COLOR_BUFFER_BIT);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
    // Nothing is read back here. The caller draws this canvas into its own 2D
    // surface, which is a canvas-to-canvas drawImage - the operation Gecko has
    // no trouble with, and the reason this indirection works at all.
    return canvas;
  } catch {
    // texImage2D throws where the element has no frame yet, which is a "not
    // this time" rather than a fault.
    return null;
  }
}

/** The rig, built once and sized to this call. Null on an engine without WebGL. */
function rigFor(w: number, h: number): Rig | null {
  if (rig && rig.gl.isContextLost()) rig = null;
  if (!rig) rig = build();
  if (!rig) return null;
  if (rig.canvas.width !== w || rig.canvas.height !== h) {
    rig.canvas.width = w;
    rig.canvas.height = h;
  }
  return rig;
}

/**
 * A one-triangle rig: a context, a program, a buffer and a texture.
 *
 * One triangle rather than two, which is the ordinary way to cover a viewport
 * and avoids the seam a quad's diagonal can leave. Its vertices run off the
 * viewport on two sides; the rasteriser clips them and every pixel is covered
 * once.
 *
 * `preserveDrawingBuffer` is load-bearing: without it the drawing buffer may be
 * cleared as soon as control returns to the browser, and the caller's drawImage
 * would take a blank canvas - which is indistinguishable from the bug this file
 * is here to get round.
 */
function build(): Rig | null {
  if (typeof document === 'undefined') return null;
  const canvas = document.createElement('canvas');
  const opts = {
    preserveDrawingBuffer: true,
    alpha: false,
    antialias: false,
    depth: false,
    stencil: false,
    // A frame grab is not a game: a low-power adapter is likelier to be the one
    // that is already awake, and there is no per-frame budget here at all.
    powerPreference: 'low-power' as const,
  };
  let gl: WebGLRenderingContext | null = null;
  try {
    const got = canvas.getContext('webgl', opts) || canvas.getContext('experimental-webgl', opts);
    // SAFETY: the two spellings answer the same interface - 'experimental-webgl'
    // is the pre-standard name for it and is still what a couple of old Android
    // builds have. TypeScript types the second as RenderingContext, which is
    // every context type at once, and there is nothing to narrow it by but the
    // name that was asked for.
    gl = got as WebGLRenderingContext | null;
  } catch {
    return null;
  }
  if (!gl) return null;

  const program = link(gl);
  if (!program) return null;
  gl.useProgram(program);

  const buffer = gl.createBuffer();
  gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
  gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW);
  const slot = gl.getAttribLocation(program, 'p');
  gl.enableVertexAttribArray(slot);
  gl.vertexAttribPointer(slot, 2, gl.FLOAT, false, 0, 0);

  const tex = gl.createTexture();
  if (!tex) return null;
  gl.bindTexture(gl.TEXTURE_2D, tex);
  // CLAMP_TO_EDGE and LINEAR without mipmaps, which is what a
  // non-power-of-two texture is allowed in WebGL 1 - and a video frame is
  // almost never a power of two.
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
  gl.uniform1i(gl.getUniformLocation(program, 'tex'), 0);

  return { canvas, gl, tex };
}

const VERTEX = `
attribute vec2 p;
varying vec2 uv;
void main() {
  uv = p * 0.5 + 0.5;
  gl_Position = vec4(p, 0.0, 1.0);
}`;

const FRAGMENT = `
precision mediump float;
uniform sampler2D tex;
varying vec2 uv;
void main() {
  gl_FragColor = texture2D(tex, uv);
}`;

function link(gl: WebGLRenderingContext): WebGLProgram | null {
  const vs = compile(gl, gl.VERTEX_SHADER, VERTEX);
  const fs = compile(gl, gl.FRAGMENT_SHADER, FRAGMENT);
  if (!vs || !fs) return null;
  const program = gl.createProgram();
  if (!program) return null;
  gl.attachShader(program, vs);
  gl.attachShader(program, fs);
  gl.linkProgram(program);
  // Deleted whether or not the link worked: the program holds its own copy once
  // linked, and these are two objects per session otherwise leaked on the path
  // where it did not.
  gl.deleteShader(vs);
  gl.deleteShader(fs);
  if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
    console.warn('[mbrd] gl-frame: the program would not link', gl.getProgramInfoLog(program));
    return null;
  }
  return program;
}

function compile(gl: WebGLRenderingContext, kind: number, source: string): WebGLShader | null {
  const shader = gl.createShader(kind);
  if (!shader) return null;
  gl.shaderSource(shader, source);
  gl.compileShader(shader);
  if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
    console.warn('[mbrd] gl-frame: a shader would not compile', gl.getShaderInfoLog(shader));
    gl.deleteShader(shader);
    return null;
  }
  return shader;
}
