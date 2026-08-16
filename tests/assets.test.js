// Naming a derived picture after what it actually is.
//
// Six places in the app make a picture out of another picture - a thumbnail, a
// video poster, a model's still - and every one of them used to write
// `something.webp` and `image/webp` outright. That was true for exactly as long
// as the encoders refused to hand back anything else, and no version of Safari
// writes WebP from a canvas, so they now do.
//
// The label is not cosmetic and that is the whole of why this file exists:
// addFile() *relabels* the blob with the type it is given, and an <img> renders
// a blob: URL by that type. A PNG announced as WebP is a picture that does not
// draw, on precisely the engine every one of those changes was made for.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { derivedFile } from '../web/assets/js/storage/assets.ts';

const blob = type => new Blob([new Uint8Array(8)], { type });

test('a derived picture is named and typed after its own bytes', () => {
  const png = derivedFile(blob('image/png'), 'thumb');
  assert.equal(png.type, 'image/png', 'the label must follow the blob, not the intention');
  assert.equal(png.name, 'thumb.png');

  const webp = derivedFile(blob('image/webp'), 'thumb');
  assert.equal(webp.type, 'image/webp');
  assert.equal(webp.name, 'thumb.webp');

  const jpeg = derivedFile(blob('image/jpeg'), 'poster');
  assert.equal(jpeg.type, 'image/jpeg');
  assert.equal(jpeg.name, 'poster.jpeg');
});

test('the stem is the caller\'s, so a model still keeps its id', () => {
  const still = derivedFile(blob('image/png'), 'abc123-still');
  assert.equal(still.name, 'abc123-still.png');
});

test('a blob with nothing to say is treated as the picture it was asked for', () => {
  // The only way to reach this is a blob with no type at all, and every producer
  // here asked an encoder for a picture - so WebP is the honest guess rather
  // than octet-stream.
  assert.equal(derivedFile(blob(''), 'thumb').type, 'image/webp');
  assert.equal(derivedFile(blob('nonsense'), 'thumb').type, 'image/webp');
  assert.equal(derivedFile(blob('text/html'), 'thumb').type, 'image/webp',
    'and a type that is not a picture at all is not passed through either');
});

test('an upper-case type is normalised rather than trusted', () => {
  const shouty = derivedFile(blob('IMAGE/PNG'), 'thumb');
  assert.equal(shouty.type, 'image/png');
  assert.equal(shouty.name, 'thumb.png');
});
