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

self.onmessage = async e => {
  const msg = e.data || {};
  if (msg.type === 'boot') return boot(msg.core);
  if (msg.type === 'run') return run(msg);
};

async function boot(url) {
  try {
    importScripts(url);
    // 0.12-style cores export a factory; older ones assign the module directly.
    const factory = self.createFFmpegCore || self.Module;
    core = typeof factory === 'function'
      ? await factory({ locateFile: name => new URL(name, url).href })
      : factory;
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
