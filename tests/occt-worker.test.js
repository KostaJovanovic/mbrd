// What the CAD kernel's worker does with what the kernel hands it.
//
// mesh/occt-worker.js is half plumbing and half a set of decisions - which
// colour a solid gets, what happens to a solid that has none, when a file is
// too big to open - and none of those need seven megabytes of WebAssembly to
// check. So the worker is run here as the classic script it is, with a fake
// `occtimportjs` in place of the real one, and driven with canned kernel
// output. The vendored build itself is tests/occt-vendor.test.js's business.
//
// This is the only way to test the file at all: a classic worker installs
// `self.onmessage` at the top level and exports nothing, which is why
// tests/imports.test.js lists it as an entry point rather than a unit.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { createContext, runInContext } from 'node:vm';

import { JS, read } from './helpers.js';

const SOURCE = read(join(JS, 'mesh', 'occt-worker.js'));

/**
 * The worker, running, with one message put through it.
 *
 * `meshes` is what the kernel is pretending to have found. The reply comes back
 * as whatever the worker posted - the same object canvas/model.ts's side of the
 * port would receive.
 */
async function run(meshes, { kind = 'step', maxTriangles = 1e6, success = true } = {}) {
  let reply = null;
  const context = createContext({
    URL, Math, Float32Array, Uint8Array, Error, console,
    importScripts() {},
    postMessage(data) { reply = data; },
    location: { href: 'https://mbrd.test/assets/js/mesh/occt-worker.js' },
  });
  context.self = context;
  context.occtimportjs = () => Promise.resolve({
    ReadStepFile: () => ({ success, meshes }),
    ReadIgesFile: () => ({ success, meshes }),
  });
  runInContext(SOURCE, context, { filename: 'occt-worker.js' });
  await context.onmessage({ data: { id: 7, kind, bytes: new ArrayBuffer(8), maxTriangles } });
  return reply;
}

/**
 * One solid: a single triangle, indexed, optionally with a colour.
 *
 * The colour is attached in a second statement rather than spread in
 * conditionally, and here that is the difference the tests turn on: the worker
 * asks whether the property is *there*, so a solid carrying `color: undefined`
 * is not the same fixture as one carrying no colour at all.
 */
function solid(color, at = 0) {
  const made = {
    attributes: {
      position: { array: [at, 0, 0, at + 1, 0, 0, at, 1, 0] },
      normal: { array: [0, 0, 1, 0, 0, 1, 0, 0, 1] },
    },
    index: { array: [0, 1, 2] },
  };
  if (color) made.color = color;
  return made;
}

test('the kernel output comes back as a flat triangle soup', async () => {
  const reply = await run([solid(null, 0), solid(null, 5)]);
  assert.equal(reply.id, 7, 'the reply is not tagged with the request it answers');
  assert.equal(reply.triangles, 2);
  assert.deepEqual(Array.from(reply.positions), [
    0, 0, 0, 1, 0, 0, 0, 1, 0,
    5, 0, 0, 6, 0, 0, 5, 1, 0,
  ]);
  // Rebuilt rather than compared whole: the worker runs in its own realm, so the
  // object it posted has that realm's prototypes and a strict deep-equal against
  // a literal written here fails on identity rather than on any value.
  assert.deepEqual(Array.from(reply.bounds.min), [0, 0, 0]);
  assert.deepEqual(Array.from(reply.bounds.max), [6, 1, 0]);
});

test('an index is expanded, not passed through', async () => {
  // The kernel answers with shared vertices; the app draws unshared triangles.
  // An index read in the wrong order is a shuffled model, which still draws.
  const shape = solid(null);
  shape.attributes.position.array = [0, 0, 0, 1, 0, 0, 0, 1, 0, 9, 9, 9];
  shape.index.array = [3, 1, 0];
  const reply = await run([shape]);
  assert.deepEqual(Array.from(reply.positions), [9, 9, 9, 1, 0, 0, 0, 0, 0]);
});

/**
 * The colour rule, which is the one that showed on screen.
 *
 * The kernel answers per solid, and an assembly styled a part at a time comes
 * back with some of them unanswered - six of eight on the file this was found
 * on. Filling the gaps with white drew an assembly with blank parts in it;
 * dropping every colour instead drew it in the board's ink, which is a still
 * that goes stale on the next palette change. See flatten() in the worker.
 */
test('a colour the answered solids agree on is the file speaking', async () => {
  const all = await run([solid([0.5, 0.5, 0.5]), solid([0.5, 0.5, 0.5], 5)]);
  assert.ok(all.colors, 'both solids carry a colour and the mesh came back with none');
  assert.equal(all.colors.length, all.positions.length, 'a colour per vertex, like the positions');

  // The case from the file: one style over the whole assembly, reported for
  // some of its solids and not the rest.
  const some = await run([solid([0.5, 0.5, 0.5]), solid(null, 5)]);
  assert.ok(some.colors, 'the file names one colour and the model came back with none');
  const first = Array.from(some.colors.slice(0, 3));
  const gap = Array.from(some.colors.slice(9, 12));
  assert.deepEqual(gap, first, 'the unanswered solid was drawn in some other colour');
});

test('solids that disagree, with a gap between them, take the board ink', async () => {
  // Two colours and a solid with neither is a file this cannot draw faithfully
  // either way round - there is one uOwnColor for the whole mesh, so the choice
  // is every solid's own colour or none of them.
  const mixed = await run([solid([0.5, 0.5, 0.5]), solid([0.1, 0.2, 0.3], 5), solid(null, 10)]);
  assert.equal(mixed.colors, null);

  const none = await run([solid(null), solid(null, 5)]);
  assert.equal(none.colors, null);
});

test('two solids of one style are one colour, not two near-misses', async () => {
  // The colours arrive as doubles out of a per-solid linear conversion, so one
  // STEP presentation style can come back differing in the last bits. Comparing
  // exactly would call that two colours and drop both.
  const a = [0.35153260827064514, 0.35153260827064514, 0.35153260827064514];
  const b = [0.35153260827064520, 0.35153260827064510, 0.35153260827064500];
  const reply = await run([solid(a), solid(b, 5), solid(null, 10)]);
  assert.ok(reply.colors, 'a rounding difference was read as a second colour');
});

test('a colour is handed over in the space the renderer draws in', async () => {
  // OCCT converts a presentation colour to linear light on the way in, so a
  // STEP file saying 0.6275 arrives as 0.3515. canvas/model.ts has no gamma in
  // it at all, and mesh/step.ts takes the number the file wrote - so without the
  // encode this reader draws the same file darker than the other one does.
  const reply = await run([solid([0.35153260827064514, 0.35153260827064514, 0.35153260827064514])]);
  for (const v of reply.colors.slice(0, 3)) {
    assert.ok(Math.abs(v - 0.6275) < 1e-3, `expected the file's own 0.6275, got ${v}`);
  }
  // The toe, which a plain 2.2 power gets wrong and which is where black lives.
  const dark = await run([solid([0.001, 0.001, 0.001])]);
  assert.ok(Math.abs(dark.colors[0] - 0.01292) < 1e-5, `linear toe: got ${dark.colors[0]}`);
});

test('a solid with no normals is shaded flat rather than black', async () => {
  const shape = solid(null);
  delete shape.attributes.normal;
  const reply = await run([shape]);
  assert.deepEqual(Array.from(reply.normals), [0, 0, 1, 0, 0, 1, 0, 0, 1]);
});

test('a file past the ceiling is counted, not allocated', async () => {
  const reply = await run([solid(null), solid(null, 5)], { maxTriangles: 1 });
  assert.equal(reply.oversize, 2, 'the ceiling reply says how many triangles there were');
  assert.equal(reply.positions, undefined, 'the arrays were built anyway - the ceiling is not a ceiling');
});

test('a file the kernel could not read comes back as a sentence', async () => {
  const refused = await run([], { success: false });
  assert.match(refused.error, /geometry/, refused.error);
  assert.equal(refused.id, 7);

  const wrongKind = await run([solid(null)], { kind: 'obj' });
  assert.match(wrongKind.error, /not a kernel format/, wrongKind.error);
});
