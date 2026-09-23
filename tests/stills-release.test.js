// A frozen GIF frame is a blob URL this app makes, and only releaseStills()
// revokes it. A card thrown away while its frame was still being encoded ran
// the release first, so the URL made afterwards was revoked by nothing.
// Driven with stand-in elements and a stand-in canvas, no document.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { captureStills, releaseStills } from '../web/assets/js/canvas/stills.ts';

function stubCanvas(t) {
  const saved = ['OffscreenCanvas', 'URL'].map(n => [n, Object.getOwnPropertyDescriptor(globalThis, n)]);
  t.after(() => {
    for (const [n, d] of saved) { if (d) Object.defineProperty(globalThis, n, d); else delete globalThis[n]; }
  });
  let finish;
  const encoded = new Promise(r => { finish = r; });
  globalThis.OffscreenCanvas = class {
    getContext() { return { drawImage() {} }; }
    convertToBlob() { return encoded; }
  };
  const live = new Set();
  let n = 0;
  globalThis.URL = {
    createObjectURL: () => { const u = `blob:still-${++n}`; live.add(u); return u; },
    revokeObjectURL: u => { live.delete(u); },
  };
  return { finish: () => finish({ type: 'image/webp', size: 1 }), live };
}

function card() {
  const classes = new Set(['still']);
  const twin = {
    src: '', listeners: [],
    classList: { contains: c => classes.has(c), add: c => classes.add(c), remove: c => classes.delete(c) },
    addEventListener(_type, fn) { this.listeners.push(fn); },
  };
  const gif = { complete: true, naturalWidth: 200, naturalHeight: 100, nextElementSibling: twin };
  const root = { querySelectorAll: sel => (sel.includes('data-gif') ? [gif] : [twin]) };
  return { root, twin };
}

const settle = async () => { for (let i = 0; i < 10; i++) await Promise.resolve(); };

test('a card discarded during the encode leaves no frame URL behind', async (t) => {
  const api = stubCanvas(t);
  const { root, twin } = card();
  captureStills(root);
  releaseStills(root);
  api.finish();
  await settle();
  assert.equal(api.live.size, 0, 'a frame URL outlived its card');
  assert.equal(twin.src, '');
});

test('a card discarded before its frame loaded revokes that frame', async (t) => {
  const api = stubCanvas(t);
  const { root, twin } = card();
  captureStills(root);
  api.finish();
  await settle();
  assert.equal(api.live.size, 1);
  releaseStills(root);
  assert.equal(api.live.size, 0, 'the frame still loading was never revoked');
  assert.ok(twin.src);
});

test('a frame that loads is kept, and revoked on release', async (t) => {
  const api = stubCanvas(t);
  const { root, twin } = card();
  captureStills(root);
  api.finish();
  await settle();
  for (const fn of twin.listeners) fn();
  assert.equal(twin.classList.contains('is-ready'), true);
  assert.equal(api.live.size, 1);
  releaseStills(root);
  assert.equal(api.live.size, 0);
});
