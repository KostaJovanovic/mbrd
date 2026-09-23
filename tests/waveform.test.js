// An audio card's waveform: measured once and kept on the item, which the
// .mbrd then saves as a sidecar. A stand-in shape for a file that would not
// decode must not be kept, or it is saved and read back as measured for good.
// A stand-in decoder; no audio is decoded here.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { putAsset } from '../web/assets/js/storage/assets.ts';
import { peaks } from '../web/assets/js/canvas/waveform.ts';

let decodes = 0;
let decode = () => Promise.reject(new Error('not a codec this engine has'));
globalThis.window ??= globalThis;
globalThis.OfflineAudioContext = class {
  decodeAudioData(buf) { decodes++; return decode(buf); }
};

const clip = (id, hash) => ({ id, asset: { hash }, meta: {} });

test('a waveform that could not be measured is drawn but not stored', async () => {
  putAsset('bad', new Blob([new Uint8Array(16)], { type: 'audio/x-odd' }));
  const one = clip('a1', 'bad');
  const shape = await peaks(one);
  assert.equal(shape.length, 256, 'the card still gets a shape to draw');
  assert.equal(one.meta.peaks, undefined, 'the stand-in was stored on the item');

  // Another mount of the same file does not decode it again this session.
  const before = decodes;
  const two = clip('a2', 'bad');
  assert.deepEqual(await peaks(two), shape);
  assert.equal(decodes, before);
  assert.equal(two.meta.peaks, undefined);
});

test('a measured waveform is stored', async () => {
  decode = async () => ({ getChannelData: () => Float32Array.from({ length: 1024 }, (_, i) => (i % 7) / 7) });
  putAsset('good', new Blob([new Uint8Array(16)], { type: 'audio/wav' }));
  const item = clip('a3', 'good');
  const shape = await peaks(item);
  assert.equal(item.meta.peaks, shape);
  assert.equal(shape.length, 256);
});
