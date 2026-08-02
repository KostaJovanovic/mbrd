// The media worker's boot, and the one death that used to be permanent.
//
// Every other way the worker can die goes through killWorker(), which clears
// `ready` so the next call spawns a fresh one. The constructor throwing - a CSP
// that forbids workers, a blocked script URL - could not, because a promise
// executor runs before the assignment it is being assigned by: whatever it wrote
// to `ready` was overwritten by `ready = spawn()` on the very next line, leaving
// the module holding a permanently rejected promise that `if (!ready)` would
// never replace.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { firstFrame } from '../web/assets/js/optimize/media.js';

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
