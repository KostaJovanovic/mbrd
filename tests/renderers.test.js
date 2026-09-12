// Classification and the renderer map have to agree - they didn't,
// silently, for the whole life of the project: classify() returned
// 'text' for fifty extensions, defaultSize() gave it a size, readText()
// was documented as its hook, yet RENDERERS had no 'text' key, so every
// .txt, .md and .csv came out generic. Nothing failed; there was nothing
// to fail. So the agreement is asserted rather than assumed.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import {
  classify, defaultSize, hasRenderer, measureSize,
  parseNoteText, normalizeNoteRich, flattenNoteRich,
} from '../web/assets/js/canvas/renderers.ts';

const file = (name, type = '') => ({ name, type });
const svgBlob = markup => new Blob([markup], { type: 'image/svg+xml' });

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
  // The other direction: a size for a type nothing draws is the same
  // drift, and it's how the missing renderer looked from the inside - a
  // size reserved for text cards that were never built.
  const sized = ['image', 'video', 'audio', 'text', 'note', 'link'];
  const missing = sized.filter(t => !hasRenderer(t));
  assert.deepEqual(missing, [], 'given a default size, but nothing renders them');
});

test('the fallback exists, since classify can always reach it', () => {
  assert.equal(classify(file('a.sldprt')), 'generic');
  assert.ok(hasRenderer('generic'));
});

// SVG is measured from its own markup rather than by a decoder, so it
// stays an image even in a browser that refuses to decode a
// viewBox-only vector - the case that used to drop it to a named card.
test('an SVG is measured from its viewBox and stays a decodable image', async () => {
  const size = await measureSize('image', svgBlob('<svg viewBox="0 0 100 50"></svg>'));
  assert.equal(size.decodable, true, 'a vector is never downgraded to a named card');
  assert.equal(size.measured, true);
  assert.ok(size.w > size.h, 'the 2:1 viewBox gives a landscape box');
});

test('an SVG with explicit width/height wins over its viewBox', async () => {
  const size = await measureSize('image', svgBlob('<svg width="40" height="120" viewBox="0 0 100 50"></svg>'));
  assert.ok(size.h > size.w, 'the 40x120 attributes give a portrait box');
});

test('an SVG that declares no size keeps the placeholder box, still an image', async () => {
  const size = await measureSize('image', svgBlob('<svg xmlns="http://www.w3.org/2000/svg"></svg>'));
  assert.equal(size.decodable, true);
  assert.deepEqual({ w: size.w, h: size.h }, defaultSize('image'));
});

test('the title card has a renderer and a ~3:2 default box, but is not a file type', () => {
  // The Desktop title card is a singleton the board seeds, never a
  // dropped file, so classify() must never produce it, yet it needs a
  // renderer and a size like any other type. Four cells wide at the
  // default step, 3:2 tall to a whole pixel (256 * 2/3 = 170.67 -> 171),
  // so the ratio is the masthead's within a pixel rather than exactly 1.5.
  assert.ok(hasRenderer('title'));
  const { w, h } = defaultSize('title');
  assert.equal(w, 256, 'four grid spaces wide at the default step');
  assert.ok(Math.abs(w / h - 3 / 2) < 0.01, `the masthead aspect, got ${w}x${h}`);
  assert.equal(classify(file('title.title')), 'generic',
    'nothing a person can drop is ever classified as a title');
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
  // The browser sets no MIME most of the time for anything interesting:
  // .jxl, .avif and friends routinely arrive with an empty file.type.
  assert.equal(classify(file('a.txt')), 'text');
  assert.equal(classify(file('holiday.JPG')), 'image');
});

test('a sticky note is square and small', () => {
  // Square because a sticky comes off a square pad; small because a note
  // is an annotation, not a thing on the board. The default must sit
  // above MIN_SIZE (48, canvas/input.ts), or a fresh note would arrive
  // already smaller than it can be dragged.
  const { w, h } = defaultSize('note');
  assert.equal(w, h, `a note should be square, got ${w}x${h}`);
  assert.ok(w > 48, `a note starts below the resize floor at ${w}`);
  assert.ok(w < defaultSize('image').w, 'a note should not outweigh a photo');
});

test('text files get a card taller than it is wide', () => {
  // A page is portrait. The generic card is landscape - the shape this
  // used to fall back to - and fits about two lines.
  const { w, h } = defaultSize('text');
  assert.ok(h > w, `text cards should be portrait, got ${w}x${h}`);
});

// ---------------------------------------------------------------------------
// The note formatting model
// ---------------------------------------------------------------------------

test('a legacy note reads its first line as a title', () => {
  // No meta.rich, no markers: the first line was the title and stays
  // one, so an old board doesn't lose its headings the day this shipped.
  const blocks = parseNoteText('Shopping\nmilk\neggs');
  assert.deepEqual(blocks.map(b => b.tag), ['h1', 'p', 'p']);
  assert.equal(blocks[0].text, 'Shopping');
});

test('markdown markers set the kind and are stripped from the text', () => {
  const blocks = parseNoteText('# Title\n## Heading\nbody');
  assert.deepEqual(blocks.map(b => b.tag), ['h1', 'h2', 'p']);
  assert.deepEqual(blocks.map(b => b.text), ['Title', 'Heading', 'body']);
});

test('rich flattens to the markdown it parses from', () => {
  const text = '# Title\n## Heading\nbody';
  const rich = normalizeNoteRich(undefined, text);
  assert.equal(flattenNoteRich(rich), text, 'the plaintext round-trips');
});

// ---------------------------------------------------------------------------
// The thumbnail is the untouched picture, and an edited card must not show it
// ---------------------------------------------------------------------------

// Read off the source, since what's held here is a shape with no DOM to
// build a card in - the same answer boot.test.js gives for an IndexedDB
// connection it can't open. meta.thumb is the hundred-pixel copy of the
// *whole untouched* file, so on a cropped, turned or matted card it's the
// full frame, wrong way up, background still on. The image renderer
// consults it twice - the stand-in while the display copy renders, and
// the far-zoom twin - and for a long time only the first knew, so a
// cut-out card grew its background back on zoom-out.
test('neither use of meta.thumb survives on an edited card', () => {
  const src = readFileSync('web/assets/js/canvas/renderers.ts', 'utf8');
  assert.match(src, /if \(thumb && !edited\) img\.src = thumb;/,
    'the stand-in while the copy renders must be refused on an edited card');
  assert.match(src, /const thumb = !animated && !edited && thumbHash/,
    'and so must the far-zoom twin, which is the same picture by the other door');
});

test('rich is authoritative when present, and is sanitised', () => {
  const rich = normalizeNoteRich({
    font: 'nope', size: 99, valign: 'sideways',
    blocks: [{ tag: 'h9', align: 'justify', text: 'a' }, { tag: 'p', align: 'right', text: 'b' }],
  }, 'ignored fallback');
  assert.equal(rich.font, 'sheet', 'an unknown font falls back');
  assert.ok(rich.size <= 1.8 && rich.size >= 0.7, 'size is clamped');
  assert.equal(rich.valign, 'top', 'an unknown vertical align falls back');
  assert.deepEqual(rich.blocks[0], { tag: 'p', align: 'left', text: 'a' }, 'bad tag/align repaired');
  assert.deepEqual(rich.blocks[1], { tag: 'p', align: 'right', text: 'b' });
});

test('a note cannot hold more than NOTE_MAX characters', () => {
  const long = 'x'.repeat(2000);
  const rich = normalizeNoteRich({ blocks: [{ tag: 'p', align: 'left', text: long }] });
  assert.ok(flattenNoteRich(rich).length <= 512, 'the flattened text fits the cap');
});

test('an empty note is a single empty heading', () => {
  const rich = normalizeNoteRich(undefined, '');
  assert.equal(rich.blocks.length, 1);
  assert.deepEqual(rich.blocks[0], { tag: 'h1', align: 'left', text: '' });
});
