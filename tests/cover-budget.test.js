// "Choose a picture" for a card (applyCover in import/drop.ts) and the pixel
// budget. The cover path decodes the picture to check it can be drawn, and it
// used to do that with no look at the header first - so a few hundred bytes
// declaring 65535 x 65535 went straight to the decoder, the one door into the
// board that importFiles() guards and this one did not.
//
// The decode is observed through createImageBitmap, which measureSize() calls
// first: a call counted is a decode started.

import { test, after } from 'node:test';
import assert from 'node:assert/strict';

import { applyCover } from '../web/assets/js/import/drop.ts';
import { setRiskPrompt } from '../web/assets/js/consent.ts';

/** A JPEG header declaring w x h, and nothing to decode behind it. */
function jpeg(w, h) {
  const b = new Uint8Array(64);
  b.set([0xff, 0xd8, 0xff, 0xc0, 0, 17, 8, h >> 8, h & 255, w >> 8, w & 255]);
  return b;
}

let decodes = 0;
const realBitmap = globalThis.createImageBitmap;
globalThis.createImageBitmap = async () => { decodes++; throw new Error('no decoder here'); };
after(() => {
  setRiskPrompt(null);
  if (realBitmap === undefined) delete globalThis.createImageBitmap;
  else globalThis.createImageBitmap = realBitmap;
});

test('a cover that declares a decode bomb is asked about, and a no stops before the decode', async () => {
  const asked = [];
  setRiskPrompt(async q => { asked.push(q); return 'no'; });
  decodes = 0;
  await applyCover('card', new File([jpeg(65535, 65535)], 'bomb.jpg', { type: 'image/jpeg' }));
  assert.equal(asked.length, 1, 'the pixel budget was not asked');
  assert.match(asked[0].body, /megapixels/);
  assert.equal(decodes, 0, 'the picture was decoded after the answer was no');
});

test('a yes lets the same cover through to the decode', async () => {
  setRiskPrompt(async () => 'go');
  decodes = 0;
  await applyCover('card', new File([jpeg(65534, 65535)], 'bomb2.jpg', { type: 'image/jpeg' }));
  assert.equal(decodes, 1);
});

test('an ordinary picture is not asked about at all', async () => {
  const asked = [];
  setRiskPrompt(async q => { asked.push(q); return 'no'; });
  decodes = 0;
  await applyCover('card', new File([jpeg(4000, 3000)], 'photo.jpg', { type: 'image/jpeg' }));
  assert.equal(asked.length, 0);
  assert.equal(decodes, 1);
});
