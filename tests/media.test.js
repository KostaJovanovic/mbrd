// The media worker's boot, and the two deaths that used to be permanent.
//
// Most ways the worker can die go through killWorker(), which clears `ready` so
// the next call spawns a fresh one. The constructor throwing - a CSP that forbids
// workers, a blocked script URL - could not, because a promise executor runs
// before the assignment it is being assigned by: whatever it wrote to `ready` was
// overwritten by `ready = spawn()` on the very next line, leaving the module
// holding a permanently rejected promise that `if (!ready)` would never replace.
//
// The other one never settled at all. A worker that boots and then stalls on the
// core download throws nothing, fires no error event, and cannot report the
// trouble itself - importScripts is synchronous, so it blocks the message loop
// the complaint would travel on. `ready` stayed pending forever and every later
// call queued behind it.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { firstFrame, BOOT_TIMEOUT_MS } from '../web/assets/js/optimize/media.ts';

/** A file that never gets read: the boot fails long before the bytes matter. */
const clip = { name: 'clip.mov', async arrayBuffer() { return new ArrayBuffer(0); } };

test('a worker constructor that throws does not wedge the module', async () => {
  const realFetch = globalThis.fetch;
  const realWorker = globalThis.Worker;
  let attempts = 0;
  // mediaAvailable() probes the core with a ranged GET, and caches only a true.
  globalThis.fetch = async () => ({ ok: true, status: 206 });
  globalThis.Worker = class {
    constructor() { attempts++; throw new Error('blocked by CSP'); }
  };

  try {
    await assert.rejects(firstFrame(clip), /blocked by CSP/);
    assert.equal(attempts, 1);
    // The second call is the whole point: it used to reject on the retained
    // promise without ever reaching the constructor again.
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
  // spawn() resolves the core URL against the page. Nothing here loads it; it
  // just has to be resolvable.
  globalThis.location = { href: 'https://example.invalid/' };
  // Constructs, accepts the boot message, and then says nothing ever again -
  // which is what a stalled importScripts of the core looks like from out here.
  globalThis.Worker = class {
    constructor() { attempts++; }
    addEventListener() {}
    removeEventListener() {}
    postMessage() {}
    terminate() {}
  };
  // The real ceiling is two minutes and this test is not going to sit through
  // it. Only the boot clock is shortened - every other timer is left alone, so
  // an accidental dependency on this would show up as a hang rather than pass.
  globalThis.setTimeout = (fn, ms, ...rest) =>
    realSetTimeout(fn, ms === BOOT_TIMEOUT_MS ? 5 : ms, ...rest);

  try {
    await assert.rejects(firstFrame(clip), /did not finish loading/);
    assert.equal(attempts, 1);
    // The point of the whole thing: `ready` was cleared, so this spawns rather
    // than awaiting the promise that never settled.
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
