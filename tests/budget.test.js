// The import memory policy: byte accounting and header-only dimension sniffing.
// These are the checks that make the 500-file cap stop being mistaken for a
// memory boundary (AUD-05). Pure module, so this is a pure test - the headers
// are hand-built so a case is about the one field it sets.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  IMPORT_LIMITS, makeByteBudget, imageDimensions, overPixelBudget,
} from '../web/assets/js/import/budget.js';

function png(w, h) {
  const b = new Uint8Array(24);
  b.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], 0);
  new DataView(b.buffer).setUint32(16, w);
  new DataView(b.buffer).setUint32(20, h);
  return b;
}
function gif(w, h) {
  const b = new Uint8Array(10);
  b.set([0x47, 0x49, 0x46, 0x38, 0x39, 0x61], 0);   // GIF89a
  b[6] = w & 0xff; b[7] = w >> 8; b[8] = h & 0xff; b[9] = h >> 8;
  return b;
}
function jpeg(w, h) {
  const b = new Uint8Array(20);
  b[0] = 0xff; b[1] = 0xd8;   // SOI
  b[2] = 0xff; b[3] = 0xc0;   // SOF0
  b[4] = 0; b[5] = 17;        // segment length
  b[6] = 8;                   // sample precision
  b[7] = h >> 8; b[8] = h & 0xff;
  b[9] = w >> 8; b[10] = w & 0xff;
  return b;
}
function webpVP8X(w, h) {
  const b = new Uint8Array(30);
  b.set([0x52, 0x49, 0x46, 0x46], 0);   // RIFF
  b.set([0x57, 0x45, 0x42, 0x50], 8);   // WEBP
  b.set([0x56, 0x50, 0x38, 0x58], 12);  // VP8X
  const w1 = w - 1, h1 = h - 1;
  b[24] = w1 & 0xff; b[25] = (w1 >> 8) & 0xff; b[26] = (w1 >> 16) & 0xff;
  b[27] = h1 & 0xff; b[28] = (h1 >> 8) & 0xff; b[29] = (h1 >> 16) & 0xff;
  return b;
}

const fakeFile = bytes => ({
  slice: () => ({ arrayBuffer: async () => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) }),
});

test('a byte budget charges what fits and refuses what does not', () => {
  const b = makeByteBudget(1000);
  assert.equal(b.take(400), true);
  assert.equal(b.take(400), true);
  assert.equal(b.take(400), false);   // 1200 > 1000
  assert.equal(b.spent(), 800);
  assert.equal(b.take(200), true);    // exactly at the limit
});

test('a single file past the per-file cap is refused whatever the batch budget', () => {
  const b = makeByteBudget(Infinity);
  assert.equal(b.take(IMPORT_LIMITS.fileBytes + 1), false);
  assert.equal(b.take(IMPORT_LIMITS.fileBytes), true);
});

test('dimensions are read from PNG, GIF, JPEG and WebP headers', () => {
  assert.deepEqual(imageDimensions(png(100, 200)), { w: 100, h: 200 });
  assert.deepEqual(imageDimensions(gif(640, 480)), { w: 640, h: 480 });
  assert.deepEqual(imageDimensions(jpeg(1024, 768)), { w: 1024, h: 768 });
  assert.deepEqual(imageDimensions(webpVP8X(4000, 3000)), { w: 4000, h: 3000 });
});

test('an unrecognised header yields no dimensions, not a wrong guess', () => {
  assert.equal(imageDimensions(new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8])), null);
});

test('a decode bomb is over the pixel budget; an ordinary photo is not', async () => {
  assert.equal(await overPixelBudget(fakeFile(png(30000, 30000))), true);   // 900 MP
  assert.equal(await overPixelBudget(fakeFile(png(2000, 1500))), false);    // 3 MP
});
