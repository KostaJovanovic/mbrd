// The worker the vendored ffmpeg core runs in.
//
// A classic worker, not a module one, because the core is an Emscripten bundle
// that expects importScripts and defines a global factory. Nothing else in this
// app is written this way; this file exists precisely so that nothing else has
// to be.
//
// It speaks four messages and holds no state beyond the core itself:
//   { type: 'boot', core }                   -> { type: 'ready', ok }
//   { type: 'run', id, inName, out, argv, bytes } -> { id, bytes } | { id, error }

let core = null;

// The one door in, and it checks what comes through it.
//
// A dedicated worker's port is reachable only by the document that spawned it -
// there is no cross-origin postMessage into one - so this is not a boundary
// against a stranger, and saying otherwise would overstate it. What the checks
// buy is smaller and real: `boot` passes its argument to importScripts(), which
// executes whatever is at that URL inside this worker, and a bug in
// optimize/media.ts that posted the wrong field would have that run with no
// complaint. The host is pinned to the one the CSP's connect-src already names,
// so the two agree by construction rather than by memory. See CORE_JS there.
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
const CORE_ORIGIN = 'https://cdn.jsdelivr.net';

let booted = false;

self.onmessage = async e => {
  const msg = e.data || {};
  if (msg.type === 'boot') {
    if (booted) return self.postMessage({ type: 'ready', ok: !!core, error: 'already started' });
    if (typeof msg.core !== 'string' || !msg.core.startsWith(CORE_ORIGIN + '/')) {
      return self.postMessage({ type: 'ready', ok: false, error: 'the core url is not one we serve from' });
    }
    booted = true;
    return boot(msg.core);
  }
  if (msg.type === 'run') {
    if (msg.id == null || typeof msg.inName !== 'string' || typeof msg.out !== 'string'
      || !Array.isArray(msg.argv) || !msg.argv.every(a => typeof a === 'string')) {
      return self.postMessage({ id: msg.id ?? null, error: 'malformed run request' });
    }
    return run(msg);
  }
};

async function boot(url) {
  try {
    importScripts(url);
    // 0.12-style cores export a factory; older ones assign the module directly.
    const factory = self.createFFmpegCore || self.Module;
    if (typeof factory !== 'function') {
      core = factory;
    } else {
      // Hand the core the wasm *bytes* rather than let it fetch the file itself.
      //
      // The reason is a trap this walked straight into: the UMD core, loaded by
      // importScripts in a classic worker, resolves `ffmpeg-core.wasm` against the
      // worker's own origin and fetches it there, ignoring the locateFile below.
      // That path does not exist on this origin, so a dev server answers its 404
      // or SPA fallback - an HTML page - and Emscripten compiles the HTML as wasm
      // and dies with "failed to match magic number". Fetching the bytes from the
      // CDN ourselves and passing them as `wasmBinary` (which Emscripten consumes
      // before it would fetch anything) makes the source unambiguous. locateFile
      // stays for any other file the core resolves the same way.
      const wasmURL = new URL('ffmpeg-core.wasm', url).href;
      const res = await fetch(wasmURL);
      if (!res.ok) throw new Error(`wasm ${res.status} at ${wasmURL}`);
      const wasmBinary = await res.arrayBuffer();
      core = await factory({ wasmBinary, locateFile: name => new URL(name, url).href });
    }
    if (!core?.FS || typeof core.callMain !== 'function') {
      throw new Error('this build exposes neither FS nor callMain');
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
    core.callMain(['-nostdin', '-hide_banner', '-loglevel', 'error', '-y', ...argv]);

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
