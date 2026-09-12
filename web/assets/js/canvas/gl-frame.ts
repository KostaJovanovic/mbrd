// WebGL video-frame grab — workaround for Firefox Android (bug 1526207) where
// ctx.drawImage(video) silently returns blank for hardware-decoded codecs.
// gl.texImage2D takes the SurfaceTexture path Gecko does support (bug 1655101).
// Fallback only: poster.ts comes here when a 2D frame comes back empty.
// One context for the session, rebuilt on context loss.

/** GL context, texture and canvas for one upload. */
type Rig = {
  canvas: HTMLCanvasElement,
  gl: WebGLRenderingContext,
  tex: WebGLTexture,
};

let rig: Rig | null = null;

// Returns the video's current frame on a canvas, or null on any failure.
export function glFrame(v: HTMLVideoElement, w: number, h: number): HTMLCanvasElement | null {
  const r = rigFor(w, h);
  if (!r) return null;
  const { gl, tex, canvas } = r;
  try {
    gl.bindTexture(gl.TEXTURE_2D, tex);
    // Video rows are top-down, GL textures bottom-up.
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, true);
    // RGBA takes the SurfaceTexture fast path; RGB falls back to slow readback.
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, v);
    gl.viewport(0, 0, w, h);
    gl.clearColor(0, 0, 0, 1);
    gl.clear(gl.COLOR_BUFFER_BIT);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
    // Caller blits this canvas into its 2D surface — canvas-to-canvas drawImage works fine.
    return canvas;
  } catch {
    // texImage2D throws when no frame is decoded yet.
    return null;
  }
}

// Returns (or builds) the rig, sized to w×h. Null if no WebGL.
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

// Build a one-triangle rig. preserveDrawingBuffer is required or the caller
// reads a blank canvas after control returns to the browser.
function build(): Rig | null {
  if (typeof document === 'undefined') return null;
  const canvas = document.createElement('canvas');
  const opts = {
    preserveDrawingBuffer: true,
    alpha: false,
    antialias: false,
    depth: false,
    stencil: false,
    // Low-power adapter is likelier already awake; no per-frame budget here.
    powerPreference: 'low-power' as const,
  };
  let gl: WebGLRenderingContext | null = null;
  try {
    const got = canvas.getContext('webgl', opts) || canvas.getContext('experimental-webgl', opts);
    // 'experimental-webgl' returns RenderingContext, same interface as 'webgl'.
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
  // NPOT textures in WebGL 1 require CLAMP_TO_EDGE and no mipmaps.
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
  // Program holds its own copy after linking; delete the originals.
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
