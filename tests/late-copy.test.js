// A photo card's display copy is made after the card is built, and it can
// land on a card that has changed since: one zoomed past it onto the
// original (canvas/hires.ts), or one thrown away. Driven with stand-in
// <img> objects, no document.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { landDisplay, releaseImages } from '../web/assets/js/canvas/renderers.ts';

const img = (patch = {}) => ({
  isConnected: true, src: '', dataset: {},
  removeAttribute(name) { if (name === 'src') this.src = ''; },
  ...patch,
});

test('a copy lands on a mounted card, and on one not mounted yet', () => {
  const live = img({ src: 'blob:thumb' });
  landDisplay(live, 'blob:copy');
  assert.equal(live.src, 'blob:copy');
  const fresh = img({ isConnected: false });
  landDisplay(fresh, 'blob:copy');
  assert.equal(fresh.src, 'blob:copy');
});

test('a copy never loads into a picture whose card was thrown away', () => {
  // releaseImages() clears the src, so `!img.src` was true of a discarded
  // card, and the copy was set on an <img> that Chromium then never frees.
  const gone = img({ src: 'blob:thumb' });
  releaseImages({ querySelectorAll: () => [gone] });
  gone.isConnected = false;
  landDisplay(gone, 'blob:copy');
  assert.equal(gone.src, '');
});

test('a card zoomed onto its original keeps it, and returns to the copy', () => {
  // The sweep recorded the thumbnail as the copy to return to. The late copy
  // then replaced the original, and a zoom-out went back to the thumbnail.
  const sharp = img({ src: 'asset:original', dataset: { hires: 'on' }, _copyUrl: 'blob:thumb' });
  landDisplay(sharp, 'blob:copy');
  assert.equal(sharp.src, 'asset:original');
  assert.equal(sharp._copyUrl, 'blob:copy');
});
