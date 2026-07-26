// Classification and the renderer map have to agree.
//
// They did not, silently, for the whole life of the project: classify()
// returned 'text' for some fifty extensions, defaultSize() gave it a 300x360,
// readText() was written and documented as the text renderer's hook, the README
// listed text as one of the four things that renders - and RENDERERS had no
// 'text' key, so every .txt, .md and .csv came out as a generic card with a
// name and a byte count. Nothing failed. There was nothing to fail.
//
// So the agreement is asserted rather than assumed. These tests are cheap and
// they are the only thing standing between "we added a type" and the same
// quiet hole opening again.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { classify, defaultSize, hasRenderer } from '../web/assets/js/canvas/renderers.js';

const file = (name, type = '') => ({ name, type });

// ---------------------------------------------------------------------------
// Every route ends somewhere real
// ---------------------------------------------------------------------------

test('every type classify() produces has a renderer', () => {
  const names = [
    'a.png', 'a.jpg', 'a.gif', 'a.webp', 'a.avif', 'a.svg', 'a.heic',
    'a.mp4', 'a.webm', 'a.mov', 'a.mkv',
    'a.mp3', 'a.wav', 'a.flac', 'a.m4a',
    'a.txt', 'a.md', 'a.csv', 'a.json', 'a.js', 'a.py', 'a.yml', 'a.log',
    'a.sldprt', 'a.dwg', 'a.zip', 'a.exe', 'noextension',
  ];
  const missing = [...new Set(names.map(n => classify(file(n))))].filter(t => !hasRenderer(t));
  assert.deepEqual(missing, [], 'classified as these, but nothing renders them');
});

test('every type defaultSize() knows about has a renderer', () => {
  // The other direction. A size for a type nothing draws is the same drift
  // seen from the other end, and it is how the missing renderer looked from
  // the inside: a 300x360 reserved for text cards that were never built.
  const sized = ['image', 'video', 'audio', 'text', 'note', 'link'];
  const missing = sized.filter(t => !hasRenderer(t));
  assert.deepEqual(missing, [], 'given a default size, but nothing renders them');
});

test('the fallback exists, since classify can always reach it', () => {
  assert.equal(classify(file('a.sldprt')), 'generic');
  assert.ok(hasRenderer('generic'));
});

// ---------------------------------------------------------------------------
// Classification itself
// ---------------------------------------------------------------------------

test('MIME wins over the extension', () => {
  assert.equal(classify(file('a.dat', 'image/png')), 'image');
  assert.equal(classify(file('a.dat', 'video/mp4')), 'video');
  assert.equal(classify(file('a.dat', 'audio/mpeg')), 'audio');
  assert.equal(classify(file('a.dat', 'text/plain')), 'text');
});

test('an extension carries it when the browser sets no MIME', () => {
  // Which is most of the time for anything interesting: .jxl, .avif and
  // friends routinely arrive with an empty file.type.
  assert.equal(classify(file('a.txt')), 'text');
  assert.equal(classify(file('holiday.JPG')), 'image');
});

test('a sticky note is square and small', () => {
  // Square because a sticky comes off a square pad, and small because a note
  // is an annotation on the board rather than a thing on it. The floor that
  // matters is MIN_SIZE in canvas/input.js (48): the default has to sit above
  // it, or a fresh note would arrive already smaller than it can be dragged.
  const { w, h } = defaultSize('note');
  assert.equal(w, h, `a note should be square, got ${w}x${h}`);
  assert.ok(w > 48, `a note starts below the resize floor at ${w}`);
  assert.ok(w < defaultSize('image').w, 'a note should not outweigh a photo');
});

test('text files get a card taller than it is wide', () => {
  // A page is portrait. The generic card is landscape, which is the shape this
  // was falling back to, and it fits about two lines.
  const { w, h } = defaultSize('text');
  assert.ok(h > w, `text cards should be portrait, got ${w}x${h}`);
});
