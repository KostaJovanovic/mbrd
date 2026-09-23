// The TIFF worker's guard around the vendored UTIF directory reader
// (import/tiff-worker.js), run for real: the worker file and both vendored
// scripts are loaded into a vm context that stands in for a worker global, so
// what is tested is the exact code the browser runs, UTIF included.
//
// Every refusal is a plain `error` reply, never the `pixels` question - a
// directory that loops is not a large picture, and there is nothing to lift.
// Each is paired with an honest file that gets through the same door first.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import vm from 'node:vm';

import { WEB } from './helpers.js';

const WORKER = join(WEB, 'assets', 'js', 'import', 'tiff-worker.js');

/** A fresh worker global with the worker file loaded. Returns its ask(). */
function loadWorker() {
  const replies = [];
  const g = {
    console,
    postMessage: msg => replies.push(msg),
    importScripts: (...paths) => {
      for (const p of paths) vm.runInContext(readFileSync(resolve(dirname(WORKER), p), 'utf8'), g);
    },
  };
  g.self = g;
  vm.createContext(g);
  vm.runInContext(readFileSync(WORKER, 'utf8'), g);
  return async bytes => {
    const buf = Uint8Array.from(bytes).buffer;
    await g.onmessage({ data: { id: 1, bytes: buf, lift: false } });
    return replies.pop();
  };
}

const u16 = v => [v & 255, (v >> 8) & 255];
const u32 = v => [v & 255, (v >> 8) & 255, (v >> 16) & 255, (v >>> 24) & 255];

/** A little-endian TIFF with one directory at 8 holding `entries`, then `next`. */
function tiff(entries, next = 0) {
  const out = [0x49, 0x49, ...u16(42), ...u32(8), ...u16(entries.length)];
  for (const [tag, type, num, value] of entries) out.push(...u16(tag), ...u16(type), ...u32(num), ...u32(value));
  out.push(...u32(next));
  return out;
}

/** 20000 x 20000 is past the pixel ceiling, so an honest directory comes back
 *  as the `pixels` question without any pixel being decoded - which is the
 *  proof it went through UTIF.decode and the guard in one piece. */
const HONEST = [[256, 4, 1, 20000], [257, 4, 1, 20000]];

test('an honest directory gets through the guard to the ceiling question', async () => {
  const ask = loadWorker();
  const reply = await ask(tiff(HONEST));
  assert.equal(reply.error, undefined, reply.error);
  assert.equal(reply.pixels, 20000 * 20000);
});

test('the 16-byte file whose directory names itself as the next one ends at once', async () => {
  // `II 2A00 08000000 0000 08000000`: the crafted file from the 2026-09-23
  // hunt. UTIF pushed an object a turn for ever - 3.4 GB of heap in 5 s.
  const ask = loadWorker();
  const bytes = [0x49, 0x49, 0x2A, 0x00, 0x08, 0, 0, 0, 0, 0, 0x08, 0, 0, 0];
  const t0 = performance.now();
  const reply = await ask([...bytes, 0, 0]);
  assert.ok(performance.now() - t0 < 1000, 'the directory chain did not stop');
  assert.match(reply.error, /point back/);
  assert.equal(reply.pixels, undefined, 'a loop is not a ceiling');
});

test('a chain of two directories that point at each other ends too', async () => {
  const ask = loadWorker();
  // Directory at 8 (no entries) -> directory at 14 (no entries) -> 8 again.
  const bytes = [0x49, 0x49, ...u16(42), ...u32(8), ...u16(0), ...u32(14), ...u16(0), ...u32(8)];
  assert.match((await ask(bytes)).error, /point back/);
});

test('an entry claiming four billion values is refused before UTIF expands it', async () => {
  const ask = loadWorker();
  const t0 = performance.now();
  const reply = await ask(tiff([...HONEST, [258, 3, 0xFFFFFFF0, 0]]));
  assert.ok(performance.now() - t0 < 1000, 'the entry was expanded');
  assert.match(reply.error, /longer than the file/);
});

test('a SubIFD that names its own directory stops at the depth cap', async () => {
  const ask = loadWorker();
  const reply = await ask(tiff([...HONEST, [330, 4, 1, 8]]));
  assert.match(reply.error, /nest too deep|more than the file/);
});

test('many directories naming one big array add up past the budget', async () => {
  // Each SubIFD entry names the same directory, and that directory names the
  // same 1000-value array: a fan-out that is no loop and no single lying
  // count, only far more work than the file holds.
  const ask = loadWorker();
  const fan = 200;
  const subAt = 8 + 2 + 3 * 12 + 4;                     // right after the first directory
  const arrayAt = subAt + 2 + 12 + 4 + fan * 4;
  const out = [0x49, 0x49, ...u16(42), ...u32(8)];
  out.push(...u16(3));
  for (const [tag, type, num, value] of [...HONEST, [330, 4, fan, subAt + 2 + 12 + 4]]) {
    out.push(...u16(tag), ...u16(type), ...u32(num), ...u32(value));
  }
  out.push(...u32(0));
  // The directory every SubIFD slot points at: one entry, a 1000-SHORT array.
  const sub = subAt;
  assert.equal(out.length, sub);
  out.push(...u16(1), ...u16(273), ...u16(3), ...u32(1000), ...u32(arrayAt), ...u32(0));
  // The SubIFD offsets: `fan` copies of `sub`.
  for (let i = 0; i < fan; i++) out.push(...u32(sub));
  assert.equal(out.length, arrayAt);
  for (let i = 0; i < 1000; i++) out.push(0, 0);
  const reply = await ask(out);
  assert.match(reply.error, /more than the file/);
});
