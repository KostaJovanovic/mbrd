// The media worker's boot, and two deaths that used to be permanent. Most
// deaths go through killWorker(), clearing `ready` so the next call
// respawns. A throwing constructor couldn't: the promise executor runs
// before `ready = spawn()` overwrites it, leaving a permanently rejected
// promise `if (!ready)` never replaces. And a worker that stalls on the
// core download (importScripts is synchronous, blocking its own message
// loop) never settles `ready` at all, queuing every later call behind it.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { firstFrame, loadCore, BOOT_TIMEOUT_MS, CORE_SHA256 } from '../web/assets/js/optimize/media.ts';
import { setPlatform } from '../web/assets/js/platform/platform.ts';

/** A file that never gets read: the boot fails long before the bytes matter. */
const clip = { name: 'clip.mov', async arrayBuffer() { return new ArrayBuffer(0); } };

test('a worker constructor that throws does not wedge the module', async () => {
  const realFetch = globalThis.fetch;
  const realWorker = globalThis.Worker;
  let attempts = 0;
  // mediaAvailable() probes the core with a ranged GET, caching only a true.
  globalThis.fetch = async () => ({ ok: true, status: 206 });
  globalThis.Worker = class {
    constructor() { attempts++; throw new Error('blocked by CSP'); }
  };

  try {
    await assert.rejects(firstFrame(clip), /blocked by CSP/);
    assert.equal(attempts, 1);
    // The second call is the point: it used to reject on the retained
    // promise without reaching the constructor again.
    await assert.rejects(firstFrame(clip), /blocked by CSP/);
    assert.equal(attempts, 2, 'a later attempt must try to spawn again');
  } finally {
    globalThis.fetch = realFetch;
    if (realWorker === undefined) delete globalThis.Worker;
    else globalThis.Worker = realWorker;
  }
});

test('a worker that boots and then goes silent is given up on, and respawns', async () => {
  const realFetch = globalThis.fetch;
  const realWorker = globalThis.Worker;
  const realSetTimeout = globalThis.setTimeout;
  const realLocation = globalThis.location;
  let attempts = 0;

  // The probe answers; the core's own download stalls, which is one of the
  // two ways a boot goes silent.
  globalThis.fetch = async (url, init) => (init?.headers?.Range ? { ok: true, status: 206 } : new Promise(() => {}));
  globalThis.location = { href: 'https://example.invalid/' };
  // Constructs, accepts the boot message, then says nothing ever again -
  // what a stalled importScripts of the core looks like from out here.
  globalThis.Worker = class {
    constructor() { attempts++; }
    addEventListener() {}
    removeEventListener() {}
    postMessage() {}
    terminate() {}
  };
  // The real ceiling is two minutes; only the boot clock is shortened here,
  // so an accidental dependency on other timers shows up as a hang.
  globalThis.setTimeout = (fn, ms, ...rest) =>
    realSetTimeout(fn, ms === BOOT_TIMEOUT_MS ? 5 : ms, ...rest);

  try {
    await assert.rejects(firstFrame(clip), /did not finish loading/);
    assert.equal(attempts, 1);
    // The point of the whole thing: `ready` was cleared, so this spawns
    // rather than awaiting the promise that never settled.
    await assert.rejects(firstFrame(clip), /did not finish loading/);
    assert.equal(attempts, 2, 'a later attempt must try to spawn again');
  } finally {
    globalThis.fetch = realFetch;
    globalThis.setTimeout = realSetTimeout;
    if (realLocation === undefined) delete globalThis.location;
    else globalThis.location = realLocation;
    if (realWorker === undefined) delete globalThis.Worker;
    else globalThis.Worker = realWorker;
  }
});

test('the core is pinned by hash, and other bytes never reach the worker', async () => {
  // The worker runs the core on the app's origin, with every board in the
  // browser in reach, so the CDN serving something else must be a refusal.
  for (const hash of Object.values(CORE_SHA256)) assert.match(hash, /^[0-9a-f]{64}$/);
  const realFetch = globalThis.fetch;
  const fetched = [];
  globalThis.fetch = async url => {
    fetched.push(url);
    return { ok: true, status: 200, arrayBuffer: async () => new TextEncoder().encode('self.evil = 1').buffer };
  };
  try {
    await assert.rejects(loadCore(), /not the one this app was built against/);
    assert.deepEqual(fetched.map(u => u.slice(u.lastIndexOf('/') + 1)).sort(), ['ffmpeg-core.js', 'ffmpeg-core.wasm']);
  } finally {
    globalThis.fetch = realFetch;
  }
});

test('the worker boots only from bytes, never from a URL', () => {
  // Read as text: the worker is a classic script with importScripts. It used
  // to importScripts a URL, which ran whatever the CDN answered.
  const src = readFileSync(join(import.meta.dirname, '..', 'web', 'assets', 'js', 'optimize', 'media-worker.js'), 'utf8');
  assert.doesNotMatch(src, /\bfetch\(/, 'the worker fetches nothing; the page checks the bytes first');
  assert.match(src, /msg\.wasm instanceof ArrayBuffer/);
});

/**
 * A clip too large for one ArrayBuffer: reading it whole throws, the way a
 * 2 GB+ File does in a browser. Its head can still be sliced.
 */
function hugeClip() {
  const reads = { whole: 0 };
  return {
    reads,
    file: {
      name: 'film.mov',
      size: 3 * 1024 ** 3,
      async arrayBuffer() { reads.whole++; throw new RangeError('Array buffer allocation failed'); },
      slice() { return { async arrayBuffer() { return new ArrayBuffer(16); } }; },
    },
  };
}

/** Run firstFrame() with a Worker that cannot be built, so the call ends at
 *  the boot and what it did before the boot is what is asserted. */
async function upToTheBoot(file) {
  const realFetch = globalThis.fetch;
  const realWorker = globalThis.Worker;
  globalThis.fetch = async () => ({ ok: true, status: 206 });
  globalThis.Worker = class { constructor() { throw new Error('no worker here'); } };
  try {
    await assert.rejects(firstFrame(file), /no worker here/,
      'the call must reach the wasm path, not stop at the whole-file read');
  } finally {
    globalThis.fetch = realFetch;
    if (realWorker === undefined) delete globalThis.Worker;
    else globalThis.Worker = realWorker;
  }
}

test('in a browser a huge clip is not read whole for a shell that is not there', async () => {
  const { reads, file } = hugeClip();
  await upToTheBoot(file);
  assert.equal(reads.whole, 0, 'the whole file was read for the native port');
});

test('with a shell, a clip too large to read whole falls through to the head slice', async () => {
  const { reads, file } = hugeClip();
  let asked = 0;
  setPlatform({ native: { firstFrame: async () => { asked++; return null; } } });
  try {
    await upToTheBoot(file);
  } finally {
    setPlatform(null);
  }
  assert.equal(reads.whole, 1, 'a wired shell is still offered the file');
  assert.equal(asked, 0, 'the port was called with no bytes');
});
