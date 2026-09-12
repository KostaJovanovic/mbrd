// The media worker's boot, and two deaths that used to be permanent. Most
// deaths go through killWorker(), clearing `ready` so the next call
// respawns. A throwing constructor couldn't: the promise executor runs
// before `ready = spawn()` overwrites it, leaving a permanently rejected
// promise `if (!ready)` never replaces. And a worker that stalls on the
// core download (importScripts is synchronous, blocking its own message
// loop) never settles `ready` at all, queuing every later call behind it.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { firstFrame, BOOT_TIMEOUT_MS } from '../web/assets/js/optimize/media.ts';

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

  globalThis.fetch = async () => ({ ok: true, status: 206 });
  // spawn() resolves the core URL against the page; nothing here loads it,
  // it just has to be resolvable.
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
