// The import memory policy: byte accounting and header-only dimension sniffing.
// These are the checks that make the 500-file cap stop being mistaken for a
// memory boundary (AUD-05). Pure module, so this is a pure test - the headers
// are hand-built so a case is about the one field it sets.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  IMPORT_LIMITS, makeByteBudget, imageDimensions, overPixelBudget,
} from '../web/assets/js/import/budget.ts';

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

// ---------------------------------------------------------------------------
// The four formats the budget could not read
//
// PHOTO_EXTS (import/formats.ts) carries BMP, ICO, AVIF and TIFF, and a browser
// decodes all four - but imageDimensions() knew only PNG, GIF, WebP and JPEG,
// so overPixelBudget() answered false for every one of them. A sixty-byte BMP
// declaring 30000x30000 went to createImageBitmap() and allocated about 3.6 GB:
// the exact allocation this module's header says it exists to stop, from a file
// that fits in a chat message.
// ---------------------------------------------------------------------------

const bmp = (w, h) => {
  const b = new Uint8Array(60);
  b[0] = 0x42; b[1] = 0x4d;                     // 'BM'
  const dv = new DataView(b.buffer);
  dv.setUint32(14, 40, true);                   // BITMAPINFOHEADER size
  dv.setInt32(18, w, true);
  dv.setInt32(22, h, true);
  return b;
};

test('a BMP declares its size in a header, and it is read', () => {
  assert.deepEqual(imageDimensions(bmp(30000, 30000)), { w: 30000, h: 30000 });
  assert.deepEqual(imageDimensions(bmp(640, 480)), { w: 640, h: 480 });
});

test('a top-down BMP has a negative height and the same pixel count', () => {
  // Legal, common, and says nothing about how much memory it decodes to.
  assert.deepEqual(imageDimensions(bmp(30000, -30000)), { w: 30000, h: 30000 });
});

test('an ICO reports its largest entry, and 0 means 256', () => {
  const b = new Uint8Array(6 + 32);
  b[2] = 1;                                     // type: icon
  new DataView(b.buffer).setUint16(4, 2, true); // two entries
  b[6] = 16; b[7] = 16;                         // 16x16
  b[22] = 0; b[23] = 0;                         // 256x256, written as zero
  assert.deepEqual(imageDimensions(b), { w: 256, h: 256 });
});

test('an AVIF reports the size in its ispe box', () => {
  const b = new Uint8Array(64);
  b.set([0, 0, 0, 24, 0x66, 0x74, 0x79, 0x70], 0);     // ....ftyp
  b.set([0x69, 0x73, 0x70, 0x65], 30);                 // ispe
  const dv = new DataView(b.buffer);
  dv.setUint32(38, 20000);                             // width, big-endian
  dv.setUint32(42, 20000);                             // height
  assert.deepEqual(imageDimensions(b), { w: 20000, h: 20000 });
});

test('a TIFF reports ImageWidth and ImageLength from its first IFD', () => {
  const b = new Uint8Array(64);
  const dv = new DataView(b.buffer);
  b[0] = 0x49; b[1] = 0x49;                     // 'II', little-endian
  dv.setUint16(2, 42, true);
  dv.setUint32(4, 8, true);                     // first IFD at byte 8
  dv.setUint16(8, 2, true);                     // two entries
  dv.setUint16(10, 256, true); dv.setUint16(12, 4, true);
  dv.setUint32(14, 1, true); dv.setUint32(18, 25000, true);
  dv.setUint16(22, 257, true); dv.setUint16(24, 4, true);
  dv.setUint32(26, 1, true); dv.setUint32(30, 25000, true);
  assert.deepEqual(imageDimensions(b), { w: 25000, h: 25000 });
});

test('the budget refuses a tiny file that declares an enormous picture', async () => {
  const huge = new Blob([bmp(30000, 30000)]);
  assert.equal(huge.size < 100, true, 'the fixture has to be tiny to be the point');
  assert.equal(await overPixelBudget(huge), true);
});

test('and lets an ordinary photograph through', async () => {
  assert.equal(await overPixelBudget(new Blob([bmp(4000, 3000)])), false);
});

test('bytes it cannot read are still not refused', () => {
  // A false positive here costs somebody their photograph; a false negative
  // costs a check the byte caps and the decoder still make.
  assert.equal(imageDimensions(new Uint8Array(64)), null);
  assert.equal(imageDimensions(new Uint8Array(0)), null);
});
