// The worker the vendored ffmpeg core runs in.
//
// A classic worker, not a module one, because the core is an Emscripten bundle
// that expects importScripts and defines a global factory. Nothing else in this
// app is written this way; this file exists precisely so that nothing else has
// to be.
//
// It speaks four messages and holds no state beyond the core itself:
//   { type: 'boot', js, wasm }               -> { type: 'ready', ok }
//   { type: 'run', id, inName, out, argv, bytes } -> { id, bytes } | { id, error }

let core = null;

// The one door in, and it checks what comes through it.
//
// A dedicated worker's port is reachable only by the document that spawned it -
// there is no cross-origin postMessage into one - so this is not a boundary
// against a stranger, and saying otherwise would overstate it. `boot` brings the
// core as bytes, never as a URL: optimize/media.ts fetched them from the CDN and
// checked both against the SHA-256 it was built with (CORE_SHA256 there), since
// this worker runs on the app's origin with its storage, every board in the
// browser included, and runs whatever the core is. This fetches nothing.
//
// `run` is checked for shape rather than content: FS.writeFile with a number
// for a name and callMain with a non-array both fail deep inside Emscripten,
// with an error naming neither. Its `id` is checked with the rest because it is
// the only way back - media.ts parks each job in a map keyed by it and drops
// any reply without one, so an id-less request that fails silently is a job
// sitting on the fifteen-minute timeout instead of erroring at once.
//
// `boot` answers itself rather than running twice. A second one used to
// re-importScripts the core and re-instantiate it, which is minutes of work and
// a fresh filesystem underneath whatever job was mid-encode.
let booted = false;

self.onmessage = async e => {
  const msg = e.data || {};
  if (msg.type === 'boot') {
    if (booted) return self.postMessage({ type: 'ready', ok: !!core, error: 'already started' });
    if (typeof msg.js !== 'string' || !(msg.wasm instanceof ArrayBuffer)) {
      return self.postMessage({ type: 'ready', ok: false, error: 'the core did not come as checked bytes' });
    }
    booted = true;
    return boot(msg.js, msg.wasm);
  }
  if (msg.type === 'run') {
    if (msg.id == null || typeof msg.inName !== 'string' || typeof msg.out !== 'string'
      || !Array.isArray(msg.argv) || !msg.argv.every(a => typeof a === 'string')) {
      return self.postMessage({ id: msg.id ?? null, error: 'malformed run request' });
    }
    return run(msg);
  }
};

async function boot(js, wasmBinary) {
  try {
    // The checked text, run as importScripts runs a file: at global scope,
    // where the UMD core defines its factory.
    const url = URL.createObjectURL(new Blob([js], { type: 'text/javascript' }));
    try { importScripts(url); } finally { URL.revokeObjectURL(url); }
    // 0.12-style cores export a factory; older ones assign the module directly.
    const factory = self.createFFmpegCore || self.Module;
    if (typeof factory !== 'function') {
      core = factory;
    } else {
      // The wasm as *bytes*, which Emscripten consumes before it would fetch
      // anything. Left to itself the UMD core resolves `ffmpeg-core.wasm`
      // against the worker's own origin, where a dev server answers an HTML
      // page and Emscripten dies with "failed to match magic number". The
      // single-threaded build loads no other file.
      core = await factory({ wasmBinary });
    }
    // Older cores run ffmpeg through callMain(). @ffmpeg/core 0.12 has no
    // callMain: it runs through exec() and wants reset() between runs, and
    // with only the callMain test here every poster on the web came out black.
    if (!core?.FS || (typeof core.callMain !== 'function' && typeof core.exec !== 'function')) {
      throw new Error('this build exposes neither FS nor callMain nor exec');
    }
    self.postMessage({ type: 'ready', ok: true });
  } catch (err) {
    self.postMessage({ type: 'ready', ok: false, error: String(err?.message || err) });
  }
}

function run({ id, inName, out, argv, bytes }) {
  if (!core) return self.postMessage({ id, error: 'core not started' });
  try {
    core.FS.writeFile(inName, new Uint8Array(bytes));
    try { core.FS.unlink(out); } catch { /* first run: nothing to remove */ }

    // ffmpeg's own exit code is not reliably surfaced by every core build, so
    // the test is whether an output file exists with anything in it - which is
    // the question actually being asked.
    const args = ['-nostdin', '-hide_banner', '-loglevel', 'error', '-y', ...argv];
    if (typeof core.callMain === 'function') {
      core.callMain(args);
    } else {
      try { core.exec(...args); } finally { core.reset?.(); }
    }

    let result = null;
    try {
      const data = core.FS.readFile(out);
      if (data?.length) result = data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength);
    } catch { /* the run produced nothing */ }

    // The in-memory filesystem is not a cache. Left alone, a board of forty
    // files would keep every input and every output resident until the tab was
    // closed, which is the wasm heap growing until it cannot.
    cleanup([inName, out]);
    self.postMessage(result ? { id, bytes: result } : { id, bytes: null }, result ? [result] : []);
  } catch (err) {
    cleanup([inName, out]);
    self.postMessage({ id, error: String(err?.message || err) });
  }
}

function cleanup(names) {
  for (const n of names) {
    try { core.FS.unlink(n); } catch { /* already gone */ }
  }
}
