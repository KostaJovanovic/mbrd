// The two decode workers (import/tiff.ts, import/heif.ts) on the day one of
// them hangs. A timeout that only rejects leaves the worker spinning, and
// every later file in the session queues behind it and fails two minutes on.
// So the timeout has to end the worker, and the next file has to get a new
// one. A fake Worker that never answers and mocked timers stand in for a
// crafted file and two real minutes.

import { test, mock } from 'node:test';
import assert from 'node:assert/strict';

import { tiffRaster } from '../web/assets/js/import/tiff.ts';
import { heifPicture } from '../web/assets/js/import/heif.ts';

/** Every Worker made, and whether it was ended. None of them ever answers. */
const made = [];
class SilentWorker {
  constructor(url) { this.url = url; this.ended = false; made.push(this); }
  postMessage() {}
  terminate() { this.ended = true; }
}

/** Let the awaits before the postMessage (file.arrayBuffer() and the like) run. */
const settle = async () => { for (let i = 0; i < 20; i++) await new Promise(r => setImmediate(r)); };

async function hangThenRetry(t, start) {
  made.length = 0;
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const first = start();
  await settle();
  assert.equal(made.length, 1, 'the first file did not reach a worker');
  t.mock.timers.tick(120_000);
  assert.equal(await first, null, 'a hung decode is a named card');
  assert.ok(made[0].ended, 'the hung worker was left running');

  const second = start();
  await settle();
  assert.equal(made.length, 2, 'the next file queued behind the hung worker');
  t.mock.timers.tick(120_000);
  await second;
}

test('a TIFF decode that never answers ends its worker, and the next file gets a new one', async t => {
  globalThis.Worker = SilentWorker;
  const warn = mock.method(console, 'warn', () => {});
  const file = () => new File([new Uint8Array(64)], 'scan.tif', { type: 'image/tiff' });
  await hangThenRetry(t, () => tiffRaster(file()));
  warn.mock.restore();
  delete globalThis.Worker;
});

test('a libheif decode that never answers ends its worker, and the next file gets a new one', async t => {
  globalThis.Worker = SilentWorker;
  globalThis.OffscreenCanvas ??= class {};
  const warn = mock.method(console, 'warn', () => {});
  // An ftyp with the heic brand and nothing else: enough to be sent to the
  // decoder, and VideoDecoder is absent here, so it is libheif that is asked.
  const bytes = new Uint8Array(64);
  bytes.set([0, 0, 0, 24, 0x66, 0x74, 0x79, 0x70, 0x68, 0x65, 0x69, 0x63]);
  const file = () => new File([bytes], 'photo.heic');
  await hangThenRetry(t, () => heifPicture(file()));
  warn.mock.restore();
  delete globalThis.Worker;
});
