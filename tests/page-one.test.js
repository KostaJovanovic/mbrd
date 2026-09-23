// Page one of a Word file (import/page-one.ts). The XML walk needs a
// DOMParser, which Node lacks, so this holds the two pure halves: the page
// box a file states, and the flow that sets blocks on it.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { pageBox, flow, isWordDoc } from '../web/assets/js/import/page-one.ts';

// A stand-in for measureText: every character ten twips wide per point.
const measure = (text, size) => text.length * 10 * size;

const text = (t, over = {}) => ({
  kind: 'text', text: t, size: 10, bold: false, colour: null,
  align: 'left', after: 0, indent: 0, ...over,
});

// One line of 10 pt type, in twips: the flow's own arithmetic.
const LINE = 10 * 1.2 * 20;

test('the Word spellings, and no other', () => {
  for (const ext of ['docx', 'docm', 'dotx', 'dotm']) assert.equal(isWordDoc(ext), true, ext);
  for (const ext of ['doc', 'pptx', 'odt', 'xlsx']) assert.equal(isWordDoc(ext), false, ext);
});

test('a page with nothing stated is A4 with one-inch margins', () => {
  assert.deepEqual(pageBox({}),
    { w: 11906, h: 16838, top: 1440, right: 1440, bottom: 1440, left: 1440 });
});

test('a stated page is used, and an absurd number falls back', () => {
  const page = pageBox({ w: 12240, h: 15840, left: 1800, top: -5, right: 99999, bottom: 720 });
  assert.equal(page.w, 12240, 'US Letter width');
  assert.equal(page.h, 15840);
  assert.equal(page.left, 1800);
  assert.equal(page.bottom, 720);
  assert.equal(page.top, 1440, 'a negative margin takes the default');
  assert.equal(page.right, 1440, 'a margin past any paper takes the default');
});

test('a margin stays under a third of its edge', () => {
  const page = pageBox({ w: 3000, h: 3000, left: 2000, right: 2000 });
  assert.equal(page.left, 1000);
  assert.equal(page.right, 1000);
});

test('text wraps to the measure between the margins', () => {
  // 3000 twips wide at 100 a character: thirty characters to a line.
  const page = pageBox({ w: 4000, h: 20000, left: 500, right: 500, top: 500, bottom: 500 });
  const placed = flow([text('aaaa bbbb cccc dddd eeee ffff gggg')], page, measure);
  assert.deepEqual(placed.map(p => p.text), ['aaaa bbbb cccc dddd eeee ffff', 'gggg']);
  assert.equal(placed[0].x, 500);
  assert.equal(placed[0].y, 500);
  assert.equal(placed[1].y, 500 + LINE);
});

test('an empty paragraph still takes a line', () => {
  const page = pageBox({ w: 4000, h: 20000, left: 500, right: 500, top: 500, bottom: 500 });
  const placed = flow([text('one'), text(''), text('two')], page, measure);
  assert.deepEqual(placed.map(p => p.text), ['one', 'two']);
  assert.equal(placed[1].y, 500 + 2 * LINE);
});

test('the flow stops at the foot of page one', () => {
  const page = pageBox({ w: 4000, h: 2000, left: 500, right: 500, top: 500, bottom: 500 });
  const placed = flow(Array.from({ length: 40 }, (_, i) => text(`line ${i}`)), page, measure);
  assert.ok(placed.length > 1 && placed.length < 40, `${placed.length} lines set`);
  for (const p of placed) assert.ok(p.y + LINE <= 2000 - 500, `${p.text} runs past the foot`);
});

test('one enormous paragraph is measured only as far as the page has room', () => {
  // The 2026-09-23 hunt: MAX_CHARS is checked between body children, so one
  // <w:p> of a million words went whole to wrap(), a measure per word, for
  // about forty visible lines.
  const page = pageBox({});
  let calls = 0;
  const counted = (t, size) => { calls++; return measure(t, size); };
  const huge = Array.from({ length: 200_000 }, () => 'word').join(' ');
  const placed = flow([text(huge)], page, counted);
  const fits = Math.floor((page.h - page.top - page.bottom) / LINE);
  assert.equal(placed.length, fits, 'the page is still filled');
  assert.ok(calls < fits * 100, `${calls} measures for ${fits} lines`);
});

test('centred text sits in the middle of the measure', () => {
  const page = pageBox({ w: 4000, h: 20000, left: 500, right: 500, top: 500, bottom: 500 });
  const [line] = flow([text('abcd', { align: 'center' })], page, measure);
  assert.equal(line.x, 500 + (3000 - 400) / 2);
});

test('a picture wider than the text shrinks to it', () => {
  const page = pageBox({ w: 4000, h: 20000, left: 500, right: 500, top: 500, bottom: 500 });
  const [pic, after] = flow([
    { kind: 'image', w: 6000, h: 3000, align: 'left', bytes: null },
    text('under'),
  ], page, measure);
  assert.equal(pic.w, 3000);
  assert.equal(pic.h, 1500);
  assert.equal(after.y, 500 + 1500, 'the text goes on under the picture');
});

test('a picture that does not fit under the text ends the page', () => {
  const page = pageBox({ w: 4000, h: 4000, left: 500, right: 500, top: 500, bottom: 500 });
  const placed = flow([
    text('top'),
    { kind: 'image', w: 3000, h: 2900, align: 'left', bytes: null },
    text('never'),
  ], page, measure);
  assert.deepEqual(placed.map(p => p.kind), ['text']);
});
